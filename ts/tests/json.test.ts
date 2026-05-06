import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isError } from "../src/models/index.ts";
import {
  parseAppInstalls,
  parseChromeHistory,
  parseJsonActivity,
  parseKeep,
  parseLikes,
  parseLocationHistory,
  parseSemanticLocationHistory,
} from "../src/parsers/json/index.ts";

function tmpFile(contents: string, name = "file.json"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gtp-"));
  const fp = path.join(dir, name);
  writeFileSync(fp, contents, "utf-8");
  return fp;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseJsonActivity", () => {
  test("parses a single Discover blob", async () => {
    const json = JSON.stringify([
      {
        header: "Discover",
        title: "7 cards in your feed",
        time: "2021-12-13T03:04:05.007Z",
        products: ["Discover"],
        locationInfos: [
          {
            name: "At this general area",
            url: "https://www.google.com/maps/@?api=1&map_action=map&center=lat,lon&zoom=12",
            source: "From your Location History",
            sourceUrl: "https://www.google.com/maps/timeline",
          },
        ],
        subtitles: [{ name: "Computer programming" }, { name: "Computer Science" }],
      },
    ]);
    const fp = tmpFile(json);
    const res = await collect(parseJsonActivity(fp));
    expect(res).toHaveLength(1);
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.kind).toBe("activity");
    expect(ev.header).toBe("Discover");
    expect(ev.title).toBe("7 cards in your feed");
    expect(ev.time.toISOString()).toBe("2021-12-13T03:04:05.007Z");
    expect(ev.subtitles).toHaveLength(2);
    expect(ev.subtitles[0]).toEqual({ name: "Computer programming", url: null });
    expect(ev.locationInfos[0]?.source).toBe("From your Location History");
    expect(ev.products).toEqual(["Discover"]);
  });

  test("upgrades insecure http://youtube.com URLs to https://", async () => {
    const json = JSON.stringify([
      {
        header: "YouTube",
        title: "Watched x",
        titleUrl: "http://www.youtube.com/watch?v=abc",
        time: "2020-01-01T00:00:00Z",
      },
    ]);
    const fp = tmpFile(json);
    const res = await collect(parseJsonActivity(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.titleUrl).toBe("https://www.youtube.com/watch?v=abc");
  });
});

describe("parseLikes", () => {
  test("extracts liked YouTube video", async () => {
    const json = JSON.stringify([
      {
        contentDetails: { videoId: "J1tF-DKKt7k" },
        snippet: {
          title: "Hello",
          description: "World",
          publishedAt: "2020-07-05T18:27:32.000Z",
        },
      },
    ]);
    const fp = tmpFile(json);
    const res = await collect(parseLikes(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.title).toBe("Hello");
    expect(ev.link).toBe("https://youtube.com/watch?v=J1tF-DKKt7k");
    expect(ev.dt.toISOString()).toBe("2020-07-05T18:27:32.000Z");
  });
});

describe("parseAppInstalls", () => {
  test("extracts install metadata", async () => {
    const json = JSON.stringify([
      {
        install: {
          doc: { documentType: "Android Apps", title: "ClickUp" },
          firstInstallationTime: "2022-03-14T07:06:12.070725Z",
          deviceAttribute: {
            model: "SM-S901E",
            carrier: "Vodafone",
            manufacturer: "samsung",
            deviceDisplayName: "samsung SM-S901E",
          },
          lastUpdateTime: "2024-08-27T22:55:15.184610Z",
        },
      },
    ]);
    const fp = tmpFile(json);
    const res = await collect(parseAppInstalls(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.title).toBe("ClickUp");
    expect(ev.deviceName).toBe("samsung SM-S901E");
    expect(ev.deviceCarrier).toBe("Vodafone");
    expect(ev.lastUpdateTime.toISOString()).toBe("2024-08-27T22:55:15.184Z");
  });
});

describe("parseChromeHistory", () => {
  test("extracts a history entry", async () => {
    const json = JSON.stringify({
      "Browser History": [
        {
          title: "Hello",
          url: "https://example.com/",
          time_usec: 1_700_000_000_000_000,
          page_transition: "LINK",
        },
      ],
    });
    const fp = tmpFile(json);
    const res = await collect(parseChromeHistory(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.title).toBe("Hello");
    expect(ev.url).toBe("https://example.com/");
    expect(ev.pageTransition).toBe("LINK");
    expect(ev.dt.getTime()).toBe(1_700_000_000_000);
  });
});

describe("parseLocationHistory", () => {
  test("extracts a Location with E7 normalisation", async () => {
    const json = JSON.stringify({
      locations: [
        {
          latitudeE7: 374200000,
          longitudeE7: -1220800000,
          accuracy: 20,
          deviceTag: 1234,
          source: "GPS",
          timestamp: "2023-01-01T00:00:00Z",
        },
      ],
    });
    const fp = tmpFile(json);
    const res = await collect(parseLocationHistory(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.lat).toBeCloseTo(37.42);
    expect(ev.lng).toBeCloseTo(-122.08);
    expect(ev.accuracy).toBe(20);
    expect(ev.source).toBe("GPS");
  });
});

describe("parseSemanticLocationHistory", () => {
  test("extracts a PlaceVisit", async () => {
    const json = JSON.stringify({
      timelineObjects: [
        {
          placeVisit: {
            location: {
              latitudeE7: 374200000,
              longitudeE7: -1220800000,
              placeId: "abc123",
              address: "1 Infinite Loop",
              name: "HQ",
              locationConfidence: 0.9,
            },
            duration: {
              startTimestamp: "2023-01-01T00:00:00Z",
              endTimestamp: "2023-01-01T01:00:00Z",
            },
            visitConfidence: 0.95,
          },
        },
      ],
    });
    const fp = tmpFile(json);
    const res = await collect(parseSemanticLocationHistory(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.placeId).toBe("abc123");
    expect(ev.name).toBe("HQ");
    expect(ev.startTime.toISOString()).toBe("2023-01-01T00:00:00.000Z");
  });
});

describe("parseKeep", () => {
  test("extracts a single Keep note", async () => {
    const json = JSON.stringify({
      title: "Shopping",
      color: "DEFAULT",
      isTrashed: false,
      isPinned: true,
      isArchived: false,
      userEditedTimestampUsec: 1_700_000_000_000_000,
      createdTimestampUsec: 1_600_000_000_000_000,
      textContent: "Eggs, Milk",
    });
    const fp = tmpFile(json);
    const res = await collect(parseKeep(fp));
    const ev = res[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.title).toBe("Shopping");
    expect(ev.textContent).toBe("Eggs, Milk");
    expect(ev.isPinned).toBe(true);
    expect(ev.created_dt.toISOString()).toBe("2020-09-13T12:26:40.000Z");
  });
});
