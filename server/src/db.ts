import { DatabaseSync } from 'node:sqlite';
import { hashPassword, newId } from './auth.ts';
import type { Campaign, Creative } from './scheduler.ts';

export const AD_CATEGORIES = [
  'alcohol', 'auto', 'cannabis', 'education', 'entertainment', 'finance', 'gambling', 'health',
  'home_services', 'political', 'real_estate', 'restaurant', 'retail', 'services', 'other',
] as const;

export const VENUE_CATEGORIES = ['qsr', 'casual_dining', 'bar', 'cafe', 'barbershop', 'laundromat', 'gym', 'retail', 'other'] as const;

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS operators (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      brand_color TEXT NOT NULL DEFAULT '#2563eb', logo_url TEXT,
      default_cpm_cents INTEGER NOT NULL DEFAULT 1200,
      min_budget_cents INTEGER NOT NULL DEFAULT 2500,
      platform_fee_pct REAL NOT NULL DEFAULT 5,
      network_opt_in INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS advertisers (
      id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
      name TEXT NOT NULL, contact_email TEXT, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS venues (
      id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
      name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
      lat REAL NOT NULL, lng REAL NOT NULL, timezone TEXT NOT NULL, category TEXT NOT NULL,
      blocked_ad_categories TEXT NOT NULL DEFAULT '["cannabis"]',
      audience_multiplier REAL NOT NULL DEFAULT 2,
      rev_share_pct REAL NOT NULL DEFAULT 20,
      house_creatives TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL,
      operator_id TEXT REFERENCES operators(id), venue_id TEXT REFERENCES venues(id),
      advertiser_id TEXT REFERENCES advertisers(id), created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS screens (
      id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
      venue_id TEXT NOT NULL REFERENCES venues(id), name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'idle', ad_share_pct REAL NOT NULL DEFAULT 40,
      loop_sec INTEGER NOT NULL DEFAULT 120, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
      pairing_code TEXT UNIQUE, pairing_expires_at TEXT,
      screen_id TEXT UNIQUE REFERENCES screens(id), operator_id TEXT REFERENCES operators(id),
      last_seen_at TEXT, last_status TEXT, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS menus (
      venue_id TEXT PRIMARY KEY REFERENCES venues(id), operator_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Menu', theme TEXT NOT NULL DEFAULT 'dark',
      sections TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, operator_id TEXT REFERENCES operators(id),
      advertiser_id TEXT REFERENCES advertisers(id), name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'draft',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      geo TEXT, venue_categories TEXT, dayparts TEXT,
      ad_category TEXT NOT NULL DEFAULT 'other', weight REAL NOT NULL DEFAULT 1,
      max_sov_pct REAL NOT NULL DEFAULT 20,
      cpm_cents INTEGER NOT NULL, budget_cents INTEGER NOT NULL,
      spent_micros INTEGER NOT NULL DEFAULT 0,
      stripe_session_id TEXT, review_note TEXT, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creatives (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      url TEXT NOT NULL, type TEXT NOT NULL, duration_sec REAL NOT NULL, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pop_events (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, screen_id TEXT NOT NULL, venue_id TEXT NOT NULL,
      operator_id TEXT NOT NULL, campaign_id TEXT, creative_id TEXT NOT NULL,
      played_at TEXT NOT NULL, duration_sec REAL NOT NULL, impressions REAL NOT NULL DEFAULT 0,
      gross_micros INTEGER NOT NULL DEFAULT 0, platform_micros INTEGER NOT NULL DEFAULT 0,
      operator_micros INTEGER NOT NULL DEFAULT 0, venue_micros INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pop_operator_time ON pop_events (operator_id, played_at);
    CREATE INDEX IF NOT EXISTS pop_campaign ON pop_events (campaign_id);
    CREATE INDEX IF NOT EXISTS pop_venue_time ON pop_events (venue_id, played_at);

    INSERT OR IGNORE INTO settings VALUES ('network_take_pct', '20');
  `);
  migrate(db);
  return db;
}

/** Ordered schema migrations; PRAGMA user_version records how many have been applied. */
const MIGRATIONS: string[] = [
  // 1: Phase 2 (open hours, payouts, audit log, device commands, notifications, POS integrations)
  `
  ALTER TABLE venues ADD COLUMN open_hours TEXT;
  ALTER TABLE venues ADD COLUMN stripe_account_id TEXT;
  ALTER TABLE operators ADD COLUMN stripe_account_id TEXT;
  ALTER TABLE pop_events ADD COLUMN operator_payout_id TEXT;
  ALTER TABLE pop_events ADD COLUMN venue_payout_id TEXT;

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, operator_id TEXT,
    method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, ip TEXT
  );
  CREATE INDEX audit_operator_at ON audit_log (operator_id, at);

  CREATE TABLE device_commands (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), screen_id TEXT NOT NULL,
    type TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, acked_at TEXT
  );
  CREATE INDEX device_commands_pending ON device_commands (device_id, acked_at);

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    dedupe_key TEXT UNIQUE, created_at TEXT NOT NULL, sent_at TEXT
  );

  CREATE TABLE payouts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, recipient_type TEXT NOT NULL, recipient_id TEXT NOT NULL,
    operator_id TEXT NOT NULL, period_end TEXT NOT NULL,
    earned_micros INTEGER NOT NULL, carry_in_micros INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL, remainder_micros INTEGER NOT NULL,
    status TEXT NOT NULL, stripe_transfer_id TEXT, error TEXT, created_at TEXT NOT NULL, paid_at TEXT
  );
  CREATE INDEX payouts_recipient ON payouts (recipient_type, recipient_id, created_at);

  CREATE TABLE integrations (
    venue_id TEXT NOT NULL REFERENCES venues(id), provider TEXT NOT NULL,
    merchant_id TEXT, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT, expires_at TEXT,
    last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (venue_id, provider)
  );
  `,
  // 2: operator SaaS billing (per paired screen, Stripe Billing)
  `
  ALTER TABLE operators ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE operators ADD COLUMN stripe_customer_id TEXT;
  ALTER TABLE operators ADD COLUMN stripe_subscription_id TEXT;
  ALTER TABLE operators ADD COLUMN stripe_subscription_item_id TEXT;
  ALTER TABLE operators ADD COLUMN billed_screens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE operators ADD COLUMN billing_price_cents INTEGER;
  ALTER TABLE operators ADD COLUMN billing_period_end TEXT;
  ALTER TABLE operators ADD COLUMN free_until TEXT;
  INSERT OR IGNORE INTO settings VALUES ('saas_price_cents', '1500');
  INSERT OR IGNORE INTO settings VALUES ('saas_trial_days', '30');
  INSERT OR IGNORE INTO settings VALUES ('saas_free_screens', '2');
  `,
  // 3: pooled network readiness (venue/screen metadata, activity for quality scores, programmatic gating)
  `
  ALTER TABLE venues ADD COLUMN venue_type TEXT;
  ALTER TABLE screens ADD COLUMN width_px INTEGER NOT NULL DEFAULT 1920;
  ALTER TABLE screens ADD COLUMN height_px INTEGER NOT NULL DEFAULT 1080;
  ALTER TABLE screens ADD COLUMN diagonal_in REAL;
  ALTER TABLE screens ADD COLUMN audio INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE operators ADD COLUMN programmatic_override TEXT;
  CREATE TABLE screen_activity (
    screen_id TEXT NOT NULL, hour TEXT NOT NULL,
    heartbeats INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (screen_id, hour)
  );
  INSERT OR IGNORE INTO settings VALUES ('programmatic_min_quality', '80');
  `,
  // 4: OpenRTB DOOH gateway
  `
  CREATE TABLE ssps (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint_url TEXT NOT NULL, auth_header_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, timeout_ms INTEGER NOT NULL DEFAULT 300,
    floor_cpm_cents INTEGER NOT NULL DEFAULT 300, created_at TEXT NOT NULL
  );
  CREATE TABLE rtb_auctions (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, screen_id TEXT NOT NULL, operator_id TEXT NOT NULL, at TEXT NOT NULL,
    imps INTEGER NOT NULL, bids INTEGER NOT NULL, wins INTEGER NOT NULL, errors INTEGER NOT NULL
  );
  CREATE INDEX rtb_auctions_at ON rtb_auctions (at);
  CREATE TABLE rtb_wins (
    id TEXT PRIMARY KEY, ssp_id TEXT NOT NULL, request_id TEXT NOT NULL, imp_id TEXT NOT NULL, bid_id TEXT, seat TEXT,
    screen_id TEXT NOT NULL, operator_id TEXT NOT NULL, venue_id TEXT NOT NULL,
    price_cpm_micros INTEGER NOT NULL, multiplier REAL NOT NULL,
    creative_url TEXT NOT NULL, creative_type TEXT NOT NULL, duration_sec REAL NOT NULL,
    adomain TEXT, crid TEXT, burl TEXT, impression_urls TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, played_at TEXT
  );
  CREATE INDEX rtb_wins_screen ON rtb_wins (screen_id, created_at);
  CREATE TABLE rtb_notices (
    id TEXT PRIMARY KEY, win_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at TEXT NOT NULL, sent_at TEXT
  );
  ALTER TABLE pop_events ADD COLUMN rtb_win_id TEXT;
  INSERT OR IGNORE INTO settings VALUES ('rtb_settled_through', '');
  `,
  // 5: private marketplace (PMP) deals
  `
  CREATE TABLE rtb_deals (
    id TEXT PRIMARY KEY, ssp_id TEXT NOT NULL REFERENCES ssps(id), deal_id TEXT NOT NULL, name TEXT NOT NULL, buyer TEXT,
    floor_cpm_cents INTEGER NOT NULL, auction_type INTEGER NOT NULL DEFAULT 1, private_auction INTEGER NOT NULL DEFAULT 0,
    wseats TEXT, venue_types TEXT, operator_ids TEXT, start_date TEXT, end_date TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
    UNIQUE (ssp_id, deal_id)
  );
  ALTER TABLE rtb_wins ADD COLUMN deal_id TEXT;
  `,
];

function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as any).user_version as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
  return r?.value ?? null;
}

export const nowIso = () => new Date().toISOString();

const JSON_COLS = new Set([
  'blocked_ad_categories', 'house_creatives', 'geo', 'venue_categories', 'dayparts', 'sections', 'last_status', 'open_hours', 'adomain', 'impression_urls',
  'wseats', 'venue_types', 'operator_ids',
]);
const BOOL_COLS = new Set(['network_opt_in', 'audio', 'private_auction']);
const HIDDEN_COLS = new Set(['password_hash', 'secret_hash', 'access_token_enc', 'refresh_token_enc', 'auth_header_enc']);

/** snake_case row → camelCase API object, parsing JSON columns. */
export function toApi<T = any>(row: any): T {
  if (!row) return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    if (HIDDEN_COLS.has(k)) continue;
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = JSON_COLS.has(k) && typeof v === 'string' ? JSON.parse(v) : BOOL_COLS.has(k) ? !!v : v;
  }
  return out;
}

export function campaignForScheduler(db: DatabaseSync, row: any): Campaign {
  const creatives = (db.prepare(`SELECT * FROM creatives WHERE campaign_id = ? ORDER BY created_at`).all(row.id) as any[])
    .map((c): Creative => ({ id: c.id, url: c.url, type: c.type, durationSec: c.duration_sec }));
  return {
    id: row.id,
    advertiser: row.advertiser_id ?? '',
    tier: row.tier,
    startDate: row.start_date,
    endDate: row.end_date,
    geo: row.geo ? JSON.parse(row.geo) : null,
    venueCategories: row.venue_categories ? JSON.parse(row.venue_categories) : null,
    dayparts: row.dayparts ? JSON.parse(row.dayparts) : null,
    adCategory: row.ad_category,
    weight: row.weight,
    maxSovPct: row.max_sov_pct,
    creatives,
  };
}

export function isEmpty(db: DatabaseSync): boolean {
  return !(db.prepare(`SELECT 1 FROM users LIMIT 1`).get());
}

export function createUser(db: DatabaseSync, u: {
  email: string; password: string; name: string; role: string;
  operatorId?: string | null; venueId?: string | null; advertiserId?: string | null;
}): string {
  const id = newId('usr');
  db.prepare(`INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, u.email.trim(), hashPassword(u.password), u.name, u.role,
    u.operatorId ?? null, u.venueId ?? null, u.advertiserId ?? null, nowIso(),
  );
  return id;
}

export const DEMO_PASSWORD = 'demo1234';

/** Demo tenant: an Austin operator with two venues, a menu board, local and network campaigns. */
export function seedDemo(db: DatabaseSync): void {
  const t = nowIso();
  const year = new Date().getFullYear();
  const svg = (id: string, durationSec = 10) => ({ id, url: `/creatives/${id}.svg`, type: 'image', durationSec });

  db.prepare(`INSERT INTO operators (id, slug, name, brand_color, default_cpm_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('op_austin', 'austin', 'Austin Screen Co.', '#0f766e', 1200, t);

  const venue = db.prepare(`
    INSERT INTO venues (id, operator_id, name, address, lat, lng, timezone, category, blocked_ad_categories,
      audience_multiplier, rev_share_pct, house_creatives, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  venue.run('ven_tacos', 'op_austin', 'South Congress Tacos', '1500 S Congress Ave', 30.2496, -97.7495, 'America/Chicago',
    'qsr', JSON.stringify(['alcohol', 'cannabis']), 3, 20, JSON.stringify([svg('house-weather', 10)]), t);
  venue.run('ven_pub', 'op_austin', 'Eastside Pub', '1100 E 6th St', 30.2627, -97.7270, 'America/Chicago',
    'bar', JSON.stringify(['cannabis']), 5, 25, JSON.stringify([svg('house-trivia', 15)]), t);
  // Venues without open_hours are treated as always open; the pub gets real hours as an example.
  db.prepare(`UPDATE venues SET open_hours = ? WHERE id = 'ven_pub'`).run(JSON.stringify({
    mon: [['16:00', '02:00']], tue: [['16:00', '02:00']], wed: [['16:00', '02:00']], thu: [['16:00', '02:00']],
    fri: [['12:00', '02:00']], sat: [['12:00', '02:00']], sun: [['12:00', '22:00']],
  }));

  db.prepare(`UPDATE venues SET venue_type = ? WHERE id = ?`).run('entertainment.qsr', 'ven_tacos');
  db.prepare(`UPDATE venues SET venue_type = ? WHERE id = ?`).run('entertainment.bars', 'ven_pub');
  const screen = db.prepare(`INSERT INTO screens (id, operator_id, venue_id, name, mode, ad_share_pct, loop_sec, diagonal_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  screen.run('scr_tacos_menu', 'op_austin', 'ven_tacos', 'Menu board (counter)', 'menu', 20, 120, 55, t);
  screen.run('scr_pub_bar', 'op_austin', 'ven_pub', 'Over the bar', 'idle', 40, 120, 65, t);

  db.prepare(`INSERT INTO menus VALUES (?, ?, ?, ?, ?, ?)`).run('ven_tacos', 'op_austin', 'South Congress Tacos', 'dark',
    JSON.stringify([
      { name: 'Tacos', items: [
        { name: 'Brisket', price: '4.50', description: 'Smoked brisket, onion, cilantro' },
        { name: 'Al Pastor', price: '3.75', description: 'Pork, pineapple, salsa verde' },
        { name: 'Migas', price: '3.50', description: 'Egg, tortilla chips, cheese', soldOut: true },
      ] },
      { name: 'Sides & Drinks', items: [
        { name: 'Chips & Queso', price: '5.00' },
        { name: 'Elote', price: '4.00' },
        { name: 'Horchata', price: '3.00' },
      ] },
    ]), t);

  db.prepare(`INSERT INTO advertisers VALUES (?, ?, ?, ?, ?)`).run('adv_dentist', 'op_austin', 'Bright Smile Dental', 'dentist@austin.test', t);
  db.prepare(`INSERT INTO advertisers VALUES (?, ?, ?, ?, ?)`).run('adv_brewery', 'op_austin', 'Hill Country Brewing', 'brewery@austin.test', t);

  const campaign = db.prepare(`
    INSERT INTO campaigns (id, operator_id, advertiser_id, name, tier, status, payment_status, start_date, end_date,
      geo, venue_categories, dayparts, ad_category, max_sov_pct, cpm_cents, budget_cents, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const creative = db.prepare(`INSERT INTO creatives VALUES (?, ?, ?, 'image', 10, ?)`);
  campaign.run('cmp_dentist', 'op_austin', 'adv_dentist', 'New patient special', 'local', 'paid', `${year}-01-01`, `${year}-12-31`,
    JSON.stringify({ lat: 30.25, lng: -97.75, radiusMiles: 3 }), null, null, 'health', 20, 1200, 50_000, t);
  creative.run('cr_dentist', 'cmp_dentist', '/creatives/ad-dentist.svg', t);
  campaign.run('cmp_brewery', 'op_austin', 'adv_brewery', 'Happy hour', 'local', 'invoiced', `${year}-01-01`, `${year}-12-31`,
    JSON.stringify({ lat: 30.26, lng: -97.74, radiusMiles: 5 }), null, JSON.stringify([{ startHour: 16, endHour: 2 }]),
    'alcohol', 20, 1500, 30_000, t);
  creative.run('cr_brewery', 'cmp_brewery', '/creatives/ad-brewery.svg', t);
  campaign.run('cmp_carwash', null, null, 'National Car Wash Co.', 'programmatic', 'invoiced', `${year}-01-01`, `${year}-12-31`,
    null, null, null, 'auto', 15, 800, 1_000_000, t);
  creative.run('cr_carwash', 'cmp_carwash', '/creatives/ad-carwash.svg', t);

  createUser(db, { email: 'admin@platform.test', password: DEMO_PASSWORD, name: 'Platform Admin', role: 'platform_admin' });
  createUser(db, { email: 'ops@austin.test', password: DEMO_PASSWORD, name: 'Alex (Austin Screen Co.)', role: 'operator_admin', operatorId: 'op_austin' });
  createUser(db, { email: 'tacos@austin.test', password: DEMO_PASSWORD, name: 'Maria (SoCo Tacos)', role: 'venue_manager', operatorId: 'op_austin', venueId: 'ven_tacos' });
  createUser(db, { email: 'dentist@austin.test', password: DEMO_PASSWORD, name: 'Dr. Lee', role: 'advertiser', operatorId: 'op_austin', advertiserId: 'adv_dentist' });
}
