# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions map to roadmap phases.

## [Unreleased]

## [0.5.0] - 2026-10-26

Phase 3 (part 2): selling the pooled network.

### Added
- **Private marketplace (PMP) deals:** the platform admin registers deal IDs agreed with an SSP. Each deal has a buyer, floor CPM, first-price or fixed-price pricing, optional buyer seats, venue-type and operator targeting, and optional dates.
  - Matching screens send the deals in `imp.pmp` on every auction.
  - Deal bids must name an offered deal, meet its floor and come from an allowed seat.
  - A private deal shuts out open-market bids.
  - Wins record their deal. Each deal shows plays and gross revenue.
  - Deals are disabled, not deleted.
- **Deal avails:** a forecast of the unsold inventory a deal's targeting reaches, for sizing a deal with a buyer.
- **Forecast net of sold campaigns:** capacity per bucket is now split into sold and available.
  - Sold time comes from simulating each hour's loop from active campaigns, both the operator's own and opted-in network campaigns, using the real scheduler. Each campaign is capped by its remaining budget.
  - New fields: `soldSeconds`, `soldImpressions`, `availableSeconds`, `availableImpressions` and `sellThroughPct` per bucket, plus a per-campaign delivery outlook (`byCampaign`) that flags campaigns whose budget runs out within the window.
  - `GET /api/forecast?venueTypes=` narrows the forecast to venue types. Campaign budgets are still shared with screens outside the filter.
- Console:
  - The dashboard capacity card shows sold vs. available, and there's a campaign delivery table.
  - The Pooled network page shows available inventory and network campaign delivery.
  - The Programmatic page has deals, with an avails view.

### Changed
- Forecast days (`byDay`) are now venue-local dates, not UTC dates.

## [0.4.0] - 2026-10-26

Phase 3 (part 1): the pooled programmatic network.

### Added
- **OpenRTB 2.6 DOOH gateway:** unsold ad time (after direct, local and network campaigns) is auctioned across connected SSPs when a screen fetches its playlist, while the venue is open.
  - Bid requests include the `dooh` object (OpenOOH venue type), `qty.multiplier`, an out-of-home device with location, `bcat` built from the venue's blocked categories, and per-SSP floors and timeouts.
  - The best valid bid per impression wins. Creatives are VAST (MP4 or static image), an image tag or an image URL, over https only.
  - Win notices (`nurl`) fire on selection. Billing notices (`burl`) and VAST impression pixels fire after proof-of-play, with OpenRTB macros substituted. Notice URLs that resolve to private or local addresses are refused.
  - Each win plays once, and proof-of-play verifies it: right screen, within its expiry, long enough, never billed twice. It's then split like any other play using the network take rate.
  - Programmatic plays appear in operator and venue reports. They're included in payouts only up to the "SSPs have paid through" date set by the platform admin.
  - Admin Programmatic page: connect, enable and disable SSPs (credentials encrypted with `APP_SECRET`), auction count, fill rate, wins and revenue by SSP, notice delivery, settlement date.
- **Venue and screen metadata for programmatic buyers:** OpenOOH venue type per venue (defaults from the venue category), and screen resolution, diagonal size and audio.
- **Operator quality score** (last 7 days): uptime during open hours from hourly player activity (60%), venue/screen details complete (20%), plays passing proof-of-play verification (20%). Operators need 24 open screen-hours of history and a score of at least 80 (a platform setting) to receive programmatic demand. The platform admin can always allow or pause an operator.
- **Inventory forecast:** ad capacity and impressions for the next 1–30 days by venue type, daypart, venue and day, for each operator and for the pooled network of eligible operators.
- Console: programmatic readiness and capacity on the operator dashboard, venue type and screen size fields, admin Pooled network page.

## [0.3.0] - 2026-10-26

Completes Phase 2's money movement: the platform can now bill operators. Postgres and object storage are deferred until operator count needs them (see roadmap).

### Added
- **Operator SaaS billing** (Stripe Billing): per-paired-screen monthly subscription with a free trial, started from Settings → Billing through Stripe Checkout. The subscription quantity follows paired screens with proration (on pairing changes and hourly). Operators manage cards and invoices in the Stripe customer portal.
- Free tier (default 2 screens) and design-partner comps (`free until` date) managed by the platform admin; the plan price, trial length and free screens are platform settings.
- Lapsed billing blocks pairing new screens (`402`) but never stops screens that are already playing.
- Emails for failed subscription payments and trials ending soon.
- Platform admin billing page: SaaS MRR, paying and trialing operators, billed screens.

