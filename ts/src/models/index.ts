/**
 * Event models — TypeScript port of `models.py`.
 *
 * Every event is a discriminated union member tagged with `kind`. The `key`
 * function on each variant is used by `merge` to deduplicate events when
 * combining multiple Takeouts (parity with the Python `key` property).
 *
 * Dates are stored as native `Date` objects in memory and serialised as ISO
 * strings at the export boundary (NDJSON, SQLite, etc.).
 */
import { z } from "zod";
import { epochSeconds } from "../time/index.ts";

export type Url = string;

// ---------------------------------------------------------------------------
// Auxiliary value types (NamedTuple equivalents in Python).
// ---------------------------------------------------------------------------

export interface Subtitle {
  name: string;
  url: Url | null;
}

export interface LocationInfo {
  name: string | null;
  url: Url | null;
  source: string | null;
  sourceUrl: Url | null;
}

export interface KeepListContent {
  textHtml: string;
  text: string;
  isChecked: boolean;
}

export interface KeepAnnotation {
  description: string;
  source: string;
  title: string;
  url: string;
}

export interface CandidateLocation {
  lat: number;
  lng: number;
  address: string | null;
  name: string | null;
  placeId: string | null;
  semanticType: string | null;
  locationConfidence: number | null;
  sourceInfoDeviceTag: number | null;
}

// ---------------------------------------------------------------------------
// Event variants. Each gets a unique `kind` discriminator + ISO `dt` string for
// sorting and bucketing without re-parsing dates.
// ---------------------------------------------------------------------------

export interface Activity {
  kind: "activity";
  header: string;
  title: string;
  time: Date;
  description: string | null;
  titleUrl: Url | null;
  subtitles: Subtitle[];
  details: string[];
  locationInfos: LocationInfo[];
  products: string[];
}

export interface YoutubeComment {
  kind: "youtubeComment";
  content: string;
  dt: Date;
  urls: Url[];
}

export interface CSVYoutubeComment {
  kind: "csvYoutubeComment";
  commentId: string;
  channelId: string;
  dt: Date;
  price: string | null;
  parentCommentId: string | null;
  videoId: string;
  contentJSON: string;
}

export interface CSVYoutubeLiveChat {
  kind: "csvYoutubeLiveChat";
  liveChatId: string;
  channelId: string;
  dt: Date;
  price: string | null;
  videoId: string;
  contentJSON: string;
}

export interface LikedYoutubeVideo {
  kind: "likedYoutubeVideo";
  title: string;
  desc: string;
  link: string;
  dt: Date;
}

export interface PlayStoreAppInstall {
  kind: "playStoreAppInstall";
  title: string;
  lastUpdateTime: Date;
  firstInstallationTime: Date;
  deviceName: string | null;
  deviceCarrier: string | null;
  deviceManufacturer: string | null;
}

export interface Location {
  kind: "location";
  lat: number;
  lng: number;
  accuracy: number | null;
  deviceTag: number | null;
  source: string | null;
  dt: Date;
}

export interface PlaceVisit {
  kind: "placeVisit";
  lat: number;
  lng: number;
  centerLat: number | null;
  centerLng: number | null;
  address: string | null;
  name: string | null;
  locationConfidence: number | null;
  placeId: string;
  startTime: Date;
  endTime: Date;
  sourceInfoDeviceTag: number | null;
  otherCandidateLocations: CandidateLocation[];
  placeConfidence: string | null;
  placeVisitType: string | null;
  visitConfidence: number | null;
  editConfirmationStatus: string | null;
  placeVisitImportance: string | null;
}

export interface ChromeHistory {
  kind: "chromeHistory";
  title: string;
  url: Url;
  dt: Date;
  pageTransition: string | null;
}

export interface Keep {
  kind: "keep";
  title: string;
  updated_dt: Date;
  created_dt: Date;
  listContent: KeepListContent[] | null;
  textContent: string | null;
  textContentHtml: string | null;
  color: string;
  annotations: KeepAnnotation[] | null;
  isTrashed: boolean;
  isPinned: boolean;
  isArchived: boolean;
}

/** Discriminated union of every event the parser can yield. */
export type GoogleEvent =
  | Activity
  | YoutubeComment
  | CSVYoutubeComment
  | CSVYoutubeLiveChat
  | LikedYoutubeVideo
  | PlayStoreAppInstall
  | Location
  | PlaceVisit
  | ChromeHistory
  | Keep;

export type EventKind = GoogleEvent["kind"];

export const ALL_EVENT_KINDS: readonly EventKind[] = [
  "activity",
  "youtubeComment",
  "csvYoutubeComment",
  "csvYoutubeLiveChat",
  "likedYoutubeVideo",
  "playStoreAppInstall",
  "location",
  "placeVisit",
  "chromeHistory",
  "keep",
] as const;

// ---------------------------------------------------------------------------
// Event family — used by exporters to bucket related event kinds together
// (e.g. OpenViking L1 categories, OpenClaw digest sections).
// ---------------------------------------------------------------------------

export type EventFamily = "activity" | "youtube" | "play" | "location" | "chrome" | "keep";

const KIND_TO_FAMILY: Record<EventKind, EventFamily> = {
  activity: "activity",
  youtubeComment: "youtube",
  csvYoutubeComment: "youtube",
  csvYoutubeLiveChat: "youtube",
  likedYoutubeVideo: "youtube",
  playStoreAppInstall: "play",
  location: "location",
  placeVisit: "location",
  chromeHistory: "chrome",
  keep: "keep",
};

