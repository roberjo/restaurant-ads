// OpenRTB 2.6 DOOH gateway: auctions a screen's unsold ad time across configured SSPs.
//
// Flow: playlist request → leftover ad seconds → one bid request (N imps) to every enabled SSP →
// best bid ≥ floor per imp wins → win notice (nurl) → creative plays once → proof-of-play verifies it →
// billing notice (burl) and VAST impression pixels fire, and revenue is split like any other play.
// Programmatic money arrives from SSPs later, so payouts include it only up to the "settled through" date.
// PMP deals: the platform sells the pooled network to specific buyers through an SSP; matching imps carry `imp.pmp`.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './app-types.ts';
import { newId } from './auth.ts';
import { decrypt } from './crypto.ts';
import { getSetting } from './db.ts';
import { operatorQuality, venueType } from './quality.ts';
import type { Creative } from './scheduler.ts';

export const RTB_SLOT_SEC = 15;
export const MAX_IMPS = 4;
const DEFAULT_EXP_SEC = 1800;
/** AdCom device type 8: out-of-home device. */
const DEVICE_TYPE_OOH = 8;
/** AdCom "DOOH venue taxonomy" list value for the OpenOOH venue taxonomy; confirm per SSP. */
const VENUE_TAXONOMY_OPENOOH = 2;

/** IAB Content Taxonomy 1.0 categories to block for each of our ad categories (sent as `bcat`). */
export const IAB_BLOCKS: Record<string, string[]> = {
  alcohol: ['IAB8-5', 'IAB8-18'],
  gambling: ['IAB9-7', 'IAB14-1'],
  political: ['IAB11-4'],
  cannabis: ['IAB7-39'],
  health: ['IAB7'],
  finance: ['IAB13'],
  real_estate: ['IAB21'],
  auto: ['IAB2'],
};

export interface RtbScreen {
  screen: any; // screens row
  venueRow: any; // venues row
  operator: any; // operators row
}

// ---- Eligibility ----
const qualityCache = new Map<string, { at: number; eligible: boolean }>();
function programmaticEligible(db: DatabaseSync, operatorId: string, now: Date): boolean {
  const c = qualityCache.get(operatorId);
  if (c && now.getTime() - c.at < 10 * 60_000) return c.eligible;
  const eligible = operatorQuality(db, operatorId, now).eligible;
  qualityCache.set(operatorId, { at: now.getTime(), eligible });
  return eligible;
}
export const clearQualityCache = () => qualityCache.clear();

// ---- PMP deals ----
const localDate = (tz: string, now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);

/** Enabled deals on this SSP whose dates and targeting (venue types, operators) match the screen. */
export function dealsFor(db: DatabaseSync, sspId: string, s: RtbScreen, now = new Date()): any[] {
  const today = localDate(s.venueRow.timezone, now);
  const vt = venueType(s.venueRow);
  return (db.prepare(`SELECT * FROM rtb_deals WHERE ssp_id = ? AND enabled = 1`).all(sspId) as any[]).filter((d) => {
    if ((d.start_date && today < d.start_date) || (d.end_date && today > d.end_date)) return false;
    const types: string[] | null = d.venue_types ? JSON.parse(d.venue_types) : null;
    const ops: string[] | null = d.operator_ids ? JSON.parse(d.operator_ids) : null;
    return (!types?.length || types.includes(vt)) && (!ops?.length || ops.includes(s.operator.id));
  });
}

/** OpenRTB `imp.pmp` for the given deals; private if any deal is (open-market bids are then refused). */
export function pmpObject(deals: any[]) {
  return {
    private_auction: deals.some((d) => d.private_auction) ? 1 : 0,
    deals: deals.map((d) => {
      const wseat: string[] = d.wseats ? JSON.parse(d.wseats) : [];
      return { id: d.deal_id, bidfloor: d.floor_cpm_cents / 100, bidfloorcur: 'USD', at: d.auction_type, ...(wseat.length ? { wseat } : {}) };
    }),
  };
}

