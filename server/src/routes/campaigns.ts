// Campaign lifecycle: draft → pending_review → active ⇄ paused → completed (or rejected), plus
// creatives, prepayment via Stripe Checkout, and delivery reports.
import { actingOperatorId, newId, requireRole, requireUser, type AppCtx, type User } from '../auth.ts';
import { AD_CATEGORIES, VENUE_CATEGORIES, nowIso, toApi } from '../db.ts';
import { HttpError } from '../http.ts';
import { MICROS_PER_CENT, microsToUsd } from '../ledger.ts';
import { createCheckoutSession, verifyWebhook } from '../stripe.ts';
import { saveUpload } from '../uploads.ts';
import type { App } from '../app-types.ts';
import { date, int, num, oneOf, str, stringList } from '../validate.ts';

const EDITABLE = ['draft', 'rejected', 'pending_review'];
const OPERATOR_TIERS = ['sponsorship', 'direct', 'local'] as const;
const NETWORK_TIERS = ['direct', 'programmatic'] as const;

function parseTargeting(b: any) {
  let geo = null;
  if (b.geo) {
    geo = {
      lat: num(b.geo.lat, 'geo.lat', -90, 90),
      lng: num(b.geo.lng, 'geo.lng', -180, 180),
      radiusMiles: num(b.geo.radiusMiles, 'geo.radiusMiles', 0.25, 200),
    };
  }
  const venueCategories = b.venueCategories?.length ? stringList(b.venueCategories, 'venueCategories', VENUE_CATEGORIES) : null;
  let dayparts = null;
  if (b.dayparts?.length) {
    if (!Array.isArray(b.dayparts) || b.dayparts.length > 6) throw new HttpError(400, 'dayparts must be a list (max 6)');
    dayparts = b.dayparts.map((d: any) => ({
      startHour: int(d.startHour, 'startHour', 0, 23),
      endHour: int(d.endHour, 'endHour', 0, 24),
    }));
  }
  return { geo, venueCategories, dayparts };
}

