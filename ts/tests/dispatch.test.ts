import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TakeoutParser } from "../src/dispatch/index.ts";
import { mergeEvents } from "../src/merge/index.ts";
import { isError } from "../src/models/index.ts";

function makeFakeTakeout(locale: "EN" | "DE"): string {
  const root = mkdtempSync(path.join(tmpdir(), "fake-takeout-"));
  // Chrome history (EN path)
  if (locale === "EN") {
    mkdirSync(path.join(root, "Chrome"), { recursive: true });
    writeFileSync(
      path.join(root, "Chrome", "BrowserHistory.json"),
      JSON.stringify({
        "Browser History": [
          {
            title: "Page A",
            url: "https://example.com/a",
            time_usec: 1_700_000_000_000_000,
          },
          {
            title: "Page B",
            url: "https://example.com/b",
            time_usec: 1_700_000_000_001_000,
          },
        ],
      }),
    );
    mkdirSync(path.join(root, "Google Play Store"), { recursive: true });
    writeFileSync(
      path.join(root, "Google Play Store", "Installs.json"),
      JSON.stringify([
        {
          install: {
            doc: { title: "Some App" },
            firstInstallationTime: "2023-01-01T00:00:00Z",
            lastUpdateTime: "2023-06-01T00:00:00Z",
          },
        },
      ]),
    );
  }
  return root;
}

describe("TakeoutParser dispatch", () => {
  test("walks an EN takeout and parses Chrome + Play installs", async () => {
    const dir = makeFakeTakeout("EN");
    const tp = new TakeoutParser(dir, { localeName: "EN", warnUnhandled: false });
    const events = await tp.parseAll();
    const kinds = events.filter((e) => !isError(e)).map((e: any) => e.kind);
    expect(kinds).toContain("chromeHistory");
    expect(kinds).toContain("playStoreAppInstall");
    expect(kinds.filter((k: string) => k === "chromeHistory")).toHaveLength(2);
  });

  test("filter restricts emitted events to chosen kinds", async () => {
    const dir = makeFakeTakeout("EN");
    const tp = new TakeoutParser(dir, {
      localeName: "EN",
      filter: new Set(["playStoreAppInstall"]),
      warnUnhandled: false,
    });
    const events = await tp.parseAll();
    const kinds = events.filter((e) => !isError(e)).map((e: any) => e.kind);
    expect(kinds.every((k: string) => k === "playStoreAppInstall")).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
  });
});

describe("mergeEvents", () => {
  test("dedupes identical events from multiple sources", async () => {
    const dir = makeFakeTakeout("EN");
    const tp1 = new TakeoutParser(dir, { localeName: "EN", warnUnhandled: false });
    const tp2 = new TakeoutParser(dir, { localeName: "EN", warnUnhandled: false });
    const merged: any[] = [];
    for await (const ev of mergeEvents(tp1.parse(), tp2.parse())) merged.push(ev);
    const events = merged.filter((e) => !isError(e));
    // exact same takeout twice => same number of unique events as parsing once
    const tp3 = new TakeoutParser(dir, { localeName: "EN", warnUnhandled: false });
    const single = (await tp3.parseAll()).filter((e) => !isError(e));
    expect(events.length).toBe(single.length);
  });
});
