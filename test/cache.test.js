const { TTLCache, metadataCache, searchCache, keyCooldown, clearAllCaches } = require("../src/cache");

afterEach(() => jest.useRealTimers());

describe("TTLCache", () => {
  test("stores and returns values", () => {
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
  });

  test("set returns the value it stored", () => {
    expect(new TTLCache(1000).set("a", 7)).toBe(7);
  });

  test("forgets an entry once it expires", () => {
    jest.useFakeTimers();
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    jest.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(0);
  });

  test("honours a per-entry lifetime", () => {
    jest.useFakeTimers();
    const cache = new TTLCache(1000);
    cache.set("long", 1, 5000);
    jest.advanceTimersByTime(2000);
    expect(cache.get("long")).toBe(1);
  });

  test("evicts the oldest entry when full", () => {
    const cache = new TTLCache(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("overwriting a key does not evict anything", () => {
    const cache = new TTLCache(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("b", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(3);
  });

  test("delete and clear", () => {
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.delete("a")).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

test("clearAllCaches empties every named cache", () => {
  metadataCache.set("m", 1);
  searchCache.set("s", 1);
  keyCooldown.set("k", 1);
  clearAllCaches();
  expect(metadataCache.size + searchCache.size + keyCooldown.size).toBe(0);
});
