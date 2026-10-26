// Inventory forecast: ad capacity over the coming days from venue hours, screen ad share and audience multipliers,
// net of what booked campaigns will take.
import type { DatabaseSync } from 'node:sqlite';
import { campaignForScheduler } from './db.ts';
import { isOpenAt } from './hours.ts';
import { MICROS_PER_CENT } from './ledger.ts';
import { venueType } from './quality.ts';
import { buildPlaylist, type Campaign, type Venue } from './scheduler.ts';

export const AD_SLOT_SEC = 10;
export const DAYPARTS: Array<[name: string, startHour: number, endHour: number]> = [
  ['breakfast', 6, 11], ['lunch', 11, 14], ['afternoon', 14, 17], ['dinner', 17, 21], ['late', 21, 6],
];

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function localParts(d: Date, tz: string): { date: string; hour: number } {
  let f = hourFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    hourFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
export const daypartOf = (hour: number) =>
  DAYPARTS.find(([, s, e]) => (s < e ? hour >= s && hour < e : hour >= s || hour < e))![0];

interface Bucket { adSeconds: number; impressions: number; soldSeconds: number; soldImpressions: number }
const empty = (): Bucket => ({ adSeconds: 0, impressions: 0, soldSeconds: 0, soldImpressions: 0 });
const add = (m: Map<string, Bucket>, k: string, d: Partial<Bucket>) => {
  const b = m.get(k) ?? empty();
  for (const key of Object.keys(d) as Array<keyof Bucket>) b[key] += d[key]!;
  m.set(k, b);
};
const present = (b: Bucket) => {
  const availableSeconds = Math.max(0, b.adSeconds - b.soldSeconds);
  return {
    adSeconds: Math.round(b.adSeconds),
    impressions: Math.round(b.impressions),
    soldSeconds: Math.round(b.soldSeconds),
    soldImpressions: Math.round(b.soldImpressions),
    availableSeconds: Math.round(availableSeconds),
    // Unsold capacity priced like capacity (per ad slot), so available ≤ capacity even when sold creatives are short.
    availableImpressions: Math.round(b.adSeconds ? (b.impressions * availableSeconds) / b.adSeconds : 0),
    sellThroughPct: b.adSeconds ? Math.round((1000 * Math.min(b.soldSeconds, b.adSeconds)) / b.adSeconds) / 10 : 0,
  };
};
const rows = (m: Map<string, Bucket>, key: string) =>
  [...m.entries()].map(([k, b]) => ({ [key]: k, ...present(b) })).sort((a, b) => b.impressions - a.impressions);

export interface ForecastOptions {
  /** Only count venues of these OpenOOH venue types (e.g. a deal's targeting). */
  venueTypes?: string[] | null;
}

/**
 * Forecast ad capacity for paired screens of the given operators over the next `days` days.
 * Capacity per open hour = 3600 s × ad share; impressions = ad seconds / slot length × audience multiplier.
 * Sold = what active campaigns (the operator's own, plus network campaigns where opted in) would take of each
 * hour's loop, as the scheduler would build it, capped by each campaign's remaining budget.
 */
export function forecastInventory(db: DatabaseSync, operatorIds: string[], days = 7, from = new Date(), opts: ForecastOptions = {}) {
  const marks = operatorIds.map(() => '?').join(',') || 'NULL';
  const screens = (db.prepare(`
    SELECT s.id AS screen_id, s.ad_share_pct, s.loop_sec, s.operator_id, v.id AS venue_id, v.name AS venue_name, v.category,
      v.venue_type, v.open_hours, v.timezone, v.audience_multiplier, v.lat, v.lng, v.blocked_ad_categories
    FROM screens s JOIN devices d ON d.screen_id = s.id JOIN venues v ON v.id = s.venue_id
    WHERE s.operator_id IN (${marks})`).all(...operatorIds) as any[]);
  // Out-of-scope screens are still simulated: they spend the same campaign budgets.
  const inScope = (s: any) => !opts.venueTypes?.length || opts.venueTypes.includes(venueType(s));

  // Booked campaigns per operator, with how many impressions their remaining budget still buys.
  const campaignRows = new Map<string, any>();
  const campaignsFor = new Map<string, Campaign[]>();
  for (const opId of new Set(screens.map((s) => s.operator_id as string))) {
    const list = db.prepare(`
      SELECT c.* FROM campaigns c, operators o WHERE o.id = ? AND c.status = 'active'
        AND (c.operator_id = o.id OR (c.operator_id IS NULL AND o.network_opt_in = 1))`).all(opId) as any[];
    for (const r of list) campaignRows.set(r.id, r);
    campaignsFor.set(opId, list.filter((r) => r.spent_micros < r.budget_cents * MICROS_PER_CENT).map((r) => campaignForScheduler(db, r)));
  }

  const capacity = { byVenueType: new Map<string, Bucket>(), byDaypart: new Map<string, Bucket>(), byVenue: new Map<string, Bucket>(), byDay: new Map<string, Bucket>() };
  // Sold time is recorded per campaign first so it can be scaled down where the budget runs out.
  const sold = new Map<string, { plays: number; impressions: number; buckets: Map<string, Bucket> }>();
  const start = Math.floor(from.getTime() / 3600_000) * 3600_000 + 3600_000;

  for (const s of screens) {
    const hours = s.open_hours ? JSON.parse(s.open_hours) : null;
    const adSecPerHour = (3600 * s.ad_share_pct) / 100;
    const vt = venueType(s);
    const venue: Venue = {
      id: s.venue_id, name: s.venue_name, lat: s.lat, lng: s.lng, timezone: s.timezone, category: s.category,
      blockedAdCategories: JSON.parse(s.blocked_ad_categories), audienceMultiplier: s.audience_multiplier, houseCreatives: [],
    };
    const campaigns = campaignsFor.get(s.operator_id) ?? [];
    const counted = inScope(s);
    if (!counted && !campaigns.length) continue;
    const loopsPerHour = 3600 / s.loop_sec;
    for (let i = 0; i < days * 24; i++) {
      const t = new Date(start + i * 3600_000);
      const mid = new Date(t.getTime() + 30 * 60_000);
      if (!isOpenAt(hours, s.timezone, mid)) continue;
      const { date, hour } = localParts(t, s.timezone);
      const keys = [`byVenueType|${vt}`, `byDaypart|${daypartOf(hour)}`, `byVenue|${s.venue_id}|${s.venue_name}`, `byDay|${date}`];
      const imps = (adSecPerHour / AD_SLOT_SEC) * s.audience_multiplier;
      if (counted) {
        add(capacity.byVenueType, vt, { adSeconds: adSecPerHour, impressions: imps });
      add(capacity.byDaypart, daypartOf(hour), { adSeconds: adSecPerHour, impressions: imps });
      add(capacity.byVenue, `${s.venue_id}|${s.venue_name}`, { adSeconds: adSecPerHour, impressions: imps });
        add(capacity.byDay, date, { adSeconds: adSecPerHour, impressions: imps });
      }
      if (!campaigns.length) continue;

      const perCampaign = new Map<string, { sec: number; plays: number }>();
      for (const slot of buildPlaylist(venue, campaigns, mid, { loopSec: s.loop_sec, adSharePct: s.ad_share_pct })) {
        if (!slot.campaignId) continue;
        const c = perCampaign.get(slot.campaignId) ?? { sec: 0, plays: 0 };
        c.sec += slot.durationSec;
        c.plays += 1;
        perCampaign.set(slot.campaignId, c);
      }
      for (const [cid, c] of perCampaign) {
        const e = sold.get(cid) ?? { plays: 0, impressions: 0, buckets: new Map() };
        const plays = c.plays * loopsPerHour;
        // A verified play counts the venue's audience multiplier as impressions (see ingestPop).
        const playImps = plays * s.audience_multiplier;
        e.plays += plays;
        e.impressions += playImps;
        if (counted) for (const k of keys) add(e.buckets, k, { soldSeconds: c.sec * loopsPerHour, soldImpressions: playImps });
        sold.set(cid, e);
      }
    }
  }

  const byCampaign = [];
  for (const [cid, e] of sold) {
    const r = campaignRows.get(cid);
    const remainingMicros = r.budget_cents * MICROS_PER_CENT - r.spent_micros;
    const budgetImpressions = (remainingMicros * 1000) / (r.cpm_cents * MICROS_PER_CENT);
    const scale = e.impressions > budgetImpressions ? budgetImpressions / e.impressions : 1;
    for (const [k, b] of e.buckets) {
      const [dim, ...rest] = k.split('|');
      add(capacity[dim as keyof typeof capacity], rest.join('|'), { soldSeconds: b.soldSeconds * scale, soldImpressions: b.soldImpressions * scale });
    }
    byCampaign.push({
      campaignId: cid,
      name: r.name,
      network: r.operator_id === null,
      endDate: r.end_date,
      forecastImpressions: Math.round(e.impressions * scale),
      remainingBudgetImpressions: Math.round(budgetImpressions),
      budgetLimited: scale < 1,
    });
  }
  byCampaign.sort((a, b) => b.forecastImpressions - a.forecastImpressions);

  const total = [...capacity.byVenueType.values()].reduce((acc, b) => {
    for (const key of Object.keys(b) as Array<keyof Bucket>) acc[key] += b[key];
    return acc;
  }, empty());
  return {
    days,
    from: new Date(start).toISOString(),
    screens: screens.filter(inScope).length,
    totals: { ...present(total), adSlots: Math.floor(total.adSeconds / AD_SLOT_SEC), availableSlots: Math.floor(Math.max(0, total.adSeconds - total.soldSeconds) / AD_SLOT_SEC) },
    byVenueType: rows(capacity.byVenueType, 'venueType'),
    byDaypart: rows(capacity.byDaypart, 'daypart'),
    byDay: rows(capacity.byDay, 'day').sort((a, b) => String(a.day).localeCompare(String(b.day))),
    byVenue: rows(capacity.byVenue, 'venue').map((r) => { const [id, name] = String(r.venue).split('|'); return { ...r, venueId: id, venue: name }; }),
    byCampaign,
    assumptions: {
      adSlotSec: AD_SLOT_SEC,
      openHours: 'venue hours (always open when unknown)',
      scope: 'paired screens',
      sold: 'active campaigns as scheduled, capped by remaining budget; programmatic fill is not counted as sold',
      venueTypes: opts.venueTypes?.length ? opts.venueTypes : null,
    },
  };
}
