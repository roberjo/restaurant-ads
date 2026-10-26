// Operator SaaS billing endpoints (operator self-serve and platform admin).
import { actingOperatorId, requireRole } from '../auth.ts';
import { billingSettings, billingSummary, portalSession, startCheckout } from '../billing.ts';
import { HttpError } from '../http.ts';
import type { App } from '../app-types.ts';
import { date } from '../validate.ts';

export function registerBilling({ db, router, config }: App): void {
  const operator = (id: string) => {
    const op = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(id) as any;
    if (!op) throw new HttpError(404, 'operator not found');
    return op;
  };

  router.get('/api/operator/billing', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return billingSummary(db, config, operator(actingOperatorId(ctx, user)));
  });

  router.post('/api/operator/billing/checkout', async (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return startCheckout(db, config, operator(actingOperatorId(ctx, user)), user.email);
  });

  router.post('/api/operator/billing/portal', async (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return portalSession(config, operator(actingOperatorId(ctx, user)));
  });

  router.get('/api/admin/billing', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const ops = (db.prepare(`SELECT * FROM operators ORDER BY name`).all() as any[]).map((op) => ({
      operatorId: op.id, name: op.name, ...billingSummary(db, config, op),
    }));
    const paying = ops.filter((o) => o.state === 'active' || o.state === 'past_due');
    return {
      settings: billingSettings(db),
      operators: ops,
      totals: {
        mrrCents: paying.reduce((s, o) => s + o.unitPriceCents * o.billedScreens, 0),
        payingOperators: paying.length,
        trialing: ops.filter((o) => o.state === 'trialing').length,
        billedScreens: paying.reduce((s, o) => s + o.billedScreens, 0),
      },
    };
  });

  // Comp an operator (e.g. a design partner) until a date; null removes the comp.
  router.put('/api/admin/operators/:id/billing', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const op = operator(ctx.params.id);
    const freeUntil = ctx.body.freeUntil ? date(ctx.body.freeUntil, 'freeUntil') : null;
    db.prepare(`UPDATE operators SET free_until = ? WHERE id = ?`).run(freeUntil, op.id);
    return billingSummary(db, config, operator(op.id));
  });
}
