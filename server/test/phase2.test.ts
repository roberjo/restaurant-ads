import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/app-types.ts';
import { DEMO_PASSWORD, openDb, seedDemo } from '../src/db.ts';
import { checkOfflineScreens } from '../src/jobs.ts';
import { flushOutbox } from '../src/notify.ts';
import { decrypt, encrypt, signState, verifyState } from '../src/crypto.ts';
import { catalogToSections } from '../src/square.ts';

// ---- Fake third-party APIs (Stripe, Square, Resend) ----
interface Call { url: string; method: string; headers: Record<string, string>; body: string }
const calls: Call[] = [];
let seq = 0;
const CATALOG = [
  { type: 'CATEGORY', id: 'C1', category_data: { name: 'Tacos' } },
  { type: 'CATEGORY', id: 'C2', category_data: { name: 'Drinks' } },
  { type: 'ITEM', id: 'I1', item_data: { name: 'Brisket', description: 'Smoked', categories: [{ id: 'C1' }],
    variations: [{ item_variation_data: { price_money: { amount: 475 } } }] } },
  { type: 'ITEM', id: 'I2', item_data: { name: 'Migas', category_id: 'C1',
    variations: [{ item_variation_data: { price_money: { amount: 350 }, location_overrides: [{ location_id: 'L1', sold_out: true }] } }] } },
  { type: 'ITEM', id: 'I3', item_data: { name: 'Horchata', reporting_category: { id: 'C2' }, variations: [{ item_variation_data: { price_money: { amount: 300 } } }] } },
  { type: 'ITEM', id: 'I4', item_data: { name: 'Old special', is_archived: true, variations: [] } },
  { type: 'ITEM', id: 'I5', is_deleted: true, item_data: { name: 'Deleted', variations: [] } },
  { type: 'ITEM', id: 'I6', item_data: { name: 'Mystery', variations: [{ item_variation_data: {} }] } },
];

const fakeFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  calls.push({ url, method: init.method ?? 'GET', headers, body: init.body ? String(init.body) : '' });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://api.stripe.com/v1/accounts') return json({ id: `acct_${++seq}` });
  if (url === 'https://api.stripe.com/v1/account_links') return json({ url: 'https://connect.stripe.com/setup/e/test' });
  if (url.startsWith('https://api.stripe.com/v1/accounts/')) return json({ id: url.split('/').pop(), payouts_enabled: true, details_submitted: true });
  if (url === 'https://api.stripe.com/v1/transfers') return json({ id: `tr_${++seq}` });
  if (url.endsWith('/oauth2/token')) return json({ access_token: 'sq_access', refresh_token: 'sq_refresh', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), merchant_id: 'MERCH1' });
  if (url.includes('/v2/catalog/list')) return json({ objects: CATALOG });
  if (url === 'https://api.resend.com/emails') return json({ id: 'em_1' });
  return json({ error: { message: `unexpected ${url}` } }, 500);
}) as typeof fetch;

const SQ_KEY = 'sq_webhook_key';
const SQ_URL = 'https://ads.example.com/api/square/webhook';

let server: Server;
let db: DatabaseSync;
let base: string;
let uploads: string;
let config: Config;

