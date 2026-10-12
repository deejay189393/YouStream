const {
  normalizeConfig,
  encodeConfig,
  decodeConfig,
  isConfigured,
  effectiveTmdbKey,
  parseMargin,
  formatMargin,
  cleanKey,
  DEFAULT_MARGINS,
  DEFAULT_EXCLUDE,
  DEFAULT_EXCLUDE_DESCRIPTION,
  DEFAULT_MOVIE_QUERY,
  DEFAULT_EPISODE_QUERY,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_VIEWS
} = require("../src/config");
const { PLAYBACK_VERSION } = require("../src/playback");

afterEach(() => {
  delete process.env.TMDB_API_KEY;
});

const decoded = (config) => JSON.parse(decodeURIComponent(encodeConfig(config)));

describe("parseMargin", () => {
  test.each([
    ["45s", { value: 45, unit: "s" }],
    ["10m", { value: 10, unit: "m" }],
    ["20%", { value: 20, unit: "%" }],
    [" 2.5 M ", { value: 2.5, unit: "m" }],
    ["0s", { value: 0, unit: "s" }],
    [{ value: "90", unit: "s" }, { value: 90, unit: "s" }],
    [{ value: 1.234, unit: "%" }, { value: 1.23, unit: "%" }]
  ])("reads %p", (raw, expected) => {
    expect(parseMargin(raw)).toEqual(expected);
  });

  test.each([
    ["45"],
    ["45h"],
    ["-5s"],
    ["7201s"],
    ["121m"],
    ["101%"],
    [{ value: "x", unit: "s" }],
    [{ value: 5, unit: "h" }],
    [45],
    [null]
  ])("refuses %p", (raw) => {
    expect(parseMargin(raw)).toBeNull();
  });

  test("formatMargin is its inverse", () => {
    expect(formatMargin({ value: 2.5, unit: "m" })).toBe("2.5m");
    expect(parseMargin(formatMargin({ value: 20, unit: "%" }))).toEqual({ value: 20, unit: "%" });
  });
});

describe("cleanKey", () => {
  test("trims a key", () => {
    expect(cleanKey("  AIza_abc-123.x ")).toBe("AIza_abc-123.x");
  });

  test("refuses anything a key never contains, or too long a key", () => {
    expect(cleanKey("AIza abc")).toBe("");
    expect(cleanKey("<script>")).toBe("");
    expect(cleanKey("a".repeat(513))).toBe("");
    expect(cleanKey(42)).toBe("");
  });
});

