// Stripe Connect onboarding for operators and venues, payout runs, and payout history.
import { actingOperatorId, requireRole, type AppCtx, type User } from '../auth.ts';
import { toApi } from '../db.ts';
import { HttpError } from '../http.ts';
import { createPayoutRun, executePayouts } from '../payouts.ts';
import { createAccountLink, createExpressAccount, retrieveAccount } from '../stripe.ts';
import type { App } from '../app-types.ts';
import { date } from '../validate.ts';

export function registerPayouts({ db, router, config }: App): void {
  const key = () => {
    if (!config.stripeSecretKey) throw new HttpError(400, 'payouts are not configured (STRIPE_SECRET_KEY)');
    return config.stripeSecretKey;
  };

  function venueAccess(user: User, venueId: string): any {
    const v = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(venueId) as any;
    const ok = v && (user.role === 'platform_admin' ||
      (user.role === 'operator_admin' && v.operator_id === user.operatorId) ||
      (user.role === 'venue_manager' && v.id === user.venueId));
    if (!ok) throw new HttpError(404, 'venue not found');
    return v;
  }

  async function onboard(table: 'operators' | 'venues', row: any, email: string, returnPath: string) {
    let account = row.stripe_account_id as string | null;
    if (!account) {
      const a = await createExpressAccount(key(), email, { [table === 'operators' ? 'operator_id' : 'venue_id']: row.id }, config.fetchImpl);
      account = a.id as string;
      db.prepare(`UPDATE ${table} SET stripe_account_id = ? WHERE id = ?`).run(account, row.id);
    }
    const back = `${config.publicUrl}/console/${returnPath}`;
    const link = await createAccountLink(key(), account, back, back, config.fetchImpl);
    return { url: link.url as string, account };
  }

  async function status(accountId: string | null) {
    key();
    if (!accountId) return { connected: false, payoutsEnabled: false, detailsSubmitted: false };
    const a = await retrieveAccount(key(), accountId, config.fetchImpl);
    return { connected: true, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted };
  }

  router.post('/api/operator/stripe/onboard', async (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const op = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(actingOperatorId(ctx, user));
    return onboard('operators', op, user.email, '#/settings');
  });

  router.get('/api/operator/stripe/status', async (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const op = db.prepare(`SELECT stripe_account_id FROM operators WHERE id = ?`).get(actingOperatorId(ctx, user)) as any;
    return status(op?.stripe_account_id ?? null);
  });

  router.post('/api/venues/:id/stripe/onboard', async (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = venueAccess(user, ctx.params.id);
    return onboard('venues', v, user.email, `#/venues/${v.id}`);
  });

  router.get('/api/venues/:id/stripe/status', async (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    return status(venueAccess(user, ctx.params.id).stripe_account_id);
  });

  router.post('/api/admin/payouts/run', async (ctx) => {
    requireRole(ctx, 'platform_admin');
    key();
    const periodEnd = date(ctx.body.periodEnd ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), 'periodEnd');
    if (periodEnd >= new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'periodEnd must be before today');
    const run = createPayoutRun(db, periodEnd);
    const result = await executePayouts(db, config, run.runId);
    return { runId: run.runId, created: run.payouts.length, ...result };
  });

  router.post('/api/admin/payouts/retry', async (ctx) => {
    requireRole(ctx, 'platform_admin');
    return executePayouts(db, config);
  });

  router.get('/api/payouts', (ctx: AppCtx) => {
    const user = requireRole(ctx, 'platform_admin', 'operator_admin', 'venue_manager');
    const base = `
      SELECT p.*, CASE p.recipient_type WHEN 'operator' THEN o.name ELSE v.name END AS recipient_name
      FROM payouts p LEFT JOIN operators o ON p.recipient_type = 'operator' AND o.id = p.recipient_id
      LEFT JOIN venues v ON p.recipient_type = 'venue' AND v.id = p.recipient_id`;
    let rows: any[];
    if (user.role === 'venue_manager') {
      rows = db.prepare(`${base} WHERE p.recipient_type = 'venue' AND p.recipient_id = ? ORDER BY p.created_at DESC LIMIT 200`).all(user.venueId);
    } else if (user.role === 'platform_admin' && !ctx.url.searchParams.get('operatorId')) {
      rows = db.prepare(`${base} ORDER BY p.created_at DESC LIMIT 500`).all();
    } else {
      rows = db.prepare(`${base} WHERE p.operator_id = ? ORDER BY p.created_at DESC LIMIT 500`).all(actingOperatorId(ctx, user));
    }
    return rows.map(toApi);
  });
}
