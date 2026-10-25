// Square POS: OAuth, catalog → menu-board mapping, webhook verification, and venue sync.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './app-types.ts';
import { decrypt, encrypt } from './crypto.ts';

export const SQUARE_VERSION = '2024-10-17';
export const SQUARE_SCOPES = ['ITEMS_READ', 'MERCHANT_PROFILE_READ'];
const MAX_SECTIONS = 12;
const MAX_ITEMS = 30;

export const squareBase = (config: Config) =>
  config.squareEnvironment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';

export function squareConfigured(config: Config): boolean {
  return !!(config.squareAppId && config.squareAppSecret && config.appSecret);
}

export function authorizeUrl(config: Config, state: string): string {
  const q = new URLSearchParams({ client_id: config.squareAppId!, scope: SQUARE_SCOPES.join(' '), session: 'false', state });
  return `${squareBase(config)}/oauth2/authorize?${q}`;
}

async function squareJson(config: Config, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<any> {
  const r = await (config.fetchImpl ?? fetch)(`${squareBase(config)}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'square-version': SQUARE_VERSION,
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`square: ${json?.errors?.[0]?.detail ?? json?.message ?? r.status}`);
  return json;
}

export async function exchangeToken(config: Config, grant: { code: string } | { refreshToken: string }) {
  const body = 'code' in grant
    ? { client_id: config.squareAppId, client_secret: config.squareAppSecret, code: grant.code, grant_type: 'authorization_code' }
    : { client_id: config.squareAppId, client_secret: config.squareAppSecret, refresh_token: grant.refreshToken, grant_type: 'refresh_token' };
  const t = await squareJson(config, '/oauth2/token', { method: 'POST', body });
  return { accessToken: t.access_token as string, refreshToken: (t.refresh_token as string) ?? null, expiresAt: (t.expires_at as string) ?? null, merchantId: (t.merchant_id as string) ?? null };
}

export async function fetchCatalog(config: Config, token: string): Promise<any[]> {
  const objects: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ types: 'ITEM,CATEGORY', ...(cursor ? { cursor } : {}) });
    const r = await squareJson(config, `/v2/catalog/list?${q}`, { token });
    objects.push(...(r.objects ?? []));
    cursor = r.cursor;
    if (!cursor) break;
  }
  return objects;
}

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);

/** Map Square catalog objects to menu sections (one per category; uncategorized items go to "Menu"). */
export function catalogToSections(objects: any[]): { name: string; items: any[] }[] {
  const categories = new Map<string, string>();
  for (const o of objects) if (o.type === 'CATEGORY' && !o.is_deleted) categories.set(o.id, clip(o.category_data?.name, 60) || 'Menu');
  const sections = new Map<string, any[]>();
  for (const o of objects) {
    const d = o.item_data;
    if (o.type !== 'ITEM' || o.is_deleted || !d || d.is_archived) continue;
    const catId = d.reporting_category?.id ?? d.categories?.[0]?.id ?? d.category_id;
    const section = (catId && categories.get(catId)) || 'Menu';
    const variations = (d.variations ?? []).filter((v: any) => !v.is_deleted);
    const cents = variations.map((v: any) => v.item_variation_data?.price_money?.amount).find((a: unknown) => typeof a === 'number');
    const soldOut = variations.length > 0 && variations.every((v: any) =>
      (v.item_variation_data?.location_overrides ?? []).some((lo: any) => lo.sold_out === true));
    const items = sections.get(section) ?? [];
    items.push({
      name: clip(d.name, 80) || 'Item',
      price: typeof cents === 'number' ? (cents / 100).toFixed(2) : '',
      description: clip(d.description_plaintext ?? d.description, 160),
      soldOut,
    });
    sections.set(section, items);
  }
  return [...sections.entries()]
    .sort(([a], [b]) => (a === 'Menu' ? 1 : b === 'Menu' ? -1 : a.localeCompare(b)))
    .slice(0, MAX_SECTIONS)
    .map(([name, items]) => ({ name, items: items.sort((x, y) => x.name.localeCompare(y.name)).slice(0, MAX_ITEMS) }));
}

/** Square signs notification URL + raw body with HMAC-SHA256 (base64). */
export function verifySquareWebhook(rawBody: string, signature: string | undefined, key: string, url: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(url + rawBody).digest('base64'));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Pull the venue's Square catalog into its menu board, refreshing the access token when needed. */
export async function syncSquareVenue(db: DatabaseSync, config: Config, venueId: string): Promise<{ sections: number; items: number }> {
  const integ = db.prepare(`SELECT * FROM integrations WHERE venue_id = ? AND provider = 'square'`).get(venueId) as any;
  if (!integ) throw new Error('Square is not connected for this venue');
  const secret = config.appSecret!;
  try {
    let token = decrypt(secret, integ.access_token_enc);
    if (integ.refresh_token_enc && integ.expires_at && Date.parse(integ.expires_at) < Date.now() + 24 * 3600_000) {
      const t = await exchangeToken(config, { refreshToken: decrypt(secret, integ.refresh_token_enc) });
      token = t.accessToken;
      db.prepare(`UPDATE integrations SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), expires_at = ? WHERE venue_id = ? AND provider = 'square'`)
        .run(encrypt(secret, t.accessToken), t.refreshToken ? encrypt(secret, t.refreshToken) : null, t.expiresAt, venueId);
    }
    const sections = catalogToSections(await fetchCatalog(config, token));
    const v = db.prepare(`SELECT name, operator_id FROM venues WHERE id = ?`).get(venueId) as any;
    const existing = db.prepare(`SELECT title, theme FROM menus WHERE venue_id = ?`).get(venueId) as any;
    db.prepare(`INSERT OR REPLACE INTO menus VALUES (?, ?, ?, ?, ?, ?)`).run(
      venueId, v.operator_id, existing?.title ?? v.name, existing?.theme ?? 'dark', JSON.stringify(sections), new Date().toISOString());
    db.prepare(`UPDATE integrations SET last_sync_at = ?, last_error = NULL WHERE venue_id = ? AND provider = 'square'`).run(new Date().toISOString(), venueId);
    return { sections: sections.length, items: sections.reduce((n, s) => n + s.items.length, 0) };
  } catch (e) {
    db.prepare(`UPDATE integrations SET last_error = ? WHERE venue_id = ? AND provider = 'square'`).run(String((e as Error).message).slice(0, 500), venueId);
    throw e;
  }
}

export async function syncAllSquareVenues(db: DatabaseSync, config: Config): Promise<void> {
  if (!squareConfigured(config)) return;
  for (const r of db.prepare(`SELECT venue_id FROM integrations WHERE provider = 'square'`).all() as any[]) {
    await syncSquareVenue(db, config, r.venue_id).catch((e) => console.error(`[square] sync ${r.venue_id}: ${e.message}`));
  }
}
