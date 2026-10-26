// Pooled network readiness: operator quality scores, programmatic gating and inventory forecasts.
import { actingOperatorId, requireRole } from '../auth.ts';
import { forecastInventory } from '../forecast.ts';
import { HttpError } from '../http.ts';
import { DEFAULT_VENUE_TYPES, operatorQuality } from '../quality.ts';
import type { App } from '../app-types.ts';
import { int } from '../validate.ts';

export function registerProgrammatic({ db, router }: App): void {
  router.get('/api/quality', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    return operatorQuality(db, actingOperatorId(ctx, user));
  });

  router.get('/api/admin/quality', (ctx) => {
    requireRole(ctx, 'platform_admin');
    return (db.prepare(`SELECT id, name, network_opt_in FROM operators ORDER BY name`).all() as any[])
      .map((o) => ({ operatorId: o.id, name: o.name, networkOptIn: !!o.network_opt_in, ...operatorQuality(db, o.id) }));
  });

  router.put('/api/admin/operators/:id/programmatic', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const override = ctx.body.override ?? null;
    if (![null, 'allow', 'deny'].includes(override)) throw new HttpError(400, 'override must be "allow", "deny" or null');
    const r = db.prepare(`UPDATE operators SET programmatic_override = ? WHERE id = ?`).run(override, ctx.params.id);
    if (!r.changes) throw new HttpError(404, 'operator not found');
    return operatorQuality(db, ctx.params.id);
  });

  // Operators see their own capacity; the platform admin (without ?operatorId) sees the pooled network:
  // operators that opted into network demand and are eligible for programmatic.
  router.get('/api/forecast', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const days = int(ctx.url.searchParams.get('days') ?? 7, 'days', 1, 30);
    if (user.role === 'platform_admin' && !ctx.url.searchParams.get('operatorId')) {
      const ops = (db.prepare(`SELECT id FROM operators WHERE network_opt_in = 1`).all() as any[])
        .map((o) => o.id as string).filter((id) => operatorQuality(db, id).eligible);
      return { scope: 'network', operators: ops.length, ...forecastInventory(db, ops, days) };
    }
    return { scope: 'operator', ...forecastInventory(db, [actingOperatorId(ctx, user)], days) };
  });

  router.get('/api/venue-types', (ctx) => {
    requireRole(ctx, 'operator_admin', 'platform_admin');
    return { defaults: DEFAULT_VENUE_TYPES, taxonomy: 'OpenOOH venue taxonomy' };
  });
}
