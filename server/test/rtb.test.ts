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
import { createPayoutRun } from '../src/payouts.ts';
import { clearQualityCache, flushNotices, isPublicAddress, parseCreative } from '../src/rtb.ts';

// ---- Fake SSPs and tracking endpoints ----
interface Call { url: string; headers: Record<string, string>; body: any }
const calls: Call[] = [];
const VAST = `<VAST version="4.0"><Ad id="a1"><InLine><Impression><![CDATA[https://track.ssp-a.example/imp?p=\${AUCTION_PRICE}]]></Impression>
  <Creatives><Creative><Linear><Duration>00:00:15</Duration><MediaFiles>
  <MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080"><![CDATA[https://cdn.ssp-a.example/spot.mp4]]></MediaFile>
  </MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`;

const fakeFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, headers, body });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://ssp-a.example/bid') {
    return json({ id: body.id, cur: 'USD', seatbid: [{ seat: 'dsp1', bid: [
      { id: 'b1', impid: '1', price: 6, adm: VAST, mtype: 2, crid: 'cr1', adomain: ['brand.example'],
        nurl: 'https://win.ssp-a.example/n?price=${AUCTION_PRICE}&imp=${AUCTION_IMP_ID}', burl: 'https://bill.ssp-a.example/b?price=${AUCTION_PRICE}' },
      { id: 'b2', impid: '2', price: 2, adm: '<img src="https://cdn.ssp-a.example/cheap.png">', mtype: 1 }, // below A's $3 floor
    ] }] });
  }
  if (url === 'https://ssp-b.example/openrtb') {
    return json({ id: body.id, seatbid: [{ seat: 'dsp2', bid: [
      { id: 'c1', impid: '1', price: 5, adm: '<img src="https://cdn.ssp-b.example/loses.png">', mtype: 1 }, // outbid by A
      { id: 'c3', impid: '3', price: 9, adm: '<img src="https://cdn.ssp-b.example/beer.png">', mtype: 1, cat: ['IAB8-5'] }, // blocked
      { id: 'c4', impid: '4', price: 4, adm: '<img src="https://cdn.ssp-b.example/shoes.png">', mtype: 1, burl: 'https://bill.ssp-b.example/b' },
    ] }] });
  }
  if (url === 'https://ssp-down.example/bid') return json({ error: 'boom' }, 500);
  return new Response('', { status: 200 });
}) as typeof fetch;

let server: Server;
let db: DatabaseSync;
let base: string;
let uploads: string;
let config: Config;
let device: string;
let screenId: string;

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

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  db.prepare(`UPDATE campaigns SET status = 'paused'`).run(); // leave all ad time to programmatic
  db.prepare(`UPDATE operators SET programmatic_override = 'allow'`).run();
  uploads = mkdtempSync(join(tmpdir(), 'ads-rtb-'));
  config = {
    publicUrl: 'https://ads.example.com', uploadsDir: uploads, appSecret: 'test-app-secret', fetchImpl: fakeFetch,
    resolveHost: async (host) => (host.endsWith('.internal-ssp.example') ? ['10.0.0.7'] : ['93.184.216.34']),
  };
  server = createApp(db, config);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ops = await login('ops@austin.test');
  screenId = (await call('POST', '/api/screens', { token: ops, body: { venueId: 'ven_tacos', name: 'Patio', mode: 'idle', adSharePct: 50 } })).body.id;
  const reg = await call('POST', '/api/device/register');
  await call('POST', `/api/screens/${screenId}/pair`, { token: ops, body: { code: reg.body.pairingCode } });
  device = `${reg.body.deviceId}.${reg.body.deviceSecret}`;
});
after(() => { server.close(); rmSync(uploads, { recursive: true, force: true }); });

