// Venue open hours in the venue's local timezone, including ranges that cross midnight.
import { HttpError } from './http.ts';

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];
/** e.g. { mon: [["11:00", "14:00"], ["17:00", "02:00"]] }. A missing day means closed. null means always open. */
export type OpenHours = Partial<Record<Day, [string, string][]>> | null;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

function local(now: Date, tz: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3) as Day), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function isOpenAt(hours: OpenHours, tz: string, now: Date, bufferMin = 0): boolean {
  if (!hours) return true;
  const { day, minute } = local(now, tz);
  const prev = (day + 6) % 7;
  // Today's ranges, plus yesterday's ranges that run past midnight.
  for (const [open, close] of hours[DAYS[day]] ?? []) {
    const o = toMin(open) - bufferMin;
    const c = toMin(close) + bufferMin;
    if (toMin(close) > toMin(open) ? minute >= o && minute < c : minute >= o) return true;
  }
  for (const [open, close] of hours[DAYS[prev]] ?? []) {
    if (toMin(close) <= toMin(open) && minute < toMin(close) + bufferMin) return true;
  }
  return false;
}

/** Desired TV power state: on from 15 minutes before opening until 15 minutes after closing. */
export function powerState(hours: OpenHours, tz: string, now: Date): 'on' | 'standby' {
  return isOpenAt(hours, tz, now, 15) ? 'on' : 'standby';
}

/** Average open hours per day; used for reach estimates. */
export function avgDailyOpenHours(hours: OpenHours): number {
  if (!hours) return 12;
  let total = 0;
  for (const d of DAYS) {
    for (const [open, close] of hours[d] ?? []) {
      const len = toMin(close) - toMin(open);
      total += len > 0 ? len : len + 1440;
    }
  }
  return total / 60 / 7;
}

export function parseOpenHours(v: unknown): OpenHours {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'openHours must be an object keyed by day');
  const out: Partial<Record<Day, [string, string][]>> = {};
  for (const [k, ranges] of Object.entries(v as Record<string, unknown>)) {
    if (!DAYS.includes(k as Day)) throw new HttpError(400, `openHours: unknown day "${k}"`);
    if (!Array.isArray(ranges) || ranges.length > 4) throw new HttpError(400, `openHours.${k} must be a list of up to 4 ranges`);
    out[k as Day] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !HHMM.test(r[0]) || !HHMM.test(r[1]) || r[0] === r[1]) {
        throw new HttpError(400, `openHours.${k}: ranges must be ["HH:MM", "HH:MM"]`);
      }
      return [r[0], r[1]] as [string, string];
    });
  }
  return out;
}