async function call(method: string, path: string, opts: { token?: string; device?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.device) headers.authorization = `Device ${opts.device}`;
  const r = await fetch(base + path, { method, headers, redirect: 'manual', body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, headers: r.headers };
}
const login = async (email: string) => (await call('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } })).body.token as string;
async function pairedDevice(ops: string, screenId: string) {
  const reg = await call('POST', '/api/device/register');
  await call('POST', `/api/screens/${screenId}/pair`, { token: ops, body: { code: reg.body.pairingCode } });
  return { cred: `${reg.body.deviceId}.${reg.body.deviceSecret}`, id: reg.body.deviceId as string };
}
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();
const dayBefore = (d = 1) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  uploads = mkdtempSync(join(tmpdir(), 'ads-p2-'));
  config = {
    publicUrl: 'https://ads.example.com', uploadsDir: uploads,
    stripeSecretKey: 'sk_test_x', stripeWebhookSecret: 'whsec_x',
    appSecret: 'test-app-secret', squareAppId: 'sq-app', squareAppSecret: 'sq-secret', squareEnvironment: 'sandbox',
    squareWebhookSignatureKey: SQ_KEY, squareWebhookUrl: SQ_URL,
    fetchImpl: fakeFetch,
  };
  server = createApp(db, config);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(uploads, { recursive: true, force: true }); });

describe('audit log', () => {
  test('records changes per operator, including refused attempts', async () => {
    const ops = await login('ops@austin.test');
    await call('PUT', '/api/operator', { token: ops, body: { brandColor: '#123456' } });
    await call('PUT', '/api/operator', { token: ops, body: { brandColor: 'blue' } }); // 400
    const log = (await call('GET', '/api/audit', { token: ops })).body;
    assert.equal(log[0].status, 400);
    assert.equal(log[1].status, 200);
    assert.equal(log[0].path, '/api/operator');
    assert.equal(log[0].email, 'ops@austin.test');
    assert.equal((await call('GET', '/api/audit', { token: await login('tacos@austin.test') })).status, 403);
  });
});

describe('open hours, fleet alerts and device power', () => {
  test('a closed venue suppresses offline alerts and puts the TV in standby', async () => {
    const ops = await login('ops@austin.test');
    const { cred, id } = await pairedDevice(ops, 'scr_pub_bar');
    assert.equal((await call('PUT', '/api/venues/ven_pub', { token: ops, body: { openHours: { mon: [['9:00', '17:00']] } } })).status, 400);
    await call('PUT', '/api/venues/ven_pub', { token: ops, body: { openHours: {} } }); // closed every day
    db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(new Date(Date.now() - 3600_000).toISOString(), id);

    const fleet = (await call('GET', '/api/fleet', { token: ops })).body;
    const pub = fleet.screens.find((s: any) => s.id === 'scr_pub_bar');
    assert.equal(pub.status, 'offline');
    assert.equal(pub.venueOpen, false);
    assert.ok(!fleet.alerts.some((a: any) => a.screenId === 'scr_pub_bar'), 'no alert while closed');

    const power = await call('GET', '/api/device/power', { device: cred });
    assert.equal(power.body.power, 'standby');
    const seen = db.prepare(`SELECT last_seen_at FROM devices WHERE id = ?`).get(id) as any;
    assert.ok(Date.parse(seen.last_seen_at) < Date.now() - 1800_000, 'power polling is not a heartbeat');

    await call('PUT', '/api/venues/ven_pub', { token: ops, body: { openHours: null } }); // always open
    assert.equal((await call('GET', '/api/device/power', { device: cred })).body.power, 'on');
    const fleet2 = (await call('GET', '/api/fleet', { token: ops })).body;
    assert.ok(fleet2.alerts.some((a: any) => a.screenId === 'scr_pub_bar'), 'alert once open');
  });

  test('venue managers can set their own hours', async () => {
    const vm = await login('tacos@austin.test');
    const r = await call('PUT', '/api/venues/ven_tacos', { token: vm, body: { openHours: { mon: [['07:00', '15:00']] } } });
    assert.deepEqual(r.body.openHours, { mon: [['07:00', '15:00']] });
    await call('PUT', '/api/venues/ven_tacos', { token: vm, body: { openHours: null } });
  });
});

describe('remote device commands', () => {
  test('queue → delivered on heartbeat → acknowledged once', async () => {
    const ops = await login('ops@austin.test');
    const { cred } = await pairedDevice(ops, 'scr_tacos_menu');
    assert.equal((await call('POST', '/api/screens/scr_tacos_menu/commands', { token: ops, body: { type: 'format_disk' } })).status, 400);
    const q = await call('POST', '/api/screens/scr_tacos_menu/commands', { token: ops, body: { type: 'identify' } });
    assert.equal(q.body.status, 'queued');
    const hb = await call('POST', '/api/device/heartbeat', { device: cred, body: {} });
    assert.deepEqual(hb.body.commands.map((c: any) => c.type), ['identify']);
    assert.equal((await call('POST', `/api/device/commands/${q.body.id}/ack`, { device: cred })).body.ok, true);
    assert.equal((await call('POST', `/api/device/commands/${q.body.id}/ack`, { device: cred })).body.ok, false);
    assert.equal((await call('POST', '/api/device/heartbeat', { device: cred, body: {} })).body.commands.length, 0);
  });
});

describe('creative templates', () => {
  test('preview and save a templated ad; served sandboxed', async () => {
    const adv = await login('dentist@austin.test');
    const preview = await call('POST', '/api/templates/preview', { token: adv, body: { template: 'bold', headline: 'Free whitening', cta: 'Book today' } });
    assert.ok(preview.body.svg.includes('Free whitening'));

    const year = new Date().getFullYear();
    const c = await call('POST', '/api/campaigns', { token: adv, body: { name: 'Template test', startDate: `${year}-01-01`, endDate: `${year}-12-31`, budgetCents: 5000 } });
    const saved = await call('POST', `/api/campaigns/${c.body.id}/creatives/template`, {
      token: adv, body: { template: 'split', headline: 'Smile <b>brighter</b>', subline: 'New patients welcome', bgColor: '#1e3a8a', durationSec: 12 },
    });
    const cr = saved.body.creatives[0];
    assert.match(cr.url, /^\/uploads\/[0-9a-f]+\.svg$/);
    assert.equal(cr.durationSec, 12);
    const file = await fetch(base + cr.url);
    assert.equal(file.headers.get('content-type'), 'image/svg+xml');
    assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);
    const svg = await file.text();
    assert.ok(svg.includes('&lt;b&gt;brighter'), 'user text is escaped');
  });
});

