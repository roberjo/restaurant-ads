// Venues, screens, device pairing, fleet health, menus, advertisers and venue users.
import { actingOperatorId, newId, requireRole, type AppCtx, type User } from '../auth.ts';
import { AD_CATEGORIES, VENUE_CATEGORIES, createUser, nowIso, toApi } from '../db.ts';
import { HttpError } from '../http.ts';
import { saveGeneratedSvg, saveUpload } from '../uploads.ts';
import { renderTemplate } from '../templates.ts';
import { isOpenAt, parseOpenHours } from '../hours.ts';
import type { App } from '../app-types.ts';
import { assertCanPair, syncQuantitySoon } from '../billing.ts';
import { email, int, num, oneOf, optStr, str, stringList } from '../validate.ts';

export const SCREEN_MODES = ['menu', 'idle', 'signage'] as const;
/** OpenOOH venue type IDs look like "entertainment.bars". */
const venueTypeInput = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[a-z_]+(\.[a-z_]+)*$/.test(v) || v.length > 80) throw new HttpError(400, 'venueType must be an OpenOOH ID like "entertainment.bars"');
  return v;
};
export const DEVICE_COMMANDS = ['reload', 'identify', 'clear_cache', 'refresh_playlist'] as const;
export const ONLINE_WINDOW_MS = 5 * 60_000;

export function screenStatus(lastSeenAt: string | null, paired: boolean): 'unpaired' | 'online' | 'offline' {
  if (!paired) return 'unpaired';
  return lastSeenAt && Date.now() - Date.parse(lastSeenAt) < ONLINE_WINDOW_MS ? 'online' : 'offline';
}

function validTimezone(tz: unknown): string {
  const s = str(tz, 'timezone', 3, 64);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch {
    throw new HttpError(400, 'invalid timezone');
  }
  return s;
}

