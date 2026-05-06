/**
 * CSV parsers — port of `parse_csv.py` (YouTube comments / live chats).
 *
 * Includes a tiny RFC-4180-ish CSV reader; the YouTube CSVs are well-formed
 * (UTF-8, quoted fields, CRLF terminators) so a streaming character-level
 * parser is small and faster than pulling in a third-party dependency.
 */
import { promises as fs } from "node:fs";
import {
  type CSVYoutubeComment,
  type CSVYoutubeLiveChat,
  type Result,
  isError,
  makeError,
} from "../../models/index.ts";
import { parseJsonUtcDate } from "../../time/index.ts";

// ---------------------------------------------------------------------------
// Minimal CSV reader: yields rows as string[]. Handles quoted fields with
// embedded commas, newlines, and "" -> " escapes.
// ---------------------------------------------------------------------------

export function* parseCsv(text: string): Generator<string[]> {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const row: string[] = [];
    let field = "";
    let inQuotes = false;
    let lineEnded = false;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (i + 1 < n && text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === ",") {
        row.push(field);
        field = "";
        i++;
        continue;
      }
      if (c === "\r") {
        if (i + 1 < n && text[i + 1] === "\n") i += 2;
        else i++;
        row.push(field);
        lineEnded = true;
        break;
      }
      if (c === "\n") {
        i++;
        row.push(field);
        lineEnded = true;
        break;
      }
      field += c;
      i++;
    }
    if (!lineEnded) {
      // EOF without trailing newline — flush the in-progress field
      row.push(field);
    }
    // skip a single empty trailing row caused by a trailing newline at EOF
    if (i >= n && row.length === 1 && row[0] === "") return;
    yield row;
  }
}

function isEmptyRow(row: string[]): boolean {
  return row.length === 0 || row.every((c) => c.trim() === "");
}

// ---------------------------------------------------------------------------
// YouTube comments CSV (DictReader-based in Python)
// ---------------------------------------------------------------------------

function parseCommentRowDict(row: Record<string, string>): Result<CSVYoutubeComment> {
  try {
    const commentId = row["Comment ID"];
    const channelId = row["Channel ID"];
    const createdAt = row["Comment Create Timestamp"] ?? row["Comment create timestamp"];
    const price = row.Price;
    const parentRaw = row["Parent Comment ID"] ?? row["Parent comment ID"];
    const videoId = row["Video ID"];
    const textJSON = row["Comment Text"] ?? row["Comment text"];
    if (!commentId || !channelId || !createdAt || !videoId || textJSON == null) {
      return makeError("Missing required column in comment row", undefined, row);
    }
    return {
      kind: "csvYoutubeComment",
      commentId,
      channelId,
      dt: parseJsonUtcDate(createdAt),
      price: price ?? null,
      parentCommentId: parentRaw?.trim() ? parentRaw : null,
      videoId,
      contentJSON: textJSON,
    };
  } catch (e) {
    return makeError("Failed to parse comment row", undefined, e);
  }
}

export async function* parseYoutubeCommentsCsv(
  path: string,
): AsyncIterable<Result<CSVYoutubeComment>> {
  const text = await fs.readFile(path, "utf-8");
  const rows = parseCsv(text);
  const headerRow = rows.next();
  if (headerRow.done) return;
  const headers = headerRow.value;
  for (const row of rows) {
    if (isEmptyRow(row)) continue;
    const dict: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      dict[headers[i]!] = row[i] ?? "";
    }
    yield parseCommentRowDict(dict);
  }
}

// ---------------------------------------------------------------------------
// YouTube live chats CSV (positional reader in Python).
// Columns: Live Chat ID,Channel ID,Live Chat Create Timestamp,Price,Video ID,Live Chat Text
// ---------------------------------------------------------------------------

export async function* parseYoutubeLiveChatsCsv(
  path: string,
  opts: { skipFirst?: boolean } = { skipFirst: true },
): AsyncIterable<Result<CSVYoutubeLiveChat>> {
  const text = await fs.readFile(path, "utf-8");
  const rows = parseCsv(text);
  if (opts.skipFirst !== false) rows.next();
  for (const row of rows) {
    if (isEmptyRow(row)) continue;
    if (row.length !== 6) {
      yield makeError(`Expected 6 columns, got ${row.length}: ${row.join("|")}`);
      continue;
    }
    const [liveChatId, channelId, createdAt, price, videoId, textJSON] = row as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    try {
      yield {
        kind: "csvYoutubeLiveChat",
        liveChatId,
        channelId,
        dt: parseJsonUtcDate(createdAt),
        price: price && price.length > 0 ? price : null,
        videoId,
        contentJSON: textJSON,
      };
    } catch (e) {
      yield makeError("Failed to parse live chat row", path, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Reconstructing rich comment text — port of `reconstruct_comment_content` &
// `extract_comment_links`. The Takeout stores comment bodies as a JSON blob
// with `takeoutSegments`; the 2024+ format embeds them inline as serialized
// JSON fragments.
// ---------------------------------------------------------------------------

export type CommentOutputFormat = "text" | "markdown";

interface Segment {
  text?: string;
  link?: { linkUrl?: string };
}

function validateContent(content: string | Record<string, any>): Result<Segment[]> {
  if (typeof content === "string" && content.startsWith('{"text":"')) {
    // 2024+ format: comma-joined serialized JSONs
    const jsonEnd = '"}';
    const jsonStart = '{"';
    const split = content.split(`${jsonEnd},${jsonStart}`);
    const segs: Segment[] = [];
    for (let i = 0; i < split.length; i++) {
      let js = split[i]!;
      if (i !== 0) js = jsonStart + js;
      if (i !== split.length - 1) js = js + jsonEnd;
      js = js.replace(/\n/g, "\\n");
      try {
        segs.push(JSON.parse(js));
      } catch (e) {
        return makeError("Failed to JSON-parse comment segment", undefined, e);
      }
    }
    return segs;
  }
  let data: any;
  if (typeof content === "object" && content !== null) {
    data = content;
  } else {
    if (typeof content !== "string") {
      return makeError(`Expected str or dict, got ${typeof content}`);
    }
    try {
      data = JSON.parse(content);
    } catch (e) {
      return makeError("Comment content not valid JSON", undefined, e);
    }
  }
  if (!("takeoutSegments" in data)) {
    return makeError(`Expected 'takeoutSegments' in content`);
  }
  if (!Array.isArray(data.takeoutSegments)) {
    return makeError("Expected takeoutSegments to be a list");
  }
  return data.takeoutSegments as Segment[];
}

export function reconstructCommentContent(
  content: string | Record<string, any>,
  format: CommentOutputFormat,
): Result<string> {
  const segs = validateContent(content);
  if (isError(segs)) return segs;
  const out: string[] = [];
  for (const segment of segs) {
    if (format === "text") {
      if (segment.text != null) out.push(segment.text);
    } else if (format === "markdown") {
      if (segment.link?.linkUrl) {
        if (segment.text != null) out.push(`[${segment.text}](${segment.link.linkUrl})`);
        else out.push(segment.link.linkUrl);
      } else if (segment.text != null) {
        out.push(segment.text);
      } else {
        return makeError(`Expected 'text' or 'link' in segment: ${JSON.stringify(segment)}`);
      }
    }
  }
  return out.join("");
}

export function extractCommentLinks(content: string | Record<string, any>): Result<string[]> {
  const segs = validateContent(content);
  if (isError(segs)) return segs;
  const links: string[] = [];
  for (const segment of segs) {
    if (segment.link?.linkUrl) links.push(segment.link.linkUrl);
  }
  return links;
}
