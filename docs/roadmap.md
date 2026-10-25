# Program Roadmap

The full plan for building a **platform that lets independent operators run local in-venue TV ad networks**, with every operator's screens pooled into one national network. It builds on [platform-model.md](platform-model.md) (the business model) and [feasibility.md](feasibility.md) (the background).

---

## 1. Goal and operating model

**Goal:** an AV installer or local agency can sign up, pair a restaurant's existing TV in under 10 minutes, give the venue a free menu board, sell local ads the same week, and earn national programmatic revenue once the pooled network has enough screens. We earn from SaaS fees, payment fees and a take rate on programmatic ads.

```
            ┌──────────────── PLATFORM (us) ────────────────┐
 National ─▶│ SSP/OpenRTB DOOH  ·  Network campaigns         │
 demand     │ Ledger & payouts  ·  Fleet/device mgmt         │
            │ Scheduler/ad server · Measurement · Compliance │
            └──────▲─────────────────▲──────────────────▲────┘
                   │ white-label     │                  │ device API
        ┌──────────┴──────┐   ┌──────┴────────┐   ┌─────┴──────────┐
        │ OPERATOR        │   │ ADVERTISER    │   │ PLAYER         │
        │ console         │   │ self-serve    │   │ stick/TV/browser│
        │ (sells locally) │   │ (local SMB)   │   └─────┬──────────┘
        └──────┬──────────┘   └───────────────┘         │ HDMI
               │ signs                                  ▼
        ┌──────┴──────────┐                       existing venue TV
        │ VENUE portal    │◀── revenue share + free menu boards
        └─────────────────┘
```

### Stakeholders and what each needs

| Stakeholder | Needs from us | Pays us |
|---|---|---|
| **Platform (us)** | Network quality, density and compliance | — |
| **Operator** | Easy installs, local ad sales tools, payouts, programmatic fill, white-label branding | SaaS per screen, payment fees, programmatic take rate |
| **Venue** (restaurant) | Good menu board, no hassle, revenue-share income, control over which ad categories appear | Nothing (paid a revenue share) |
| **Local advertiser** | Fast self-serve buying, a clear audience area, proof the ads ran, low minimum spend | Ad spend (through the operator) |
| **National buyer / SSP** | Scale, trustworthy proof-of-play, impression measurement, standard OpenRTB integration | Ad spend (through the SSP) |

---

## 2. Product suite

| # | Product | Users | Summary |
|---|---|---|---|
| P1 | **Ad server and scheduler** | system | Targeting, tiers, share of voice, budget and pacing; builds a playlist for every screen |
| P2 | **Player** | screens | Web player plus native kiosk wrappers; offline-first, proof-of-play, heartbeats, pairing, menu rendering |
| P3 | **Device and fleet management** | operator, platform | Pairing, provisioning, health, alerts, remote commands, OTA updates |
| P4 | **Operator console** | operator | Venues, screens, menus, advertisers, campaign review, reports, branding, rate card |
| P5 | **Venue portal** | venue | Menu editor, statements, ad category blocklist, own promos |
| P6 | **Advertiser self-serve** | local SMB | White-label signup, map radius targeting, creative upload/templates, checkout, reports |
| P7 | **Menu boards** | venue, operator | Templates and themes, sold-out items, POS sync (Square → Toast → Clover), dayparted menus |
| P8 | **Ledger, billing and payouts** | everyone | Per-play revenue split, statements, Stripe Checkout, Stripe Connect payouts, SaaS billing, tax forms |
| P9 | **Programmatic gateway** | platform | OpenRTB 2.6 DOOH supply to SSPs, floors, deals/private marketplaces, pooled inventory |
| P10 | **Measurement and analytics** | everyone | Audience multipliers, impression estimates, forecasting, QR/promo-code attribution |
| P11 | **Trust and safety** | platform, operator | Creative review, category policy, audit log, operator quality scores, takedowns |
| P12 | **Operator enablement kit** | operator | Installer guide, pitch decks, contract templates, rate-card guidance, training/certification, docs site |
| P13 | **Platform admin** | us | Operator management, network campaigns, SSP config, global policy, support tools |

---

## 3. Feature roadmap by phase

### Phase 0: Foundations ✅ (done)
- Scheduler (geo radius, venue category, daypart, blocklist, tiers, share-of-voice cap, interleaving)
- Web player (offline cache, proof-of-play queue, heartbeats)
- Proof-of-play ingestion with de-duplication; campaign report

### Phase 1: Operator MVP (0 → first design-partner operator) ✅ built (pending design-partner validation)
**Goal:** one operator can run 10 venues end to end with manual payment collection.

