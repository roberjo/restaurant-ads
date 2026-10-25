import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import { DEMO_PASSWORD, openDb, seedDemo } from '../src/db.ts';
import { signWebhookForTest } from '../src/stripe.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WEBHOOK_SECRET = 'whsec_test';

let server: Server;
let db: DatabaseSync;
let base: string;
let uploads: string;

async function call(method: string, path: string, opts: { token?: string; device?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.device) headers.authorization = `Device ${opts.device}`;
  const r = await fetch(base + path, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  return { status: r.status, body: (await r.json()) as any };
}

async function login(email: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

async function pairedDevice(opsToken: string, screenId: string): Promise<string> {
  const reg = await call('POST', '/api/device/register');
  const cred = `${reg.body.deviceId}.${reg.body.deviceSecret}`;
  const pair = await call('POST', `/api/screens/${screenId}/pair`, { token: opsToken, body: { code: reg.body.pairingCode.toLowerCase() } });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  return cred;
}

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  uploads = mkdtempSync(join(tmpdir(), 'ads-uploads-'));
  server = createApp(db, { publicUrl: 'http://test', uploadsDir: uploads, stripeWebhookSecret: WEBHOOK_SECRET });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(uploads, { recursive: true, force: true });
});

describe('auth and tenancy', () => {
  test('login, me, bad password', async () => {
    const t = await login('ops@austin.test');
    const me = await call('GET', '/api/me', { token: t });
    assert.equal(me.body.user.role, 'operator_admin');
    assert.equal(me.body.operator.slug, 'austin');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ops@austin.test', password: 'nope' } })).status, 401);
    assert.equal((await call('GET', '/api/venues')).status, 401);
  });

  test('operators cannot see each other’s data', async () => {
    const admin = await login('admin@platform.test');
    const created = await call('POST', '/api/admin/operators', {
      token: admin,
      body: { slug: 'tulsa', name: 'Tulsa Screens', adminEmail: 'ops@tulsa.test', adminPassword: DEMO_PASSWORD, adminName: 'Sam' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const tulsa = await login('ops@tulsa.test');
    assert.deepEqual((await call('GET', '/api/venues', { token: tulsa })).body, []);
    assert.equal((await call('GET', '/api/venues/ven_tacos', { token: tulsa })).status, 404);
    assert.equal((await call('POST', '/api/screens/scr_pub_bar/pair', { token: tulsa, body: { code: 'ABCDEF' } })).status, 404);
    assert.equal((await call('GET', '/api/campaigns/cmp_dentist', { token: tulsa })).status, 404);
    // platform admin acts on a specific operator
    const v = await call('GET', '/api/venues?operatorId=op_austin', { token: admin });
    assert.equal(v.body.length, 2);
  });
});

describe('devices, playlists and proof-of-play', () => {
  test('unpaired device shows a code; pairing binds it to a screen', async () => {
    const reg = await call('POST', '/api/device/register');
    assert.match(reg.body.pairingCode, /^[A-Z2-9]{6}$/);
    const cred = `${reg.body.deviceId}.${reg.body.deviceSecret}`;
    assert.equal((await call('GET', '/api/device/state', { device: cred })).body.paired, false);
    assert.equal((await call('GET', '/api/device/playlist', { device: cred })).status, 409);
    assert.equal((await call('GET', '/api/device/state', { device: `${reg.body.deviceId}.wrong` })).status, 401);

    const ops = await login('ops@austin.test');
    await call('POST', '/api/screens/scr_pub_bar/pair', { token: ops, body: { code: reg.body.pairingCode } });
    const state = await call('GET', '/api/device/state', { device: cred });
    assert.equal(state.body.paired, true);
    assert.equal(state.body.screen.venueName, 'Eastside Pub');

    const fleet = await call('GET', '/api/fleet', { token: ops });
    assert.equal(fleet.body.screens.find((s: any) => s.id === 'scr_pub_bar').status, 'online');
  });

  test('menu-mode playlist contains the menu and ads; alcohol is blocked at the taco shop', async () => {
    const ops = await login('ops@austin.test');
    const cred = await pairedDevice(ops, 'scr_tacos_menu');
    const pl = await call('GET', '/api/device/playlist', { device: cred });
    assert.equal(pl.body.mode, 'menu');
    const ids = pl.body.slots.map((s: any) => s.campaignId ?? s.creativeId);
    assert.ok(ids.includes('menu'));
    assert.ok(ids.includes('cmp_dentist'));
    assert.ok(!ids.includes('cmp_brewery'));
    const adSec = pl.body.slots.filter((s: any) => s.campaignId).reduce((a: number, s: any) => a + s.durationSec, 0);
    assert.ok(adSec <= 24, `menu screens are capped at 20% ads, got ${adSec}s`);

    const menu = await call('GET', '/api/device/menu', { device: cred });
    assert.equal(menu.body.sections[0].name, 'Tacos');
  });

  test('pop ingestion prices plays, splits revenue and rejects bad events', async () => {
    const ops = await login('ops@austin.test');
    const cred = await pairedDevice(ops, 'scr_pub_bar');
    const now = new Date().toISOString();
    const ev = (id: string, campaignId: string | null, creativeId: string, durationSec = 10, playedAt = now) =>
      ({ id, campaignId, creativeId, durationSec, playedAt });

    const r = await call('POST', '/api/device/pop', {
      device: cred,
      body: {
        events: [
          ev('a1', 'cmp_dentist', 'cr_dentist'),
          ev('a1', 'cmp_dentist', 'cr_dentist'), // duplicate
          ev('a2', 'cmp_dentist', 'cr_dentist', 2), // too short
          ev('a3', 'cmp_dentist', 'cr_carwash'), // creative from another campaign
          ev('a4', 'cmp_carwash', 'cr_carwash'), // network campaign
          ev('a5', null, 'house-trivia', 15), // house content
          ev('a6', 'cmp_dentist', 'cr_dentist', 10, '2001-01-01T00:00:00Z'), // stale
          ev('a7', 'cmp_nope', 'cr_dentist'), // unknown campaign
        ],
      },
    });
    assert.deepEqual(r.body, { accepted: 3, rejected: 4, duplicates: 1 });

    const rows = db.prepare(`SELECT * FROM pop_events WHERE device_id = ? ORDER BY id`).all(cred.split('.')[0]) as any[];
    const dentist = rows.find((x) => x.campaign_id === 'cmp_dentist');
    // pub multiplier 5, $12 CPM → 60,000 micros; local platform fee 5%; venue share 25%
    assert.deepEqual(
      [dentist.gross_micros, dentist.platform_micros, dentist.venue_micros, dentist.operator_micros],
      [60_000, 3_000, 14_250, 42_750],
    );
    const carwash = rows.find((x) => x.campaign_id === 'cmp_carwash');
    // $8 CPM × 5 = 40,000; network take 20% = 8,000; venue 25% of 32,000 = 8,000
    assert.deepEqual([carwash.gross_micros, carwash.platform_micros, carwash.venue_micros], [40_000, 8_000, 8_000]);
    const house = rows.find((x) => x.campaign_id === null);
    assert.equal(house.gross_micros, 0);

    const spent = db.prepare(`SELECT spent_micros FROM campaigns WHERE id = 'cmp_dentist'`).get() as any;
    assert.ok(spent.spent_micros >= 60_000);

    const report = await call('GET', '/api/reports/operator', { token: ops });
    assert.ok(report.body.totals.plays >= 2);
    assert.ok(report.body.byVenue.some((v: any) => v.name === 'Eastside Pub'));
  });

  test('alcohol ad played at a venue that blocks alcohol is rejected', async () => {
    const ops = await login('ops@austin.test');
    const cred = await pairedDevice(ops, 'scr_tacos_menu');
    const r = await call('POST', '/api/device/pop', {
      device: cred,
      body: { events: [{ id: 'b1', campaignId: 'cmp_brewery', creativeId: 'cr_brewery', durationSec: 10, playedAt: new Date().toISOString() }] },
    });
    assert.deepEqual(r.body, { accepted: 0, rejected: 1, duplicates: 0 });
  });
});

describe('advertiser self-serve and review', () => {
  test('signup → campaign → creative → submit → approval requires payment → invoiced → active', async () => {
    const brand = await call('GET', '/api/public/operators/austin');
    assert.equal(brand.body.name, 'Austin Screen Co.');
    assert.equal(brand.body.platformFeePct, undefined, 'internal fields not exposed publicly');

    const signup = await call('POST', '/api/public/operators/austin/advertisers', {
      body: { businessName: 'Joe’s Plumbing', name: 'Joe', email: 'joe@plumb.test', password: 'pipes1234' },
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    const adv = signup.body.token;
    const year = new Date().getFullYear();

    assert.equal((await call('POST', '/api/campaigns', {
      token: adv, body: { name: 'Too small', startDate: `${year}-01-01`, endDate: `${year}-12-31`, budgetCents: 100 },
    })).status, 400, 'below operator minimum budget');

    const c = await call('POST', '/api/campaigns', {
      token: adv,
      body: {
        name: 'Spring tune-up', startDate: `${year}-01-01`, endDate: `${year}-12-31`, budgetCents: 5000,
        adCategory: 'home_services', geo: { lat: 30.25, lng: -97.75, radiusMiles: 4 }, tier: 'sponsorship', cpmCents: 1,
      },
    });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.tier, 'local', 'advertisers cannot choose their tier');
    assert.equal(c.body.cpmCents, 1200, 'advertisers get the operator rate card');
    const id = c.body.id;

    assert.equal((await call('POST', `/api/campaigns/${id}/submit`, { token: adv })).status, 400, 'needs a creative');
    assert.equal((await call('POST', `/api/campaigns/${id}/creatives`, { token: adv, body: { dataBase64: Buffer.from('<html>').toString('base64') } })).status, 400);
    const withCreative = await call('POST', `/api/campaigns/${id}/creatives`, { token: adv, body: { dataBase64: PNG, durationSec: 10 } });
    assert.equal(withCreative.body.creatives.length, 1);
    assert.equal((await call('POST', `/api/campaigns/${id}/submit`, { token: adv })).body.status, 'pending_review');
    assert.equal((await call('POST', `/api/campaigns/${id}/approve`, { token: adv })).status, 403, 'advertisers cannot self-approve');

    const ops = await login('ops@austin.test');
    assert.equal((await call('POST', `/api/campaigns/${id}/approve`, { token: ops })).status, 409, 'unpaid');
    await call('POST', `/api/campaigns/${id}/mark-invoiced`, { token: ops });
    assert.equal((await call('POST', `/api/campaigns/${id}/approve`, { token: ops })).body.status, 'active');

    const cred = await pairedDevice(ops, 'scr_pub_bar');
    const pl = await call('GET', '/api/device/playlist', { device: cred });
    assert.ok(pl.body.slots.some((s: any) => s.campaignId === id), 'new campaign is served');

    const other = await call('GET', `/api/campaigns/cmp_dentist`, { token: adv });
    assert.equal(other.status, 404, 'advertisers only see their own campaigns');
  });

  test('stripe webhook marks a campaign paid only with a valid signature', async () => {
    const ops = await login('ops@austin.test');
    const year = new Date().getFullYear();
    const c = await call('POST', '/api/campaigns', {
      token: ops, body: { advertiserId: 'adv_dentist', name: 'Fall promo', startDate: `${year}-01-01`, endDate: `${year}-12-31`, budgetCents: 5000 },
    });
    db.prepare(`UPDATE campaigns SET stripe_session_id = 'cs_test_1' WHERE id = ?`).run(c.body.id);
    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', payment_status: 'paid', metadata: { campaign_id: c.body.id } } },
    });
    const bad = await call('POST', '/api/stripe/webhook', { raw: payload, headers: { 'stripe-signature': signWebhookForTest(payload, 'wrong') } });
    assert.equal(bad.status, 400);
    const good = await call('POST', '/api/stripe/webhook', { raw: payload, headers: { 'stripe-signature': signWebhookForTest(payload, WEBHOOK_SECRET) } });
    assert.equal(good.status, 200);
    assert.equal((await call('GET', `/api/campaigns/${c.body.id}`, { token: ops })).body.paymentStatus, 'paid');
  });

  test('campaign completes when its budget is spent', async () => {
    const ops = await login('ops@austin.test');
    const year = new Date().getFullYear();
    const c = await call('POST', '/api/campaigns', {
      token: ops, body: { advertiserId: 'adv_dentist', name: 'Tiny', startDate: `${year}-01-01`, endDate: `${year}-12-31`, budgetCents: 2500, cpmCents: 100_000 },
    });
    const id = c.body.id;
    await call('POST', `/api/campaigns/${id}/creatives`, { token: ops, body: { dataBase64: PNG, durationSec: 10 } });
    await call('POST', `/api/campaigns/${id}/submit`, { token: ops });
    await call('POST', `/api/campaigns/${id}/mark-invoiced`, { token: ops });
    await call('POST', `/api/campaigns/${id}/approve`, { token: ops });
    const crId = (await call('GET', `/api/campaigns/${id}`, { token: ops })).body.creatives[0].id;
    const cred = await pairedDevice(ops, 'scr_pub_bar');
    // $1000 CPM × 5 impressions = $5/play → 5 plays exhaust $25
    const events = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, campaignId: id, creativeId: crId, durationSec: 10, playedAt: new Date().toISOString() }));
    await call('POST', '/api/device/pop', { device: cred, body: { events } });
    const after = (await call('GET', `/api/campaigns/${id}`, { token: ops })).body;
    assert.equal(after.status, 'completed');
    assert.equal(after.delivery.spentUsd, 25, 'never bills beyond budget');
    const pl = await call('GET', '/api/device/playlist', { device: cred });
    assert.ok(!pl.body.slots.some((s: any) => s.campaignId === id));
  });
});