describe('notifications', () => {
  test('submission emails the operator; outbox delivers via Resend or skips without a key', async () => {
    const adv = await login('dentist@austin.test');
    const year = new Date().getFullYear();
    const c = await call('POST', '/api/campaigns', { token: adv, body: { name: 'Notify test', startDate: `${year}-01-01`, endDate: `${year}-12-31`, budgetCents: 5000 } });
    await call('POST', `/api/campaigns/${c.body.id}/creatives/template`, { token: adv, body: { template: 'bold', headline: 'Hi' } });
    await call('POST', `/api/campaigns/${c.body.id}/submit`, { token: adv });
    const msg = db.prepare(`SELECT * FROM outbox WHERE subject LIKE 'Campaign to review: Notify test%'`).get() as any;
    assert.equal(msg.to_email, 'ops@austin.test');

    const skipped = await flushOutbox(db, { ...config, resendApiKey: undefined });
    assert.ok(skipped.skipped >= 1);
    db.prepare(`UPDATE outbox SET status = 'pending' WHERE id = ?`).run(msg.id);
    const before = calls.length;
    const sent = await flushOutbox(db, { ...config, resendApiKey: 're_test', emailFrom: 'Ads <ads@example.com>' });
    assert.ok(sent.sent >= 1);
    const resend = calls.slice(before).find((x) => x.url === 'https://api.resend.com/emails')!;
    assert.equal(resend.headers.authorization, 'Bearer re_test');
    assert.equal(JSON.parse(resend.body).to[0], 'ops@austin.test');
  });

  test('offline screens alert once per outage, only while the venue is open', async () => {
    const ops = await login('ops@austin.test');
    const { id } = await pairedDevice(ops, 'scr_tacos_menu');
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(stale, id);
    const tacosAlerts = () => (db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE dedupe_key LIKE 'offline:scr_tacos_menu:%'`).get() as any).n;
    checkOfflineScreens(db, config);
    assert.equal(tacosAlerts(), 1);
    checkOfflineScreens(db, config);
    assert.equal(tacosAlerts(), 1, 'deduplicated');
    db.prepare(`UPDATE venues SET open_hours = '{}' WHERE id = 'ven_tacos'`).run();
    db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(new Date(Date.now() - 25 * 60_000).toISOString(), id);
    checkOfflineScreens(db, config);
    assert.equal(tacosAlerts(), 1, 'closed venue: no new alert for a new outage');
    db.prepare(`UPDATE venues SET open_hours = NULL WHERE id = 'ven_tacos'`).run();
  });
});

describe('payouts (Stripe Connect)', () => {
  test('onboarding creates an Express account and returns a link', async () => {
    const ops = await login('ops@austin.test');
    const r = await call('POST', '/api/operator/stripe/onboard', { token: ops });
    assert.equal(r.body.url, 'https://connect.stripe.com/setup/e/test');
    assert.match(r.body.account, /^acct_/);
    const again = await call('POST', '/api/operator/stripe/onboard', { token: ops });
    assert.equal(again.body.account, r.body.account, 'reuses the account');
    const st = await call('GET', '/api/operator/stripe/status', { token: ops });
    assert.deepEqual(st.body, { connected: true, payoutsEnabled: true, detailsSubmitted: true });
  });

  test('run pays card-paid earnings once, carries remainders, waits for missing accounts', async () => {
    const ops = await login('ops@austin.test');
    const admin = await login('admin@platform.test');
    db.prepare(`UPDATE campaigns SET cpm_cents = 100000 WHERE id = 'cmp_dentist'`).run(); // $5 per play at the pub
    db.prepare(`UPDATE pop_events SET operator_payout_id = 'old', venue_payout_id = 'old'`).run(); // ignore earlier tests' plays
    const { cred } = await pairedDevice(ops, 'scr_pub_bar');
    const ev = (id: string, campaignId: string, creativeId: string) => ({ id, campaignId, creativeId, durationSec: 10, playedAt: yesterday() });
    const pop = await call('POST', '/api/device/pop', { device: cred, body: { events: [
      ev('p1', 'cmp_dentist', 'cr_dentist'), ev('p2', 'cmp_dentist', 'cr_dentist'), ev('p3', 'cmp_carwash', 'cr_carwash'),
    ] } });
    assert.equal(pop.body.accepted, 3);

    assert.equal((await call('POST', '/api/admin/payouts/run', { token: admin, body: { periodEnd: new Date().toISOString().slice(0, 10) } })).status, 400, 'period must be closed');
    const before = calls.length;
    const run = await call('POST', '/api/admin/payouts/run', { token: admin, body: { periodEnd: dayBefore() } });
    assert.equal(run.body.created, 2, 'operator + venue; the invoiced network campaign is excluded');
    assert.equal(run.body.paid, 1);
    assert.equal(run.body.awaiting_account, 1);

    const payouts = (await call('GET', '/api/payouts', { token: ops })).body;
    const op = payouts.find((p: any) => p.recipientType === 'operator');
    const ven = payouts.find((p: any) => p.recipientType === 'venue');
    // per play: gross 5,000,000µ; platform 5% → net 4,750,000; venue 25% = 1,187,500; operator 3,562,500
    assert.deepEqual([op.earnedMicros, op.amountCents, op.remainderMicros, op.status], [7_125_000, 712, 5_000, 'paid']);
    assert.deepEqual([ven.earnedMicros, ven.amountCents, ven.status], [2_375_000, 237, 'awaiting_account']);
    const transfer = calls.slice(before).find((x) => x.url === 'https://api.stripe.com/v1/transfers')!;
    assert.equal(transfer.headers['idempotency-key'], op.id);
    assert.match(transfer.body, /amount=712/);

    const rerun = await call('POST', '/api/admin/payouts/run', { token: admin, body: { periodEnd: dayBefore() } });
    assert.equal(rerun.body.created, 0, 'plays are never paid twice');

    db.prepare(`UPDATE venues SET stripe_account_id = 'acct_venue' WHERE id = 'ven_pub'`).run();
    const retry = await call('POST', '/api/admin/payouts/retry', { token: admin });
    assert.equal(retry.body.paid, 1);

    await call('POST', '/api/device/pop', { device: cred, body: { events: [ev('p4', 'cmp_dentist', 'cr_dentist')] } });
    await call('POST', '/api/admin/payouts/run', { token: admin, body: { periodEnd: dayBefore() } });
    const latest = (await call('GET', '/api/payouts', { token: ops })).body.find((p: any) => p.recipientType === 'operator');
    assert.deepEqual([latest.carryInMicros, latest.amountCents, latest.remainderMicros], [5_000, 356, 7_500]);

    const vm = await login('tacos@austin.test');
    assert.deepEqual((await call('GET', '/api/payouts', { token: vm })).body, [], 'venue managers only see their venue');
  });
});

describe('Square POS menu sync', () => {
  test('token encryption and signed state', () => {
    const t = encrypt('k', 'secret-token');
    assert.notEqual(t, 'secret-token');
    assert.equal(decrypt('k', t), 'secret-token');
    assert.throws(() => decrypt('other', t));
    const s = signState('k', { venueId: 'v1' });
    assert.equal(verifyState('k', s)?.venueId, 'v1');
    assert.equal(verifyState('k', s.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);
    assert.equal(verifyState('k', signState('k', { venueId: 'v1' }, -1)), null, 'expired');
  });

  test('catalog maps to sections with prices and sold-out items', () => {
    const sections = catalogToSections(CATALOG);
    assert.deepEqual(sections.map((s) => s.name), ['Drinks', 'Tacos', 'Menu']);
    const tacos = sections.find((s) => s.name === 'Tacos')!;
    assert.deepEqual(tacos.items.map((i) => [i.name, i.price, i.soldOut]), [['Brisket', '4.75', false], ['Migas', '3.50', true]]);
    assert.equal(sections.find((s) => s.name === 'Menu')!.items[0].price, '', 'variable price');
    assert.ok(!JSON.stringify(sections).includes('Old special') && !JSON.stringify(sections).includes('Deleted'));
  });

  test('OAuth connect → callback → menu synced; tokens stored encrypted', async () => {
    const vm = await login('tacos@austin.test');
    const c = await call('POST', '/api/venues/ven_tacos/square/connect', { token: vm });
    const url = new URL(c.body.url);
    assert.equal(url.origin, 'https://connect.squareupsandbox.com');
    assert.equal(url.searchParams.get('scope'), 'ITEMS_READ MERCHANT_PROFILE_READ');

    const bad = await call('GET', `/api/square/callback?code=x&state=forged`);
    assert.equal(bad.status, 400);
    const cb = await call('GET', `/api/square/callback?code=auth_code_1&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get('location')!, /venues\/ven_tacos\/menu\?square=connected/);

    const integ = db.prepare(`SELECT * FROM integrations WHERE venue_id = 'ven_tacos'`).get() as any;
    assert.ok(!integ.access_token_enc.includes('sq_access'), 'token encrypted at rest');
    const menu = (await call('GET', '/api/venues/ven_tacos/menu', { token: vm })).body;
    assert.deepEqual(menu.sections.map((s: any) => s.name), ['Drinks', 'Tacos', 'Menu']);
    const status = (await call('GET', '/api/venues/ven_tacos/square', { token: vm })).body;
    assert.equal(status.connected, true);
    assert.equal(status.merchantId, 'MERCH1');
    assert.equal((await call('GET', '/api/venues/ven_pub/square', { token: vm })).status, 404);
  });

  test('signed webhook triggers a resync; unsigned is rejected', async () => {
    const body = JSON.stringify({ type: 'catalog.version.updated', merchant_id: 'MERCH1' });
    assert.equal((await call('POST', '/api/square/webhook', { raw: body, headers: { 'x-square-hmacsha256-signature': 'nope' } })).status, 400);
    const before = calls.filter((c) => c.url.includes('/v2/catalog/list')).length;
    const sig = createHmac('sha256', SQ_KEY).update(SQ_URL + body).digest('base64');
    assert.equal((await call('POST', '/api/square/webhook', { raw: body, headers: { 'x-square-hmacsha256-signature': sig } })).status, 200);
    for (let i = 0; i < 50 && calls.filter((c) => c.url.includes('/v2/catalog/list')).length === before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(calls.filter((c) => c.url.includes('/v2/catalog/list')).length > before);
  });
});
