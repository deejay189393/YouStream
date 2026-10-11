const { normalizePlayback, PLAYBACK_VERSION } = require("./playback");
const { COUNTRY_SET, LANGUAGE_SET } = require("./regions");

/**
 * The reader's settings travel in the addon URL as its first path segment,
 * exactly the way stremio-addon-sdk's router expects:
 *
 *     encodeURIComponent(JSON.stringify(config))
 *
 * Nothing is stored on the server. Every setting left at its default is left
 * out, because the whole URL rides on every request an app makes.
 *
 *   youtubeKey      required -- the reader's YouTube Data API key
 *   tmdbKey         optional -- exact episode runtimes, and tmdb: ids
 *   movieMargin     "10m"  how far a film's length may be from its runtime
 *   episodeMargin   "45s"  the same for an episode whose own runtime is known
 *   typicalMargin   "20%"  for an episode when only the show's usual length is
 *   playback        ["app", "youtube"]  the ways to watch, in order
 *   playbackVersion 1      the option list the above was saved against
 *   types           ["movie", "series"]
 *   maxResults      5      how many matching videos to list
 *   region          "IN"   hides videos blocked there, ranks for it
 *   audioLanguage   "hi"   drops videos spoken in another language
 *   embeddableOnly  false  only videos that allow embedding (Stremio Web)
 *   exclude         [...]  words that disqualify a video's title
 *   movieQuery      "{title} {year} full movie {language}"
 *   episodeQuery    "{title} season {season} episode {episode}"
 */

/**
 * A margin is a number and a unit: seconds, minutes, or a percentage of the
 * listed runtime. Stored compactly as "45s", "10m" or "20%".
 */
const MARGIN_UNITS = {
  s: { label: "seconds", max: 7200 },
  m: { label: "minutes", max: 120 },
  "%": { label: "%", max: 100 }
};

const DEFAULT_MARGINS = {
  movieMargin: { value: 10, unit: "m" },
  episodeMargin: { value: 45, unit: "s" },
  typicalMargin: { value: 20, unit: "%" }
};

const CONTENT_TYPES = ["movie", "series"];
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 20;

/**
 * Words that mark a video as being *about* a title rather than the title
 * itself. Reactions and reviews are the dangerous ones: a reaction to an
 * episode runs as long as the episode -- measured, a search for a TVF show
 * that is no longer on YouTube returned twenty results, every one of them a
 * reaction, revisit or rewind of the right length. Game cutscene
 * compilations are sold as "full movie" and run feature length.
 */
const DEFAULT_EXCLUDE = [
  "trailer", "teaser", "promo", "sneak peek", "reaction", "react", "reacts", "reacting", "review", "explained",
  "explanation", "recap", "breakdown", "analysis", "commentary", "behind the scenes", "making of", "bloopers",
  "interview", "podcast", "spoof", "parody", "fan made", "fanmade", "fan film", "gameplay", "walkthrough",
  "cutscenes", "jukebox", "soundtrack", "ost", "lyrics", "amv", "edit", "shorts", "in minutes", "summary",
  "summarized", "ending explained", "theory", "theories", "best scenes", "deleted scenes", "compilation", "revisit",
  "rewind", "watching", "watch along", "watchalong", "watch party", "discussion", "facts", "best of", "album"
];

const DEFAULT_MOVIE_QUERY = "{title} {year} full movie {language}";
const DEFAULT_EPISODE_QUERY = "{title} season {season} episode {episode}";
const MAX_QUERY_LENGTH = 200;
const MAX_EXCLUDE_WORDS = 80;
const MAX_WORD_LENGTH = 40;
const MAX_KEY_LENGTH = 512;

function parseMargin(raw) {
  let value;
  let unit;
  if (raw && typeof raw === "object") {
    ({ value, unit } = raw);
    value = Number(value);
  } else if (typeof raw === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|%)\s*$/i.exec(raw);
    if (!match) return null;
    value = Number(match[1]);
    unit = match[2].toLowerCase();
  } else {
    return null;
  }
  if (!Object.hasOwn(MARGIN_UNITS, unit) || !Number.isFinite(value)) return null;
  if (value < 0 || value > MARGIN_UNITS[unit].max) return null;
  return { value: Math.round(value * 100) / 100, unit };
}

function formatMargin(margin) {
  return `${margin.value}${margin.unit}`;
}

function sameMargin(a, b) {
  return a.value === b.value && a.unit === b.unit;
}

function cleanKey(raw) {
  if (typeof raw !== "string") return "";
  const key = raw.trim();
  return key.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9._\-]+$/.test(key) ? key : "";
}

function cleanTemplate(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  return text.includes("{title}") ? text : fallback;
}

