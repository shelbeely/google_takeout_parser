/**
 * Path dispatch — port of `path_dispatch.py`.
 *
 * Walks a Takeout directory, matches each file against the active
 * `HandlerMap`(s), and yields a single async stream of `Result<Event>`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { type HandlerFunction, type HandlerMap, LOCALES } from "../locales/index.ts";
import {
  type EventKind,
  type GoogleEvent,
  type Result,
  isError,
  makeError,
} from "../models/index.ts";

export type ErrorPolicy = "yield" | "raise" | "drop";

export interface DispatchOptions {
  /** Locale name (e.g. "EN"). If omitted, locales are scored by # of matches. */
  localeName?: string | undefined;
  /** Override handler maps directly (overrides locale resolution). */
  handlers?: HandlerMap[] | undefined;
  /** Filter to only emit these event kinds. */
  filter?: ReadonlySet<EventKind> | undefined;
  /** "yield" (default) returns errors as values; "drop" silently swallows. */
  errorPolicy?: ErrorPolicy | undefined;
  /** When true, log unhandled-file warnings to stderr. */
  warnUnhandled?: boolean | undefined;
}

interface MatchResult {
  handler: HandlerFunction | null; // null = explicitly ignored
  matched: true;
}
interface NoMatch {
  matched: false;
}
type HandlerLookup = MatchResult | NoMatch;

function matchOne(relPath: string, hm: HandlerMap): HandlerLookup {
  for (const [re, handler] of hm) {
    if (re.test(relPath)) {
      return { matched: true, handler };
    }
  }
  return { matched: false };
}

async function* walkFiles(root: string): AsyncIterable<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        yield full;
      }
    }
  }
}

/**
 * Resolve which handler maps to use for this dispatch.
 *
 * Resolution order: explicit handlers > localeName > envvar > guess by score.
 */
async function resolveHandlerMaps(
  takeoutDir: string,
  opts: DispatchOptions,
): Promise<HandlerMap[]> {
  if (opts.handlers && opts.handlers.length > 0) return opts.handlers;
  const explicitName = opts.localeName ?? process.env.GOOGLE_TAKEOUT_PARSER_LOCALE ?? undefined;
  if (explicitName && LOCALES[explicitName]) {
    return [LOCALES[explicitName]];
  }
  // No explicit locale: score every locale by how many files it can match.
  const scores: Array<[string, number, HandlerMap]> = [];
  for (const [name, hm] of Object.entries(LOCALES)) {
    let count = 0;
    for await (const f of walkFiles(takeoutDir)) {
      const rel = path.relative(takeoutDir, f).split(path.sep).join("/");
      const r = matchOne(rel, hm);
      if (r.matched) count++;
    }
    scores.push([name, count, hm]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return scores.map(([, , hm]) => hm);
}

export class TakeoutParser {
  readonly takeoutDir: string;
  readonly opts: DispatchOptions;
  private handlerMaps: HandlerMap[] | null = null;

  constructor(takeoutDir: string, opts: DispatchOptions = {}) {
    this.takeoutDir = path.resolve(takeoutDir);
    this.opts = opts;
  }

  private async ensureHandlers(): Promise<HandlerMap[]> {
    if (this.handlerMaps) return this.handlerMaps;
    const stat = await fs.stat(this.takeoutDir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Takeout dir does not exist: ${this.takeoutDir}`);
    }
    this.handlerMaps = await resolveHandlerMaps(this.takeoutDir, this.opts);
    return this.handlerMaps;
  }

  /**
   * Build the file -> handler dispatch map for the current Takeout.
   * Useful for diagnostics and progress reporting.
   */
  async dispatchMap(): Promise<Map<string, HandlerFunction>> {
    const maps = await this.ensureHandlers();
    const out = new Map<string, HandlerFunction>();
    for await (const f of walkFiles(this.takeoutDir)) {
      const rel = path.relative(this.takeoutDir, f).split(path.sep).join("/");
      let resolved = false;
      for (const hm of maps) {
        const r = matchOne(rel, hm);
        if (r.matched) {
          if (r.handler != null) out.set(f, r.handler);
          resolved = true;
          break;
        }
      }
      if (!resolved && this.opts.warnUnhandled !== false) {
        process.stderr.write(`unhandled file: ${rel}\n`);
      }
    }
    return out;
  }

  /** Stream every parsed event (and parse errors per the error policy). */
  async *parse(): AsyncIterable<Result<GoogleEvent>> {
    const dispatch = await this.dispatchMap();
    const filter = this.opts.filter;
    const policy: ErrorPolicy = this.opts.errorPolicy ?? "yield";
    for (const [file, handler] of dispatch) {
      try {
        for await (const ev of handler(file)) {
          if (isError(ev)) {
            if (policy === "raise") throw new Error(ev.message);
            if (policy === "drop") continue;
            yield ev;
            continue;
          }
          if (filter && !filter.has(ev.kind)) continue;
          yield ev;
        }
      } catch (e) {
        const err = makeError(
          `Handler crashed on ${file}: ${e instanceof Error ? e.message : String(e)}`,
          file,
          e,
        );
        if (policy === "raise") throw e;
        if (policy === "drop") continue;
        yield err;
      }
    }
  }

  /** Convenience: collect everything into an array. */
  async parseAll(): Promise<Result<GoogleEvent>[]> {
    const out: Result<GoogleEvent>[] = [];
    for await (const ev of this.parse()) out.push(ev);
    return out;
  }
}