export function familyFor(kind: EventKind): EventFamily {
  return KIND_TO_FAMILY[kind];
}

// ---------------------------------------------------------------------------
// Primary timestamp accessor — equivalent to the `dt` property in Python.
// Used by exporters (date-bucketed shards, FTS rows, digests).
// ---------------------------------------------------------------------------

export function eventTimestamp(e: GoogleEvent): Date {
  switch (e.kind) {
    case "activity":
      return e.time;
    case "playStoreAppInstall":
      return e.lastUpdateTime;
    case "placeVisit":
      return e.startTime;
    case "keep":
      return e.created_dt;
    default:
      return e.dt;
  }
}

// ---------------------------------------------------------------------------
// Merge keys — port of the `key` property on each Python dataclass. The merge
// layer dedupes by (kind, key()).
// ---------------------------------------------------------------------------

export type EventKey = string;

export function eventKey(e: GoogleEvent): EventKey {
  switch (e.kind) {
    case "activity":
      return `${e.kind}|${e.header}|${e.title}|${epochSeconds(e.time)}`;
    case "youtubeComment":
    case "csvYoutubeComment":
    case "csvYoutubeLiveChat":
    case "likedYoutubeVideo":
      return `${e.kind}|${epochSeconds(e.dt)}`;
    case "playStoreAppInstall":
      return `${e.kind}|${epochSeconds(e.lastUpdateTime)}`;
    case "location":
      return `${e.kind}|${e.lat}|${e.lng}|${e.accuracy ?? "null"}|${epochSeconds(e.dt)}`;
    case "placeVisit":
      return `${e.kind}|${e.lat}|${e.lng}|${epochSeconds(e.startTime)}|${e.visitConfidence ?? "null"}`;
    case "chromeHistory":
      return `${e.kind}|${e.url}|${epochSeconds(e.dt)}`;
    case "keep":
      return `${e.kind}|${epochSeconds(e.created_dt)}`;
  }
}

// ---------------------------------------------------------------------------
// Result type — replaces Python's `Res[T] = T | Exception` pattern with a
// proper tagged Result so handlers can never accidentally treat an error as a
// value.
// ---------------------------------------------------------------------------

export type ParseError = {
  kind: "error";
  message: string;
  source?: string;
  cause?: unknown;
};

export type Result<T> = T | ParseError;

export function isError<T>(r: Result<T>): r is ParseError {
  return typeof r === "object" && r !== null && (r as ParseError).kind === "error";
}

export function makeError(message: string, source?: string, cause?: unknown): ParseError {
  return { kind: "error", message, source, cause };
}

// ---------------------------------------------------------------------------
// Zod schemas — used to validate the *structural* shape of incoming Takeout
// JSON before we map it into our event types. The schemas are intentionally
// permissive (most fields optional / passthrough) because the Takeout shape
// drifts year-to-year and we'd rather degrade gracefully than reject a whole
// file.
// ---------------------------------------------------------------------------

export const ActivityJsonSchema = z
  .object({
    header: z.string().optional(),
    title: z.string(),
    time: z.string().optional(),
    titleUrl: z.string().optional(),
    description: z.string().optional(),
    products: z.array(z.string()).optional(),
    subtitles: z
      .array(z.object({ name: z.string().optional(), url: z.string().optional() }))
      .optional(),
    details: z.array(z.object({ name: z.string().optional() })).optional(),
    locationInfos: z
      .array(
        z.object({
          name: z.string().optional(),
          url: z.string().optional(),
          source: z.string().optional(),
          sourceUrl: z.string().optional(),
        }),
      )
      .optional(),
    snippet: z
      .object({ publishedAt: z.string().optional(), title: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ActivityJson = z.infer<typeof ActivityJsonSchema>;

export const LikedJsonSchema = z
  .object({
    contentDetails: z.object({ videoId: z.string() }).passthrough(),
    snippet: z
      .object({
        title: z.string(),
        description: z.string(),
        publishedAt: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const PlayInstallJsonSchema = z
  .object({
    install: z
      .object({
        doc: z.object({ title: z.string() }).passthrough(),
        firstInstallationTime: z.string(),
        lastUpdateTime: z.string(),
        deviceAttribute: z
          .object({
            deviceDisplayName: z.string().optional(),
            carrier: z.string().optional(),
            manufacturer: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const ChromeHistoryFileSchema = z
  .object({
    "Browser History": z.array(
      z
        .object({
          title: z.string(),
          url: z.string(),
          time_usec: z.number(),
          page_transition: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const LocationFileSchema = z
  .object({
    locations: z.array(z.record(z.any())).optional(),
  })
  .passthrough();

export const SemanticHistoryFileSchema = z
  .object({
    timelineObjects: z.array(z.record(z.any())).optional(),
  })
  .passthrough();

export const KeepFileSchema = z
  .object({
    title: z.string(),
    color: z.string(),
    isTrashed: z.boolean(),
    isPinned: z.boolean(),
    isArchived: z.boolean(),
    userEditedTimestampUsec: z.number(),
    createdTimestampUsec: z.number().optional(),
    textContent: z.string().optional(),
    textContentHtml: z.string().optional(),
    listContent: z
      .array(
        z.object({
          textHtml: z.string(),
          text: z.string(),
          isChecked: z.boolean(),
        }),
      )
      .optional(),
    annotations: z
      .array(
        z.object({
          description: z.string(),
          source: z.string(),
          title: z.string(),
          url: z.string(),
        }),
      )
      .optional(),
  })
  .passthrough();
