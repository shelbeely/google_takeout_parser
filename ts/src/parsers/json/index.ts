/**
 * JSON parsers — port of `parse_json.py`.
 *
 * Each parser is an async generator that yields `Result<Event>` values: either
 * a successfully-parsed event or a `ParseError` describing which row failed.
 * This mirrors the Python `Iterator[Res[T]]` pattern but with a tagged
 * `Result` type that's safe to switch on.
 */
import { promises as fs } from "node:fs";
import {
  type Activity,
  type CandidateLocation,
  type ChromeHistory,
  type Keep,
  type LikedYoutubeVideo,
  type Location,
  type LocationInfo,
  type PlaceVisit,
  type PlayStoreAppInstall,
  type Result,
  type Subtitle,
  makeError,
} from "../../models/index.ts";
import { parseDatetimeMillis, parseJsonUtcDate } from "../../time/index.ts";
import { convertToHttpsOpt } from "../../util/httpAllowlist.ts";

async function readJson(path: string): Promise<unknown> {
  const text = await fs.readFile(path, "utf-8");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Activity (My Activity / YouTube history)
// ---------------------------------------------------------------------------

export async function* parseJsonActivity(path: string): AsyncIterable<Result<Activity>> {
  let data: unknown;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`Activity: failed to read JSON in '${path}'`, path, e);
    return;
  }
  if (!Array.isArray(data)) {
    yield makeError(`Activity: Top level item in '${path}' isn't a list`, path);
    return;
  }

  for (const raw of data) {
    try {
      const blobAny = raw as Record<string, any>;
      const subtitles: Subtitle[] = [];
      for (const s of blobAny.subtitles ?? []) {
        if (typeof s !== "object" || s === null) continue;
        if (!("name" in s)) continue;
        subtitles.push({ name: s.name, url: s.url ?? null });
      }

      // Detect pre-2017 "snippet" format
      let blob = blobAny;
      let header: string;
      let timeStr: string;
      if ("snippet" in blobAny) {
        blob = blobAny.snippet;
        header = "YouTube";
        timeStr = blob.publishedAt;
      } else {
        let _header: string | undefined = blobAny.header;
        if (_header == null) {
          // pre-2021 MyActivity/Chrome data sometimes contains items without
          // header that originate from view-source: pages.
          if (
            typeof blobAny.title === "string" &&
            blobAny.title.startsWith("Visited view-source:")
          ) {
            _header = "Chrome";
          }
        }
        if (_header == null) {
          throw new Error(
            `Missing header in activity blob: ${JSON.stringify(blobAny).slice(0, 200)}`,
          );
        }
        header = _header;
        timeStr = blobAny.time;
      }

      const locationInfos: LocationInfo[] = [];
      for (const li of blob.locationInfos ?? []) {
        locationInfos.push({
          name: li.name ?? null,
          url: convertToHttpsOpt(li.url),
          source: li.source ?? null,
          sourceUrl: convertToHttpsOpt(li.sourceUrl),
        });
      }

      const details: string[] = [];
      for (const d of blob.details ?? []) {
        if (d && typeof d === "object" && typeof d.name === "string") {
          details.push(d.name);
        }
      }

      yield {
        kind: "activity",
        header,
        title: blob.title,
        titleUrl: convertToHttpsOpt(blob.titleUrl),
        description: blob.description ?? null,
        time: parseJsonUtcDate(timeStr),
        subtitles,
        details,
        locationInfos,
        products: blob.products ?? [],
      };
    } catch (e) {
      yield makeError(
        `Activity row failed: ${e instanceof Error ? e.message : String(e)}`,
        path,
        e,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// YouTube likes (playlists/likes.json)
// ---------------------------------------------------------------------------

export async function* parseLikes(path: string): AsyncIterable<Result<LikedYoutubeVideo>> {
  let data: unknown;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`Likes: failed to read JSON in '${path}'`, path, e);
    return;
  }
  if (!Array.isArray(data)) {
    yield makeError(`Likes: Top level item in '${path}' isn't a list`, path);
    return;
  }
  for (const raw of data) {
    try {
      const j = raw as any;
      yield {
        kind: "likedYoutubeVideo",
        title: j.snippet.title,
        desc: j.snippet.description,
        link: `https://youtube.com/watch?v=${j.contentDetails.videoId}`,
        dt: parseJsonUtcDate(j.snippet.publishedAt),
      };
    } catch (e) {
      yield makeError("Likes row failed", path, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Play Store installs
// ---------------------------------------------------------------------------

export async function* parseAppInstalls(path: string): AsyncIterable<Result<PlayStoreAppInstall>> {
  let data: unknown;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`App installs: failed to read JSON in '${path}'`, path, e);
    return;
  }
  if (!Array.isArray(data)) {
    yield makeError(`App installs: Top level item in '${path}' isn't a list`, path);
    return;
  }
  for (const raw of data) {
    try {
      const j = raw as any;
      const dev = j.install?.deviceAttribute ?? {};
      yield {
        kind: "playStoreAppInstall",
        title: j.install.doc.title,
        deviceName: dev.deviceDisplayName ?? null,
        deviceCarrier: dev.carrier ?? null,
        deviceManufacturer: dev.manufacturer ?? null,
        lastUpdateTime: parseJsonUtcDate(j.install.lastUpdateTime),
        firstInstallationTime: parseJsonUtcDate(j.install.firstInstallationTime),
      };
    } catch (e) {
      yield makeError("App install row failed", path, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Location history (Records.json / Location History.json)
// ---------------------------------------------------------------------------

function parseTimestampKey(d: any, key: string): Date {
  if (`${key}Ms` in d) {
    return parseDatetimeMillis(d[`${key}Ms`]);
  }
  return parseJsonUtcDate(d[key]);
}

export async function* parseLocationHistory(path: string): AsyncIterable<Result<Location>> {
  let data: any;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`Locations: failed to read JSON in '${path}'`, path, e);
    return;
  }
  if (!data || typeof data !== "object" || !("locations" in data)) {
    yield makeError(`Locations: no 'locations' key in '${path}'`, path);
    return;
  }
  for (const loc of data.locations ?? []) {
    try {
      const accuracy = loc.accuracy;
      const deviceTag = loc.deviceTag;
      const source = loc.source;
      yield {
        kind: "location",
        lng: Number(loc.longitudeE7) / 1e7,
        lat: Number(loc.latitudeE7) / 1e7,
        dt: parseTimestampKey(loc, "timestamp"),
        accuracy: accuracy == null ? null : Number(accuracy),
        deviceTag: deviceTag == null ? null : Number(deviceTag),
        source: source == null ? null : String(source),
      };
    } catch (e) {
      yield makeError("Location row failed", path, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Semantic location history -> PlaceVisit
// ---------------------------------------------------------------------------

const SEM_REQUIRED_KEYS = ["location", "duration"];
const SEM_REQUIRED_LOCATION_KEYS = ["placeId", "latitudeE7", "longitudeE7"];

function checkRequiredKeys(d: any, required: string[]): string | null {
  for (const k of required) if (!(k in d)) return k;
  return null;
}

function candidateFromDict(d: any): CandidateLocation {
  const placeId = d.placeId ?? null;
  const semanticType = d.semanticType ?? null;
  if (placeId == null && semanticType == null) {
    throw new Error(
      `CandidateLocation: missing both placeId and semanticType: ${JSON.stringify(d).slice(0, 200)}`,
    );
  }
  return {
    address: d.address ?? null,
    name: d.name ?? null,
    placeId,
    semanticType,
    locationConfidence: d.locationConfidence ?? null,
    lat: Number(d.latitudeE7) / 1e7,
    lng: Number(d.longitudeE7) / 1e7,
    sourceInfoDeviceTag: d.sourceInfo?.deviceTag ?? null,
  };
}

export async function* parseSemanticLocationHistory(
  path: string,
): AsyncIterable<Result<PlaceVisit>> {
  let data: any;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`Locations: failed to read JSON in '${path}'`, path, e);
    return;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    yield makeError(`Locations: Top level item in '${path}' isn't a dict`, path);
    return;
  }
  if (!("timelineObjects" in data)) {
    yield makeError(`Locations: no 'timelineObjects' key in '${path}'`, path);
    return;
  }

  for (const tlo of data.timelineObjects ?? []) {
    if (!("placeVisit" in tlo)) continue;
    const placeVisit = tlo.placeVisit;
    const missing = checkRequiredKeys(placeVisit, SEM_REQUIRED_KEYS);
    if (missing != null) {
      yield makeError(`PlaceVisit: no '${missing}' key in '${path}'`, path);
      continue;
    }
    try {
      const locJson = placeVisit.location;
      const missingLoc = checkRequiredKeys(locJson, SEM_REQUIRED_LOCATION_KEYS);
      if (missingLoc != null) {
        // handle defensively, just skip
        continue;
      }
      const location = candidateFromDict(locJson);
      const placeId = location.placeId;
      if (placeId == null) {
        throw new Error("Missing placeId on canonical location");
      }
      const duration = placeVisit.duration;
      yield {
        kind: "placeVisit",
        name: location.name,
        address: location.address,
        otherCandidateLocations: (placeVisit.otherCandidateLocations ?? []).map(candidateFromDict),
        sourceInfoDeviceTag: location.sourceInfoDeviceTag,
        placeConfidence: placeVisit.placeConfidence ?? null,
        placeVisitImportance: placeVisit.placeVisitImportance ?? null,
        placeVisitType: placeVisit.placeVisitType ?? null,
        visitConfidence: placeVisit.visitConfidence ?? null,
        editConfirmationStatus: placeVisit.editConfirmationStatus ?? null,
        placeId,
        lng: location.lng,
        lat: location.lat,
        centerLat: "centerLatE7" in placeVisit ? Number(placeVisit.centerLatE7) / 1e7 : null,
        centerLng: "centerLngE7" in placeVisit ? Number(placeVisit.centerLngE7) / 1e7 : null,
        startTime: parseTimestampKey(duration, "startTimestamp"),
        endTime: parseTimestampKey(duration, "endTimestamp"),
        locationConfidence: location.locationConfidence,
      };
    } catch (e) {
      yield makeError(
        `PlaceVisit row failed: ${e instanceof Error ? e.message : String(e)}`,
        path,
        e,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome history
// ---------------------------------------------------------------------------

export async function* parseChromeHistory(path: string): AsyncIterable<Result<ChromeHistory>> {
  let data: any;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`Chrome history: failed to read JSON in '${path}'`, path, e);
    return;
  }
  if (!data || !("Browser History" in data)) {
    yield makeError(`Chrome/BrowserHistory: no 'Browser History' key in '${path}'`, path);
    return;
  }
  for (const item of data["Browser History"] ?? []) {
    try {
      yield {
        kind: "chromeHistory",
        title: item.title,
        url: item.url, // intentionally not coerced to https; this is user history
        dt: new Date(item.time_usec / 1000),
        pageTransition: item.page_transition ?? null,
      };
    } catch (e) {
      yield makeError("Chrome history row failed", path, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Google Keep — one note per file
// ---------------------------------------------------------------------------

export async function* parseKeep(path: string): AsyncIterable<Result<Keep>> {
  let data: any;
  try {
    data = await readJson(path);
  } catch (e) {
    yield makeError(`Keep: failed to read JSON in '${path}'`, path, e);
    return;
  }
  try {
    const updatedDt = new Date(data.userEditedTimestampUsec / 1000);
    const createdUsec = data.createdTimestampUsec;
    const createdDt = createdUsec == null ? updatedDt : new Date(createdUsec / 1000);

    yield {
      kind: "keep",
      title: data.title,
      created_dt: createdDt,
      updated_dt: updatedDt,
      listContent: (data.listContent ?? []).map((c: any) => ({
        textHtml: c.textHtml,
        text: c.text,
        isChecked: c.isChecked,
      })),
      textContent: data.textContent ?? null,
      textContentHtml: data.textContentHtml ?? null,
      color: data.color,
      annotations: (data.annotations ?? []).map((a: any) => ({
        description: a.description,
        source: a.source,
        title: a.title,
        url: a.url,
      })),
      isTrashed: data.isTrashed,
      isPinned: data.isPinned,
      isArchived: data.isArchived,
    };
  } catch (e) {
    yield makeError("Keep parse failed", path, e);
  }
}
