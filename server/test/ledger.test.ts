import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microsToUsd, priceImpressions, splitRevenue } from '../src/ledger.ts';
import { signWebhookForTest, verifyWebhook } from '../src/stripe.ts';

test('prices impressions at CPM in micros', () => {
  // $12 CPM → $0.012 per impression → 12,000 micros
  assert.equal(priceImpressions(1, 1200), 12_000);
  assert.equal(priceImpressions(5, 1200), 60_000);
  assert.equal(microsToUsd(60_000), 0.06);
});

test('split: platform fee first, venue share of net, operator keeps remainder', () => {
  const s = splitRevenue(60_000, 5, 25);
  assert.deepEqual(s, { grossMicros: 60_000, platformMicros: 3_000, venueMicros: 14_250, operatorMicros: 42_750 });
  const odd = splitRevenue(101, 33, 33);
  assert.equal(odd.platformMicros + odd.venueMicros + odd.operatorMicros, 101, 'no money created or lost');
});

test('stripe webhook signature verification', () => {
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  const header = signWebhookForTest(payload, 'whsec_x');
  assert.equal(verifyWebhook(payload, header, 'whsec_x').type, 'checkout.session.completed');
  assert.throws(() => verifyWebhook(payload, header, 'whsec_wrong'), /mismatch/);
  assert.throws(() => verifyWebhook(payload + ' ', header, 'whsec_x'), /mismatch/);
  const old = signWebhookForTest(payload, 'whsec_x', Math.floor(Date.now() / 1000) - 3600);
  assert.throws(() => verifyWebhook(payload, old, 'whsec_x'), /tolerance/);
});
