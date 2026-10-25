// Stripe Checkout (advertiser prepayment) and webhook verification over REST; no SDK needed.
import { createHmac, timingSafeEqual } from 'node:crypto';

type Params = Record<string, unknown>;

/** Encode nested params the way Stripe expects: a[b][0][c]=v */
export function stripeForm(params: Params, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') stripeForm(v as Params, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeRequest(
  secretKey: string, method: 'GET' | 'POST', path: string, params: Params = {},
  opts: { idempotencyKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<any> {
  const f = opts.fetchImpl ?? fetch;
  const body = stripeForm(params);
  const url = `https://api.stripe.com${path}${method === 'GET' && [...body].length ? `?${body}` : ''}`;
  const r = await f(url, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
  const json: any = await r.json();
  if (!r.ok) throw new Error(`stripe: ${json?.error?.message ?? r.status}`);
  return json;
}

// ---- Connect (Express accounts) ----
export const createExpressAccount = (key: string, email: string, metadata: Params, fetchImpl?: typeof fetch) =>
  stripeRequest(key, 'POST', '/v1/accounts', {
    type: 'express', country: 'US', email, capabilities: { transfers: { requested: true } }, metadata,
  }, { fetchImpl });

export const createAccountLink = (key: string, account: string, refreshUrl: string, returnUrl: string, fetchImpl?: typeof fetch) =>
  stripeRequest(key, 'POST', '/v1/account_links', { account, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' }, { fetchImpl });

export const retrieveAccount = (key: string, account: string, fetchImpl?: typeof fetch) =>
  stripeRequest(key, 'GET', `/v1/accounts/${encodeURIComponent(account)}`, {}, { fetchImpl });

export const createTransfer = (key: string, p: { amountCents: number; destination: string; transferGroup: string; metadata: Params; idempotencyKey: string }, fetchImpl?: typeof fetch) =>
  stripeRequest(key, 'POST', '/v1/transfers', {
    amount: p.amountCents, currency: 'usd', destination: p.destination, transfer_group: p.transferGroup, metadata: p.metadata,
  }, { idempotencyKey: p.idempotencyKey, fetchImpl });

export interface CheckoutParams {
  secretKey: string;
  amountCents: number;
  description: string;
  campaignId: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: typeof fetch;
}

export async function createCheckoutSession(p: CheckoutParams): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(p.amountCents),
    'line_items[0][price_data][product_data][name]': p.description,
    client_reference_id: p.campaignId,
    'metadata[campaign_id]': p.campaignId,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
  });
  if (p.customerEmail) form.set('customer_email', p.customerEmail);
  const r = await (p.fetchImpl ?? fetch)('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${p.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body: any = await r.json();
  if (!r.ok) throw new Error(`stripe: ${body?.error?.message ?? r.status}`);
  return { id: body.id, url: body.url };
}

/** Verify a `Stripe-Signature` header (t=...,v1=...) and return the parsed event. */
export function verifyWebhook(payload: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): any {
  if (!header) throw new Error('missing signature');
  const items = header.split(',').map((kv) => kv.split('=') as [string, string]);
  const t = Number(items.find(([k]) => k === 't')?.[1]);
  const sigs = items.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || sigs.length === 0) throw new Error('malformed signature');
  if (Math.abs(nowSec - t) > toleranceSec) throw new Error('signature timestamp outside tolerance');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  const ok = sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
  if (!ok) throw new Error('signature mismatch');
  return JSON.parse(payload);
}

export function signWebhookForTest(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
