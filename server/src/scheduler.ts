// Pure playlist scheduler: given a venue, candidate campaigns and a time, build one loop.

export type Tier = 'sponsorship' | 'direct' | 'local' | 'programmatic' | 'rtb' | 'house';

export const TIER_RANK: Record<Tier, number> = {
  sponsorship: 0,
  direct: 1,
  local: 2,
  programmatic: 3,
  rtb: 3.5, // OpenRTB wins fill whatever network campaigns leave
  house: 4,
};

export interface Creative {
  id: string;
  url: string;
  type: 'image' | 'video' | 'menu';
  durationSec: number;
}

export interface Venue {
  id: string;
  name: string;
  lat: number;
  lng: number;
  timezone: string;
  category: string;
  blockedAdCategories: string[];
  audienceMultiplier: number;
  houseCreatives: Creative[];
}

export interface Daypart {
  startHour: number; // inclusive, 0-23 local time
  endHour: number; // exclusive, may wrap past midnight
}

export interface Campaign {
  id: string;
  advertiser: string;
  tier: Tier;
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string; // YYYY-MM-DD, inclusive
  geo: { lat: number; lng: number; radiusMiles: number } | null;
  venueCategories: string[] | null;
  dayparts: Daypart[] | null;
  adCategory: string;
  weight: number;
  maxSovPct: number; // max share of the loop this campaign may take
  creatives: Creative[];
}

export interface Slot {
  creativeId: string;
  campaignId: string | null;
  url: string;
  type: Creative['type'];
  durationSec: number;
  /** Play at most once (programmatic wins are bought per play). */
  once?: boolean;
}

export interface PlaylistOptions {
  loopSec?: number;
  adSharePct?: number;
}

export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

function localParts(now: Date, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function inDaypart(hour: number, dp: Daypart): boolean {
  return dp.startHour <= dp.endHour
    ? hour >= dp.startHour && hour < dp.endHour
    : hour >= dp.startHour || hour < dp.endHour;
}

export function isEligible(c: Campaign, venue: Venue, now: Date): boolean {
  const { date, hour } = localParts(now, venue.timezone);
  if (date < c.startDate || date > c.endDate) return false;
  if (c.creatives.length === 0) return false;
  if (venue.blockedAdCategories.includes(c.adCategory)) return false;
  if (c.venueCategories && !c.venueCategories.includes(venue.category)) return false;
  if (c.geo && haversineMiles(c.geo.lat, c.geo.lng, venue.lat, venue.lng) > c.geo.radiusMiles) return false;
  if (c.dayparts && !c.dayparts.some((dp) => inDaypart(hour, dp))) return false;
  return true;
}

export function buildPlaylist(
  venue: Venue,
  campaigns: Campaign[],
  now: Date,
  { loopSec = 120, adSharePct = 50 }: PlaylistOptions = {},
): Slot[] {
  const eligible = campaigns
    .filter((c) => isEligible(c, venue, now))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);

  // Fill ad time tier by tier with smooth weighted round-robin, respecting per-campaign SOV caps.
  const ads: Slot[] = [];
  let adRemaining = (loopSec * adSharePct) / 100;
  const used = new Map<string, number>();
  const creativeIdx = new Map<string, number>();

  const tiers = [...new Set(eligible.map((c) => c.tier))];
  for (const tier of tiers) {
    const pool = eligible.filter((c) => c.tier === tier);
    const current = new Map(pool.map((c) => [c.id, 0]));
    while (adRemaining > 0) {
      const fits = pool.filter((c) => {
        const cr = c.creatives[(creativeIdx.get(c.id) ?? 0) % c.creatives.length];
        const cap = (loopSec * c.maxSovPct) / 100;
        return cr.durationSec <= adRemaining && (used.get(c.id) ?? 0) + cr.durationSec <= cap;
      });
      if (fits.length === 0) break;
      const total = fits.reduce((s, c) => s + c.weight, 0);
      for (const c of fits) current.set(c.id, current.get(c.id)! + c.weight);
      const pick = fits.reduce((best, c) => (current.get(c.id)! > current.get(best.id)! ? c : best));
      current.set(pick.id, current.get(pick.id)! - total);

      const i = creativeIdx.get(pick.id) ?? 0;
      const cr = pick.creatives[i % pick.creatives.length];
      creativeIdx.set(pick.id, i + 1);
      used.set(pick.id, (used.get(pick.id) ?? 0) + cr.durationSec);
      adRemaining -= cr.durationSec;
      ads.push({ creativeId: cr.id, campaignId: pick.id, url: cr.url, type: cr.type, durationSec: cr.durationSec });
    }
  }

  // Fill the rest of the loop with house/venue content.
  const house: Slot[] = [];
  let houseRemaining = loopSec - ads.reduce((s, a) => s + a.durationSec, 0);
  for (let i = 0; venue.houseCreatives.length > 0 && houseRemaining > 0; i++) {
    const cr = venue.houseCreatives[i % venue.houseCreatives.length];
    if (cr.durationSec > houseRemaining) break;
    house.push({ creativeId: cr.id, campaignId: null, url: cr.url, type: cr.type, durationSec: cr.durationSec });
    houseRemaining -= cr.durationSec;
  }

  return interleave(ads, house);
}

// Spread ads evenly through house content so viewers don't see a block of back-to-back ads.
function interleave(ads: Slot[], house: Slot[]): Slot[] {
  if (ads.length === 0) return house;
  if (house.length === 0) return ads;
  const out: Slot[] = [];
  const total = ads.length + house.length;
  let a = 0;
  let h = 0;
  for (let i = 0; i < total; i++) {
    const wantAds = Math.round(((i + 1) * ads.length) / total);
    if (a < wantAds && a < ads.length) out.push(ads[a++]);
    else if (h < house.length) out.push(house[h++]);
    else out.push(ads[a++]);
  }
  return out;
}
