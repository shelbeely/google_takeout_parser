# `@shelbeely/google-takeout-parser` — TypeScript / Bun port

A streaming parser for [Google Takeout][takeout] exports, written in TypeScript
on top of [Bun][bun]. Output formats are designed for AI-agent consumption:
the parser pre-bakes everything to disk so the agent never waits on parsing at
query time.

This is a port of the original Python package one directory up. It currently
covers the JSON and CSV parsers (Activity, Chrome history, Play installs,
Location history, Semantic Location history, Keep notes, YouTube likes,
YouTube comments CSV, YouTube live-chats CSV) plus EN and DE locales. The
legacy HTML parsers have **not** yet been ported (see "Status" below).

## Install

```bash
# As a CLI (one-off run via Bun)
bun x @shelbeely/google-takeout-parser parse ./Takeout

# As a library
bun add @shelbeely/google-takeout-parser
# or
npm install @shelbeely/google-takeout-parser

# As a standalone binary (no Bun required at runtime)
bun build --compile --outfile=./google-takeout-parser ./src/cli/bin.ts
```

## CLI

```
google-takeout-parser parse [options] <takeout-dir>
google-takeout-parser merge [options] <takeout-dir>...
google-takeout-parser cache (path|clear|list)
```

Common options:

| Flag | Description |
| ---- | ----------- |
| `-f, --format` | Comma-separated list: `ndjson`, `openviking`, `openclaw`, `jsonl`, `json`. Default: `jsonl` (stdout). |
| `-o, --out` | Output dir or file. Required for `ndjson`/`openviking`/`openclaw`. |
| `--filter <kind>` | Only emit events of this kind (repeatable). |
| `-l, --locale <name>` | Force a locale (`EN`, `DE`). Default: auto-detect. |
| `--no-cache`, `--cache-dir` | Cache control. |
| `-v, --verbose`, `-q, --quiet` | Logging. |

### Recipes

**Plain NDJSON for shell pipelines:**

```bash
google-takeout-parser parse ./Takeout > events.ndjson
jq -c 'select(.kind=="activity" and .header=="YouTube")' events.ndjson | wc -l
```

**OpenClaw skill bundle** — drop into an OpenClaw skill directory and point
the `read SQLite + render` skill at it. No Python, no parsing, no startup
latency.

```bash
google-takeout-parser parse \
  --format openclaw \
  --out ~/.openclaw/skills/google-takeout \
  --skill-name "google-takeout" \
  --skill-desc "Pre-parsed Google Takeout. SQL via by-date.sqlite, FTS5 via search.sqlite." \
  ./Takeout
```

The bundle contains:

- `skill.json` — manifest enumerating resources and capabilities.
- `manifest.json` — schema version, generated-at, sha256s.
- `by-date.sqlite` — one table per event kind (`events_<kind>`),
  indexed on `(ts, key)`.
- `search.sqlite` — FTS5 virtual tables `search_activity`,
  `search_youtube_comments`, `search_keep`, `search_chrome`.
- `digests/daily/<YYYY-MM-DD>.md`, `digests/weekly/<YYYY-Www>.md`,
  `digests/by-product.md` — pre-rendered Markdown summaries the agent can
  prompt-stuff verbatim.

**OpenViking Context Database** — output a directory in the OpenViking
filesystem-paradigm shape with L0/L1/L2 tiered loading.

```bash
google-takeout-parser parse --format openviking --out ~/.ov/google-takeout ./Takeout
ov_cli ingest ~/.ov/google-takeout    # if you have OpenViking installed
```

The directory shape:

```
~/.ov/google-takeout/
├── index.md            # L0: always-loaded human/agent overview
├── summary.json        # L0: structured overview
├── manifest.json       # catalogue of every file (sha256, row count, dt range)
├── activity/
│   ├── README.md       # L1: schema + per-month index
│   └── 2023/04.ndjson  # L2: month-bucketed leaf shards
├── chrome/...
├── youtube/...
├── play/...
├── location/...
└── keep/...
```

The agent never opens an L2 shard unless its directory walk concludes the data
is needed; `index.md` and the L1 READMEs carry enough metadata to plan
retrieval.

**Combine multiple formats in one pass:**

```bash
google-takeout-parser parse \
  --format ndjson,openviking,openclaw \
  --out ./out \
  ./Takeout
```

