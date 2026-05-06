#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import path from "node:path";
/**
 * CLI entrypoint — `google-takeout-parser`.
 *
 * Subcommands mirror the Python tool plus a new `--format` flag for
 * agent-native exporters:
 *
 *   parse <takeout-dir>            Parse one Takeout
 *   merge <takeout-dir>...         Merge & dedup multiple Takeouts
 *   cache (path|clear)             Inspect / clear the cache
 *
 * Common options:
 *   --format ndjson|openviking|openclaw|jsonl|json   (comma-separated allowed)
 *   --out <dir-or-file>            Output destination (required for non-stdout formats)
 *   --filter <kind>                Filter to one or more event kinds
 *   --locale <EN|DE>               Force a locale
 *   --no-cache / --cache-dir       Cache control
 *   --quiet / --verbose
 */
import { parseArgs } from "node:util";
import { TakeoutCache, defaultCacheDir } from "../cache/index.ts";
import { TakeoutParser } from "../dispatch/index.ts";
import { writeNdjson, writeOpenClaw, writeOpenViking } from "../exporters/index.ts";
import { serializeEvent } from "../exporters/serialize.ts";
import { listLocales } from "../locales/index.ts";
import { mergeEvents } from "../merge/index.ts";
import {
  ALL_EVENT_KINDS,
  type EventKind,
  type GoogleEvent,
  type Result,
  isError,
} from "../models/index.ts";
import { PARSER_VERSION } from "../version.ts";

type Format = "ndjson" | "openviking" | "openclaw" | "jsonl" | "json";

interface CommonOpts {
  formats: Format[];
  out: string | undefined;
  filter: Set<EventKind> | undefined;
  locale: string | undefined;
  cache: boolean;
  cacheDir: string;
  verbose: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function parseFormats(s: string | undefined): Format[] {
  const valid: Format[] = ["ndjson", "openviking", "openclaw", "jsonl", "json"];
  if (!s) return ["jsonl"]; // default to stdout JSONL
  const parts = s.split(",").map((x) => x.trim().toLowerCase()) as Format[];
  for (const p of parts) {
    if (!valid.includes(p)) fail(`invalid --format value: ${p} (valid: ${valid.join(", ")})`);
  }
  return parts;
}

function parseFilter(s: string[] | undefined): Set<EventKind> | undefined {
  if (!s || s.length === 0) return undefined;
  const set = new Set<EventKind>();
  for (const k of s) {
    if (!(ALL_EVENT_KINDS as readonly string[]).includes(k)) {
      fail(`invalid --filter kind: ${k} (valid: ${ALL_EVENT_KINDS.join(", ")})`);
    }
    set.add(k as EventKind);
  }
  return set;
}

function printHelp(): void {
  process.stdout.write(
    `google-takeout-parser v${PARSER_VERSION}

Usage:
  google-takeout-parser parse [options] <takeout-dir>
  google-takeout-parser merge [options] <takeout-dir>...
  google-takeout-parser cache (path|clear|list)
  google-takeout-parser --help
  google-takeout-parser --version

Options:
  -f, --format <list>     Output format(s): ndjson,openviking,openclaw,jsonl,json (default: jsonl)
  -o, --out <path>        Output dir or file (required for ndjson/openviking/openclaw)
      --filter <kind>     Only emit events of this kind (repeatable). Kinds: ${ALL_EVENT_KINDS.join(", ")}
  -l, --locale <name>     Force a locale (${listLocales().join(", ")}). Default: auto-detect.
      --no-cache          Disable result cache
      --cache-dir <dir>   Override cache directory (default: ${defaultCacheDir()})
  -v, --verbose           Verbose logging
  -q, --quiet             Quiet mode
      --skill-name <s>    OpenClaw: name to put in skill.json
      --skill-desc <s>    OpenClaw: description to put in skill.json
  -h, --help              Show this help
  -V, --version           Show version
`,
  );
}

function readCommon(values: Record<string, any>): CommonOpts {
  return {
    formats: parseFormats(values.format),
    out: values.out,
    filter: parseFilter(values.filter as string[] | undefined),
    locale: values.locale,
    cache: values.cache !== false,
    cacheDir: values["cache-dir"] ?? defaultCacheDir(),
    verbose: !!values.verbose,
  };
}

async function streamFromTakeouts(
  dirs: string[],
  opts: CommonOpts,
): Promise<AsyncIterable<Result<GoogleEvent>>> {
  for (const d of dirs) {
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      fail(`Takeout dir does not exist: ${d}`);
    }
  }
  const parsers = dirs.map(
    (d) =>
      new TakeoutParser(d, {
        localeName: opts.locale,
        filter: opts.filter,
        warnUnhandled: opts.verbose,
        errorPolicy: "yield",
      }),
  );
  if (parsers.length === 1) return parsers[0]!.parse();
  return mergeEvents(...parsers.map((p) => p.parse()));
}

