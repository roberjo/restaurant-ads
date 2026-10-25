import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { openDb, rowToCampaign, rowToVenue, seed } from './db.ts';
import { buildPlaylist } from './scheduler.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PORT = Number(process.env.PORT ?? 8787);
const ONLINE_WINDOW_MS = 5 * 60_000;

const db = openDb(process.env.DB_PATH ?? join(ROOT, 'data.sqlite'));
seed(db);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function serveStatic(res: ServerResponse, baseDir: string, relPath: string): Promise<void> {
  const safe = normalize(relPath || 'index.html').replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(baseDir, safe));
    res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function screenWithVenue(screenId: string) {
  const row = db
    .prepare(`SELECT v.* FROM screens s JOIN venues v ON v.id = s.venue_id WHERE s.id = ?`)
    .get(screenId);
  return row ? rowToVenue(row) : null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST',
    });
    return void res.end();
  }

  // GET /api/screens/:id/playlist
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'screens' && parts[3] === 'playlist') {
    const venue = screenWithVenue(parts[2]);
    if (!venue) return json(res, 404, { error: 'unknown screen' });
    const campaigns = db.prepare(`SELECT * FROM campaigns`).all().map(rowToCampaign);
    const now = new Date();
    const slots = buildPlaylist(venue, campaigns, now, {
      loopSec: Number(url.searchParams.get('loopSec') ?? 120),
      adSharePct: Number(url.searchParams.get('adSharePct') ?? 50),
    });
    return json(res, 200, { screenId: parts[2], venueId: venue.id, generatedAt: now.toISOString(), ttlSec: 300, slots });
  }

  // POST /api/screens/:id/heartbeat
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'screens' && parts[3] === 'heartbeat') {
    const body = await readJson(req);
    const r = db
      .prepare(`UPDATE screens SET last_heartbeat_at = ?, last_status = ? WHERE id = ?`)
      .run(new Date().toISOString(), JSON.stringify(body), parts[2]);
    return json(res, r.changes ? 200 : 404, { ok: r.changes > 0 });
  }

  // GET /api/screens — fleet status
  if (req.method === 'GET' && url.pathname === '/api/screens') {
    const rows = db.prepare(`SELECT * FROM screens`).all() as any[];
    return json(res, 200, rows.map((s) => ({
      ...s,
      last_status: s.last_status ? JSON.parse(s.last_status) : null,
      online: !!s.last_heartbeat_at && Date.now() - Date.parse(s.last_heartbeat_at) < ONLINE_WINDOW_MS,
    })));
  }

  // POST /api/pop  { events: [{ id, screenId, creativeId, campaignId, playedAt, durationSec }] }
  if (req.method === 'POST' && url.pathname === '/api/pop') {
    const { events = [] } = await readJson(req);
    const insert = db.prepare(`INSERT OR IGNORE INTO pop_events VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const receivedAt = new Date().toISOString();
    let accepted = 0;
    for (const e of events) {
      if (!e.id || !e.screenId || !e.creativeId || !e.playedAt) continue;
      accepted += Number(insert.run(e.id, e.screenId, e.creativeId, e.campaignId ?? null, e.playedAt, Number(e.durationSec) || 0, receivedAt).changes);
    }
    return json(res, 200, { accepted });
  }

  // GET /api/reports/campaigns — plays, estimated impressions and spend
  if (req.method === 'GET' && url.pathname === '/api/reports/campaigns') {
    const rows = db.prepare(`
      SELECT c.id, c.advertiser, c.tier, c.cpm_usd,
             COUNT(p.id) AS plays,
             COALESCE(SUM(v.audience_multiplier), 0) AS est_impressions
      FROM campaigns c
      LEFT JOIN pop_events p ON p.campaign_id = c.id
      LEFT JOIN screens s ON s.id = p.screen_id
      LEFT JOIN venues v ON v.id = s.venue_id
      GROUP BY c.id ORDER BY c.id
    `).all() as any[];
    return json(res, 200, rows.map((r) => ({ ...r, est_spend_usd: +((r.est_impressions / 1000) * r.cpm_usd).toFixed(2) })));
  }

  if (req.method === 'GET' && parts[0] === 'creatives') return serveStatic(res, join(ROOT, 'creatives'), parts.slice(1).join('/'));
  if (req.method === 'GET' && parts[0] === 'player') return serveStatic(res, join(ROOT, 'player'), parts.slice(1).join('/'));
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { location: '/player/?screen=s-tacos-counter' });
    return void res.end();
  }

  json(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  });
}).listen(PORT, () => {
  console.log(`Ad server on http://localhost:${PORT}  (player: /player/?screen=s-tacos-counter)`);
});
