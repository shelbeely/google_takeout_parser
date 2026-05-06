import { Database } from "bun:sqlite";
/**
 * Cache layer — replacement for Python `cachew`.
 *
 * Stores parsed-event payloads as gzipped NDJSON keyed by:
 *   sha256(parser_version | absolute_file_path | size | mtime_ns | locale)
 *
 * The index is a `bun:sqlite` database for fast lookup; payloads live alongside
 * it as `.ndjson.gz` files. Cache invalidates whenever any of (parser version,
 * file size, mtime, locale, file path) changes — same triggers as cachew.
 */
import { createHash } from "node:crypto";
import {
  promises as fs,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { rehydrateEvent, serializeEvent } from "../exporters/serialize.ts";
import { type GoogleEvent, type Result, isError } from "../models/index.ts";
import { PARSER_VERSION } from "../version.ts";

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg
    ? path.join(xdg, "google-takeout-parser-ts")
    : path.join(os.homedir(), ".cache", "google-takeout-parser-ts");
}

interface IndexRow {
  cache_key: string;
  payload_path: string;
  generated_at: number;
}

export class TakeoutCache {
  readonly cacheDir: string;
  private db: Database;

  constructor(cacheDir: string = defaultCacheDir()) {
    this.cacheDir = cacheDir;
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
    this.db = new Database(path.join(this.cacheDir, "index.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        cache_key TEXT PRIMARY KEY,
        payload_path TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      )
    `);
  }

  static async cacheKey(filePath: string, locale: string | undefined): Promise<string> {
    const stat = await fs.stat(filePath);
    const h = createHash("sha256");
    h.update(PARSER_VERSION);
    h.update("\x00");
    h.update(filePath);
    h.update("\x00");
    h.update(String(stat.size));
    h.update("\x00");
    h.update(String(stat.mtimeMs));
    h.update("\x00");
    h.update(locale ?? "");
    return h.digest("hex");
  }

  get(cacheKey: string): Result<GoogleEvent>[] | null {
    const row = this.db
      .query("SELECT cache_key, payload_path, generated_at FROM entries WHERE cache_key = ?")
      .get(cacheKey) as IndexRow | undefined;
    if (!row) return null;
    const full = path.join(this.cacheDir, row.payload_path);
    if (!existsSync(full)) {
      this.db.run("DELETE FROM entries WHERE cache_key = ?", [cacheKey]);
      return null;
    }
    const text = gunzipSync(readFileSync(full)).toString("utf-8");
    const out: Result<GoogleEvent>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.kind === "error") {
          out.push(obj);
        } else {
          out.push(rehydrateEvent(obj));
        }
      } catch {
        // skip malformed cache line
      }
    }
    return out;
  }

  put(cacheKey: string, events: Result<GoogleEvent>[]): void {
    const lines: string[] = [];
    for (const e of events) {
      if (isError(e)) {
        lines.push(JSON.stringify(e));
      } else {
        lines.push(JSON.stringify(serializeEvent(e)));
      }
    }
    const body = `${lines.join("\n")}\n`;
    const filename = `${cacheKey}.ndjson.gz`;
    const full = path.join(this.cacheDir, filename);
    const gz = gzipSync(Buffer.from(body, "utf-8"));
    writeFileSync(full, gz);
    this.db.run(
      "INSERT OR REPLACE INTO entries (cache_key, payload_path, generated_at) VALUES (?, ?, ?)",
      [cacheKey, filename, Date.now()],
    );
  }

  list(): IndexRow[] {
    return this.db
      .query("SELECT cache_key, payload_path, generated_at FROM entries")
      .all() as IndexRow[];
  }

  clear(): void {
    const rows = this.list();
    for (const r of rows) {
      const f = path.join(this.cacheDir, r.payload_path);
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }
    this.db.run("DELETE FROM entries");
  }

  close(): void {
    this.db.close();
  }
}
