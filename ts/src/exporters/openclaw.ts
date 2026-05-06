import { Database } from "bun:sqlite";
/**
 * OpenClaw exporter — produces a directory shaped as an OpenClaw skill bundle.
 *
 * The bundle's purpose: an OpenClaw assistant should never have to wait on
 * parsing. Pre-rendered SQLite tables (with FTS5 indexes) and Markdown digests
 * mean a tiny "read SQLite + render" skill can answer common questions
 * synchronously.
 *
 * Layout produced (rooted at `--out`):
 *
 *   skill.json                OpenClaw skill manifest (description, queries)
 *   manifest.json             Schema versions, generated-at, sha256s
 *   by-date.sqlite            One table per event kind, indexed on (timestamp, key)
 *   search.sqlite             FTS5 virtual tables for free-text search
 *   digests/
 *     daily/<YYYY-MM-DD>.md   Per-day Markdown summary (top events)
 *     weekly/<YYYY-Www>.md    Per-week summary
 *     by-product.md           Per-product activity totals
 *
 * NOTE: OpenClaw's skill schema isn't fully published yet. The `skill.json`
 * we emit is the documented shape (name, description, version, capabilities,
 * resources) and is forward-compatible: extra fields are ignored by OpenClaw
 * and unknown fields are passed through. Adjust `OPENCLAW_SKILL_SHAPE` below
 * if you need to track schema updates.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ALL_EVENT_KINDS,
  type EventKind,
  type GoogleEvent,
  type Result,
  eventKey,
  eventTimestamp,
  isError,
} from "../models/index.ts";
import { PARSER_VERSION, SCHEMA_VERSION } from "../version.ts";
import { serializeEvent } from "./serialize.ts";

export interface OpenClawExportOptions {
  /** Skill name shown in OpenClaw's resource picker. */
  skillName?: string;
  /** Skill description used by the assistant when deciding to call it. */
  skillDescription?: string;
  /** Source Takeout paths recorded in manifest. */
  sources?: string[];
}

export interface OpenClawExportStats {
  outDir: string;
  totalEvents: number;
  totalErrors: number;
  perKind: Record<string, number>;
}

interface DigestBucket {
  events: GoogleEvent[];
}

