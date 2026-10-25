import type { DatabaseSync } from 'node:sqlite';
import type { AppCtx } from './auth.ts';
import type { Router } from './http.ts';

export interface Config {
  /** Public base URL, used for Stripe redirect URLs. */
  publicUrl: string;
  uploadsDir: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
}

export interface App {
  db: DatabaseSync;
  config: Config;
  router: Router<AppCtx>;
}
