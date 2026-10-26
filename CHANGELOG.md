# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions map to roadmap phases.

## [Unreleased]

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

[Unreleased]: https://github.com/roberjo/restaurant-ads/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/roberjo/restaurant-ads/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/roberjo/restaurant-ads/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/roberjo/restaurant-ads/releases/tag/v0.1.0
