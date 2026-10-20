const cache = require("../src/cache");
const { hostConfig, DAY_MS } = require("../src/hostConfig");
const { MemoryStore } = require("../src/cache/memory");
const { FileStore } = require("../src/cache/file");
const { RedisStore } = require("../src/cache/redis");
const { freshCache, TEST_CACHE } = require("./helpers");

const { searchCache, metadataCache, keyCooldown, Namespace, isNewRelease, searchMsFor } = cache;

let warn;
beforeEach(() => {
  freshCache();
  jest.restoreAllMocks();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a namespace", () => {
  test("keeps a value with its freshness", async () => {
    await searchCache.set("query", [{ id: "a" }]);
    expect(await searchCache.get("query")).toEqual({ value: [{ id: "a" }], fresh: true });
    expect(await searchCache.get("other")).toBeUndefined();
  });

  test("keys are the prefix, the namespace, its version and a hash of the id", async () => {
    const store = freshCache({ prefix: "beta" });
    await searchCache.set("Kota Factory season 1 episode 3", []);
    const [key] = [...store.entries.keys()];
    expect(key).toMatch(/^beta:search:v1:[0-9a-f]{32}$/);
  });

  test("a new version does not read the old one's entries, and is cleared with it", async () => {
    await searchCache.set("query", ["old shape"]);
    const next = new Namespace("search", 2, { freshMs: () => 1000, staleMs: () => 0 });
    expect(await next.get("query")).toBeUndefined();
    await next.set("query", ["new shape"]);
    expect(await searchCache.count()).toBe(2);
    expect(await next.clear()).toBe(2);
  });

  test("is fresh for its lifetime, then kept only as stale, then gone", async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(start);
    await metadataCache.set("url", { body: 1 });
    clock.mockReturnValue(start + TEST_CACHE.metadataMs - 1);
    expect((await metadataCache.get("url")).fresh).toBe(true);
    clock.mockReturnValue(start + TEST_CACHE.metadataMs + 1);
    expect(await metadataCache.get("url")).toEqual({ value: { body: 1 }, fresh: false });
    clock.mockReturnValue(start + TEST_CACHE.metadataMs + TEST_CACHE.staleMs + 1);
    expect(await metadataCache.get("url")).toBeUndefined();
  });

  test("a lifetime can be given per entry, and a cooldown is never kept stale", async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(start);
    await keyCooldown.set("key", true, 1000);
    clock.mockReturnValue(start + 1001);
    expect(await keyCooldown.get("key")).toBeUndefined();
  });

  test("a lifetime of zero stores nothing", async () => {
    freshCache({ metadataMs: 0 });
    await metadataCache.set("url", { body: 1 });
    expect(await metadataCache.count()).toBe(0);
  });

  test("an entry that is not what was written reads as missing", async () => {
    const store = freshCache();
    await store.set(searchCache.keyOf("query"), "{not json", Date.now() + 1000);
    expect(await searchCache.get("query")).toBeUndefined();
  });

  describe("over a store that fails", () => {
    const broken = () => {
      const store = new MemoryStore({ maxBytes: 1e6 });
      store.get = async () => {
        throw new Error("ECONNREFUSED");
      };
      store.set = store.get;
      store.close = async () => {
        throw new Error("already closed");
      };
      return store;
    };

    test("reads as empty and writes as nothing, with a warning a minute at most", async () => {
      cache.configureCache(TEST_CACHE, broken());
      const start = Date.now() + 10 * 60 * 1000;
      const clock = jest.spyOn(Date, "now").mockReturnValue(start);
      expect(await searchCache.get("q")).toBeUndefined();
      await searchCache.set("q", []);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[cache] reading search failed, carrying on without it: ECONNREFUSED");
      clock.mockReturnValue(start + 61 * 1000);
      await metadataCache.set("u", {});
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith("[cache] writing metadata failed, carrying on without it: ECONNREFUSED");
    });

    test("replacing it closes it, and a close that fails is ignored", () => {
      cache.configureCache(TEST_CACHE, broken());
      expect(() => freshCache()).not.toThrow();
    });
  });
});