describe('venue manager', () => {
  test('can manage blocklist and menu, not commercial terms or other venues', async () => {
    const vm = await login('tacos@austin.test');
    const upd = await call('PUT', '/api/venues/ven_tacos', { token: vm, body: { blockedAdCategories: ['alcohol', 'gambling'], revSharePct: 90 } });
    assert.deepEqual(upd.body.blockedAdCategories, ['alcohol', 'gambling']);
    assert.equal(upd.body.revSharePct, 20, 'rev share unchanged');
    assert.equal((await call('GET', '/api/venues/ven_pub', { token: vm })).status, 404);
    assert.equal((await call('GET', '/api/campaigns', { token: vm })).status, 403);

    const menu = await call('PUT', '/api/venues/ven_tacos/menu', {
      token: vm, body: { title: 'SoCo Tacos', theme: 'brand', sections: [{ name: 'Tacos', items: [{ name: 'Brisket', price: '5.00', soldOut: true }] }] },
    });
    assert.equal(menu.body.sections[0].items[0].soldOut, true);

    const stmt = await call('GET', '/api/reports/venue/ven_tacos', { token: vm });
    assert.equal(stmt.status, 200);
    assert.equal(stmt.body.totals.gross, undefined, 'venues see their earnings, not operator margins');
    assert.equal((await call('GET', '/api/reports/venue/ven_pub', { token: vm })).status, 404);
  });
});

describe('static files', () => {
  test('serves console and player; blocks traversal', async () => {
    assert.equal((await fetch(`${base}/player/`)).status, 200);
    assert.equal((await fetch(`${base}/console/`)).status, 200);
    assert.equal((await fetch(`${base}/creatives/..%2Fpackage.json`)).status, 404);
  });
});
