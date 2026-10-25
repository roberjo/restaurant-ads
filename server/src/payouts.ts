// Payout runs: pay operators and venues their share of card-paid campaigns via Stripe Connect transfers.
// Each verified play is assigned to exactly one operator payout and one venue payout, so nobody is
// paid twice. Sub-cent remainders and amounts below the minimum carry forward to the next run.
import type { DatabaseSync } from 'node:sqlite';
import { newId } from './auth.ts';
import { MICROS_PER_CENT } from './ledger.ts';
import { createTransfer } from './stripe.ts';
import { enqueueEmail, operatorAdminEmails, venueManagerEmails } from './notify.ts';
import type { Config } from './app-types.ts';

export const MIN_PAYOUT_CENTS = 100;

type Recipient = 'operator' | 'venue';

const RECIPIENTS: Record<Recipient, { share: string; link: string; group: string; operatorOf: string }> = {
  operator: { share: 'operator_micros', link: 'operator_payout_id', group: 'p.operator_id', operatorOf: 'p.operator_id' },
  venue: { share: 'venue_micros', link: 'venue_payout_id', group: 'p.venue_id', operatorOf: 'p.operator_id' },
};

export function createPayoutRun(db: DatabaseSync, periodEnd: string): { runId: string; payouts: any[] } {
  const runId = newId('run');
  const endExclusive = new Date(Date.parse(periodEnd) + 86_400_000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const created: any[] = [];
  db.exec('BEGIN');
  try {
    for (const type of Object.keys(RECIPIENTS) as Recipient[]) {
      const r = RECIPIENTS[type];
      const eligible = `FROM pop_events p JOIN campaigns c ON c.id = p.campaign_id
        WHERE c.payment_status = 'paid' AND p.${r.link} IS NULL AND p.played_at < ? AND p.${r.share} > 0`;
      const groups = db.prepare(`SELECT ${r.group} AS rid, MIN(${r.operatorOf}) AS operator_id, SUM(p.${r.share}) AS earned ${eligible} GROUP BY ${r.group}`)
        .all(endExclusive) as any[];
      for (const g of groups) {
        const last = db.prepare(`SELECT remainder_micros FROM payouts WHERE recipient_type = ? AND recipient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get(type, g.rid) as any;
        const carry = last?.remainder_micros ?? 0;
        const total = g.earned + carry;
        let cents = Math.floor(total / MICROS_PER_CENT);
        if (cents < MIN_PAYOUT_CENTS) cents = 0;
        const remainder = total - cents * MICROS_PER_CENT;
        const id = newId('po');
        db.prepare(`
          INSERT INTO payouts (id, run_id, recipient_type, recipient_id, operator_id, period_end, earned_micros, carry_in_micros,
            amount_cents, remainder_micros, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, runId, type, g.rid, g.operator_id, periodEnd, g.earned, carry, cents, remainder, cents ? 'pending' : 'below_minimum', now);
        db.prepare(`UPDATE pop_events SET ${r.link} = ? WHERE id IN (SELECT p.id ${eligible} AND ${r.group} = ?)`).run(id, endExclusive, g.rid);
        created.push(db.prepare(`SELECT * FROM payouts WHERE id = ?`).get(id));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { runId, payouts: created };
}

/** Attempt transfers for pending, failed and awaiting-account payouts (optionally limited to one run). */
export async function executePayouts(db: DatabaseSync, config: Config, runId?: string): Promise<Record<string, number>> {
  if (!config.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  const rows = db.prepare(`
    SELECT * FROM payouts WHERE status IN ('pending', 'failed', 'awaiting_account') ${runId ? 'AND run_id = ?' : ''}
    ORDER BY created_at`).all(...(runId ? [runId] : [])) as any[];
  const summary: Record<string, number> = { paid: 0, failed: 0, awaiting_account: 0 };
  for (const p of rows) {
    const table = p.recipient_type === 'operator' ? 'operators' : 'venues';
    const acct = (db.prepare(`SELECT stripe_account_id, name FROM ${table} WHERE id = ?`).get(p.recipient_id) as any);
    if (!acct?.stripe_account_id) {
      db.prepare(`UPDATE payouts SET status = 'awaiting_account', error = NULL WHERE id = ?`).run(p.id);
      summary.awaiting_account++;
      continue;
    }
    try {
      const t = await createTransfer(config.stripeSecretKey, {
        amountCents: p.amount_cents, destination: acct.stripe_account_id, transferGroup: p.run_id,
        metadata: { payout_id: p.id, recipient_type: p.recipient_type, recipient_id: p.recipient_id, period_end: p.period_end },
        idempotencyKey: p.id,
      }, config.fetchImpl);
      db.prepare(`UPDATE payouts SET status = 'paid', stripe_transfer_id = ?, paid_at = ?, error = NULL WHERE id = ?`).run(t.id, new Date().toISOString(), p.id);
      const to = p.recipient_type === 'operator' ? operatorAdminEmails(db, p.recipient_id) : venueManagerEmails(db, p.recipient_id);
      enqueueEmail(db, to, `Payout sent: $${(p.amount_cents / 100).toFixed(2)}`,
        `A payout of $${(p.amount_cents / 100).toFixed(2)} for ad revenue through ${p.period_end} is on its way to ${acct.name}'s bank account.`);
      summary.paid++;
    } catch (e) {
      db.prepare(`UPDATE payouts SET status = 'failed', error = ? WHERE id = ?`).run(String((e as Error).message).slice(0, 500), p.id);
      summary.failed++;
    }
  }
  return summary;
}
