// Password hashing, user sessions and device credentials.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, type Ctx } from './http.ts';

export type Role = 'platform_admin' | 'operator_admin' | 'venue_manager' | 'advertiser';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  operatorId: string | null;
  venueId: string | null;
  advertiserId: string | null;
}

export interface Device {
  id: string;
  screenId: string | null;
  operatorId: string | null;
}

export interface AppCtx extends Ctx {
  user: User | null;
}

const SESSION_TTL_MS = 30 * 24 * 3600_000;

export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function rowToUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    operatorId: r.operator_id,
    venueId: r.venue_id,
    advertiserId: r.advertiser_id,
  };
}

export function createSession(db: DatabaseSync, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(sha256(token), userId, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return token;
}

export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
}

function bearer(ctx: Ctx, scheme: string): string | null {
  const h = ctx.req.headers.authorization ?? '';
  return h.startsWith(scheme + ' ') ? h.slice(scheme.length + 1).trim() : null;
}

export function userFromRequest(db: DatabaseSync, ctx: Ctx): User | null {
  const token = bearer(ctx, 'Bearer');
  if (!token) return null;
  const r = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), new Date().toISOString());
  return r ? rowToUser(r) : null;
}

/** Devices authenticate with `Authorization: Device <deviceId>.<secret>`. */
export function deviceFromRequest(db: DatabaseSync, ctx: Ctx): Device {
  const cred = bearer(ctx, 'Device');
  const dot = cred?.indexOf('.') ?? -1;
  if (!cred || dot < 1) throw new HttpError(401, 'device credentials required');
  const id = cred.slice(0, dot);
  const r = db.prepare(`SELECT id, secret_hash, screen_id, operator_id FROM devices WHERE id = ?`).get(id) as any;
  const given = Buffer.from(sha256(cred.slice(dot + 1)));
  if (!r || !timingSafeEqual(Buffer.from(r.secret_hash), given)) throw new HttpError(401, 'invalid device credentials');
  return { id: r.id, screenId: r.screen_id, operatorId: r.operator_id };
}

export function requireUser(ctx: AppCtx): User {
  if (!ctx.user) throw new HttpError(401, 'login required');
  return ctx.user;
}

export function requireRole(ctx: AppCtx, ...roles: Role[]): User {
  const u = requireUser(ctx);
  if (!roles.includes(u.role)) throw new HttpError(403, 'forbidden');
  return u;
}

/**
 * The operator a request acts on. Operator-scoped users always act on their own operator;
 * platform admins choose one with ?operatorId= (or body.operatorId).
 */
export function actingOperatorId(ctx: AppCtx, user: User): string {
  if (user.role !== 'platform_admin') {
    if (!user.operatorId) throw new HttpError(403, 'no operator');
    return user.operatorId;
  }
  const id = ctx.url.searchParams.get('operatorId') ?? ctx.body?.operatorId;
  if (!id) throw new HttpError(400, 'operatorId required for platform admin');
  return id;
}

/** Simple fixed-window limiter for login and registration endpoints. */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return;
    }
    if (++h.n > max) throw new HttpError(429, 'too many requests, try again later');
  };
}
