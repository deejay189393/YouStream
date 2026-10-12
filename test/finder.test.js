const youtube = require("../src/youtube");
const { findVideos, buildQuery, isBlocked } = require("../src/finder");
const { hostConfig } = require("../src/hostConfig");
const { normalizeConfig } = require("../src/config");
const { response, routeFetch, apiVideo, freshCache } = require("./helpers");

beforeEach(() => {
  freshCache();
  youtube.inFlight.clear();
  jest.restoreAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.TMDB_API_KEY;
});

const SETTINGS = normalizeConfig({ youtubeKey: "KEY" });

const MOVIE = { isEpisode: false, title: "Don", aliases: [], year: 1978, runtimeSeconds: 10500 };
const EPISODE = {
  isEpisode: true,
  title: "Kota Factory",
  aliases: [],
  year: 2019,
  season: 1,
  episode: 3,
  episodeTitle: "Optimization",
  absoluteEpisode: 3
};

describe("buildQuery", () => {
  test("the default searches", () => {
    expect(buildQuery(MOVIE, SETTINGS)).toBe("Don 1978 full movie");
    expect(buildQuery(EPISODE, SETTINGS)).toBe("Kota Factory season 1 episode 3");
  });

  test("{language} is the reader's audio language by name", () => {
    expect(buildQuery(MOVIE, normalizeConfig({ audioLanguage: "hi" }))).toBe("Don 1978 full movie Hindi");
  });

  test("every placeholder", () => {
    const settings = normalizeConfig({ episodeQuery: "{title} {s00e00} {episodeTitle} #{absolute} ({year}) {unknown}" });
    expect(buildQuery(EPISODE, settings)).toBe("Kota Factory S01E03 Optimization #3 (2019) {unknown}");
  });

  test("a placeholder with nothing to fill it disappears with its space", () => {
    expect(buildQuery({ ...MOVIE, year: null }, SETTINGS)).toBe("Don full movie");
    const settings = normalizeConfig({ movieQuery: "{title} {s00e00} {episodeTitle}" });
    expect(buildQuery({ ...MOVIE, episodeTitle: undefined }, settings)).toBe("Don");
  });

  test("a query that renders empty falls back to the title", () => {
    const settings = normalizeConfig({ movieQuery: "{title}" });
    expect(buildQuery({ ...MOVIE, title: "  " }, settings)).toBe("  ");
  });
});

const CINEMETA = {
  meta: {
    name: "Kota Factory",
    year: "2019",
    runtime: "43 min",
    videos: [
      { season: 1, episode: 3, name: "Optimization" },
      { season: 1, episode: 4, name: "Shutdown" }
    ]
  }
};

describe("blocked videos and channels", () => {
  const legal = { blockedVideos: ["e3xxxxxxxxx"], blockedChannels: ["UC1234567890123456789012"] };

  test("by video or by channel", () => {
    expect(isBlocked({ id: "e3xxxxxxxxx", channelId: "UCother" }, legal)).toBe(true);
    expect(isBlocked({ id: "other000000", channelId: "UC1234567890123456789012" }, legal)).toBe(true);
    expect(isBlocked({ id: "other000000", channelId: "UCother" }, legal)).toBe(false);
    expect(isBlocked({ id: "e3xxxxxxxxx", channelId: "UCother" })).toBe(false);
  });

  test("a blocked video is never a match, and says why", async () => {
    routeFetch([
      ["/meta/series/tt9432978.json", CINEMETA],
      ["/search?", { items: [{ id: { videoId: "e3" } }] }],
      ["/videos?", { items: [apiVideo("e3", { snippet: { title: "Kota Factory - S01 E03 - Optimization" }, contentDetails: { duration: "PT36M51S" } })] }]
    ]);
    hostConfig.legal.blockedVideos = ["e3"];
    try {
      const result = await findVideos("tt9432978:1:3", SETTINGS);
      expect(result.matches).toEqual([]);
      expect(result.evaluations[0]).toMatchObject({ ok: false, reason: "blocked on this server" });
    } finally {
      hostConfig.legal.blockedVideos = [];
    }
  });
});

