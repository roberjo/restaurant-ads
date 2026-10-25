// Statements and earnings reports derived from proof-of-play ledger columns.
import { actingOperatorId, requireRole } from '../auth.ts';
import { HttpError } from '../http.ts';
import { microsToUsd } from '../ledger.ts';
import type { App } from '../app-types.ts';
import type { AppCtx } from '../auth.ts';

const MONEY = `COUNT(*) AS plays, COALESCE(SUM(p.impressions), 0) AS impressions,
  COALESCE(SUM(p.gross_micros), 0) AS gross, COALESCE(SUM(p.platform_micros), 0) AS platform,
  COALESCE(SUM(p.operator_micros), 0) AS operator, COALESCE(SUM(p.venue_micros), 0) AS venue`;

function money(r: any) {
  return {
    ...r,
    gross: microsToUsd(r.gross),
    platform: microsToUsd(r.platform),
    operator: microsToUsd(r.operator),
    venue: microsToUsd(r.venue),
  };
}

function range(ctx: AppCtx): { from: string; to: string; toExclusive: string } {
  const today = new Date().toISOString().slice(0, 10);
  const from = ctx.url.searchParams.get('from') ?? `${today.slice(0, 8)}01`;
  const to = ctx.url.searchParams.get('to') ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
  const toExclusive = new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10);
  return { from, to, toExclusive };
}

export function registerReports({ db, router }: App): void {
  router.get('/api/reports/operator', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin');
    const operatorId = actingOperatorId(ctx, user);
    const { from, to, toExclusive } = range(ctx);
    const where = `p.operator_id = ? AND p.played_at >= ? AND p.played_at < ? AND p.campaign_id IS NOT NULL`;
    const args = [operatorId, from, toExclusive];
    return {
      from, to,
      totals: money(db.prepare(`SELECT ${MONEY} FROM pop_events p WHERE ${where}`).get(...args)),
      byVenue: db.prepare(`
        SELECT v.id, v.name, v.rev_share_pct AS rev_share_pct, ${MONEY}
        FROM pop_events p JOIN venues v ON v.id = p.venue_id WHERE ${where} GROUP BY v.id ORDER BY gross DESC`).all(...args).map(money),
      byCampaign: db.prepare(`
        SELECT c.id, c.name, c.tier, c.operator_id IS NULL AS network, ${MONEY}
        FROM pop_events p JOIN campaigns c ON c.id = p.campaign_id WHERE ${where} GROUP BY c.id ORDER BY gross DESC`).all(...args).map(money),
      byDay: db.prepare(`
        SELECT substr(p.played_at, 1, 10) AS day, ${MONEY}
        FROM pop_events p WHERE ${where} GROUP BY day ORDER BY day`).all(...args).map(money),
    };
  });

  router.get('/api/reports/venue/:id', (ctx) => {
    const user = requireRole(ctx, 'operator_admin', 'platform_admin', 'venue_manager');
    const v = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(ctx.params.id) as any;
    const allowed = v && (
      user.role === 'platform_admin' ||
      (user.role === 'operator_admin' && v.operator_id === user.operatorId) ||
      (user.role === 'venue_manager' && v.id === user.venueId)
    );
    if (!allowed) throw new HttpError(404, 'venue not found');
    const { from, to, toExclusive } = range(ctx);
    const where = `p.venue_id = ? AND p.played_at >= ? AND p.played_at < ? AND p.campaign_id IS NOT NULL`;
    const args = [v.id, from, toExclusive];
    const strip = (r: any) => ({ plays: r.plays, impressions: r.impressions, venueEarnings: r.venue, ...(r.day ? { day: r.day } : {}), ...(r.name ? { name: r.name } : {}) });
    return {
      venue: { id: v.id, name: v.name, revSharePct: v.rev_share_pct },
      from, to,
      totals: strip(money(db.prepare(`SELECT ${MONEY} FROM pop_events p WHERE ${where}`).get(...args))),
      byDay: db.prepare(`SELECT substr(p.played_at, 1, 10) AS day, ${MONEY} FROM pop_events p WHERE ${where} GROUP BY day ORDER BY day`)
        .all(...args).map(money).map(strip),
      byAdvertiser: db.prepare(`
        SELECT COALESCE(a.name, 'Network advertisers') AS name, ${MONEY}
        FROM pop_events p JOIN campaigns c ON c.id = p.campaign_id LEFT JOIN advertisers a ON a.id = c.advertiser_id
        WHERE ${where} GROUP BY a.id ORDER BY venue DESC`).all(...args).map(money).map(strip),
    };
  });

  router.get('/api/reports/platform', (ctx) => {
    requireRole(ctx, 'platform_admin');
    const { from, to, toExclusive } = range(ctx);
    const where = `p.played_at >= ? AND p.played_at < ? AND p.campaign_id IS NOT NULL`;
    return {
      from, to,
      totals: money(db.prepare(`SELECT ${MONEY} FROM pop_events p WHERE ${where}`).get(from, toExclusive)),
      byOperator: db.prepare(`
        SELECT o.id, o.name, ${MONEY} FROM pop_events p JOIN operators o ON o.id = p.operator_id
        WHERE ${where} GROUP BY o.id ORDER BY gross DESC`).all(from, toExclusive).map(money),
    };
  });
}