function sha256OfFile(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoWeek(d: Date): string {
  // ISO week-of-year (YYYY-Www)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const week = 1 + Math.ceil((firstThursday - target.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${week.toString().padStart(2, "0")}`;
}

export class OpenClawExporter {
  private byDate: Database | null = null;
  private search: Database | null = null;
  private totalEvents = 0;
  private totalErrors = 0;
  private perKind = new Map<EventKind, number>();
  private firstDt: Date | null = null;
  private lastDt: Date | null = null;
  private daily = new Map<string, DigestBucket>();
  private weekly = new Map<string, DigestBucket>();
  private productCounts = new Map<string, number>();

  constructor(
    public readonly outDir: string,
    private readonly opts: OpenClawExportOptions = {},
  ) {}

  async open(): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
    await mkdir(path.join(this.outDir, "digests", "daily"), { recursive: true });
    await mkdir(path.join(this.outDir, "digests", "weekly"), { recursive: true });

    this.byDate = new Database(path.join(this.outDir, "by-date.sqlite"));
    this.byDate.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");
    for (const k of ALL_EVENT_KINDS) {
      const table = `events_${k}`;
      this.byDate.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          key TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          ts_iso TEXT NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${table}_ts ON ${table}(ts);
      `);
    }

    this.search = new Database(path.join(this.outDir, "search.sqlite"));
    this.search.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");
    // FTS5 tables — body holds the searchable text, ts/key/kind let us join back.
    this.search.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_activity USING fts5(
        body, key UNINDEXED, ts UNINDEXED, header UNINDEXED
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_youtube_comments USING fts5(
        body, key UNINDEXED, ts UNINDEXED, video_id UNINDEXED
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_keep USING fts5(
        body, key UNINDEXED, ts UNINDEXED, title UNINDEXED
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_chrome USING fts5(
        body, key UNINDEXED, ts UNINDEXED, url UNINDEXED
      );
    `);

    this.byDate.exec("BEGIN");
    this.search.exec("BEGIN");
  }

  write(ev: Result<GoogleEvent>): void {
    if (isError(ev)) {
      this.totalErrors++;
      return;
    }
    if (!this.byDate || !this.search) throw new Error("OpenClawExporter not open()ed");
    this.totalEvents++;
    this.perKind.set(ev.kind, (this.perKind.get(ev.kind) ?? 0) + 1);

    const dt = eventTimestamp(ev);
    if (!this.firstDt || dt < this.firstDt) this.firstDt = dt;
    if (!this.lastDt || dt > this.lastDt) this.lastDt = dt;
    const ts = Math.trunc(dt.getTime() / 1000);
    const key = eventKey(ev);
    const payload = JSON.stringify(serializeEvent(ev));

    const table = `events_${ev.kind}`;
    this.byDate
      .query(`INSERT OR REPLACE INTO ${table} (key, ts, ts_iso, payload) VALUES (?, ?, ?, ?)`)
      .run(key, ts, dt.toISOString(), payload);

    // FTS rows
    if (ev.kind === "activity") {
      const bodyParts = [ev.title];
      if (ev.description) bodyParts.push(ev.description);
      for (const s of ev.subtitles) bodyParts.push(s.name);
      this.search
        .query("INSERT INTO search_activity (body, key, ts, header) VALUES (?, ?, ?, ?)")
        .run(bodyParts.join(" \u2014 "), key, ts, ev.header);
      // also bucket per-product
      for (const p of ev.products) {
        this.productCounts.set(p, (this.productCounts.get(p) ?? 0) + 1);
      }
      this.productCounts.set(ev.header, (this.productCounts.get(ev.header) ?? 0) + 1);
    } else if (ev.kind === "csvYoutubeComment" || ev.kind === "youtubeComment") {
      const body = ev.kind === "csvYoutubeComment" ? ev.contentJSON : ev.content;
      this.search
        .query("INSERT INTO search_youtube_comments (body, key, ts, video_id) VALUES (?, ?, ?, ?)")
        .run(body, key, ts, ev.kind === "csvYoutubeComment" ? ev.videoId : "");
    } else if (ev.kind === "keep") {
      const bodyParts = [ev.title];
      if (ev.textContent) bodyParts.push(ev.textContent);
      if (ev.listContent) for (const li of ev.listContent) bodyParts.push(li.text);
      this.search
        .query("INSERT INTO search_keep (body, key, ts, title) VALUES (?, ?, ?, ?)")
        .run(bodyParts.join("\n"), key, ts, ev.title);
    } else if (ev.kind === "chromeHistory") {
      this.search
        .query("INSERT INTO search_chrome (body, key, ts, url) VALUES (?, ?, ?, ?)")
        .run(`${ev.title} ${ev.url}`, key, ts, ev.url);
    }

    // digest buckets — only keep top-N per bucket via streaming sample to bound memory
    pushBounded(this.daily, ymd(dt), ev, 20);
    pushBounded(this.weekly, isoWeek(dt), ev, 50);
  }

  async close(): Promise<OpenClawExportStats> {
    if (!this.byDate || !this.search) throw new Error("OpenClawExporter not open()ed");
    this.byDate.exec("COMMIT");
    this.search.exec("COMMIT");
    this.byDate.close();
    this.search.close();

    // digests
    for (const [day, bucket] of [...this.daily].sort()) {
      const md = renderDigest(`Daily digest — ${day}`, bucket);
      await writeFile(path.join(this.outDir, "digests", "daily", `${day}.md`), md, "utf-8");
    }
    for (const [week, bucket] of [...this.weekly].sort()) {
      const md = renderDigest(`Weekly digest — ${week}`, bucket);
      await writeFile(path.join(this.outDir, "digests", "weekly", `${week}.md`), md, "utf-8");
    }
    const productMd = renderProductDigest(this.productCounts);
    await writeFile(path.join(this.outDir, "digests", "by-product.md"), productMd, "utf-8");

    const perKindObj: Record<string, number> = {};
    for (const [k, v] of this.perKind) perKindObj[k] = v;

    // skill.json
    const skill = {
      name: this.opts.skillName ?? "google-takeout",
      version: PARSER_VERSION,
      description:
        this.opts.skillDescription ??
        "Read-only access to a pre-parsed Google Takeout export. Every record is already in SQLite (`by-date.sqlite`) with FTS5 indexes (`search.sqlite`); no parsing happens at query time.",
      runtime: "sqlite",
      resources: [
        {
          id: "by-date",
          path: "by-date.sqlite",
          type: "sqlite",
          description: "One table per event kind (events_<kind>), indexed on ts.",
        },
        {
          id: "search",
          path: "search.sqlite",
          type: "sqlite-fts5",
          description:
            "Full-text search over activity titles, YouTube comments, Keep notes, Chrome history.",
        },
        {
          id: "digests",
          path: "digests/",
          type: "markdown-tree",
          description: "Pre-rendered daily/weekly Markdown digests for prompt-stuffing.",
        },
      ],
      capabilities: [
        {
          id: "query.events_by_kind_and_date",
          description: "SELECT rows from events_<kind> WHERE ts BETWEEN ? AND ?.",
        },
        { id: "search.activity", description: "FTS5 MATCH against search_activity." },
        {
          id: "search.youtube_comments",
          description: "FTS5 MATCH against search_youtube_comments.",
        },
        { id: "search.keep", description: "FTS5 MATCH against search_keep." },
        { id: "search.chrome", description: "FTS5 MATCH against search_chrome." },
        {
          id: "digest.daily",
          description: "Read digests/daily/<YYYY-MM-DD>.md for a day's summary.",
        },
        {
          id: "digest.weekly",
          description: "Read digests/weekly/<YYYY-Www>.md for a week's summary.",
        },
      ],
      stats: {
        totalEvents: this.totalEvents,
        totalErrors: this.totalErrors,
        firstEvent: this.firstDt?.toISOString() ?? null,
        lastEvent: this.lastDt?.toISOString() ?? null,
        perKind: perKindObj,
      },
    };
    const skillPath = path.join(this.outDir, "skill.json");
    await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, "utf-8");

    // manifest with sha256s
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      generatedAt: new Date().toISOString(),
      sources: this.opts.sources ?? [],
      files: [
        { path: "skill.json", sha256: sha256OfFile(skillPath) },
        {
          path: "by-date.sqlite",
          sha256: sha256OfFile(path.join(this.outDir, "by-date.sqlite")),
        },
        {
          path: "search.sqlite",
          sha256: sha256OfFile(path.join(this.outDir, "search.sqlite")),
        },
      ],
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
      perKind: perKindObj,
    };
  }
}

