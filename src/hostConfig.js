/**
 * Settings that belong to whoever runs the addon, read from the environment
 * once at startup. Readers never see or change these: their own settings
 * live in the install URL (see config.js).
 *
 * Every variable is optional. A value that cannot be read falls back to its
 * default with a warning in the log, so a typo never stops the server.
 *
 *   CACHE_STORE                 memory | redis | file. Default: redis when
 *                               REDIS_URL is set, otherwise memory.
 *   REDIS_URL                   redis://user:password@host:port/db
 *   CACHE_DIR                   where the file store writes (default .cache);
 *                               on Railway, a volume's mount path
 *   CACHE_PREFIX                namespace for every key (default youstream).
 *                               Two deployments with the same prefix on one
 *                               Redis share their searches; give them
 *                               different prefixes to keep them apart.
 *   CACHE_MEMORY_MB             memory store size (default 64)
 *   CACHE_FILE_MB               file store size (default 512)
 *
 *   CACHE_SEARCH_TTL            how long a YouTube search counts as current
 *                               (default 24h)
 *   CACHE_SEARCH_RECENT_TTL     the same, for a film or episode released in
 *                               the last CACHE_RECENT_DAYS (default 3h), so
 *                               an upload that follows a premiere is found
 *                               the same day
 *   CACHE_RECENT_DAYS           default 30
 *   CACHE_METADATA_TTL          titles, years, runtimes, credits (default 3d)
 *   CACHE_STALE_TTL             how much longer an entry is kept to answer
 *                               with when YouTube or a metadata service
 *                               fails -- a spent quota, an outage (default
 *                               7d). YouTube data is never kept longer than
 *                               30 days in all, as YouTube's API policies
 *                               require.
 *   CACHE_ADMIN_TOKEN           turns on GET and DELETE /admin/cache, with
 *                               this as the bearer token
 *
 *   STREAM_CACHE_MAX_AGE        how long an app may reuse a stream list with
 *                               videos in it (default 6h)
 *   STREAM_CACHE_MAX_AGE_EMPTY  ... an empty one (default 1h; never longer
 *                               than CACHE_SEARCH_RECENT_TTL for a recent
 *                               release)
 *
 *   IMDB_DATASETS               off to match films on Cinemeta's runtimes
 *                               alone instead of loading IMDb's own data
 *                               daily (see metadata/imdb.js)
 *   TVDB_API_KEY, TVDB_PIN      TheTVDB's API, for episodes' own runtimes
 *                               and air dates (see metadata/tvdb.js). The
 *                               PIN only for a subscriber-supported key
 *
 * Durations are seconds, or a number with s, m, h or d: 90, 90s, 15m, 6h, 7d.
 * Zero turns that cache off.
 */

const SECOND_MS = 1000;
const UNIT_MS = { s: SECOND_MS, m: 60 * SECOND_MS, h: 60 * 60 * SECOND_MS, d: 24 * 60 * 60 * SECOND_MS };
const DAY_MS = UNIT_MS.d;

/** YouTube API data may be kept 30 days at most, then refreshed or deleted. */
const MAX_YOUTUBE_DATA_MS = 30 * DAY_MS;

const STORES = ["memory", "redis", "file"];
const OFF = ["off", "false", "0", "no"];

const DEFAULTS = {
  CACHE_DIR: ".cache",
  CACHE_PREFIX: "youstream",
  CACHE_MEMORY_MB: 64,
  CACHE_FILE_MB: 512,
  CACHE_SEARCH_TTL: "24h",
  CACHE_SEARCH_RECENT_TTL: "3h",
  CACHE_RECENT_DAYS: 30,
  CACHE_METADATA_TTL: "3d",
  CACHE_STALE_TTL: "7d",
  STREAM_CACHE_MAX_AGE: "6h",
  STREAM_CACHE_MAX_AGE_EMPTY: "1h"
};

/** "6h" -> 21600000. Null for anything that is not a duration. */
function parseDuration(raw) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(String(raw));
  if (!match) return null;
  return Math.round(Number(match[1]) * UNIT_MS[(match[2] || "s").toLowerCase()]);
}

/** The URL with its password masked, for the log. */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch (_) {
    return "(unreadable URL)";
  }
}

