import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/app-types.ts';
import { DEMO_PASSWORD, openDb, seedDemo } from '../src/db.ts';
import { forecastInventory, daypartOf } from '../src/forecast.ts';
import { hourBucket, operatorQuality } from '../src/quality.ts';

let server: Server;
let db: DatabaseSync;
let base: string;
let uploads: string;
let config: Config;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const r = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body };
}
const login = async (email: string) => (await call('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } })).body.token as string;

const now = new Date();
/** Pair a device directly, set up 8 days ago. */
function pairAgo(screenId: string, days = 8) {
  db.prepare(`INSERT INTO devices (id, secret_hash, screen_id, operator_id, created_at) VALUES (?, 'x', ?, 'op_austin', ?)`)
    .run(`dev_${screenId}`, screenId, new Date(now.getTime() - days * 86_400_000).toISOString());
}
function heartbeatEveryHour(screenId: string, days = 7) {
  const ins = db.prepare(`INSERT OR REPLACE INTO screen_activity (screen_id, hour, heartbeats, plays, rejected) VALUES (?, ?, 60, 30, 0)`);
  for (let i = 0; i <= days * 24; i++) ins.run(screenId, hourBucket(new Date(now.getTime() - i * 3600_000)));
}

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  uploads = mkdtempSync(join(tmpdir(), 'ads-prog-'));
  config = { publicUrl: 'https://ads.example.com', uploadsDir: uploads };
  server = createApp(db, config);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(uploads, { recursive: true, force: true }); });

describe('operator quality score', () => {
  test('needs history before it can qualify', () => {
    const q = operatorQuality(db, 'op_austin', now);
    assert.equal(q.score, null);
    assert.equal(q.eligible, false);
    assert.match(q.reason, /needs 24 open screen-hours/);
  });

  test('full uptime, metadata and compliance qualify', () => {
    pairAgo('scr_tacos_menu');
    pairAgo('scr_pub_bar');
    heartbeatEveryHour('scr_tacos_menu');
    heartbeatEveryHour('scr_pub_bar');
    const q = operatorQuality(db, 'op_austin', now);
    assert.equal(q.uptimePct, 100);
    assert.equal(q.metadataPct, 88, 'tacos has no open hours: 7 of 8 checks');
    assert.equal(q.compliancePct, 100);
    assert.equal(q.score, Math.round(0.6 * 100 + 0.2 * 88 + 0.2 * 100));
    assert.equal(q.eligible, true);
    // Tacos (no hours) is expected every hour; the pub only while open
    assert.ok(q.expectedScreenHours > 168 && q.expectedScreenHours < 168 * 2);
  });

  test('downtime and rejected plays lower the score below the threshold', () => {
    db.prepare(`DELETE FROM screen_activity WHERE screen_id = 'scr_tacos_menu'`).run();
    db.prepare(`UPDATE screen_activity SET rejected = 30 WHERE screen_id = 'scr_pub_bar'`).run();
    const q = operatorQuality(db, 'op_austin', now);
    assert.ok(q.uptimePct! < 50);
    assert.equal(q.compliancePct, 50);
    assert.ok(q.score! < 80);
    assert.equal(q.eligible, false);
    assert.match(q.reason, /below 80/);
  });

  test('hours before the device was set up do not count as downtime', () => {
    db.prepare(`UPDATE devices SET created_at = ? WHERE screen_id = 'scr_tacos_menu'`).run(new Date(now.getTime() - 2 * 3600_000).toISOString());
    const q = operatorQuality(db, 'op_austin', now);
    assert.ok(q.uptimePct! > 90, `uptime ${q.uptimePct}`);
  });
});

