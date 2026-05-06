import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mergeEventsSync } from "../src/merge/index.ts";
import {
  type ChromeHistory,
  type GoogleEvent,
  type Result,
  eventKey,
} from "../src/models/index.ts";

// Generators ----------------------------------------------------------------

const arbChromeHistory: fc.Arbitrary<ChromeHistory> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.webUrl(),
    fc.integer({ min: 0, max: 2_000_000_000 }),
  )
  .map(([title, url, ts]) => ({
    kind: "chromeHistory",
    title,
    url,
    dt: new Date(ts * 1000),
    pageTransition: null,
  }));

const arbEvent: fc.Arbitrary<GoogleEvent> = arbChromeHistory;

const arbStream: fc.Arbitrary<GoogleEvent[]> = fc.array(arbEvent, { maxLength: 30 });

function keysOf(rs: Result<GoogleEvent>[]): Set<string> {
  const s = new Set<string>();
  for (const r of rs) {
    if ("kind" in r && r.kind !== "error") s.add(eventKey(r as GoogleEvent));
  }
  return s;
}

// Properties ---------------------------------------------------------------

describe("mergeEventsSync — fast-check properties", () => {
  test("idempotent: merge(xs, xs) has the same key-set as xs", () => {
    fc.assert(
      fc.property(arbStream, (xs) => {
        const once = mergeEventsSync(xs);
        const twice = mergeEventsSync(xs, xs);
        expect(keysOf(twice)).toEqual(keysOf(once));
      }),
      { numRuns: 50 },
    );
  });

  test("commutative on key-set: merge(a, b) = merge(b, a) (as sets)", () => {
    fc.assert(
      fc.property(arbStream, arbStream, (a, b) => {
        const ab = mergeEventsSync(a, b);
        const ba = mergeEventsSync(b, a);
        expect(keysOf(ab)).toEqual(keysOf(ba));
      }),
      { numRuns: 50 },
    );
  });

  test("output keys equal the union of input keys", () => {
    fc.assert(
      fc.property(arbStream, arbStream, arbStream, (a, b, c) => {
        const merged = mergeEventsSync(a, b, c);
        const expected = new Set<string>([
          ...a.map(eventKey),
          ...b.map(eventKey),
          ...c.map(eventKey),
        ]);
        expect(keysOf(merged)).toEqual(expected);
      }),
      { numRuns: 50 },
    );
  });

  test("output never contains duplicate keys", () => {
    fc.assert(
      fc.property(arbStream, arbStream, (a, b) => {
        const merged = mergeEventsSync(a, b);
        const seen = new Set<string>();
        for (const r of merged) {
          if ("kind" in r && r.kind !== "error") {
            const k = eventKey(r as GoogleEvent);
            expect(seen.has(k)).toBe(false);
            seen.add(k);
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
