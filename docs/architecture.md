# Architecture

See [roadmap.md §4](roadmap.md#4-architecture) for the target architecture. This page covers what's built.

```
 Advertiser ──┐   console/ (role-based SPA)          player/ (web, any TV)
 Operator   ──┼──▶  Bearer session  ─┐        ┌──  Device <id>.<secret>
 Venue mgr  ──┤                      ▼        ▼
 Platform   ──┘              server/src/app.ts  (node:http, no dependencies)
                     ┌──────────────┬───────────────┬──────────────┬─────────────┐
                 routes/core   routes/network  routes/campaigns  routes/device  routes/reports
                     └──────────────┴───────┬───────┴──────────────┴─────────────┘
                              scheduler.ts · ledger.ts · stripe.ts · uploads.ts
                                            node:sqlite (data/app.sqlite)
```

## Tenancy and roles

| Role | Scope | Can |
|---|---|---|
| `platform_admin` | everything; picks an operator via `?operatorId=` | onboard operators, network campaigns, take rate, platform report |
| `operator_admin` | own operator | venues, screens, pairing, menus, advertisers, campaign review, reports, branding, rate card |
| `venue_manager` | own venue | menu board, ad category blocklist, house promos, own statement (earnings only) |
| `advertiser` | own advertiser | create campaigns at the operator's rate card, upload ads, pay, view delivery |

All access checks go through `requireRole` / `actingOperatorId` and per-entity loaders (`venueFor`, `screenFor`, `campaignFor`). Rows outside the caller's scope return 404, so other tenants' IDs aren't revealed.

## Device lifecycle

1. `POST /api/device/register` → `{deviceId, deviceSecret, pairingCode}`. The secret is stored as a SHA-256 hash.
2. The player polls `GET /api/device/state` and shows the code (valid for 24h, refreshed automatically).
3. The operator calls `POST /api/screens/:id/pair {code}`, which binds the device to the screen and its operator.
4. The player fetches `GET /api/device/playlist` (TTL 5 min) and `GET /api/device/menu`, caches creatives, and plays offline when needed.
5. The player posts `POST /api/device/pop` (batched every 30s) and `POST /api/device/heartbeat` (every 60s), which drive fleet status.

## Playlist rules

- Eligible campaigns: `active`, budget remaining, owned by the screen's operator **or** a network campaign when the operator has opted in, and passing the scheduler's checks (flight dates, geo radius, venue category, daypart in the venue's timezone, venue blocklist).
- Filled by tier (`sponsorship` > `direct` > `local` > `programmatic`), weighted round-robin, with a share-of-voice cap per campaign, up to the screen's ad share.
- The rest of the loop is house content. In **menu** mode that's the menu board; **idle** mode uses venue promos plus the menu; **signage** mode uses promos only.

## Money flow (per verified ad play)

```
impressions = venue.audience_multiplier
gross       = impressions × CPM / 1000                 (capped at the remaining budget)
platform    = gross × (local: operator.platform_fee_pct | network: settings.network_take_pct)
venue       = (gross − platform) × venue.rev_share_pct
operator    = gross − platform − venue                 (absorbs rounding)
```
Amounts are integer micro-dollars stored on each `pop_events` row, so every statement is a `SUM` over proof-of-play and is reproducible. A campaign moves to `completed` when it has spent its budget.

**Proof-of-play is rejected** when the device isn't authenticated, the campaign couldn't have been served to that screen (wrong operator, blocked category, outside geo/daypart/flight), the creative doesn't belong to the campaign, the play was shorter than 80% of the creative, or the timestamp is more than 7 days old or in the future. Duplicates (same device and event ID) are ignored.

## Campaign lifecycle

```
draft ──submit──▶ pending_review ──approve*──▶ active ⇄ paused
  ▲                    │                         │
  └──── (edit) ◀── rejected ◀───────reject───────┘        active ──budget spent──▶ completed
* approve requires payment_status = paid (Stripe webhook) or invoiced (operator collects offline)
```

## Payouts (Stripe Connect)

```
card-paid campaign plays ──▶ payout run (platform admin, closed period) ──▶ payouts rows ──▶ Stripe transfers
   pop_events.operator_payout_id / venue_payout_id link each play to exactly one payout
```
- Only campaigns with `payment_status = 'paid'` (money held by the platform's Stripe account) are paid out. For **invoiced** campaigns the operator collected the money; the operator report shows the platform fee owed.
- Each payout = earned micros + the previous payout's remainder; it transfers whole cents only if ≥ $1.00, otherwise everything carries forward (`below_minimum`).
- Transfers use the payout ID as the Stripe idempotency key, so retries can't double-pay. Statuses: `pending → paid | failed | awaiting_account`.

## Operator SaaS billing (Stripe Billing)

```
operator ──Checkout (mode=subscription, per-screen price, trial)──▶ Stripe ──webhooks──▶ re-fetch subscription ──▶ operators.billing_*
pair/unpair screen ──▶ subscription item quantity = paired screens (prorated); hourly job reconciles
```
- **Plan** (platform settings): price per paired screen per month (default $15), trial days (30), and free screens without a subscription (2). Price changes only apply to new subscriptions.
- **Design partners:** the platform admin can comp an operator until a date (`free_until`).
- **Enforcement:** without good standing (`active`, `trialing`, or `past_due` while Stripe retries), pairing beyond the free screens returns `402`. Screens that are already paired **keep playing**, so an operator's billing problem never hurts venues or paying advertisers. Replacing a screen's device is always allowed.
- **Source of truth:** every `customer.subscription.*` event re-fetches the subscription from Stripe, so out-of-order or replayed events can't regress state. Subscriptions that don't belong to an operator (other products on the same Stripe account) are ignored. Failed payments and trial endings email the operator's admins once per invoice or subscription.
- Operators manage cards and download invoices in the Stripe customer portal.

## Pooled network readiness
- **Activity:** each player heartbeat and proof-of-play batch updates `screen_activity` (per screen per UTC hour: heartbeats, verified plays, rejected plays).
- **Quality score** (`quality.ts`, last 7 days): `0.6 × uptime + 0.2 × metadata + 0.2 × compliance`. Uptime counts only open hours (venue hours) after the device was set up. Metadata checks venue type, hours and address per venue, and diagonal size per screen. Compliance is the share of reported plays that passed verification. Programmatic access requires 24 open screen-hours of history and a score ≥ `programmatic_min_quality` (default 80), unless the platform admin overrides it (`allow` / `deny`).
- **Forecast** (`forecast.ts`): per open hour, capacity = 3600 s × screen ad share; impressions = ad seconds / 10 s × venue audience multiplier.
  - Sold time comes from running the real scheduler for each screen-hour over its active campaigns: its own campaigns plus network campaigns if the operator opted in.
  - Each campaign's sold time is then scaled down if its forecast impressions exceed what its remaining budget buys. The scaling assumes even spend, which is an approximation since real spend front-loads.
  - Available = capacity − sold.
  - A venue-type filter limits what's reported but still simulates every screen, because they all draw on the same budgets.

## Programmatic (OpenRTB 2.6 DOOH)

```
GET /api/device/playlist ──▶ schedule direct/local/network campaigns ──▶ leftover ad seconds ≥ 15 and venue open?
   └─▶ one bid request (≤ 4 imps of 15 s) to every enabled SSP, in parallel, per-SSP floor and timeout
        └─▶ best valid bid per imp ──▶ rtb_wins + nurl ──▶ slot `rtb:<win>` (once: true) in the playlist
POST /api/device/pop ──▶ verify win (screen, expiry, duration, not yet played) ──▶ price × multiplier / 1000
   └─▶ split with network take ──▶ pop_events.rtb_win_id ──▶ burl + VAST impression pixels queued
```
- **Eligibility:** the operator has opted into network demand and passes the quality gate (cached for 10 minutes), at least one SSP is enabled, and the venue is open.
- **Request:** `dooh` (OpenOOH venue type, publisher = operator), `qty` (venue audience multiplier, publisher-provided), device type 8 (OOH) with location, `bcat` mapped from the venue's blocked categories, first-price auction, USD.
- **Validation:** response ID must match, price ≥ the SSP's floor, no blocked categories, a playable https creative of 15 s or less.
- **Notices** (`rtb_notices`) are delivered by a background job every 5 s with retries. URLs resolving to private, loopback or link-local addresses are refused.
- **Settlement:** SSPs pay the platform 30–60 days after month end. Payout runs include programmatic plays only up to `rtb_settled_through`, which the platform admin sets.
- SSP credentials are encrypted with `APP_SECRET` and never returned by the API.
- **PMP deals** (`rtb_deals`):
  - Deals that are enabled, in date (venue-local) and match the screen's venue type and operator are sent in `imp.pmp` to their SSP, with deal floor, `at` (1 first price, 3 fixed price) and `wseat`.
  - A bid with `dealid` must name one of those deals, meet its floor and come from an allowed seat. Bids without one use the SSP floor and are refused when any offered deal is private.
  - The highest valid price still wins each imp; deals aren't otherwise prioritised.
  - `rtb_wins.deal_id` attributes revenue to the deal.

## Integrations and background jobs
- **Square:** OAuth (`ITEMS_READ`, `MERCHANT_PROFILE_READ`), HMAC-signed expiring `state`, tokens encrypted with AES-256-GCM using a key derived from `APP_SECRET`, automatic refresh, catalog → menu sections, signed `catalog.version.updated` webhooks, and a 30-minute resync job.
- **Jobs** (`jobs.ts`, in-process timers): offline-screen alerts (once per outage, only while the venue is open), outbox delivery (Resend, up to 5 attempts), Square resync, billing quantity reconciliation (hourly), programmatic notices (every 5 s). They move to a real queue with Postgres in Phase 2b.
- **Audit log:** every authenticated non-GET request (including refused ones) is recorded with user, operator, path, status and IP.

## Devices: commands and power
- `POST /api/screens/:id/commands` queues `identify | reload | clear_cache | refresh_playlist`; the player receives commands in its heartbeat response and acknowledges each one once.
- `GET /api/device/power` returns `on | standby` from venue hours (±15 min). The Raspberry Pi agent turns that into HDMI-CEC commands. It deliberately isn't a heartbeat.

## Schema migrations
`openDb` applies ordered migrations tracked by `PRAGMA user_version`, each in a transaction. Inserts name their columns, so adding columns is safe.

## Known limits
- SQLite and local-disk uploads: move to Postgres/PostGIS plus object storage/CDN.
- Paused campaigns can still bill plays from players working offline on a cached playlist (bounded by budget).
- Android/Fire TV kiosk wrapper not built yet; use the Raspberry Pi kit or a signage browser.
- Background jobs run in-process; with multiple instances they must move to a queue.
