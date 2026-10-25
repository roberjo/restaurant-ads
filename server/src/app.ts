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
        if (req.method === 'GET' && staticDirs[top as keyof typeof staticDirs]) {
          return await serveStatic(res, staticDirs[top as keyof typeof staticDirs], decodeURIComponent(rest.join('/')));
        }
        throw new HttpError(404, 'not found');
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
