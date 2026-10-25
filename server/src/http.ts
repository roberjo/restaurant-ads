// Minimal router, body parsing and static file serving on top of node:http.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  rawBody: string;
  body: any;
}

type Handler<C extends Ctx> = (ctx: C) => unknown | Promise<unknown>;

interface Route<C extends Ctx> {
  method: string;
  parts: string[];
  handler: Handler<C>;
}

export class Router<C extends Ctx> {
  routes: Route<C>[] = [];

  add(method: string, pattern: string, handler: Handler<C>): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }
  get(p: string, h: Handler<C>) { this.add('GET', p, h); }
  post(p: string, h: Handler<C>) { this.add('POST', p, h); }
  put(p: string, h: Handler<C>) { this.add('PUT', p, h); }
  delete(p: string, h: Handler<C>) { this.add('DELETE', p, h); }

  match(method: string, pathname: string): { handler: Handler<C>; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (r.parts[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
};

export async function serveStatic(res: ServerResponse, baseDir: string, relPath: string, headers: Record<string, string> = {}): Promise<void> {
  const base = resolve(baseDir);
  const file = resolve(base, relPath || 'index.html');
  if (file !== base && !file.startsWith(base + sep)) return sendJson(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}
