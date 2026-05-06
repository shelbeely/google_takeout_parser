/**
 * OpenViking exporter — writes a directory in the OpenViking
 * "filesystem-paradigm" Context Database shape with L0/L1/L2 tiered loading.
 *
 * Layout produced (rooted at `--out`):
 *
 *   index.md                Always-loaded human/agent overview (L0)
 *   summary.json            Always-loaded structured overview (L0)
 *   manifest.json           Catalogue of every file with hash, row count, dt range
 *   <family>/               One directory per event family (L1)
 *     README.md             Schema + per-month index for the family
 *     <YYYY>/<MM>.ndjson    Date-bucketed leaf shards (L2)
 *
 * The key idea is that an OpenViking agent never opens a "leaf" L2 shard
 * unless its directory walk concludes the data is needed — `index.md` and the
 * per-family `README.md`s are enough for the agent to plan retrieval.
 *
 * See https://github.com/volcengine/OpenViking for the paradigm description.
 */
import { createHash } from "node:crypto";
import { type WriteStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type EventFamily,
  type EventKind,
  type GoogleEvent,
  type Result,
  eventTimestamp,
  familyFor,
  isError,
} from "../models/index.ts";
import { PARSER_VERSION, SCHEMA_VERSION } from "../version.ts";
import { serializeEvent } from "./serialize.ts";

interface ShardWriter {
  filePath: string;
  stream: WriteStream;
  rows: number;
  minDt: Date;
  maxDt: Date;
  kinds: Set<EventKind>;
}

interface FamilyAccumulator {
  family: EventFamily;
  shards: Map<string, ShardWriter>; // key: "YYYY/MM"
  totalRows: number;
  perKind: Map<EventKind, number>;
  minDt: Date | null;
  maxDt: Date | null;
}

export interface OpenVikingExportOptions {
  /** Path to the source Takeout directory(ies), recorded in summary.json. */
  sources?: string[];
}

export interface OpenVikingExportStats {
  outDir: string;
  totalEvents: number;
  totalErrors: number;
  perFamily: Record<EventFamily, number>;
  perKind: Record<string, number>;
}

