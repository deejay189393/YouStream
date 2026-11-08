/**
 * Settings that belong to whoever runs the addon, read from the environment
 * once at startup. Readers never see or change these: their own settings
 * live in the install URL (see config.js).
 *
 * Every variable is optional. A value that cannot be read falls back to its
 * default with a warning in the log, so a typo never stops the server.
 *
 *   CACHE_STORE                 memory | redis | file | database. Default:
 *                               redis when REDIS_URL is set, otherwise
 *                               memory. database keeps the cache in a table
 *                               of DATABASE_URL's database, beside profiles
 *   REDIS_URL                   redis://user:password@host:port/db
 *   CACHE_DIR                   where the file store writes (default .cache);
 *                               on Railway, a volume's mount path
 *   CACHE_PREFIX                namespace for every key (default youstream).
 *                               Two deployments with the same prefix on one
 *                               Redis or database share their searches; give
 *                               them different prefixes to keep them apart.
 *   CACHE_MEMORY_MB             memory store size (default 64)
 *   CACHE_FILE_MB               file store size (default 512)
 *   CACHE_DATABASE_MB           database store size, for this prefix
 *                               (default 512)
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
 *   BLOCKED_VIDEOS              videos this server never offers, for a rights
 *                               holder who asks: ids or YouTube links,
 *                               separated by commas or spaces
 *   BLOCKED_CHANNELS            the same for whole channels: UC... ids or
 *                               youtube.com/channel/ links
 *   CONTACT                     an email address or a URL, shown on the terms
 *                               page for questions and removal requests
 *                               (default: the project's GitHub issues)
 *
 *   DATABASE_URL                where profiles are kept: a SQLite file,
 *                               sqlite:///data/youstream.db (on Railway, in a
 *                               volume), or postgres://user:pass@host/db (see
 *                               storage/index.js). With SECRET_KEY, turns
 *                               profiles on; without both, the install link
 *                               carries the settings, as before
 *   SECRET_KEY                  64 hexadecimal characters (32 random bytes),
 *                               which every profile's keys are bound to. Keep
 *                               it secret and never change it: every profile
 *                               would stop opening
 *   PROFILE_SESSION_TTL         how long a remembered sign-in lasts unused
 *                               (default 30d)
 *   PROFILE_SESSION_MAX_TTL     how long it lasts however much it is used
 *                               (default 90d)
 *   PROFILE_PRUNE_AFTER         delete a profile no app or sign-in has used
 *                               for this long (default off: kept until its
 *                               owner deletes it)
 *   TRUST_PROXY                 how many proxies stand in front of YouStream,
 *                               whose X-Forwarded-For says who the client is
 *                               (default 1, as on Railway); false for none.
 *                               Sign-in attempts are limited per client
 *
 * Durations are seconds, or a number with s, m, h or d: 90, 90s, 15m, 6h, 7d.
 * Zero turns that cache off.
 */

const { parseDatabaseUrl, describeDatabase } = require("./storage");

const SECOND_MS = 1000;
const UNIT_MS = { s: SECOND_MS, m: 60 * SECOND_MS, h: 60 * 60 * SECOND_MS, d: 24 * 60 * 60 * SECOND_MS };
const DAY_MS = UNIT_MS.d;

/** YouTube API data may be kept 30 days at most, then refreshed or deleted. */
const MAX_YOUTUBE_DATA_MS = 30 * DAY_MS;