## [0.2.1] - 2026-10-25

### Changed
- Container image runs on Node 26 (was Node 24). CI tests on Node 24 and 26; releases are tested on 26. Node 24 remains supported for running from source.

## [0.2.0] - 2026-10-25

Phase 2 (part 1): money movement and pilot hardening. See [docs/roadmap.md](docs/roadmap.md#phase-2-pilot-hardening-and-money-movement-1--5-operators).

### Added
- **Stripe Connect payouts:** Express onboarding for operators and venues, payout runs that pay each party's share of card-paid campaigns exactly once, $1 minimum with sub-cent carry-forward, idempotent transfers, retry of failed/awaiting payouts, payout history per role.
- **Square POS menu sync:** OAuth connect with signed state, tokens encrypted at rest (AES-256-GCM), catalog → menu sections with prices and sold-out items, token refresh, signed webhooks (`catalog.version.updated`), and a 30-minute background resync.
- **Ad templates:** bold / split / photo layouts rendered to 1920×1080 SVG with live preview in the console, for campaign ads and venue promos.
- **Venue open hours** (including past-midnight ranges): offline alerts only while open, reach estimates from real hours, and a TV power schedule.
- **Raspberry Pi player kit** (`scripts/pi`): installer, kiosk autostart, and an HDMI-CEC agent that powers the TV on/off with venue hours.
- **Remote screen commands:** identify, reload, clear cache, refresh playlist.
- **Email notifications** via a transactional outbox (Resend): campaign submitted/approved/rejected, screen offline (once per outage), payout sent.
- **Audit log** of every authenticated change, including refused attempts, with a console view.
- Background job runner; schema migrations (`PRAGMA user_version`); `/api/device/power`.
- Operator report shows platform fees owed on campaigns the operator invoiced directly.

### Fixed
- Payout status no longer offers onboarding when Stripe isn't configured.
- Outbound email now uses the configured HTTP client.

## [0.1.0] - 2026-10-25

Phase 1: Operator MVP. See [docs/roadmap.md](docs/roadmap.md).

### Added
- Multi-tenant operators with white-label branding and a self-serve advertiser signup page.
- Roles: platform admin, operator admin, venue manager, advertiser. Scrypt password hashing, hashed bearer sessions, login rate limiting.
- Device self-registration with 6-character pairing codes; device-authenticated playlist, menu, heartbeat and proof-of-play APIs.
- Screen modes (`menu`, `idle`, `signage`) and a menu-board editor with sold-out items, rendered full screen by the player.
- Scheduler: geo radius, venue category, dayparts in the venue's timezone, category blocklists, priority tiers, share-of-voice caps, interleaving.
- Campaign lifecycle (draft → review → active/paused → completed/rejected) with prepaid CPM budgets enforced when serving and when recording plays.
- Network campaigns served to operators who opt in.
- Proof-of-play fraud checks (eligibility, minimum duration, timestamp window, de-duplication) and a per-play platform/operator/venue revenue split in integer micro-dollars.
- Reports: operator earnings, venue revenue-share statements, campaign delivery, platform totals.
- Stripe Checkout prepayment with webhook signature verification; "invoiced" mode for offline collection.
- Fleet health with offline/unpaired alerts.
- Role-based web console with map targeting and reach estimates; offline-capable web player.
- Container image, health endpoint, CI (tests, shellcheck, container smoke test), CodeQL, Trivy, gitleaks, dependency review, Dependabot, tag-driven releases to GHCR.

### Security
- Content-Security-Policy per area (strict for the console, sandboxed for uploads and creatives), `X-Frame-Options: DENY`, `nosniff`, `no-store` on the API, Subresource Integrity on CDN assets.

[Unreleased]: https://github.com/roberjo/restaurant-ads/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/roberjo/restaurant-ads/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/roberjo/restaurant-ads/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/roberjo/restaurant-ads/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/roberjo/restaurant-ads/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/roberjo/restaurant-ads/releases/tag/v0.1.0