describe("normalizeConfig", () => {
  test("fills every default for an empty config", () => {
    expect(normalizeConfig({})).toEqual({
      youtubeKey: "",
      tmdbKey: "",
      movieMargin: DEFAULT_MARGINS.movieMargin,
      partnerMovieMargin: DEFAULT_MARGINS.partnerMovieMargin,
      episodeMargin: DEFAULT_MARGINS.episodeMargin,
      typicalMargin: DEFAULT_MARGINS.typicalMargin,
      playback: ["app", "youtube"],
      types: ["movie", "series"],
      maxResults: DEFAULT_MAX_RESULTS,
      minViews: DEFAULT_MIN_VIEWS,
      region: "",
      audioLanguage: "",
      embeddableOnly: false,
      officialOnly: false,
      exclude: DEFAULT_EXCLUDE,
      excludeDescription: DEFAULT_EXCLUDE_DESCRIPTION,
      movieQuery: DEFAULT_MOVIE_QUERY,
      episodeQuery: DEFAULT_EPISODE_QUERY
    });
  });

  test("the view minimum: 1,000 by default, 0 turns it off, anything invalid is the default", () => {
    expect(DEFAULT_MIN_VIEWS).toBe(1000);
    expect(normalizeConfig({ minViews: 0 }).minViews).toBe(0);
    expect(normalizeConfig({ minViews: "250" }).minViews).toBe(250);
    expect(normalizeConfig({ minViews: -1 }).minViews).toBe(DEFAULT_MIN_VIEWS);
    expect(normalizeConfig({ minViews: 1.5 }).minViews).toBe(DEFAULT_MIN_VIEWS);
    expect(normalizeConfig({ minViews: 1e9 }).minViews).toBe(DEFAULT_MIN_VIEWS);
    expect(normalizeConfig({ minViews: " " }).minViews).toBe(DEFAULT_MIN_VIEWS);
  });

  test("the defaults: 10 minutes for films (20% from official channels), 90 seconds for episodes, 30% for usual lengths", () => {
    expect(DEFAULT_MARGINS).toEqual({
      movieMargin: { value: 10, unit: "m" },
      partnerMovieMargin: { value: 20, unit: "%" },
      episodeMargin: { value: 90, unit: "s" },
      typicalMargin: { value: 30, unit: "%" }
    });
  });

  test.each([[null], [undefined], [false], [[1, 2]], ["text"]])("is safe on %p", (raw) => {
    expect(normalizeConfig(raw).youtubeKey).toBe("");
  });

  test("does not share the default lists between configs", () => {
    normalizeConfig({}).exclude.push("x");
    normalizeConfig({}).types.push("x");
    expect(normalizeConfig({}).exclude).toEqual(DEFAULT_EXCLUDE);
    expect(normalizeConfig({}).types).toEqual(["movie", "series"]);
  });

  test("reads every setting", () => {
    const n = normalizeConfig({
      youtubeKey: "yt",
      tmdbKey: "tm",
      movieMargin: "15%",
      episodeMargin: "90s",
      typicalMargin: "5m",
      playback: ["youtube"],
      types: ["series"],
      maxResults: "8",
      region: "IN",
      audioLanguage: "hi",
      embeddableOnly: true,
      exclude: [" Trailer ", "trailer", "", 5, "Reaction"],
      movieQuery: "  {title}   full  movie ",
      episodeQuery: "{title} {s00e00}"
    });
    expect(n).toMatchObject({
      youtubeKey: "yt",
      tmdbKey: "tm",
      movieMargin: { value: 15, unit: "%" },
      episodeMargin: { value: 90, unit: "s" },
      typicalMargin: { value: 5, unit: "m" },
      playback: ["youtube"],
      types: ["series"],
      maxResults: 8,
      region: "IN",
      audioLanguage: "hi",
      embeddableOnly: true,
      exclude: ["trailer", "reaction"],
      movieQuery: "{title} full movie",
      episodeQuery: "{title} {s00e00}"
    });
  });

  test("replaces anything invalid with its default", () => {
    const n = normalizeConfig({
      movieMargin: "lots",
      types: ["films"],
      maxResults: 0,
      region: "XX",
      audioLanguage: "klingon",
      embeddableOnly: "yes",
      exclude: "trailer",
      movieQuery: "no placeholder",
      episodeQuery: 5
    });
    expect(n).toMatchObject({
      movieMargin: DEFAULT_MARGINS.movieMargin,
      types: ["movie", "series"],
      maxResults: DEFAULT_MAX_RESULTS,
      region: "",
      audioLanguage: "",
      embeddableOnly: false,
      exclude: DEFAULT_EXCLUDE,
      movieQuery: DEFAULT_MOVIE_QUERY,
      episodeQuery: DEFAULT_EPISODE_QUERY
    });
  });

  test("caps how many results may be listed", () => {
    expect(normalizeConfig({ maxResults: 21 }).maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(normalizeConfig({ maxResults: 20 }).maxResults).toBe(20);
    expect(normalizeConfig({ maxResults: " " }).maxResults).toBe(DEFAULT_MAX_RESULTS);
  });

  test("bounds the excluded words", () => {
    const many = Array.from({ length: 250 }, (_, i) => `word${i}`);
    expect(normalizeConfig({ exclude: many }).exclude).toHaveLength(200);
    expect(normalizeConfig({ exclude: ["x".repeat(60)] }).exclude[0]).toHaveLength(40);
  });

  test("keeps an emptied exclusion list empty", () => {
    expect(normalizeConfig({ exclude: [] }).exclude).toEqual([]);
  });
});

describe("encodeConfig", () => {
  test("stores only what differs from the defaults", () => {
    expect(decoded({ youtubeKey: "yt" })).toEqual({
      youtubeKey: "yt",
      playback: ["app", "youtube"],
      playbackVersion: PLAYBACK_VERSION
    });
  });

  test("stores every changed setting compactly", () => {
    expect(
      decoded({
        youtubeKey: "yt",
        tmdbKey: "tm",
        movieMargin: "12%",
        episodeMargin: { value: 60, unit: "s" },
        typicalMargin: "3m",
        partnerMovieMargin: "25%",
        playback: ["smarttube"],
        types: ["movie"],
        maxResults: 3,
        minViews: 0,
        region: "IN",
        audioLanguage: "hi",
        embeddableOnly: true,
        officialOnly: true,
        exclude: ["trailer"],
        excludeDescription: ["fan movie"],
        movieQuery: "{title} movie",
        episodeQuery: "{title} {s00e00}"
      })
    ).toEqual({
      youtubeKey: "yt",
      tmdbKey: "tm",
      movieMargin: "12%",
      episodeMargin: "60s",
      typicalMargin: "3m",
      partnerMovieMargin: "25%",
      playback: ["smarttube"],
      playbackVersion: PLAYBACK_VERSION,
      types: ["movie"],
      maxResults: 3,
      minViews: 0,
      region: "IN",
      audioLanguage: "hi",
      embeddableOnly: true,
      officialOnly: true,
      exclude: ["trailer"],
      excludeDescription: ["fan movie"],
      movieQuery: "{title} movie",
      episodeQuery: "{title} {s00e00}"
    });
  });

  test("round-trips through decodeConfig", () => {
    const config = { youtubeKey: "yt", movieMargin: "8%", region: "GB" };
    expect(decodeConfig(encodeConfig(config))).toEqual(normalizeConfig(config));
  });

  test("a margin given with the default's value and unit is not stored", () => {
    expect(decoded({ youtubeKey: "yt", movieMargin: "10m" }).movieMargin).toBeUndefined();
    expect(decoded({ youtubeKey: "yt", movieMargin: "10s" }).movieMargin).toBe("10s");
  });
});

describe("decodeConfig", () => {
  test("accepts the segment still encoded or already decoded", () => {
    const segment = encodeConfig({ youtubeKey: "yt" });
    expect(decodeConfig(segment).youtubeKey).toBe("yt");
    expect(decodeConfig(decodeURIComponent(segment)).youtubeKey).toBe("yt");
  });

  test("accepts a decoded segment holding a literal %", () => {
    expect(decodeConfig(JSON.stringify({ youtubeKey: "yt", movieMargin: "20%" })).movieMargin).toEqual({
      value: 20,
      unit: "%"
    });
  });

  test.each([[""], [undefined], ["not json"], ["[1,2]"], ["null"], ["42"]])("refuses %p", (raw) => {
    expect(decodeConfig(raw)).toBeNull();
  });
});

describe("isConfigured", () => {
  test("needs a YouTube key", () => {
    expect(isConfigured({ youtubeKey: "yt" })).toBe(true);
    expect(isConfigured({ tmdbKey: "tm" })).toBe(false);
    expect(isConfigured(null)).toBe(false);
  });
});

describe("effectiveTmdbKey", () => {
  test("prefers the reader's own key", () => {
    process.env.TMDB_API_KEY = "server";
    expect(effectiveTmdbKey(normalizeConfig({ tmdbKey: "mine" }))).toBe("mine");
  });

  test("falls back to the server's", () => {
    process.env.TMDB_API_KEY = "server";
    expect(effectiveTmdbKey(normalizeConfig({}))).toBe("server");
  });

  test("is empty when neither has one", () => {
    expect(effectiveTmdbKey(normalizeConfig({}))).toBe("");
  });
});
