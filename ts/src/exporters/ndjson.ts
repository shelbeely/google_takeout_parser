/**
 * NDJSON exporter — one event per line, JSON, discriminated by `kind`.
 *
 * This is the lowest-common-denominator format both OpenClaw and OpenViking
 * (and any agent / shell pipeline) can consume cheaply: `grep`, `jq`, or
 * `tail -F` work directly on it.
 */
import { type WriteStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type GoogleEvent, type Result, isError } from "../models/index.ts";
import { serializeEvent } from "./serialize.ts";

export interface NdjsonExporterStats {
  outPath: string;
  events: number;
  errors: number;
}

export class NdjsonExporter {
  private stream: WriteStream | null = null;
  private events = 0;
  private errors = 0;

  constructor(public readonly outPath: string) {}

  async open(): Promise<void> {
    await mkdir(path.dirname(this.outPath), { recursive: true });
    this.stream = createWriteStream(this.outPath, { encoding: "utf-8" });
  }

  write(ev: Result<GoogleEvent>): void {
    if (!this.stream) throw new Error("NdjsonExporter not open()ed");
    if (isError(ev)) {
      this.errors++;
      this.stream.write(`${JSON.stringify(ev)}\n`);
      return;
    }
    this.events++;
    this.stream.write(`${JSON.stringify(serializeEvent(ev))}\n`);
  }

  async close(): Promise<NdjsonExporterStats> {
    return new Promise((resolve, reject) => {
      if (!this.stream) {
        resolve({ outPath: this.outPath, events: this.events, errors: this.errors });
        return;
      }
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else
          resolve({
            outPath: this.outPath,
            events: this.events,
            errors: this.errors,
          });
      });
    });
  }
}

/** Drain a stream of events to NDJSON in one call. */
export async function writeNdjson(
  outPath: string,
  events: AsyncIterable<Result<GoogleEvent>>,
): Promise<NdjsonExporterStats> {
  const exp = new NdjsonExporter(outPath);
  await exp.open();
  for await (const ev of events) exp.write(ev);
  return exp.close();
}
