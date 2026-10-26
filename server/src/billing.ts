// Operator SaaS billing: a per-screen monthly subscription on Stripe Billing.
// Stripe is the source of truth: every subscription webhook re-fetches the subscription before it's applied.
// Lapsed billing only blocks pairing *new* screens; screens already playing keep running so venues and
// paying advertisers aren't hurt by an operator's billing problem.
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './app-types.ts';
import { getSetting } from './db.ts';
import { HttpError } from './http.ts';
import { enqueueEmail, operatorAdminEmails } from './notify.ts';
import { stripeRequest } from './stripe.ts';

/** Subscription statuses that allow adding screens (past_due: Stripe is still retrying the card). */
const IN_GOOD_STANDING = new Set(['active', 'trialing', 'past_due']);
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

export interface BillingSettings { priceCents: number; trialDays: number; freeScreens: number }

export function billingSettings(db: DatabaseSync): BillingSettings {
  return {
    priceCents: Number(getSetting(db, 'saas_price_cents') ?? 1500),
    trialDays: Number(getSetting(db, 'saas_trial_days') ?? 30),
    freeScreens: Number(getSetting(db, 'saas_free_screens') ?? 2),
  };
}

/** Screens with a paired device: what the operator is billed for. */
export const pairedScreens = (db: DatabaseSync, operatorId: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM screens s JOIN devices d ON d.screen_id = s.id WHERE s.operator_id = ?`).get(operatorId) as any).n;

export function billingSummary(db: DatabaseSync, config: Config, op: any, now = new Date()) {
  const settings = billingSettings(db);
  const paired = pairedScreens(db, op.id);
  const today = now.toISOString().slice(0, 10);
  let state: string;
  if (!config.stripeSecretKey) state = 'not_configured';
  else if (op.free_until && op.free_until >= today) state = 'comped';
  else state = op.billing_status ?? 'none';
  const unlimited = state === 'not_configured' || state === 'comped' || IN_GOOD_STANDING.has(state);
  const unitCents = op.billing_price_cents ?? settings.priceCents;
  return {
    state,
    canPair: unlimited || paired < settings.freeScreens,
    freeScreens: settings.freeScreens,
    pairedScreens: paired,
    billedScreens: op.billed_screens ?? 0,
    unitPriceCents: unitCents,
    monthlyEstimateCents: state === 'comped' || state === 'not_configured' ? 0 : unitCents * Math.max(1, paired),
    trialDays: op.stripe_subscription_id ? 0 : settings.trialDays,
    periodEnd: op.billing_period_end ?? null,
    freeUntil: op.free_until ?? null,
    hasSubscription: !!op.stripe_subscription_id && LIVE.has(op.billing_status),
    canManage: !!op.stripe_customer_id,
  };
}

/** Throws 402 when the operator can't add another paired screen. Replacing a screen's device is always allowed. */
export function assertCanPair(db: DatabaseSync, config: Config, operatorId: string, screenAlreadyPaired: boolean): void {
  if (screenAlreadyPaired) return;
  const op = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(operatorId);
  const b = billingSummary(db, config, op);
  if (!b.canPair) {
    throw new HttpError(402, b.state === 'none'
      ? `the free plan covers ${b.freeScreens} screens: start a subscription in Settings → Billing to add more`
      : `billing is ${b.state.replace(/_/g, ' ')}: update payment in Settings → Billing to add screens (existing screens keep playing)`);
  }
}

const key = (config: Config) => {
  if (!config.stripeSecretKey) throw new HttpError(400, 'billing is not configured (STRIPE_SECRET_KEY)');
  return config.stripeSecretKey;
};

export async function startCheckout(db: DatabaseSync, config: Config, op: any, email: string): Promise<{ url: string }> {
  const b = billingSummary(db, config, op);
  if (b.hasSubscription) throw new HttpError(409, 'already subscribed: use "Manage billing" to change payment details');
  const settings = billingSettings(db);
  const back = `${config.publicUrl}/console/#/settings`;
  const session = await stripeRequest(key(config), 'POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: [{
      quantity: Math.max(1, b.pairedScreens),
      price_data: {
        currency: 'usd', unit_amount: settings.priceCents, recurring: { interval: 'month' },
        product_data: { name: 'Screen subscription (per paired screen)' },
      },
    }],
    subscription_data: { metadata: { operator_id: op.id }, trial_period_days: b.trialDays || undefined },
    customer: op.stripe_customer_id ?? undefined,
    customer_email: op.stripe_customer_id ? undefined : email,
    client_reference_id: op.id,
    metadata: { operator_id: op.id, kind: 'saas' },
    success_url: `${back}?billing=success`,
    cancel_url: `${back}?billing=cancelled`,
  }, { fetchImpl: config.fetchImpl });
  db.prepare(`UPDATE operators SET billing_price_cents = ? WHERE id = ?`).run(settings.priceCents, op.id);
  return { url: session.url };
}

export async function portalSession(config: Config, op: any): Promise<{ url: string }> {
  if (!op.stripe_customer_id) throw new HttpError(409, 'no billing account yet: start a subscription first');
  const s = await stripeRequest(key(config), 'POST', '/v1/billing_portal/sessions', {
    customer: op.stripe_customer_id, return_url: `${config.publicUrl}/console/#/settings`,
  }, { fetchImpl: config.fetchImpl });
  return { url: s.url };
}

