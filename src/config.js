const { normalizePlayback, PLAYBACK_VERSION } = require("./playback");
const { COUNTRY_SET, LANGUAGE_SET } = require("./regions");
const { PRESETS, DEFAULT_FORMAT, MAX_NAME_TEMPLATE, MAX_DESCRIPTION_TEMPLATE } = require("./streamFormat");
const { normalizeCatalogs, toStoredCatalogs, SORTS, LENGTHS } = require("./catalogs");

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
 *   partnerMovieMargin "20%" the same, for a film on an official channel
 *   episodeMargin   "90s"  the same for an episode whose own runtime is known
 *   typicalMargin   "30%"  for an episode when only the show's usual length is
 *   playback        ["app", "youtube"]  the ways to watch, in order
 *   playbackVersion 1      the option list the above was saved against
 *   types           ["movie", "series"]
 *   maxResults      5      how many matching videos to list
 *   minViews        1000   fewer views than this and a video is not offered
 *   region          "IN"   hides videos blocked there, ranks for it
 *   audioLanguage   "hi"   drops videos spoken in another language
 *   embeddableOnly  false  only videos that allow embedding (Stremio Web)
 *   officialOnly    false  only uploads from YouTube content partners
 *   exclude         [...]  words that disqualify a video's title
 *   excludeDescription [...] phrases that disqualify a video's description
 *   movieQuery      "{title} {year} full movie {language}"
 *   episodeQuery    "{title} season {season} episode {episode}"
 *   format          "youstream"  the preset a stream's name and description
 *                   come from: youstream, compact, tamtaro or classic
 *   nameTemplate, descriptionTemplate   the reader's own, in AIOStreams'
 *                   formatter syntax (streamFormat.js); only when they are
 *                   no preset, which is then left out
 *
 * YouTube itself, browsed in the app (catalogs.js, browse.js):
 *
 *   search          true   the app's search searches YouTube too. On
 *                   unless switched off, so an addon installed before
 *                   search existed has it as well
 *   searchSort      "relevance"  YouTube's own ranking; or date, viewCount,
 *                   rating
 *   searchLength    "any"  or short (under 4 minutes), medium, long
 *   safeSearch      "moderate"  YouTube's default; or strict, none
 *   catalogs        []     the reader's rows: searches, channels, playlists,
 *                   Trending, in order (catalogs.js)
 *   catalogRefresh  "2h"   how long a catalog's results are reused before
 *                   YouTube is asked again: minutes, hours or days, at
 *                   least 30 minutes
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

/**
 * Defaults chosen on measurements (see README, "Runtime margins"):
 *
 *   movies                10 minutes
 *   movies, official      20% -- partner channels' cuts of Indian films run
 *                         10 to 25 minutes short, and were all genuine
 *   episodes              90 seconds -- listings are whole minutes and the
 *                         YouTube cut differs by up to 70 s: at 45 s, two of
 *                         the five official Aspirants episodes were missed
 *   episodes, usual length 30% -- one Kota Factory episode runs 29% under
 *                         the show's usual length
 *
 * The episode number, not the length, is what keeps the wrong episode out,
 * so the wider episode margins cost no precision in the measured searches.
 */
const DEFAULT_MARGINS = {
  movieMargin: { value: 10, unit: "m" },
  partnerMovieMargin: { value: 20, unit: "%" },
  episodeMargin: { value: 90, unit: "s" },
  typicalMargin: { value: 30, unit: "%" }
};

const CONTENT_TYPES = ["movie", "series"];
const DEFAULT_MAX_RESULTS = 5;

/** YouTube search's SafeSearch: moderate is what YouTube does unasked. */
const SAFE_SEARCH = ["moderate", "strict", "none"];

/**
 * How often a catalog asks YouTube again, per reader. Two hours by default:
 * a search catalog costs one of the reader's 100 daily searches each time
 * it refreshes, and a row of videos barely changes in two hours. At least
 * thirty minutes, and no upper limit -- though YouTube's API policies let a
 * server keep its data 30 days at most, so anything longer refreshes then.
 */
const REFRESH_UNITS = {
  m: { label: "minutes", ms: 60 * 1000 },
  h: { label: "hours", ms: 60 * 60 * 1000 },
  d: { label: "days", ms: 24 * 60 * 60 * 1000 }
};
const DEFAULT_CATALOG_REFRESH = { value: 2, unit: "h" };
const MIN_CATALOG_REFRESH = { value: 30, unit: "m" };
const MIN_CATALOG_REFRESH_MS = 30 * 60 * 1000;

/**
 * Below this many views a video is not offered. Measured against the live
 * API, every false match that got past the other checks was nearly unwatched
 * -- a 205-view podcast episode titled "SEASON1 EPISODE 2 ... ASPIRANTs", a
 * 103-view "New Move Vivah (2026)" -- while the genuine uploads ran from
 * thousands to tens of millions. 0 turns the floor off.
 */
