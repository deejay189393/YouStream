const { readHostConfig, describeCache, parseDuration, redactUrl, hostConfig, MAX_YOUTUBE_DATA_MS } = require("../src/hostConfig");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

describe("readHostConfig", () => {
  test("with nothing set: memory, and the documented lifetimes", () => {
    expect(readHostConfig({})).toEqual({
      cache: {
        store: "memory",
        redisUrl: null,
        dir: ".cache",
        prefix: "youstream",
        memoryBytes: 64 * MB,
        fileBytes: 512 * MB,
        searchMs: DAY,
        recentSearchMs: 3 * HOUR,
        recentDays: 30,
        metadataMs: 3 * DAY,
        staleMs: 7 * DAY,
        adminToken: null
      },
      streams: { maxAgeSeconds: 6 * 3600, emptyMaxAgeSeconds: 3600, failedMaxAgeSeconds: 60 },
      legal: { blockedVideos: [], blockedChannels: [], contact: "https://github.com/deejay189393/YouStream/issues" },
      metadata: { imdbDatasets: true, tvdbKey: null, tvdbPin: null },
      warnings: []
    });
  });

  test("REDIS_URL alone is enough to use Redis", () => {
    expect(readHostConfig({ REDIS_URL: " redis://default:pw@redis.railway.internal:6379 " }).cache).toMatchObject({
      store: "redis",
      redisUrl: "redis://default:pw@redis.railway.internal:6379"
    });
  });

  test("CACHE_STORE picks the store, whatever the case", () => {
    expect(readHostConfig({ CACHE_STORE: "FILE", CACHE_DIR: " /data/cache " }).cache).toMatchObject({ store: "file", dir: "/data/cache" });
    expect(readHostConfig({ CACHE_STORE: "memory", REDIS_URL: "redis://x" }).cache.store).toBe("memory");
  });

  test("a store it cannot use falls back, with a warning", () => {
    const unknown = readHostConfig({ CACHE_STORE: "memcached", REDIS_URL: "redis://x" });
    expect(unknown.cache.store).toBe("redis");
    expect(unknown.warnings).toEqual(['CACHE_STORE="memcached" is not one of memory, redis, file; using redis']);
    const noUrl = readHostConfig({ CACHE_STORE: "redis" });
    expect(noUrl.cache.store).toBe("memory");
    expect(noUrl.warnings).toEqual(["CACHE_STORE=redis needs REDIS_URL; using memory"]);
  });

  test("lifetimes, in any unit", () => {
    const { cache, streams } = readHostConfig({
      CACHE_SEARCH_TTL: "12h",
      CACHE_SEARCH_RECENT_TTL: "90m",
      CACHE_METADATA_TTL: "86400",
      CACHE_STALE_TTL: "1.5d",
      CACHE_RECENT_DAYS: "14",
      STREAM_CACHE_MAX_AGE: "2h",
      STREAM_CACHE_MAX_AGE_EMPTY: "0"
    });
    expect(cache).toMatchObject({ searchMs: 12 * HOUR, recentSearchMs: 90 * MINUTE, metadataMs: DAY, staleMs: 36 * HOUR, recentDays: 14 });
    expect(streams).toMatchObject({ maxAgeSeconds: 7200, emptyMaxAgeSeconds: 0 });
  });

  test("a lifetime it cannot read falls back to the default, with a warning", () => {
    const { cache, warnings } = readHostConfig({ CACHE_SEARCH_TTL: "a day", CACHE_STALE_TTL: "-1d" });
    expect(cache).toMatchObject({ searchMs: DAY, staleMs: 7 * DAY });
    expect(warnings).toEqual([
      'CACHE_SEARCH_TTL="a day" is not a duration such as 90s, 15m, 6h or 7d; using 24h',
      'CACHE_STALE_TTL="-1d" is not a duration such as 90s, 15m, 6h or 7d; using 7d'
    ]);
  });

  test("YouTube data is never current for more than 30 days", () => {
    const { cache, warnings } = readHostConfig({ CACHE_SEARCH_TTL: "60d", CACHE_SEARCH_RECENT_TTL: "31d" });
    expect(cache.searchMs).toBe(MAX_YOUTUBE_DATA_MS);
    expect(cache.recentSearchMs).toBe(MAX_YOUTUBE_DATA_MS);
    expect(warnings).toEqual([
      "CACHE_SEARCH_TTL is capped at 30 days, the most YouTube's API policies allow",
      "CACHE_SEARCH_RECENT_TTL is capped at 30 days, the most YouTube's API policies allow"
    ]);
  });

  test("sizes and counts", () => {
    expect(readHostConfig({ CACHE_MEMORY_MB: "128", CACHE_FILE_MB: "2048" }).cache).toMatchObject({
      memoryBytes: 128 * MB,
      fileBytes: 2048 * MB
    });
    const bad = readHostConfig({ CACHE_MEMORY_MB: "lots", CACHE_RECENT_DAYS: "0" });
    expect(bad.cache).toMatchObject({ memoryBytes: 64 * MB, recentDays: 30 });
    expect(bad.warnings).toEqual([
      'CACHE_MEMORY_MB="lots" is not a positive number; using 64',
      'CACHE_RECENT_DAYS="0" is not a positive number; using 30'
    ]);
  });

  test("the prefix, lower-cased, from a safe alphabet", () => {
    expect(readHostConfig({ CACHE_PREFIX: " YouStream-Beta " }).cache.prefix).toBe("youstream-beta");
    const bad = readHostConfig({ CACHE_PREFIX: "you stream:*" });
    expect(bad.cache.prefix).toBe("youstream");
    expect(bad.warnings).toEqual(['CACHE_PREFIX="you stream:*" may only use letters, digits, - and _; using youstream']);
  });

  test("the admin token, and blanks read as unset", () => {
    expect(readHostConfig({ CACHE_ADMIN_TOKEN: " t0ken " }).cache.adminToken).toBe("t0ken");
    expect(readHostConfig({ CACHE_ADMIN_TOKEN: "  ", REDIS_URL: "", CACHE_DIR: " " }).cache).toMatchObject({
      adminToken: null,
      store: "memory",
      dir: ".cache"
    });
  });

  test("metadata sources: IMDb's data unless turned off, TheTVDB with a key", () => {
    expect(readHostConfig({ IMDB_DATASETS: "OFF" }).metadata.imdbDatasets).toBe(false);
    expect(readHostConfig({ IMDB_DATASETS: "0" }).metadata.imdbDatasets).toBe(false);
    expect(readHostConfig({ IMDB_DATASETS: "on" }).metadata.imdbDatasets).toBe(true);
    expect(readHostConfig({ TVDB_API_KEY: " key ", TVDB_PIN: " 1234 " }).metadata).toMatchObject({ tvdbKey: "key", tvdbPin: "1234" });
  });

  test("videos and channels a rights holder asked to be blocked, by id or link", () => {
    const { legal, warnings } = readHostConfig({
      BLOCKED_VIDEOS:
        "dQw4w9WgXcQ, https://www.youtube.com/watch?v=abcdefghijk&t=3 https://youtu.be/ABCDEFGHIJK?si=x https://www.youtube.com/shorts/s0rt5_vid-0 dQw4w9WgXcQ nope",
      BLOCKED_CHANNELS: "UC1234567890123456789012 https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos @handle"
    });
    expect(legal.blockedVideos).toEqual(["dQw4w9WgXcQ", "abcdefghijk", "ABCDEFGHIJK", "s0rt5_vid-0"]);
    expect(legal.blockedChannels).toEqual(["UC1234567890123456789012", "UCabcdefghijklmnopqrstuv"]);
    expect(warnings).toEqual([
      'BLOCKED_VIDEOS: "nope" is not a YouTube video id or link; ignored',
      'BLOCKED_CHANNELS: "@handle" is not a YouTube channel id (UC...) or channel link; ignored'
    ]);
  });

  test("a contact for questions and removal requests", () => {
    expect(readHostConfig({ CONTACT: " rights@example.com " }).legal.contact).toBe("rights@example.com");
  });

  test("reads the process environment by default", () => {
    expect(hostConfig).toEqual(readHostConfig(process.env));
  });
});

