# restaurant-ads

[![CI](https://github.com/roberjo/restaurant-ads/actions/workflows/ci.yml/badge.svg)](https://github.com/roberjo/restaurant-ads/actions/workflows/ci.yml)
[![Security](https://github.com/roberjo/restaurant-ads/actions/workflows/security.yml/badge.svg)](https://github.com/roberjo/restaurant-ads/actions/workflows/security.yml)
[![CodeQL](https://github.com/roberjo/restaurant-ads/actions/workflows/codeql.yml/badge.svg)](https://github.com/roberjo/restaurant-ads/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/roberjo/restaurant-ads?include_prereleases&sort=semver)](https://github.com/roberjo/restaurant-ads/releases)

A platform for running **local in-venue TV ad networks**. Independent operators (AV installers, local agencies) sign up restaurants, turn an existing TV into a free menu board with ads mixed in, sell local ads, and earn from pooled national demand. The platform earns from SaaS fees, payment fees and a take rate on programmatic ads.

| Doc | What |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | **The program plan**: products, phases, architecture, operations, legal, go-to-market, KPIs, risks |
| [docs/platform-model.md](docs/platform-model.md) | Why we're an operator platform, revenue model, franchise-law guardrails |
| [docs/feasibility.md](docs/feasibility.md) | Background: competition, inventory, channels, unit economics |
| [docs/architecture.md](docs/architecture.md) | How the code is organised and how money flows |
| [docs/build-journal.md](docs/build-journal.md) | How the project was built, decisions and lessons |
| [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) | Releases and security policy |

## Status: v0.4.0, Phase 3 (pooled programmatic network) in progress

**New in v0.4.0:** OpenRTB 2.6 DOOH gateway (programmatic fill from connected SSPs), operator quality scores that gate programmatic demand, inventory forecasts, OpenOOH venue metadata.

**v0.3.0:** operator SaaS billing on Stripe Billing: per-screen subscriptions, trials, a free tier and design-partner comps.

**v0.2.0:** Stripe Connect payouts to operators and venues · Square POS menu sync · ad templates with live preview · venue open hours · Raspberry Pi kiosk with HDMI-CEC TV power control ([scripts/pi](scripts/pi)) · remote screen commands · email notifications · audit log. See the [CHANGELOG](CHANGELOG.md).

### Phase 1 (v0.1.0)

- Multi-tenant operators with white-label branding and a self-serve advertiser signup link
- Roles: platform admin, operator admin, venue manager, advertiser
- Device pairing: the player shows a code, and the operator enters it in the console
- Screen modes: **menu board** (ads capped at about 20%), **idle**, **signage**
- Menu board editor with sold-out items, rendered full screen by the player
- Campaigns: geo radius, venue category, dayparts, category blocklists, priority tiers, share of voice, prepaid CPM budgets, a review workflow
- Network campaigns served to operators who opt in (the first step towards pooled programmatic demand)
- Proof-of-play with fraud checks (device auth, eligibility, minimum duration, de-duplication), priced into a **platform → operator → venue** revenue split
- Statements: operator earnings, venue revenue-share statements, campaign delivery, platform report
- Stripe Checkout prepayment (when keys are set), or "invoiced" for operators who collect payment offline
- Fleet health and offline/unpaired alerts

## Run

Requires Node 24+ (the container image and releases use Node 26). There are no dependencies to install.

```sh
npm run demo     # demo data in ./data/demo → http://localhost:8787
npm test         # unit and end-to-end API tests
npm start        # real use: set ADMIN_EMAIL / ADMIN_PASSWORD on first run
```

Or with Docker:

```sh
docker run -p 8787:8787 -v ads-data:/data -e SEED_DEMO=1 ghcr.io/roberjo/restaurant-ads:latest
```

Demo logins (password `demo1234`): `admin@platform.test`, `ops@austin.test`, `tacos@austin.test`, `dentist@austin.test`.

**Try the full loop:**
1. Open `http://localhost:8787/player/?debug=1` in one tab. It shows a pairing code.
2. Sign in as `ops@austin.test` at `/console/`, go to **Screens**, enter the code next to "Menu board (counter)" and press **Pair**.
3. The player switches to the menu board with ads mixed in. Proof-of-play shows up in **Reports** within about 30 seconds.
4. Advertiser self-serve: `/console/#/signup/austin`.

## Configuration

| Env var | Purpose |
|---|---|
| `PORT` | default 8787 |
| `DATA_DIR` | SQLite database and uploads (default `./data`) |
| `PUBLIC_URL` | base URL for payment redirects |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | create the first platform admin on an empty database |
| `SEED_DEMO=1` | seed demo data on an empty database |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | enable advertiser card prepayment, payouts and operator SaaS billing. Webhook: `POST /api/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.payment_failed`. Enable the Stripe customer portal for operators to manage cards and invoices. |
| `RESEND_API_KEY`, `EMAIL_FROM` | send notification emails (otherwise they're logged and skipped) |
| `APP_SECRET` | long random string; encrypts stored POS tokens and SSP credentials, and signs OAuth state (required for Square and authenticated SSPs) |
| `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_ENVIRONMENT` | Square menu sync (`sandbox` or `production`); OAuth redirect URL: `{PUBLIC_URL}/api/square/callback` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | instant resync on catalog changes (`POST /api/square/webhook`, event `catalog.version.updated`) |

## Development workflow

- **CI** (`ci.yml`): tests, browser-code syntax checks, shellcheck, and a container build plus smoke test on every push and PR.
- **Security** (`security.yml`, `codeql.yml`): CodeQL, Trivy (repo and image, fails on high/critical), gitleaks over the full history, dependency review on PRs, weekly scheduled scans. Dependabot keeps actions, the base image and packages current. All actions are pinned to commit SHAs.
- **Releases** (`release.yml`): bump `version` in `package.json`, add a `CHANGELOG.md` section, then `git tag vX.Y.Z && git push --tags`. CI tests, publishes `ghcr.io/roberjo/restaurant-ads:{X.Y.Z, X.Y, latest}` with provenance and an SBOM, and creates the GitHub release.
- **Versioning:** SemVer. Before 1.0, each minor version is a roadmap phase.

## Layout

```
server/src/
  app.ts            request pipeline, static hosting
  http.ts           router, body parsing, static files
  auth.ts           passwords (scrypt), sessions, device credentials, roles, rate limits
  db.ts             schema, demo seed
  scheduler.ts      playlist builder (pure)
  ledger.ts         CPM pricing and revenue split (pure, integer micro-dollars)
  payouts.ts        payout runs and Stripe Connect transfers
  billing.ts        operator SaaS subscriptions (per paired screen, Stripe Billing)
  rtb.ts            OpenRTB 2.6 DOOH gateway: bid requests, winner selection, notices
  quality.ts        operator quality score · forecast.ts inventory forecast
  stripe.ts         Checkout, Connect, webhook signature verification
  square.ts         Square OAuth, catalog → menu mapping, webhook verification
  templates.ts      ad templates (SVG)
  hours.ts          venue open hours and TV power schedule
  notify.ts         email outbox · jobs.ts background jobs · crypto.ts token encryption
  uploads.ts        content-sniffed creative uploads
  routes/           core (auth/admin/operator/audit) · network (venues/screens/menus/fleet/commands) ·
                    campaigns · device (pairing/playlist/proof-of-play/power) · reports · payouts · integrations · billing
console/            role-based web console (no build step)
player/             web player for TVs, sticks and browsers
scripts/pi/         Raspberry Pi kiosk + HDMI-CEC installer
creatives/          demo artwork
docs/               plan and design
```
