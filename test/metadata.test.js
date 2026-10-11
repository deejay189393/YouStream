const { clearAllCaches, metadataCache } = require("../src/cache");
const { getJson, yearOf, runtimeSeconds } = require("../src/metadata/http");
const cinemeta = require("../src/metadata/cinemeta");
const tmdb = require("../src/metadata/tmdb");
const kitsu = require("../src/metadata/kitsu");
const { resolveTitle, uniqueAliases } = require("../src/metadata");
const { parseStreamId } = require("../src/ids");
const { response, routeFetch } = require("./helpers");

beforeEach(() => {
  clearAllCaches();
  jest.restoreAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

// --- Fixtures, trimmed from real responses ----------------------------------

const CINEMETA_MOVIE = {
  meta: { name: "The Shawshank Redemption", year: "1994", runtime: "142 min", moviedb_id: 278 }
};

const CINEMETA_SERIES = {
  meta: {
    name: "TVF Pitchers",
    year: "2015–2022",
    runtime: "51 min",
    moviedb_id: 63180,
    videos: [
      { season: 0, episode: 1, name: "Special" },
      { season: 1, episode: 1, name: "Tu Beer Hai" },
      { season: 1, episode: 2, name: "And Then There Were Four" },
      { season: 1, episode: 3, name: "The Jury Room" },
      { season: 2, number: 1, title: "The Valley" },
      { season: 2, episode: 2, name: "Second" },
      null
    ]
  }
};

const TMDB_MOVIE = {
  title: "The Shawshank Redemption",
  original_title: "The Shawshank Redemption",
  release_date: "1994-09-23",
  runtime: 142,
  alternative_titles: {
    titles: [
      { iso_3166_1: "US", title: "Shawshank" },
      { iso_3166_1: "IN", title: "Shawshank Redemption" },
      { iso_3166_1: "FR", title: "Les Évadés" },
      { iso_3166_1: "US", title: " " },
      null
    ]
  },
  external_ids: { imdb_id: "tt0111161" }
};

const TMDB_SHOW = {
  name: "Pitchers",
  original_name: "TVF Pitchers",
  first_air_date: "2015-06-03",
  episode_run_time: [45],
  seasons: [
    { season_number: 0, episode_count: 2 },
    { season_number: 1, episode_count: 5 },
    { season_number: 2, episode_count: 5 },
    { season_number: "x" }
  ],
  alternative_titles: { results: [{ iso_3166_1: "IN", title: "TVF Pitchers" }] },
  external_ids: { imdb_id: "tt4742876" }
};

const TMDB_SEASON = {
  episodes: [
    { episode_number: 1, name: "Tu Beer Hai", runtime: 41 },
    { episode_number: 3, name: "The Jury Room", runtime: 38 }
  ]
};

const KITSU_ANIME = {
  data: {
    attributes: {
      canonicalTitle: "SPY×FAMILY",
      titles: { en: "SPY x FAMILY", en_jp: "SPY×FAMILY", ja_jp: "SPY×FAMILY" },
      abbreviatedTitles: ["SxF"],
      startDate: "2022-04-09",
      episodeLength: 24,
      subtype: "TV"
    }
  }
};

const KITSU_EPISODE = {
  data: [{ attributes: { number: 3, canonicalTitle: "PREPARE FOR THE INTERVIEW", length: 23 } }]
};

// --- http ------------------------------------------------------------------

describe("getJson", () => {
  test("returns the body and caches it under the given key", async () => {
    const fetch = routeFetch([["example.com", { a: 1 }]]);
    expect(await getJson("https://example.com/x?key=secret", { cacheKey: "x" })).toEqual({ a: 1 });
    expect(await getJson("https://example.com/x?key=secret", { cacheKey: "x" })).toEqual({ a: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metadataCache.get("x")).toEqual({ body: { a: 1 } });
  });

  test("caches a 404 as null", async () => {
    const fetch = routeFetch([]);
    expect(await getJson("https://example.com/missing")).toBeNull();
    expect(await getJson("https://example.com/missing")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("throws, without caching, on an error status", async () => {
    routeFetch([["example.com", response({}, { status: 503 })]]);
    await expect(getJson("https://example.com/x")).rejects.toMatchObject({ status: 503 });
    expect(metadataCache.size).toBe(0);
  });

  test("throws on a body that is not JSON", async () => {
    routeFetch([["example.com", response(null, { json: false })]]);
    await expect(getJson("https://example.com/x")).rejects.toMatchObject({ status: 200 });
  });

  test("throws a 502 when the service cannot be reached", async () => {
    routeFetch([["example.com", new Error("ECONNRESET")]]);
    await expect(getJson("https://example.com/x")).rejects.toMatchObject({
      status: 502,
      message: "Could not reach example.com: ECONNRESET"
    });
  });

  test("sends the headers it is given", async () => {
    const fetch = routeFetch([["example.com", {}]]);
    await getJson("https://example.com/x", { headers: { authorization: "Bearer t" } });
    expect(fetch.mock.calls[0][1].headers).toEqual({ authorization: "Bearer t" });
  });
});

describe("yearOf and runtimeSeconds", () => {
  test.each([
    ["1994", 1994],
    ["2015–2022", 2015],
    ["2022-04-09", 2022],
    [1994, 1994],
    [null, null],
    ["unknown", null]
  ])("yearOf(%p)", (raw, year) => {
    expect(yearOf(raw)).toBe(year);
  });

  test.each([
    ["142 min", 8520],
    ["2h 22min", 8520],
    ["1h", 3600],
    ["45m", 2700],
    ["90", 5400],
    [" 90.5 ", 5430],
    [142, 8520],
    [0, null],
    [-5, null],
    [NaN, null],
    ["", null],
    ["N/A", null],
    ["0 min", null],
    [undefined, null]
  ])("runtimeSeconds(%p)", (raw, seconds) => {
    expect(runtimeSeconds(raw)).toBe(seconds);
  });
});

// --- Cinemeta --------------------------------------------------------------

describe("cinemeta", () => {
  test("reads a film", async () => {
    routeFetch([["/meta/movie/tt0111161.json", CINEMETA_MOVIE]]);
    expect(await cinemeta.movie("tt0111161")).toEqual({
      title: "The Shawshank Redemption",
      year: 1994,
      runtimeSeconds: 8520,
      tmdbId: "278"
    });
  });

  test("falls back from year to releaseInfo, and goes without a TMDB id", async () => {
    routeFetch([["/meta/movie/", { meta: { name: "X", releaseInfo: "2001" } }]]);
    expect(await cinemeta.movie("tt1")).toEqual({ title: "X", year: 2001, runtimeSeconds: null, tmdbId: null });
  });

  test("a missing or nameless title is null", async () => {
    routeFetch([["tt2", { meta: { name: "" } }], ["tt3", { nothing: true }]]);
    expect(await cinemeta.movie("tt1")).toBeNull();
    expect(await cinemeta.movie("tt2")).toBeNull();
    expect(await cinemeta.movie("tt3")).toBeNull();
  });

  test("reads an episode, its name and its number across the show", async () => {
    routeFetch([["/meta/series/tt4742876.json", CINEMETA_SERIES]]);
    expect(await cinemeta.episode("tt4742876", 2, 1)).toEqual({
      title: "TVF Pitchers",
      year: 2015,
      typicalRuntimeSeconds: 3060,
      episodeTitle: "The Valley",
      absoluteEpisode: 4,
      seasonCount: 2,
      tmdbId: "63180"
    });
  });

  test("an episode it does not list still resolves the show", async () => {
    routeFetch([["/meta/series/", { meta: { name: "Show", videos: "nope" } }]]);
    expect(await cinemeta.episode("tt9", 1, 9)).toEqual({
      title: "Show",
      year: null,
      typicalRuntimeSeconds: null,
      episodeTitle: null,
      absoluteEpisode: 9,
      seasonCount: null,
      tmdbId: null
    });
  });

  test("an unnamed episode has no title", async () => {
    routeFetch([["/meta/series/", { meta: { name: "Show", videos: [{ season: 1, episode: 1, name: 5 }] } }]]);
    expect((await cinemeta.episode("tt9", 1, 1)).episodeTitle).toBeNull();
  });

  test("a missing show is null", async () => {
    routeFetch([]);
    expect(await cinemeta.episode("tt9", 1, 1)).toBeNull();
  });

  test("specials have no absolute number", () => {
    expect(cinemeta.absoluteEpisode(CINEMETA_SERIES.meta.videos.filter(Boolean), 0, 1)).toBeNull();
  });
});

// --- TMDB ------------------------------------------------------------------

describe("tmdb", () => {
  test("a v3 key goes in the query string, and the cache key leaves it out", async () => {
    const fetch = routeFetch([["/movie/278", TMDB_MOVIE]]);
    await tmdb.movie("v3key", "278", "");
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get("api_key")).toBe("v3key");
    expect(fetch.mock.calls[0][1].headers.authorization).toBeUndefined();
    expect([...metadataCache.store.keys()].join()).not.toContain("v3key");
  });

  test("a v4 read access token goes in a bearer header", async () => {
    const fetch = routeFetch([["/movie/278", TMDB_MOVIE]]);
    await tmdb.movie("eyJtoken", "278", "");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("api_key")).toBeNull();
    expect(fetch.mock.calls[0][1].headers.authorization).toBe("Bearer eyJtoken");
  });

  test("reads a film with its other names, the reader's country first", async () => {
    routeFetch([["/movie/278", TMDB_MOVIE]]);
    expect(await tmdb.movie("k", "278", "IN")).toEqual({
      title: "The Shawshank Redemption",
      originalTitle: "The Shawshank Redemption",
      year: 1994,
      runtimeSeconds: 8520,
      aliases: ["Shawshank Redemption", "Shawshank"],
      imdbId: "tt0111161"
    });
  });

  test("a film without the optional parts", async () => {
    routeFetch([["/movie/1", { title: "Bare", original_title: 5 }]]);
    expect(await tmdb.movie("k", "1", "")).toEqual({
      title: "Bare",
      originalTitle: null,
      year: null,
      runtimeSeconds: null,
      aliases: [],
      imdbId: null
    });
  });

  test("a missing or untitled film is null", async () => {
    routeFetch([["/movie/2", { title: "" }]]);
    expect(await tmdb.movie("k", "1", "")).toBeNull();
    expect(await tmdb.movie("k", "2", "")).toBeNull();
  });

  test("finds by IMDb id", async () => {
    routeFetch([
      ["/find/tt0111161", { movie_results: [{ id: 278 }], tv_results: [] }],
      ["/find/tt4742876", { movie_results: [{ id: "x" }], tv_results: [{ id: 63180 }] }]
    ]);
    expect(await tmdb.findByImdb("k", "tt0111161")).toEqual({ movieId: "278", tvId: null });
    expect(await tmdb.findByImdb("k", "tt4742876")).toEqual({ movieId: null, tvId: "63180" });
    expect(await tmdb.findByImdb("k", "tt0000001")).toEqual({ movieId: null, tvId: null });
  });

  test("reads a show", async () => {
    routeFetch([["/tv/63180?", TMDB_SHOW]]);
    expect(await tmdb.show("k", "63180", "")).toEqual({
      title: "Pitchers",
      originalTitle: "TVF Pitchers",
      year: 2015,
      typicalRuntimeSeconds: 2700,
      aliases: [],
      seasons: [
        { season: 0, episodes: 2 },
        { season: 1, episodes: 5 },
        { season: 2, episodes: 5 }
      ],
      imdbId: "tt4742876"
    });
  });

  test("a show without the optional parts", async () => {
    routeFetch([["/tv/1?", { name: "Bare" }]]);
    expect(await tmdb.show("k", "1", "IN")).toEqual({
      title: "Bare",
      originalTitle: null,
      year: null,
      typicalRuntimeSeconds: null,
      aliases: [],
      seasons: [],
      imdbId: null
    });
  });

  test("a missing show is null", async () => {
    routeFetch([]);
    expect(await tmdb.show("k", "1", "")).toBeNull();
  });

  test("reads one episode from its season", async () => {
    routeFetch([["/tv/63180/season/1", TMDB_SEASON]]);
    expect(await tmdb.episode("k", "63180", 1, 3)).toEqual({ episodeTitle: "The Jury Room", runtimeSeconds: 2280 });
    expect(await tmdb.episode("k", "63180", 1, 2)).toBeNull();
  });

  test("an episode with no name, or a season with no list", async () => {
    routeFetch([
      ["/season/1", { episodes: [{ episode_number: 1, name: "" }] }],
      ["/season/2", {}]
    ]);
    expect(await tmdb.episode("k", "9", 1, 1)).toEqual({ episodeTitle: null, runtimeSeconds: null });
    expect(await tmdb.episode("k", "9", 2, 1)).toBeNull();
  });

  test("absolute numbering skips specials", () => {
    const seasons = [
      { season: 0, episodes: 2 },
      { season: 1, episodes: 5 },
      { season: 2, episodes: 5 }
    ];
    expect(tmdb.absoluteEpisode(seasons, 2, 1)).toBe(6);
    expect(tmdb.absoluteEpisode(seasons, 0, 1)).toBeNull();
  });

  test("aliasesFrom is safe on anything", () => {
    expect(tmdb.aliasesFrom(undefined, "IN")).toEqual([]);
  });

  test("aliases are capped", () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ iso_3166_1: "US", title: `Name ${i}` }));
    expect(tmdb.aliasesFrom(list, "")).toHaveLength(8);
  });

  describe("checkKey", () => {
    test("ok", async () => {
      const fetch = routeFetch([["/configuration", {}]]);
      expect(await tmdb.checkKey("k")).toBe("ok");
      expect(new URL(fetch.mock.calls[0][0]).searchParams.get("api_key")).toBe("k");
    });

    test("a bearer token goes in the header", async () => {
      const fetch = routeFetch([["/configuration", {}]]);
      expect(await tmdb.checkKey("eyJx")).toBe("ok");
      expect(fetch.mock.calls[0][1].headers.authorization).toBe("Bearer eyJx");
    });

    test("invalid", async () => {
      routeFetch([["/configuration", response({}, { status: 401 })]]);
      expect(await tmdb.checkKey("k")).toBe("invalid");
    });

    test("unreachable, on an outage or a network failure", async () => {
      routeFetch([["/configuration", response({}, { status: 500 })]]);
      expect(await tmdb.checkKey("k")).toBe("unreachable");
      routeFetch([["/configuration", new Error("down")]]);
      expect(await tmdb.checkKey("k")).toBe("unreachable");
    });
  });
});

