# Platform Model: "Network-in-a-Box" for Operators

**Pivot:** we don't run a network. We give independent **operators** everything they need to run a local in-venue TV ad network: software, integrations, installers and playbooks. We earn money from their activity.

Constraints we've decided on:
- Venues' **existing TVs** are used. We don't supply screens.
- What we offer venues: **a revenue share plus free menu boards**.
- We have **no** existing venue, advertiser or exchange relationships.

## Verdict

This is a better model than operating a network ourselves, because it avoids our two weakest points: venue sales and local ad sales. One change is critical:

> **Don't sell a kit. Run a platform and pool operators' screens into one network.**

A one-time "turnkey business" sale is a weak, high-churn business with legal risk (see §5). A platform that **pools every operator's screens into one network** fixes the problem that kills small operators: they're too small for national/programmatic buyers. The pooled network is where we can build a moat:

```
Operator A (Austin, 40 screens) ─┐
Operator B (Tulsa, 25 screens)  ─┼─▶ Our platform = one network of 500+ screens ─▶ SSPs (Vistar, Place Exchange, Hivestack)
Operator C (Boise, 60 screens)  ─┘        │                                          national/regional demand
                                          └─▶ Stripe Connect payouts to operators → venues
```

- **Operators** own venue relationships and local ad sales: the hard, local, human work.
- **We** own the software, device fleet, programmatic demand, payments and data. These benefit from scale.

## 1. Who the customer (operator) is

| Segment | Fit | Why |
|---|---|---|
| **AV installers / TV mounting companies** | ★★★ | Already in restaurants, already install TVs, want recurring revenue. |
| **Local marketing / ad agencies, print-media sellers (coupon books, placemat ads)** | ★★★ | Already sell local ads; screens are a new product line for them. |
| **Restaurant groups and multi-unit franchisees** | ★★ | Run their own network across their own locations, with internal promos and sold ads. |
| **POS resellers (Toast/Square/Clover dealers)** | ★★ | Already have the restaurant relationship; menu boards are an easy upsell. |
| First-time "side hustle" entrepreneurs | ★ | High churn and support load, and the segment where the legal and reputational risk is highest. Don't target them first. |

## 2. Revenue model

| Stream | Typical range | Notes |
|---|---|---|
| Per-screen SaaS | $8–25 /screen/month | Market rate for signage SaaS (Yodeck, OptiSigns, ScreenCloud). Bundle menu boards and ads. |
| Programmatic take rate | 15–30% of net | We're the publisher of record to SSPs; operators earn without doing any national sales. |
| Local ad payment processing | 3–8% platform fee | Advertiser self-serve payments run through Stripe Connect; we take an application fee. |
| Pre-provisioned hardware | $15–30 margin/device | Fire TV/Android stick with our app installed and kiosk mode on, shipped ready to plug in. |
| Onboarding / certification (optional) | one-time | Be careful: required up-front fees are a franchise trigger (§5). |

Rough example: 30 operators × 50 screens = 1,500 screens.
- SaaS at $15 = $22.5k/month.
- Programmatic: ~$300/screen/month gross × 25% fill would be ~$110k gross; at a 20% take that's ~$22k/month.
- Local processing at 5% on ~$75k of local spend ≈ $3.75k/month.

That's roughly **$45–50k MRR** (monthly recurring revenue). The model works if operators stay; it's sensitive to operator churn.

## 3. What "turnkey" includes

**Software (multi-tenant):**
- **Operator console:** venues, screens, campaigns, approvals, payouts, fleet health.
- **Venue portal:** menu board editor, revenue-share statements, ad category blocklist, their own promos.
- **Advertiser self-serve:** draw a radius on a map, pick a creative template, pay, then get a proof-of-play report.
- **Player:** the existing web player plus an Android/Fire TV kiosk wrapper.

**Integrations:**
- SSPs via OpenRTB 2.6 DOOH. **One integration serves every operator**; this is the core of the pooled-network value.
- Stripe Connect for advertiser payments and operator/venue payouts.
- **POS menu sync** (Toast, Square, Clover APIs) so menu-board prices and 86'd (sold-out) items update automatically. This is the venue hook that makes "free menu boards" valuable instead of a chore.
- Audience/foot-traffic data (venue-reported counts at first, Placer.ai-type data later) to calculate impressions.

