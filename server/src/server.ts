import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, createApp } from './app.ts';
import { DEMO_PASSWORD, createUser, isEmpty, openDb, seedDemo } from './db.ts';
import { startJobs } from './jobs.ts';
import { syncAllSquareVenues } from './square.ts';

const PORT = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? join(ROOT, 'data');
mkdirSync(dataDir, { recursive: true });
const db = openDb(process.env.DB_PATH ?? join(dataDir, 'app.sqlite'));

if (isEmpty(db)) {
  if (process.env.SEED_DEMO === '1') {
    seedDemo(db);
    console.log(`Seeded demo data. Logins (password "${DEMO_PASSWORD}"):
  platform admin  admin@platform.test
  operator        ops@austin.test
  venue manager   tacos@austin.test
  advertiser      dentist@austin.test`);
  } else if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    createUser(db, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: 'Platform Admin', role: 'platform_admin' });
    console.log(`Created platform admin ${process.env.ADMIN_EMAIL}`);
  } else {
    console.warn('Empty database: set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin, or SEED_DEMO=1 for demo data.');
  }
}

const env = process.env;
const config = {
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${PORT}`,
  uploadsDir: join(dataDir, 'uploads'),
  stripeSecretKey: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  resendApiKey: env.RESEND_API_KEY,
  emailFrom: env.EMAIL_FROM,
  appSecret: env.APP_SECRET,
  squareAppId: env.SQUARE_APP_ID,
  squareAppSecret: env.SQUARE_APP_SECRET,
  squareEnvironment: (env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox') as 'production' | 'sandbox',
  squareWebhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  squareWebhookUrl: env.SQUARE_WEBHOOK_URL,
};
if (config.stripeSecretKey && !config.stripeWebhookSecret) console.warn('STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET: card payments will never be confirmed.');

const server = createApp(db, config);
startJobs(db, config, [{ everyMs: 30 * 60_000, run: () => syncAllSquareVenues(db, config) }]);

server.listen(PORT, () => {
  console.log(`Console: http://localhost:${PORT}/console/   Player: http://localhost:${PORT}/player/`);
});
