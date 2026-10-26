// Pooled network readiness: operator quality scores, programmatic gating and inventory forecasts.
import { actingOperatorId, newId, requireRole } from '../auth.ts';
import { encrypt } from '../crypto.ts';
import { getSetting, nowIso, toApi } from '../db.ts';
import { clearQualityCache } from '../rtb.ts';
import { forecastInventory } from '../forecast.ts';
import { HttpError } from '../http.ts';
import { DEFAULT_VENUE_TYPES, operatorQuality } from '../quality.ts';
import type { App } from '../app-types.ts';
import { date, int, optStr, str } from '../validate.ts';

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
  router.get('/api/forecast', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const days = int(ctx.url.searchParams.get('days') ?? 7, 'days', 1, 30);
    if (user.role === 'platform_admin' && !ctx.url.searchParams.get('operatorId')) {
      const ops = (db.prepare(`SELECT id FROM operators WHERE network_opt_in = 1`).all() as any[])
        .map((o) => o.id as string).filter((id) => operatorQuality(db, id).eligible);
      return { scope: 'network', operators: ops.length, ...forecastInventory(db, ops, days) };
    }
    return { scope: 'operator', ...forecastInventory(db, [actingOperatorId(ctx, user)], days) };
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