**Installers and devices (existing TVs):**
- Pre-imaged stick → plug into a spare HDMI input → scan a QR code to pair it to a venue/screen.
- HDMI-CEC scheduling: power on before opening, switch to the player input when no game is on, power off at close.
- **Menu-board mode** (full-time on one TV, ads at around 15–20% share) vs **idle-time mode** (TVs that show sports).
- A self-test and an install checklist in the operator's mobile flow (photo of placement, Wi-Fi strength, CEC works).

**Playbooks:**
- Venue pitch deck and a one-page revenue-share calculator.
- Templates for the venue agreement, advertiser insertion order and terms *(attorney-reviewed)*.
- Local rate-card guidance, a 90-day launch plan and density targets (for example, 25 venues in 3 zip codes before selling ads).

## 4. Competition at this layer

- **Broadsign, Vistar (Cortex player plus SSP), Hivestack:** enterprise DOOH stacks, priced and built for big media owners. Poor fit for a 40-screen operator.
- **Signage SaaS** (Yodeck, OptiSigns, Raydiant, ScreenCloud): good CMSs, but weak on ad sales, payouts and programmatic, and no POS-synced menu boards with ads.
- **Atmosphere/Loop:** they own the venue relationship themselves and are not an operator platform. Their partner programs are worth studying.

**Our position:** *the full business stack for a small DOOH operator*: menu boards that sell the venue, local ad sales tools, pooled programmatic demand and automatic payouts.

## 5. Legal: what defines the business

Selling a "turnkey business" can legally make us a **franchise** or a **business opportunity** seller.

- **FTC Franchise Rule (16 CFR 436):** generally applies when all three are present:
  1. the operator uses our brand
  2. we exercise significant control or give significant assistance
  3. a required payment over a small threshold is made in the first six months

  If it applies, we need a Franchise Disclosure Document (FDD), and some states (CA, NY, IL, MD, WA, others) require registration.
- **FTC Business Opportunity Rule (16 CFR 437):** applies when we sell an opportunity and offer to provide locations or accounts, or to buy back output. Earnings claims trigger strict disclosure and substantiation rules.
- **Reputation:** "own your own advertising network" is a known biz-opp scam pattern. Credibility is an asset; earnings hype destroys it.

**Design choices that keep us a software vendor (check them with a franchise attorney before launch):**
- **White-label:** operators run under *their own* brand, not ours.
- No required up-front "license fee". Charge usage-based SaaS fees with optional services.
- **No earnings claims** in marketing; publish only network-wide *actuals* with appropriate caveats.
- Don't promise venues or advertisers to operators.
- Sell first to existing businesses (AV installers, agencies), not first-time entrepreneurs.

## 6. Remaining risks

1. **Chicken and egg, one level up:** operators want proof it works, and SSPs want screen scale. Recruit **2–3 design-partner operators** (local AV installers) and give them free SaaS in exchange for feedback and case studies.
2. **SSP onboarding:** SSPs prefer networks with 500–1,000+ screens and good data. Until then, fill time with local ads and house content; apply once there's density.
3. **Existing TVs are sports TVs:** idle-time inventory is limited. Menu-board mode gives guaranteed hours and is the more honest inventory to sell.
4. **Operator quality:** a bad operator (offline screens, inappropriate ads) hurts the pooled network's reputation with SSPs. Use fleet SLAs, ad approval and the ability to remove operators.

## 7. What changes in the codebase

1. **Multi-tenancy:** an `operators` table; every venue, screen, campaign and creative is scoped to an operator; per-operator branding (white-label).
2. **Device pairing:** QR code/pairing-code flow and screen provisioning.
3. **Menu board content type:** templated menu layouts fed by POS sync, with ad share configured per screen.
4. **Payments:** Stripe Connect for advertiser charges, the platform fee and operator → venue revenue-share statements.
5. **Pooled programmatic:** an OpenRTB DOOH adapter that bids across all operators' eligible slots, plus per-operator revenue attribution.
