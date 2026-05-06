/**
 * Shared helpers for the HTML parsers — port of common bits from
 * `parse_html/activity.py`.
 */

import { type HTMLElement, type Node, NodeType, type TextNode } from "node-html-parser";

export function cleanLatin1Chars(s: string): string {
  // Latin-1 / wide non-breaking spaces in legacy exports → plain ASCII space.
  return s.replace(/\u00a0/g, " ").replace(/\u2003/g, " ");
}

export function isElement(n: Node): n is HTMLElement {
  return n.nodeType === NodeType.ELEMENT_NODE;
}

export function isText(n: Node): n is TextNode {
  return n.nodeType === NodeType.TEXT_NODE;
}

/** Returns text content with HTML entities decoded. */
export function nodeText(n: HTMLElement | TextNode): string {
  // `.text` decodes HTML entities (e.g. `&nbsp;` → `\u00a0`); `.rawText` does
  // not. We always want decoded text — `cleanLatin1Chars` then collapses the
  // resulting `\u00a0` / `\u2003` to plain spaces.
  return n.text;
}

/**
 * Splits a flat list of nodes into groups separated by `<br>` elements.
 *
 * Mirrors `_group_by_brs` in `parse_html/activity.py`. Used to read
 * line-separated content out of the legacy My Activity layout.
 */
export type Token = HTMLElement | TextNode;

export function groupByBrs(nodes: Node[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  for (const n of nodes) {
    if (isElement(n)) {
      if (n.tagName?.toLowerCase() === "br") {
        out.push(cur);
        cur = [];
      } else {
        cur.push(n);
      }
    } else if (isText(n)) {
      cur.push(n);
    }
    // Other node types (comments, etc.) are ignored.
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
