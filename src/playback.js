/**
 * The ways to watch a matched video, each on or off, in the reader's order.
 * The order is the order the app lists them, so the first one is what the
 * play button (and an app's autoplay) lands on.
 *
 * In-app playback sends the bare `ytId` and nothing else. The app resolves
 * the video itself, on the device, from the viewer's own connection: Stremio
 * in its built-in YouTube player, Nuvio through the extractor its trailers
 * use (YouTubeStreamResolver -> InAppYouTubeExtractor.extractSingleUrl,
 * which prefers YouTube's HLS playlist, so every quality is available). Nuvio
 * resolves a `ytId` only when the stream carries no `url` or `externalUrl`,
 * which is why that row carries neither. Nothing passes through this server,
 * so YouTube refusing datacenter addresses -- which it does, on and off --
 * never matters.
 *
 * The external rows hand Android a URI. Nuvio opens them with
 * `Intent(ACTION_VIEW, Uri.parse(externalUrl))` and no package, so the addon
 * cannot name an app; it can only choose a URI and let Android route it:
 *
 *   youtube    https://www.youtube.com/watch?v=ID -- the YouTube app if it is
 *              installed, otherwise a browser
 *   smarttube  vnd.youtube:ID -- registered by YouTube apps and never by a
 *              browser, so on a TV running SmartTube it normally lands there
 */

const WATCH_URL = "https://www.youtube.com/watch?v=";

const PLAYBACK_OPTIONS = [
  {
    id: "app",
    label: "Play in app",
    short: "Play in app",
    note:
      "Your app fetches the video straight from YouTube, at the best quality it offers. Stremio plays it in its built-in YouTube player; Nuvio needs a release newer than 1.1.0-beta.2."
  },
  {
    id: "youtube",
    label: "Open in the YouTube app",
    short: "YouTube app",
    note: "Hands the video to whichever app opens youtube.com links: the YouTube app, or a browser if there is none."
  },
  {
    id: "smarttube",
    label: "Open in SmartTube",
    short: "SmartTube",
    note: "Sends vnd.youtube:, which only a YouTube app opens, never a browser. Off unless you use SmartTube."
  }
];

const OPTIONS_BY_ID = new Map(PLAYBACK_OPTIONS.map((o) => [o.id, o]));
const OPTION_IDS = PLAYBACK_OPTIONS.map((o) => o.id);

/** In-app first, the YouTube app behind it; SmartTube is opt-in. */
const DEFAULT_PLAYBACK = ["app", "youtube"];

/**
 * The version of this option list a config was saved against. A saved list
 * is an explicit choice, so an option missing from it is off -- but an
 * option added after the list was saved never had the chance to be chosen.
 * Recording the version lets a future option be added to older lists rather
 * than silently withheld from everyone who installed before it existed.
 */
const PLAYBACK_VERSION = 1;

/**
 * An ordered, de-duplicated list of known option ids. An empty result falls
 * back to the default: a config that turns everything off could play
 * nothing, which is never what was meant.
 */
function normalizePlayback(value) {
  const seen = new Set();
  const ordered = (Array.isArray(value) ? value : []).filter((id) => {
    if (typeof id !== "string" || !OPTIONS_BY_ID.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return ordered.length ? ordered : [...DEFAULT_PLAYBACK];
}

/** The rows the configure page shows: enabled ones first, in order. */
function orderedPlaybackOptions(enabled) {
  const chosen = normalizePlayback(enabled);
  const rest = OPTION_IDS.filter((id) => !chosen.includes(id));
  return [...chosen, ...rest].map((id) => ({ ...OPTIONS_BY_ID.get(id), enabled: chosen.includes(id) }));
}

/** The URI an external option hands to the device, or null for in-app. */
function externalUrlFor(optionId, videoId) {
  if (optionId === "youtube") return `${WATCH_URL}${videoId}`;
  if (optionId === "smarttube") return `vnd.youtube:${videoId}`;
  return null;
}

module.exports = {
  PLAYBACK_OPTIONS,
  OPTION_IDS,
  OPTIONS_BY_ID,
  DEFAULT_PLAYBACK,
  PLAYBACK_VERSION,
  normalizePlayback,
  orderedPlaybackOptions,
  externalUrlFor,
  WATCH_URL
};