const DEFAULT_MIN_VIEWS = 1000;
const MAX_MIN_VIEWS = 100000000;
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
  "trailer", "teaser", "promo", "sneak peek", "reaction", "react", "reacts", "reacting", "review", "explain",
  "explained", "explanation", "explaine", "recap", "breakdown", "analysis", "commentary", "commentry", "behind the scenes",
  "making of", "bloopers",
  "interview", "podcast", "spoof", "parody", "fan made", "fanmade", "fan film", "gameplay", "walkthrough",
  "cutscenes", "jukebox", "soundtrack", "ost", "lyrics", "amv", "edit", "shorts", "in minutes", "summary",
  "summarized", "ending explained", "theory", "theories", "best scenes", "deleted scenes", "compilation", "revisit",
  "rewind", "watching", "watch along", "watchalong", "watch party", "discussion", "fact", "best of", "album",
  "r&f", "script reading", "table read", "ambience", "ambient", "audiobook", "audio book", "pocket fm", "details",
  "rifftrax", "abridged", "ytp", "meme", "ai generated", "full story", "game movie", "fandub", "critique",
  "critica", "resena", "recensione", "reaccion", "reacao", "explicacion", "explicado", "resumen", "resumo"
];

/**
 * Phrases in a video's description that mark it as something other than the
 * title itself. Measured over 1,490 real results: every one of these appeared
 * only on wrong matches or on unofficial re-uploads, never on an official or
 * public-domain upload. A fan film says "our new full fan movie"; an
 * explainer posing as a film says "in this video, we delve into"; a Hindi
 * recap says "is video mein ... baat karenge"; a partner channel's video
 * essay titled "The Shawshank Redemption (1994) | Tim Robbins, Morgan
 * Freeman" says "in this in-depth video essay, we analyze"; re-uploads of
 * other people's films cite "Section 107" and "fair use", or say "I do not
 * own"; a review channel that titles its uploads "Full Movie" says "this is
 * not a movie, this is just a movie review".
 */
const DEFAULT_EXCLUDE_DESCRIPTION = [
  "fan movie", "fan film", "fanmade", "fan made", "in this video", "in this youtube video", "is video mein",
  "is video me", "iss video mein", "we delve", "we will discuss", "we discuss", "we explore", "all rights belong",
  "do not own", "dont own", "not monetized", "section 107", "fair use", "copyright disclaimer", "gameplay",
  "game movie", "cutscenes", "troll", "critique", "video essay", "we analyze", "we analyse", "we examine",
  "this breakdown", "in depth analysis", "not a movie", "not the full movie", "just a movie review", "just a review",
  "only do reviews", "never show the full movie"
];

const DEFAULT_MOVIE_QUERY = "{title} {year} full movie {language}";
const DEFAULT_EPISODE_QUERY = "{title} season {season} episode {episode}";
const MAX_QUERY_LENGTH = 200;
const MAX_EXCLUDE_WORDS = 200;
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

/**
 * A refresh interval, "90m", "2h", "1.5d" or { value, unit }. Anything
 * shorter than thirty minutes is thirty minutes; anything that is not an
 * interval is null.
 */