describe("configureCache", () => {
  test("starts the store the settings name", async () => {
    expect(cache.configureCache({ ...TEST_CACHE, store: "memory" })).toBeInstanceOf(MemoryStore);
    const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "youstream-"));
    const files = cache.configureCache({ ...TEST_CACHE, store: "file", dir });
    expect(files).toBeInstanceOf(FileStore);
    await files.sweeping;
    const redis = cache.configureCache({ ...TEST_CACHE, store: "redis", redisUrl: "redis://127.0.0.1:1" });
    expect(redis).toBeInstanceOf(RedisStore);
    redis.client.emit("error", new Error("ECONNREFUSED"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Redis: ECONNREFUSED"));
    redis.client.disconnect();
    freshCache();
    require("fs").rmSync(dir, { recursive: true, force: true });
  });

  test("with no settings, the host's", () => {
    cache.configureCache();
    expect(cache.cacheSettings()).toBe(hostConfig.cache);
  });

  test("is done on first use when nothing configured it", async () => {
    await jest.isolateModulesAsync(async () => {
      const fresh = require("../src/cache");
      expect(await fresh.searchCache.get("anything")).toBeUndefined();
      expect(fresh.cacheSettings()).toBe(require("../src/hostConfig").hostConfig.cache);
      await fresh.closeCache();
    });
  });
});

describe("clearAllCaches, cacheStats and closeCache", () => {
  test("clear every namespace under the prefix, and count what is there", async () => {
    await searchCache.set("a", []);
    await metadataCache.set("b", {});
    await keyCooldown.set("c", true);
    await cache.browseCache.set("d", { items: [], next: null });
    await cache.videoCache.set("e", {});
    expect(await cache.cacheStats()).toMatchObject({
      store: "memory",
      prefix: "youstream",
      entries: { search: 1, metadata: 1, cooldown: 1, browse: 1, video: 1 }
    });
    expect(await cache.clearAllCaches()).toBe(5);
    expect((await cache.cacheStats()).entries).toEqual({ search: 0, metadata: 0, cooldown: 0, browse: 0, video: 0 });
  });

  test("closing twice is harmless, and the next use starts again", async () => {
    await cache.closeCache();
    await cache.closeCache();
    expect(await searchCache.get("x")).toBeUndefined();
  });
});

describe("how long a search stays current", () => {
  const NOW = Date.parse("2026-10-12T12:00:00Z");

  test.each([
    ["released yesterday", { released: "2026-10-11" }, true],
    ["released 29 days ago", { released: "2026-09-13" }, true],
    ["released 31 days ago", { released: "2026-09-11" }, false],
    ["not out yet", { released: "2026-12-25" }, true],
    ["undated, from this year", { year: 2026 }, true],
    ["undated, an episode of this year", { isEpisode: true, year: 2019, releaseYear: 2026 }, true],
    ["undated, from last year", { year: 2025 }, false],
    ["undated and unknown", {}, false],
    ["an unreadable date falls back to the year", { released: "soon", year: 2026 }, true]
  ])("%s", (_, title, recent) => {
    expect(isNewRelease(title, 30, NOW)).toBe(recent);
  });

  test("a recent release's search is current for the shorter time", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(searchMsFor({ released: today })).toBe(TEST_CACHE.recentSearchMs);
    expect(searchMsFor({ released: "1994-09-23" })).toBe(TEST_CACHE.searchMs);
  });

  test("never longer than an ordinary search's, and off when searches are off", () => {
    const today = new Date().toISOString().slice(0, 10);
    freshCache({ searchMs: 60 * 60 * 1000, recentSearchMs: 3 * 60 * 60 * 1000 });
    expect(searchMsFor({ released: today })).toBe(60 * 60 * 1000);
    freshCache({ searchMs: 0 });
    expect(searchMsFor({ released: today })).toBe(0);
  });

  test("YouTube data is kept no more than 30 days in all", async () => {
    const store = freshCache({ searchMs: 25 * DAY_MS, staleMs: 30 * DAY_MS });
    const start = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(start);
    await searchCache.set("q", []);
    expect([...store.entries.values()][0].expiresAt).toBe(start + 30 * DAY_MS);
  });
});