## Library

```ts
import { TakeoutParser, mergeEvents, writeOpenViking, writeOpenClaw } from "@shelbeely/google-takeout-parser";

const tp = new TakeoutParser("./Takeout", { localeName: "EN" });

// Stream events as you go (memory-flat for multi-GB takeouts):
for await (const ev of tp.parse()) {
  if (ev.kind === "error") continue;
  // ...
}

// Or pipe straight to an exporter:
await writeOpenClaw("./out/openclaw", new TakeoutParser("./Takeout").parse(), {
  skillName: "google-takeout",
});
```

Custom locales:

```ts
import { registerLocale, compileHandlerMap, parseJsonActivity } from "@shelbeely/google-takeout-parser";

registerLocale(
  "FR",
  compileHandlerMap([
    ["Mon Activité/.*?Mon\\s*Activité\\.json", parseJsonActivity],
    // ...
  ]),
);
```

## Caching

Like the Python tool's `cachew`, parsed events are cached to disk keyed by
`(parser version, file path, file size, mtime, locale)`. Storage:

- Index: `bun:sqlite` database at `<cache-dir>/index.sqlite`.
- Payloads: gzipped NDJSON at `<cache-dir>/<sha>.ndjson.gz`.

Default cache dir: `$XDG_CACHE_HOME/google-takeout-parser-ts` or
`~/.cache/google-takeout-parser-ts`. Override with `--cache-dir`.

## Architecture

```
src/
├── models/        Discriminated-union event types + Zod schemas + key()
├── time/          Timestamp helpers (millis, micros, ISO-8601 UTC)
├── util/          httpAllowlist (rewrite Google http:// -> https://)
├── parsers/
│   ├── json/      Activity, Likes, Play installs, Location, Semantic Location, Chrome, Keep
│   └── csv/       YouTube comments, YouTube live chats, comment text reconstruction
├── locales/       EN & DE handler maps + registerLocale()
├── dispatch/      Walks a Takeout dir, matches files, streams Result<Event>
├── merge/         Dedupes by event key across multiple takeouts
├── cache/         bun:sqlite + gzipped-NDJSON content-addressed cache
├── exporters/
│   ├── ndjson.ts      One event per line
│   ├── openviking.ts  L0/L1/L2 filesystem-paradigm directory
│   └── openclaw.ts    Skill bundle: SQLite + FTS5 + digests + skill.json
└── cli/bin.ts     CLI entrypoint
```

Every parser is an `AsyncIterable<Result<Event>>`. Errors surface as values
(`ParseError`) rather than thrown exceptions — the dispatch layer respects
`errorPolicy: "yield" | "raise" | "drop"`.

## Status

| Feature | Status |
| ------- | ------ |
| JSON parsers (Activity, Chrome, Play, Location, Semantic, Keep, Likes) | ✅ |
| CSV parsers (YouTube comments, live chats, content reconstruction) | ✅ |
| Locales: EN, DE | ✅ |
| Path dispatch with `Result<T>` | ✅ |
| Merge / dedup across takeouts | ✅ |
| Cache (bun:sqlite + gzipped NDJSON) | ✅ |
| NDJSON exporter | ✅ |
| OpenViking exporter (L0/L1/L2 + manifest) | ✅ |
| OpenClaw exporter (skill.json + by-date + FTS5 search + digests) | ✅ |
| CLI: `parse`, `merge`, `cache`, multi-`--format` | ✅ |
| **Legacy HTML parsers** (My Activity HTML, comment HTML, live-chat HTML) | ❌ Not ported. Use the Python package for HTML-only takeouts. |
| Snapshot parity tests vs. Python NDJSON | Planned |
| `bun build --compile` release pipeline | Planned (CI builds + tests today) |

The OpenClaw skill schema isn't fully published yet; `skill.json` follows the
documented shape (`name`, `version`, `description`, `runtime`, `resources`,
`capabilities`) and is forward-compatible with extra fields.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
bun test            # 29 tests across 6 files
bun run build       # bundle to dist/
```

CI (`.github/workflows/ts-ci.yaml`) runs typecheck + lint + tests on Ubuntu and
macOS with the latest Bun.

[takeout]: https://takeout.google.com/
[bun]: https://bun.sh/
