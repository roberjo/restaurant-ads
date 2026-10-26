// Inventory forecast: ad capacity over the coming days from venue hours, screen ad share and audience multipliers.
import type { DatabaseSync } from 'node:sqlite';
import { isOpenAt } from './hours.ts';
import { venueType } from './quality.ts';

export const AD_SLOT_SEC = 10;
export const DAYPARTS: Array<[name: string, startHour: number, endHour: number]> = [
  ['breakfast', 6, 11], ['lunch', 11, 14], ['afternoon', 14, 17], ['dinner', 17, 21], ['late', 21, 6],
];

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function localHour(d: Date, tz: string): number {
  let f = hourFormatters.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }); hourFormatters.set(tz, f); }
  return Number(f.format(d));
}
export const daypartOf = (hour: number) =>
  DAYPARTS.find(([, s, e]) => (s < e ? hour >= s && hour < e : hour >= s || hour < e))![0];

interface Bucket { adSeconds: number; impressions: number }
const add = (m: Map<string, Bucket>, k: string, adSeconds: number, impressions: number) => {
  const b = m.get(k) ?? { adSeconds: 0, impressions: 0 };
  b.adSeconds += adSeconds;
  b.impressions += impressions;
  m.set(k, b);
};
const rows = (m: Map<string, Bucket>, key: string) =>
  [...m.entries()].map(([k, b]) => ({ [key]: k, adSeconds: Math.round(b.adSeconds), impressions: Math.round(b.impressions) }))
    .sort((a, b) => b.impressions - a.impressions);

/**
 * Forecast ad capacity for paired screens of the given operators over the next `days` days.
 * Capacity per open hour = 3600 s × ad share; impressions = ad seconds / slot length × audience multiplier.
 */
export function forecastInventory(db: DatabaseSync, operatorIds: string[], days = 7, from = new Date()) {
  const marks = operatorIds.map(() => '?').join(',') || 'NULL';
  const screens = db.prepare(`
    SELECT s.ad_share_pct, v.id AS venue_id, v.name AS venue_name, v.category, v.venue_type, v.open_hours, v.timezone, v.audience_multiplier
    FROM screens s JOIN devices d ON d.screen_id = s.id JOIN venues v ON v.id = s.venue_id
    WHERE s.operator_id IN (${marks})`).all(...operatorIds) as any[];

  const byVenueType = new Map<string, Bucket>();
  const byDaypart = new Map<string, Bucket>();
  const byVenue = new Map<string, Bucket>();
  const byDay = new Map<string, Bucket>();
  const start = Math.floor(from.getTime() / 3600_000) * 3600_000 + 3600_000;
  // Open hours are per venue, so evaluate each venue's hours once and scale by its screens.
  const venues = new Map<string, { v: any; adShares: number[] }>();
  for (const s of screens) {
    const e = venues.get(s.venue_id) ?? { v: s, adShares: [] };
    e.adShares.push(s.ad_share_pct);
    venues.set(s.venue_id, e);
  }
  for (const { v, adShares } of venues.values()) {
    const hours = v.open_hours ? JSON.parse(v.open_hours) : null;
    const adSecPerHour = adShares.reduce((sum, pct) => sum + (3600 * pct) / 100, 0);
    const vt = venueType(v);
    for (let i = 0; i < days * 24; i++) {
      const t = new Date(start + i * 3600_000);
      if (!isOpenAt(hours, v.timezone, new Date(t.getTime() + 30 * 60_000))) continue;
      const imps = (adSecPerHour / AD_SLOT_SEC) * v.audience_multiplier;
      add(byVenueType, vt, adSecPerHour, imps);
      add(byDaypart, daypartOf(localHour(t, v.timezone)), adSecPerHour, imps);
      add(byVenue, `${v.venue_id}|${v.venue_name}`, adSecPerHour, imps);
      add(byDay, t.toISOString().slice(0, 10), adSecPerHour, imps);
    }
  }
  const total = [...byVenueType.values()].reduce((s, b) => ({ adSeconds: s.adSeconds + b.adSeconds, impressions: s.impressions + b.impressions }), { adSeconds: 0, impressions: 0 });
  return {
    days,
    from: new Date(start).toISOString(),
    screens: screens.length,
    totals: { adSeconds: Math.round(total.adSeconds), impressions: Math.round(total.impressions), adSlots: Math.floor(total.adSeconds / AD_SLOT_SEC) },
    byVenueType: rows(byVenueType, 'venueType'),
    byDaypart: rows(byDaypart, 'daypart'),
    byDay: rows(byDay, 'day').sort((a, b) => String(a.day).localeCompare(String(b.day))),
    byVenue: rows(byVenue, 'venue').map((r) => { const [id, name] = String(r.venue).split('|'); return { ...r, venueId: id, venue: name }; }),
    assumptions: { adSlotSec: AD_SLOT_SEC, openHours: 'venue hours (always open when unknown)', scope: 'paired screens', capacityNotSold: true },
  };
}
