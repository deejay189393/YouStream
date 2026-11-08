const { readHostConfig, describeCache, parseDuration, redactUrl, hostConfig, MAX_YOUTUBE_DATA_MS } = require("../src/hostConfig");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

describe("readHostConfig", () => {
  test("with nothing set: memory, and the documented lifetimes", () => {
    expect(readHostConfig({})).toEqual({
      profiles: {
        enabled: false,
        databaseUrl: null,
        secret: null,
        sessions: { rememberedMs: 30 * DAY, maxMs: 90 * DAY, browserMs: DAY },
        pruneAfterMs: 0
      },
      trustProxy: 1,
      cache: {
        store: "memory",
        redisUrl: null,
        databaseUrl: null,
        dir: ".cache",
        prefix: "youstream",
        memoryBytes: 64 * MB,
        fileBytes: 512 * MB,
        databaseBytes: 512 * MB,
        searchMs: DAY,
        recentSearchMs: 3 * HOUR,
        recentDays: 30,
        metadataMs: 3 * DAY,
        staleMs: 7 * DAY,
        adminToken: null
      },
      streams: { maxAgeSeconds: 6 * 3600, emptyMaxAgeSeconds: 3600, failedMaxAgeSeconds: 60 },
      legal: { blockedVideos: [], blockedChannels: [], contact: "https://github.com/deejay189393/YouStream/issues" },
      metadata: { imdbDatasets: true, animeDataset: true, tvdbKey: null, tvdbPin: null },
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
    expect(unknown.warnings).toEqual(['CACHE_STORE="memcached" is not one of memory, redis, file, database; using redis']);
    const noUrl = readHostConfig({ CACHE_STORE: "redis" });
    expect(noUrl.cache.store).toBe("memory");
    expect(noUrl.warnings).toEqual(["CACHE_STORE=redis needs REDIS_URL; using memory"]);
  });

  test("the database store uses DATABASE_URL, the profiles' database", () => {
    const both = readHostConfig({ CACHE_STORE: "Database", DATABASE_URL: " postgres://u:pw@postgres.railway.internal:5432/railway " });
    expect(both.cache).toMatchObject({ store: "database", databaseUrl: "postgres://u:pw@postgres.railway.internal:5432/railway" });
    expect(both.cache.databaseUrl).toBe(both.profiles.databaseUrl);
    expect(readHostConfig({ DATABASE_URL: "sqlite:///data/y.db" }).cache.store).toBe("memory");
  });

  test("without a usable DATABASE_URL, the database store falls back, with a warning", () => {
    const none = readHostConfig({ CACHE_STORE: "database", REDIS_URL: "redis://x" });
    expect(none.cache).toMatchObject({ store: "redis", databaseUrl: null });
    expect(none.warnings).toEqual(["CACHE_STORE=database needs a usable DATABASE_URL; using redis"]);
    const wrong = readHostConfig({ CACHE_STORE: "database", DATABASE_URL: "mysql://h/db" });
    expect(wrong.cache).toMatchObject({ store: "memory", databaseUrl: null });
    expect(wrong.warnings).toEqual([
      "CACHE_STORE=database needs a usable DATABASE_URL; using memory",
      "DATABASE_URL must start with sqlite: or postgres:, not mysql:; profiles are off"
    ]);
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
    expect(readHostConfig({ CACHE_MEMORY_MB: "128", CACHE_FILE_MB: "2048", CACHE_DATABASE_MB: "256" }).cache).toMatchObject({
      memoryBytes: 128 * MB,
      fileBytes: 2048 * MB,
      databaseBytes: 256 * MB
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
    expect(readHostConfig({ ANIME_DATASET: " Off " }).metadata.animeDataset).toBe(false);
    expect(readHostConfig({ ANIME_DATASET: "on" }).metadata.animeDataset).toBe(true);
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

  test("profiles: on with a usable DATABASE_URL and SECRET_KEY", () => {
    const secret = "ab".repeat(32);
    const sqlite = readHostConfig({ DATABASE_URL: " sqlite:///data/youstream.db ", SECRET_KEY: ` ${secret.toUpperCase()} ` });
    expect(sqlite.profiles).toEqual({
      enabled: true,
      databaseUrl: "sqlite:///data/youstream.db",
      secret: Buffer.from(secret, "hex"),
      sessions: { rememberedMs: 30 * DAY, maxMs: 90 * DAY, browserMs: DAY },
      pruneAfterMs: 0
    });
    expect(sqlite.warnings).toEqual([]);
    const pg = readHostConfig({ DATABASE_URL: "postgres://u:p@db.internal:5432/youstream", SECRET_KEY: secret });
    expect(pg.profiles.enabled).toBe(true);
  });

  test("profiles: off, with a warning, when either half is missing or wrong", () => {
    const secret = "ab".repeat(32);
    const off = (env) => {
      const c = readHostConfig(env);
      return [c.profiles.enabled, c.warnings];
    };
    expect(off({ DATABASE_URL: "sqlite:///data/y.db" })).toEqual([false, ["Profiles need SECRET_KEY as well as DATABASE_URL; profiles are off"]]);
    expect(off({ SECRET_KEY: secret })).toEqual([false, ["Profiles need DATABASE_URL as well as SECRET_KEY; profiles are off"]]);
    expect(off({ DATABASE_URL: "mysql://h/db", SECRET_KEY: secret })).toEqual([
      false,
      ["DATABASE_URL must start with sqlite: or postgres:, not mysql:; profiles are off"]
    ]);
    expect(off({ DATABASE_URL: "sqlite:///data/y.db", SECRET_KEY: "not-hex" })).toEqual([
      false,
      ["SECRET_KEY must be 64 hexadecimal characters (32 bytes), such as openssl rand -hex 32 prints; profiles are off"]
    ]);
    expect(off({ DATABASE_URL: "   ", SECRET_KEY: "  " })).toEqual([false, []]);
  });

  test("profiles: how long sign-ins last, never capped below their own length, and pruning", () => {
    const c = readHostConfig({ PROFILE_SESSION_TTL: "7d", PROFILE_SESSION_MAX_TTL: "1d", PROFILE_PRUNE_AFTER: "365d" });
    expect(c.profiles.sessions).toEqual({ rememberedMs: 7 * DAY, maxMs: 7 * DAY, browserMs: DAY });
    expect(c.profiles.pruneAfterMs).toBe(365 * DAY);
    expect(readHostConfig({ PROFILE_PRUNE_AFTER: "off" }).profiles.pruneAfterMs).toBe(0);
    const bad = readHostConfig({ PROFILE_PRUNE_AFTER: "soon", PROFILE_SESSION_TTL: "a while" });
    expect(bad.profiles.pruneAfterMs).toBe(0);
    expect(bad.profiles.sessions.rememberedMs).toBe(30 * DAY);
    expect(bad.warnings).toEqual([
      'PROFILE_SESSION_TTL="a while" is not a duration such as 90s, 15m, 6h or 7d; using 30d',
      'PROFILE_PRUNE_AFTER="soon" is not a duration such as 365d; profiles are never pruned'
    ]);
  });

  test("TRUST_PROXY: a number of proxies, or none", () => {
    expect(readHostConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(readHostConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(readHostConfig({ TRUST_PROXY: "0" }).trustProxy).toBe(false);
    const bad = readHostConfig({ TRUST_PROXY: "everyone" });
    expect(bad.trustProxy).toBe(1);
    expect(bad.warnings).toEqual(['TRUST_PROXY="everyone" is not a number of proxies or false; using 1']);
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

  test("the database by where it is, never its password", () => {
    const postgres = readHostConfig({ CACHE_STORE: "database", DATABASE_URL: "postgres://u:pw@db.internal:5432/railway" }).cache;
    expect(describeCache(postgres)).toMatch(/^database PostgreSQL db\.internal:5432\/railway \(512 MB\), prefix "youstream": /);
    expect(describeCache(postgres)).not.toContain("pw");
    const sqlite = readHostConfig({ CACHE_STORE: "database", DATABASE_URL: "sqlite:///data/y.db", CACHE_DATABASE_MB: "64" }).cache;
    expect(describeCache(sqlite)).toMatch(/^database SQLite \/data\/y\.db \(64 MB\), /);
  });
});