/** Record a (freshly fetched) subscription on its operator. Ignores subscriptions that aren't ours or are superseded. */
function applySubscription(db: DatabaseSync, sub: any): string | null {
  const op = (sub.metadata?.operator_id
    ? db.prepare(`SELECT * FROM operators WHERE id = ?`).get(sub.metadata.operator_id)
    : db.prepare(`SELECT * FROM operators WHERE stripe_subscription_id = ?`).get(sub.id)) as any;
  if (!op) return null;
  // A different, still-live subscription is already on file: don't let a stale one overwrite it.
  if (op.stripe_subscription_id && op.stripe_subscription_id !== sub.id && LIVE.has(op.billing_status)) return null;
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  db.prepare(`UPDATE operators SET billing_status = ?, stripe_subscription_id = ?, stripe_subscription_item_id = ?,
      stripe_customer_id = COALESCE(?, stripe_customer_id), billed_screens = ?, billing_period_end = ?,
      billing_price_cents = COALESCE(?, billing_price_cents) WHERE id = ?`).run(
    sub.status, sub.id, item?.id ?? null, typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
    item?.quantity ?? 0, periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    item?.price?.unit_amount ?? null, op.id);
  return op.id;
}

const retrieveSubscription = (config: Config, id: string) =>
  stripeRequest(key(config), 'GET', `/v1/subscriptions/${encodeURIComponent(id)}`, {}, { fetchImpl: config.fetchImpl });

/** Handle billing-related Stripe events. Returns true when the event was a billing event. */
export async function handleBillingEvent(db: DatabaseSync, config: Config, event: any): Promise<boolean> {
  const o = event.data?.object ?? {};
  if (event.type === 'checkout.session.completed') {
    if (o.mode !== 'subscription' || !o.metadata?.operator_id || !o.subscription) return false;
    const subId = typeof o.subscription === 'string' ? o.subscription : o.subscription.id;
    const opId = applySubscription(db, await retrieveSubscription(config, subId));
    if (opId) await syncQuantity(db, config, opId);
    return true;
  }
  if (event.type.startsWith('customer.subscription.')) {
    // Other products may share the Stripe account: only fetch subscriptions that belong to an operator.
    if (!o.metadata?.operator_id && !db.prepare(`SELECT 1 FROM operators WHERE stripe_subscription_id = ?`).get(o.id)) return true;
    const sub = await retrieveSubscription(config, o.id);
    const opId = applySubscription(db, sub);
    if (opId && event.type === 'customer.subscription.trial_will_end') {
      enqueueEmail(db, operatorAdminEmails(db, opId), 'Your trial ends soon',
        `Your screen subscription trial ends on ${new Date((sub.trial_end ?? 0) * 1000).toDateString()}.\n` +
        `Billing then starts automatically for each paired screen. Manage billing: ${config.publicUrl}/console/#/settings`,
        `trial_end:${sub.id}`);
    }
    return true;
  }
  if (event.type === 'invoice.payment_failed') {
    const op = db.prepare(`SELECT id FROM operators WHERE stripe_customer_id = ?`).get(o.customer) as any;
    if (op) {
      enqueueEmail(db, operatorAdminEmails(db, op.id), 'Payment failed for your screen subscription',
        `We couldn't charge your card for your screen subscription. Stripe will retry automatically.\n` +
        `Your screens keep playing, but you can't add new ones until payment succeeds.\n` +
        `Update your payment method: ${config.publicUrl}/console/#/settings`,
        `invoice_failed:${o.id}`);
    }
    return true;
  }
  return false;
}

/** Keep the subscription quantity equal to the number of paired screens (prorated by Stripe). */
export async function syncQuantity(db: DatabaseSync, config: Config, operatorId: string): Promise<boolean> {
  if (!config.stripeSecretKey) return false;
  const op = db.prepare(`SELECT * FROM operators WHERE id = ?`).get(operatorId) as any;
  if (!op?.stripe_subscription_item_id || !LIVE.has(op.billing_status)) return false;
  const want = Math.max(1, pairedScreens(db, operatorId));
  if (want === op.billed_screens) return false;
  await stripeRequest(config.stripeSecretKey, 'POST', `/v1/subscription_items/${encodeURIComponent(op.stripe_subscription_item_id)}`,
    { quantity: want, proration_behavior: 'create_prorations' }, { fetchImpl: config.fetchImpl });
  db.prepare(`UPDATE operators SET billed_screens = ? WHERE id = ?`).run(want, operatorId);
  return true;
}

export async function syncAllQuantities(db: DatabaseSync, config: Config): Promise<number> {
  if (!config.stripeSecretKey) return 0;
  let changed = 0;
  for (const r of db.prepare(`SELECT id FROM operators WHERE stripe_subscription_item_id IS NOT NULL`).all() as any[]) {
    try { if (await syncQuantity(db, config, r.id)) changed++; } catch (e) { console.error(`[billing] quantity sync ${r.id}:`, (e as Error).message); }
  }
  return changed;
}

/** Fire-and-forget quantity sync after pairing changes; the hourly job catches anything this misses. */
export function syncQuantitySoon(db: DatabaseSync, config: Config, operatorId: string): void {
  syncQuantity(db, config, operatorId).catch((e) => console.error(`[billing] quantity sync ${operatorId}:`, e.message));
}
