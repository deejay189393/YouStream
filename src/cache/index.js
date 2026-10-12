const crypto = require("crypto");
const { hostConfig, describeCache, MAX_YOUTUBE_DATA_MS, DAY_MS } = require("../hostConfig");
const { MemoryStore } = require("./memory");
const { RedisStore } = require("./redis");
const { FileStore } = require("./file");

/**
 * What the addon keeps, and for how long. The store -- memory, Redis or
 * files -- and every lifetime are the host's choice (see hostConfig.js).
 *
 * Only what upstream services said is cached, never a verdict: a YouTube
 * search's raw results and a metadata service's raw answer. Matching runs
 * afresh on every request, so a reader's settings and any change to the
 * matching rules apply at once, with nothing to flush.
 *
 * Invalidation:
 *
 *   by age     each entry is current for its lifetime, and a search for a
 *              film or episode released in the last few weeks has a much
 *              shorter one, so an upload that follows a premiere is found
 *              the same day (searchMsFor).
 *
 *   by error   past its lifetime an entry is kept a while longer (staleMs),
 *              and answered with only when the service it came from fails:
 *              a spent quota or an outage serves yesterday's results rather
 *              than none. YouTube data is never kept past 30 days in all.
 *
 *   by shape   each namespace carries a version in its keys. When the code
 *              changes what it stores, the version goes up, and entries in
 *              the old shape are never read again; they expire on their own.
 *
 *   by hand    DELETE /admin/cache/<namespace> (see server.js), or a new
 *              CACHE_PREFIX.
 *
 * A store that fails -- Redis unreachable, a disk full -- is logged and
 * treated as empty. The addon answers without its cache rather than not
 * at all.
 */

const WARN_EVERY_MS = 60 * 1000;
let lastWarning = 0;

function warn(message) {
  const now = Date.now();
  if (now - lastWarning < WARN_EVERY_MS) return;
  lastWarning = now;
  console.warn(`[cache] ${message}`);
}

let settings = null;
let store = null;

function createStore(cache) {
  if (cache.store === "redis") {
    return new RedisStore({ url: cache.redisUrl, onError: (err) => warn(`Redis: ${err.message}`) });
  }
  if (cache.store === "file") return new FileStore({ dir: cache.dir, prefix: cache.prefix, maxBytes: cache.fileBytes });
  return new MemoryStore({ maxBytes: cache.memoryBytes });
}

/**
 * Starts the store the settings name, closing any earlier one. Called on
 * first use with the host's settings; tests call it with their own, and may
 * hand over a ready store.
 */
function configureCache(cache = hostConfig.cache, ready = null) {
  if (store) store.close().catch(() => {});
  lastWarning = 0;
  settings = cache;
  store = ready || createStore(cache);
  return store;
}

function current() {
  if (!store) configureCache();
  return store;
}

function cacheSettings() {
  current();
  return settings;
}

const hash = (id) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 32);

class Namespace {
  /**
   * @param {string} name
   * @param {number} version   raise when the shape of what is stored changes
   * @param {object} lifetimes
   * @param {function} lifetimes.freshMs  (settings) -> default lifetime
   * @param {function} lifetimes.staleMs  (settings, freshMs) -> extra time
   *                                      kept for when the source fails
   */
  constructor(name, version, { freshMs, staleMs }) {
    this.name = name;
    this.version = version;
    this.freshMs = freshMs;
    this.staleMs = staleMs;
  }

  /** Every version of this namespace, for counting and clearing. */
  prefix() {
    return `${cacheSettings().prefix}:${this.name}:`;
  }

  keyOf(id) {
    return `${this.prefix()}v${this.version}:${hash(id)}`;
  }

  /** { value, fresh } for a stored entry, or undefined. */
  async get(id) {
    let text;
    try {
      text = await current().get(this.keyOf(id));
    } catch (err) {
      warn(`reading ${this.name} failed, carrying on without it: ${err.message}`);
      return undefined;
    }
    if (typeof text !== "string") return undefined;
    try {
      const record = JSON.parse(text);
      return { value: record.v, fresh: Date.now() < record.f };
    } catch (_) {
      return undefined;
    }
  }

  async set(id, value, freshMs = this.freshMs(cacheSettings())) {
    if (!(freshMs > 0)) return;
    const now = Date.now();
    const staleMs = Math.max(0, this.staleMs(cacheSettings(), freshMs));
    try {
      await current().set(this.keyOf(id), JSON.stringify({ f: now + freshMs, v: value }), now + freshMs + staleMs);
    } catch (err) {
      warn(`writing ${this.name} failed, carrying on without it: ${err.message}`);
    }
  }

  async clear() {
    return current().clear(this.prefix());
  }

  async count() {
    return current().count(this.prefix());
  }
}

/**
 * One YouTube search and its enrichment, by query, shared by everyone on
 * this server: the results are the same whoever asks, and a search is the
 * scarcest thing the addon spends, 100 of a key's 10,000 daily units.
 * Version 1 is youtube.toVideo's shape.
 */
const searchCache = new Namespace("search", 1, {
  freshMs: (s) => s.searchMs,
  staleMs: (s, freshMs) => Math.min(s.staleMs, MAX_YOUTUBE_DATA_MS - freshMs)
});

/** One metadata service's answer (Cinemeta, TMDB, TVmaze, Kitsu), by URL. */
const metadataCache = new Namespace("metadata", 1, {
  freshMs: (s) => s.metadataMs,
  staleMs: (s) => s.staleMs
});

/**
 * A YouTube key that reported its daily quota spent, by fingerprint, until
 * the quota resets -- so the next request does not spend a round trip
 * learning it again. Never served stale.
 */
const keyCooldown = new Namespace("cooldown", 1, {
  freshMs: () => 60 * 60 * 1000,
  staleMs: () => 0
});

const NAMESPACES = { search: searchCache, metadata: metadataCache, cooldown: keyCooldown };

/**
 * Whether a film or episode came out recently enough that new uploads of it
 * are still appearing: released in the last `recentDays`, or not yet. With
 * no date listed, anything from this calendar year counts.
 */
function isNewRelease(title, recentDays, now) {
  const released = Date.parse(title.released);
  if (!Number.isNaN(released)) return now - released < recentDays * DAY_MS;
  const year = title.releaseYear || title.year;
  return Boolean(year) && year >= new Date(now).getUTCFullYear();
}

/** How long a search for this title stays current. */
function searchMsFor(title, now = Date.now()) {
  const s = cacheSettings();
  return isNewRelease(title, s.recentDays, now) ? Math.min(s.recentSearchMs, s.searchMs) : s.searchMs;
}

async function clearAllCaches() {
  return current().clear(`${cacheSettings().prefix}:`);
}

async function cacheStats() {
  const s = cacheSettings();
  const entries = {};
  for (const [name, namespace] of Object.entries(NAMESPACES)) entries[name] = await namespace.count();
  return { store: current().kind, prefix: s.prefix, description: describeCache(s), entries };
}

async function closeCache() {
  if (store) await store.close();
  store = null;
}

module.exports = {
  configureCache,
  cacheSettings,
  searchCache,
  metadataCache,
  keyCooldown,
  NAMESPACES,
  Namespace,
  isNewRelease,
  searchMsFor,
  clearAllCaches,
  cacheStats,
  closeCache
};
