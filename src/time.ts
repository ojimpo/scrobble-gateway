import type { LastFmPeriod } from "./domain.js";

const ISO_WITH_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseDateTime(value: string, field: string): number;
export function parseDateTime(value: undefined, field: string): undefined;
export function parseDateTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;

  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const milliseconds = Date.parse(`${trimmed}T00:00:00Z`);
    if (Number.isFinite(milliseconds)) {
      const startOfDay = Math.floor(milliseconds / 1_000);
      return field === "to" ? startOfDay + 86_399 : startOfDay;
    }
  }

  if (!ISO_WITH_TIMEZONE.test(trimmed)) {
    throw new Error(`${field} must be a Unix timestamp, YYYY-MM-DD (UTC), or ISO 8601 with a timezone`);
  }

  const milliseconds = Date.parse(trimmed);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${field} is not a valid date-time`);
  }

  return Math.floor(milliseconds / 1_000);
}

export function periodStart(period: LastFmPeriod, nowUnix = Math.floor(Date.now() / 1_000)): number | undefined {
  if (period === "overall") return undefined;

  if (period === "7day") return nowUnix - 7 * 86_400;

  const months = {
    "1month": 1,
    "3month": 3,
    "6month": 6,
    "12month": 12,
  }[period];
  const date = new Date(nowUnix * 1_000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return Math.floor(date.getTime() / 1_000);
}

export function toIso(unix: number | null | undefined): string | null {
  return unix === null || unix === undefined ? null : new Date(unix * 1_000).toISOString();
}

export function assertDateRange(from: number | undefined, to: number | undefined): void {
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error("from must be earlier than or equal to to");
  }
}
