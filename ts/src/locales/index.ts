import type { GoogleEvent, Result } from "../models/index.ts";
import { parseYoutubeCommentsCsv, parseYoutubeLiveChatsCsv } from "../parsers/csv/index.ts";
/**
 * Locale handler maps — port of `locales/en.py` and `locales/de.py`.
 *
 * Each locale is an ordered list of `[regex, handler|null]` pairs.
 * - `handler` is an async-generator function that parses a file
 * - `null` means "explicitly ignore matching files" (so dispatch knows the
 *   file isn't an unhandled-file warning case)
 * - First match wins; entries are evaluated in order.
 */
import { parseHtmlActivity, parseHtmlComments } from "../parsers/html/index.ts";
import {
  parseAppInstalls,
  parseChromeHistory,
  parseJsonActivity,
  parseKeep,
  parseLikes,
  parseLocationHistory,
  parseSemanticLocationHistory,
} from "../parsers/json/index.ts";

/** Parser handler — yields one or more `Result<Event>` from a file path. */
export type HandlerFunction = (path: string) => AsyncIterable<Result<GoogleEvent>>;

/** Locale: ordered list of regex -> handler|null pairs. */
export type HandlerMap = Array<[RegExp, HandlerFunction | null]>;

/** Convert an array of [regex string, handler] entries to a HandlerMap. */
export function compileHandlerMap(entries: Array<[string, HandlerFunction | null]>): HandlerMap {
  return entries.map(([pat, h]) => [new RegExp(`^${pat}`), h]);
}

// HTML parsers — ported via `node-html-parser`. Live-chat HTML files use the
// same shape as comment HTML and reuse `parseHtmlComments`. (Note: in the
// Python codebase, live-chat HTML and comment HTML share the same parser path
// because both produce `YoutubeComment` events.)

// ---------------------------------------------------------------------------
// English locale (port of locales/en.py)
// ---------------------------------------------------------------------------

export const EN: HandlerMap = compileHandlerMap([
  ["Chrome/BrowserHistory\\.json", parseChromeHistory],
  ["Chrome/History\\.json", parseChromeHistory],
  ["Chrome", null],

  ["Google Play Store/Installs\\.json", parseAppInstalls],
  ["Google Play Store/", null],

  ["Location History/Location( )?History\\.json", parseLocationHistory],
  ["Location History( \\(Timeline\\))?/Records\\.json", parseLocationHistory],
  [
    "Location History( \\(Timeline\\))?/Semantic Location History/.*/.*\\.json",
    parseSemanticLocationHistory,
  ],
  ["Location History( \\(Timeline\\))?/", null],

  ["YouTube( and YouTube Music)?/history/.*?\\.html", parseHtmlActivity],
  ["YouTube( and YouTube Music)?/history/.*?\\.json", parseJsonActivity],

  ["YouTube( and YouTube Music)?/my-comments/.*?\\.html", parseHtmlComments],
  ["YouTube( and YouTube Music)?/comments/comments\\.csv", parseYoutubeCommentsCsv],
  ["YouTube( and YouTube Music)?/live\\s*chats/live\\s*chats\\.csv", parseYoutubeLiveChatsCsv],
  ["YouTube( and YouTube Music)?/my-live-chat-messages/.*?\\.html", parseHtmlComments],
  ["YouTube( and YouTube Music)?/playlists/likes\\.json", parseLikes],
  ["YouTube( and YouTube Music)?/playlists/", null],
  ["YouTube( and YouTube Music)?/subscriptions", null],
  ["YouTube( and YouTube Music)?/videos", null],
  ["YouTube( and YouTube Music)?/music-uploads", null],
  ["YouTube( and YouTube Music)?/channels/", null],

  ["My Activity/Assistant/.*\\.mp3", null],
  ["My Activity/Voice and Audio/.*\\.mp3", null],
  ["My Activity/Takeout", null],
  ["My Activity/.*?My\\s*Activity(-\\d+)?\\.html", parseHtmlActivity],
  ["My Activity/.*?My\\s*Activity\\.json", parseJsonActivity],

  ["Access Log Activity", null],
  ["Assistant Notes and Lists/.*\\.csv", null],
  ["Blogger/Comments/.*?feed\\.atom", null],
  ["Blogger/Blogs/", null],
  ["Fit/", null],
  ["Groups", null],
  ["Google Play Games Services/Games/.*/(Achievements|Activity|Experience|Scores)\\.html", null],
  ["Hangouts", null],
  ["Keep/.*?\\.json", parseKeep],
  ["Keep/", null],
  ["Maps \\(your places\\)", null],
  ["My Maps/.*\\.kmz", null],
  ["Saved/.*\\.csv", null],
  ["Shopping Lists/.*\\.csv", null],
  ["Tasks", null],

  ["Android Device Configuration Service/", null],
  ["Blogger/Albums/", null],
  ["Blogger/Profile/", null],
  ["Calendar/", null],
  ["Cloud Print/", null],
  ["Contacts/", null],
  ["Drive/", null],
  ["Google Account/", null],
  ["Google Business Profile/", null],
  ["Google My Business/", null],
  ["Google Pay/", null],
  ["Google Photos/", null],
  ["Google Play Books/.*\\.pdf", null],
  ["Google Play Games Services/Games/.*/(Data\\.bin|Metadata\\.html)", null],
  ["Google Play Movies.*?/", null],
  ["Google Shopping/", null],
  ["Google Store/", null],
  ["Google Translator Toolkit/", null],
  ["Google Workspace Marketplace/", null],
  ["Home App/", null],
  ["Mail/", null],
  ["Maps/", null],
  ["News/", null],
  ["Profile/Profile\\.json", null],
  ["Saved/Favorite places\\.csv", null],
  ["Search Contributions/", null],
  ["archive_browser\\.html", null],
]);

