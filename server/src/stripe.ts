// Stripe Checkout (advertiser prepayment) and webhook verification over REST; no SDK needed.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckoutParams {
  secretKey: string;
  amountCents: number;
  description: string;
  campaignId: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
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
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
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
