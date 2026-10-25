// POS integrations (Square): connect via OAuth, sync menus on demand, by webhook, and periodically.
import { requireRole, type User } from '../auth.ts';
import { HttpError } from '../http.ts';
import { encrypt, signState, verifyState } from '../crypto.ts';
import { authorizeUrl, exchangeToken, squareConfigured, syncSquareVenue, verifySquareWebhook } from '../square.ts';
import type { App } from '../app-types.ts';

export function registerIntegrations({ db, router, config }: App): void {
  function venueAccess(user: User, venueId: string): any {
    const v = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(venueId) as any;
    const ok = v && (user.role === 'platform_admin' ||
      (user.role === 'operator_admin' && v.operator_id === user.operatorId) ||
      (user.role === 'venue_manager' && v.id === user.venueId));
    if (!ok) throw new HttpError(404, 'venue not found');
    return v;
  }
  const requireSquare = () => {
    if (!squareConfigured(config)) throw new HttpError(400, 'Square is not configured on this server (SQUARE_APP_ID, SQUARE_APP_SECRET, APP_SECRET)');
  };

  router.get('/api/venues/:id/square', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueAccess(user, ctx.params.id);
    const i = db.prepare(`SELECT merchant_id, last_sync_at, last_error, created_at FROM integrations WHERE venue_id = ? AND provider = 'square'`).get(v.id) as any;
    return { configured: squareConfigured(config), connected: !!i, merchantId: i?.merchant_id ?? null, lastSyncAt: i?.last_sync_at ?? null, lastError: i?.last_error ?? null };
  });

  router.post('/api/venues/:id/square/connect', (ctx) => {
    requireSquare();
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueAccess(user, ctx.params.id);
    return { url: authorizeUrl(config, signState(config.appSecret!, { venueId: v.id, userId: user.id })) };
  });

  // Square redirects the browser here; the signed state ties the callback to the venue and user that started it.
  router.get('/api/square/callback', async (ctx) => {
    const redirect = (venueId: string | null, result: string) => {
      ctx.res.writeHead(302, { location: `/console/#/venues/${encodeURIComponent(venueId ?? '')}/menu?square=${encodeURIComponent(result)}` });
      ctx.res.end();
    };
    requireSquare();
    const state = verifyState(config.appSecret!, ctx.url.searchParams.get('state') ?? '');
    if (!state?.venueId) throw new HttpError(400, 'invalid or expired state');
    const code = ctx.url.searchParams.get('code');
    if (!code) return redirect(state.venueId, 'denied');
    const t = await exchangeToken(config, { code });
    db.prepare(`
      INSERT INTO integrations (venue_id, provider, merchant_id, access_token_enc, refresh_token_enc, expires_at, created_at)
      VALUES (?, 'square', ?, ?, ?, ?, ?)
      ON CONFLICT (venue_id, provider) DO UPDATE SET merchant_id = excluded.merchant_id, access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at, last_error = NULL`)
      .run(state.venueId, t.merchantId, encrypt(config.appSecret!, t.accessToken), t.refreshToken ? encrypt(config.appSecret!, t.refreshToken) : null,
        t.expiresAt, new Date().toISOString());
    try {
      await syncSquareVenue(db, config, state.venueId);
      redirect(state.venueId, 'connected');
    } catch {
      redirect(state.venueId, 'sync_failed');
    }
  });

  router.post('/api/venues/:id/square/sync', async (ctx) => {
    requireSquare();
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueAccess(user, ctx.params.id);
    try {
      return await syncSquareVenue(db, config, v.id);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  });

  router.delete('/api/venues/:id/square', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueAccess(user, ctx.params.id);
    db.prepare(`DELETE FROM integrations WHERE venue_id = ? AND provider = 'square'`).run(v.id);
    return { ok: true };
  });

  router.post('/api/square/webhook', async (ctx) => {
    if (!config.squareWebhookSignatureKey || !config.squareWebhookUrl) throw new HttpError(404, 'not found');
    if (!verifySquareWebhook(ctx.rawBody, ctx.req.headers['x-square-hmacsha256-signature'] as string | undefined,
      config.squareWebhookSignatureKey, config.squareWebhookUrl)) {
      throw new HttpError(400, 'invalid signature');
    }
    const event = ctx.body;
    if (event?.type === 'catalog.version.updated' && event.merchant_id) {
      const venues = db.prepare(`SELECT venue_id FROM integrations WHERE provider = 'square' AND merchant_id = ?`).all(event.merchant_id) as any[];
      // Acknowledge quickly; sync in the background.
      setImmediate(() => {
        for (const r of venues) syncSquareVenue(db, config, r.venue_id).catch((e) => console.error(`[square] webhook sync: ${e.message}`));
      });
    }
    return { received: true };
  });
}
