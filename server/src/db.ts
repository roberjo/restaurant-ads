import { DatabaseSync } from 'node:sqlite';
import type { Campaign, Creative, Venue } from './scheduler.ts';

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      timezone TEXT NOT NULL, category TEXT NOT NULL,
      blocked_ad_categories TEXT NOT NULL DEFAULT '[]',
      audience_multiplier REAL NOT NULL DEFAULT 1,
      rev_share_pct REAL NOT NULL DEFAULT 20,
      house_creatives TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS screens (
      id TEXT PRIMARY KEY, venue_id TEXT NOT NULL REFERENCES venues(id),
      name TEXT NOT NULL, last_heartbeat_at TEXT, last_status TEXT
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, advertiser TEXT NOT NULL, tier TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      geo TEXT, venue_categories TEXT, dayparts TEXT,
      ad_category TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
      max_sov_pct REAL NOT NULL DEFAULT 25, cpm_usd REAL NOT NULL DEFAULT 0,
      creatives TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS pop_events (
      id TEXT PRIMARY KEY, screen_id TEXT NOT NULL, creative_id TEXT NOT NULL,
      campaign_id TEXT, played_at TEXT NOT NULL, duration_sec REAL NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  return db;
}

type Row = Record<string, any>;

export function rowToVenue(r: Row): Venue {
  return {
    id: r.id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    timezone: r.timezone,
    category: r.category,
    blockedAdCategories: JSON.parse(r.blocked_ad_categories),
    audienceMultiplier: r.audience_multiplier,
    houseCreatives: JSON.parse(r.house_creatives),
  };
}

export function rowToCampaign(r: Row): Campaign {
  return {
    id: r.id,
    advertiser: r.advertiser,
    tier: r.tier,
    startDate: r.start_date,
    endDate: r.end_date,
    geo: r.geo ? JSON.parse(r.geo) : null,
    venueCategories: r.venue_categories ? JSON.parse(r.venue_categories) : null,
    dayparts: r.dayparts ? JSON.parse(r.dayparts) : null,
    adCategory: r.ad_category,
    weight: r.weight,
    maxSovPct: r.max_sov_pct,
    creatives: JSON.parse(r.creatives),
  };
}

const svg = (id: string, durationSec = 10): Creative => ({
  id,
  url: `/creatives/${id}.svg`,
  type: 'image',
  durationSec,
});

// Demo data: a small cluster of venues in Austin, TX.
export function seed(db: DatabaseSync): void {
  const venue = db.prepare(
    `INSERT OR REPLACE INTO venues VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  venue.run('v-tacos', 'South Congress Tacos', 30.2496, -97.7495, 'America/Chicago', 'qsr',
    JSON.stringify(['alcohol']), 3, 20, JSON.stringify([svg('house-menu', 15), svg('house-weather', 10)]));
  venue.run('v-pub', 'Eastside Pub', 30.2627, -97.7270, 'America/Chicago', 'bar',
    '[]', 5, 25, JSON.stringify([svg('house-trivia', 15)]));

  const screen = db.prepare(`INSERT OR REPLACE INTO screens (id, venue_id, name) VALUES (?, ?, ?)`);
  screen.run('s-tacos-counter', 'v-tacos', 'Counter');
  screen.run('s-pub-bar', 'v-pub', 'Over the bar');

  const year = new Date().getFullYear();
  const campaign = db.prepare(`INSERT OR REPLACE INTO campaigns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  campaign.run('c-dentist', 'Bright Smile Dental', 'local', `${year}-01-01`, `${year}-12-31`,
    JSON.stringify({ lat: 30.25, lng: -97.75, radiusMiles: 3 }), null, null, 'health', 1, 25, 12,
    JSON.stringify([svg('ad-dentist')]));
  campaign.run('c-brewery', 'Hill Country Brewing', 'local', `${year}-01-01`, `${year}-12-31`,
    JSON.stringify({ lat: 30.26, lng: -97.74, radiusMiles: 5 }), null,
    JSON.stringify([{ startHour: 16, endHour: 2 }]), 'alcohol', 1, 25, 15,
    JSON.stringify([svg('ad-brewery')]));
  campaign.run('c-carwash', 'National Car Wash Co.', 'programmatic', `${year}-01-01`, `${year}-12-31`,
    null, null, null, 'auto', 1, 20, 8, JSON.stringify([svg('ad-carwash')]));
}
