import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgDailyOpenHours, isOpenAt, parseOpenHours, powerState } from '../src/hours.ts';

const TZ = 'America/Chicago';
// 2026-06-15 is a Monday. CDT = UTC-5.
const at = (localIso: string) => new Date(`${localIso}-05:00`);
const pub = parseOpenHours({ mon: [['16:00', '02:00']], tue: [['16:00', '02:00']], sun: [['12:00', '22:00']] });

test('null hours means always open', () => {
  assert.equal(isOpenAt(null, TZ, at('2026-06-15T03:00:00')), true);
});

test('same-day and overnight ranges', () => {
  assert.equal(isOpenAt(pub, TZ, at('2026-06-15T15:59:00')), false, 'Mon before open');
  assert.equal(isOpenAt(pub, TZ, at('2026-06-15T16:00:00')), true, 'Mon at open');
  assert.equal(isOpenAt(pub, TZ, at('2026-06-15T23:30:00')), true, 'Mon late');
  assert.equal(isOpenAt(pub, TZ, at('2026-06-16T01:30:00')), true, 'Tue 1:30am belongs to Monday night');
  assert.equal(isOpenAt(pub, TZ, at('2026-06-16T02:00:00')), false, 'closes at 2am');
  assert.equal(isOpenAt(pub, TZ, at('2026-06-14T21:59:00')), true, 'Sunday');
  assert.equal(isOpenAt(pub, TZ, at('2026-06-17T12:00:00')), false, 'Wed has no hours: closed');
});

test('power state turns the TV on 15 minutes early and off 15 minutes late', () => {
  assert.equal(powerState(pub, TZ, at('2026-06-15T15:44:00')), 'standby');
  assert.equal(powerState(pub, TZ, at('2026-06-15T15:46:00')), 'on');
  assert.equal(powerState(pub, TZ, at('2026-06-16T02:10:00')), 'on');
  assert.equal(powerState(pub, TZ, at('2026-06-16T02:20:00')), 'standby');
});

test('average daily hours for reach estimates', () => {
  // Mon 10h + Tue 10h + Sun 10h = 30h / 7
  assert.ok(Math.abs(avgDailyOpenHours(pub) - 30 / 7) < 1e-9);
  assert.equal(avgDailyOpenHours(null), 12);
});

test('validation', () => {
  assert.throws(() => parseOpenHours({ funday: [] }), /unknown day/);
  assert.throws(() => parseOpenHours({ mon: [['9:00', '17:00']] }), /HH:MM/);
  assert.throws(() => parseOpenHours({ mon: [['09:00', '09:00']] }), /HH:MM/);
});
