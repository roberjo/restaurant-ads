# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions map to roadmap phases.

## [Unreleased]

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

[Unreleased]: https://github.com/roberjo/restaurant-ads/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/roberjo/restaurant-ads/releases/tag/v0.1.0
