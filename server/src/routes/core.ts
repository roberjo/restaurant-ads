// Auth, public white-label endpoints, platform admin and operator settings.
import {
  actingOperatorId, createSession, deleteSession, newId, rateLimiter, requireRole, requireUser, verifyPassword, rowToUser,
} from '../auth.ts';
import { AD_CATEGORIES, VENUE_CATEGORIES, createUser, getSetting, nowIso, toApi } from '../db.ts';
import { HttpError } from '../http.ts';
import type { App } from '../app-types.ts';
import { email, int, num, optStr, str } from '../validate.ts';

const PUBLIC_OPERATOR_COLS = 'id, slug, name, brand_color, logo_url, default_cpm_cents, min_budget_cents';

export function registerCore({ db, router, config }: App): void {
  const loginLimit = rateLimiter(10, 60_000);
  const signupLimit = rateLimiter(5, 3600_000);

  router.post('/api/auth/login', (ctx) => {
    const addr = email(ctx.body.email);
    loginLimit(`${ctx.req.socket.remoteAddress}:${addr}`);
    const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(addr) as any;
    if (!row || !verifyPassword(String(ctx.body.password ?? ''), row.password_hash)) throw new HttpError(401, 'invalid email or password');
    return { token: createSession(db, row.id), user: rowToUser(row) };
  });

  router.post('/api/auth/logout', (ctx) => {
    const token = (ctx.req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token) deleteSession(db, token);
    return { ok: true };
  });

  router.get('/api/me', (ctx) => {
    const user = requireUser(ctx);
    const operator = user.operatorId ? toApi(db.prepare(`SELECT * FROM operators WHERE id = ?`).get(user.operatorId)) : null;
    return {
      user,
      operator,
      stripeEnabled: !!config.stripeSecretKey,
      adCategories: AD_CATEGORIES,
      venueCategories: VENUE_CATEGORIES,
    };
  });

  // White-label advertiser signup: /console/#/signup/<slug>
  router.get('/api/public/operators/:slug', (ctx) => {
    const op = db.prepare(`SELECT ${PUBLIC_OPERATOR_COLS} FROM operators WHERE slug = ?`).get(ctx.params.slug);
    if (!op) throw new HttpError(404, 'operator not found');
    return toApi(op);
  });

  router.post('/api/public/operators/:slug/advertisers', (ctx) => {
    signupLimit(String(ctx.req.socket.remoteAddress));
    const op = db.prepare(`SELECT id FROM operators WHERE slug = ?`).get(ctx.params.slug) as any;
    if (!op) throw new HttpError(404, 'operator not found');
    const addr = email(ctx.body.email);
    const password = str(ctx.body.password, 'password', 8, 200);
    if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(addr)) throw new HttpError(409, 'email already registered');
    const advertiserId = newId('adv');
    db.prepare(`INSERT INTO advertisers VALUES (?, ?, ?, ?, ?)`)
      .run(advertiserId, op.id, str(ctx.body.businessName, 'businessName'), addr, nowIso());
    const userId = createUser(db, {
      email: addr, password, name: str(ctx.body.name, 'name'), role: 'advertiser', operatorId: op.id, advertiserId,
    });
    const user = rowToUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId));
    return { token: createSession(db, userId), user };
  });

  // ---- Platform admin ----
  router.get('/api/admin/operators', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return (db.prepare(`
      SELECT o.*,
        (SELECT COUNT(*) FROM venues v WHERE v.operator_id = o.id) AS venue_count,
        (SELECT COUNT(*) FROM screens s WHERE s.operator_id = o.id) AS screen_count
      FROM operators o ORDER BY o.created_at`).all()).map(toApi);
  });

  router.post('/api/admin/operators', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const slug = str(ctx.body.slug, 'slug', 2, 40).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, 'slug must be lowercase letters, numbers and dashes');
    if (db.prepare(`SELECT 1 FROM operators WHERE slug = ?`).get(slug)) throw new HttpError(409, 'slug taken');
    const adminEmail = email(ctx.body.adminEmail);
    if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(adminEmail)) throw new HttpError(409, 'admin email already registered');
    const id = newId('op');
    db.prepare(`INSERT INTO operators (id, slug, name, created_at) VALUES (?, ?, ?, ?)`).run(id, slug, str(ctx.body.name, 'name'), nowIso());
    createUser(db, {
      email: adminEmail, password: str(ctx.body.adminPassword, 'adminPassword', 8, 200),
      name: str(ctx.body.adminName, 'adminName'), role: 'operator_admin', operatorId: id,
    });
    return toApi(db.prepare(`SELECT * FROM operators WHERE id = ?`).get(id));
  });

  router.get('/api/admin/settings', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return { networkTakePct: Number(getSetting(db, 'network_take_pct')) };
  });

  router.put('/api/admin/settings', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const pct = num(ctx.body.networkTakePct, 'networkTakePct', 0, 100);
    db.prepare(`INSERT OR REPLACE INTO settings VALUES ('network_take_pct', ?)`).run(String(pct));
    return { networkTakePct: pct };
  });

  // ---- Audit log ----
  router.get('/api/audit', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const limit = Math.min(500, Number(ctx.url.searchParams.get('limit') ?? 200) || 200);
    const all = user.role === 'platform_admin' && !ctx.url.searchParams.get('operatorId');
    const rows = all
      ? db.prepare(`SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.operator_id = ? ORDER BY a.id DESC LIMIT ?`)
        .all(actingOperatorId(ctx, user), limit);
    return rows.map(toApi);
  });

  // ---- Operator settings (branding, rate card, network opt-in) ----
  router.get('/api/operator', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return toApi(db.prepare(`SELECT * FROM operators WHERE id = ?`).get(actingOperatorId(ctx, user)));
  });

  router.put('/api/operator', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const id = actingOperatorId(ctx, user);
    const cur = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(id) as any;
    if (!cur) throw new HttpError(404, 'operator not found');
    const b = ctx.body;
    const color = b.brandColor ?? cur.brand_color;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'brandColor must be #rrggbb');
    db.prepare(`UPDATE operators SET name = ?, brand_color = ?, logo_url = ?, default_cpm_cents = ?, min_budget_cents = ?, network_opt_in = ? WHERE id = ?`).run(
      b.name !== undefined ? str(b.name, 'name') : cur.name,
      color,
      b.logoUrl !== undefined ? optStr(b.logoUrl, 'logoUrl', 500) : cur.logo_url,
      b.defaultCpmCents !== undefined ? int(b.defaultCpmCents, 'defaultCpmCents', 100, 100_000) : cur.default_cpm_cents,
      b.minBudgetCents !== undefined ? int(b.minBudgetCents, 'minBudgetCents', 100, 10_000_000) : cur.min_budget_cents,
      b.networkOptIn !== undefined ? (b.networkOptIn ? 1 : 0) : cur.network_opt_in,
      id,
    );
    // platform_fee_pct is only changed by the platform admin
    if (user.role === 'platform_admin' && b.platformFeePct !== undefined) {
      db.prepare(`UPDATE operators SET platform_fee_pct = ? WHERE id = ?`).run(num(b.platformFeePct, 'platformFeePct', 0, 100), id);
    }
    return toApi(db.prepare(`SELECT * FROM operators WHERE id = ?`).get(id));
  });
}
