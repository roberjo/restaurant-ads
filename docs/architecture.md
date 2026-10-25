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

## Integrations and background jobs
- **Square:** OAuth (`ITEMS_READ`, `MERCHANT_PROFILE_READ`), HMAC-signed expiring `state`, tokens encrypted with AES-256-GCM using a key derived from `APP_SECRET`, automatic refresh, catalog → menu sections, signed `catalog.version.updated` webhooks, and a 30-minute resync job.
- **Jobs** (`jobs.ts`, in-process timers): offline-screen alerts (once per outage, only while the venue is open), outbox delivery (Resend, up to 5 attempts), Square resync. They move to a real queue with Postgres in Phase 2b.
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
