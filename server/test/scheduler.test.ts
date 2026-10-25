import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaylist, haversineMiles, isEligible, type Campaign, type Venue } from '../src/scheduler.ts';

const venue: Venue = {
  id: 'v1',
  name: 'Test Tacos',
  lat: 30.25,
  lng: -97.75,
  timezone: 'America/Chicago',
  category: 'qsr',
  blockedAdCategories: ['alcohol'],
  audienceMultiplier: 3,
  houseCreatives: [{ id: 'h1', url: '/h1', type: 'image', durationSec: 15 }],
};

const base: Campaign = {
  id: 'c1',
  advertiser: 'A',
  tier: 'local',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  geo: null,
  venueCategories: null,
  dayparts: null,
  adCategory: 'health',
  weight: 1,
  maxSovPct: 25,
  creatives: [{ id: 'a1', url: '/a1', type: 'image', durationSec: 10 }],
};

// 2026-06-15 18:00 UTC = 13:00 in Austin (CDT)
const noon = new Date('2026-06-15T18:00:00Z');

test('haversine is roughly right', () => {
  // Austin to Dallas is about 182 miles
  assert.ok(Math.abs(haversineMiles(30.2672, -97.7431, 32.7767, -96.797) - 182) < 5);
});

test('eligibility filters', () => {
  assert.equal(isEligible(base, venue, noon), true);
  assert.equal(isEligible({ ...base, adCategory: 'alcohol' }, venue, noon), false, 'blocked category');
  assert.equal(isEligible({ ...base, endDate: '2026-06-14' }, venue, noon), false, 'flight ended');
  assert.equal(isEligible({ ...base, venueCategories: ['bar'] }, venue, noon), false, 'venue category');
  assert.equal(isEligible({ ...base, geo: { lat: 32.78, lng: -96.8, radiusMiles: 10 } }, venue, noon), false, 'out of radius');
  assert.equal(isEligible({ ...base, dayparts: [{ startHour: 16, endHour: 2 }] }, venue, noon), false, 'outside daypart');
  assert.equal(isEligible({ ...base, dayparts: [{ startHour: 11, endHour: 14 }] }, venue, noon), true, 'inside daypart');
});

test('wrapping daypart matches after midnight', () => {
  const lateNight = new Date('2026-06-15T06:30:00Z'); // 01:30 local
  assert.equal(isEligible({ ...base, dayparts: [{ startHour: 22, endHour: 2 }] }, venue, lateNight), true);
});

test('respects ad share, SOV cap, and fills with house content', () => {
  const slots = buildPlaylist(venue, [base, { ...base, id: 'c2' }], noon, { loopSec: 120, adSharePct: 50 });
  const adSec = slots.filter((s) => s.campaignId).reduce((s, x) => s + x.durationSec, 0);
  const total = slots.reduce((s, x) => s + x.durationSec, 0);
  assert.ok(adSec <= 60);
  // each campaign capped at 25% of 120s = 30s
  for (const id of ['c1', 'c2']) {
    const sec = slots.filter((s) => s.campaignId === id).reduce((s, x) => s + x.durationSec, 0);
    assert.ok(sec <= 30, `${id} got ${sec}s`);
  }
  assert.ok(total <= 120 && total > 100);
  assert.ok(slots.some((s) => s.campaignId === null), 'has house content');
});

test('higher tiers fill first', () => {
  const sponsor: Campaign = { ...base, id: 'sp', tier: 'sponsorship', maxSovPct: 50 };
  const prog: Campaign = { ...base, id: 'pg', tier: 'programmatic', maxSovPct: 50 };
  const slots = buildPlaylist(venue, [prog, sponsor], noon, { loopSec: 120, adSharePct: 50 });
  assert.ok(slots.filter((s) => s.campaignId === 'sp').length === 6);
  assert.ok(slots.every((s) => s.campaignId !== 'pg'));
});

test('ads are interleaved, not back-to-back blocks', () => {
  const slots = buildPlaylist(venue, [base, { ...base, id: 'c2' }], noon, { loopSec: 120, adSharePct: 50 });
  assert.notEqual(slots[0].campaignId === null, slots[1].campaignId === null);
});