| Area | Features |
|---|---|
| Tenancy and auth | Operators as tenants; users with roles (`platform_admin`, `operator_admin`, `venue_manager`, `advertiser`); hashed passwords; bearer sessions; every query scoped to the tenant |
| White-label | Operator slug, brand name and colour; branded advertiser signup page |
| Device pairing | Player self-registers and shows a 6-character code; operator enters the code to bind the device to a screen; devices authenticate with their own secret |
| Screens | Modes: `menu` (full-time menu board with ads at 15–20%), `idle` (ads plus house content), `signage`; ad share per screen |
| Menu boards | Structured menu editor (sections, items, prices, sold-out); themed full-screen renderer in the player |
| Campaigns | Draft → pending review → active → paused/completed/rejected; prepaid CPM budgets; budget cap enforced at serve time and at ingestion |
| Creatives | Image/video upload with type and size checks; reviewed with the campaign |
| Network campaigns | Platform-owned campaigns served to operators who opt in (the first step towards pooled demand) |
| Ledger | Each verified play is priced (impressions × CPM) and split platform → operator → venue in integer micro-dollars |
| Statements | Operator earnings, per-venue revenue-share statements, campaign delivery reports |
| Payments | Stripe Checkout for advertiser prepayment when configured (webhook verified); otherwise "invoiced" for operators who collect offline |
| Fleet health | Online/offline/unpaired status per screen; alert list |
| Proof-of-play integrity | Device-authenticated; rejects campaigns not eligible for that screen; minimum play duration |
| Consoles | One web console with role-based views for all four roles |

**Exit criteria:** a design partner runs ≥10 venues for 30 days with ≥95% screen uptime, ≥3 paying local advertisers, and statements that reconcile with proof-of-play events.

### Phase 2: Pilot hardening and money movement (1 → 5 operators)

**Status (v0.2.0):**

| Item | Status |
|---|---|
| Stripe Connect payouts (operators and venues) | ✅ built |
| Square POS menu sync (OAuth, webhooks, periodic sync) | ✅ built |
| Creative templates | ✅ built (SVG; video transcoding still to do) |
| Notifications (email outbox) | ✅ built (SMS still to do) |
| Venue open hours, closed-hours alert suppression | ✅ built |
| Remote device commands (reload, identify, clear cache) | ✅ built (screenshot still to do) |
| Audit log, schema migrations, background jobs | ✅ built |
| HDMI-CEC power/input control | ✅ via the **Raspberry Pi kit**. Android/Fire TV apps generally can't send CEC, so the Pi is the CEC path. |
| Android/Fire TV kiosk app | ⏳ next (needs an Android build toolchain in CI) |
| Operator SaaS billing (Stripe Billing) | ⏳ next |
| Postgres + PostGIS, object storage/CDN | ⏳ next (needed before ~50 operators) |
| Error tracking, SSO | ⏳ next |
- **Android/Fire TV kiosk app** (Kotlin wrapper around the web player): auto-boot, device-owner/kiosk mode, HDMI-CEC power and input scheduling, watchdog restart, OTA updates. Includes the **pre-imaged device provisioning** flow.
- **Stripe Connect** (Express accounts) for operators and venues: automatic payouts, 1099-K handled by Stripe, platform application fees.
- **Operator SaaS billing:** per active screen per month, via Stripe Billing.
- **Square POS menu sync** (Catalog API plus webhooks): prices, item availability, images.
- Creative **templates** (an advertiser types text, picks a photo and colour, and a 1920×1080 ad is generated), plus a video transcoding pipeline.
- Notifications (email/SMS): campaign approved, screen offline, statement ready.
- Infrastructure: **Postgres + PostGIS**, object storage and a CDN for creatives, background job queue, migrations, backups, audit log, rate limiting, error tracking.
- Venue open hours: no "offline" alerts when the venue is closed; CEC power schedule follows open hours.
- Remote device commands: reload, screenshot, reboot.

**Exit:** 5 operators, 150+ screens, automated payouts, less than 1 support ticket per screen per quarter.

### Phase 3: Pooled network (programmatic)
- **OpenRTB 2.6 DOOH gateway:** bid requests per eligible slot, with `dooh` object, venue type (OpenOOH taxonomy), impression multiplier and floors; win notices and billing pixels via proof-of-play.
- Onboard 1–2 SSPs (Vistar, Place Exchange, Hivestack). Typically needs 500–1,000+ screens and good venue metadata.
- Private marketplace (PMP) deals and network-wide direct campaigns sold by the platform.
- **Measurement:** venue foot-traffic data (POS transaction counts, third-party data), audience multiplier methodology, third-party verification readiness.
- Inventory forecasting (available impressions by geography, venue type and daypart) for the operator sales team and SSPs.
- Operator quality score (uptime, ad compliance, data accuracy), which gates access to programmatic demand.

