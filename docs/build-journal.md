# Build Journal: From Idea to Platform

How this project went from "ads on restaurant TVs" to a tested, multi-tenant platform with CI/CD. It was built as a conversation between a founder and an AI coding agent (Claude Code), with the founder making the business decisions and the agent researching, challenging, building and verifying.

---

## 1. Start with the idea, and invite pushback

The starting brief was broad: a collection of tools for a restaurant TV ad network, connecting national, regional and local ad demand to screens in local businesses through channels like Roku apps and Samsung TVs. It came with an explicit invitation: *question the feasibility, the business model, the implementation, everything.*

That invitation shaped the whole project. The first deliverable wasn't code; it was [feasibility.md](feasibility.md).

## 2. The feasibility check changed the plan

Four findings reshaped the idea:

| Assumption | Finding |
|---|---|
| "Restaurant TVs are ad inventory" | Most restaurant TVs show live sports. You can't insert ads into cable or satellite broadcasts, and venues won't interrupt the game. **Real inventory is idle time and dedicated screens.** |
| "Roku and Samsung apps are the channel" | Consumer TV apps can't force themselves to start, can't stay in the foreground, and need staff to launch them. A $30–60 kiosk stick (or a Raspberry Pi) is the reliable path. |
| "Nobody does this" | Atmosphere TV and Loop TV already run free, ad-funded venue channels across tens of thousands of venues. |
| "One screen makes money" | A single screen nets very roughly $100–300/month. **The business only works with density**: hundreds of screens in one metro. |

The useful outcome: the open questions were narrowed to three decisions only the founder could make.

## 3. Founder decisions

1. Use the TVs venues **already have** (no hardware capex).
2. Pay venues with a **revenue share plus free menu boards**.
3. Start with **no** venue, advertiser or ad-exchange relationships.

Decision 3 was the most important. Without relationships, running a network means doing the two hardest jobs, venue sales and local ad sales, from scratch.

## 4. The pivot: sell the shovels

The founder proposed building the software, integrations and playbooks so *other people* run the networks. We refined that into a model where the platform is more than a kit:

- **Operators** (AV installers, local agencies) own the local, human work: signing venues and selling local ads.
- **The platform** pools every operator's screens into one national network, which solves the density problem national ad buyers care about, and earns from SaaS fees, payment fees and a programmatic take rate.

Research also turned up a legal issue: selling a "turnkey business" can make you a **franchise** or **business opportunity** seller under FTC rules (16 CFR 436/437). The design guardrails follow from that: operators use their own brand (white-label), fees are usage-based, there are no earnings claims, and the first customers are existing businesses rather than first-time entrepreneurs. Details are in [platform-model.md](platform-model.md).

## 5. Plan the whole program before building

[roadmap.md](roadmap.md) covers everything needed to *run the business*, not just the software:

- 13 products, from the ad server to the operator enablement kit
- 5 phases, each with measurable exit criteria (e.g. Phase 1: one operator, 10 venues, 30 days, ≥95% uptime)
- target architecture, data model, integrations, device strategy
- team plan, support model, go-to-market, legal checklist, financial checkpoints, KPIs and a risk register

## 6. Building Phase 1

### Architecture choices
- **Zero runtime dependencies.** Node 24's built-in TypeScript type-stripping and `node:sqlite` mean `npm install` isn't needed, there's no supply-chain surface to patch, and the code is easy to read. Postgres is planned for Phase 2.
- **Proof-of-play is the financial source of truth.** Each verified ad play is priced and split (platform → operator → venue) at write time, in **integer micro-dollars**. Every statement is then a `SUM` over plays, which makes them reproducible and auditable.
- **Tenant isolation everywhere.** Every query is scoped to the caller's operator. Out-of-scope records return 404 rather than 403, so IDs from other tenants aren't revealed.
- **Thin, offline-first players.** The server builds playlists; the player caches them and keeps running without a network.
- **Billing fraud is a first-class concern.** Plays are rejected if the campaign couldn't have served on that screen (wrong operator, blocked category, outside the geo radius, daypart or flight), if the play was too short, or if the timestamp is stale.

### Testing strategy
- Pure functions (scheduler, pricing, revenue split, webhook signatures) get unit tests.
- An end-to-end API suite starts the real server against an in-memory database and covers the risky flows: tenant isolation, pairing, proof-of-play fraud cases, exact money splits, the campaign review and payment flow, budget exhaustion, and venue-manager permissions.
- Then a **real browser run**: the player shows a pairing code, the operator pairs it in the console, the TV switches to a menu board with ads mixed in, and the real proof-of-play shows up in the ledger with the expected split.

### Bugs caught by verification, not by review
- The player page returned 404: an empty path normalized to `.` (the directory) instead of `index.html`.
- Duplicate proof-of-play events were correctly ignored but not counted anywhere. They're now reported explicitly as `duplicates`.
- Static files didn't answer `HEAD` requests, which load balancers and uptime monitors use.

## 7. Shipping it

- **Privacy before publishing:** commits were rewritten to GitHub's no-reply address before the repo went public.
- **CI:** tests, syntax checks, shellcheck and a container smoke test on every push and PR.
- **Security:** CodeQL (security-extended), Trivy scans of the repo and container image, gitleaks over the full history, dependency review on PRs, Dependabot. Every third-party action is **pinned to a commit SHA**.
- **Hardening:** per-area Content-Security-Policy (uploads and creatives are sandboxed), frame denial, `nosniff`, `no-store` on the API, Subresource Integrity on CDN assets, a non-root container with a health check.
- **Releases:** pushing a `vX.Y.Z` tag runs the tests, checks the tag matches `package.json`, publishes a multi-tag image to GHCR with provenance and an SBOM, and creates a GitHub release from the changelog.

## 8. By the numbers (v0.1.0)

| | |
|---|---|
| Server (TypeScript) | ~2,000 lines, 0 runtime dependencies |
| Console (HTML/CSS/JS, no build step) | ~950 lines |
| Player | ~230 lines |
| Tests | 20 (unit + end-to-end API) |
| Planning docs | ~550 lines |

## 9. Lessons

1. **Ask to be challenged.** The most valuable output of the first hour was being told where the idea was weakest. The pivot came from that.
2. **Decide the business model before the architecture.** Multi-tenancy, white-labelling and pooled supply only appear in the code because of the operator-platform decision.
3. **Put the money logic in pure functions and test it to the micro-dollar.**
4. **Run the real thing.** Three bugs that passed review were found by running the server and player end to end.
5. **Legal shapes the product.** Franchise-law guardrails decided features such as white-labelling and how fees work.

---

*Next: Phase 2, covering payouts, the kiosk player, POS menu sync, creative templates, notifications and production infrastructure. See [roadmap.md](roadmap.md).*