export function registerNetwork({ db, router, config }: App): void {
  /** Load a venue the user may access. Venue managers only see their own venue. */
  function venueFor(ctx: AppCtx, user: User, venueId: string): any {
    const v = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(venueId) as any;
    if (!v) throw new HttpError(404, 'venue not found');
    if (user.role === 'platform_admin') return v;
    if (v.operator_id !== user.operatorId) throw new HttpError(404, 'venue not found');
    if (user.role === 'venue_manager' && user.venueId !== v.id) throw new HttpError(404, 'venue not found');
    if (user.role === 'advertiser') throw new HttpError(403, 'forbidden');
    return v;
  }

  function screenFor(ctx: AppCtx, user: User, screenId: string): any {
    const s = db.prepare(`SELECT * FROM screens WHERE id = ?`).get(screenId) as any;
    if (!s) throw new HttpError(404, 'screen not found');
    venueFor(ctx, user, s.venue_id);
    return s;
  }

  // ---- Venues ----
  router.get('/api/venues', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    if (user.role === 'venue_manager') {
      return (db.prepare(`SELECT * FROM venues WHERE id = ?`).all(user.venueId)).map(toApi);
    }
    return db.prepare(`
      SELECT v.*, (SELECT COUNT(*) FROM screens s WHERE s.venue_id = v.id) AS screen_count
      FROM venues v WHERE v.operator_id = ? ORDER BY v.name`).all(actingOperatorId(ctx, user)).map(toApi);
  });

  router.get('/api/venues/:id', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    return toApi(venueFor(ctx, user, ctx.params.id));
  });

  router.post('/api/venues', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const operatorId = actingOperatorId(ctx, user);
    const b = ctx.body;
    const id = newId('ven');
    db.prepare(`
      INSERT INTO venues (id, operator_id, name, address, lat, lng, timezone, category, blocked_ad_categories,
        audience_multiplier, rev_share_pct, open_hours, venue_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, operatorId, str(b.name, 'name'), optStr(b.address, 'address', 300) ?? '',
      num(b.lat, 'lat', -90, 90), num(b.lng, 'lng', -180, 180), validTimezone(b.timezone ?? 'America/Chicago'),
      oneOf(b.category ?? 'qsr', 'category', VENUE_CATEGORIES),
      JSON.stringify(b.blockedAdCategories ? stringList(b.blockedAdCategories, 'blockedAdCategories', AD_CATEGORIES) : ['cannabis']),
      num(b.audienceMultiplier ?? 2, 'audienceMultiplier', 0, 1000), num(b.revSharePct ?? 20, 'revSharePct', 0, 100),
      b.openHours ? JSON.stringify(parseOpenHours(b.openHours)) : null, venueTypeInput(b.venueType), nowIso(),
    );
    return toApi(db.prepare(`SELECT * FROM venues WHERE id = ?`).get(id));
  });

  router.put('/api/venues/:id', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueFor(ctx, user, ctx.params.id);
    const b = ctx.body;
    const blocked = b.blockedAdCategories !== undefined
      ? JSON.stringify(stringList(b.blockedAdCategories, 'blockedAdCategories', AD_CATEGORIES))
      : v.blocked_ad_categories;
    const openHours = b.openHours !== undefined
      ? (b.openHours === null ? null : JSON.stringify(parseOpenHours(b.openHours)))
      : v.open_hours;
    db.prepare(`UPDATE venues SET open_hours = ? WHERE id = ?`).run(openHours, v.id);
    if (user.role === 'venue_manager') {
      // Venues control which ad categories appear and their hours; commercial terms belong to the operator.
      db.prepare(`UPDATE venues SET blocked_ad_categories = ? WHERE id = ?`).run(blocked, v.id);
    } else {
      db.prepare(`
        UPDATE venues SET name = ?, address = ?, lat = ?, lng = ?, timezone = ?, category = ?, blocked_ad_categories = ?,
          audience_multiplier = ?, rev_share_pct = ?, venue_type = ? WHERE id = ?`).run(
        b.name !== undefined ? str(b.name, 'name') : v.name,
        b.address !== undefined ? optStr(b.address, 'address', 300) ?? '' : v.address,
        b.lat !== undefined ? num(b.lat, 'lat', -90, 90) : v.lat,
        b.lng !== undefined ? num(b.lng, 'lng', -180, 180) : v.lng,
        b.timezone !== undefined ? validTimezone(b.timezone) : v.timezone,
        b.category !== undefined ? oneOf(b.category, 'category', VENUE_CATEGORIES) : v.category,
        blocked,
        b.audienceMultiplier !== undefined ? num(b.audienceMultiplier, 'audienceMultiplier', 0, 1000) : v.audience_multiplier,
        b.revSharePct !== undefined ? num(b.revSharePct, 'revSharePct', 0, 100) : v.rev_share_pct,
        b.venueType !== undefined ? venueTypeInput(b.venueType) : v.venue_type,
        v.id,
      );
    }
    return toApi(db.prepare(`SELECT * FROM venues WHERE id = ?`).get(v.id));
  });

  // House content (venue promos shown between ads)
  router.post('/api/venues/:id/house-creatives', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueFor(ctx, user, ctx.params.id);
    const up = saveUpload(config.uploadsDir, ctx.body.dataBase64);
    const list = JSON.parse(v.house_creatives);
    list.push({ id: newId('hc'), url: up.url, type: up.type, durationSec: num(ctx.body.durationSec ?? 10, 'durationSec', 3, 120) });
    db.prepare(`UPDATE venues SET house_creatives = ? WHERE id = ?`).run(JSON.stringify(list), v.id);
    return toApi(db.prepare(`SELECT * FROM venues WHERE id = ?`).get(v.id));
  });

  router.post('/api/venues/:id/house-creatives/template', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueFor(ctx, user, ctx.params.id);
    const up = saveGeneratedSvg(config.uploadsDir, renderTemplate(ctx.body));
    const list = JSON.parse(v.house_creatives);
    list.push({ id: newId('hc'), url: up.url, type: up.type, durationSec: num(ctx.body.durationSec ?? 10, 'durationSec', 3, 120) });
    db.prepare(`UPDATE venues SET house_creatives = ? WHERE id = ?`).run(JSON.stringify(list), v.id);
    return toApi(db.prepare(`SELECT * FROM venues WHERE id = ?`).get(v.id));
  });

  router.delete('/api/venues/:id/house-creatives/:hcId', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueFor(ctx, user, ctx.params.id);
    const list = JSON.parse(v.house_creatives).filter((h: any) => h.id !== ctx.params.hcId);
    db.prepare(`UPDATE venues SET house_creatives = ? WHERE id = ?`).run(JSON.stringify(list), v.id);
    return toApi(db.prepare(`SELECT * FROM venues WHERE id = ?`).get(v.id));
  });

  // Venue manager logins
  router.post('/api/venues/:id/users', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const v = venueFor(ctx, user, ctx.params.id);
    const addr = email(ctx.body.email);
    if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(addr)) throw new HttpError(409, 'email already registered');
    const id = createUser(db, {
      email: addr, password: str(ctx.body.password, 'password', 8, 200), name: str(ctx.body.name, 'name'),
      role: 'venue_manager', operatorId: v.operator_id, venueId: v.id,
    });
    return { id, email: addr };
  });

  // ---- Menus ----
  router.get('/api/venues/:id/menu', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueFor(ctx, user, ctx.params.id);
    const m = db.prepare(`SELECT * FROM menus WHERE venue_id = ?`).get(v.id);
    return m ? toApi(m) : { venueId: v.id, title: v.name, theme: 'dark', sections: [], updatedAt: null };
  });

  router.put('/api/venues/:id/menu', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueFor(ctx, user, ctx.params.id);
    const b = ctx.body;
    if (!Array.isArray(b.sections) || b.sections.length > 12) throw new HttpError(400, 'sections must be a list (max 12)');
    const sections = b.sections.map((s: any, i: number) => {
      if (!Array.isArray(s?.items) || s.items.length > 30) throw new HttpError(400, `sections[${i}].items must be a list (max 30)`);
      return {
        name: str(s.name, `sections[${i}].name`, 1, 60),
        items: s.items.map((it: any, j: number) => ({
          name: str(it?.name, `sections[${i}].items[${j}].name`, 1, 80),
          price: optStr(it.price, 'price', 20) ?? '',
          description: optStr(it.description, 'description', 160) ?? '',
          soldOut: !!it.soldOut,
        })),
      };
    });
    db.prepare(`INSERT OR REPLACE INTO menus VALUES (?, ?, ?, ?, ?, ?)`).run(
      v.id, v.operator_id, str(b.title ?? v.name, 'title', 1, 80), oneOf(b.theme ?? 'dark', 'theme', ['dark', 'light', 'brand']),
      JSON.stringify(sections), nowIso(),
    );
    return toApi(db.prepare(`SELECT * FROM menus WHERE venue_id = ?`).get(v.id));
  });

  // ---- Screens ----
  const SCREEN_SELECT = `
    SELECT s.*, v.name AS venue_name, v.open_hours AS venue_open_hours, v.timezone AS venue_timezone,
      d.id AS device_id, d.last_seen_at, d.last_status
    FROM screens s JOIN venues v ON v.id = s.venue_id LEFT JOIN devices d ON d.screen_id = s.id`;
  const withStatus = (r: any) => {
    const { venueOpenHours, venueTimezone, ...rest } = toApi(r);
    return {
      ...rest,
      status: screenStatus(r.last_seen_at, !!r.device_id),
      venueOpen: isOpenAt(r.venue_open_hours ? JSON.parse(r.venue_open_hours) : null, r.venue_timezone, new Date()),
    };
  };

  router.get('/api/screens', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const rows = user.role === 'venue_manager'
      ? db.prepare(`${SCREEN_SELECT} WHERE s.venue_id = ? ORDER BY s.name`).all(user.venueId)
      : db.prepare(`${SCREEN_SELECT} WHERE s.operator_id = ? ORDER BY v.name, s.name`).all(actingOperatorId(ctx, user));
    return rows.map(withStatus);
  });

  router.post('/api/screens', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const v = venueFor(ctx, user, str(ctx.body.venueId, 'venueId'));
    const mode = oneOf(ctx.body.mode ?? 'idle', 'mode', SCREEN_MODES);
    const id = newId('scr');
    const b = ctx.body;
    db.prepare(`INSERT INTO screens (id, operator_id, venue_id, name, mode, ad_share_pct, loop_sec, width_px, height_px, diagonal_in, audio, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, v.operator_id, v.id, str(b.name, 'name'), mode,
      num(b.adSharePct ?? (mode === 'menu' ? 20 : 40), 'adSharePct', 0, 100),
      int(b.loopSec ?? 120, 'loopSec', 30, 900),
      int(b.widthPx ?? 1920, 'widthPx', 320, 8192), int(b.heightPx ?? 1080, 'heightPx', 240, 8192),
      b.diagonalIn != null && b.diagonalIn !== '' ? num(b.diagonalIn, 'diagonalIn', 10, 400) : null, b.audio ? 1 : 0, nowIso(),
    );
    return withStatus(db.prepare(`${SCREEN_SELECT} WHERE s.id = ?`).get(id));
  });

  router.put('/api/screens/:id', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const s = screenFor(ctx, user, ctx.params.id);
    const b = ctx.body;
    db.prepare(`UPDATE screens SET name = ?, mode = ?, ad_share_pct = ?, loop_sec = ?, width_px = ?, height_px = ?, diagonal_in = ?, audio = ? WHERE id = ?`).run(
      b.name !== undefined ? str(b.name, 'name') : s.name,
      b.mode !== undefined ? oneOf(b.mode, 'mode', SCREEN_MODES) : s.mode,
      b.adSharePct !== undefined ? num(b.adSharePct, 'adSharePct', 0, 100) : s.ad_share_pct,
      b.loopSec !== undefined ? int(b.loopSec, 'loopSec', 30, 900) : s.loop_sec,
      b.widthPx !== undefined ? int(b.widthPx, 'widthPx', 320, 8192) : s.width_px,
      b.heightPx !== undefined ? int(b.heightPx, 'heightPx', 240, 8192) : s.height_px,
      b.diagonalIn !== undefined ? (b.diagonalIn === null || b.diagonalIn === '' ? null : num(b.diagonalIn, 'diagonalIn', 10, 400)) : s.diagonal_in,
      b.audio !== undefined ? (b.audio ? 1 : 0) : s.audio,
      s.id,
    );
    return withStatus(db.prepare(`${SCREEN_SELECT} WHERE s.id = ?`).get(s.id));
  });

  router.post('/api/screens/:id/pair', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const s = screenFor(ctx, user, ctx.params.id);
    const code = str(ctx.body.code, 'code', 4, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const d = db.prepare(`SELECT * FROM devices WHERE pairing_code = ? AND pairing_expires_at > ?`).get(code, nowIso()) as any;
    if (!d) throw new HttpError(404, 'pairing code not found or expired');
    assertCanPair(db, config, s.operator_id, !!db.prepare(`SELECT 1 FROM devices WHERE screen_id = ?`).get(s.id));
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE devices SET screen_id = NULL, operator_id = NULL WHERE screen_id = ?`).run(s.id);
      db.prepare(`UPDATE devices SET screen_id = ?, operator_id = ?, pairing_code = NULL, pairing_expires_at = NULL WHERE id = ?`)
        .run(s.id, s.operator_id, d.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    syncQuantitySoon(db, config, s.operator_id);
    return withStatus(db.prepare(`${SCREEN_SELECT} WHERE s.id = ?`).get(s.id));
  });

  router.post('/api/screens/:id/unpair', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const s = screenFor(ctx, user, ctx.params.id);
    db.prepare(`UPDATE devices SET screen_id = NULL, operator_id = NULL WHERE screen_id = ?`).run(s.id);
    syncQuantitySoon(db, config, s.operator_id);
    return withStatus(db.prepare(`${SCREEN_SELECT} WHERE s.id = ?`).get(s.id));
  });

  router.post('/api/screens/:id/commands', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const s = screenFor(ctx, user, ctx.params.id);
    const type = oneOf(ctx.body.type, 'type', DEVICE_COMMANDS);
    const d = db.prepare(`SELECT id FROM devices WHERE screen_id = ?`).get(s.id) as any;
    if (!d) throw new HttpError(409, 'screen has no paired device');
    const id = newId('cmd');
    db.prepare(`INSERT INTO device_commands (id, device_id, screen_id, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, d.id, s.id, type, user.id, nowIso());
    return { id, type, status: 'queued' };
  });

  router.get('/api/fleet', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const screens = db.prepare(`${SCREEN_SELECT} WHERE s.operator_id = ? ORDER BY v.name, s.name`)
      .all(actingOperatorId(ctx, user)).map(withStatus);
    const summary = { total: screens.length, online: 0, offline: 0, unpaired: 0 };
    for (const s of screens) summary[s.status as 'online' | 'offline' | 'unpaired']++;
    // A screen at a closed venue is expected to be off, so only alert while the venue is open.
    const alerts = screens
      .filter((s) => s.status === 'unpaired' || (s.status === 'offline' && s.venueOpen))
      .map((s) => ({
        screenId: s.id,
        severity: s.status === 'offline' ? 'high' : 'low',
        message: s.status === 'offline'
          ? `${s.venueName} · ${s.name} offline since ${s.lastSeenAt ?? 'never seen'}`
          : `${s.venueName} · ${s.name} has no paired device`,
      }));
    return { summary, screens, alerts };
  });

  // ---- Advertisers ----
  router.get('/api/advertisers', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return db.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM campaigns c WHERE c.advertiser_id = a.id) AS campaign_count
      FROM advertisers a WHERE a.operator_id = ? ORDER BY a.name`).all(actingOperatorId(ctx, user)).map(toApi);
  });

  router.post('/api/advertisers', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const operatorId = actingOperatorId(ctx, user);
    const id = newId('adv');
    const contact = ctx.body.contactEmail ? email(ctx.body.contactEmail) : null;
    db.prepare(`INSERT INTO advertisers VALUES (?, ?, ?, ?, ?)`).run(id, operatorId, str(ctx.body.name, 'name'), contact, nowIso());
    // Optionally give the advertiser a self-serve login
    if (contact && ctx.body.password) {
      if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(contact)) throw new HttpError(409, 'email already registered');
      createUser(db, {
        email: contact, password: str(ctx.body.password, 'password', 8, 200), name: str(ctx.body.name, 'name'),
        role: 'advertiser', operatorId, advertiserId: id,
      });
    }
    return toApi(db.prepare(`SELECT * FROM advertisers WHERE id = ?`).get(id));
  });
}
