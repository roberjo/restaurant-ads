# Architecture

```
 Demand                         Platform (server/)                       Supply
 ─────────                      ──────────────────                       ──────
 Local advertisers ──┐      ┌──────────────────────────┐
   (self-serve)      │      │ Campaigns / Creatives    │         ┌──────────────┐
 Regional direct  ───┼────▶ │ Targeting & Scheduler    │ ◀─────▶ │ Player (web) │ x N screens
 National via SSP ───┘      │ Proof-of-play + Heartbeat│  HTTPS  │  Tizen/webOS │
   (OpenRTB DOOH)           │ Venues / Screens / RevShare│        │  Android kiosk│
                            └──────────────────────────┘         │  (Roku later)│
                                                                 └──────────────┘
```

## Core concepts

- **Venue:** a physical location (lat/lng, category, open hours, blocked ad categories, revenue share %).
- **Screen:** a display in a venue, paired to one player device. It sends heartbeats and has an orientation.
- **Campaign:** an advertiser, flight dates, daily budget or fixed placement fee, targeting (geo radius, venue categories, dayparts), priority tier, and an ad category used for blocklists.
- **Creative:** an image or video URL and its duration.
- **Playlist:** what the scheduler returns for one screen for the next window: an ordered list of slots made up of ads plus house/venue content.
- **Proof-of-play (PoP):** one event per completed play (screen, creative, timestamp, duration). This is the billing source of truth.

## Scheduling (v0)

The playlist is built for a screen in a fixed **loop** (default: 120s total, ads fill up to `adSharePct` of the loop):

1. Find eligible campaigns: active flight, the venue is within the geo radius, the venue category matches, the current hour is within the daypart, and the ad category isn't blocked by the venue.
2. Order by priority tier (`sponsorship` > `direct` > `local` > `programmatic` > `house`).
3. Fill ad time with weighted round-robin inside each tier, capping each campaign at its share-of-voice.
4. Fill the remaining time with venue/house content.

The player fetches a playlist every N minutes, so a cached playlist covers outages, and caches creative files with the Cache API. Proof-of-play events are queued in `localStorage` and flushed in batches.

## Stack choices

- Node 24, using built-in TypeScript type-stripping and `node:sqlite`. Zero dependencies for now, so it's easy to read and run.
- Postgres + PostGIS when geo queries become real; a CDN for creatives.
- A single web player for every platform; native wrappers only for kiosk/auto-start.
