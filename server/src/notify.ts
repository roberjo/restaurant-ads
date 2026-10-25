// Transactional email via an outbox table: enqueue inside request handlers, deliver from a background job.
import type { DatabaseSync } from 'node:sqlite';
import { newId } from './auth.ts';
import type { Config } from './app-types.ts';

const MAX_ATTEMPTS = 5;

export function enqueueEmail(db: DatabaseSync, to: string[], subject: string, body: string, dedupeKey?: string): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO outbox (id, to_email, subject, body, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const addr of new Set(to)) {
    insert.run(newId('msg'), addr, subject.slice(0, 200), body, dedupeKey ? `${dedupeKey}:${addr}` : null, new Date().toISOString());
  }
}

const emails = (rows: any[]) => rows.map((r) => r.email as string);

export const operatorAdminEmails = (db: DatabaseSync, operatorId: string) =>
  emails(db.prepare(`SELECT email FROM users WHERE role = 'operator_admin' AND operator_id = ?`).all(operatorId));
export const platformAdminEmails = (db: DatabaseSync) =>
  emails(db.prepare(`SELECT email FROM users WHERE role = 'platform_admin'`).all());
export const advertiserEmails = (db: DatabaseSync, advertiserId: string) =>
  emails(db.prepare(`SELECT email FROM users WHERE role = 'advertiser' AND advertiser_id = ?`).all(advertiserId));
export const venueManagerEmails = (db: DatabaseSync, venueId: string) =>
  emails(db.prepare(`SELECT email FROM users WHERE role = 'venue_manager' AND venue_id = ?`).all(venueId));

/** Deliver pending messages through Resend; without an API key, messages are logged and marked skipped. */
export async function flushOutbox(db: DatabaseSync, config: Config, fetchImpl: typeof fetch = config.fetchImpl ?? fetch, limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
  const rows = db.prepare(`SELECT * FROM outbox WHERE status IN ('pending', 'retry') AND attempts < ? ORDER BY created_at LIMIT ?`)
    .all(MAX_ATTEMPTS, limit) as any[];
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const m of rows) {
    if (!config.resendApiKey || !config.emailFrom) {
      console.log(`[email:skipped] to=${m.to_email} subject="${m.subject}"`);
      db.prepare(`UPDATE outbox SET status = 'skipped', sent_at = ? WHERE id = ?`).run(new Date().toISOString(), m.id);
      result.skipped++;
      continue;
    }
    try {
      const r = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json', 'idempotency-key': m.id },
        body: JSON.stringify({ from: config.emailFrom, to: [m.to_email], subject: m.subject, text: m.body }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      db.prepare(`UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`).run(new Date().toISOString(), m.id);
      result.sent++;
    } catch (e) {
      const attempts = m.attempts + 1;
      db.prepare(`UPDATE outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?`)
        .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', attempts, String((e as Error).message).slice(0, 500), m.id);
      result.failed++;
    }
  }
  return result;
}
