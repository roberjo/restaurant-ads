// Venue metadata for programmatic buyers, screen activity tracking, and the operator quality score
// that gates access to programmatic demand.
import type { DatabaseSync } from 'node:sqlite';
import { getSetting } from './db.ts';
import { isOpenAt } from './hours.ts';

/**
 * Default OpenOOH venue taxonomy IDs per venue category. Operators can override per venue;
 * confirm against the taxonomy version each SSP supports.
 */
export const DEFAULT_VENUE_TYPES: Record<string, string> = {
  qsr: 'entertainment.qsr',
  casual_dining: 'entertainment.casual_dining',
  bar: 'entertainment.bars',
  cafe: 'entertainment.qsr',
  barbershop: 'health_and_beauty.salons',
  laundromat: 'retail.laundromats',
  gym: 'health_and_beauty.gyms',
  retail: 'retail',
  other: 'other',
};

export const venueType = (v: { venue_type?: string | null; category: string }) =>
  v.venue_type || DEFAULT_VENUE_TYPES[v.category] || 'other';

export const hourBucket = (d: Date) => d.toISOString().slice(0, 13);

/** Count player activity per screen per UTC hour: heartbeats prove uptime, plays/rejections measure compliance. */
export function recordActivity(db: DatabaseSync, screenId: string, counts: { heartbeats?: number; plays?: number; rejected?: number }, now = new Date()): void {
  db.prepare(`
    INSERT INTO screen_activity (screen_id, hour, heartbeats, plays, rejected) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (screen_id, hour) DO UPDATE SET heartbeats = heartbeats + excluded.heartbeats,
      plays = plays + excluded.plays, rejected = rejected + excluded.rejected`)
    .run(screenId, hourBucket(now), counts.heartbeats ?? 0, counts.plays ?? 0, counts.rejected ?? 0);
}

const MIN_SCREEN_HOURS = 24;
const WEIGHTS = { uptime: 0.6, metadata: 0.2, compliance: 0.2 };

export interface Quality {
  score: number | null;
  uptimePct: number | null;
  metadataPct: number;
  compliancePct: number;
  expectedScreenHours: number;
  pairedScreens: number;
  minScore: number;
  override: string | null;
  eligible: boolean;
  reason: string;
}

/**
 * Quality over the last `days` days:
 * - uptime: share of open hours (venue hours, after the device was set up) in which the player sent a heartbeat
 * - metadata: venue type, open hours, address and screen size filled in
 * - compliance: share of reported plays that passed proof-of-play checks
 */
export function operatorQuality(db: DatabaseSync, operatorId: string, now = new Date(), days = 7): Quality {
  const op = db.prepare(`SELECT programmatic_override FROM operators WHERE id = ?`).get(operatorId) as any;
  const minScore = Number(getSetting(db, 'programmatic_min_quality') ?? 80);
  const screens = db.prepare(`
    SELECT s.id, s.diagonal_in, d.created_at AS device_since, v.id AS venue_id, v.open_hours, v.timezone, v.venue_type, v.address
    FROM screens s JOIN devices d ON d.screen_id = s.id JOIN venues v ON v.id = s.venue_id WHERE s.operator_id = ?`).all(operatorId) as any[];

  const start = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000 - days * 24 * 3600_000);
  const seen = new Set((db.prepare(`
    SELECT a.screen_id || '|' || a.hour AS k FROM screen_activity a JOIN screens s ON s.id = a.screen_id
    WHERE s.operator_id = ? AND a.hour >= ? AND a.heartbeats > 0`).all(operatorId, hourBucket(start)) as any[]).map((r) => r.k));
  let expected = 0;
  let up = 0;
  for (const s of screens) {
    const hours = s.open_hours ? JSON.parse(s.open_hours) : null;
    const since = Date.parse(s.device_since);
    for (let t = start.getTime(); t + 3600_000 <= now.getTime(); t += 3600_000) {
      if (t < since || !isOpenAt(hours, s.timezone, new Date(t + 30 * 60_000))) continue;
      expected++;
      if (seen.has(`${s.id}|${hourBucket(new Date(t))}`)) up++;
    }
  }

  const checks: boolean[] = [];
  const venues = new Map(screens.map((s) => [s.venue_id, s]));
  for (const v of venues.values()) checks.push(!!v.venue_type, !!v.open_hours, !!v.address);
  for (const s of screens) checks.push(!!s.diagonal_in);
  const metadataPct = checks.length ? Math.round((100 * checks.filter(Boolean).length) / checks.length) : 0;

  const act = db.prepare(`
    SELECT COALESCE(SUM(a.plays), 0) AS plays, COALESCE(SUM(a.rejected), 0) AS rejected
    FROM screen_activity a JOIN screens s ON s.id = a.screen_id WHERE s.operator_id = ? AND a.hour >= ?`).get(operatorId, hourBucket(start)) as any;
  const reported = act.plays + act.rejected;
  const compliancePct = reported ? Math.round((100 * act.plays) / reported) : 100;

  const uptimePct = expected ? Math.round((100 * up) / expected) : null;
  const score = uptimePct === null ? null
    : Math.round(WEIGHTS.uptime * uptimePct + WEIGHTS.metadata * metadataPct + WEIGHTS.compliance * compliancePct);
  const override = op?.programmatic_override ?? null;

  let eligible: boolean;
  let reason: string;
  if (override === 'allow') { eligible = true; reason = 'approved by the platform'; }
  else if (override === 'deny') { eligible = false; reason = 'paused by the platform'; }
  else if (expected < MIN_SCREEN_HOURS) { eligible = false; reason = `needs ${MIN_SCREEN_HOURS} open screen-hours of history (has ${expected})`; }
  else if (score! < minScore) { eligible = false; reason = `quality score ${score} is below ${minScore}`; }
  else { eligible = true; reason = `quality score ${score} meets ${minScore}`; }

  return { score, uptimePct, metadataPct, compliancePct, expectedScreenHours: expected, pairedScreens: screens.length, minScore, override, eligible, reason };
}
