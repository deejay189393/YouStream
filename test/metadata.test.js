const { metadataCache } = require("../src/cache");
const { getJson, postJson, yearOf, dateOf, runtimeSeconds } = require("../src/metadata/http");
const cinemeta = require("../src/metadata/cinemeta");
const tmdb = require("../src/metadata/tmdb");
const kitsu = require("../src/metadata/kitsu");
const anilist = require("../src/metadata/anilist");
const animeDb = require("../src/metadata/animeDb");
const tvmaze = require("../src/metadata/tvmaze");
const { resolveTitle, uniqueAliases, shortNames } = require("../src/metadata");
const imdb = require("../src/metadata/imdb");
const tvdbClient = require("../src/metadata/tvdb");
const { hostConfig } = require("../src/hostConfig");
const { parseStreamId } = require("../src/ids");
const { response, routeFetch, freshCache, TEST_CACHE } = require("./helpers");

beforeEach(() => {
  freshCache();
  jest.restoreAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

// --- Fixtures, trimmed from real responses ----------------------------------

const CINEMETA_MOVIE = {
  meta: {
    name: "The Shawshank Redemption",
    year: "1994",
    released: "1994-10-14T00:00:00.000Z",
    runtime: "142 min",
    moviedb_id: 278,
    cast: ["Tim Robbins", "Morgan Freeman", " ", 5],
    director: ["Frank Darabont"]
  }
};

const CINEMETA_SERIES = {
  meta: {
    name: "TVF Pitchers",
    year: "2015–2022",
    runtime: "51 min",
    moviedb_id: 63180,
    tvdb_id: 297358,
    cast: ["Naveen Kasturia", "Arunabh Kumar"],
    videos: [
      { season: 0, episode: 1, name: "Special" },
      { season: 1, episode: 1, name: "Tu Beer Hai" },
      { season: 1, episode: 2, name: "And Then There Were Four" },
      { season: 1, episode: 3, name: "The Jury Room", released: "2015-07-20T00:00:00.000Z", tvdb_id: 5245433 },
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
  external_ids: { imdb_id: "tt0111161" },
  credits: {
    cast: [{ name: "Tim Robbins" }, { name: "Morgan Freeman" }, { name: "Bob Gunton" }, null],
    crew: [{ name: "Frank Darabont", job: "Director" }, { name: "Roger Deakins", job: "Director of Photography" }, null]
  }
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
  external_ids: { imdb_id: "tt4742876" },
  credits: { cast: [{ name: "Naveen Kasturia" }, { name: "Jitendra Kumar" }] }
};

const TMDB_SEASON = {
  episodes: [
    { episode_number: 1, name: "Tu Beer Hai", runtime: 41, air_date: "2015-06-03" },
    { episode_number: 3, name: "The Jury Room", runtime: 38, air_date: "2015-07-20" },
    null
  ]
};

/** A season whose every episode lists the same runtime: the slot, not the episode. */
const TMDB_UNIFORM_SEASON = {
  episodes: [
    { episode_number: 1, name: "One", runtime: 60 },
    { episode_number: 2, name: "Two", runtime: 60 }
  ]
};

const TVMAZE_SHOW = { id: 7329, name: "TVF Pitchers" };
const TVMAZE_EPISODES = [
  { season: 1, number: 1, runtime: 45 },
  { season: 1, number: 2, runtime: 45 },
  { season: 1, number: 3, runtime: 45 },
  { season: 2, number: 1, runtime: 60 },
  { season: 2, number: 2, runtime: 64 },
  null
];

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
  data: [{ attributes: { number: 3, canonicalTitle: "PREPARE FOR THE INTERVIEW", length: 23, airdate: "2022-04-23" } }]
};

const ANILIST_MEDIA = {
  data: {
    Media: {
      id: 140960,
      idMal: 50265,
      format: "TV",
      episodes: 12,
      duration: 24,
      title: { english: "SPY x FAMILY", romaji: "SPY×FAMILY", native: "SPY×FAMILY" },
      synonyms: ["SxF", "Spy Family", "间谍过家家", " "],
      startDate: { year: 2022, month: 4, day: 9 }
    }
  }
};

// --- http ------------------------------------------------------------------

describe("postJson", () => {
  test("posts the JSON asked, and keeps the answer under the key given", async () => {
    const fetch = routeFetch([["example.com", { data: 1 }]]);
    expect(await postJson("https://example.com/graphql", { query: "q" }, { cacheKey: "g" })).toEqual({ data: 1 });
    expect(await postJson("https://example.com/graphql", { query: "q" }, { cacheKey: "g" })).toEqual({ data: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({ method: "POST", body: '{"query":"q"}', headers: { "Content-Type": "application/json" } });
  });

  test("a 404 is null, kept like any answer; a failure throws, unkept", async () => {
    routeFetch([]);
    expect(await postJson("https://example.com/graphql", {}, { cacheKey: "missing" })).toBeNull();
    routeFetch([["example.com", response({}, { status: 429 })]]);
    await expect(postJson("https://example.com/graphql", {}, { cacheKey: "busy" })).rejects.toMatchObject({ status: 429 });
    expect(await metadataCache.get("busy")).toBeUndefined();
  });
});

describe("getJson", () => {
  test("returns the body and caches it under the given key", async () => {
    const fetch = routeFetch([["example.com", { a: 1 }]]);
    expect(await getJson("https://example.com/x?key=secret", { cacheKey: "x" })).toEqual({ a: 1 });
    expect(await getJson("https://example.com/x?key=secret", { cacheKey: "x" })).toEqual({ a: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await metadataCache.get("x")).toEqual({ value: { body: { a: 1 } }, fresh: true });
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
    expect(await metadataCache.count()).toBe(0);
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

  describe("past an answer's lifetime", () => {
    let up;
    let fetch;
    let clock;
    beforeEach(async () => {
      const start = Date.now();
      clock = jest.spyOn(Date, "now").mockReturnValue(start);
      up = true;
      let version = 0;
      fetch = routeFetch([["example.com", () => (up ? { version: ++version } : response({}, { status: 503 }))]]);
      await getJson("https://example.com/x");
      clock.mockReturnValue(start + TEST_CACHE.metadataMs + 1);
    });

    test("the service is asked again", async () => {
      expect(await getJson("https://example.com/x")).toEqual({ version: 2 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("the old answer stands in while the service is down", async () => {
      up = false;
      expect(await getJson("https://example.com/x")).toEqual({ version: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("and once the extra time is over too, a failure is a failure", async () => {
      up = false;
      clock.mockReturnValue(Date.now() + TEST_CACHE.staleMs);
      await expect(getJson("https://example.com/x")).rejects.toMatchObject({ status: 503 });
    });
  });
});

describe("dateOf", () => {
  test.each([
    ["2015-07-20", "2015-07-20"],
    ["2015-07-20T00:00:00.000Z", "2015-07-20"],
    ["2015", null],
    [20150720, null],
    [null, null]
  ])("dateOf(%p)", (raw, date) => {
    expect(dateOf(raw)).toBe(date);
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
  test("reads a film, with its credits", async () => {
    routeFetch([["/meta/movie/tt0111161.json", CINEMETA_MOVIE]]);
    expect(await cinemeta.movie("tt0111161")).toEqual({
      title: "The Shawshank Redemption",
      people: ["Tim Robbins", "Morgan Freeman", "Frank Darabont"],
      year: 1994,
      released: "1994-10-14",
      runtimeSeconds: 8520,
      tmdbId: "278"
    });
  });

  test("falls back from year to releaseInfo, and goes without a TMDB id or credits", async () => {
    routeFetch([["/meta/movie/", { meta: { name: "X", releaseInfo: "2001", cast: "nope" } }]]);
    expect(await cinemeta.movie("tt1")).toEqual({ title: "X", people: [], year: 2001, released: null, runtimeSeconds: null, tmdbId: null });
  });

  test("a missing or nameless title is null", async () => {
    routeFetch([["tt2", { meta: { name: "" } }], ["tt3", { nothing: true }]]);
    expect(await cinemeta.movie("tt1")).toBeNull();
    expect(await cinemeta.movie("tt2")).toBeNull();
    expect(await cinemeta.movie("tt3")).toBeNull();
  });

  test("reads an episode, its name, its air date and its number across the show", async () => {
    routeFetch([["/meta/series/tt4742876.json", CINEMETA_SERIES]]);
    expect(await cinemeta.episode("tt4742876", 1, 3)).toEqual({
      title: "TVF Pitchers",
      people: ["Naveen Kasturia", "Arunabh Kumar"],
      year: 2015,
      typicalRuntimeSeconds: 3060,
      episodeTitle: "The Jury Room",
      released: "2015-07-20",
      absoluteEpisode: 3,
      seasonCount: 2,
      tmdbId: "63180",
      tvdbId: "297358",
      tvdbEpisodeId: "5245433"
    });
    expect(await cinemeta.episode("tt4742876", 2, 1)).toMatchObject({
      episodeTitle: "The Valley",
      absoluteEpisode: 4,
      released: null,
      tvdbEpisodeId: null
    });
  });

  test("an episode it does not list still resolves the show", async () => {
    routeFetch([["/meta/series/", { meta: { name: "Show", videos: "nope" } }]]);
    expect(await cinemeta.episode("tt9", 1, 9)).toEqual({
      title: "Show",
      people: [],
      year: null,
      typicalRuntimeSeconds: null,
      episodeTitle: null,
      released: null,
      absoluteEpisode: 9,
      seasonCount: null,
      tmdbId: null,
      tvdbId: null,
      tvdbEpisodeId: null
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
    expect(url.searchParams.get("append_to_response")).toBe("alternative_titles,external_ids,credits");
    expect(fetch.mock.calls[0][1].headers.authorization).toBeUndefined();
    // Cached by the URL without the key, so a reader with another key shares it.
    await tmdb.movie("otherkey", "278", "");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a v4 read access token goes in a bearer header", async () => {
    const fetch = routeFetch([["/movie/278", TMDB_MOVIE]]);
    await tmdb.movie("eyJtoken", "278", "");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("api_key")).toBeNull();
    expect(fetch.mock.calls[0][1].headers.authorization).toBe("Bearer eyJtoken");
  });

  test("reads a film with its other names, the reader's country first, and its credits", async () => {
    routeFetch([["/movie/278", TMDB_MOVIE]]);
    expect(await tmdb.movie("k", "278", "IN")).toEqual({
      title: "The Shawshank Redemption",
      originalTitle: "The Shawshank Redemption",
      year: 1994,
      released: "1994-09-23",
      runtimeSeconds: 8520,
      aliases: ["Shawshank Redemption", "Shawshank"],
      people: ["Tim Robbins", "Morgan Freeman", "Bob Gunton", "Frank Darabont"],
      imdbId: "tt0111161"
    });
  });

  test("a film without the optional parts", async () => {
    routeFetch([["/movie/1", { title: "Bare", original_title: 5 }]]);
    expect(await tmdb.movie("k", "1", "")).toEqual({
      title: "Bare",
      originalTitle: null,
      year: null,
      released: null,
      runtimeSeconds: null,
      aliases: [],
      people: [],
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
      people: ["Naveen Kasturia", "Jitendra Kumar"],
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
      people: [],
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
    expect(await tmdb.episode("k", "63180", 1, 3)).toEqual({ episodeTitle: "The Jury Room", released: "2015-07-20", runtimeSeconds: 2280 });
    expect(await tmdb.episode("k", "63180", 1, 2)).toBeNull();
  });

  test("a runtime copied onto every episode of the season is dropped", async () => {
    routeFetch([["/season/1", TMDB_UNIFORM_SEASON]]);
    expect(await tmdb.episode("k", "9", 1, 1)).toEqual({ episodeTitle: "One", released: null, runtimeSeconds: null });
  });

  test("an episode with no name, or a season with no list", async () => {
    routeFetch([
      ["/season/1", { episodes: [{ episode_number: 1, name: "" }] }],
      ["/season/2", {}]
    ]);
    expect(await tmdb.episode("k", "9", 1, 1)).toEqual({ episodeTitle: null, released: null, runtimeSeconds: null });
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

  test("credits keep eight billed cast members and the directors", () => {
    const cast = Array.from({ length: 12 }, (_, i) => ({ name: `Actor ${i}` }));
    expect(tmdb.peopleOf({ credits: { cast, crew: "x" } })).toHaveLength(8);
    expect(tmdb.peopleOf(null)).toEqual([]);
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

// --- TVmaze ----------------------------------------------------------------

describe("tvmaze", () => {
  test("an episode's own runtime, where its season's runtimes vary", async () => {
    const fetch = routeFetch([
      ["/lookup/shows?imdb=tt4742876", TVMAZE_SHOW],
      ["/shows/7329/episodes", TVMAZE_EPISODES]
    ]);
    expect(await tvmaze.episodeRuntime("tt4742876", 2, 2)).toBe(3840);
    expect(fetch.mock.calls[0][0]).toBe("https://api.tvmaze.com/lookup/shows?imdb=tt4742876");
  });

  test("nothing where every episode of the season lists the same runtime: that is the slot", async () => {
    routeFetch([
      ["/lookup/shows", TVMAZE_SHOW],
      ["/episodes", TVMAZE_EPISODES]
    ]);
    expect(await tvmaze.episodeRuntime("tt4742876", 1, 3)).toBeNull();
  });

  test("nothing for an episode, a show or an episode list it does not have", async () => {
    routeFetch([
      ["/lookup/shows?imdb=tt1", TVMAZE_SHOW],
      ["/shows/7329/episodes", "nope"],
      ["/lookup/shows?imdb=tt2", { id: "x" }]
    ]);
    expect(await tvmaze.episodeRuntime("tt1", 2, 9)).toBeNull();
    expect(await tvmaze.episodeRuntime("tt2", 1, 1)).toBeNull();
    expect(await tvmaze.episodeRuntime("tt3", 1, 1)).toBeNull();
  });

  test("variesWithinSeason ignores missing runtimes", () => {
    expect(tvmaze.variesWithinSeason([{ runtime: 30 }, { runtime: null }, { runtime: 0 }])).toBe(false);
    expect(tvmaze.variesWithinSeason([{ runtime: 30 }, { runtime: 31 }])).toBe(true);
  });
});

// --- Kitsu -----------------------------------------------------------------

describe("kitsu", () => {
  test("reads an anime, English name first", async () => {
    routeFetch([["/anime/45398", KITSU_ANIME]]);
    expect(await kitsu.anime("45398")).toEqual({
      title: "SPY x FAMILY",
      english: "SPY x FAMILY",
      aliases: ["SPY×FAMILY", "SxF"],
      year: 2022,
      released: "2022-04-09",
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
    expect(await kitsu.episode("45398", 3)).toEqual({ episodeTitle: "PREPARE FOR THE INTERVIEW", released: "2022-04-23", runtimeSeconds: 1380 });
    expect(fetch.mock.calls[0][0]).toContain("filter%5Bnumber%5D=3");
  });

  test("an unnamed episode, or one it does not have", async () => {
    routeFetch([
      ["/anime/1/episodes", { data: [{ attributes: { number: 1, canonicalTitle: " " } }, null] }],
      ["/anime/2/episodes", { data: "x" }]
    ]);
    expect(await kitsu.episode("1", 1)).toEqual({ episodeTitle: null, released: null, runtimeSeconds: null });
    expect(await kitsu.episode("1", 2)).toBeNull();
    expect(await kitsu.episode("2", 1)).toBeNull();
  });

  test("namesOf is safe without titles", () => {
    expect(kitsu.namesOf({ canonicalTitle: "A", abbreviatedTitles: "x" })).toEqual(["A"]);
  });
});

// --- Resolution ------------------------------------------------------------

describe("anilist", () => {
  test("an anime by AniList's id, English name first, with its MyAnimeList id", async () => {
    const fetch = routeFetch([["graphql.anilist.co", ANILIST_MEDIA]]);
    expect(await anilist.anime({ anilist: 140960 })).toEqual({
      title: "SPY x FAMILY",
      english: "SPY x FAMILY",
      aliases: ["SPY×FAMILY", "SxF", "Spy Family", "间谍过家家"],
      year: 2022,
      released: "2022-04-09",
      typicalRuntimeSeconds: 1440,
      isMovie: false,
      ids: { anilist: 140960, mal: 50265 }
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(anilist.BASE_URL);
    expect(JSON.parse(init.body)).toEqual({ query: anilist.QUERY, variables: { id: 140960 } });
  });

  test("or by MyAnimeList's", async () => {
    const fetch = routeFetch([["graphql.anilist.co", ANILIST_MEDIA]]);
    expect((await anilist.anime({ mal: "50265" })).title).toBe("SPY x FAMILY");
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables).toEqual({ idMal: 50265 });
  });

  test("without an English name, its romanised one; a film is a film; a date not whole is no date", async () => {
    routeFetch([
      [
        "graphql.anilist.co",
        { data: { Media: { id: 21519, format: "MOVIE", title: { romaji: "Kimi no Na wa." }, startDate: { year: 2016 } } } }
      ]
    ]);
    expect(await anilist.anime({ anilist: 21519 })).toEqual({
      title: "Kimi no Na wa.",
      english: null,
      aliases: [],
      year: 2016,
      released: null,
      typicalRuntimeSeconds: null,
      isMovie: true,
      ids: { anilist: 21519, mal: null }
    });
  });

  test("whatever of it AniList leaves out: its title, its other names, its date, its ids", async () => {
    routeFetch([["graphql.anilist.co", { data: { Media: { synonyms: ["Only A Synonym"] } } }]]);
    expect(await anilist.anime({ anilist: 5 })).toEqual({
      title: "Only A Synonym",
      english: null,
      aliases: [],
      year: null,
      released: null,
      typicalRuntimeSeconds: null,
      isMovie: false,
      ids: { anilist: null, mal: null }
    });
  });

  test("null for an anime AniList does not have, or one without a name", async () => {
    routeFetch([["graphql.anilist.co", response({ errors: [{ status: 404 }], data: { Media: null } }, { status: 404 })]]);
    expect(await anilist.anime({ anilist: 1 })).toBeNull();
    freshCache();
    routeFetch([["graphql.anilist.co", { data: { Media: { id: 2, title: {} } } }]]);
    expect(await anilist.anime({ anilist: 2 })).toBeNull();
    freshCache();
    routeFetch([["graphql.anilist.co", { data: {} }]]);
    expect(await anilist.anime({ mal: 3 })).toBeNull();
  });
});

describe("resolveTitle", () => {
  const resolve = (id, options) => resolveTitle(parseStreamId(id), options);

  test("an IMDb film from Cinemeta alone", async () => {
    routeFetch([["/meta/movie/tt0111161.json", CINEMETA_MOVIE]]);
    expect(await resolve("tt0111161")).toEqual({
      isEpisode: false,
      title: "The Shawshank Redemption",
      aliases: [],
      year: 1994,
      released: "1994-10-14",
      people: ["Tim Robbins", "Morgan Freeman", "Frank Darabont"],
      imdbId: "tt0111161",
      runtimeSeconds: 8520,
      runtimeKind: "exact",
      otherRuntimes: [],
      sources: ["cinemeta"]
    });
  });

  test("an IMDb film with TMDB's other names, credits and differing runtime, by the id Cinemeta gave", async () => {
    const fetch = routeFetch([
      ["/meta/movie/tt0111161.json", CINEMETA_MOVIE],
      ["/movie/278", { ...TMDB_MOVIE, runtime: 144 }]
    ]);
    const title = await resolve("tt0111161", { tmdbKey: "k", region: "IN" });
    expect(title.aliases).toEqual(["Shawshank Redemption", "Shawshank"]);
    expect(title.people).toEqual(["Tim Robbins", "Morgan Freeman", "Frank Darabont", "Bob Gunton"]);
    expect(title.runtimeSeconds).toBe(8520);
    expect(title.otherRuntimes).toEqual([8640]);
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
    expect(title).toMatchObject({ title: "The Shawshank Redemption", year: 1994, runtimeSeconds: 8520, otherRuntimes: [], sources: ["tmdb"] });
    expect(console.warn).toHaveBeenCalled();
  });

  test("an IMDb film nobody knows is null", async () => {
    routeFetch([["/find/", { movie_results: [] }]]);
    expect(await resolve("tt0000001", { tmdbKey: "k" })).toBeNull();
    expect(await resolve("tt0000001")).toBeNull();
  });

  test("an IMDb film Cinemeta cannot answer for, with no TMDB key, is a failed lookup, not an unknown title", async () => {
    routeFetch([["/meta/movie/", response({}, { status: 500 })]]);
    await expect(resolve("tt0111161")).rejects.toMatchObject({
      kind: "unavailable",
      message: "no title, as Cinemeta movie tt0111161 failed"
    });
  });

  test("so is one neither Cinemeta nor TMDB could be asked about, naming both", async () => {
    routeFetch([
      ["/meta/movie/", new Error("timed out")],
      ["/find/", response({}, { status: 503 })]
    ]);
    await expect(resolve("tt0111161", { tmdbKey: "k" })).rejects.toMatchObject({
      kind: "unavailable",
      message: "no title, as Cinemeta movie tt0111161, TMDB find tt0111161 failed"
    });
  });

  test("and one Cinemeta does not list while TMDB, which might, is down", async () => {
    routeFetch([["/find/", new Error("down")]]);
    await expect(resolve("tt0111161", { tmdbKey: "k" })).rejects.toMatchObject({ kind: "unavailable" });
  });

  test("lookups running at once each count only their own failures", async () => {
    routeFetch([
      ["/meta/movie/tt0000500.json", response({}, { status: 500 })],
      ["/meta/movie/tt0111161.json", CINEMETA_MOVIE]
    ]);
    const [down, missing, known] = await Promise.allSettled([resolve("tt0000500"), resolve("tt0000404"), resolve("tt0111161")]);
    expect(down).toMatchObject({ status: "rejected", reason: { message: "no title, as Cinemeta movie tt0000500 failed" } });
    expect(missing).toEqual({ status: "fulfilled", value: null });
    expect(known).toMatchObject({ status: "fulfilled", value: { title: "The Shawshank Redemption" } });
  });

  test("a TMDB lookup that fails leaves Cinemeta's answer standing", async () => {
    routeFetch([
      ["/meta/movie/", { meta: { name: "No TMDB id", year: "2000", runtime: "100 min" } }],
      ["/find/", new Error("down")]
    ]);
    expect(await resolve("tt1234567", { tmdbKey: "k" })).toMatchObject({ title: "No TMDB id", sources: ["cinemeta"] });
  });

  describe("with IMDb's own data loaded", () => {
    const HEADER = "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres";
    beforeEach(async () => {
      async function* lines() {
        yield HEADER;
        yield ["tt0111161", "movie", "The Shawshank Redemption", "x", "0", "1994", "\\N", "144", "Drama"].join("\t");
      }
      imdb.useIndex(await imdb.buildIndex(lines()));
    });
    afterEach(() => imdb.useIndex(null));

    test("a film is matched on IMDb's runtime, with Cinemeta's alongside where it differs", async () => {
      routeFetch([["/meta/movie/tt0111161.json", CINEMETA_MOVIE]]);
      expect(await resolve("tt0111161")).toMatchObject({ runtimeSeconds: 8640, otherRuntimes: [8520], sources: ["imdb", "cinemeta"] });
    });

    test("and IMDb's runtime is enough when Cinemeta has none", async () => {
      routeFetch([["/meta/movie/tt0111161.json", { meta: { ...CINEMETA_MOVIE.meta, runtime: undefined } }]]);
      expect(await resolve("tt0111161")).toMatchObject({ runtimeSeconds: 8640, otherRuntimes: [], runtimeKind: "exact" });
    });

    test("a tmdb: film too, through the IMDb id TMDB gives", async () => {
      routeFetch([
        ["/movie/278", TMDB_MOVIE],
        ["/meta/movie/tt0111161.json", CINEMETA_MOVIE]
      ]);
      expect(await resolve("tmdb:278", { tmdbKey: "k" })).toMatchObject({
        runtimeSeconds: 8640,
        otherRuntimes: [8520],
        sources: ["tmdb", "imdb", "cinemeta"]
      });
    });
  });

  test("an IMDb film with no runtime anywhere", async () => {
    routeFetch([["/meta/movie/", { meta: { name: "Untimed" } }]]);
    expect(await resolve("tt1234567")).toMatchObject({ runtimeSeconds: null, runtimeKind: null, year: null, otherRuntimes: [] });
  });

  test("a name with a subtitle also counts by its main title", async () => {
    routeFetch([["/meta/movie/", { meta: { name: "Nosferatu: A Symphony of Horror", runtime: "94 min" } }]]);
    expect((await resolve("tt0013442")).aliases).toEqual(["Nosferatu"]);
  });

  describe("with a TheTVDB key", () => {
    const TVDB_SEASON = (runtimes) => ({
      data: {
        episodes: [
          { id: 5245431, seasonNumber: 1, number: 1, runtime: runtimes[0], aired: "2015-06-03" },
          { id: 5245433, seasonNumber: 1, number: 3, runtime: runtimes[1], aired: "2015-07-21", absoluteNumber: 3, name: "Jury" }
        ]
      }
    });
    const LOGIN = [/thetvdb\.com\/v4\/login$/, { data: { token: "t" } }];
    beforeEach(() => {
      hostConfig.metadata.tvdbKey = "k";
      tvdbClient.resetSession();
    });
    afterEach(() => {
      hostConfig.metadata.tvdbKey = null;
    });

    test("an episode's own runtime from TheTVDB, for the very episode Cinemeta lists", async () => {
      const fetch = routeFetch([
        ["/meta/series/tt4742876.json", CINEMETA_SERIES],
        LOGIN,
        ["/series/297358/episodes/default?page=0&season=1", TVDB_SEASON([41, 38])]
      ]);
      expect(await resolve("tt4742876:1:3")).toMatchObject({
        runtimeSeconds: 2280,
        runtimeKind: "exact",
        otherRuntimes: [],
        episodeTitle: "The Jury Room",
        released: "2015-07-20",
        sources: ["cinemeta", "tvdb"]
      });
      expect(fetch.mock.calls.some(([url]) => url.includes("/episodes/5245433"))).toBe(false);
    });

    test("TMDB's own runtime counts alongside where the two differ", async () => {
      routeFetch([
        ["/meta/series/tt4742876.json", CINEMETA_SERIES],
        LOGIN,
        ["/series/297358/episodes/default", TVDB_SEASON([41, 40])],
        ["/tv/63180/season/1", TMDB_SEASON],
        ["/tv/63180?", TMDB_SHOW]
      ]);
      expect(await resolve("tt4742876:1:3", { tmdbKey: "k" })).toMatchObject({
        runtimeSeconds: 2400,
        otherRuntimes: [2280],
        sources: ["cinemeta", "tvdb", "tmdb"]
      });
    });

    test("a runtime TheTVDB copies onto the whole season is the usual length, after Cinemeta's", async () => {
      routeFetch([["/meta/series/tt4742876.json", CINEMETA_SERIES], LOGIN, ["/series/297358/", TVDB_SEASON([60, 60])]]);
      expect(await resolve("tt4742876:1:3")).toMatchObject({ runtimeSeconds: 3060, runtimeKind: "typical" });
      freshCache();
      routeFetch([
        ["/meta/series/tt4742876.json", { meta: { ...CINEMETA_SERIES.meta, runtime: undefined } }],
        LOGIN,
        ["/series/297358/", TVDB_SEASON([60, 60])]
      ]);
      expect(await resolve("tt4742876:1:3")).toMatchObject({ runtimeSeconds: 3600, runtimeKind: "typical" });
    });

    test("an episode beyond the season's first page, by its own id", async () => {
      routeFetch([
        ["/meta/series/tt4742876.json", CINEMETA_SERIES],
        LOGIN,
        ["/series/297358/", { data: { episodes: [] } }],
        ["/episodes/5245433", { data: { id: 5245433, runtime: 38, absoluteNumber: 3 } }]
      ]);
      expect(await resolve("tt4742876:1:3")).toMatchObject({ runtimeSeconds: 3060, runtimeKind: "typical", absoluteEpisode: 3 });
    });

    test("what TheTVDB fills in when Cinemeta has no date or name for the episode", async () => {
      const bare = { meta: { name: "Show", tvdb_id: 9, videos: [{ season: 1, episode: 3, tvdb_id: 5245433 }] } };
      routeFetch([["/meta/series/tt9000009.json", bare], LOGIN, ["/series/9/", TVDB_SEASON([41, 38])]]);
      expect(await resolve("tt9000009:1:3")).toMatchObject({ released: "2015-07-21", episodeTitle: "Jury" });
    });

    test("without TheTVDB ids, or with TheTVDB down, the other sources stand", async () => {
      routeFetch([["/meta/series/", { meta: { name: "Show", videos: [] } }]]);
      expect(await resolve("tt9000009:1:1")).toMatchObject({ sources: ["cinemeta"] });
      routeFetch([["/meta/series/tt4742876.json", CINEMETA_SERIES], [/\/login$/, response({}, { status: 401 })]]);
      expect(await resolve("tt4742876:1:3")).toMatchObject({ runtimeSeconds: 3060, sources: ["cinemeta"] });
      const onlyEpisodeId = { meta: { name: "Show", videos: [{ season: 1, episode: 1, tvdb_id: 77 }] } };
      routeFetch([["/meta/series/tt8000008.json", onlyEpisodeId], LOGIN, ["/episodes/77", { data: { id: 77, runtime: 22 } }]]);
      expect(await resolve("tt8000008:1:1")).toMatchObject({ runtimeSeconds: 1320, runtimeKind: "typical", sources: ["cinemeta", "tvdb"] });
    });

    test("Cinemeta down, TheTVDB is not asked, and with nothing else to answer, the lookup has failed", async () => {
      const fetch = routeFetch([["/meta/series/", response({}, { status: 500 })]]);
      await expect(resolve("tt4742876:1:3")).rejects.toMatchObject({
        kind: "unavailable",
        message: expect.stringContaining("Cinemeta series tt4742876")
      });
      expect(fetch.mock.calls.some(([url]) => url.includes("thetvdb"))).toBe(false);
    });
  });

  test("an IMDb episode from Cinemeta alone has only the typical length", async () => {
    routeFetch([["/meta/series/tt4742876.json", CINEMETA_SERIES]]);
    expect(await resolve("tt4742876:1:3")).toEqual({
      isEpisode: true,
      title: "TVF Pitchers",
      aliases: [],
      year: 2015,
      people: ["Naveen Kasturia", "Arunabh Kumar"],
      imdbId: "tt4742876",
      runtimeSeconds: 3060,
      runtimeKind: "typical",
      otherRuntimes: [],
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "The Jury Room",
      released: "2015-07-20",
      releaseYear: 2015,
      seasonCount: 2,
      sources: ["cinemeta"]
    });
  });

  test("TVmaze, keyless, gives the episode's own length where its season's lengths vary", async () => {
    routeFetch([
      ["/meta/series/tt4742876.json", CINEMETA_SERIES],
      ["/lookup/shows?imdb=tt4742876", TVMAZE_SHOW],
      ["/shows/7329/episodes", TVMAZE_EPISODES]
    ]);
    expect(await resolve("tt4742876:2:1")).toMatchObject({ runtimeSeconds: 3600, runtimeKind: "exact", sources: ["cinemeta", "tvmaze"] });
    expect(await resolve("tt4742876:1:3")).toMatchObject({ runtimeSeconds: 3060, runtimeKind: "typical", sources: ["cinemeta"] });
  });

  test("with TMDB, the episode's own length, merged credits and other names", async () => {
    routeFetch([
      ["/meta/series/tt4742876.json", CINEMETA_SERIES],
      ["/tv/63180/season/1", TMDB_SEASON],
      ["/tv/63180?", TMDB_SHOW]
    ]);
    const title = await resolve("tt4742876:1:3", { tmdbKey: "k" });
    expect(title).toMatchObject({
      runtimeSeconds: 2280,
      runtimeKind: "exact",
      aliases: ["Pitchers"],
      people: ["Naveen Kasturia", "Arunabh Kumar", "Jitendra Kumar"],
      sources: ["cinemeta", "tmdb"]
    });
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
      people: ["Naveen Kasturia", "Jitendra Kumar"],
      imdbId: "tt4742876",
      runtimeSeconds: 2700,
      runtimeKind: "typical",
      otherRuntimes: [],
      season: 2,
      episode: 1,
      absoluteEpisode: 6,
      episodeTitle: null,
      released: null,
      releaseYear: null,
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
      releaseYear: 2015,
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

  test("a tmdb: film, with IMDb's runtime and credits alongside", async () => {
    routeFetch([
      ["/movie/278", { ...TMDB_MOVIE, runtime: 144 }],
      ["/meta/movie/tt0111161.json", CINEMETA_MOVIE]
    ]);
    expect(await resolve("tmdb:278", { tmdbKey: "k", region: "IN" })).toEqual({
      isEpisode: false,
      title: "The Shawshank Redemption",
      aliases: ["Shawshank Redemption", "Shawshank"],
      year: 1994,
      released: "1994-09-23",
      people: ["Tim Robbins", "Morgan Freeman", "Bob Gunton", "Frank Darabont"],
      imdbId: "tt0111161",
      runtimeSeconds: 8640,
      runtimeKind: "exact",
      otherRuntimes: [8520],
      sources: ["tmdb", "cinemeta"]
    });
  });

  test("a tmdb: film with no runtime or release date borrows IMDb's", async () => {
    routeFetch([
      ["/movie/278", { ...TMDB_MOVIE, runtime: 0, release_date: "" }],
      ["/meta/movie/tt0111161.json", CINEMETA_MOVIE]
    ]);
    expect(await resolve("tmdb:278", { tmdbKey: "k" })).toMatchObject({ runtimeSeconds: 8520, otherRuntimes: [], released: "1994-10-14" });
  });

  test("a tmdb: film with no runtime and no IMDb id", async () => {
    routeFetch([["/movie/9", { title: "Short" }]]);
    expect(await resolve("tmdb:9", { tmdbKey: "k" })).toMatchObject({ runtimeSeconds: null, imdbId: null, sources: ["tmdb"] });
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
      people: ["Naveen Kasturia", "Jitendra Kumar"],
      imdbId: "tt4742876",
      runtimeSeconds: 2280,
      runtimeKind: "exact",
      otherRuntimes: [],
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "The Jury Room",
      released: "2015-07-20",
      releaseYear: 2015,
      seasonCount: 2,
      sources: ["tmdb"]
    });
  });

  test("a tmdb: episode TMDB has no length for takes TVmaze's, through the show's IMDb id", async () => {
    routeFetch([
      ["/tv/63180/season/2", { episodes: [{ episode_number: 1, name: "The Valley" }] }],
      ["/tv/63180?", TMDB_SHOW],
      ["/lookup/shows?imdb=tt4742876", TVMAZE_SHOW],
      ["/shows/7329/episodes", TVMAZE_EPISODES]
    ]);
    expect(await resolve("tmdb:63180:2:1", { tmdbKey: "k" })).toMatchObject({
      runtimeSeconds: 3600,
      runtimeKind: "exact",
      sources: ["tmdb", "tvmaze"]
    });
  });

  test("a tmdb: episode with no length anywhere falls back to the show's", async () => {
    routeFetch([
      ["/tv/5/season/", new Error("down")],
      ["/tv/5?", { name: "Bare", episode_run_time: [30] }]
    ]);
    expect(await resolve("tmdb:5:1:1", { tmdbKey: "k" })).toMatchObject({
      runtimeSeconds: 1800,
      runtimeKind: "typical",
      episodeTitle: null,
      releaseYear: null,
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
      people: [],
      imdbId: null,
      otherRuntimes: [],
      runtimeSeconds: 1380,
      runtimeKind: "exact",
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "PREPARE FOR THE INTERVIEW",
      released: "2022-04-23",
      releaseYear: 2022,
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
      released: null,
      people: [],
      imdbId: null,
      otherRuntimes: [],
      runtimeSeconds: 6360,
      runtimeKind: "exact",
      sources: ["kitsu"]
    });
  });

  test("a missing Kitsu entry is null", async () => {
    routeFetch([]);
    expect(await resolve("kitsu:1:1")).toBeNull();
  });

  test("but Kitsu down is a failed lookup", async () => {
    routeFetch([["/anime/", response({}, { status: 502 })]]);
    await expect(resolve("kitsu:1:1")).rejects.toMatchObject({
      kind: "unavailable",
      message: "no title, as Kitsu anime 1, Kitsu episode 1 1 failed"
    });
  });

  test("as is TMDB down for a tmdb: show", async () => {
    routeFetch([["/tv/5", new Error("down")]]);
    await expect(resolve("tmdb:5:1:1", { tmdbKey: "k" })).rejects.toMatchObject({ kind: "unavailable" });
  });

  describe("an anime by any database's id", () => {
    // The anime database's line for it: every site's id, and the names
    // uploads use that one site or another lacks.
    const ENTRY = {
      sources: ["https://kitsu.app/anime/45398", "https://myanimelist.net/anime/50265", "https://anilist.co/anime/140960", "https://anidb.net/anime/16591"],
      title: "SPY x FAMILY",
      type: "TV",
      episodes: 12,
      animeSeason: { year: 2022 },
      duration: { value: 1440, unit: "SECONDS" },
      synonyms: ["Spy Family", "SxF", "Spy Kyoushitsu Family"]
    };
    beforeEach(async () => {
      async function* lines() {
        yield JSON.stringify(ENTRY);
      }
      animeDb.useIndex(await animeDb.buildIndex(lines()));
    });
    afterEach(() => animeDb.useIndex(null));
    const KITSU_NO_ENGLISH = { data: { attributes: { canonicalTitle: "Spy x Family", episodeLength: 24, startDate: "2022-04-09" } } };

    test("by MyAnimeList's: Kitsu and the database asked, their names gathered, Kitsu's English name searched", async () => {
      const fetch = routeFetch([
        ["/anime/45398/episodes", KITSU_EPISODE],
        ["/anime/45398", KITSU_ANIME],
        ["graphql.anilist.co", ANILIST_MEDIA]
      ]);
      expect(await resolve("mal:50265:3")).toEqual({
        isEpisode: true,
        title: "SPY x FAMILY",
        // Short names, abbreviations among them, are left out but for Kitsu's own.
        aliases: ["SPY×FAMILY", "SxF", "Spy Family", "Spy Kyoushitsu Family"],
        year: 2022,
        people: [],
        imdbId: null,
        otherRuntimes: [],
        runtimeSeconds: 1380,
        runtimeKind: "exact",
        season: 1,
        episode: 3,
        absoluteEpisode: 3,
        episodeTitle: "PREPARE FOR THE INTERVIEW",
        released: "2022-04-23",
        releaseYear: 2022,
        seasonCount: 1,
        sources: ["kitsu", "anime database"]
      });
      // With an English name from Kitsu, AniList is not asked.
      expect(fetch.mock.calls.some(([url]) => url.includes("anilist"))).toBe(false);
    });

    test("an English name searched in the short form uploads write it in", async () => {
      routeFetch([["/anime/45398", { data: { attributes: { canonicalTitle: "Spy", titles: { en: "Spy Family: The Whole Long Subtitle Nobody Writes Out" } } } }]]);
      const title = await resolve("kitsu:45398");
      expect(title.title).toBe("Spy Family");
      expect(title.aliases).toContain("Spy Family: The Whole Long Subtitle Nobody Writes Out");
      freshCache();
      // Not when the part before the colon is no name of its own.
      routeFetch([["/anime/45398", { data: { attributes: { titles: { en: "Re:Zero - Starting Life" } } } }]]);
      expect((await resolve("kitsu:45398")).title).toBe("Re:Zero - Starting Life");
    });

    test("without an English name on Kitsu, AniList's; with neither, the database's title", async () => {
      routeFetch([
        ["/anime/45398/episodes", { data: [] }],
        ["/anime/45398", KITSU_NO_ENGLISH],
        ["graphql.anilist.co", { data: { Media: { ...ANILIST_MEDIA.data.Media, title: { english: "Spy Family (English)", romaji: "SPY×FAMILY" } } } }]
      ]);
      expect(await resolve("anidb:16591:2")).toMatchObject({ title: "Spy Family (English)", runtimeSeconds: 1440, runtimeKind: "typical" });
      freshCache();
      routeFetch([
        ["/anime/45398", KITSU_NO_ENGLISH],
        ["graphql.anilist.co", { data: { Media: { ...ANILIST_MEDIA.data.Media, title: { romaji: "SPY×FAMILY" } } } }]
      ]);
      const film = await resolve("anilist:140960");
      expect(film).toMatchObject({ isEpisode: false, title: "SPY x FAMILY", year: 2022, released: "2022-04-09" });
      // Kitsu's "Spy x Family" is the title itself, in other letters' case.
      expect(film.aliases).toEqual(["SPY×FAMILY", "Spy Family", "间谍过家家", "Spy Kyoushitsu Family"]);
    });

    test("when Kitsu and AniList have nothing, the database's own: title, names, year and length", async () => {
      routeFetch([]);
      expect(await resolve("kitsu:45398")).toEqual({
        isEpisode: false,
        title: "SPY x FAMILY",
        aliases: ["Spy Family", "Spy Kyoushitsu Family"],
        year: 2022,
        released: null,
        people: [],
        imdbId: null,
        otherRuntimes: [],
        runtimeSeconds: 1440,
        runtimeKind: "exact",
        sources: ["anime database"]
      });
    });

    test("Kitsu alone, with Kitsu not listing it, is an unknown title", async () => {
      routeFetch([]);
      expect(await resolve("kitsu:45398:1", { animeSource: "kitsu" })).toBeNull();
    });

    test("Kitsu alone, when chosen: no AniList, and names from Kitsu, found by the database", async () => {
      const fetch = routeFetch([["/anime/45398", KITSU_ANIME]]);
      expect(await resolve("mal:50265", { animeSource: "kitsu" })).toMatchObject({ title: "SPY x FAMILY", aliases: ["SPY×FAMILY", "SxF"], sources: ["kitsu"] });
      expect(fetch.mock.calls.some(([url]) => url.includes("anilist"))).toBe(false);
    });

    test("an id the database does not know is asked of the one source that knows it", async () => {
      animeDb.useIndex(null);
      const fetch = routeFetch([["graphql.anilist.co", ANILIST_MEDIA]]);
      expect(await resolve("anilist:140960")).toMatchObject({ title: "SPY x FAMILY", sources: ["anilist"] });
      expect(fetch).toHaveBeenCalledTimes(1);
      // Kitsu alone cannot look up an AniList id without the database's map.
      expect(await resolve("anilist:140960", { animeSource: "kitsu" })).toBeNull();
      // Nor can anyone an AniDB id.
      expect(await resolve("anidb:16591")).toBeNull();
    });

    test("an anime nobody knows is null; Kitsu and AniList down, with no database, a failed lookup", async () => {
      animeDb.useIndex(null);
      routeFetch([]);
      expect(await resolve("mal:1:1")).toBeNull();
      routeFetch([["graphql.anilist.co", response({}, { status: 503 })]]);
      await expect(resolve("mal:2:1")).rejects.toMatchObject({ kind: "unavailable", message: "no title, as AniList anime mal:2 failed" });
    });
  });
});

describe("uniqueAliases", () => {
  test("drops the title itself, blanks, repeats and non-strings, case-insensitively", () => {
    expect(uniqueAliases("Pitchers", ["pitchers", " TVF Pitchers ", "tvf pitchers", "", null, 5, "Other"])).toEqual([
      "TVF Pitchers",
      "Other"
    ]);
  });

  test("adds the main title of a name with a subtitle, unless it is too short to mean anything", () => {
    expect(uniqueAliases("Baahubali: The Beginning", [])).toEqual(["Baahubali"]);
    expect(uniqueAliases("Up: A Story", ["It: Chapter Two"])).toEqual(["It: Chapter Two"]);
  });

  test("adds each name's short names", () => {
    expect(uniqueAliases("The Nation Wants to Guess with Gursimran Kamba", [])).toEqual([
      "Nation Wants to Guess with Gursimran Kamba",
      "The Nation Wants to Guess",
      "Nation Wants to Guess"
    ]);
  });
});

describe("shortNames", () => {
  test("without a leading The, a trailing host, or both", () => {
    expect(shortNames("Last Week Tonight with John Oliver")).toEqual(["Last Week Tonight"]);
    expect(shortNames("The Big Bang Theory")).toEqual(["Big Bang Theory"]);
    expect(shortNames("the late show with someone")).toEqual(["late show with someone", "the late show"]);
  });

  test("only when three words or more remain", () => {
    expect(shortNames("The Office")).toEqual([]);
    expect(shortNames("Real Time with Bill Maher")).toEqual([]);
    expect(shortNames("Gone with the Wind")).toEqual([]);
    expect(shortNames("The Girl with the Dragon Tattoo")).toEqual(["Girl with the Dragon Tattoo"]);
  });

  test("a host's name is one to three words at the very end", () => {
    expect(shortNames("Dinner with Friends and Their Families Tonight")).toEqual([]);
    expect(shortNames("Kota Factory")).toEqual([]);
  });
});
