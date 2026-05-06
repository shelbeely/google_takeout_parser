/**
 * Merge layer — port of `merge.py`.
 *
 * Dedupes events across multiple takeouts using the per-event `eventKey()`
 * function (which mirrors the Python `key` property on each dataclass).
 */
import { type GoogleEvent, type Result, eventKey, isError } from "../models/index.ts";

/** A `Set<EventKey>` wrapper used to dedupe events as they stream through. */
export class GoogleEventSet {
  private keys: Set<string> = new Set();

  has(e: GoogleEvent): boolean {
    return this.keys.has(eventKey(e));
  }

  size(): number {
    return this.keys.size;
  }

  add(e: GoogleEvent): void {
    this.keys.add(eventKey(e));
  }

  /** Returns true if newly added; false if it was already present. */
  addIfNew(e: GoogleEvent): boolean {
    const k = eventKey(e);
    if (this.keys.has(k)) return false;
    this.keys.add(k);
    return true;
  }
}

/** Merge several event streams, dropping duplicates by key. Errors pass through. */
export async function* mergeEvents(
  ...sources: AsyncIterable<Result<GoogleEvent>>[]
): AsyncIterable<Result<GoogleEvent>> {
  const seen = new GoogleEventSet();
  for (const src of sources) {
    for await (const ev of src) {
      if (isError(ev)) {
        yield ev;
        continue;
      }
      if (seen.addIfNew(ev)) {
        yield ev;
      }
    }
  }
}

/** Synchronous variant for callers that already have arrays in memory. */
export function mergeEventsSync(
  ...sources: Iterable<Result<GoogleEvent>>[]
): Result<GoogleEvent>[] {
  const seen = new GoogleEventSet();
  const out: Result<GoogleEvent>[] = [];
  for (const src of sources) {
    for (const ev of src) {
      if (isError(ev)) {
        out.push(ev);
        continue;
      }
      if (seen.addIfNew(ev)) {
        out.push(ev);
      }
    }
  }
  return out;
}
