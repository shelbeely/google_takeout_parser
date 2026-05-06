import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeNdjson, writeOpenClaw, writeOpenViking } from "../src/exporters/index.ts";
import type { GoogleEvent, Result } from "../src/models/index.ts";

function fixtureEvents(): Result<GoogleEvent>[] {
  return [
    {
      kind: "activity",
      header: "Search",
      title: "Searched for cats",
      time: new Date("2023-04-15T12:00:00Z"),
      description: null,
      titleUrl: "https://www.google.com/search?q=cats",
      subtitles: [],
      details: [],
      locationInfos: [],
      products: ["Search"],
    },
    {
      kind: "activity",
      header: "YouTube",
      title: "Watched something",
      time: new Date("2023-04-16T08:30:00Z"),
      description: null,
      titleUrl: null,
      subtitles: [],
      details: [],
      locationInfos: [],
      products: ["YouTube"],
    },
    {
      kind: "chromeHistory",
      title: "Example",
      url: "https://example.com",
      dt: new Date("2023-04-15T13:00:00Z"),
      pageTransition: "LINK",
    },
    {
      kind: "keep",
      title: "Groceries",
      created_dt: new Date("2023-04-10T09:00:00Z"),
      updated_dt: new Date("2023-04-10T09:00:00Z"),
      listContent: [{ text: "milk", textHtml: "milk", isChecked: false }],
      textContent: null,
      textContentHtml: null,
      color: "DEFAULT",
      annotations: [],
      isTrashed: false,
      isPinned: false,
      isArchived: false,
    },
  ];
}

async function* asAsync<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

describe("NDJSON exporter", () => {
  test("writes one event per line with serialised dates", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ndjson-"));
    const fp = path.join(dir, "events.ndjson");
    const stats = await writeNdjson(fp, asAsync(fixtureEvents()));
    expect(stats.events).toBe(4);
    const lines = readFileSync(fp, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const first = JSON.parse(lines[0]!);
    expect(first.kind).toBe("activity");
    expect(typeof first.time).toBe("string");
    expect(first.time).toBe("2023-04-15T12:00:00.000Z");
  });
});

describe("OpenViking exporter", () => {
  test("writes L0 + L1 + L2 layout with manifest", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ov-"));
    const stats = await writeOpenViking(dir, asAsync(fixtureEvents()), {
      sources: ["/path/to/Takeout"],
    });
    expect(stats.totalEvents).toBe(4);

    // L0
    expect(existsSync(path.join(dir, "index.md"))).toBe(true);
    expect(existsSync(path.join(dir, "summary.json"))).toBe(true);
    expect(existsSync(path.join(dir, "manifest.json"))).toBe(true);

    const summary = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf-8"));
    expect(summary.totals.events).toBe(4);
    expect(summary.perFamily.activity).toBe(2);
    expect(summary.perFamily.chrome).toBe(1);
    expect(summary.perFamily.keep).toBe(1);

    // L1: per-family READMEs
    expect(existsSync(path.join(dir, "activity", "README.md"))).toBe(true);
    expect(existsSync(path.join(dir, "chrome", "README.md"))).toBe(true);
    expect(existsSync(path.join(dir, "keep", "README.md"))).toBe(true);

    // L2: shards bucketed by month
    expect(existsSync(path.join(dir, "activity", "2023", "04.ndjson"))).toBe(true);
    expect(existsSync(path.join(dir, "chrome", "2023", "04.ndjson"))).toBe(true);

    const shardLines = readFileSync(path.join(dir, "activity", "2023", "04.ndjson"), "utf-8")
      .trim()
      .split("\n");
    expect(shardLines).toHaveLength(2);

    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf-8"));
    expect(manifest.paradigm).toBe("openviking-l0-l1-l2");
    expect(manifest.tiers.l0).toContain("index.md");
    expect(manifest.tiers.l0).toContain("summary.json");
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("OpenClaw exporter", () => {
  test("writes skill.json + by-date.sqlite + search.sqlite + digests", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-"));
    const stats = await writeOpenClaw(dir, asAsync(fixtureEvents()), {
      skillName: "test-skill",
    });
    expect(stats.totalEvents).toBe(4);

    expect(existsSync(path.join(dir, "skill.json"))).toBe(true);
    expect(existsSync(path.join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(dir, "by-date.sqlite"))).toBe(true);
    expect(existsSync(path.join(dir, "search.sqlite"))).toBe(true);
    expect(existsSync(path.join(dir, "digests", "by-product.md"))).toBe(true);

    const skill = JSON.parse(readFileSync(path.join(dir, "skill.json"), "utf-8"));
    expect(skill.name).toBe("test-skill");
    expect(skill.runtime).toBe("sqlite");
    expect(skill.resources.find((r: any) => r.id === "by-date")).toBeTruthy();
    expect(skill.resources.find((r: any) => r.id === "search")).toBeTruthy();
    expect(skill.stats.totalEvents).toBe(4);

    // by-date.sqlite — there should be a row per event, queryable on ts
    const db = new Database(path.join(dir, "by-date.sqlite"));
    const activities = db
      .query("SELECT key, ts, ts_iso FROM events_activity ORDER BY ts")
      .all() as any[];
    expect(activities).toHaveLength(2);
    expect(activities[0].ts_iso).toBe("2023-04-15T12:00:00.000Z");

    const chrome = db.query("SELECT key FROM events_chromeHistory").all() as any[];
    expect(chrome).toHaveLength(1);
    db.close();

    // search.sqlite — FTS5 MATCH should find the activity
    const sdb = new Database(path.join(dir, "search.sqlite"));
    const matches = sdb
      .query("SELECT key FROM search_activity WHERE search_activity MATCH 'cats'")
      .all() as any[];
    expect(matches).toHaveLength(1);
    const keepMatches = sdb
      .query("SELECT key FROM search_keep WHERE search_keep MATCH 'milk'")
      .all() as any[];
    expect(keepMatches).toHaveLength(1);
    sdb.close();

    // daily digest
    expect(existsSync(path.join(dir, "digests", "daily", "2023-04-15.md"))).toBe(true);
  });
});
