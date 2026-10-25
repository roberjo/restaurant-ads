// Small input validators that throw 400s with field names.
import { HttpError } from './http.ts';

export function str(v: unknown, field: string, min = 1, max = 200): string {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) {
    throw new HttpError(400, `${field} must be a string of ${min}-${max} characters`);
  }
  return v.trim();
}

export function optStr(v: unknown, field: string, max = 200): string | null {
  if (v === null || v === undefined || v === '') return null;
  return str(v, field, 1, max);
}

export function num(v: unknown, field: string, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function int(v: unknown, field: string, min = -Infinity, max = Infinity): number {
  const n = num(v, field, min, max);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be an integer`);
  return n;
}

export function email(v: unknown): string {
  const s = str(v, 'email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'invalid email');
  return s;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

export function date(v: unknown, field: string): string {
  const s = str(v, field, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return s;
}

export function stringList(v: unknown, field: string, allowed: readonly string[]): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be a list`);
  for (const x of v) oneOf(x, field, allowed);
  return [...new Set(v as string[])];
}
