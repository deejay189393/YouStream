/**
 * The cache against a real Redis, when REDIS_TEST_URL names one (CI starts
 * one; locally: redis-server, then REDIS_TEST_URL=redis://127.0.0.1:6379).
 * Skipped otherwise: the unit tests cover the same code against a mock.
 */
const { configureCache, searchCache, metadataCache, clearAllCaches, cacheStats, closeCache } = require("../src/cache");
const { RedisStore } = require("../src/cache/redis");
const { TEST_CACHE } = require("./helpers");

const url = process.env.REDIS_TEST_URL;
const maybe = url ? describe : describe.skip;

maybe("the cache on a real Redis", () => {
  const prefix = `youstream-test-${process.pid}`;

  beforeAll(() => {
    expect(configureCache({ ...TEST_CACHE, store: "redis", redisUrl: url, prefix })).toBeInstanceOf(RedisStore);
  });

  afterAll(async () => {
    await clearAllCaches();
    await closeCache();
  });

  test("keeps, counts and clears entries under its own prefix", async () => {
    await searchCache.set("q", [{ id: "a" }]);
    await metadataCache.set("u", { body: null });
    expect(await searchCache.get("q")).toEqual({ value: [{ id: "a" }], fresh: true });
    expect(await metadataCache.get("u")).toEqual({ value: { body: null }, fresh: true });
    expect(await cacheStats()).toMatchObject({ store: "redis", prefix, entries: { search: 1, metadata: 1, cooldown: 0 } });
    expect(await searchCache.clear()).toBe(1);
    expect(await searchCache.get("q")).toBeUndefined();
  });

  test("Redis expires an entry once its extra time is over", async () => {
    configureCache({ ...TEST_CACHE, store: "redis", redisUrl: url, prefix, staleMs: 0 });
    await searchCache.set("brief", [], 50);
    expect(await searchCache.get("brief")).toEqual({ value: [], fresh: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await searchCache.get("brief")).toBeUndefined();
  });
});