// ---------------------------------------------------------------------------
// German locale (port of locales/de.py)
// ---------------------------------------------------------------------------

export const DE: HandlerMap = compileHandlerMap([
  ["Chrome/BrowserHistory\\.json", parseChromeHistory],
  ["Chrome", null],
  ["Google Play Store/Installs\\.json", parseAppInstalls],
  ["Google Play Store/", null],
  ["Location History/Location( )?History\\.json", parseLocationHistory],
  ["Location History( \\(Timeline\\))?/Records\\.json", parseLocationHistory],
  [
    "Location History( \\(Timeline\\))?/Semantic Location History/.*/.*\\.json",
    parseSemanticLocationHistory,
  ],
  ["Location History( \\(Timeline\\))?/", null],
  ["YouTube( und YouTube Music)?/Verlauf/.*?\\.html", parseHtmlActivity],
  ["YouTube( und YouTube Music)?/Verlauf/.*?\\.json", parseJsonActivity],
  ["YouTube( und YouTube Music)?/Meine Kommentare/.*?\\.html", parseHtmlComments],
  ["YouTube( und YouTube Music)?/meine-live-chat-nachrichten/.*?\\.html", parseHtmlComments],
  ["YouTube( und YouTube Music)?/Playlists/Liked videos\\.json", parseLikes],
  ["YouTube( und Youtube Music)?/.*", null],
  ["Meine Aktivit\u00e4ten/.*?Meine\\s*Aktivit\u00e4ten\\.html", parseHtmlActivity],
  ["Meine Aktivit\u00e4ten/.*?Meine\\s*Aktivit\u00e4ten\\.json", parseJsonActivity],
  ["Google Fit", null],
  ["Google Play-Spieldienste/", null],
  ["Google Developers/", null],
  ["Google Play/", null],
  ["Google Pay", null],
  ["Google Finanzen/", null],
  ["Home App/", null],
  ["Google Shopping", null],
  ["Google Workspace Marketplace", null],
  ["Google Play Filme _ Serien/", null],
  ["Google Play B\u00fccher/", null],
  ["Google News/", null],
  ["Discover/", null],
  ["Google Kontakte/", null],
  ["Gmail/", null],
  ["Google Unternehmensprofil/", null],
  ["Google Fotos/", null],
  ["Gespeichert/", null],
  ["Google Chat/", null],
  ["Business Messages/", null],
  ["Classroom/", null],
  ["Google-Konto/", null],
  ["Google-Hilfe-Communities/", null],
  ["Kalender/", null],
  ["Aufgaben/", null],
  ["Maps \\(Meine Orte\\)/", null],
  ["Maps/", null],
  ["Profil/", null],
  ["Groups/", null],
  ["Drive/", null],
  ["Zugriffsprotokollaktivit\u00e4ten/", null],
  ["Search Contributions/", null],
  ["Android-Ger\u00e4tekonfigurationsdienst/", null],
  ["Archiv_\u00dcbersicht\\.html", null],
]);

// ---------------------------------------------------------------------------
// Locale registry — extensible via registerLocale().
// ---------------------------------------------------------------------------

export const LOCALES: Record<string, HandlerMap> = {
  EN,
  DE,
};

export function registerLocale(name: string, map: HandlerMap): void {
  LOCALES[name] = map;
}

export function listLocales(): string[] {
  return Object.keys(LOCALES);
}
