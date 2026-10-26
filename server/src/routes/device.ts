// Device API used by players: self-registration, pairing, playlists, menus, heartbeats, proof-of-play.
import { randomBytes, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { deviceFromRequest, newId, rateLimiter, sha256, type Device } from '../auth.ts';
import { campaignForScheduler, getSetting, nowIso, toApi } from '../db.ts';
import { HttpError } from '../http.ts';
import { MICROS_PER_CENT, priceImpressions, splitRevenue } from '../ledger.ts';
import { buildPlaylist, isEligible, type Campaign, type Creative, type Venue } from '../scheduler.ts';
import type { App } from '../app-types.ts';
import { powerState } from '../hours.ts';
import { recordActivity } from '../quality.ts';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_TTL_MS = 24 * 3600_000;
const PLAYLIST_TTL_SEC = 300;
const MAX_EVENT_AGE_MS = 7 * 24 * 3600_000;
const MIN_PLAY_FRACTION = 0.8;

function pairingCode(): string {
  return Array.from({ length: 6 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('');
}

interface ScreenCtx {
  screen: any;
  venueRow: any;
  operator: any;
  venue: Venue;
  menu: any | null;
}

function loadScreenCtx(db: DatabaseSync, device: Device): ScreenCtx {
  if (!device.screenId) throw new HttpError(409, 'device is not paired');
  const screen = db.prepare(`SELECT * FROM screens WHERE id = ?`).get(device.screenId) as any;
  const venueRow = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(screen.venue_id) as any;
  const operator = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(screen.operator_id) as any;
  const menu = db.prepare(`SELECT * FROM menus WHERE venue_id = ?`).get(venueRow.id) as any;
  const menuSlot: Creative = { id: 'menu', url: '/api/device/menu', type: 'menu', durationSec: screen.mode === 'menu' ? 30 : 15 };
  const houseCreatives: Creative[] = JSON.parse(venueRow.house_creatives);
  const hasMenu = !!menu && JSON.parse(menu.sections).length > 0;
  const house =
    screen.mode === 'menu' ? (hasMenu ? [menuSlot] : houseCreatives)
    : screen.mode === 'idle' ? (hasMenu ? [...houseCreatives, menuSlot] : houseCreatives)
    : houseCreatives;
  const venue: Venue = {
    id: venueRow.id,
    name: venueRow.name,
    lat: venueRow.lat,
    lng: venueRow.lng,
    timezone: venueRow.timezone,
    category: venueRow.category,
    blockedAdCategories: JSON.parse(venueRow.blocked_ad_categories),
    audienceMultiplier: venueRow.audience_multiplier,
    houseCreatives: house,
  };
  return { screen, venueRow, operator, venue, menu };
}

/** Campaigns that may serve on this operator's screens: their own, plus network campaigns if opted in. */
function servableCampaignRows(db: DatabaseSync, operator: any, statuses: string[]): any[] {
  const marks = statuses.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM campaigns
    WHERE status IN (${marks}) AND (operator_id = ? OR (operator_id IS NULL AND ? = 1))`)
    .all(...statuses, operator.id, operator.network_opt_in) as any[];
}

export function buildScreenPlaylist(db: DatabaseSync, device: Device, now = new Date()) {
  const sc = loadScreenCtx(db, device);
  const campaigns = servableCampaignRows(db, sc.operator, ['active'])
    .filter((r) => r.spent_micros < r.budget_cents * MICROS_PER_CENT)
    .map((r) => campaignForScheduler(db, r));
  const slots = buildPlaylist(sc.venue, campaigns, now, { loopSec: sc.screen.loop_sec, adSharePct: sc.screen.ad_share_pct });
  return { screenId: sc.screen.id, mode: sc.screen.mode, generatedAt: now.toISOString(), ttlSec: PLAYLIST_TTL_SEC, slots };
}

export interface PopEvent {
  id: string;
  creativeId: string;
  campaignId?: string | null;
  playedAt: string;
  durationSec: number;
}

/**
 * Verify and record proof-of-play events, pricing each ad play and splitting revenue.
 * Rejects plays for campaigns this screen could not have been served, plays shorter than the
 * creative, and timestamps that are stale or in the future.
 */
export function ingestPop(db: DatabaseSync, device: Device, events: PopEvent[], now = new Date()): { accepted: number; rejected: number; duplicates: number } {
  const sc = loadScreenCtx(db, device);
  const networkTake = Number(getSetting(db, 'network_take_pct') ?? 20);
  const servable = new Map(servableCampaignRows(db, sc.operator, ['active', 'paused', 'completed']).map((r) => [r.id, r]));
  const schedCache = new Map<string, Campaign>();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pop_events (id, device_id, screen_id, venue_id, operator_id, campaign_id, creative_id,
      played_at, duration_sec, impressions, gross_micros, platform_micros, operator_micros, venue_micros, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const receivedAt = now.toISOString();
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;

  db.exec('BEGIN');
  try {
    for (const e of events.slice(0, 1000)) {
      const playedMs = Date.parse(e?.playedAt);
      const valid =
        typeof e?.id === 'string' && e.id.length <= 200 && typeof e.creativeId === 'string' &&
        Number.isFinite(playedMs) && playedMs <= now.getTime() + 5 * 60_000 && now.getTime() - playedMs <= MAX_EVENT_AGE_MS &&
        Number.isFinite(Number(e.durationSec));
      if (!valid) { rejected++; continue; }
      const playedAt = new Date(playedMs).toISOString();
      const id = `${device.id}:${e.id}`;
      let money = { impressions: 0, grossMicros: 0, platformMicros: 0, operatorMicros: 0, venueMicros: 0 };

      if (e.campaignId) {
        const row = servable.get(e.campaignId);
        let camp = row && schedCache.get(row.id);
        if (row && !camp) { camp = campaignForScheduler(db, row); schedCache.set(row.id, camp); }
        const creative = camp?.creatives.find((c) => c.id === e.creativeId);
        if (!row || !camp || !creative || !isEligible(camp, sc.venue, new Date(playedMs)) ||
            Number(e.durationSec) < creative.durationSec * MIN_PLAY_FRACTION) {
          rejected++;
          continue;
        }
        const impressions = sc.venue.audienceMultiplier;
        const fresh = db.prepare(`SELECT spent_micros, budget_cents, status FROM campaigns WHERE id = ?`).get(row.id) as any;
        const remaining = Math.max(0, fresh.budget_cents * MICROS_PER_CENT - fresh.spent_micros);
        const gross = Math.min(priceImpressions(impressions, row.cpm_cents), remaining);
        const platformPct = row.operator_id === null ? networkTake : sc.operator.platform_fee_pct;
        const split = splitRevenue(gross, platformPct, sc.venueRow.rev_share_pct);
        money = { impressions, ...split };
      }

      const r = insert.run(
        id, device.id, sc.screen.id, sc.venueRow.id, sc.operator.id, e.campaignId ?? null, e.creativeId,
        playedAt, Number(e.durationSec), money.impressions, money.grossMicros, money.platformMicros,
        money.operatorMicros, money.venueMicros, receivedAt,
      );
      if (!r.changes) { duplicates++; continue; }
      accepted++;
      if (e.campaignId && money.grossMicros > 0) {
        db.prepare(`UPDATE campaigns SET spent_micros = spent_micros + ? WHERE id = ?`).run(money.grossMicros, e.campaignId);
        db.prepare(`UPDATE campaigns SET status = 'completed' WHERE id = ? AND status = 'active' AND spent_micros >= budget_cents * ?`)
          .run(e.campaignId, MICROS_PER_CENT);
      }
    }
    recordActivity(db, sc.screen.id, { plays: accepted, rejected }, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { accepted, rejected, duplicates };
}

export function registerDevice({ db, router }: App): void {
  const registerLimit = rateLimiter(20, 3600_000);
  const touch = (d: Device, status?: unknown) =>
    db.prepare(`UPDATE devices SET last_seen_at = ?${status !== undefined ? ', last_status = ?' : ''} WHERE id = ?`)
      .run(nowIso(), ...(status !== undefined ? [JSON.stringify(status).slice(0, 2000)] : []), d.id);

  router.post('/api/device/register', (ctx) => {
    registerLimit(String(ctx.req.socket.remoteAddress));
    const id = newId('dev');
    const secret = randomBytes(24).toString('base64url');
    const code = pairingCode();
    db.prepare(`INSERT INTO devices (id, secret_hash, pairing_code, pairing_expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, sha256(secret), code, new Date(Date.now() + PAIRING_TTL_MS).toISOString(), nowIso());
    return { deviceId: id, deviceSecret: secret, pairingCode: code };
  });

  router.get('/api/device/state', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    touch(d);
    if (!d.screenId) {
      let row = db.prepare(`SELECT pairing_code, pairing_expires_at FROM devices WHERE id = ?`).get(d.id) as any;
      if (!row.pairing_code || row.pairing_expires_at < nowIso()) {
        db.prepare(`UPDATE devices SET pairing_code = ?, pairing_expires_at = ? WHERE id = ?`)
          .run(pairingCode(), new Date(Date.now() + PAIRING_TTL_MS).toISOString(), d.id);
        row = db.prepare(`SELECT pairing_code, pairing_expires_at FROM devices WHERE id = ?`).get(d.id);
      }
      return { paired: false, pairingCode: row.pairing_code, pairingExpiresAt: row.pairing_expires_at };
    }
    const sc = loadScreenCtx(db, d);
    return {
      paired: true,
      screen: { id: sc.screen.id, name: sc.screen.name, mode: sc.screen.mode, venueName: sc.venueRow.name },
      brand: { name: sc.operator.name, color: sc.operator.brand_color, logoUrl: sc.operator.logo_url },
    };
  });

  router.get('/api/device/playlist', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    touch(d);
    return buildScreenPlaylist(db, d);
  });

  router.get('/api/device/menu', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    const sc = loadScreenCtx(db, d);
    return {
      ...(sc.menu ? toApi(sc.menu) : { title: sc.venueRow.name, theme: 'dark', sections: [] }),
      brandColor: sc.operator.brand_color,
    };
  });

  router.post('/api/device/heartbeat', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    touch(d, ctx.body ?? {});
    if (d.screenId) recordActivity(db, d.screenId, { heartbeats: 1 });
    const commands = db.prepare(`SELECT id, type, created_at FROM device_commands WHERE device_id = ? AND acked_at IS NULL ORDER BY created_at`)
      .all(d.id).map(toApi);
    return { ok: true, paired: !!d.screenId, commands };
  });

  router.post('/api/device/commands/:id/ack', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    const r = db.prepare(`UPDATE device_commands SET acked_at = ? WHERE id = ? AND device_id = ? AND acked_at IS NULL`)
      .run(nowIso(), ctx.params.id, d.id);
    return { ok: r.changes > 0 };
  });

  // Used by local agents (e.g. the Raspberry Pi HDMI-CEC agent). It deliberately doesn't count as a
  // heartbeat: only the player reports liveness, so a crashed browser still shows as offline.
  router.get('/api/device/power', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    if (!d.screenId) return { power: 'on', paired: false };
    const v = db.prepare(`SELECT v.open_hours, v.timezone FROM screens s JOIN venues v ON v.id = s.venue_id WHERE s.id = ?`).get(d.screenId) as any;
    return { power: powerState(v.open_hours ? JSON.parse(v.open_hours) : null, v.timezone, new Date()), paired: true };
  });

  router.post('/api/device/pop', (ctx) => {
    const d = deviceFromRequest(db, ctx);
    touch(d);
    if (!Array.isArray(ctx.body?.events)) throw new HttpError(400, 'events must be a list');
    return ingestPop(db, d, ctx.body.events);
  });
}
