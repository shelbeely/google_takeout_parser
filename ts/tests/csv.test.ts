import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isError } from "../src/models/index.ts";
import {
  extractCommentLinks,
  parseCsv,
  parseYoutubeCommentsCsv,
  parseYoutubeLiveChatsCsv,
  reconstructCommentContent,
} from "../src/parsers/csv/index.ts";

function tmpFile(contents: string, name = "file.csv"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gtp-csv-"));
  const fp = path.join(dir, name);
  writeFileSync(fp, contents, "utf-8");
  return fp;
}

describe("parseCsv", () => {
  test("handles quoted fields with commas and embedded newlines", () => {
    const text = `a,b,c\r\n"hello, world","line1\nline2","quote ""inside"""\r\n`;
    const rows = [...parseCsv(text)];
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["hello, world", "line1\nline2", 'quote "inside"'],
    ]);
  });

  test("handles trailing newline without producing empty row", () => {
    const rows = [...parseCsv("a,b\nc,d\n")];
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("handles missing trailing newline", () => {
    const rows = [...parseCsv("a,b\nc,d")];
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseYoutubeCommentsCsv", () => {
  test("parses a single comment row", async () => {
    const text =
      "Comment ID,Channel ID,Comment Create Timestamp,Price,Parent Comment ID,Video ID,Comment Text\r\n" +
      `Ugxabc,UC123,2023-05-01T12:00:00Z,,,vid123,"{""takeoutSegments"":[{""text"":""hello""}]}"\r\n`;
    const fp = tmpFile(text);
    const out: any[] = [];
    for await (const r of parseYoutubeCommentsCsv(fp)) out.push(r);
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.commentId).toBe("Ugxabc");
    expect(ev.videoId).toBe("vid123");
    expect(ev.parentCommentId).toBeNull();
    expect(ev.dt.toISOString()).toBe("2023-05-01T12:00:00.000Z");
  });
});

describe("parseYoutubeLiveChatsCsv", () => {
  test("parses positional rows", async () => {
    const text =
      "Live Chat ID,Channel ID,Live Chat Create Timestamp,Price,Video ID,Live Chat Text\r\n" +
      `lc1,UC123,2023-05-01T12:00:00Z,,vid456,"{""takeoutSegments"":[{""text"":""hi""}]}"\r\n`;
    const fp = tmpFile(text);
    const out: any[] = [];
    for await (const r of parseYoutubeLiveChatsCsv(fp)) out.push(r);
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    if (isError(ev)) throw new Error(ev.message);
    expect(ev.liveChatId).toBe("lc1");
    expect(ev.videoId).toBe("vid456");
  });
});

describe("reconstructCommentContent", () => {
  test("reconstructs text from old takeoutSegments format", () => {
    const content = JSON.stringify({
      takeoutSegments: [{ text: "Hello, " }, { text: "world!" }],
    });
    const r = reconstructCommentContent(content, "text");
    expect(r).toBe("Hello, world!");
  });

  test("reconstructs markdown with link segments", () => {
    const content = JSON.stringify({
      takeoutSegments: [
        { text: "see " },
        { text: "this", link: { linkUrl: "https://example.com" } },
      ],
    });
    const r = reconstructCommentContent(content, "markdown");
    expect(r).toBe("see [this](https://example.com)");
  });

  test("extractCommentLinks returns just the URLs", () => {
    const content = JSON.stringify({
      takeoutSegments: [
        { text: "see " },
        { text: "this", link: { linkUrl: "https://a.com" } },
        { text: " or " },
        { link: { linkUrl: "https://b.com" } },
      ],
    });
    const r = extractCommentLinks(content);
    expect(r).toEqual(["https://a.com", "https://b.com"]);
  });

  test("returns ParseError for malformed input", () => {
    const r = reconstructCommentContent("not json", "text");
    expect(isError(r)).toBe(true);
  });
});