**Exit:** programmatic demand fills ≥20% of available ad seconds across the network.

### Phase 4: Scale
- Toast and Clover POS integrations (Toast needs partner approval: start early).
- Samsung Tizen / LG webOS signage apps; Roku channel as a no-hardware onboarding path.
- QR-code and promo-code attribution for local advertisers (the strongest renewal driver).
- AI-assisted creative generation and copy; automatic content moderation.
- Advanced pacing (even delivery across the flight), frequency caps per venue, competitive separation.
- Operator mobile app (install wizard, photo checklist, field service).
- Data warehouse and BI; network-level reporting for buyers.

### Phase 5: Ecosystem
- Public API/SDK for operators and integrators; webhooks.
- Partner program, operator certification, marketplace for installers and creative services.
- Hardware financing/leasing partners; insurance guidance.
- International (currencies, tax, privacy regimes).

---

## 4. Architecture

### 4.1 Current (Phase 1): a deliberately simple modular monolith
- Node 24 (native TypeScript), `node:http`, `node:sqlite`, no runtime dependencies.
- Modules: `http` (router), `auth`, `db` (schema/seed), `scheduler`, `ledger`, `payments/stripe`, `routes/*` (one per product area).
- Static apps: `console/` (role-based SPA) and `player/` (web player).
- Uploads on local disk.

### 4.2 Target (Phase 2–3)
```
            CDN (creatives, player bundle, console)
                         │
  ┌──────────────── API (stateless, horizontally scaled) ─────────────────┐
  │ auth · tenancy · operators · venues · screens · campaigns · menus     │
  │ device API (high QPS, cached playlists) · ledger · reports            │
  └───────┬───────────────┬──────────────────┬──────────────┬─────────────┘
          │               │                  │              │
   Postgres+PostGIS   Redis (playlist    Job queue      Object storage
   (system of record) cache, rate-limit) (transcode,    (creatives, menu
                                         POS sync,      images, screenshots)
                                         payouts, alerts)
          │
   Event pipeline: proof-of-play → append-only store → warehouse (BigQuery/ClickHouse)
          │
   Programmatic gateway (separate service, low latency) ⇄ SSPs (OpenRTB 2.6 DOOH)
```

**Key design principles:**
1. **Proof-of-play is the financial source of truth.** It's append-only and de-duplicated by event ID; ledger entries derive from it, and statements are reproducible.
2. **Money as integers** (micro-dollars); split rules are versioned so past statements never change.
3. **Tenant isolation everywhere:** every row has an `operator_id`; authorization is checked in one place.
4. **Offline-first devices:** a player must run for 24h+ without a network, using a cached playlist and creatives and a queued proof-of-play log.
5. **The server builds playlists; players are thin.** This keeps targeting and pricing logic in one auditable place.
6. **White-label by configuration**, not by forking code.

### 4.3 Data model (Phase 1)
`operators` · `users` · `sessions` · `venues` · `screens` · `devices` · `menus` · `advertisers` · `campaigns` · `creatives` · `pop_events` (with ledger split columns) · `settings`

### 4.4 Security and privacy
- No cameras or audience PII. Audience is estimated from venue-level counts (avoids biometric privacy laws such as Illinois BIPA, and avoids privacy backlash).
- Passwords hashed with scrypt; session and device tokens stored only as hashes; Stripe webhook signature checks.
- Phase 2: SSO for operators, audit log, SOC 2-ready logging, per-tenant rate limits.

---

## 5. Integrations

| Integration | Phase | Purpose | Notes |
|---|---|---|---|
| Stripe Checkout | 1 | Advertiser prepayment | REST, no SDK; webhook signature verified |
| Stripe Connect + Billing | 2 | Operator/venue payouts, SaaS billing | Express accounts; Stripe handles KYC and 1099-K |
| Square Catalog API | 2 | Menu sync | OAuth per venue |
| Toast, Clover | 4 | Menu sync | Toast partner program has a long lead time |
| SSPs (Vistar, Place Exchange, Hivestack) | 3 | Programmatic demand | OpenRTB 2.6 DOOH; commercial agreements needed |
| Email/SMS (Postmark/Resend, Twilio) | 2 | Notifications | |
| Maps/geocoding | 1–2 | Venue location, advertiser radius | Leaflet + OSM tiles in Phase 1; a geocoder in Phase 2 |
| Foot-traffic data | 3 | Audience multipliers | Placer.ai-class providers or POS transaction counts |

