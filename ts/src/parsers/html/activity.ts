/**
 * Legacy My Activity HTML parser — port of `parse_html/activity.py`.
 *
 * The HTML format consists of a series of `<div class="outer-cell">` blocks,
 * each containing:
 *   - a header `<p class="mdl-typography--title">` (e.g. "Search", "YouTube")
 *   - a body content cell (`mdl-typography--body-1`) holding the title /
 *     subtitles / event datetime
 *   - a caption cell (`mdl-typography--caption`) holding labelled groups
 *     ("Products:", "Locations:", "Details:")
 *
 * See `_parse_activity_div` in the Python code for the equivalent shape. We
 * mirror the parsing strategy with `node-html-parser` instead of bs4.
 */

import { promises as fs } from "node:fs";
import { type HTMLElement, type Node, parse as parseHtml } from "node-html-parser";
import {
  type Activity,
  type LocationInfo,
  type Result,
  type Subtitle,
  makeError,
} from "../../models/index.ts";
import { convertToHttpsOpt } from "../../util/httpAllowlist.ts";
import { parseHtmlDt } from "./htmlTime.ts";
import { type Token, cleanLatin1Chars, groupByBrs, isElement, isText, nodeText } from "./shared.ts";

// ---------------------------------------------------------------------------
// Subtitle parsing
// ---------------------------------------------------------------------------

function parseSubtitles(
  cell: HTMLElement,
  fileDt: Date | null,
): { subtitles: Subtitle[]; dt: Date } {
  const children = cell.childNodes as Node[];
  if (children.length === 0) {
    throw new Error("Empty subtitle cell");
  }
  // Last child should be a text node carrying the datetime.
  const dtNode = children[children.length - 1]!;
  if (!isText(dtNode)) {
    throw new Error(`Expected last subtitle child to be text (datetime), got ${dtNode.nodeType}`);
  }
  const dt = parseHtmlDt(nodeText(dtNode).trim(), { fileDt });

  const head = children.slice(0, -1);
  const subtitles: Subtitle[] = [];
  for (const group of groupByBrs(head)) {
    let buf = "";
    let url: string | null = null;
    for (const tok of group) {
      if (isText(tok)) {
        buf += nodeText(tok);
      } else if (isElement(tok)) {
        if (tok.tagName?.toLowerCase() === "a") {
          buf += nodeText(tok);
          const href = tok.getAttribute("href");
          if (href) url = href;
        }
      }
    }
    subtitles.push({
      name: cleanLatin1Chars(buf),
      url: convertToHttpsOpt(url),
    });
  }
  return { subtitles, dt };
}

// ---------------------------------------------------------------------------
// Caption parsing
// ---------------------------------------------------------------------------

function splitByCaptionHeaders(groups: Token[][]): Map<string, Token[][]> {
  const out = new Map<string, Token[][]>();
  let key = "";
  let vals: Token[][] = [];
  for (const g of groups) {
    const first = g[0];
    if (
      first &&
      isElement(first) &&
      first.tagName?.toLowerCase() === "b" &&
      first.textContent.endsWith(":")
    ) {
      if (key) {
        out.set(key, vals);
        vals = [];
      }
      key = nodeText(first).trim();
    } else if (key) {
      vals.push(g);
    }
    // Pre-key content is skipped (parity with Python's assertion path).
  }
  if (vals.length > 0 && key) out.set(key, vals);
  return out;
}

const COMMON_GMAPS_QUERY_PARAMS = ["api", "map_action", "center", "zoom"];

function isLocationApiLink(url: string): boolean {
  try {
    const u = new URL(url);
    let n = 0;
    for (const p of COMMON_GMAPS_QUERY_PARAMS) {
      if (u.searchParams.has(p)) n++;
    }
    return n > 2;
  } catch {
    return false;
  }
}

