/**
 * A tiny in-memory TTL cache. Deliberately dependency-free: the addon runs as
 * a single container, so a Map with expiry timestamps is enough.
 *
 * Kept as its own small class so it can be swapped for a shared store (Redis,
 * SQLite) if this ever runs as more than one instance: every call site would
 * only need a different implementation of the same get/set/has API.
 */
class TTLCache {
  /**
   * @param {number} ttlMs default time-to-live for entries, in ms
   * @param {number} [maxEntries] the oldest entry (by insertion order) is
   *   evicted once this is exceeded, so unique lookups cannot grow memory
   *   without limit.
   */
  constructor(ttlMs, maxEntries = 1000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The named caches, one per concern, each with its own natural lifetime:
 *
 *   metadataCache  one upstream metadata response (Cinemeta, TMDB, Kitsu)
 *                  by URL. A day: titles, years and runtimes do not move.
 *
 *   searchCache    one YouTube search and its enrichment, by query. Shared
 *                  by everyone on this server, because the results are the
 *                  same whoever asks and a search is the scarcest thing the
 *                  addon spends: 100 of 10,000 daily quota units. A day.
 *
 *   keyCooldown    a YouTube key that just reported its quota spent, so the
 *                  next request does not spend a round trip finding out again.
 */
const metadataCache = new TTLCache(24 * HOUR_MS, 5000);
const searchCache = new TTLCache(24 * HOUR_MS, 1000);
const keyCooldown = new TTLCache(30 * 60 * 1000, 500);

function clearAllCaches() {
  metadataCache.clear();
  searchCache.clear();
  keyCooldown.clear();
}

module.exports = { TTLCache, metadataCache, searchCache, keyCooldown, clearAllCaches, HOUR_MS };
