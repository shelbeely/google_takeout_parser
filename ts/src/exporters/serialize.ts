/**
 * Serialise / rehydrate events for storage.
 *
 * `Date` is converted to ISO-8601 strings on serialisation and back to `Date`
 * on rehydration. The list of date-bearing fields per event kind is defined
 * here in one place to keep the round-trip lossless.
 */
import type { EventKind, GoogleEvent } from "../models/index.ts";

const DATE_FIELDS: Record<EventKind, readonly string[]> = {
  activity: ["time"],
  youtubeComment: ["dt"],
  csvYoutubeComment: ["dt"],
  csvYoutubeLiveChat: ["dt"],
  likedYoutubeVideo: ["dt"],
  playStoreAppInstall: ["lastUpdateTime", "firstInstallationTime"],
  location: ["dt"],
  placeVisit: ["startTime", "endTime"],
  chromeHistory: ["dt"],
  keep: ["created_dt", "updated_dt"],
};

/** Convert an event to a plain JSON-safe object (Dates -> ISO strings). */
export function serializeEvent(e: GoogleEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(e as object) };
  for (const f of DATE_FIELDS[e.kind]) {
    const v = out[f];
    if (v instanceof Date) out[f] = v.toISOString();
  }
  return out;
}

/** Inverse of `serializeEvent`. */
export function rehydrateEvent(obj: any): GoogleEvent {
  const e = { ...obj } as any;
  const kind = e.kind as EventKind;
  for (const f of DATE_FIELDS[kind] ?? []) {
    if (typeof e[f] === "string") e[f] = new Date(e[f]);
  }
  return e as GoogleEvent;
}
