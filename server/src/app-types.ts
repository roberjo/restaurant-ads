import type { DatabaseSync } from 'node:sqlite';
import type { AppCtx } from './auth.ts';
import type { Router } from './http.ts';

export interface Config {
  /** Public base URL, used for Stripe redirect URLs. */
  publicUrl: string;
  uploadsDir: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  resendApiKey?: string;
  emailFrom?: string;
  /** Secret for encrypting stored OAuth tokens and signing OAuth state. Required for POS integrations. */
  appSecret?: string;
  squareAppId?: string;
  squareAppSecret?: string;
  squareEnvironment?: 'sandbox' | 'production';
  squareWebhookSignatureKey?: string;
  squareWebhookUrl?: string;
  /** DNS resolution for SSP notice URLs (blocks private addresses); injectable for tests. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Outbound HTTP for third-party APIs (Stripe, Square, email); injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface App {
  db: DatabaseSync;
  config: Config;
  router: Router<AppCtx>;
}