function readHostConfig(env = process.env) {
  const warnings = [];
  const given = (name) => typeof env[name] === "string" && env[name].trim() !== "";

  function duration(name) {
    if (given(name)) {
      const ms = parseDuration(env[name]);
      if (ms !== null) return ms;
      warnings.push(`${name}="${env[name]}" is not a duration such as 90s, 15m, 6h or 7d; using ${DEFAULTS[name]}`);
    }
    return parseDuration(DEFAULTS[name]);
  }

  function count(name) {
    if (given(name)) {
      const n = Number(env[name]);
      if (Number.isFinite(n) && n > 0) return n;
      warnings.push(`${name}="${env[name]}" is not a positive number; using ${DEFAULTS[name]}`);
    }
    return DEFAULTS[name];
  }

  const redisUrl = given("REDIS_URL") ? env.REDIS_URL.trim() : null;
  let store = redisUrl ? "redis" : "memory";
  if (given("CACHE_STORE")) {
    const asked = env.CACHE_STORE.trim().toLowerCase();
    if (!STORES.includes(asked)) {
      warnings.push(`CACHE_STORE="${env.CACHE_STORE}" is not one of ${STORES.join(", ")}; using ${store}`);
    } else if (asked === "redis" && !redisUrl) {
      warnings.push("CACHE_STORE=redis needs REDIS_URL; using memory");
    } else {
      store = asked;
    }
  }

  let prefix = DEFAULTS.CACHE_PREFIX;
  if (given("CACHE_PREFIX")) {
    const cleaned = env.CACHE_PREFIX.trim().toLowerCase();
    if (/^[a-z0-9_-]{1,40}$/.test(cleaned)) prefix = cleaned;
    else warnings.push(`CACHE_PREFIX="${env.CACHE_PREFIX}" may only use letters, digits, - and _; using ${prefix}`);
  }

  const searchMs = duration("CACHE_SEARCH_TTL");
  const recentSearchMs = duration("CACHE_SEARCH_RECENT_TTL");
  const staleMs = duration("CACHE_STALE_TTL");
  [
    ["CACHE_SEARCH_TTL", searchMs],
    ["CACHE_SEARCH_RECENT_TTL", recentSearchMs]
  ].forEach(([name, ms]) => {
    if (ms > MAX_YOUTUBE_DATA_MS) warnings.push(`${name} is capped at 30 days, the most YouTube's API policies allow`);
  });

  return {
    cache: {
      store,
      redisUrl,
      dir: given("CACHE_DIR") ? env.CACHE_DIR.trim() : DEFAULTS.CACHE_DIR,
      prefix,
      memoryBytes: count("CACHE_MEMORY_MB") * 1024 * 1024,
      fileBytes: count("CACHE_FILE_MB") * 1024 * 1024,
      searchMs: Math.min(searchMs, MAX_YOUTUBE_DATA_MS),
      recentSearchMs: Math.min(recentSearchMs, MAX_YOUTUBE_DATA_MS),
      recentDays: count("CACHE_RECENT_DAYS"),
      metadataMs: duration("CACHE_METADATA_TTL"),
      staleMs,
      adminToken: given("CACHE_ADMIN_TOKEN") ? env.CACHE_ADMIN_TOKEN.trim() : null
    },
    streams: {
      maxAgeSeconds: Math.round(duration("STREAM_CACHE_MAX_AGE") / SECOND_MS),
      emptyMaxAgeSeconds: Math.round(duration("STREAM_CACHE_MAX_AGE_EMPTY") / SECOND_MS),
      failedMaxAgeSeconds: 60
    },
    metadata: {
      imdbDatasets: !(given("IMDB_DATASETS") && OFF.includes(env.IMDB_DATASETS.trim().toLowerCase())),
      tvdbKey: given("TVDB_API_KEY") ? env.TVDB_API_KEY.trim() : null,
      tvdbPin: given("TVDB_PIN") ? env.TVDB_PIN.trim() : null
    },
    warnings
  };
}

/** One line for the startup log; never prints a password or the admin token. */
function describeCache(cache) {
  const ttl = (ms) => {
    if (ms === 0) return "off";
    const [unit, size] = Object.entries(UNIT_MS)
      .reverse()
      .find(([, size]) => ms % size === 0) || ["s", SECOND_MS];
    return `${ms / size}${unit}`;
  };
  const where = {
    memory: `memory (${Math.round(cache.memoryBytes / 1048576)} MB)`,
    redis: `redis ${redactUrl(cache.redisUrl)}`,
    file: `file ${cache.dir} (${Math.round(cache.fileBytes / 1048576)} MB)`
  }[cache.store];
  return (
    `${where}, prefix "${cache.prefix}": searches ${ttl(cache.searchMs)} ` +
    `(${ttl(cache.recentSearchMs)} for releases of the last ${cache.recentDays} days), ` +
    `metadata ${ttl(cache.metadataMs)}, ${cache.staleMs ? `kept ${ttl(cache.staleMs)} more for outages` : "nothing kept for outages"}` +
    `${cache.adminToken ? ", admin endpoint on" : ""}`
  );
}

const hostConfig = readHostConfig();

module.exports = { hostConfig, readHostConfig, describeCache, parseDuration, redactUrl, MAX_YOUTUBE_DATA_MS, DAY_MS };