describe("findVideos", () => {
  test("an id it cannot read", async () => {
    expect(await findVideos("nd_123", SETTINGS)).toEqual({ status: "unsupported id" });
  });

  test("a type the reader switched off costs nothing", async () => {
    const fetch = routeFetch([]);
    const result = await findVideos("tt9432978:1:3", normalizeConfig({ youtubeKey: "KEY", types: ["movie"] }));
    expect(result.status).toBe("type switched off");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a title nobody knows", async () => {
    routeFetch([]);
    expect((await findVideos("tt0000001", SETTINGS)).status).toBe("unknown title");
  });

  test("from id to ranked matches, with one search of the right length", async () => {
    const fetch = routeFetch([
      ["/meta/series/tt9432978.json", CINEMETA],
      ["/search?", { items: [{ id: { videoId: "e3" } }, { id: { videoId: "e4" } }, { id: { videoId: "e3b" } }] }],
      [
        "/videos?",
        {
          items: [
            apiVideo("e3", { snippet: { title: "Kota Factory - S01 E03 - Optimization" }, contentDetails: { duration: "PT36M51S" } }),
            apiVideo("e4", { snippet: { title: "Kota Factory - S01 E04 - Shutdown" }, contentDetails: { duration: "PT39M54S" } }),
            apiVideo("e3b", {
              snippet: { title: "Kota Factory Episode 3 re-upload" },
              contentDetails: { duration: "PT36M51S", definition: "sd" },
              statistics: { viewCount: "3" }
            })
          ]
        }
      ]
    ]);
    const result = await findVideos("tt9432978:1:3", normalizeConfig({ youtubeKey: "KEY", region: "IN", audioLanguage: "hi" }));
    expect(result.status).toBe("ok");
    expect(result.query).toBe("Kota Factory season 1 episode 3");
    expect(result.cached).toBe(false);
    expect(result.matches.map((m) => m.video.id)).toEqual(["e3"]);
    expect(result.evaluations.find((e) => e.video.id === "e4").reason).toBe("episode 4");
    expect(result.evaluations.find((e) => e.video.id === "e3b").reason).toBe("too few views");

    const search = new URL(fetch.mock.calls.find(([url]) => url.includes("/search?"))[0]).searchParams;
    expect(search.get("videoDuration")).toBe("long");
    expect(search.get("regionCode")).toBe("IN");
    expect(search.get("relevanceLanguage")).toBe("hi");
  });

  test("lists at most the reader's number of matches", async () => {
    routeFetch([
      ["/meta/movie/", { meta: { name: "Night of the Living Dead", year: "1968", runtime: "96 min" } }],
      ["/search?", { items: ["a", "b", "c"].map((videoId) => ({ id: { videoId } })) }],
      [
        "/videos?",
        { items: ["a", "b", "c"].map((id) => apiVideo(id, { snippet: { title: "Night of the Living Dead 1968" }, contentDetails: { duration: "PT1H36M" } })) }
      ]
    ]);
    const result = await findVideos("tt0063350", normalizeConfig({ youtubeKey: "KEY", maxResults: 2 }));
    expect(result.matches).toHaveLength(2);
    expect(result.evaluations).toHaveLength(3);
  });

  test("uses the server's TMDB key for tmdb: ids when the reader has none", async () => {
    process.env.TMDB_API_KEY = "SERVER";
    const fetch = routeFetch([
      ["/movie/10331", { title: "Night of the Living Dead", release_date: "1968-10-04", runtime: 96 }],
      ["/search?", { items: [] }]
    ]);
    expect((await findVideos("tmdb:10331", SETTINGS)).status).toBe("ok");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("api_key")).toBe("SERVER");
  });

  test("a failed search is reported with its kind", async () => {
    routeFetch([
      ["/meta/series/", CINEMETA],
      ["/search?", response({ error: { message: "bad key", errors: [{ reason: "keyInvalid" }] } }, { status: 400 })]
    ]);
    const result = await findVideos("tt9432978:1:3", SETTINGS);
    expect(result).toMatchObject({ status: "search failed", error: { kind: "invalid", message: "bad key" } });
    expect(result.title.title).toBe("Kota Factory");
  });
});
