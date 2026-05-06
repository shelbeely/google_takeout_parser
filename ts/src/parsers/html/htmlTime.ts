/**
 * HTML datetime parsing — port of `parse_html/html_time_utils.py`.
 *
 * The legacy My Activity HTML format encodes timestamps as
 *   `Mon DD, YYYY, HH:MM:SS AM/PM [TZABBR]`
 *
 * Three sub-cases (per the Python comment):
 *   1. No timezone abbreviation (pre-2018): treat as UTC.
 *   2. `UTC` abbreviation (2018-2020): treat as UTC.
 *   3. Other abbreviation (post-2020): the abbreviation reflects the **export
 *      machine's local time** at export, not the time of the event. We try to
 *      compute the correct offset using the export's `file_dt`. If we can't
 *      resolve the abbreviation, we fall back to UTC and warn.
 *
 * JavaScript has no built-in equivalent of pytz's abbreviation database, so we
 * support the most common abbreviations explicitly. Unknown abbreviations log
 * a warning and fall back to UTC (matching the Python behaviour of "best we
 * can do").
 */

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

// Mon DD, YYYY, H:MM:SS AM/PM [TZ]
// Day can be 1-2 digits; hour can be 1-2 digits.
const HTML_DT_REGEX =
  /^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)(?:\s+([A-Z]{2,5}))?$/;

/**
 * Common timezone-abbreviation → IANA-zone mapping. Same set the Python
 * pytz database covers in practice for Google Takeout exports.
 *
 * For zones with daylight-saving variants, we map to the IANA zone (the actual
 * offset is computed via `Intl.DateTimeFormat` against `fileDt`).
 */
const ABBR_TO_IANA: Record<string, string> = {
  UTC: "UTC",
  GMT: "Europe/London",
  BST: "Europe/London",
  WET: "Europe/Lisbon",
  WEST: "Europe/Lisbon",
  CET: "Europe/Berlin",
  CEST: "Europe/Berlin",
  EET: "Europe/Helsinki",
  EEST: "Europe/Helsinki",
  MSK: "Europe/Moscow",
  IST: "Asia/Kolkata",
  PKT: "Asia/Karachi",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  MST: "America/Denver",
  MDT: "America/Denver",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  EST: "America/New_York",
  EDT: "America/New_York",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
  HST: "Pacific/Honolulu",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
  ACST: "Australia/Adelaide",
  ACDT: "Australia/Adelaide",
  AWST: "Australia/Perth",
  NZST: "Pacific/Auckland",
  NZDT: "Pacific/Auckland",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  SGT: "Asia/Singapore",
  HKT: "Asia/Hong_Kong",
};

/**
 * Returns the UTC offset in minutes for a given IANA zone at a given instant.
 * Negative for west of UTC (matches `Date.getTimezoneOffset` sign convention's
 * inverse, i.e. positive for east of UTC).
 */
function tzOffsetMinutes(iana: string, at: Date): number {
  // `Intl.DateTimeFormat` gives us the wall-clock representation of `at` in the
  // target zone. We reconstruct that wall clock as if it were UTC, then compare
  // to the actual UTC instant to derive the offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: iana,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(at);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const wallUtcMs = Date.UTC(
    Number.parseInt(lookup.year!, 10),
    Number.parseInt(lookup.month!, 10) - 1,
    Number.parseInt(lookup.day!, 10),
    Number.parseInt(lookup.hour!, 10) === 24 ? 0 : Number.parseInt(lookup.hour!, 10),
    Number.parseInt(lookup.minute!, 10),
    Number.parseInt(lookup.second!, 10),
  );
  return Math.round((wallUtcMs - at.getTime()) / 60000);
}

export function parseHtmlDt(s: string, opts: { fileDt?: Date | null } = {}): Date {
  const trimmed = s.trim();
  const m = HTML_DT_REGEX.exec(trimmed);
  if (!m) {
    throw new Error(`Could not parse HTML datetime '${s}'`);
  }
  const [, monStr, dayStr, yearStr, hourStr, minStr, secStr, ampm, tzAbbr] = m;
  const month = MONTHS[monStr!];
  if (month === undefined) {
    throw new Error(`Unknown month '${monStr}' in '${s}'`);
  }
  let hour = Number.parseInt(hourStr!, 10);
  const minute = Number.parseInt(minStr!, 10);
  const second = Number.parseInt(secStr!, 10);
  const day = Number.parseInt(dayStr!, 10);
  const year = Number.parseInt(yearStr!, 10);
  if (ampm === "AM" && hour === 12) hour = 0;
  else if (ampm === "PM" && hour !== 12) hour += 12;

  // Case 1 + 2: no abbreviation or explicit UTC → straight UTC.
  if (!tzAbbr || tzAbbr === "UTC") {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  // Case 3: abbreviation reflects export-machine local time. Use fileDt to
  // resolve the correct offset; fall back to "now" if absent.
  const iana = ABBR_TO_IANA[tzAbbr];
  if (!iana) {
    // Unknown abbreviation: best-effort fall back to UTC.
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  const refInstant = fileDtRef(opts.fileDt, year, month, day);
  const offsetMin = tzOffsetMinutes(iana, refInstant);
  const wallUtcMs = Date.UTC(year, month, day, hour, minute, second);
  return new Date(wallUtcMs - offsetMin * 60000);
}

function fileDtRef(fileDt: Date | null | undefined, y: number, m: number, d: number): Date {
  if (fileDt instanceof Date && !Number.isNaN(fileDt.getTime())) return fileDt;
  // No file_dt: use the event's nominal date itself as a coarse anchor.
  return new Date(Date.UTC(y, m, d, 12, 0, 0));
}