export function registerCampaigns({ db, router, config }: App): void {
  function campaignFor(user: User, id: string): any {
    const c = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as any;
    const visible = c && (
      user.role === 'platform_admin' ||
      (user.role === 'operator_admin' && c.operator_id === user.operatorId) ||
      (user.role === 'advertiser' && c.advertiser_id === user.advertiserId)
    );
    if (!visible) throw new HttpError(404, 'campaign not found');
    return c;
  }

  const isReviewer = (u: User, c: any) =>
    u.role === 'platform_admin' || (u.role === 'operator_admin' && c.operator_id === u.operatorId);

  function present(c: any) {
    const creatives = db.prepare(`SELECT * FROM creatives WHERE campaign_id = ? ORDER BY created_at`).all(c.id).map(toApi);
    const d = db.prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(impressions), 0) AS impressions FROM pop_events WHERE campaign_id = ?`).get(c.id) as any;
    const adv = c.advertiser_id ? (db.prepare(`SELECT name FROM advertisers WHERE id = ?`).get(c.advertiser_id) as any) : null;
    return {
      ...toApi(c),
      advertiserName: adv?.name ?? null,
      network: c.operator_id === null,
      creatives,
      delivery: { plays: d.plays, impressions: d.impressions, spentUsd: microsToUsd(c.spent_micros), budgetUsd: c.budget_cents / 100 },
    };
  }

  const reload = (id: string) => present(db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id));

  function setStatus(c: any, from: string[], to: string, extra: Record<string, unknown> = {}) {
    if (!from.includes(c.status)) throw new HttpError(409, `campaign is ${c.status}; cannot move to ${to}`);
    const cols = Object.keys(extra).map((k) => `, ${k} = ?`).join('');
    db.prepare(`UPDATE campaigns SET status = ?${cols} WHERE id = ?`).run(to, ...(Object.values(extra) as any[]), c.id);
    return reload(c.id);
  }

  router.get('/api/campaigns', (ctx) => {
    const user = requireRole(ctx, 'platform_admin', 'operator_admin', 'advertiser');
    let rows: any[];
    if (user.role === 'advertiser') {
      rows = db.prepare(`SELECT * FROM campaigns WHERE advertiser_id = ? ORDER BY created_at DESC`).all(user.advertiserId);
    } else if (user.role === 'platform_admin' && ctx.url.searchParams.get('network') === '1') {
      rows = db.prepare(`SELECT * FROM campaigns WHERE operator_id IS NULL ORDER BY created_at DESC`).all();
    } else {
      rows = db.prepare(`SELECT * FROM campaigns WHERE operator_id = ? ORDER BY created_at DESC`).all(actingOperatorId(ctx, user));
    }
    const status = ctx.url.searchParams.get('status');
    return rows.filter((r) => !status || r.status === status).map(present);
  });

  router.get('/api/campaigns/:id', (ctx) => present(campaignFor(requireUser(ctx), ctx.params.id)));

  router.post('/api/campaigns', (ctx) => {
    const user = requireRole(ctx, 'platform_admin', 'operator_admin', 'advertiser');
    const b = ctx.body;
    let operatorId: string | null;
    let advertiserId: string | null;
    let tier: string;
    let cpmCents: number;
    let maxSov = 20;
    let minBudget = 100;

    if (user.role === 'platform_admin' && b.network) {
      operatorId = null;
      advertiserId = null;
      tier = oneOf(b.tier ?? 'programmatic', 'tier', NETWORK_TIERS);
      cpmCents = int(b.cpmCents, 'cpmCents', 50, 100_000);
      maxSov = num(b.maxSovPct ?? 15, 'maxSovPct', 1, 100);
    } else {
      operatorId = user.role === 'advertiser' ? user.operatorId! : actingOperatorId(ctx, user);
      const op = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(operatorId) as any;
      if (user.role === 'advertiser') {
        advertiserId = user.advertiserId;
        tier = 'local';
        cpmCents = op.default_cpm_cents;
      } else {
        advertiserId = str(b.advertiserId, 'advertiserId');
        const adv = db.prepare(`SELECT operator_id FROM advertisers WHERE id = ?`).get(advertiserId) as any;
        if (!adv || adv.operator_id !== operatorId) throw new HttpError(400, 'unknown advertiser');
        tier = oneOf(b.tier ?? 'local', 'tier', OPERATOR_TIERS);
        cpmCents = b.cpmCents !== undefined ? int(b.cpmCents, 'cpmCents', 50, 100_000) : op.default_cpm_cents;
        maxSov = num(b.maxSovPct ?? 20, 'maxSovPct', 1, 100);
      }
      minBudget = op.min_budget_cents;
    }

    const budgetCents = int(b.budgetCents, 'budgetCents', minBudget, 100_000_000);
    const startDate = date(b.startDate, 'startDate');
    const endDate = date(b.endDate, 'endDate');
    if (endDate < startDate) throw new HttpError(400, 'endDate must be on or after startDate');
    const t = parseTargeting(b);
    const id = newId('cmp');
    db.prepare(`
      INSERT INTO campaigns (id, operator_id, advertiser_id, name, tier, status, payment_status, start_date, end_date,
        geo, venue_categories, dayparts, ad_category, max_sov_pct, cpm_cents, budget_cents, created_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, operatorId, advertiserId, str(b.name, 'name'), tier, operatorId === null ? 'invoiced' : 'unpaid',
      startDate, endDate,
      t.geo ? JSON.stringify(t.geo) : null, t.venueCategories ? JSON.stringify(t.venueCategories) : null,
      t.dayparts ? JSON.stringify(t.dayparts) : null,
      oneOf(b.adCategory ?? 'other', 'adCategory', AD_CATEGORIES), maxSov, cpmCents, budgetCents, nowIso(),
    );
    return reload(id);
  });

  router.put('/api/campaigns/:id', (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!isReviewer(user, c) && !EDITABLE.includes(c.status)) throw new HttpError(409, `campaign is ${c.status}; pause it before editing`);
    const b = { ...toApi(c), ...ctx.body };
    const startDate = date(b.startDate, 'startDate');
    const endDate = date(b.endDate, 'endDate');
    if (endDate < startDate) throw new HttpError(400, 'endDate must be on or after startDate');
    const t = parseTargeting(b);
    const minBudget = c.operator_id
      ? (db.prepare(`SELECT min_budget_cents FROM operators WHERE id = ?`).get(c.operator_id) as any).min_budget_cents
      : 100;
    if (c.payment_status === 'paid' && b.budgetCents !== c.budget_cents) throw new HttpError(409, 'budget is locked after payment');
    db.prepare(`
      UPDATE campaigns SET name = ?, start_date = ?, end_date = ?, geo = ?, venue_categories = ?, dayparts = ?,
        ad_category = ?, budget_cents = ? WHERE id = ?`).run(
      str(b.name, 'name'), startDate, endDate,
      t.geo ? JSON.stringify(t.geo) : null, t.venueCategories ? JSON.stringify(t.venueCategories) : null,
      t.dayparts ? JSON.stringify(t.dayparts) : null,
      oneOf(b.adCategory, 'adCategory', AD_CATEGORIES), int(b.budgetCents, 'budgetCents', minBudget, 100_000_000), c.id,
    );
    if (isReviewer(user, c)) {
      if (ctx.body.cpmCents !== undefined) db.prepare(`UPDATE campaigns SET cpm_cents = ? WHERE id = ?`).run(int(ctx.body.cpmCents, 'cpmCents', 50, 100_000), c.id);
      if (ctx.body.maxSovPct !== undefined) db.prepare(`UPDATE campaigns SET max_sov_pct = ? WHERE id = ?`).run(num(ctx.body.maxSovPct, 'maxSovPct', 1, 100), c.id);
    }
    return reload(c.id);
  });

  // ---- Creatives ----
  router.post('/api/campaigns/:id/creatives', (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!isReviewer(user, c) && !EDITABLE.includes(c.status)) throw new HttpError(409, 'creatives can only change before approval');
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM creatives WHERE campaign_id = ?`).get(c.id) as any).n;
    if (count >= 10) throw new HttpError(400, 'max 10 creatives per campaign');
    const up = saveUpload(config.uploadsDir, ctx.body.dataBase64);
    db.prepare(`INSERT INTO creatives VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId('cr'), c.id, up.url, up.type, num(ctx.body.durationSec ?? 10, 'durationSec', 5, 30), nowIso());
    return reload(c.id);
  });

  router.delete('/api/campaigns/:id/creatives/:crId', (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!isReviewer(user, c) && !EDITABLE.includes(c.status)) throw new HttpError(409, 'creatives can only change before approval');
    db.prepare(`DELETE FROM creatives WHERE id = ? AND campaign_id = ?`).run(ctx.params.crId, c.id);
    return reload(c.id);
  });

  // ---- Lifecycle ----
  router.post('/api/campaigns/:id/submit', (ctx) => {
    const c = campaignFor(requireUser(ctx), ctx.params.id);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM creatives WHERE campaign_id = ?`).get(c.id) as any).n;
    if (n === 0) throw new HttpError(400, 'add at least one creative before submitting');
    return setStatus(c, ['draft', 'rejected'], 'pending_review', { review_note: null });
  });

  router.post('/api/campaigns/:id/approve', (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!isReviewer(user, c)) throw new HttpError(403, 'only the operator can approve');
    if (c.payment_status === 'unpaid') throw new HttpError(409, 'payment required: wait for checkout or mark as invoiced');
    return setStatus(c, ['pending_review'], 'active', { review_note: null });
  });

  router.post('/api/campaigns/:id/reject', (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!isReviewer(user, c)) throw new HttpError(403, 'only the operator can reject');
    return setStatus(c, ['pending_review', 'active', 'paused'], 'rejected', { review_note: str(ctx.body.note, 'note', 1, 500) });
  });

  router.post('/api/campaigns/:id/pause', (ctx) => setStatus(campaignFor(requireUser(ctx), ctx.params.id), ['active'], 'paused'));
  router.post('/api/campaigns/:id/resume', (ctx) => setStatus(campaignFor(requireUser(ctx), ctx.params.id), ['paused'], 'active'));

  router.post('/api/campaigns/:id/mark-invoiced', (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!isReviewer(user, c)) throw new HttpError(403, 'only the operator can mark invoiced');
    if (c.payment_status !== 'unpaid') throw new HttpError(409, `payment is already ${c.payment_status}`);
    db.prepare(`UPDATE campaigns SET payment_status = 'invoiced' WHERE id = ?`).run(c.id);
    return reload(c.id);
  });

  // ---- Payments ----
  router.post('/api/campaigns/:id/checkout', async (ctx) => {
    const user = requireUser(ctx);
    const c = campaignFor(user, ctx.params.id);
    if (!config.stripeSecretKey) throw new HttpError(400, 'online payments are not configured; ask your operator for an invoice');
    if (c.payment_status !== 'unpaid') throw new HttpError(409, `payment is already ${c.payment_status}`);
    const adv = db.prepare(`SELECT contact_email FROM advertisers WHERE id = ?`).get(c.advertiser_id) as any;
    const back = `${config.publicUrl}/console/#/campaigns/${c.id}`;
    const session = await createCheckoutSession({
      secretKey: config.stripeSecretKey,
      amountCents: c.budget_cents,
      description: `Screen ad campaign: ${c.name}`,
      campaignId: c.id,
      customerEmail: adv?.contact_email ?? undefined,
      successUrl: `${back}?paid=1`,
      cancelUrl: back,
    });
    db.prepare(`UPDATE campaigns SET stripe_session_id = ? WHERE id = ?`).run(session.id, c.id);
    return { url: session.url };
  });

  router.post('/api/stripe/webhook', (ctx) => {
    if (!config.stripeWebhookSecret) throw new HttpError(404, 'not found');
    let event: any;
    try {
      event = verifyWebhook(ctx.rawBody, ctx.req.headers['stripe-signature'] as string | undefined, config.stripeWebhookSecret);
    } catch (e) {
      throw new HttpError(400, `webhook rejected: ${(e as Error).message}`);
    }
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      const s = event.data.object;
      db.prepare(`UPDATE campaigns SET payment_status = 'paid' WHERE id = ? AND stripe_session_id = ? AND payment_status = 'unpaid'`)
        .run(s.metadata?.campaign_id ?? s.client_reference_id, s.id);
    }
    return { received: true };
  });

  // ---- Inventory: where the screens are, for targeting and reach estimates ----
  router.get('/api/inventory', (ctx) => {
    const user = requireRole(ctx, 'platform_admin', 'operator_admin', 'advertiser');
    const operatorId = user.role === 'advertiser' ? user.operatorId! : actingOperatorId(ctx, user);
    const OPEN_HOURS = 12;
    const AD_SEC = 10;
    const rows = db.prepare(`
      SELECT v.id, v.name, v.lat, v.lng, v.category, v.audience_multiplier, s.loop_sec, s.ad_share_pct
      FROM venues v JOIN screens s ON s.venue_id = v.id WHERE v.operator_id = ?`).all(operatorId) as any[];
    const venues = new Map<string, any>();
    for (const r of rows) {
      const v = venues.get(r.id) ?? { id: r.id, name: r.name, lat: r.lat, lng: r.lng, category: r.category, screens: 0, estDailyImpressions: 0 };
      // One campaign capped at 20% share of voice (or the screen's ad share if lower)
      const playsPerLoop = Math.floor((r.loop_sec * Math.min(20, r.ad_share_pct)) / 100 / AD_SEC);
      v.screens++;
      v.estDailyImpressions += Math.round(((OPEN_HOURS * 3600) / r.loop_sec) * playsPerLoop * r.audience_multiplier);
      venues.set(r.id, v);
    }
    return { venues: [...venues.values()], assumptions: { openHoursPerDay: OPEN_HOURS, adLengthSec: AD_SEC, maxSovPct: 20 } };
  });

  // ---- Delivery report ----
  router.get('/api/campaigns/:id/report', (ctx) => {
    const c = campaignFor(requireUser(ctx), ctx.params.id);
    const byVenue = db.prepare(`
      SELECT v.name AS venue, COUNT(*) AS plays, SUM(p.impressions) AS impressions, SUM(p.gross_micros) AS gross_micros
      FROM pop_events p JOIN venues v ON v.id = p.venue_id WHERE p.campaign_id = ? GROUP BY v.id ORDER BY plays DESC`).all(c.id) as any[];
    const byDay = db.prepare(`
      SELECT substr(played_at, 1, 10) AS day, COUNT(*) AS plays, SUM(impressions) AS impressions, SUM(gross_micros) AS gross_micros
      FROM pop_events WHERE campaign_id = ? GROUP BY day ORDER BY day`).all(c.id) as any[];
    const fmt = (r: any) => ({ ...r, spendUsd: microsToUsd(r.gross_micros), gross_micros: undefined });
    return {
      campaign: present(c),
      byVenue: byVenue.map(fmt),
      byDay: byDay.map(fmt),
      remainingUsd: Math.max(0, c.budget_cents * MICROS_PER_CENT - c.spent_micros) / 1_000_000,
    };
  });
}
