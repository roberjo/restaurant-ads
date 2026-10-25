# restaurant-ads

A platform for running **local in-venue TV ad networks**. Independent operators (AV installers, local agencies) sign up restaurants, turn an existing TV into a free menu board with ads mixed in, sell local ads, and earn from pooled national demand. The platform earns from SaaS fees, payment fees and a take rate on programmatic ads.

| Doc | What |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | **The program plan**: products, phases, architecture, operations, legal, go-to-market, KPIs, risks |
| [docs/platform-model.md](docs/platform-model.md) | Why we're an operator platform, revenue model, franchise-law guardrails |
| [docs/feasibility.md](docs/feasibility.md) | Background: competition, inventory, channels, unit economics |
| [docs/architecture.md](docs/architecture.md) | How the code is organised and how money flows |

## Status: Phase 1 (Operator MVP) built

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

Requires Node 24+. There are no dependencies to install.

```sh
npm run demo     # demo data in ./data/demo → http://localhost:8787
npm test         # unit and end-to-end API tests
npm start        # real use: set ADMIN_EMAIL / ADMIN_PASSWORD on first run
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
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | enable advertiser card prepayment (webhook: `POST /api/stripe/webhook`, event `checkout.session.completed`) |

## Layout

```
server/src/
  app.ts            request pipeline, static hosting
  http.ts           router, body parsing, static files
  auth.ts           passwords (scrypt), sessions, device credentials, roles, rate limits
  db.ts             schema, demo seed
  scheduler.ts      playlist builder (pure)
  ledger.ts         CPM pricing and revenue split (pure, integer micro-dollars)
  stripe.ts         Checkout + webhook signature verification
  uploads.ts        content-sniffed creative uploads
  routes/           core (auth/admin/operator) · network (venues/screens/menus/fleet) ·
                    campaigns · device (pairing/playlist/proof-of-play) · reports
console/            role-based web console (no build step)
player/             web player for TVs, sticks and browsers
creatives/          demo artwork
docs/               plan and design
```