function ymKey(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}/${m}`;
}

function sha256OfFile(p: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

const FAMILY_DESCRIPTIONS: Record<EventFamily, string> = {
  activity:
    "Google 'My Activity' events across dozens of products (search, Discover, Maps, Assistant, Translate, etc.). Each event has a header (product), title, optional description, and a UTC timestamp.",
  youtube:
    "YouTube and YouTube Music: watch/search history (as Activity), liked videos, posted comments (CSV + legacy HTML), and live-chat messages.",
  play: "Google Play Store app installs — title, install/update timestamps, and the device they were installed on.",
  location:
    "Location History — both raw GPS records (Location) and inferred place visits (PlaceVisit) from Semantic Location History.",
  chrome: "Chrome browser history — page title, URL, transition type, timestamp.",
  keep: "Google Keep notes — title, body (text or list items), color, archive/pin/trash flags, and annotations.",
};

const FAMILY_KINDS: Record<EventFamily, readonly EventKind[]> = {
  activity: ["activity"],
  youtube: ["youtubeComment", "csvYoutubeComment", "csvYoutubeLiveChat", "likedYoutubeVideo"],
  play: ["playStoreAppInstall"],
  location: ["location", "placeVisit"],
  chrome: ["chromeHistory"],
  keep: ["keep"],
};

export class OpenVikingExporter {
  private families = new Map<EventFamily, FamilyAccumulator>();
  private totalEvents = 0;
  private totalErrors = 0;
  private firstDt: Date | null = null;
  private lastDt: Date | null = null;

  constructor(
    public readonly outDir: string,
    private readonly opts: OpenVikingExportOptions = {},
  ) {}

  async open(): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
  }

  private getFamilyAcc(family: EventFamily): FamilyAccumulator {
    let acc = this.families.get(family);
    if (!acc) {
      acc = {
        family,
        shards: new Map(),
        totalRows: 0,
        perKind: new Map(),
        minDt: null,
        maxDt: null,
      };
      this.families.set(family, acc);
      const dir = path.join(this.outDir, family);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    return acc;
  }

  private getShard(family: FamilyAccumulator, dt: Date): ShardWriter {
    const ym = ymKey(dt);
    let s = family.shards.get(ym);
    if (!s) {
      const dir = path.join(this.outDir, family.family, ym.split("/")[0]!);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const filePath = path.join(this.outDir, family.family, `${ym}.ndjson`);
      s = {
        filePath,
        stream: createWriteStream(filePath, { encoding: "utf-8" }),
        rows: 0,
        minDt: dt,
        maxDt: dt,
        kinds: new Set(),
      };
      family.shards.set(ym, s);
    }
    return s;
  }

  write(ev: Result<GoogleEvent>): void {
    if (isError(ev)) {
      this.totalErrors++;
      return;
    }
    this.totalEvents++;
    const dt = eventTimestamp(ev);
    if (!this.firstDt || dt < this.firstDt) this.firstDt = dt;
    if (!this.lastDt || dt > this.lastDt) this.lastDt = dt;

    const family = familyFor(ev.kind);
    const acc = this.getFamilyAcc(family);
    acc.totalRows++;
    acc.perKind.set(ev.kind, (acc.perKind.get(ev.kind) ?? 0) + 1);
    if (!acc.minDt || dt < acc.minDt) acc.minDt = dt;
    if (!acc.maxDt || dt > acc.maxDt) acc.maxDt = dt;

    const shard = this.getShard(acc, dt);
    shard.rows++;
    shard.kinds.add(ev.kind);
    if (dt < shard.minDt) shard.minDt = dt;
    if (dt > shard.maxDt) shard.maxDt = dt;
    shard.stream.write(`${JSON.stringify(serializeEvent(ev))}\n`);
  }

  async close(): Promise<OpenVikingExportStats> {
    // close all shard streams
    const closes: Promise<void>[] = [];
    for (const fam of this.families.values()) {
      for (const s of fam.shards.values()) {
        closes.push(
          new Promise((res, rej) =>
            s.stream.end((err: Error | null | undefined) => (err ? rej(err) : res())),
          ),
        );
      }
    }
    await Promise.all(closes);

    // write per-family READMEs
    const manifestFiles: ManifestFile[] = [];
    const perFamilyCounts: Record<string, number> = {};
    const perKindCounts: Record<string, number> = {};

    for (const fam of this.families.values()) {
      perFamilyCounts[fam.family] = fam.totalRows;
      for (const [k, v] of fam.perKind) perKindCounts[k] = (perKindCounts[k] ?? 0) + v;
      const readmePath = path.join(this.outDir, fam.family, "README.md");
      const readme = renderFamilyReadme(fam);
      await writeFile(readmePath, readme, "utf-8");
      manifestFiles.push({
        path: path.relative(this.outDir, readmePath),
        kind: "family-index",
        family: fam.family,
        bytes: Buffer.byteLength(readme, "utf-8"),
        sha256: sha256OfFile(readmePath),
      });
      // shard manifest entries
      const sortedShards = [...fam.shards.values()].sort((a, b) =>
        a.filePath.localeCompare(b.filePath),
      );
      for (const s of sortedShards) {
        manifestFiles.push({
          path: path.relative(this.outDir, s.filePath),
          kind: "shard",
          family: fam.family,
          eventKinds: [...s.kinds],
          rows: s.rows,
          minDt: s.minDt.toISOString(),
          maxDt: s.maxDt.toISOString(),
          sha256: sha256OfFile(s.filePath),
        });
      }
    }

    // L0: summary.json + index.md
    const summary = {
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      generatedAt: new Date().toISOString(),
      sources: this.opts.sources ?? [],
      totals: {
        events: this.totalEvents,
        errors: this.totalErrors,
      },
      dateRange: {
        first: this.firstDt?.toISOString() ?? null,
        last: this.lastDt?.toISOString() ?? null,
      },
      perFamily: perFamilyCounts,
      perKind: perKindCounts,
    };
    const summaryPath = path.join(this.outDir, "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

    const indexMd = renderIndexMd(summary);
    const indexPath = path.join(this.outDir, "index.md");
    await writeFile(indexPath, indexMd, "utf-8");

    manifestFiles.push({
      path: "summary.json",
      kind: "overview",
      bytes: Buffer.byteLength(JSON.stringify(summary, null, 2), "utf-8") + 1,
      sha256: sha256OfFile(summaryPath),
    });
    manifestFiles.push({
      path: "index.md",
      kind: "overview",
      bytes: Buffer.byteLength(indexMd, "utf-8"),
      sha256: sha256OfFile(indexPath),
    });

    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      paradigm: "openviking-l0-l1-l2",
      generatedAt: summary.generatedAt,
      tiers: {
        l0: ["index.md", "summary.json"],
        l1: [...this.families.keys()].map((f) => `${f}/README.md`),
        l2Pattern: "<family>/<YYYY>/<MM>.ndjson",
      },
      files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    };
    await writeFile(
      path.join(this.outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

    return {
      outDir: this.outDir,
      totalEvents: this.totalEvents,
      totalErrors: this.totalErrors,
      perFamily: perFamilyCounts as Record<EventFamily, number>,
      perKind: perKindCounts,
    };
  }
}

interface ManifestFile {
  path: string;
  kind: "overview" | "family-index" | "shard";
  family?: EventFamily;
  eventKinds?: EventKind[];
  rows?: number;
  bytes?: number;
  minDt?: string;
  maxDt?: string;
  sha256: string;
}

interface Manifest {
  schemaVersion: string;
  parserVersion: string;
  paradigm: string;
  generatedAt: string;
  tiers: {
    l0: string[];
    l1: string[];
    l2Pattern: string;
  };
  files: ManifestFile[];
}

function renderFamilyReadme(fam: FamilyAccumulator): string {
  const lines: string[] = [];
  lines.push(`# ${fam.family}\n`);
  lines.push(`${FAMILY_DESCRIPTIONS[fam.family]}\n`);
  lines.push("## Schema (event kinds)\n");
  for (const k of FAMILY_KINDS[fam.family]) {
    const count = fam.perKind.get(k) ?? 0;
    lines.push(`- **${k}** — ${count} events`);
  }
  lines.push("");
  lines.push("## Date range\n");
  if (fam.minDt && fam.maxDt) {
    lines.push(`- First: \`${fam.minDt.toISOString()}\``);
    lines.push(`- Last:  \`${fam.maxDt.toISOString()}\``);
  } else {
    lines.push("_no events_");
  }
  lines.push("");
  lines.push("## Shards (L2)\n");
  lines.push(
    "Events are sharded by month at `<YYYY>/<MM>.ndjson`. Each line is a JSON event with a `kind` discriminator. Open a shard only when its date range matches the question being asked.\n",
  );
  const shards = [...fam.shards.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
  if (shards.length > 0) {
    lines.push("| Shard | Rows | Min dt | Max dt |");
    lines.push("| ----- | ---: | ------ | ------ |");
    for (const s of shards) {
      const rel = path.relative(path.dirname(path.join(s.filePath, "..")), s.filePath);
      lines.push(
        `| \`${rel}\` | ${s.rows} | ${s.minDt.toISOString()} | ${s.maxDt.toISOString()} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderIndexMd(summary: any): string {
  const lines: string[] = [];
  lines.push("# Google Takeout — OpenViking Context Pack\n");
  lines.push(
    `Generated by \`google-takeout-parser\` (v${PARSER_VERSION}) at ${summary.generatedAt}. Schema v${SCHEMA_VERSION}. Layout follows the OpenViking L0/L1/L2 filesystem paradigm.\n`,
  );
  lines.push("## Overview (L0 — always loaded)\n");
  lines.push(`- **Total events:** ${summary.totals.events}`);
  lines.push(`- **Errors:** ${summary.totals.errors}`);
  if (summary.dateRange.first) {
    lines.push(`- **First event:** \`${summary.dateRange.first}\``);
    lines.push(`- **Last event:**  \`${summary.dateRange.last}\``);
  }
  lines.push("- **Sources:**");
  for (const s of summary.sources ?? []) lines.push(`  - \`${s}\``);
  lines.push("");
  lines.push("## Families (L1 — load on demand)\n");
  for (const [fam, count] of Object.entries(summary.perFamily)) {
    lines.push(`- [\`${fam}/README.md\`](./${fam}/README.md) — ${count} events`);
  }
  lines.push("");
  lines.push("## Per-kind breakdown\n");
  for (const [k, count] of Object.entries(summary.perKind)) {
    lines.push(`- **${k}**: ${count}`);
  }
  lines.push("");
  lines.push("## Retrieval guidance\n");
  lines.push(
    "1. Read this file (L0) and `summary.json`.\n2. To answer a question, narrow to one or more family READMEs (L1).\n3. Only then open a specific `<family>/<YYYY>/<MM>.ndjson` shard (L2).\n4. `manifest.json` lists every file with its sha256, row count, and dt range.\n",
  );
  return lines.join("\n");
}

/** Drain a stream of events to an OpenViking pack in one call. */
export async function writeOpenViking(
  outDir: string,
  events: AsyncIterable<Result<GoogleEvent>>,
  opts: OpenVikingExportOptions = {},
): Promise<OpenVikingExportStats> {
  const exp = new OpenVikingExporter(outDir, opts);
  await exp.open();
  for await (const ev of events) exp.write(ev);
  return exp.close();
}