async function runFormats(
  events: AsyncIterable<Result<GoogleEvent>>,
  opts: CommonOpts,
  sources: string[],
  skillName: string | undefined,
  skillDesc: string | undefined,
): Promise<void> {
  // Single-format and stdout-format short circuit.
  if (opts.formats.length === 1 && (opts.formats[0] === "jsonl" || opts.formats[0] === "json")) {
    const buf: any[] = [];
    for await (const ev of events) {
      if (isError(ev)) {
        if (opts.verbose) process.stderr.write(`${ev.message}\n`);
        continue;
      }
      const obj = serializeEvent(ev);
      if (opts.formats[0] === "jsonl") process.stdout.write(`${JSON.stringify(obj)}\n`);
      else buf.push(obj);
    }
    if (opts.formats[0] === "json") process.stdout.write(JSON.stringify(buf, null, 2));
    return;
  }

  // For file/directory exporters we may need to fan out — buffer events once
  // and re-iterate per format. (Memory cost: a single GoogleEvent[] in RAM.)
  const buffered: Result<GoogleEvent>[] = [];
  for await (const ev of events) buffered.push(ev);

  if (!opts.out) fail("--out is required for ndjson/openviking/openclaw formats");
  for (const fmt of opts.formats) {
    const replay: AsyncIterable<Result<GoogleEvent>> = (async function* () {
      for (const ev of buffered) yield ev;
    })();
    const target = opts.formats.length === 1 ? opts.out! : path.join(opts.out!, fmt);
    if (fmt === "ndjson" || fmt === "jsonl") {
      const stats = await writeNdjson(
        target.endsWith(".ndjson") ? target : path.join(target, "events.ndjson"),
        replay,
      );
      process.stderr.write(`wrote ${stats.events} events to ${stats.outPath}\n`);
    } else if (fmt === "openviking") {
      const stats = await writeOpenViking(target, replay, { sources });
      process.stderr.write(
        `OpenViking pack: ${stats.totalEvents} events across ${Object.keys(stats.perFamily).length} families -> ${stats.outDir}\n`,
      );
    } else if (fmt === "openclaw") {
      const stats = await writeOpenClaw(target, replay, {
        sources,
        skillName,
        skillDescription: skillDesc,
      });
      process.stderr.write(
        `OpenClaw skill bundle: ${stats.totalEvents} events -> ${stats.outDir}\n`,
      );
    } else if (fmt === "json") {
      const buf = buffered.filter((e) => !isError(e)).map((e) => serializeEvent(e as GoogleEvent));
      process.stdout.write(JSON.stringify(buf, null, 2));
    }
  }
}

const COMMON_OPTIONS = {
  format: { type: "string", short: "f" },
  out: { type: "string", short: "o" },
  filter: { type: "string", multiple: true },
  locale: { type: "string", short: "l" },
  cache: { type: "boolean", default: true },
  "cache-dir": { type: "string" },
  verbose: { type: "boolean", short: "v" },
  quiet: { type: "boolean", short: "q" },
  "skill-name": { type: "string" },
  "skill-desc": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    return;
  }
  if (argv[0] === "-V" || argv[0] === "--version") {
    process.stdout.write(`${PARSER_VERSION}\n`);
    return;
  }
  const cmd = argv[0]!;
  const rest = argv.slice(1);

  if (cmd === "cache") {
    const sub = rest[0] ?? "path";
    const cacheDir = process.env.GOOGLE_TAKEOUT_PARSER_CACHE_DIR ?? defaultCacheDir();
    const c = new TakeoutCache(cacheDir);
    if (sub === "path") process.stdout.write(`${cacheDir}\n`);
    else if (sub === "list") {
      for (const r of c.list()) process.stdout.write(`${r.cache_key}\t${r.payload_path}\n`);
    } else if (sub === "clear") {
      c.clear();
      process.stdout.write(`cleared ${cacheDir}\n`);
    } else fail(`unknown cache subcommand: ${sub}`);
    c.close();
    return;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: COMMON_OPTIONS,
      allowPositionals: true,
    });
  } catch (e) {
    fail((e as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    printHelp();
    return;
  }

  const opts = readCommon(values);
  const skillName = values["skill-name"] as string | undefined;
  const skillDesc = values["skill-desc"] as string | undefined;

  if (cmd === "parse") {
    if (positionals.length !== 1) fail("parse takes exactly one <takeout-dir>");
    const dir = path.resolve(positionals[0]!);
    const events = await streamFromTakeouts([dir], opts);
    await runFormats(events, opts, [dir], skillName, skillDesc);
  } else if (cmd === "merge") {
    if (positionals.length === 0) fail("merge takes one or more <takeout-dir>");
    const dirs = positionals.map((p) => path.resolve(p));
    const events = await streamFromTakeouts(dirs, opts);
    await runFormats(events, opts, dirs, skillName, skillDesc);
  } else {
    fail(`unknown command: ${cmd}`);
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
