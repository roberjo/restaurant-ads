// Background jobs: offline-screen alerts, email delivery, periodic POS menu sync.
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './app-types.ts';
import { isOpenAt } from './hours.ts';
import { enqueueEmail, flushOutbox, operatorAdminEmails } from './notify.ts';

export const OFFLINE_ALERT_AFTER_MS = 15 * 60_000;

/** Email operators once per outage when a paired screen stops reporting while its venue is open. */
export function checkOfflineScreens(db: DatabaseSync, config: Config, now = new Date()): number {
  const cutoff = new Date(now.getTime() - OFFLINE_ALERT_AFTER_MS).toISOString();
  const rows = db.prepare(`
    SELECT s.id, s.name, s.operator_id, v.name AS venue_name, v.open_hours, v.timezone, d.last_seen_at
    FROM screens s JOIN venues v ON v.id = s.venue_id JOIN devices d ON d.screen_id = s.id
    WHERE d.last_seen_at IS NULL OR d.last_seen_at < ?`).all(cutoff) as any[];
  let alerted = 0;
  for (const r of rows) {
    if (!isOpenAt(r.open_hours ? JSON.parse(r.open_hours) : null, r.timezone, now)) continue;
    const to = operatorAdminEmails(db, r.operator_id);
    if (!to.length) continue;
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get() as any).n;
    enqueueEmail(db, to, `Screen offline: ${r.venue_name} · ${r.name}`,
      `The screen "${r.name}" at ${r.venue_name} has not checked in since ${r.last_seen_at ?? 'it was paired'}.\n\n` +
      `Common causes: the TV input was changed, the player was unplugged, or the venue's Wi-Fi changed.\n` +
      `Fleet status: ${config.publicUrl}/console/#/screens`,
      `offline:${r.id}:${r.last_seen_at ?? 'never'}`);
    if ((db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get() as any).n > before) alerted++;
  }
  return alerted;
}

export function startJobs(db: DatabaseSync, config: Config, extra: Array<{ everyMs: number; run: () => unknown }> = []): () => void {
  const safe = (name: string, fn: () => unknown) => async () => {
    try { await fn(); } catch (e) { console.error(`[job:${name}]`, e); }
  };
  const timers = [
    setInterval(safe('offline', () => checkOfflineScreens(db, config)), 60_000),
    setInterval(safe('outbox', () => flushOutbox(db, config)), 15_000),
    ...extra.map((j, i) => setInterval(safe(`extra${i}`, j.run), j.everyMs)),
  ];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}