function pushBounded(
  m: Map<string, DigestBucket>,
  key: string,
  ev: GoogleEvent,
  cap: number,
): void {
  let b = m.get(key);
  if (!b) {
    b = { events: [] };
    m.set(key, b);
  }
  if (b.events.length < cap) {
    b.events.push(ev);
  }
}

function summariseEvent(ev: GoogleEvent): string {
  switch (ev.kind) {
    case "activity":
      return `[${ev.header}] ${ev.title}`;
    case "youtubeComment":
      return `[YouTube comment] ${ev.content.slice(0, 100)}`;
    case "csvYoutubeComment":
      return `[YouTube comment v=${ev.videoId}]`;
    case "csvYoutubeLiveChat":
      return `[Live chat v=${ev.videoId}]`;
    case "likedYoutubeVideo":
      return `[Liked] ${ev.title}`;
    case "playStoreAppInstall":
      return `[Play install] ${ev.title} on ${ev.deviceName ?? "unknown device"}`;
    case "location":
      return `[Location] ${ev.lat.toFixed(4)},${ev.lng.toFixed(4)}`;
    case "placeVisit":
      return `[Place visit] ${ev.name ?? ev.address ?? `${ev.lat.toFixed(4)},${ev.lng.toFixed(4)}`}`;
    case "chromeHistory":
      return `[Chrome] ${ev.title} — ${ev.url}`;
    case "keep":
      return `[Keep] ${ev.title}${ev.isPinned ? " 📌" : ""}`;
  }
}

function renderDigest(title: string, bucket: DigestBucket): string {
  const lines: string[] = [];
  lines.push(`# ${title}\n`);
  lines.push(`${bucket.events.length} sample event(s):\n`);
  const sorted = [...bucket.events].sort(
    (a, b) => eventTimestamp(a).getTime() - eventTimestamp(b).getTime(),
  );
  for (const ev of sorted) {
    lines.push(`- \`${eventTimestamp(ev).toISOString()}\` ${summariseEvent(ev)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderProductDigest(counts: Map<string, number>): string {
  const lines: string[] = [];
  lines.push("# Activity by product\n");
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [prod, n] of sorted) lines.push(`- **${prod}**: ${n}`);
  lines.push("");
  return lines.join("\n");
}

/** Drain a stream of events to an OpenClaw skill bundle in one call. */
export async function writeOpenClaw(
  outDir: string,
  events: AsyncIterable<Result<GoogleEvent>>,
  opts: OpenClawExportOptions = {},
): Promise<OpenClawExportStats> {
  const exp = new OpenClawExporter(outDir, opts);
  await exp.open();
  for await (const ev of events) exp.write(ev);
  return exp.close();
}
