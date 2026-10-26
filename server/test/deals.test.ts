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
import { selectWinners } from '../src/rtb.ts';

// ---- Fake SSP: bids through a deal, from the wrong seat, on an unknown deal, and on the open market ----
const requests: any[] = [];
const fakeFetch = (async (input: any, init: any = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : null;
  if (String(input) !== 'https://ssp.example/bid') return new Response('', { status: 200 });
  requests.push(body);
  const img = (n: string) => `<img src="https://cdn.ssp.example/${n}.png">`;
  return new Response(JSON.stringify({ id: body.id, seatbid: [
    { seat: 'agency1', bid: [
      { id: 'd1', impid: '1', price: 9, dealid: 'PMP-QSR', adm: img('deal'), mtype: 1 },
      { id: 'd5', impid: '2', price: 7, dealid: 'PMP-QSR', adm: img('cheap-deal'), mtype: 1 }, // under the $8 deal floor
      { id: 'd3', impid: '3', price: 20, dealid: 'NOT-OFFERED', adm: img('unknown'), mtype: 1 },
    ] },
    { seat: 'other-seat', bid: [{ id: 'd2', impid: '2', price: 12, dealid: 'PMP-QSR', adm: img('wrong-seat'), mtype: 1 }] },
    { seat: 'open', bid: [{ id: 'o4', impid: '4', price: 5, adm: img('open'), mtype: 1 }] },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let server: Server;
let db: DatabaseSync;
let base: string;
let uploads: string;
let device: string;
let admin: string;
let sspId: string;
let dealId: string;

async function call(method: string, path: string, opts: { token?: string; device?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.device) headers.authorization = `Device ${opts.device}`;
  const r = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body };
}
const login = async (email: string) => (await call('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } })).body.token as string;
const rtbUrls = (pl: any) => pl.slots.filter((s: any) => s.campaignId?.startsWith('rtb:')).map((s: any) => s.url.split('/').pop()).sort();

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  db.prepare(`UPDATE campaigns SET status = 'paused'`).run();
  db.prepare(`UPDATE operators SET programmatic_override = 'allow'`).run();
  uploads = mkdtempSync(join(tmpdir(), 'ads-deals-'));
  const config: Config = { publicUrl: 'https://ads.example.com', uploadsDir: uploads, appSecret: 'test-app-secret', fetchImpl: fakeFetch };
  server = createApp(db, config);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ops = await login('ops@austin.test');
  const screenId = (await call('POST', '/api/screens', { token: ops, body: { venueId: 'ven_tacos', name: 'Patio', mode: 'idle', adSharePct: 50 } })).body.id;
  const reg = await call('POST', '/api/device/register');
  await call('POST', `/api/screens/${screenId}/pair`, { token: ops, body: { code: reg.body.pairingCode } });
  device = `${reg.body.deviceId}.${reg.body.deviceSecret}`;
  admin = await login('admin@platform.test');
  sspId = (await call('POST', '/api/admin/ssps', { token: admin, body: { name: 'SSP', endpointUrl: 'https://ssp.example/bid', floorCpmCents: 300 } })).body.id;
});
after(() => { server.close(); rmSync(uploads, { recursive: true, force: true }); });

describe('deal setup', () => {
  test('platform admin creates deals; input is validated', async () => {
    const base = { sspId, dealId: 'PMP-QSR', name: 'QSR network — Agency 1', buyer: 'Agency 1', floorCpmCents: 800, wseats: ['agency1'], venueTypes: ['entertainment.qsr'] };
    const r = await call('POST', '/api/admin/deals', { token: admin, body: base });
    assert.equal(r.status, 200);
    dealId = r.body.id;
    assert.deepEqual([r.body.wseats, r.body.venueTypes, r.body.privateAuction, r.body.enabled, r.body.auctionType], [['agency1'], ['entertainment.qsr'], false, true, 1]);
    assert.equal((await call('POST', '/api/admin/deals', { token: admin, body: base })).status, 409, 'deal IDs are unique per SSP');
    assert.equal((await call('POST', '/api/admin/deals', { token: admin, body: { ...base, dealId: 'X', auctionType: 2 } })).status, 400);
    assert.equal((await call('POST', '/api/admin/deals', { token: admin, body: { ...base, dealId: 'X', sspId: 'ssp_nope' } })).status, 400);
    assert.equal((await call('POST', '/api/admin/deals', { token: admin, body: { ...base, dealId: 'X', venueTypes: ['Bars!'] } })).status, 400);
    assert.equal((await call('POST', '/api/admin/deals', { token: admin, body: { ...base, dealId: 'X', startDate: '2026-02-01', endDate: '2026-01-01' } })).status, 400);
    assert.equal((await call('GET', '/api/admin/deals', { token: await login('ops@austin.test') })).status, 403);
    // A bars-only deal is not offered on a taco shop's screen
    await call('POST', '/api/admin/deals', { token: admin, body: { ...base, dealId: 'PMP-BARS', venueTypes: ['entertainment.bars'] } });
    // An expired deal is not offered either
    await call('POST', '/api/admin/deals', { token: admin, body: { ...base, dealId: 'PMP-OLD', venueTypes: null, endDate: '2020-01-31' } });
  });
});

describe('deal auctions', () => {
  test('matching deals ride on each imp; deal bids must meet the deal floor and seats', async () => {
    const pl = (await call('GET', '/api/device/playlist', { device })).body;
    const req = requests.at(-1);
    assert.deepEqual(req.imp[0].pmp, { private_auction: 0, deals: [{ id: 'PMP-QSR', bidfloor: 8, bidfloorcur: 'USD', at: 1, wseat: ['agency1'] }] });
    assert.deepEqual(rtbUrls(pl), ['deal.png', 'open.png'], 'wrong seat, under-floor and unknown-deal bids lose');
    const wins = db.prepare(`SELECT bid_id, deal_id FROM rtb_wins ORDER BY bid_id`).all() as any[];
    assert.deepEqual(wins.map((w) => [w.bid_id, w.deal_id]), [['d1', dealId], ['o4', null]]);
  });

  test('a private deal shuts out open-market bids', async () => {
    await call('PUT', `/api/admin/deals/${dealId}`, { token: admin, body: { privateAuction: true } });
    const pl = (await call('GET', '/api/device/playlist', { device })).body;
    assert.equal(requests.at(-1).imp[0].pmp.private_auction, 1);
    assert.deepEqual(rtbUrls(pl), ['deal.png']);
  });

  test('disabled deals are not offered', async () => {
    await call('DELETE', `/api/admin/deals/${dealId}`, { token: admin });
    await call('GET', '/api/device/playlist', { device });
    assert.equal(requests.at(-1).imp[0].pmp, undefined);
    await call('PUT', `/api/admin/deals/${dealId}`, { token: admin, body: { enabled: true } });
  });

  test('fixed-price deals accept bids at the deal price', () => {
    const deal = { deal_id: 'FIX', floor_cpm_cents: 1000, auction_type: 3, private_auction: 1, wseats: null };
    const request = { id: 'r', bcat: [], imp: [{ id: '1' }] };
    const bid = (price: number) => ({ ssp: { floor_cpm_cents: 300 }, deals: [deal], body: { id: 'r', seatbid: [{ seat: 's', bid: [{ id: 'b', impid: '1', price, dealid: 'FIX', adm: 'https://c.example/a.png' }] }] } });
    assert.equal(selectWinners([bid(10)], request).get('1')?.deal, deal);
    assert.equal(selectWinners([bid(9.99)], request).size, 0);
  });
});

describe('deal reporting', () => {
  test('verified deal plays show up as deal revenue', async () => {
    const win = db.prepare(`SELECT * FROM rtb_wins WHERE deal_id = ? ORDER BY created_at LIMIT 1`).get(dealId) as any;
    const r = await call('POST', '/api/device/pop', { device, body: { events: [
      { id: 'p1', creativeId: `rtb:${win.id}`, campaignId: `rtb:${win.id}`, playedAt: new Date().toISOString(), durationSec: win.duration_sec },
    ] } });
    assert.equal(r.body.accepted, 1);
    const deal = (await call('GET', '/api/admin/deals', { token: admin })).body.find((d: any) => d.id === dealId);
    assert.equal(deal.played, 1);
    assert.equal(deal.grossUsd, 0.027, '$9 CPM × 3 impressions');
  });

  test('deal forecast sizes the unsold inventory its targeting reaches', async () => {
    const f = (await call('GET', `/api/admin/deals/${dealId}/forecast?days=2`, { token: admin })).body;
    assert.equal(f.operators, 1);
    assert.deepEqual(f.byVenueType.map((r: any) => r.venueType), ['entertainment.qsr']);
    assert.equal(f.totals.soldSeconds, 0, 'all campaigns are paused');
    assert.ok(f.totals.availableImpressions > 0);
  });
});
