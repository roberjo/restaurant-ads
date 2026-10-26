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
import { syncAllQuantities } from '../src/billing.ts';
import { signWebhookForTest } from '../src/stripe.ts';

// ---- Fake Stripe Billing: one subscription whose status and quantity the tests control ----
interface Call { url: string; method: string; body: URLSearchParams }
const calls: Call[] = [];
const sub = {
  id: 'sub_1', status: 'trialing', customer: 'cus_1', metadata: { operator_id: 'op_austin' }, trial_end: 1_900_000_000,
  items: { data: [{ id: 'si_1', quantity: 1, price: { unit_amount: 1500 }, current_period_end: 1_900_000_000 }] },
};

const fakeFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const body = new URLSearchParams(init.body ? String(init.body) : '');
  calls.push({ url, method: init.method ?? 'GET', body });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://api.stripe.com/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
  if (url === 'https://api.stripe.com/v1/billing_portal/sessions') return json({ url: 'https://billing.stripe.com/p/session_1' });
  if (url === 'https://api.stripe.com/v1/subscriptions/sub_1') return json(sub);
  if (url === 'https://api.stripe.com/v1/subscription_items/si_1') {
    sub.items.data[0].quantity = Number(body.get('quantity'));
    return json(sub.items.data[0]);
  }
  return json({ error: { message: `unexpected ${url}` } }, 500);
}) as typeof fetch;

let server: Server;
let db: DatabaseSync;
let base: string;
let uploads: string;
let config: Config;

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const r = await fetch(base + path, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body };
}
const login = async (email: string) => (await call('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } })).body.token as string;
const webhook = (event: unknown) => {
  const raw = JSON.stringify(event);
  return call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': signWebhookForTest(raw, 'whsec_x') } });
};
async function addScreen(ops: string, n: number) {
  return (await call('POST', '/api/screens', { token: ops, body: { venueId: 'ven_tacos', name: `Extra ${n}`, mode: 'idle' } })).body.id as string;
}
async function pair(ops: string, screenId: string) {
  const reg = await call('POST', '/api/device/register');
  return call('POST', `/api/screens/${screenId}/pair`, { token: ops, body: { code: reg.body.pairingCode } });
}
const op = () => db.prepare(`SELECT * FROM operators WHERE id = 'op_austin'`).get() as any;
const until = async (fn: () => boolean) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  uploads = mkdtempSync(join(tmpdir(), 'ads-billing-'));
  config = { publicUrl: 'https://ads.example.com', uploadsDir: uploads, stripeSecretKey: 'sk_test_x', stripeWebhookSecret: 'whsec_x', fetchImpl: fakeFetch };
  server = createApp(db, config);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(uploads, { recursive: true, force: true }); });