describe('inventory forecast', () => {
  test('capacity follows venue hours, ad share and audience multiplier', () => {
    const f = forecastInventory(db, ['op_austin'], 7, now);
    assert.equal(f.screens, 2);
    const qsr = f.byVenueType.find((r) => r.venueType === 'entertainment.qsr')!;
    // Tacos: open around the clock (no hours set), 20% ad share, multiplier 3
    assert.equal(qsr.adSeconds, 168 * 3600 * 0.2);
    assert.equal(qsr.impressions, (168 * 3600 * 0.2 / 10) * 3);
    const bars = f.byVenueType.find((r) => r.venueType === 'entertainment.bars')!;
    assert.ok(bars.adSeconds > 0 && bars.adSeconds < 168 * 3600 * 0.4, 'the pub is closed part of the week');
    assert.equal(f.byDay.length >= 7, true);
    assert.equal(f.totals.adSeconds, qsr.adSeconds + bars.adSeconds);
    assert.deepEqual(f.byDaypart.map((d) => d.daypart).sort(), ['afternoon', 'breakfast', 'dinner', 'late', 'lunch']);
  });

  test('booked campaigns are netted out of capacity', () => {
    // Mid-year, so the seeded campaigns (this calendar year) run through the whole window.
    const june = new Date(`${now.getUTCFullYear()}-06-01T12:00:00Z`);
    db.prepare(`UPDATE campaigns SET budget_cents = 10000000 WHERE id = 'cmp_dentist'`).run(); // enough for the week
    const f = forecastInventory(db, ['op_austin'], 7, june);
    db.prepare(`UPDATE campaigns SET budget_cents = 50000 WHERE id = 'cmp_dentist'`).run();
    const qsr = f.byVenueType.find((r) => r.venueType === 'entertainment.qsr')!;
    // Tacos loop: 24 s of ad time; the dentist takes 2 × 10 s (20% SOV cap), alcohol is blocked,
    // and the 10 s network spot no longer fits in the 4 s left.
    assert.equal(qsr.soldSeconds, 168 * 30 * 20);
    assert.equal(qsr.availableSeconds, 168 * 30 * 4);
    assert.equal(qsr.sellThroughPct, 83.3);
    assert.equal(f.totals.soldSeconds + f.totals.availableSeconds, f.totals.adSeconds);
    const dentist = f.byCampaign.find((c) => c.campaignId === 'cmp_dentist')!;
    assert.equal(dentist.budgetLimited, false);
    assert.ok(f.byCampaign.some((c) => c.campaignId === 'cmp_carwash' && c.network), 'network spot still plays at the pub');
  });

  test('sold time is capped by remaining budget', () => {
    const june = new Date(`${now.getUTCFullYear()}-06-01T12:00:00Z`);
    const before = forecastInventory(db, ['op_austin'], 7, june);
    // $500 budget at $12 CPM; leave $1.20 = 100 impressions
    db.prepare(`UPDATE campaigns SET spent_micros = budget_cents * 10000 - 1200000 WHERE id = 'cmp_dentist'`).run();
    const f = forecastInventory(db, ['op_austin'], 7, june);
    const dentist = f.byCampaign.find((c) => c.campaignId === 'cmp_dentist')!;
    assert.deepEqual([dentist.forecastImpressions, dentist.remainingBudgetImpressions, dentist.budgetLimited], [100, 100, true]);
    assert.ok(f.totals.availableSeconds > before.totals.availableSeconds);
    db.prepare(`UPDATE campaigns SET spent_micros = 0 WHERE id = 'cmp_dentist'`).run();
  });

  test('venue type filter narrows the forecast', () => {
    const f = forecastInventory(db, ['op_austin'], 7, now, { venueTypes: ['entertainment.bars'] });
    assert.equal(f.screens, 1);
    assert.deepEqual(f.byVenueType.map((r) => r.venueType), ['entertainment.bars']);
    // Campaign budgets are shared with screens outside the filter, so sold time matches the unfiltered forecast.
    const all = forecastInventory(db, ['op_austin'], 7, now);
    assert.deepEqual(f.byVenueType[0], all.byVenueType.find((r) => r.venueType === 'entertainment.bars'));
  });

  test('dayparts wrap past midnight', () => {
    assert.equal(daypartOf(23), 'late');
    assert.equal(daypartOf(2), 'late');
    assert.equal(daypartOf(6), 'breakfast');
    assert.equal(daypartOf(13), 'lunch');
  });
});

describe('programmatic API', () => {
  test('operators see their quality and forecast; others cannot', async () => {
    const ops = await login('ops@austin.test');
    assert.equal((await call('GET', '/api/quality', { token: ops })).body.pairedScreens, 2);
    const f = (await call('GET', '/api/forecast?days=3', { token: ops })).body;
    assert.equal(f.scope, 'operator');
    assert.equal(f.days, 3);
    assert.equal((await call('GET', '/api/forecast', { token: await login('dentist@austin.test') })).status, 403);
    assert.equal((await call('PUT', '/api/admin/operators/op_austin/programmatic', { token: ops, body: { override: 'allow' } })).status, 403);
  });

  test('platform admin overrides eligibility and sees the pooled network forecast', async () => {
    const admin = await login('admin@platform.test');
    db.prepare(`UPDATE screen_activity SET rejected = 0`).run();
    db.prepare(`DELETE FROM screen_activity WHERE screen_id = 'scr_pub_bar'`).run();
    await call('PUT', '/api/admin/operators/op_austin/programmatic', { token: admin, body: { override: 'deny' } });
    let net = (await call('GET', '/api/forecast', { token: admin })).body;
    assert.equal(net.scope, 'network');
    assert.equal(net.operators, 0);
    assert.equal(net.totals.adSeconds, 0);
    const r = await call('PUT', '/api/admin/operators/op_austin/programmatic', { token: admin, body: { override: 'allow' } });
    assert.equal(r.body.eligible, true);
    net = (await call('GET', '/api/forecast', { token: admin })).body;
    assert.equal(net.operators, 1);
    assert.ok(net.totals.impressions > 0);
    assert.equal((await call('PUT', '/api/admin/operators/op_austin/programmatic', { token: admin, body: { override: 'maybe' } })).status, 400);
    const list = (await call('GET', '/api/admin/quality', { token: admin })).body;
    assert.equal(list[0].override, 'allow');
  });

  test('venue type and screen size are editable and validated', async () => {
    const ops = await login('ops@austin.test');
    assert.equal((await call('PUT', '/api/venues/ven_tacos', { token: ops, body: { venueType: 'Bars & Pubs' } })).status, 400);
    const v = await call('PUT', '/api/venues/ven_tacos', { token: ops, body: { venueType: 'entertainment.casual_dining' } });
    assert.equal(v.body.venueType, 'entertainment.casual_dining');
    const s = await call('PUT', '/api/screens/scr_pub_bar', { token: ops, body: { diagonalIn: 75, widthPx: 3840, heightPx: 2160, audio: true } });
    assert.deepEqual([s.body.diagonalIn, s.body.widthPx, s.body.heightPx, s.body.audio], [75, 3840, 2160, true]);
    const created = await call('POST', '/api/screens', { token: ops, body: { venueId: 'ven_pub', name: 'Patio', heightPx: 1920, widthPx: 1080 } });
    assert.deepEqual([created.body.widthPx, created.body.heightPx, created.body.diagonalIn], [1080, 1920, null]);
  });
});
