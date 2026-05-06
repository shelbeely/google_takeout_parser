/**
 * Public entrypoint of the `@shelbeely/google-takeout-parser` package.
 *
 * Most users will need:
 *   - `TakeoutParser` from "./dispatch" — walk a Takeout dir, stream events
 *   - `mergeEvents`     from "./merge"    — dedup events from multiple takeouts
 *   - `writeNdjson`, `writeOpenViking`, `writeOpenClaw` from "./exporters"
 *
 * Power users can register custom locale handler maps via `registerLocale`.
 */
export * from "./models/index.ts";
export * from "./time/index.ts";
export * from "./util/httpAllowlist.ts";
export * from "./parsers/index.ts";
export * from "./locales/index.ts";
export * from "./dispatch/index.ts";
export * from "./merge/index.ts";
export * from "./exporters/index.ts";
export * from "./cache/index.ts";
export { PARSER_VERSION, SCHEMA_VERSION } from "./version.ts";