describe('operator SaaS billing', () => {
  test('free plan allows a limited number of paired screens, then 402', async () => {
    const ops = await login('ops@austin.test');
    const b = (await call('GET', '/api/operator/billing', { token: ops })).body;
    assert.equal(b.state, 'none');
    assert.equal(b.freeScreens, 2);
    assert.equal((await pair(ops, 'scr_tacos_menu')).status, 200);
    assert.equal((await pair(ops, 'scr_pub_bar')).status, 200);
    const third = await pair(ops, await addScreen(ops, 1));
    assert.equal(third.status, 402);
    assert.match(third.body.error, /free plan covers 2 screens/);
    // Replacing the device on an already-paired screen is always allowed
    assert.equal((await pair(ops, 'scr_pub_bar')).status, 200);
  });

  test('checkout creates a per-screen subscription with a trial', async () => {
    const ops = await login('ops@austin.test');
    const r = await call('POST', '/api/operator/billing/checkout', { token: ops });
    assert.equal(r.status, 200);
    assert.equal(r.body.url, 'https://checkout.stripe.com/c/cs_1');
    const c = calls.findLast((x) => x.url.endsWith('/v1/checkout/sessions'))!.body;
    assert.equal(c.get('mode'), 'subscription');
    assert.equal(c.get('line_items[0][quantity]'), '2');
    assert.equal(c.get('line_items[0][price_data][unit_amount]'), '1500');
    assert.equal(c.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(c.get('subscription_data[trial_period_days]'), '30');
    assert.equal(c.get('subscription_data[metadata][operator_id]'), 'op_austin');
    assert.equal(c.get('customer_email'), 'ops@austin.test');
  });

  test('checkout webhook records the subscription and syncs quantity to paired screens', async () => {
    const r = await webhook({ type: 'checkout.session.completed', data: { object: {
      id: 'cs_1', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', payment_status: 'no_payment_required',
      metadata: { operator_id: 'op_austin', kind: 'saas' },
    } } });
    assert.equal(r.status, 200);
    const o = op();
    assert.equal(o.billing_status, 'trialing');
    assert.equal(o.stripe_customer_id, 'cus_1');
    assert.equal(o.stripe_subscription_item_id, 'si_1');
    assert.equal(o.billed_screens, 2, 'quantity raised from 1 to the 2 paired screens');
    assert.equal(sub.items.data[0].quantity, 2);
    assert.equal(o.billing_period_end, new Date(1_900_000_000 * 1000).toISOString());
  });

  test('subscribed operators can pair more screens; quantity follows pairing', async () => {
    const ops = await login('ops@austin.test');
    const s = await addScreen(ops, 2);
    assert.equal((await pair(ops, s)).status, 200);
    await until(() => sub.items.data[0].quantity === 3);
    assert.equal(sub.items.data[0].quantity, 3);
    const prorate = calls.findLast((x) => x.url.endsWith('/subscription_items/si_1'))!.body;
    assert.equal(prorate.get('proration_behavior'), 'create_prorations');
    await call('POST', `/api/screens/${s}/unpair`, { token: ops });
    await until(() => sub.items.data[0].quantity === 2);
    assert.equal(op().billed_screens, 2);
    assert.equal(await syncAllQuantities(db, config), 0, 'already in sync');
  });

  test('a second checkout is refused; the portal opens for the customer', async () => {
    const ops = await login('ops@austin.test');
    assert.equal((await call('POST', '/api/operator/billing/checkout', { token: ops })).status, 409);
    const p = await call('POST', '/api/operator/billing/portal', { token: ops });
    assert.equal(p.body.url, 'https://billing.stripe.com/p/session_1');
    assert.equal(calls.findLast((x) => x.url.endsWith('/billing_portal/sessions'))!.body.get('customer'), 'cus_1');
  });

  test('payment failure emails the operator; canceled blocks new pairings but keeps screens playing', async () => {
    const ops = await login('ops@austin.test');
    await webhook({ type: 'invoice.payment_failed', data: { object: { id: 'in_1', customer: 'cus_1' } } });
    await webhook({ type: 'invoice.payment_failed', data: { object: { id: 'in_1', customer: 'cus_1' } } }); // retried delivery
    const mails = db.prepare(`SELECT * FROM outbox WHERE subject LIKE 'Payment failed%'`).all();
    assert.equal(mails.length, 1);

    sub.status = 'canceled';
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    assert.equal(op().billing_status, 'canceled');
    const r = await pair(ops, await addScreen(ops, 3));
    assert.equal(r.status, 402);
    assert.match(r.body.error, /billing is canceled/);
    const fleet = (await call('GET', '/api/screens', { token: ops })).body;
    assert.ok(fleet.filter((x: any) => x.deviceId).length >= 2, 'existing screens stay paired');
    assert.equal(await syncAllQuantities(db, config), 0, 'no quantity updates on a canceled subscription');
  });

  test('platform admin comps a design partner and sees MRR', async () => {
    const admin = await login('admin@platform.test');
    const ops = await login('ops@austin.test');
    const future = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
    const comp = await call('PUT', '/api/admin/operators/op_austin/billing', { token: admin, body: { freeUntil: future } });
    assert.equal(comp.body.state, 'comped');
    assert.equal(comp.body.monthlyEstimateCents, 0);
    assert.equal((await pair(ops, await addScreen(ops, 4))).status, 200);
    assert.equal((await call('PUT', '/api/admin/operators/op_austin/billing', { token: ops, body: { freeUntil: null } })).status, 403);

    sub.status = 'active';
    await call('PUT', '/api/admin/operators/op_austin/billing', { token: admin, body: { freeUntil: null } });
    await webhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
    const report = (await call('GET', '/api/admin/billing', { token: admin })).body;
    assert.equal(report.totals.payingOperators, 1);
    assert.equal(report.totals.mrrCents, 1500 * op().billed_screens);

    const s = await call('PUT', '/api/admin/settings', { token: admin, body: { priceCents: 1800, trialDays: 14, freeScreens: 1 } });
    assert.deepEqual([s.body.priceCents, s.body.trialDays, s.body.freeScreens, s.body.networkTakePct], [1800, 14, 1, 20]);
  });

  test('subscription events for unknown operators are ignored; other operators cannot read billing', async () => {
    const r = await webhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_unknown' } } });
    assert.equal(r.status, 200);
    assert.ok(!calls.some((c) => c.url.endsWith('/sub_unknown')), 'not fetched');
    const adv = await login('dentist@austin.test');
    assert.equal((await call('GET', '/api/operator/billing', { token: adv })).status, 403);
  });
});