function parseCaption(cell: HTMLElement): {
  details: string[];
  locationInfos: LocationInfo[];
  products: string[];
} {
  const details: string[] = [];
  const locationInfos: LocationInfo[] = [];
  const products: string[] = [];

  const groups = groupByBrs(cell.childNodes as Node[]);
  const split = splitByCaptionHeaders(groups);

  for (const [header, values] of split) {
    for (const value of values) {
      if (header === "Products:") {
        const first = value[0];
        if (first) {
          const txt = nodeText(first);
          products.push(cleanLatin1Chars(txt).trim());
        }
      } else if (header === "Locations:") {
        let name: string | null = null;
        let url: string | null = null;
        let source: string | null = null;
        let sourceUrl: string | null = null;
        let textbuf = "";
        const links: string[] = [];
        for (const tok of value) {
          if (isText(tok)) {
            textbuf += nodeText(tok);
          } else if (isElement(tok)) {
            textbuf += nodeText(tok);
            if (tok.tagName?.toLowerCase() === "a") {
              const href = tok.getAttribute("href");
              if (href) links.push(href);
            }
          }
        }
        textbuf = cleanLatin1Chars(textbuf).trim();

        if (textbuf.includes("-")) {
          const idx = textbuf.indexOf("-");
          name = textbuf.slice(0, idx).trim();
          source = textbuf.slice(idx + 1).trim();
        }

        if (links.length === 2) {
          url = links[0]!;
          sourceUrl = links[1]!;
        } else if (links.length === 1) {
          const only = links[0]!;
          if (isLocationApiLink(only)) {
            url = only;
            if (name === null) name = textbuf;
          } else {
            sourceUrl = only;
            if (source === null) source = textbuf;
          }
        } else {
          source = textbuf;
        }

        locationInfos.push({
          name,
          url: convertToHttpsOpt(url),
          source,
          sourceUrl: convertToHttpsOpt(sourceUrl),
        });
      } else if (header === "Details:") {
        const first = value[0];
        if (first) {
          const txt = nodeText(first);
          details.push(cleanLatin1Chars(txt).trim());
        }
      }
      // Unknown headers are ignored (parity with the Python warning path).
    }
  }

  return { details, locationInfos, products };
}

// ---------------------------------------------------------------------------
// Per-div parsing
// ---------------------------------------------------------------------------

function parseActivityDiv(div: HTMLElement, fileDt: Date | null): Activity {
  const headerEl = div.querySelector("p.mdl-typography--title");
  if (!headerEl) throw new Error("Could not find header element");
  const header = nodeText(headerEl).trim();

  const subtitleCells: HTMLElement[] = [];
  const captionCells: HTMLElement[] = [];

  for (const d of div.querySelectorAll(".content-cell")) {
    const classAttr = d.getAttribute("class") ?? "";
    if (classAttr.includes("mdl-typography--text-right")) continue;
    if (classAttr.includes("mdl-typography--body-1")) subtitleCells.push(d);
    else if (classAttr.includes("mdl-typography--caption")) captionCells.push(d);
  }

  if (subtitleCells.length !== 1) {
    throw new Error(`Expected one body cell, found ${subtitleCells.length}`);
  }
  if (captionCells.length !== 1) {
    throw new Error(`Expected one caption cell, found ${captionCells.length}`);
  }

  const { subtitles, dt } = parseSubtitles(subtitleCells[0]!, fileDt);
  const { details, locationInfos, products } = parseCaption(captionCells[0]!);

  if (subtitles.length === 0) {
    throw new Error("Could not extract a title from div");
  }
  const titleInfo = subtitles.shift()!;

  return {
    kind: "activity",
    header,
    title: titleInfo.name,
    titleUrl: convertToHttpsOpt(titleInfo.url),
    description: null,
    time: dt,
    locationInfos,
    subtitles,
    details,
    products,
  };
}

// ---------------------------------------------------------------------------
// File-level parser
// ---------------------------------------------------------------------------

export async function* parseHtmlActivity(path: string): AsyncIterable<Result<Activity>> {
  let text: string;
  let fileDt: Date | null = null;
  try {
    const stat = await fs.stat(path);
    fileDt = stat.mtime;
    text = await fs.readFile(path, "utf-8");
  } catch (e) {
    yield makeError(`HTML activity: failed to read '${path}'`, path, e);
    return;
  }
  let root: HTMLElement;
  try {
    root = parseHtml(text);
  } catch (e) {
    yield makeError(`HTML activity: failed to parse HTML in '${path}'`, path, e);
    return;
  }
  for (const div of root.querySelectorAll("div.outer-cell")) {
    try {
      yield parseActivityDiv(div, fileDt);
    } catch (e) {
      yield makeError(`HTML activity div parse failed in '${path}'`, path, e);
    }
  }
}
