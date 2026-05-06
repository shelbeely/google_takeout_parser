/**
 * Time parsing helpers — port of `time_utils.py`.
 *
 * All Takeout timestamps are normalised to UTC `Date` objects.
 */

/** Parse a Unix timestamp expressed in **seconds** (string or number). */
export function parseDatetimeSec(d: string | number): Date {
  const n = typeof d === "string" ? Number.parseInt(d, 10) : Math.trunc(d);
  return new Date(n * 1000);
}

/** Parse a Unix timestamp expressed in **milliseconds**. */
export function parseDatetimeMillis(d: string | number): Date {
  const n = typeof d === "string" ? Number.parseInt(d, 10) : Math.trunc(d);
  return new Date(n);
}

/** Parse a Unix timestamp expressed in **microseconds**. */
export function parseDatetimeMicros(d: string | number): Date {
  const n = typeof d === "string" ? Number.parseInt(d, 10) : Math.trunc(d);
  return new Date(n / 1000);
}

/**
 * Parse an ISO-8601 UTC date string from the Takeout JSON.
 *
 * Supports trailing `Z`, fractional seconds, and offsets. Returns a `Date` in UTC.
 * Equivalent to `parse_json_utc_date` in Python.
 */
export function parseJsonUtcDate(ds: string): Date {
  // JS Date already understands ISO-8601 with Z and timezone offsets.
  const d = new Date(ds);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Could not parse date: ${ds}`);
  }
  return d;
}

/** Truncating timestamp -> seconds-since-epoch, used as part of merge keys. */
export function epochSeconds(d: Date): number {
  return Math.trunc(d.getTime() / 1000);
}
