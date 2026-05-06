import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TakeoutCache } from "../src/cache/index.ts";
import type { GoogleEvent, Result } from "../src/models/index.ts";

describe("TakeoutCache", () => {
  test("round-trips serialised events through gzipped NDJSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cache-"));
    const c = new TakeoutCache(dir);
    const events: Result<GoogleEvent>[] = [
      {
        kind: "chromeHistory",
        title: "x",
        url: "https://x.com",
        dt: new Date("2023-01-01T00:00:00Z"),
        pageTransition: null,
      },
    ];
    c.put("k1", events);
    const got = c.get("k1");
    expect(got).not.toBeNull();
    expect(got!).toHaveLength(1);
    const ev = got![0]!;
    if ("kind" in ev && ev.kind === "chromeHistory") {
      expect(ev.url).toBe("https://x.com");
      expect(ev.dt).toBeInstanceOf(Date);
      expect(ev.dt.toISOString()).toBe("2023-01-01T00:00:00.000Z");
    } else {
      throw new Error("expected chromeHistory");
    }
    c.clear();
    expect(c.get("k1")).toBeNull();
    c.close();
  });
});