// ---- Bid request ----
export function buildBidRequest(s: RtbScreen, imps: number, floorCpm: number, tmaxMs: number, now = new Date()) {
  const { screen, venueRow: v, operator } = s;
  const blocked: string[] = JSON.parse(v.blocked_ad_categories);
  const bcat = [...new Set(blocked.flatMap((c) => IAB_BLOCKS[c] ?? []))];
  const w = screen.width_px ?? 1920;
  const h = screen.height_px ?? 1080;
  return {
    id: randomUUID(),
    imp: Array.from({ length: imps }, (_, i) => ({
      id: String(i + 1),
      bidfloor: floorCpm,
      bidfloorcur: 'USD',
      exp: DEFAULT_EXP_SEC,
      qty: { multiplier: v.audience_multiplier, sourcetype: 2 }, // 2 = publisher-provided
      dt: now.getTime(),
      banner: { format: [{ w, h }], mimes: ['image/png', 'image/jpeg', 'image/webp'] },
      video: {
        mimes: ['video/mp4'], minduration: 5, maxduration: RTB_SLOT_SEC, w, h, linearity: 1,
        protocols: [2, 3, 5, 6, 7, 8], skip: 0, ...(screen.audio ? {} : { playbackmethod: [6] }), // 6 = autoplay, sound off
      },
    })),
    dooh: {
      id: v.id,
      name: v.name,
      venuetype: [venueType(v)],
      venuetypetax: VENUE_TAXONOMY_OPENOOH,
      publisher: { id: operator.id, name: operator.name },
    },
    device: {
      devicetype: DEVICE_TYPE_OOH,
      ua: 'restaurant-ads-player',
      w, h,
      geo: { lat: v.lat, lon: v.lng, type: 1 }, // 1 = GPS/location services
    },
    at: 1, // first price
    tmax: tmaxMs,
    cur: ['USD'],
    bcat,
    cattax: 1, // IAB Content Taxonomy 1.0
    source: { tid: randomUUID() },
    ext: { screen_id: screen.id, venue_category: v.category },
  };
}

// ---- Bid response ----
export interface ParsedCreative { url: string; type: 'image' | 'video'; durationSec: number; impressions: string[] }