// --- Kitsu -----------------------------------------------------------------

describe("kitsu", () => {
  test("reads an anime, English name first", async () => {
    routeFetch([["/anime/45398", KITSU_ANIME]]);
    expect(await kitsu.anime("45398")).toEqual({
      title: "SPY x FAMILY",
      aliases: ["SPY×FAMILY", "SxF"],
      year: 2022,
      typicalRuntimeSeconds: 1440,
      isMovie: false
    });
  });

  test("without an English name, the first name it has", async () => {
    routeFetch([["/anime/1", { data: { attributes: { canonicalTitle: "Kimi no Na wa.", subtype: "movie" } } }]]);
    expect(await kitsu.anime("1")).toMatchObject({ title: "Kimi no Na wa.", aliases: [], isMovie: true });
  });

  test("an entry with no names, or no entry, is null", async () => {
    routeFetch([
      ["/anime/2", { data: { attributes: { titles: "x" } } }],
      ["/anime/3", { data: "x" }]
    ]);
    expect(await kitsu.anime("2")).toBeNull();
    expect(await kitsu.anime("3")).toBeNull();
    expect(await kitsu.anime("4")).toBeNull();
  });

  test("reads an episode", async () => {
    const fetch = routeFetch([["/episodes", KITSU_EPISODE]]);
    expect(await kitsu.episode("45398", 3)).toEqual({ episodeTitle: "PREPARE FOR THE INTERVIEW", runtimeSeconds: 1380 });
    expect(fetch.mock.calls[0][0]).toContain("filter%5Bnumber%5D=3");
  });

  test("an unnamed episode, or one it does not have", async () => {
    routeFetch([
      ["/anime/1/episodes", { data: [{ attributes: { number: 1, canonicalTitle: " " } }, null] }],
      ["/anime/2/episodes", { data: "x" }]
    ]);
    expect(await kitsu.episode("1", 1)).toEqual({ episodeTitle: null, runtimeSeconds: null });
    expect(await kitsu.episode("1", 2)).toBeNull();
    expect(await kitsu.episode("2", 1)).toBeNull();
  });

  test("namesOf is safe without titles", () => {
    expect(kitsu.namesOf({ canonicalTitle: "A", abbreviatedTitles: "x" })).toEqual(["A"]);
  });
});

