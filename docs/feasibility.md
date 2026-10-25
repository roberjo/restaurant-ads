# Feasibility, Business Model & Hard Questions

An honest look at the idea before building much: a network of TV screens in restaurants and other local businesses, showing ads bought nationally, regionally and locally.

## TL;DR

The idea is **viable but crowded**, and how hard it is depends almost entirely on **which screens you can control** and **where your demand comes from**.

- **Demand:** national and regional money already flows into screens like these through *programmatic DOOH* (digital out-of-home advertising bought through automated exchanges). Plug into those exchanges; don't sell national accounts yourself.
- **Local spend is the differentiator** and the hardest part. Small businesses buy cheaply, cancel often and need hand-holding. It only works with very cheap self-serve buying and tight geofencing ("ads from businesses within 3 miles").
- **Screens:** a restaurant TV showing live sports is mostly *not available* to you. You can't insert ads into cable or satellite broadcasts. Your inventory is dedicated screens, or TVs during the hours when they would otherwise be off or idle.
- **Roku/Samsung consumer apps are the wrong primary channel.** Use them only as a zero-hardware onboarding path. A $30–60 managed player (Android/Fire TV stick in kiosk mode, or a Raspberry Pi/BrightSign) is far more reliable.

## 1. Who already does this (competition)

| Player | Model | Lesson |
|---|---|---|
| **Loop Media / Loop TV** | Free music-video channel for bars/restaurants, ad-supported, runs on its own player plus Roku/Fire | Proves "free content + ads" gets screens. Shows that venues demand content, not just ads. Publicly struggled financially. |
| **Atmosphere TV** | Free curated, sound-off channel for venues, ad-supported, tens of thousands of venues | The direct competitor and the closest to this idea. Funded heavily. |
| **Vistar Media, Hivestack, Place Exchange** | DOOH SSPs (sell-side platforms) and ad exchanges | These are your **national/regional demand pipes**, not competitors. |
| **Raydiant, Spectrio, Mood Media, Yodeck, ScreenCloud** | Signage software (SaaS) for the venue's own menus and promos | They already own the screen relationship in many venues and could add ads at any time. |
| **GSTV, Outfront, local cable ad sales (Spectrum Reach, Comcast Effectv)** | Captive-audience and local TV ads | They set what local advertisers expect to pay. |

**Implication:** "ads on restaurant TVs" alone won't stand out. Possible ways to stand out:
1. **Hyper-local demand.** Sell neighbouring businesses an ad on the screens in their zip code at $X/week, self-serve, in 5 minutes. Atmosphere and Loop focus on national programmatic demand and serve this segment poorly.
2. **Vertical focus.** Pick one venue type and audience and own it, e.g. laundromats, barbershops, car-wash waiting rooms or quick-service restaurants (QSRs). In these venues people look at the screen and there are no sports competing for attention.
3. **Owned-media for the venue.** Give the restaurant free menu boards and promo slots, plus a revenue share. The ads fund free signage software.

## 2. The inventory problem (most important)