function parseRefresh(raw) {
  let value;
  let unit;
  if (raw && typeof raw === "object") {
    ({ value, unit } = raw);
    value = Number(value);
  } else if (typeof raw === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$/i.exec(raw);
    if (!match) return null;
    value = Number(match[1]);
    unit = match[2].toLowerCase();
  } else {
    return null;
  }
  if (!Object.hasOwn(REFRESH_UNITS, unit) || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  if (rounded * REFRESH_UNITS[unit].ms < MIN_CATALOG_REFRESH_MS) return { ...MIN_CATALOG_REFRESH };
  return { value: rounded, unit };
}

/** An interval in milliseconds. */
function refreshMs(refresh) {
  return refresh.value * REFRESH_UNITS[refresh.unit].ms;
}

const optionIdOf = (list, id) => (list.some((option) => option.id === id) ? id : list[0].id);

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

/**
 * A stream text template as typed: line breaks kept, other control
 * characters dropped. Too long, or empty, is no template at all.
 */
function cleanFormatTemplate(raw, max) {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  return text && text.length <= max ? text : null;
}

/** The preset a pair of templates is, or null when they are the reader's own. */
function presetFor(nameTemplate, descriptionTemplate) {
  const id = Object.keys(PRESETS).find((key) => PRESETS[key].name === nameTemplate && PRESETS[key].description === descriptionTemplate);
  return id || null;
}

function cleanExclude(raw, defaults = DEFAULT_EXCLUDE) {
  if (!Array.isArray(raw)) return [...defaults];
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

/**
 * Which kinds of title the reader wants streams for. Both when nothing was
 * saved. An empty list is a choice too: a reader who only browses YouTube
 * turns films and episodes off.
 */
function cleanTypes(raw) {
  return Array.isArray(raw) ? CONTENT_TYPES.filter((t) => raw.includes(t)) : [...CONTENT_TYPES];
}

function cleanMaxResults(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_RESULTS_LIMIT ? n : DEFAULT_MAX_RESULTS;
}

function cleanMinViews(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_MIN_VIEWS ? n : DEFAULT_MIN_VIEWS;
}

/**
 * Every setting, validated, with defaults filled in. Safe on anything: the
 * SDK hands its handlers whatever JSON the URL carried, and a hand-edited
 * URL can carry anything.
 */
function normalizeConfig(config) {
  const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const margin = (name) => parseMargin(c[name]) || { ...DEFAULT_MARGINS[name] };
  const preset = typeof c.format === "string" && Object.hasOwn(PRESETS, c.format) ? c.format : DEFAULT_FORMAT;
  const nameTemplate = cleanFormatTemplate(c.nameTemplate, MAX_NAME_TEMPLATE) || PRESETS[preset].name;
  const descriptionTemplate =
    cleanFormatTemplate(c.descriptionTemplate, MAX_DESCRIPTION_TEMPLATE) || PRESETS[preset].description;
  return {
    youtubeKey: cleanKey(c.youtubeKey),
    tmdbKey: cleanKey(c.tmdbKey),
    movieMargin: margin("movieMargin"),
    partnerMovieMargin: margin("partnerMovieMargin"),
    episodeMargin: margin("episodeMargin"),
    typicalMargin: margin("typicalMargin"),
    playback: normalizePlayback(c.playback),
    types: cleanTypes(c.types),
    maxResults: cleanMaxResults(c.maxResults),
    minViews: cleanMinViews(c.minViews),
    region: typeof c.region === "string" && COUNTRY_SET.has(c.region) ? c.region : "",
    audioLanguage: typeof c.audioLanguage === "string" && LANGUAGE_SET.has(c.audioLanguage) ? c.audioLanguage : "",
    embeddableOnly: c.embeddableOnly === true,
    officialOnly: c.officialOnly === true,
    exclude: cleanExclude(c.exclude),
    excludeDescription: cleanExclude(c.excludeDescription, DEFAULT_EXCLUDE_DESCRIPTION),
    movieQuery: cleanTemplate(c.movieQuery, DEFAULT_MOVIE_QUERY),
    episodeQuery: cleanTemplate(c.episodeQuery, DEFAULT_EPISODE_QUERY),
    // "custom" when the templates are the reader's own
    format: presetFor(nameTemplate, descriptionTemplate) || "custom",
    nameTemplate,
    descriptionTemplate,
    search: c.search !== false,
    searchSort: optionIdOf(SORTS, c.searchSort),
    searchLength: optionIdOf(LENGTHS, c.searchLength),
    safeSearch: SAFE_SEARCH.includes(c.safeSearch) ? c.safeSearch : SAFE_SEARCH[0],
    catalogs: normalizeCatalogs(c.catalogs),
    catalogRefresh: parseRefresh(c.catalogRefresh) || { ...DEFAULT_CATALOG_REFRESH }
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
  if (n.minViews !== DEFAULT_MIN_VIEWS) out.minViews = n.minViews;
  if (n.region) out.region = n.region;
  if (n.audioLanguage) out.audioLanguage = n.audioLanguage;
  if (n.embeddableOnly) out.embeddableOnly = true;
  if (n.officialOnly) out.officialOnly = true;
  if (!sameList(n.exclude, DEFAULT_EXCLUDE)) out.exclude = n.exclude;
  if (!sameList(n.excludeDescription, DEFAULT_EXCLUDE_DESCRIPTION)) out.excludeDescription = n.excludeDescription;
  if (n.movieQuery !== DEFAULT_MOVIE_QUERY) out.movieQuery = n.movieQuery;
  if (n.episodeQuery !== DEFAULT_EPISODE_QUERY) out.episodeQuery = n.episodeQuery;
  if (n.format === "custom") {
    out.nameTemplate = n.nameTemplate;
    out.descriptionTemplate = n.descriptionTemplate;
  } else if (n.format !== DEFAULT_FORMAT) {
    out.format = n.format;
  }
  if (!n.search) out.search = false;
  if (n.searchSort !== SORTS[0].id) out.searchSort = n.searchSort;
  if (n.searchLength !== LENGTHS[0].id) out.searchLength = n.searchLength;
  if (n.safeSearch !== SAFE_SEARCH[0]) out.safeSearch = n.safeSearch;
  if (n.catalogs.length) out.catalogs = toStoredCatalogs(n.catalogs);
  if (!sameMargin(n.catalogRefresh, DEFAULT_CATALOG_REFRESH)) out.catalogRefresh = formatMargin(n.catalogRefresh);
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
  parseRefresh,
  refreshMs,
  cleanKey,
  cleanFormatTemplate,
  presetFor,
  SAFE_SEARCH,
  REFRESH_UNITS,
  DEFAULT_CATALOG_REFRESH,
  MIN_CATALOG_REFRESH,
  MARGIN_UNITS,
  DEFAULT_MARGINS,
  DEFAULT_EXCLUDE,
  DEFAULT_EXCLUDE_DESCRIPTION,
  DEFAULT_MOVIE_QUERY,
  DEFAULT_EPISODE_QUERY,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_VIEWS,
  MAX_MIN_VIEWS,
  MAX_RESULTS_LIMIT,
  MAX_QUERY_LENGTH,
  CONTENT_TYPES
};
