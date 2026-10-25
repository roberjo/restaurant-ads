# Architecture (Phase 1)

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

## Known Phase 1 limits (addressed in Phase 2)
- SQLite and local-disk uploads: move to Postgres/PostGIS plus object storage/CDN.
- Paused campaigns can still bill plays from players working offline on a cached playlist (bounded by budget).
- No payouts yet: statements show what's owed. Stripe Connect comes in Phase 2.
- Kiosk/auto-boot/HDMI-CEC need the native Android wrapper.
- Reach estimates assume 12 open hours/day; venue open hours come in Phase 2.