describe('SSP setup', () => {
  test('platform admin adds SSPs; credentials are encrypted and never returned', async () => {
    const admin = await login('admin@platform.test');
    assert.equal((await call('POST', '/api/admin/ssps', { token: admin, body: { name: 'Bad', endpointUrl: 'http://ssp.example/bid' } })).status, 400);
    const a = await call('POST', '/api/admin/ssps', { token: admin, body: { name: 'SSP A', endpointUrl: 'https://ssp-a.example/bid', authHeader: 'Bearer secret-a', floorCpmCents: 300 } });
    assert.equal(a.status, 200);
    assert.equal(a.body.hasAuth, true);
    assert.equal(a.body.authHeaderEnc, undefined);
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ssps`).all()).includes('secret-a'));
    await call('POST', '/api/admin/ssps', { token: admin, body: { name: 'SSP B', endpointUrl: 'https://ssp-b.example/openrtb', floorCpmCents: 250 } });
    await call('POST', '/api/admin/ssps', { token: admin, body: { name: 'Down', endpointUrl: 'https://ssp-down.example/bid' } });
    assert.equal((await call('GET', '/api/admin/ssps', { token: await login('ops@austin.test') })).status, 403);
  });
});

describe('auction', () => {
  test('leftover ad time is auctioned; best valid bid per imp wins and plays once', async () => {
    const pl = (await call('GET', '/api/device/playlist', { device })).body;
    const reqs = calls.filter((c) => c.body?.imp);
    assert.equal(reqs.length, 3);
    const a = reqs.find((c) => c.url.includes('ssp-a'))!;
    assert.equal(a.headers.authorization, 'Bearer secret-a');
    assert.equal(a.body.imp.length, 4, '60 s of ad time / 15 s slots');
    assert.equal(a.body.imp[0].bidfloor, 3);
    assert.equal(reqs.find((c) => c.url.includes('ssp-b'))!.body.imp[0].bidfloor, 2.5);
    assert.equal(a.body.imp[0].qty.multiplier, 3);
    assert.deepEqual(a.body.dooh.venuetype, ['entertainment.qsr']);
    assert.equal(a.body.device.devicetype, 8);
    assert.ok(a.body.bcat.includes('IAB8-5'), 'tacos blocks alcohol');
    assert.deepEqual([a.body.device.geo.lat, a.body.device.geo.lon], [30.2496, -97.7495]);

    const rtb = pl.slots.filter((s: any) => s.campaignId?.startsWith('rtb:'));
    assert.equal(rtb.length, 2);
    assert.ok(rtb.every((s: any) => s.once));
    assert.deepEqual(rtb.map((s: any) => s.url).sort(), ['https://cdn.ssp-a.example/spot.mp4', 'https://cdn.ssp-b.example/shoes.png']);
    const auc = db.prepare(`SELECT * FROM rtb_auctions`).get() as any;
    assert.deepEqual([auc.imps, auc.bids, auc.wins, auc.errors], [4, 5, 2, 1]);
    const nurl = db.prepare(`SELECT url FROM rtb_notices WHERE kind = 'nurl'`).all() as any[];
    assert.deepEqual(nurl.map((n) => n.url), ['https://win.ssp-a.example/n?price=6&imp=1']);
  });

  test('proof-of-play bills each win once at its price, split with the network take', async () => {
    const wins = db.prepare(`SELECT * FROM rtb_wins ORDER BY price_cpm_micros DESC`).all() as any[];
    const ev = (w: any, id: string, durationSec = w.duration_sec) =>
      ({ id, creativeId: `rtb:${w.id}`, campaignId: `rtb:${w.id}`, playedAt: new Date().toISOString(), durationSec });
    let r = await call('POST', '/api/device/pop', { device, body: { events: [ev(wins[0], 'p1'), ev(wins[1], 'p2'), ev(wins[1], 'p3')] } });
    assert.deepEqual(r.body, { accepted: 2, rejected: 0, duplicates: 1 }, 'a second play of the same win is not billed');
    r = await call('POST', '/api/device/pop', { device, body: { events: [{ ...ev(wins[0], 'p4'), creativeId: 'rtb:win_forged', campaignId: 'rtb:win_forged' }] } });
    assert.equal(r.body.rejected, 1);

    const p = db.prepare(`SELECT * FROM pop_events WHERE rtb_win_id = ?`).get(wins[0].id) as any;
    // $6 CPM × 3 impressions / 1000 = $0.018; 20% network take; venue gets 20% of the rest
    assert.deepEqual([p.gross_micros, p.platform_micros, p.venue_micros, p.operator_micros], [18_000, 3_600, 2_880, 11_520]);
    assert.equal(p.campaign_id, null);
    const kinds = (db.prepare(`SELECT kind FROM rtb_notices ORDER BY kind`).all() as any[]).map((n) => n.kind);
    assert.deepEqual(kinds, ['burl', 'burl', 'impression', 'nurl']);
    assert.ok((db.prepare(`SELECT url FROM rtb_notices WHERE kind = 'burl' AND win_id = ?`).get(wins[0].id) as any).url.endsWith('price=6'));
  });

  test('notices are delivered, and private addresses are refused', async () => {
    db.prepare(`INSERT INTO rtb_notices (id, win_id, kind, url, created_at) VALUES ('n_evil', 'x', 'burl', 'https://admin.internal-ssp.example/hook', ?)`).run(new Date().toISOString());
    const r = await flushNotices(db, config);
    assert.deepEqual(r, { sent: 4, failed: 1 });
    assert.equal((db.prepare(`SELECT status FROM rtb_notices WHERE id = 'n_evil'`).get() as any).status, 'failed');
    assert.ok(calls.some((c) => c.url === 'https://track.ssp-a.example/imp?p=6'));
    assert.ok(!calls.some((c) => c.url.includes('internal-ssp')));
    assert.equal(isPublicAddress('192.168.1.5'), false);
    assert.equal(isPublicAddress('::1'), false);
    assert.equal(isPublicAddress('8.8.8.8'), true);
  });

  test('no auction while the venue is closed', async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM rtb_auctions`).get() as any).n;
    db.prepare(`UPDATE venues SET open_hours = '{}' WHERE id = 'ven_tacos'`).run();
    const pl = (await call('GET', '/api/device/playlist', { device })).body;
    assert.ok(!pl.slots.some((s: any) => s.campaignId?.startsWith('rtb:')));
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM rtb_auctions`).get() as any).n, before);
    db.prepare(`UPDATE venues SET open_hours = NULL WHERE id = 'ven_tacos'`).run();
  });

  test('operators paused by the platform get no programmatic demand', async () => {
    db.prepare(`UPDATE operators SET programmatic_override = 'deny'`).run();
    clearQualityCache();
    const pl = (await call('GET', '/api/device/playlist', { device })).body;
    assert.ok(!pl.slots.some((s: any) => s.campaignId?.startsWith('rtb:')));
    db.prepare(`UPDATE operators SET programmatic_override = 'allow'`).run();
    clearQualityCache();
  });
});

describe('reporting and payouts', () => {
  test('programmatic revenue appears in reports and admin stats', async () => {
    const ops = await login('ops@austin.test');
    const rep = (await call('GET', '/api/reports/operator', { token: ops })).body;
    assert.equal(rep.programmatic.plays, 2);
    assert.equal(rep.programmatic.gross, 0.03, '$0.018 + $0.012');
    const stmt = (await call('GET', '/api/reports/venue/ven_tacos', { token: ops })).body;
    assert.equal(stmt.byAdvertiser[0].name, 'Programmatic (national)');
    const admin = await login('admin@platform.test');
    const stats = (await call('GET', '/api/admin/rtb', { token: admin })).body;
    assert.equal(stats.fillRatePct, 50);
    assert.equal(stats.bySsp.find((s: any) => s.name === 'SSP A').played, 1);
  });

  test('programmatic earnings are paid out only once the SSPs have paid', async () => {
    const admin = await login('admin@platform.test');
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.prepare(`UPDATE pop_events SET played_at = ? WHERE rtb_win_id IS NOT NULL`).run(twoDaysAgo);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const rtbLinked = () => (db.prepare(`SELECT COUNT(*) AS n FROM pop_events WHERE rtb_win_id IS NOT NULL AND operator_payout_id IS NOT NULL`).get() as any).n;

    createPayoutRun(db, yesterday);
    assert.equal(rtbLinked(), 0, 'not settled yet');
    assert.equal((await call('PUT', '/api/admin/rtb/settled', { token: admin, body: { settledThrough: new Date().toISOString().slice(0, 10) } })).status, 400);
    await call('PUT', '/api/admin/rtb/settled', { token: admin, body: { settledThrough: yesterday } });
    const run = createPayoutRun(db, yesterday);
    assert.equal(rtbLinked(), 2);
    const op = run.payouts.find((p: any) => p.recipient_type === 'operator');
    assert.equal(op.earned_micros, 11_520 + 7_680);
  });
});

describe('creative parsing', () => {
  test('accepts VAST mp4, VAST static images, img tags and bare URLs; rejects http and scripts', () => {
    assert.equal(parseCreative(VAST)?.type, 'video');
    assert.equal(parseCreative(VAST)?.durationSec, 15);
    const staticVast = '<VAST><Ad><InLine><Creatives><Creative><NonLinearAds><NonLinear><StaticResource creativeType="image/png"><![CDATA[https://c.example/a.png]]></StaticResource></NonLinear></NonLinearAds></Creative></Creatives></InLine></Ad></VAST>';
    assert.deepEqual(parseCreative(staticVast), { url: 'https://c.example/a.png', type: 'image', durationSec: 10, impressions: [] });
    assert.equal(parseCreative('https://c.example/x.jpg')?.url, 'https://c.example/x.jpg');
    assert.equal(parseCreative('<img src="http://c.example/x.png">'), null);
    assert.equal(parseCreative('<script src="https://c.example/x.js"></script>'), null);
    assert.equal(parseCreative('https://c.example/x.png', 2), null, 'video bids must be VAST');
  });
});
