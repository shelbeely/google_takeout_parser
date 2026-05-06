import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isError } from "../src/models/index.ts";
import { parseHtmlActivity, parseHtmlComments, parseHtmlDt } from "../src/parsers/html/index.ts";

const FIXTURE = path.join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "testdata",
  "HtmlTakeout",
  "My Activity",
  "Chrome",
  "MyActivity.html",
);

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseHtmlDt", () => {
  test("no timezone (pre-2018) → UTC", () => {
    const d = parseHtmlDt("Jun 23, 2015, 2:43:45 PM");
    expect(d.toISOString()).toBe("2015-06-23T14:43:45.000Z");
  });

  test("explicit UTC abbreviation → UTC", () => {
    const d = parseHtmlDt("Jan 22, 2020, 8:34:00 PM UTC");
    expect(d.toISOString()).toBe("2020-01-22T20:34:00.000Z");
  });

  test("GMT abbreviation → UTC equivalent", () => {
    const d = parseHtmlDt("Jan 25, 2019, 8:23:48 AM GMT");
    expect(d.toISOString()).toBe("2019-01-25T08:23:48.000Z");
  });

  test("AM 12:xx maps to 00:xx", () => {
    const d = parseHtmlDt("Jan 1, 2020, 12:30:00 AM UTC");
    expect(d.toISOString()).toBe("2020-01-01T00:30:00.000Z");
  });

  test("PM 12:xx stays at 12:xx", () => {
    const d = parseHtmlDt("Jan 1, 2020, 12:30:00 PM UTC");
    expect(d.toISOString()).toBe("2020-01-01T12:30:00.000Z");
  });

  test("MSK abbreviation → Europe/Moscow offset", () => {
    // MSK is UTC+3 year-round, so 8:51:45 PM MSK == 17:51:45 UTC.
    const d = parseHtmlDt("Sep 10, 2019, 8:51:45 PM MSK");
    expect(d.toISOString()).toBe("2019-09-10T17:51:45.000Z");
  });

  test("unknown abbreviation → falls back to UTC", () => {
    const d = parseHtmlDt("Jan 1, 2020, 1:00:00 AM XYZ");
    expect(d.toISOString()).toBe("2020-01-01T01:00:00.000Z");
  });

  test("invalid string throws", () => {
    expect(() => parseHtmlDt("not a date")).toThrow();
  });
});

describe("parseHtmlActivity", () => {
  test("parses the bundled MyActivity.html fixture", async () => {
    const out = await collect(parseHtmlActivity(FIXTURE));
    // Should yield three Activity events (no errors).
    expect(out).toHaveLength(3);
    for (const ev of out) {
      expect(isError(ev)).toBe(false);
      if (!isError(ev)) {
        expect(ev.kind).toBe("activity");
        expect(ev.header).toBe("Search");
        expect(ev.products).toContain("Search");
      }
    }
  });

  test("first event has expected title/url/time", async () => {
    const out = await collect(parseHtmlActivity(FIXTURE));
    const first = out[0]!;
    if (isError(first)) throw new Error("expected success");
    expect(first.title).toContain("Visited");
    // URL on the title row → titleUrl (after pop).
    expect(first.titleUrl).toBe("https://productforums.google.com/forum/");
    // "Jan 31, 2018, 10:54:50 PM" with no tz → UTC.
    expect(first.time.toISOString()).toBe("2018-01-31T22:54:50.000Z");
  });

  test("third event includes a Locations entry", async () => {
    const out = await collect(parseHtmlActivity(FIXTURE));
    const third = out[2]!;
    if (isError(third)) throw new Error("expected success");
    expect(third.locationInfos.length).toBeGreaterThanOrEqual(1);
    const li = third.locationInfos[0]!;
    // The fixture's URL `https://google.com/maps?q=...` lacks 2+ of the
    // location-api query params, so it's treated as `sourceUrl`, not `url`.
    expect(li.sourceUrl).toContain("google.com/maps");
    expect(li.sourceUrl?.startsWith("https://")).toBe(true);
  });

  test("rewrites Google http URLs to https", async () => {
    const out = await collect(parseHtmlActivity(FIXTURE));
    for (const ev of out) {
      if (isError(ev)) continue;
      if (!ev.titleUrl) continue;
      let host: string;
      try {
        host = new URL(ev.titleUrl).hostname;
      } catch {
        continue;
      }
      if (host === "google.com" || host.endsWith(".google.com")) {
        expect(ev.titleUrl.startsWith("https://")).toBe(true);
      }
    }
  });
});

describe("parseHtmlComments", () => {
  test("parses an inline <li>", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "html-comment-"));
    const file = path.join(tmp, "comments.html");
    writeFileSync(
      file,
      `<ul><li>Sent at 2020-04-27 23:18:23 UTC while watching <a href="http://www.youtube.com/watch?v=mM">a video</a>.<br/>content here</li></ul>`,
    );
    const out = await collect(parseHtmlComments(file));
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    if (isError(ev)) throw new Error("expected success");
    expect(ev.kind).toBe("youtubeComment");
    expect(ev.content).toBe("content here");
    expect(ev.dt.toISOString()).toBe("2020-04-27T23:18:23.000Z");
    expect(ev.urls).toEqual(["https://www.youtube.com/watch?v=mM"]);
  });

  test("parses pre-2019 ISO date format", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "html-comment-"));
    const file = path.join(tmp, "comments.html");
    writeFileSync(
      file,
      `<ul><li>Sent on 2016-06-15T08:50:49Z while watching <a href="http://youtu.be/x">x</a>.<br/>old comment</li></ul>`,
    );
    const out = await collect(parseHtmlComments(file));
    const ev = out[0]!;
    if (isError(ev)) throw new Error("expected success");
    expect(ev.dt.toISOString()).toBe("2016-06-15T08:50:49.000Z");
    expect(ev.content).toBe("old comment");
  });

  test("yields ParseError on malformed li", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "html-comment-"));
    const file = path.join(tmp, "comments.html");
    writeFileSync(file, "<ul><li>no date here<br/>body</li></ul>");
    const out = await collect(parseHtmlComments(file));
    expect(out).toHaveLength(1);
    expect(isError(out[0]!)).toBe(true);
  });
});
