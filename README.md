# restaurant-ads

Tools and implementations for an in-venue TV ad network. National, regional and local ad demand is delivered to screens in restaurants and other local businesses.

**Direction:** we build the platform that independent operators use to run local networks; we don't run one ourselves. See [docs/platform-model.md](docs/platform-model.md).

Background: [docs/feasibility.md](docs/feasibility.md), a candid look at competitors, the inventory problem, channels (Roku/Samsung/etc.) and unit economics. Then read [docs/architecture.md](docs/architecture.md).

## What's here

| Path | What |
|---|---|
| `server/` | Ad server: venues, screens, campaigns, targeting/scheduling, proof-of-play, heartbeats, reports. Node 24, zero dependencies (`node:sqlite`, native TS). |
| `player/` | A single web player for Tizen/webOS signage browsers, Android/Fire TV kiosk WebViews and desktop browsers. Plays offline from cache and queues proof-of-play events. |
| `creatives/` | Demo ad and house content. |
| `docs/` | Feasibility, business model and architecture. |

## Run

```sh
npm start        # http://localhost:8787 → opens the player for a demo screen
npm test         # scheduler tests
```

- Player: `http://localhost:8787/player/?screen=s-pub-bar&debug=1`
- Fleet status: `GET /api/screens`
- Campaign report: `GET /api/reports/campaigns`

## Roadmap

1. Local advertiser self-serve (map radius picker, creative templates, Stripe)
2. Venue portal (revenue share, category blocklist, own promos)
3. Android/Fire TV kiosk wrapper (auto-boot, HDMI-CEC power/input control)
4. Fleet monitoring and alerting for offline screens
5. OpenRTB 2.6 DOOH adapter to an SSP for programmatic fill
6. Roku / Samsung consumer apps, only as an onboarding path
