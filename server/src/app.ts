import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { userFromRequest, type AppCtx } from './auth.ts';
import { HttpError, Router, readBody, sendJson, serveStatic } from './http.ts';
import type { App, Config } from './app-types.ts';
import { registerCore } from './routes/core.ts';
import { registerNetwork } from './routes/network.ts';
import { registerCampaigns } from './routes/campaigns.ts';
import { registerDevice } from './routes/device.ts';
import { registerReports } from './routes/reports.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
const MAX_BODY_BYTES = 30 * 1024 * 1024; // base64 creative uploads

const STATIC: Record<string, string> = {
  console: join(ROOT, 'console'),
  player: join(ROOT, 'player'),
  creatives: join(ROOT, 'creatives'),
};

const BASE_HEADERS = { 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const OSM = 'https://tile.openstreetmap.org https://*.tile.openstreetmap.org';
// Per-area Content-Security-Policy. User uploads are sandboxed so a crafted file can never run script.
const STATIC_HEADERS: Record<string, Record<string, string>> = {
  console: {
    ...BASE_HEADERS,
    'content-security-policy': `default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://unpkg.com ${OSM}; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  },
  // The player may talk to a server on another origin (?api=), so connect/img/media are open.
  player: {
    ...BASE_HEADERS,
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * blob:; connect-src *; frame-ancestors 'none'; base-uri 'none'`,
  },
  creatives: { ...BASE_HEADERS, 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; sandbox`, 'cache-control': 'public, max-age=3600' },
  uploads: { ...BASE_HEADERS, 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; sandbox`, 'cache-control': 'public, max-age=31536000, immutable' },
};

const startedAt = new Date().toISOString();
const VERSION = process.env.APP_VERSION ?? 'dev';

export function createApp(db: DatabaseSync, config: Config): Server {
  const router = new Router<AppCtx>();
  const app: App = { db, config, router };
  registerCore(app);
  registerNetwork(app);
  registerCampaigns(app);
  registerDevice(app);
  registerReports(app);
  const staticDirs = { ...STATIC, uploads: config.uploadsDir };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isApi = url.pathname.startsWith('/api/');
    // Players may run from packaged apps (Tizen/webOS/Android) on another origin.
    const cors: Record<string, string> = url.pathname.startsWith('/api/device/')
      ? { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' }
      : {};
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return void res.end();
      }
      if (!isApi) {
        if (url.pathname === '/') {
          res.writeHead(302, { location: '/console/' });
          return void res.end();
        }
        const [, top, ...rest] = url.pathname.split('/');
        if ((req.method === 'GET' || req.method === 'HEAD') && staticDirs[top as keyof typeof staticDirs]) {
          let rel: string;
          try { rel = decodeURIComponent(rest.join('/')); } catch { throw new HttpError(400, 'bad path'); }
          return await serveStatic(res, staticDirs[top as keyof typeof staticDirs], rel, STATIC_HEADERS[top]);
        }
        throw new HttpError(404, 'not found');
      }

      Object.assign(cors, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      if (url.pathname === '/api/health') {
        db.prepare('SELECT 1').get();
        return sendJson(res, 200, { ok: true, version: VERSION, startedAt }, cors);
      }

      const m = router.match(req.method ?? 'GET', url.pathname);
      if (!m) throw new HttpError(404, 'not found');
      const rawBody = req.method === 'GET' ? '' : await readBody(req, MAX_BODY_BYTES);
      let body: any = {};
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, 'invalid JSON body'); }
      }
      const ctx: AppCtx = { req, res, url, params: m.params, rawBody, body: body ?? {}, user: null };
      ctx.user = userFromRequest(db, ctx);
      const result = await m.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true }, cors);
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, cors);
      console.error(err);
      sendJson(res, 500, { error: 'internal error' }, cors);
    }
  });
}
