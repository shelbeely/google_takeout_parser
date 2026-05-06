/**
 * Legacy My-Comments HTML parser — port of `parse_html/comment.py`.
 *
 * The file is a flat `<ul><li>…</li>…</ul>` list. Each `<li>` is structured as:
 *
 *   <li>Sent at YYYY-MM-DD HH:MM:SS UTC while watching <a href="…">a video</a>.
 *       <br/>
 *       comment text, possibly with <a href="…">links</a>
 *   </li>
 *
 * The date format has historically been one of:
 *   - 2020-05-06 19:32:44 UTC
 *   - 2016-06-15T08:50:49Z   (pre-2019)
 *
 * Both are treated as UTC.
 */

import { promises as fs } from "node:fs";
import { type HTMLElement, type Node, NodeType, parse as parseHtml } from "node-html-parser";
import { type Result, type YoutubeComment, makeError } from "../../models/index.ts";
import { convertToHttps } from "../../util/httpAllowlist.ts";
import { cleanLatin1Chars, groupByBrs, isElement, isText, nodeText } from "./shared.ts";

const COMMENT_DATE_REGEX = /(\d{4})-(\d{2})-(\d{2})(?:\s+|T)(\d{2}):(\d{2}):(\d{2})/;

function extractCommentDate(text: string): Date {
  const m = COMMENT_DATE_REGEX.exec(text);
  if (!m) throw new Error(`Couldn't parse date from '${text}'`);
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Date.UTC(
      Number.parseInt(y!, 10),
      Number.parseInt(mo!, 10) - 1,
      Number.parseInt(d!, 10),
      Number.parseInt(h!, 10),
      Number.parseInt(mi!, 10),
      Number.parseInt(s!, 10),
    ),
  );
}

function parseHtmlLi(li: HTMLElement): YoutubeComment {
  const dt = extractCommentDate(nodeText(li));
  const groups = groupByBrs(li.childNodes as Node[]);
  if (groups.length !== 2) {
    throw new Error(`Expected 2 parts separated by a <br /> in li, got ${groups.length}`);
  }
  let desc = "";
  for (const node of groups[1]!) {
    if (isText(node)) desc += nodeText(node);
    else if (isElement(node)) desc += nodeText(node);
  }
  const urls: string[] = [];
  for (const a of li.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (href) urls.push(convertToHttps(href));
  }
  return {
    kind: "youtubeComment",
    content: cleanLatin1Chars(desc).trim(),
    dt,
    urls,
  };
}

export async function* parseHtmlComments(path: string): AsyncIterable<Result<YoutubeComment>> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf-8");
  } catch (e) {
    yield makeError(`HTML comments: failed to read '${path}'`, path, e);
    return;
  }
  let root: HTMLElement;
  try {
    root = parseHtml(text);
  } catch (e) {
    yield makeError(`HTML comments: failed to parse HTML in '${path}'`, path, e);
    return;
  }
  for (const li of root.querySelectorAll("li")) {
    try {
      yield parseHtmlLi(li);
    } catch (e) {
      yield makeError(`HTML comment li parse failed in '${path}'`, path, e);
    }
  }
}

// Re-export for direct unit testing.
export { parseHtmlLi as _parseHtmlLi, extractCommentDate as _extractCommentDate };

// Required for parser registry.
void NodeType;