// --- Resolution ------------------------------------------------------------

describe("resolveTitle", () => {
  const resolve = (id, options) => resolveTitle(parseStreamId(id), options);

  test("an IMDb film from Cinemeta alone", async () => {
    routeFetch([["/meta/movie/tt0111161.json", CINEMETA_MOVIE]]);
    expect(await resolve("tt0111161")).toEqual({
      isEpisode: false,
      title: "The Shawshank Redemption",
      aliases: [],
      year: 1994,
      runtimeSeconds: 8520,
      runtimeKind: "exact",
      sources: ["cinemeta"]
    });
  });

  test("an IMDb film with TMDB's other names, by the id Cinemeta gave", async () => {
    const fetch = routeFetch([
      ["/meta/movie/tt0111161.json", CINEMETA_MOVIE],
      ["/movie/278", TMDB_MOVIE]
    ]);
    const title = await resolve("tt0111161", { tmdbKey: "k", region: "IN" });
    expect(title.aliases).toEqual(["Shawshank Redemption", "Shawshank"]);
    expect(title.sources).toEqual(["cinemeta", "tmdb"]);
    expect(fetch.mock.calls.some(([url]) => url.includes("/find/"))).toBe(false);
  });

  test("an IMDb film Cinemeta cannot answer for comes from TMDB, found by IMDb id", async () => {
    routeFetch([
      ["/meta/movie/", response({}, { status: 500 })],
      ["/find/tt0111161", { movie_results: [{ id: 278 }] }],
      ["/movie/278", TMDB_MOVIE]
    ]);
    const title = await resolve("tt0111161", { tmdbKey: "k" });
    expect(title).toMatchObject({ title: "The Shawshank Redemption", year: 1994, runtimeSeconds: 8520, sources: ["tmdb"] });
    expect(console.warn).toHaveBeenCalled();
  });

  test("an IMDb film nobody knows is null", async () => {
    routeFetch([["/find/", { movie_results: [] }]]);
    expect(await resolve("tt0000001", { tmdbKey: "k" })).toBeNull();
    expect(await resolve("tt0000001")).toBeNull();
  });

  test("a TMDB lookup that fails leaves Cinemeta's answer standing", async () => {
    routeFetch([
      ["/meta/movie/", { meta: { name: "No TMDB id", year: "2000", runtime: "100 min" } }],
      ["/find/", new Error("down")]
    ]);
    expect(await resolve("tt1234567", { tmdbKey: "k" })).toMatchObject({ title: "No TMDB id", sources: ["cinemeta"] });
  });

  test("an IMDb film with no runtime anywhere", async () => {
    routeFetch([["/meta/movie/", { meta: { name: "Untimed" } }]]);
    expect(await resolve("tt1234567")).toMatchObject({ runtimeSeconds: null, runtimeKind: null, year: null });
  });

  test("an IMDb episode from Cinemeta alone has only the typical length", async () => {
    routeFetch([["/meta/series/tt4742876.json", CINEMETA_SERIES]]);
    expect(await resolve("tt4742876:1:3")).toEqual({
      isEpisode: true,
      title: "TVF Pitchers",
      aliases: [],
      year: 2015,
      runtimeSeconds: 3060,
      runtimeKind: "typical",
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "The Jury Room",
      seasonCount: 2,
      sources: ["cinemeta"]
    });
  });

  test("with TMDB, the episode's own length", async () => {
    routeFetch([
      ["/meta/series/tt4742876.json", CINEMETA_SERIES],
      ["/tv/63180/season/1", TMDB_SEASON],
      ["/tv/63180?", TMDB_SHOW]
    ]);
    const title = await resolve("tt4742876:1:3", { tmdbKey: "k" });
    expect(title).toMatchObject({ runtimeSeconds: 2280, runtimeKind: "exact", aliases: ["Pitchers"], sources: ["cinemeta", "tmdb"] });
  });

  test("an IMDb episode Cinemeta cannot answer for comes from TMDB", async () => {
    routeFetch([
      ["/meta/series/", response({}, { status: 500 })],
      ["/find/tt4742876", { tv_results: [{ id: 63180 }] }],
      ["/tv/63180/season/2", { episodes: [] }],
      ["/tv/63180?", TMDB_SHOW]
    ]);
    expect(await resolve("tt4742876:2:1", { tmdbKey: "k" })).toEqual({
      isEpisode: true,
      title: "Pitchers",
      aliases: ["TVF Pitchers"],
      year: 2015,
      runtimeSeconds: 2700,
      runtimeKind: "typical",
      season: 2,
      episode: 1,
      absoluteEpisode: 6,
      episodeTitle: null,
      seasonCount: 2,
      sources: ["tmdb"]
    });
  });

  test("what Cinemeta lacks for an episode, TMDB fills in", async () => {
    routeFetch([
      ["/meta/series/tt4742876.json", { meta: { name: "TVF Pitchers", moviedb_id: 63180, videos: [] } }],
      ["/tv/63180/season/1", TMDB_SEASON],
      ["/tv/63180?", TMDB_SHOW]
    ]);
    expect(await resolve("tt4742876:1:3", { tmdbKey: "k" })).toMatchObject({
      episodeTitle: "The Jury Room",
      seasonCount: 2,
      absoluteEpisode: 3
    });
  });

  test("a TMDB show with no seasons listed", async () => {
    routeFetch([
      ["/meta/series/", response({}, { status: 500 })],
      ["/find/", { tv_results: [{ id: 5 }] }],
      ["/tv/5?", { name: "Bare" }]
    ]);
    expect(await resolve("tt1234567:1:1", { tmdbKey: "k" })).toMatchObject({
      title: "Bare",
      absoluteEpisode: null,
      seasonCount: null,
      runtimeKind: null
    });
  });

  test("an IMDb episode nobody knows is null", async () => {
    routeFetch([["/find/", { tv_results: [] }]]);
    expect(await resolve("tt1234567:1:1", { tmdbKey: "k" })).toBeNull();
    expect(await resolve("tt1234567:1:1")).toBeNull();
  });

  test("tmdb: ids need a TMDB key", async () => {
    const fetch = routeFetch([]);
    expect(await resolve("tmdb:278")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a tmdb: film", async () => {
    routeFetch([["/movie/278", TMDB_MOVIE]]);
    expect(await resolve("tmdb:278", { tmdbKey: "k", region: "IN" })).toEqual({
      isEpisode: false,
      title: "The Shawshank Redemption",
      aliases: ["Shawshank Redemption", "Shawshank"],
      year: 1994,
      runtimeSeconds: 8520,
      runtimeKind: "exact",
      sources: ["tmdb"]
    });
  });

  test("a tmdb: film with no runtime borrows IMDb's through Cinemeta", async () => {
    routeFetch([
      ["/movie/278", { ...TMDB_MOVIE, runtime: 0 }],
      ["/meta/movie/tt0111161.json", CINEMETA_MOVIE]
    ]);
    expect(await resolve("tmdb:278", { tmdbKey: "k" })).toMatchObject({ runtimeSeconds: 8520, sources: ["tmdb", "cinemeta"] });
  });

  test("a tmdb: film with no runtime and no IMDb id", async () => {
    routeFetch([["/movie/9", { title: "Short" }]]);
    expect(await resolve("tmdb:9", { tmdbKey: "k" })).toMatchObject({ runtimeSeconds: null, sources: ["tmdb"] });
  });

  test("a missing tmdb: film is null", async () => {
    routeFetch([]);
    expect(await resolve("tmdb:9", { tmdbKey: "k" })).toBeNull();
  });

  test("a tmdb: episode", async () => {
    routeFetch([
      ["/tv/63180/season/1", TMDB_SEASON],
      ["/tv/63180?", TMDB_SHOW]
    ]);
    expect(await resolve("tmdb:63180:1:3", { tmdbKey: "k" })).toEqual({
      isEpisode: true,
      title: "Pitchers",
      aliases: ["TVF Pitchers"],
      year: 2015,
      runtimeSeconds: 2280,
      runtimeKind: "exact",
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "The Jury Room",
      seasonCount: 2,
      sources: ["tmdb"]
    });
  });

  test("a tmdb: episode TMDB does not list falls back to the show's length", async () => {
    routeFetch([
      ["/tv/5/season/", new Error("down")],
      ["/tv/5?", { name: "Bare", episode_run_time: [30] }]
    ]);
    expect(await resolve("tmdb:5:1:1", { tmdbKey: "k" })).toMatchObject({
      runtimeSeconds: 1800,
      runtimeKind: "typical",
      episodeTitle: null,
      seasonCount: null
    });
  });

  test("a missing tmdb: show is null", async () => {
    routeFetch([]);
    expect(await resolve("tmdb:5:1:1", { tmdbKey: "k" })).toBeNull();
  });

  test("a Kitsu episode, with its own length", async () => {
    routeFetch([
      ["/anime/45398/episodes", KITSU_EPISODE],
      ["/anime/45398", KITSU_ANIME]
    ]);
    expect(await resolve("kitsu:45398:3")).toEqual({
      isEpisode: true,
      title: "SPY x FAMILY",
      aliases: ["SPY×FAMILY", "SxF"],
      year: 2022,
      runtimeSeconds: 1380,
      runtimeKind: "exact",
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "PREPARE FOR THE INTERVIEW",
      seasonCount: 1,
      sources: ["kitsu"]
    });
  });

  test("a Kitsu episode Kitsu does not list keeps the usual length", async () => {
    routeFetch([["/anime/45398", KITSU_ANIME]]);
    expect(await resolve("kitsu:45398:30")).toMatchObject({ runtimeSeconds: 1440, runtimeKind: "typical", episodeTitle: null });
  });

  test("a Kitsu film's episode length is its length", async () => {
    routeFetch([["/anime/1", { data: { attributes: { canonicalTitle: "Your Name", episodeLength: 106, subtype: "movie" } } }]]);
    expect(await resolve("kitsu:1")).toEqual({
      isEpisode: false,
      title: "Your Name",
      aliases: [],
      year: null,
      runtimeSeconds: 6360,
      runtimeKind: "exact",
      sources: ["kitsu"]
    });
  });

  test("a missing Kitsu entry is null", async () => {
    routeFetch([]);
    expect(await resolve("kitsu:1:1")).toBeNull();
  });
});

describe("uniqueAliases", () => {
  test("drops the title itself, blanks, repeats and non-strings, case-insensitively", () => {
    expect(uniqueAliases("Pitchers", ["pitchers", " TVF Pitchers ", "tvf pitchers", "", null, 5, "Other"])).toEqual([
      "TVF Pitchers",
      "Other"
    ]);
  });
});