const STORES = ["memory", "redis", "file", "database"];
const DEFAULT_CONTACT = "https://github.com/deejay189393/YouStream/issues";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** A video id from an id or a YouTube link (watch, youtu.be, shorts, embed, live). */
function videoIdOf(entry) {
  if (VIDEO_ID.test(entry)) return entry;
  const match = /(?:[?&]v=|youtu\.be\/|\/(?:shorts|embed|live)\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(entry);
  return match ? match[1] : null;
}

/** A channel id from an id or a youtube.com/channel/ link. */
function channelIdOf(entry) {
  if (CHANNEL_ID.test(entry)) return entry;
  const match = /\/channel\/(UC[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(entry);
  return match ? match[1] : null;
}
const OFF = ["off", "false", "0", "no"];

const DEFAULTS = {
  PROFILE_SESSION_TTL: "30d",
  PROFILE_SESSION_MAX_TTL: "90d",
  CACHE_DIR: ".cache",
  CACHE_PREFIX: "youstream",
  CACHE_MEMORY_MB: 64,
  CACHE_FILE_MB: 512,
  CACHE_DATABASE_MB: 512,
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
  let databaseUrl = null;
  if (given("DATABASE_URL")) {
    try {
      parseDatabaseUrl(env.DATABASE_URL);
      databaseUrl = env.DATABASE_URL.trim();
    } catch (_) {
      // Said once, by readProfiles.
    }
  }
  let store = redisUrl ? "redis" : "memory";
  if (given("CACHE_STORE")) {
    const asked = env.CACHE_STORE.trim().toLowerCase();
    if (!STORES.includes(asked)) {
      warnings.push(`CACHE_STORE="${env.CACHE_STORE}" is not one of ${STORES.join(", ")}; using ${store}`);
    } else if (asked === "redis" && !redisUrl) {
      warnings.push("CACHE_STORE=redis needs REDIS_URL; using memory");
    } else if (asked === "database" && !databaseUrl) {
      warnings.push(`CACHE_STORE=database needs a usable DATABASE_URL; using ${store}`);
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

  function idList(name, idOf, what) {
    if (!given(name)) return [];
    const ids = [];
    env[name]
      .split(/[\s,]+/)
      .filter(Boolean)
      .forEach((entry) => {
        const id = idOf(entry);
        if (id) ids.push(id);
        else warnings.push(`${name}: "${entry}" is not a ${what}; ignored`);
      });
    return [...new Set(ids)];
  }

  return {
    profiles: readProfiles(env, given, duration, warnings),
    trustProxy: readTrustProxy(env, given, warnings),
    cache: {
      store,
      redisUrl,
      databaseUrl,
      dir: given("CACHE_DIR") ? env.CACHE_DIR.trim() : DEFAULTS.CACHE_DIR,
      prefix,
      memoryBytes: count("CACHE_MEMORY_MB") * 1024 * 1024,
      fileBytes: count("CACHE_FILE_MB") * 1024 * 1024,
      databaseBytes: count("CACHE_DATABASE_MB") * 1024 * 1024,
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
    legal: {
      blockedVideos: idList("BLOCKED_VIDEOS", videoIdOf, "YouTube video id or link"),
      blockedChannels: idList("BLOCKED_CHANNELS", channelIdOf, "YouTube channel id (UC...) or channel link"),
      contact: given("CONTACT") ? env.CONTACT.trim() : DEFAULT_CONTACT
    },
    metadata: {
      imdbDatasets: !(given("IMDB_DATASETS") && OFF.includes(env.IMDB_DATASETS.trim().toLowerCase())),
      tvdbKey: given("TVDB_API_KEY") ? env.TVDB_API_KEY.trim() : null,
      tvdbPin: given("TVDB_PIN") ? env.TVDB_PIN.trim() : null
    },
    warnings
  };
}

/** A sign-in not remembered lasts as long as the browser keeps it, and a day at most. */
const BROWSER_SESSION_MS = DAY_MS;

/**
 * Profiles are on when both DATABASE_URL and SECRET_KEY are usable; when
 * either is missing or wrong they are off, with a warning, and the server
 * runs as without them.
 */
function readProfiles(env, given, duration, warnings) {
  const off = (reason) => {
    warnings.push(`${reason}; profiles are off`);
    return null;
  };
  let databaseUrl = null;
  if (given("DATABASE_URL")) {
    try {
      parseDatabaseUrl(env.DATABASE_URL);
      databaseUrl = env.DATABASE_URL.trim();
    } catch (err) {
      off(err.message);
    }
  }
  let secret = null;
  if (given("SECRET_KEY")) {
    if (/^[0-9a-f]{64}$/i.test(env.SECRET_KEY.trim())) secret = Buffer.from(env.SECRET_KEY.trim(), "hex");
    else off("SECRET_KEY must be 64 hexadecimal characters (32 bytes), such as openssl rand -hex 32 prints");
  }
  if (databaseUrl && !secret && !given("SECRET_KEY")) off("Profiles need SECRET_KEY as well as DATABASE_URL");
  if (secret && !databaseUrl && !given("DATABASE_URL")) off("Profiles need DATABASE_URL as well as SECRET_KEY");

  const rememberedMs = duration("PROFILE_SESSION_TTL");
  const maxMs = duration("PROFILE_SESSION_MAX_TTL");
  let pruneAfterMs = 0;
  if (given("PROFILE_PRUNE_AFTER") && !OFF.includes(env.PROFILE_PRUNE_AFTER.trim().toLowerCase())) {
    const ms = parseDuration(env.PROFILE_PRUNE_AFTER);
    if (ms === null) warnings.push(`PROFILE_PRUNE_AFTER="${env.PROFILE_PRUNE_AFTER}" is not a duration such as 365d; profiles are never pruned`);
    else pruneAfterMs = ms;
  }
  return {
    enabled: Boolean(databaseUrl && secret),
    databaseUrl,
    secret,
    sessions: { rememberedMs, maxMs: Math.max(maxMs, rememberedMs), browserMs: BROWSER_SESSION_MS },
    pruneAfterMs
  };
}

/** Express's "trust proxy": a number of hops, or false. */
function readTrustProxy(env, given, warnings) {
  if (!given("TRUST_PROXY")) return 1;
  const raw = env.TRUST_PROXY.trim().toLowerCase();
  if (OFF.includes(raw)) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  warnings.push(`TRUST_PROXY="${env.TRUST_PROXY}" is not a number of proxies or false; using 1`);
  return 1;
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
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const where = {
    memory: () => `memory (${mb(cache.memoryBytes)})`,
    redis: () => `redis ${redactUrl(cache.redisUrl)}`,
    file: () => `file ${cache.dir} (${mb(cache.fileBytes)})`,
    database: () => `database ${describeDatabase(cache.databaseUrl)} (${mb(cache.databaseBytes)})`
  }[cache.store]();
  return (
    `${where}, prefix "${cache.prefix}": searches ${ttl(cache.searchMs)} ` +
    `(${ttl(cache.recentSearchMs)} for releases of the last ${cache.recentDays} days), ` +
    `metadata ${ttl(cache.metadataMs)}, ${cache.staleMs ? `kept ${ttl(cache.staleMs)} more for outages` : "nothing kept for outages"}` +
    `${cache.adminToken ? ", admin endpoint on" : ""}`
  );
}

const hostConfig = readHostConfig();

module.exports = {
  hostConfig,
  readHostConfig,
  describeCache,
  parseDuration,
  redactUrl,
  videoIdOf,
  channelIdOf,
  MAX_YOUTUBE_DATA_MS,
  DAY_MS,
  DEFAULT_CONTACT
};