## 6. Devices and installation

| Option | Phase | Role |
|---|---|---|
| Browser / web player | 1 | Development, demos, any smart TV browser |
| Android TV / Fire TV stick, kiosk app | 2 | **Default install**, about $30–60, CEC control |
| Samsung Tizen / LG webOS signage | 4 | Venues with commercial displays |
| Roku channel | 4 | Onboarding without hardware; limited reliability |

**Standard install (target: 10 minutes):**
1. Plug the stick into a spare HDMI port and power it from the TV's USB port.
2. Connect to the venue's Wi-Fi.
3. The pairing code appears; the operator enters it in the console.
4. Choose the screen mode.
5. Self-test: CEC on/off works, playback works, and photo of the placement.

## 7. Operating the business

### Platform team (first 18 months)
| Role | When |
|---|---|
| Founder/CEO: operator sales and partnerships | now |
| Full-stack engineer ×2 (platform, consoles) | Phase 1 |
| Android/devices engineer | Phase 2 |
| Operator success / support lead | Phase 2 |
| Ad-tech engineer (OpenRTB, measurement) | Phase 3 |
| Programmatic partnerships / network sales | Phase 3 |
| Fractional: franchise attorney, accountant, designer | Phase 1 onward |

### Support and NOC
- Tier 1: the operator supports their venues. Tier 2: we support operators.
- Fleet dashboard with offline alerts. Phase 2 targets: 99% player uptime during open hours, 4-hour response for operators.
- Runbooks: device offline, black screen, Wi-Fi change, TV replaced, venue closed or sold.

### Go-to-market (operator acquisition)
1. **Design partners (Phase 1):** 2–3 local AV installers or agencies, free SaaS for 6 months, weekly feedback.
2. **Case studies:** publish real (caveated) network metrics, not earnings promises.
3. **Channels:** AV and integrator associations, POS reseller partnerships, local marketing agency communities, the restaurant tech ecosystem.
4. **Operator onboarding program:** 2-week launch plan, certification, a density-first rule (≥25 venues in a tight cluster before selling local ads).

### Legal and compliance checklist
- [ ] Franchise attorney review of the operator agreement (FTC Franchise Rule and Business Opportunity Rule; state registration states). White-label, no required up-front fee, **no earnings claims**.
- [ ] Platform terms, operator agreement, venue agreement template, advertiser terms and ad policy.
- [ ] Ad content policy: alcohol (state rules), cannabis (generally banned), political (disclosure rules), healthcare claims.
- [ ] Sales tax on digital advertising: Maryland's digital advertising tax and other state rules. Review before taking payments in those states.
- [ ] Payments: Stripe Connect handles money transmission and KYC; we never hold funds ourselves.
- [ ] Music/content licensing: player content is sound-off with no licensed music unless properly licensed.
- [ ] Privacy policy (no audience PII); data processing terms for operators.

### Financial model checkpoints
| Milestone | Operators | Screens | Target MRR |
|---|---|---|---|
| Phase 1 exit | 1–3 | 30 | ~$0 (design partners) |
| Phase 2 exit | 5 | 150 | ~$3–5k |
| Phase 3 exit | 20 | 800 | ~$25k |
| Year 3 | 75 | 4,000 | ~$150k+ |

### KPIs
- **Supply:** paired screens, uptime during open hours, ad seconds available.
- **Demand:** fill rate (local, network, programmatic), effective CPM, advertiser renewal rate.
- **Operator health:** screens per operator, operator monthly churn, time to first ad sold.
- **Venue health:** venue churn, menu board updates per month.
- **Finance:** net revenue retention, payout accuracy (statements reconcile with proof-of-play at 100%).

---

## 8. Top risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing TVs show sports, so little ad inventory | Menu-board mode as the guaranteed inventory; CEC idle-time switching; honest inventory forecasts |
| Operators fail and churn | Target existing businesses; density-first playbook; time to first revenue under 30 days |
| SSPs won't onboard a small network | Pool supply; local and network demand first; apply at 500+ screens with clean data |
| Franchise/biz-opp classification | Attorney early; white-label; no earnings claims; usage-based fees |
| Device reliability (Wi-Fi, unplugged sticks) | Offline-first player, watchdogs, alerts, power from the TV's USB port |
| Ad fraud or inflated proof-of-play | Device authentication, eligibility checks, minimum duration, anomaly detection (Phase 3) |
| Incumbent signage SaaS adds ads | Advantage is the whole business stack: ad sales tools, payouts, pooled demand, POS-synced menus |