function cleanExclude(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_EXCLUDE];
  const seen = new Set();
  const words = [];
  raw.forEach((w) => {
    if (typeof w !== "string") return;
    const word = w.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_WORD_LENGTH);
    if (!word || seen.has(word)) return;
    seen.add(word);
    words.push(word);
  });
  return words.slice(0, MAX_EXCLUDE_WORDS);
}

function cleanTypes(raw) {
  const types = Array.isArray(raw) ? CONTENT_TYPES.filter((t) => raw.includes(t)) : [];
  return types.length ? types : [...CONTENT_TYPES];
}

function cleanMaxResults(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_RESULTS_LIMIT ? n : DEFAULT_MAX_RESULTS;
}

/**
 * Every setting, validated, with defaults filled in. Safe on anything: the
 * SDK hands its handlers whatever JSON the URL carried, and a hand-edited
 * URL can carry anything.
 */
function normalizeConfig(config) {
  const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const margin = (name) => parseMargin(c[name]) || { ...DEFAULT_MARGINS[name] };
  return {
    youtubeKey: cleanKey(c.youtubeKey),
    tmdbKey: cleanKey(c.tmdbKey),
    movieMargin: margin("movieMargin"),
    episodeMargin: margin("episodeMargin"),
    typicalMargin: margin("typicalMargin"),
    playback: normalizePlayback(c.playback),
    types: cleanTypes(c.types),
    maxResults: cleanMaxResults(c.maxResults),
    region: typeof c.region === "string" && COUNTRY_SET.has(c.region) ? c.region : "",
    audioLanguage: typeof c.audioLanguage === "string" && LANGUAGE_SET.has(c.audioLanguage) ? c.audioLanguage : "",
    embeddableOnly: c.embeddableOnly === true,
    exclude: cleanExclude(c.exclude),
    movieQuery: cleanTemplate(c.movieQuery, DEFAULT_MOVIE_QUERY),
    episodeQuery: cleanTemplate(c.episodeQuery, DEFAULT_EPISODE_QUERY)
  };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The URL segment for a config: only what differs from the defaults. */
function encodeConfig(config) {
  const n = normalizeConfig(config);
  const out = { youtubeKey: n.youtubeKey };
  if (n.tmdbKey) out.tmdbKey = n.tmdbKey;
  Object.keys(DEFAULT_MARGINS).forEach((name) => {
    if (!sameMargin(n[name], DEFAULT_MARGINS[name])) out[name] = formatMargin(n[name]);
  });
  out.playback = n.playback;
  out.playbackVersion = PLAYBACK_VERSION;
  if (!sameList(n.types, CONTENT_TYPES)) out.types = n.types;
  if (n.maxResults !== DEFAULT_MAX_RESULTS) out.maxResults = n.maxResults;
  if (n.region) out.region = n.region;
  if (n.audioLanguage) out.audioLanguage = n.audioLanguage;
  if (n.embeddableOnly) out.embeddableOnly = true;
  if (!sameList(n.exclude, DEFAULT_EXCLUDE)) out.exclude = n.exclude;
  if (n.movieQuery !== DEFAULT_MOVIE_QUERY) out.movieQuery = n.movieQuery;
  if (n.episodeQuery !== DEFAULT_EPISODE_QUERY) out.episodeQuery = n.episodeQuery;
  return encodeURIComponent(JSON.stringify(out));
}

function maybeDecode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    // Holds a literal % that is not an escape: already decoded.
    return raw;
  }
}

/**
 * A config path segment as a normalized config, or null when it is missing
 * or not a JSON object. Accepts the segment still percent-encoded or already
 * decoded (Express decodes route parameters).
 */
function decodeConfig(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(maybeDecode(raw));
  } catch (_) {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return normalizeConfig(parsed);
}

/** Complete enough to install: there is a YouTube key to search with. */
function isConfigured(config) {
  return Boolean(normalizeConfig(config).youtubeKey);
}

/** The TMDB key a request uses: the reader's own, else the server's. */
function effectiveTmdbKey(settings) {
  return settings.tmdbKey || cleanKey(process.env.TMDB_API_KEY);
}

module.exports = {
  normalizeConfig,
  encodeConfig,
  decodeConfig,
  isConfigured,
  effectiveTmdbKey,
  parseMargin,
  formatMargin,
  cleanKey,
  MARGIN_UNITS,
  DEFAULT_MARGINS,
  DEFAULT_EXCLUDE,
  DEFAULT_MOVIE_QUERY,
  DEFAULT_EPISODE_QUERY,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  MAX_QUERY_LENGTH,
  CONTENT_TYPES
};