const httpsUrl = (s: string | undefined) => (s && /^https:\/\/[^\s"'<>]+$/.test(s.trim()) ? s.trim() : null);

function vastDuration(vast: string): number | null {
  const m = vast.match(/<Duration>\s*(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)\s*<\/Duration>/i);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
const cdata = (s: string) => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();

/** Extract a playable creative from `adm`: VAST (mp4 MediaFile or StaticResource image), an <img> tag or a bare image URL. */
export function parseCreative(adm: string, mtype?: number): ParsedCreative | null {
  if (!adm) return null;
  const a = adm.trim();
  if (/<VAST[\s>]/i.test(a)) {
    const impressions = [...a.matchAll(/<Impression[^>]*>([\s\S]*?)<\/Impression>/gi)].map((m) => httpsUrl(cdata(m[1]))).filter(Boolean) as string[];
    for (const m of a.matchAll(/<MediaFile\b([^>]*)>([\s\S]*?)<\/MediaFile>/gi)) {
      const url = httpsUrl(cdata(m[2]));
      if (url && /type\s*=\s*["']video\/mp4["']/i.test(m[1])) return { url, type: 'video', durationSec: vastDuration(a) ?? RTB_SLOT_SEC, impressions };
    }
    for (const m of a.matchAll(/<StaticResource\b([^>]*)>([\s\S]*?)<\/StaticResource>/gi)) {
      const url = httpsUrl(cdata(m[2]));
      if (url && /creativeType\s*=\s*["']image\/(png|jpeg|webp)["']/i.test(m[1])) return { url, type: 'image', durationSec: vastDuration(a) ?? 10, impressions };
    }
    return null;
  }
  if (mtype === 2) return null; // video must come as VAST
  const img = a.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ?? a;
  const url = httpsUrl(img);
  return url && /\.(png|jpe?g|webp)(\?|$)/i.test(url) ? { url, type: 'image', durationSec: 10, impressions: [] } : null;
}

const MACROS = (price: number, r: { requestId: string; impId: string; bidId: string; seat: string }) => (u: string) => u
  .replaceAll('${AUCTION_PRICE}', String(price)).replaceAll('${AUCTION_CURRENCY}', 'USD')
  .replaceAll('${AUCTION_ID}', r.requestId).replaceAll('${AUCTION_IMP_ID}', r.impId)
  .replaceAll('${AUCTION_BID_ID}', r.bidId).replaceAll('${AUCTION_SEAT_ID}', r.seat);

interface Candidate { ssp: any; seat: string; bid: any; creative: ParsedCreative; deal: any | null }

/**
 * Valid bids per imp: price ≥ the floor, no blocked categories, a playable https creative that fits the slot.
 * A bid naming a `dealid` must match a deal offered to that SSP (its floor and buyer seats apply); open-market
 * bids use the SSP's floor and are refused when any offered deal is private.
 */
export function selectWinners(responses: Array<{ ssp: any; body: any; deals?: any[] }>, request: any): Map<string, Candidate> {
  const best = new Map<string, Candidate>();
  const imps = new Map(request.imp.map((i: any) => [i.id, i]));
  const bcat = new Set<string>(request.bcat);
  for (const { ssp, body, deals = [] } of responses) {
    if (!body || body.id !== request.id || (body.cur && body.cur !== 'USD')) continue;
    const privateOnly = deals.some((d) => d.private_auction);
    for (const sb of body.seatbid ?? []) {
      const seat = String(sb.seat ?? '');
      for (const bid of sb.bid ?? []) {
        const imp: any = imps.get(String(bid.impid));
        if (!imp) continue;
        let deal = null;
        if (bid.dealid) {
          deal = deals.find((d) => d.deal_id === String(bid.dealid));
          const wseats: string[] = deal?.wseats ? JSON.parse(deal.wseats) : [];
          if (!deal || (wseats.length && !wseats.includes(seat))) continue;
          if (!(Number(bid.price) >= deal.floor_cpm_cents / 100)) continue;
        } else if (privateOnly || !(Number(bid.price) >= ssp.floor_cpm_cents / 100)) continue;
        if ((bid.cat ?? []).some((c: string) => bcat.has(c) || bcat.has(c.split('-')[0]))) continue;
        const creative = parseCreative(String(bid.adm ?? ''), bid.mtype);
        if (!creative || creative.durationSec > RTB_SLOT_SEC + 0.5) continue;
        const cur = best.get(imp.id);
        if (!cur || Number(bid.price) > Number(cur.bid.price)) best.set(imp.id, { ssp, seat, bid, creative, deal });
      }
    }
  }
  return best;
}

// ---- Auction ----
export async function runAuction(db: DatabaseSync, config: Config, s: RtbScreen, adSecondsAvailable: number, now = new Date()): Promise<Creative[]> {
  if (!s.operator.network_opt_in) return [];
  const ssps = db.prepare(`SELECT * FROM ssps WHERE enabled = 1`).all() as any[];
  const imps = Math.min(MAX_IMPS, Math.floor(adSecondsAvailable / RTB_SLOT_SEC));
  if (!ssps.length || imps < 1 || !programmaticEligible(db, s.operator.id, now)) return [];

  const request = buildBidRequest(s, imps, 0, Math.max(...ssps.map((x) => x.timeout_ms)), now);
  const f = config.fetchImpl ?? fetch;
  const responses = await Promise.all(ssps.map(async (ssp) => {
    const deals = dealsFor(db, ssp.id, s, now);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-openrtb-version': '2.6' };
      if (ssp.auth_header_enc && config.appSecret) headers.authorization = decrypt(config.appSecret, ssp.auth_header_enc);
      const pmp = deals.length ? { pmp: pmpObject(deals) } : {};
      const body = { ...request, tmax: ssp.timeout_ms, imp: request.imp.map((i) => ({ ...i, bidfloor: ssp.floor_cpm_cents / 100, ...pmp })) };
      const r = await f(ssp.endpoint_url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ssp.timeout_ms) });
      if (r.status === 204) return { ssp, deals, body: null, error: null };
      if (!r.ok) return { ssp, deals, body: null, error: `HTTP ${r.status}` };
      return { ssp, deals, body: await r.json(), error: null };
    } catch (e) {
      return { ssp, deals, body: null, error: (e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message };
    }
  }));

  const winners = selectWinners(responses, request);
  const bids = responses.reduce((n, r) => n + (r.body?.seatbid ?? []).reduce((m: number, sb: any) => m + (sb.bid?.length ?? 0), 0), 0);
  const errors = responses.filter((r) => r.error).length;
  db.prepare(`INSERT INTO rtb_auctions (id, request_id, screen_id, operator_id, at, imps, bids, wins, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('auc'), request.id, s.screen.id, s.operator.id, now.toISOString(), imps, bids, winners.size, errors);

  const out: Creative[] = [];
  const insertWin = db.prepare(`
    INSERT INTO rtb_wins (id, ssp_id, request_id, imp_id, bid_id, seat, screen_id, operator_id, venue_id, price_cpm_micros, multiplier,
      creative_url, creative_type, duration_sec, adomain, crid, burl, impression_urls, created_at, expires_at, deal_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [impId, w] of winners) {
    const id = newId('win');
    const price = Number(w.bid.price);
    const sub = MACROS(price, { requestId: request.id, impId, bidId: String(w.bid.id ?? ''), seat: w.seat });
    const exp = Math.min(Number(w.bid.exp) || DEFAULT_EXP_SEC, 24 * 3600);
    insertWin.run(id, w.ssp.id, request.id, impId, String(w.bid.id ?? ''), w.seat, s.screen.id, s.operator.id, s.venueRow.id,
      Math.round(price * 1_000_000), s.venueRow.audience_multiplier, w.creative.url, w.creative.type, w.creative.durationSec,
      JSON.stringify(w.bid.adomain ?? []), String(w.bid.crid ?? ''), w.bid.burl ? sub(w.bid.burl) : null,
      JSON.stringify(w.creative.impressions.map(sub)), now.toISOString(), new Date(now.getTime() + exp * 1000).toISOString(), w.deal?.id ?? null);
    if (w.bid.nurl) queueNotice(db, id, 'nurl', sub(w.bid.nurl));
    out.push({ id: `rtb:${id}`, url: w.creative.url, type: w.creative.type, durationSec: w.creative.durationSec });
  }
  return out;
}

// ---- Notices (win, billing, VAST impressions) ----
export function queueNotice(db: DatabaseSync, winId: string, kind: string, url: string): void {
  if (!httpsUrl(url)) return;
  db.prepare(`INSERT INTO rtb_notices (id, win_id, kind, url, created_at) VALUES (?, ?, ?, ?, ?)`).run(newId('ntc'), winId, kind, url, new Date().toISOString());
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !PRIVATE_V4.some((r) => r.test(ip));
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return !(v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80'));
}

/** Notice URLs come from SSP responses, so refuse anything that resolves to a private or local address. */
async function safeToFetch(url: string, config: Config): Promise<boolean> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host)) return isPublicAddress(host);
  const addrs = config.resolveHost ? await config.resolveHost(host) : (await lookup(host, { all: true })).map((a) => a.address);
  return addrs.length > 0 && addrs.every(isPublicAddress);
}

const MAX_NOTICE_ATTEMPTS = 5;
export async function flushNotices(db: DatabaseSync, config: Config, limit = 50): Promise<{ sent: number; failed: number }> {
  const rows = db.prepare(`SELECT * FROM rtb_notices WHERE status IN ('pending', 'retry') ORDER BY created_at LIMIT ?`).all(limit) as any[];
  const f = config.fetchImpl ?? fetch;
  const res = { sent: 0, failed: 0 };
  for (const n of rows) {
    try {
      if (!(await safeToFetch(n.url, config))) throw new Error('blocked: private or local address');
      const r = await f(n.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      db.prepare(`UPDATE rtb_notices SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?`).run(new Date().toISOString(), n.id);
      res.sent++;
    } catch (e) {
      const attempts = n.attempts + 1;
      const msg = (e as Error).message;
      const final = attempts >= MAX_NOTICE_ATTEMPTS || msg.startsWith('blocked');
      db.prepare(`UPDATE rtb_notices SET status = ?, attempts = ?, last_error = ? WHERE id = ?`).run(final ? 'failed' : 'retry', attempts, msg.slice(0, 300), n.id);
      res.failed++;
    }
  }
  return res;
}

/** Programmatic plays up to this date are paid out (the SSPs have paid the platform for them). */
export const rtbSettledThrough = (db: DatabaseSync): string | null => getSetting(db, 'rtb_settled_through') || null;
