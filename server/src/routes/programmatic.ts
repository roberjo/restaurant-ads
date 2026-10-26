// Pooled network readiness: operator quality scores, programmatic gating and inventory forecasts.
import { actingOperatorId, newId, requireRole } from '../auth.ts';
import { encrypt } from '../crypto.ts';
import { getSetting, nowIso, toApi } from '../db.ts';
import { clearQualityCache } from '../rtb.ts';
import { forecastInventory } from '../forecast.ts';
import { HttpError } from '../http.ts';
import { DEFAULT_VENUE_TYPES, operatorQuality } from '../quality.ts';
import type { App } from '../app-types.ts';
import { date, int, optStr, str, venueTypeInput } from '../validate.ts';

export function registerProgrammatic({ db, router, config }: App): void {
  router.get('/api/quality', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return operatorQuality(db, actingOperatorId(ctx, user));
  });

  router.get('/api/admin/quality', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return (db.prepare(`SELECT id, name, network_opt_in FROM operators ORDER BY name`).all() as any[])
      .map((o) => ({ operatorId: o.id, name: o.name, networkOptIn: !!o.network_opt_in, ...operatorQuality(db, o.id) }));
  });

  router.put('/api/admin/operators/:id/programmatic', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const override = ctx.body.override ?? null;
    if (![null, 'allow', 'deny'].includes(override)) throw new HttpError(400, 'override must be "allow", "deny" or null');
    const r = db.prepare(`UPDATE operators SET programmatic_override = ? WHERE id = ?`).run(override, ctx.params.id);
    if (!r.changes) throw new HttpError(404, 'operator not found');
    clearQualityCache();
    return operatorQuality(db, ctx.params.id);
  });

  // Operators see their own capacity; the platform admin (without ?operatorId) sees the pooled network:
  // operators that opted into network demand and are eligible for programmatic.
  // ?venueTypes=a,b narrows to those venue types (e.g. to size a deal).
  const pooledOperators = () => (db.prepare(`SELECT id FROM operators WHERE network_opt_in = 1`).all() as any[])
    .map((o) => o.id as string).filter((id) => operatorQuality(db, id).eligible);
  router.get('/api/forecast', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const days = int(ctx.url.searchParams.get('days') ?? 7, 'days', 1, 30);
    const venueTypes = (ctx.url.searchParams.get('venueTypes') ?? '').split(',').filter(Boolean).map((v) => venueTypeInput(v, 'venueTypes')!);
    if (user.role === 'platform_admin' && !ctx.url.searchParams.get('operatorId')) {
      const ops = pooledOperators();
      return { scope: 'network', operators: ops.length, ...forecastInventory(db, ops, days, new Date(), { venueTypes }) };
    }
    return { scope: 'operator', ...forecastInventory(db, [actingOperatorId(ctx, user)], days, new Date(), { venueTypes }) };
  });

  router.get('/api/venue-types', (ctx) => {
    requireRole(ctx, 'operator_admin', 'platform_admin');
    return { defaults: DEFAULT_VENUE_TYPES, taxonomy: 'OpenOOH venue taxonomy' };
  });

  // ---- SSP connections (OpenRTB 2.6) ----
  const sspInput = (b: any, cur?: any) => {
    const url = b.endpointUrl !== undefined ? str(b.endpointUrl, 'endpointUrl', 10, 500) : cur.endpoint_url;
    if (!/^https:\/\//.test(url)) throw new HttpError(400, 'endpointUrl must be https');
    let auth = cur?.auth_header_enc ?? null;
    if (b.authHeader !== undefined) {
      const v = optStr(b.authHeader, 'authHeader', 500);
      if (v && !config.appSecret) throw new HttpError(400, 'APP_SECRET is required to store SSP credentials');
      auth = v ? encrypt(config.appSecret!, v) : null;
    }
    return {
      name: b.name !== undefined ? str(b.name, 'name') : cur.name,
      url,
      auth,
      enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : cur?.enabled ?? 1,
      timeout: b.timeoutMs !== undefined ? int(b.timeoutMs, 'timeoutMs', 50, 2000) : cur?.timeout_ms ?? 300,
      floor: b.floorCpmCents !== undefined ? int(b.floorCpmCents, 'floorCpmCents', 0, 100_000) : cur?.floor_cpm_cents ?? 300,
    };
  };
  const present = (r: any) => ({ ...toApi(r), hasAuth: !!r.auth_header_enc });

  router.get('/api/admin/ssps', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return (db.prepare(`SELECT * FROM ssps ORDER BY name`).all() as any[]).map(present);
  });

  router.post('/api/admin/ssps', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const v = sspInput(ctx.body);
    const id = newId('ssp');
    db.prepare(`INSERT INTO ssps (id, name, endpoint_url, auth_header_enc, enabled, timeout_ms, floor_cpm_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, v.name, v.url, v.auth, v.enabled, v.timeout, v.floor, nowIso());
    return present(db.prepare(`SELECT * FROM ssps WHERE id = ?`).get(id));
  });

  router.put('/api/admin/ssps/:id', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const cur = db.prepare(`SELECT * FROM ssps WHERE id = ?`).get(ctx.params.id) as any;
    if (!cur) throw new HttpError(404, 'ssp not found');
    const v = sspInput(ctx.body, cur);
    db.prepare(`UPDATE ssps SET name = ?, endpoint_url = ?, auth_header_enc = ?, enabled = ?, timeout_ms = ?, floor_cpm_cents = ? WHERE id = ?`)
      .run(v.name, v.url, v.auth, v.enabled, v.timeout, v.floor, cur.id);
    return present(db.prepare(`SELECT * FROM ssps WHERE id = ?`).get(cur.id));
  });

  router.delete('/api/admin/ssps/:id', (ctx) => {
    requireRole(ctx, 'platform_admin');
    // Disable rather than delete: past wins and plays still reference the SSP.
    const r = db.prepare(`UPDATE ssps SET enabled = 0 WHERE id = ?`).run(ctx.params.id);
    if (!r.changes) throw new HttpError(404, 'ssp not found');
    return { ok: true };
  });

  // ---- PMP deals: the pooled network sold to specific buyers through an SSP ----
  const idList = (v: unknown, field: string) => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length > 100) throw new HttpError(400, `${field} must be a list`);
    return v.length ? JSON.stringify([...new Set(v.map((x) => str(x, field, 1, 100)))]) : null;
  };
  const dealInput = (b: any, cur?: any) => {
    const pick = <T>(key: string, col: string, parse: (v: any) => T, fallback?: T) =>
      b[key] !== undefined ? parse(b[key]) : cur ? cur[col] : fallback;
    const v = {
      sspId: pick('sspId', 'ssp_id', (x) => str(x, 'sspId')),
      dealId: pick('dealId', 'deal_id', (x) => str(x, 'dealId', 1, 100)),
      name: pick('name', 'name', (x) => str(x, 'name')),
      buyer: pick('buyer', 'buyer', (x) => optStr(x, 'buyer'), null),
      floor: pick('floorCpmCents', 'floor_cpm_cents', (x) => int(x, 'floorCpmCents', 0, 100_000)),
      auctionType: pick('auctionType', 'auction_type', (x) => { if (x !== 1 && x !== 3) throw new HttpError(400, 'auctionType must be 1 (first price) or 3 (fixed price)'); return x; }, 1),
      privateAuction: pick('privateAuction', 'private_auction', (x) => (x ? 1 : 0), 0),
      wseats: pick('wseats', 'wseats', (x) => idList(x, 'wseats'), null),
      venueTypes: pick('venueTypes', 'venue_types', (x) => {
        const list = x === null ? null : Array.isArray(x) ? x.map((t) => venueTypeInput(t, 'venueTypes')) : (() => { throw new HttpError(400, 'venueTypes must be a list'); })();
        return list?.length ? JSON.stringify([...new Set(list)]) : null;
      }, null),
      operatorIds: pick('operatorIds', 'operator_ids', (x) => idList(x, 'operatorIds'), null),
      startDate: pick('startDate', 'start_date', (x) => (x ? date(x, 'startDate') : null), null),
      endDate: pick('endDate', 'end_date', (x) => (x ? date(x, 'endDate') : null), null),
      enabled: pick('enabled', 'enabled', (x) => (x ? 1 : 0), 1),
    };
    if (v.floor === undefined) throw new HttpError(400, 'floorCpmCents is required');
    if (v.startDate && v.endDate && v.endDate < v.startDate) throw new HttpError(400, 'endDate must be on or after startDate');
    if (!db.prepare(`SELECT 1 FROM ssps WHERE id = ?`).get(v.sspId)) throw new HttpError(400, 'unknown sspId');
    return v;
  };
  const dealStats = (id: string) => db.prepare(`
    SELECT COUNT(w.id) AS wins, COUNT(w.played_at) AS played, COALESCE(SUM(p.gross_micros), 0) AS gross_micros
    FROM rtb_wins w LEFT JOIN pop_events p ON p.rtb_win_id = w.id WHERE w.deal_id = ?`).get(id) as any;
  const presentDeal = (r: any) => {
    const st = dealStats(r.id);
    return { ...toApi(r), enabled: !!r.enabled, wins: st.wins, played: st.played, grossUsd: st.gross_micros / 1_000_000 };
  };
  const saveDeal = (id: string, v: ReturnType<typeof dealInput>, insert: boolean) => {
    const vals = [v.sspId, v.dealId, v.name, v.buyer, v.floor, v.auctionType, v.privateAuction, v.wseats, v.venueTypes, v.operatorIds, v.startDate, v.endDate, v.enabled];
    try {
      if (insert) {
        db.prepare(`INSERT INTO rtb_deals (ssp_id, deal_id, name, buyer, floor_cpm_cents, auction_type, private_auction, wseats, venue_types,
          operator_ids, start_date, end_date, enabled, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, id, nowIso());
      } else {
        db.prepare(`UPDATE rtb_deals SET ssp_id = ?, deal_id = ?, name = ?, buyer = ?, floor_cpm_cents = ?, auction_type = ?, private_auction = ?,
          wseats = ?, venue_types = ?, operator_ids = ?, start_date = ?, end_date = ?, enabled = ? WHERE id = ?`).run(...vals, id);
      }
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) throw new HttpError(409, 'that SSP already has a deal with this dealId');
      throw e;
    }
    return presentDeal(db.prepare(`SELECT * FROM rtb_deals WHERE id = ?`).get(id));
  };

  router.get('/api/admin/deals', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return (db.prepare(`SELECT * FROM rtb_deals ORDER BY created_at DESC`).all() as any[]).map(presentDeal);
  });

  router.post('/api/admin/deals', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return saveDeal(newId('deal'), dealInput(ctx.body), true);
  });

  router.put('/api/admin/deals/:id', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const cur = db.prepare(`SELECT * FROM rtb_deals WHERE id = ?`).get(ctx.params.id) as any;
    if (!cur) throw new HttpError(404, 'deal not found');
    return saveDeal(cur.id, dealInput(ctx.body, cur), false);
  });

  router.delete('/api/admin/deals/:id', (ctx) => {
    requireRole(ctx, 'platform_admin');
    // Disable rather than delete: wins and plays still reference the deal.
    const r = db.prepare(`UPDATE rtb_deals SET enabled = 0 WHERE id = ?`).run(ctx.params.id);
    if (!r.changes) throw new HttpError(404, 'deal not found');
    return { ok: true };
  });

  // Unsold inventory the deal's targeting reaches: what a buyer can expect to be offered.
  router.get('/api/admin/deals/:id/forecast', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const d = db.prepare(`SELECT * FROM rtb_deals WHERE id = ?`).get(ctx.params.id) as any;
    if (!d) throw new HttpError(404, 'deal not found');
    const days = int(ctx.url.searchParams.get('days') ?? 7, 'days', 1, 30);
    const targetOps: string[] | null = d.operator_ids ? JSON.parse(d.operator_ids) : null;
    const ops = pooledOperators().filter((id) => !targetOps || targetOps.includes(id));
    const venueTypes: string[] | null = d.venue_types ? JSON.parse(d.venue_types) : null;
    return { dealId: d.id, operators: ops.length, ...forecastInventory(db, ops, days, new Date(), { venueTypes }) };
  });

  // Auction stats and programmatic revenue, plus the date through which SSPs have paid (gates payouts).
  router.get('/api/admin/rtb', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const since = new Date(Date.now() - int(ctx.url.searchParams.get('days') ?? 7, 'days', 1, 90) * 86_400_000).toISOString();
    const auctions = db.prepare(`SELECT COUNT(*) AS auctions, COALESCE(SUM(imps), 0) AS imps, COALESCE(SUM(bids), 0) AS bids,
      COALESCE(SUM(wins), 0) AS wins, COALESCE(SUM(errors), 0) AS errors FROM rtb_auctions WHERE at >= ?`).get(since) as any;
    const bySsp = db.prepare(`
      SELECT s.id, s.name, COUNT(w.id) AS wins, COUNT(w.played_at) AS played,
        COALESCE(SUM(CASE WHEN w.played_at IS NOT NULL THEN p.gross_micros END), 0) AS gross_micros
      FROM ssps s LEFT JOIN rtb_wins w ON w.ssp_id = s.id AND w.created_at >= ?
      LEFT JOIN pop_events p ON p.rtb_win_id = w.id GROUP BY s.id ORDER BY s.name`).all(since) as any[];
    const notices = db.prepare(`SELECT status, COUNT(*) AS n FROM rtb_notices WHERE created_at >= ? GROUP BY status`).all(since) as any[];
    return {
      since,
      ...auctions,
      fillRatePct: auctions.imps ? Math.round((1000 * auctions.wins) / auctions.imps) / 10 : 0,
      bySsp: bySsp.map((r) => ({ ...toApi(r), grossUsd: r.gross_micros / 1_000_000, grossMicros: undefined })),
      notices: Object.fromEntries(notices.map((n) => [n.status, n.n])),
      settledThrough: getSetting(db, 'rtb_settled_through') || null,
    };
  });

  router.put('/api/admin/rtb/settled', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const through = ctx.body.settledThrough ? date(ctx.body.settledThrough, 'settledThrough') : '';
    if (through && through >= new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'settledThrough must be before today');
    db.prepare(`INSERT OR REPLACE INTO settings VALUES ('rtb_settled_through', ?)`).run(through);
    return { settledThrough: through || null };
  });
}