| Screen situation | Can you show ads? | Notes |
|---|---|---|
| TV showing cable/satellite sports or news | **No** (practically) | Modifying or overlaying a broadcast signal (L-bars, squeeze-backs) causes problems with commercial cable agreements and retransmission rights. Venues also won't let you interrupt the game. |
| TV that is off or idle, or at an idle hour (breakfast, lunch) | Yes | Needs the venue to switch inputs or have the TV auto-switch. CEC (HDMI-CEC) control from the player helps. |
| Dedicated signage screen (by the counter, waiting area, restroom) | **Yes, best** | You may need to supply the screen ($150–300 for a 43–50" TV). That is capital cost per venue. |
| Menu board screens | Partially | Show 10–20% ads alongside menu content. The venue must want it. |

**Every downstream number depends on how many hours of ad-eligible screen time you actually control per venue.**

## 3. Channels: Roku, Samsung, etc.

| Channel | Good for | Problems |
|---|---|---|
| **Roku channel** (BrightScript/SceneGraph) | Zero-hardware trial on TVs that already have Roku | No real kiosk mode. Screensaver, updates and remote use all break playback. Roku's channel-store rules and ad policies (Roku wants a share of ad revenue in channels) apply. Venue staff must launch the channel. |
| **Samsung consumer Tizen app** | Same as Roku | Store review is required, there's no auto-start, and running a consumer TV commercially can void the warranty. |
| **Samsung/LG commercial displays** (Tizen SSSP, webOS Signage) | Venues that already have pro displays | Real signage modes: auto-start, power schedules, URL launcher. A web player works directly. |
| **Android TV / Fire TV stick** in kiosk mode | **Default managed player** | Cheap, auto-boots into your app, controls the TV over CEC. Use Fire OS's or Android's enterprise / device-owner mode. |
| **Raspberry Pi / BrightSign** | Rugged, fleet-managed | BrightSign costs more but is the industry standard. A Pi needs more ops work. |

**Recommendation:** build **one web-based player** (HTML/JS) that runs in Tizen/webOS signage browsers, an Android WebView kiosk wrapper and desktop browsers. Add a thin Roku channel later, only if it helps get venues signed up. The player in [`/player`](../player) is that web player.

## 4. Unit economics (rough, check before believing)

Rough industry ranges:
- **Programmatic DOOH CPM** (cost per thousand impressions) for venue screens: about **$5–15**. This is the price per thousand *impressions*, not per thousand plays. Impressions = plays × an audience multiplier (estimated viewers per play, from foot-traffic data such as Placer.ai or the venue's own transaction counts).
- **Fill rate** on DOOH exchanges for small, unknown networks: often **10–40%**. Expect a lot of unsold time to begin with.
- **Revenue share to the venue:** commonly **10–30%** of net ad revenue, or a flat amount/free signage.

Example for one dedicated screen:
```
12 open hours × 60 min ÷ 2-min loop       = 360 loops/day
4 ad slots per loop                       = 1,440 ad plays/day
audience multiplier 3 (viewers per play)  = 4,320 impressions/day
× 30 days                                 = ~130k impressions/month
× $8 CPM × 25% fill                       = ~$260/month gross programmatic
- SSP fees (~15–25%), venue share (~20%) = ~$160/month net to you
```
**Local ads:** 10 local advertisers × $50/month on a 20-screen zip cluster = $500/month per cluster, with very low cost of delivery but **high cost to acquire and keep each advertiser**.

Costs per venue: hardware $50–300 (one-time), connectivity (venue Wi-Fi, which is unreliable, or LTE at $10–20/month), support/truck rolls, and venue sales/onboarding (often the largest cost).

**Verdict:** a single screen makes little money. The business works at **density**: hundreds of screens in a metro, so local advertisers get reach and SSPs take the network seriously. Plan the go-to-market (GTM) as **one metro at a time**.

## 5. The hard questions to answer early

1. **Supply wedge:** what makes a restaurant owner say yes? (Free menu boards? Cash? Free TV?) How long can you keep them before they unplug it?
2. **Which venues?** Dwell time and attention matter more than venue count. Waiting rooms do better than sports bars.
3. **Local demand GTM:** door-to-door, partnering with local chambers of commerce, or reselling through the venue itself ("advertise on our screens")? Could venues sell ads to each other?
4. **Measurement:** proof-of-play (proving each ad ran) is required. Impression estimates need a defensible audience multiplier, otherwise programmatic buyers apply discounts.
5. **Content:** a loop of nothing but ads gets unplugged. What's the non-ad content? (Local news and weather, trivia, the venue's own promos, licensed sound-off clips.)
6. **Ad policy:** alcohol, cannabis, political and competitor ads (e.g. a pizza chain advertising in a pizza restaurant) need venue-level blocklists.
7. **Ops:** devices go offline, Wi-Fi changes and staff unplug things. Remote monitoring and alerting are core to the product.

## 6. What to build first (MVP scope)

1. **CMS/ad server** for venues, screens, campaigns, creatives, targeting (geo radius, venue type, daypart), frequency and share-of-voice, proof-of-play logging. → `server/`
2. **Web player** that caches creatives, plays offline, reports proof-of-play and sends heartbeats. → `player/`
3. **Local advertiser self-serve:** pick an area on a map, upload an image or video (or generate one from a template), pay with Stripe. *(next)*
4. **Venue portal:** revenue dashboard, category blocklist, their own promos. *(next)*
5. **Programmatic adapter:** an OpenRTB 2.6 DOOH bid request to one SSP (e.g. Vistar or Place Exchange) to fill unsold slots. *(later; requires an SSP partnership)*

Leave Roku/Samsung store apps until venues ask for them.