describe("parseDuration", () => {
  test.each([
    ["90", 90000],
    [90, 90000],
    ["90s", 90000],
    ["15m", 15 * MINUTE],
    ["6H", 6 * HOUR],
    ["7d", 7 * DAY],
    ["0.5h", 30 * MINUTE],
    ["0", 0],
    ["", null],
    ["1w", null],
    ["-5m", null]
  ])("%p", (raw, ms) => {
    expect(parseDuration(raw)).toBe(ms);
  });
});

describe("redactUrl", () => {
  test("masks a password and keeps the rest", () => {
    expect(redactUrl("redis://default:hunter2@redis.railway.internal:6379")).toBe("redis://default:***@redis.railway.internal:6379");
    expect(redactUrl("redis://localhost:6379")).toBe("redis://localhost:6379");
    expect(redactUrl("not a url")).toBe("(unreadable URL)");
  });
});

describe("describeCache", () => {
  test("memory, with the lifetimes in their largest whole unit", () => {
    expect(describeCache(readHostConfig({}).cache)).toBe(
      'memory (64 MB), prefix "youstream": searches 1d (3h for releases of the last 30 days), metadata 3d, kept 7d more for outages'
    );
  });

  test("Redis without its password, a file store, and lifetimes that are off or odd", () => {
    const redis = readHostConfig({
      REDIS_URL: "redis://u:pw@host:6379",
      CACHE_ADMIN_TOKEN: "secret",
      CACHE_STALE_TTL: "0",
      CACHE_METADATA_TTL: "0"
    }).cache;
    expect(describeCache(redis)).toBe(
      'redis redis://u:***@host:6379, prefix "youstream": searches 1d (3h for releases of the last 30 days), metadata off, nothing kept for outages, admin endpoint on'
    );
    expect(describeCache(redis)).not.toContain("secret");
    const file = readHostConfig({ CACHE_STORE: "file", CACHE_DIR: "/data", CACHE_SEARCH_TTL: "1.5" }).cache;
    expect(describeCache(file)).toMatch(/^file \/data \(512 MB\), prefix "youstream": searches 1\.5s /);
  });
});
