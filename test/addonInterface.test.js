const youtube = require("../src/youtube");
const { createAddonInterface, handleStream, handleCatalog, handleMeta, logResult, maxAgeFor } = require("../src/addonInterface");
const browse = require("../src/browse");
const { hostConfig } = require("../src/hostConfig");

const AGES = hostConfig.streams;
const { response, routeFetch, apiVideo, freshCache } = require("./helpers");

beforeEach(() => {
  freshCache();
  youtube.inFlight.clear();
  browse.inFlight.clear();
  browse.latestSearch.clear();
  jest.restoreAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const CONFIG = { youtubeKey: "KEY" };
// A public-domain film.
const NOTLD = { meta: { name: "Night of the Living Dead", year: "1968", runtime: "96 min" } };

function youtubeReturns(videos) {
  return [
    ["/search?", { items: videos.map((v) => ({ id: { videoId: v.id } })) }],
    ["/videos?", { items: videos }]
  ];
}

describe("stream handler", () => {
  test("found videos become stream rows, cached for hours", async () => {
    routeFetch([
      ["/meta/movie/tt0063350.json", NOTLD],
      ...youtubeReturns([
        apiVideo("full0000001", { snippet: { title: "Night of the Living Dead (1968) Full Movie" }, contentDetails: { duration: "PT1H35M" } }),
        apiVideo("trailer0001", { snippet: { title: "Night of the Living Dead Trailer" }, contentDetails: { duration: "PT2M10S" } })
      ])
    ]);
    const iface = createAddonInterface();
    const res = await iface.get("stream", "movie", "tt0063350", {}, CONFIG);
    expect(res.cacheMaxAge).toBe(AGES.maxAgeSeconds);
    expect(res.streams.map((s) => s.ytId || s.externalUrl)).toEqual([
      "full0000001",
      "https://www.youtube.com/watch?v=full0000001"
    ]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("-> 1 matches; rejected: wrong length 1"));
  });

  test("nothing found is cached for an hour", async () => {
    routeFetch([["/meta/movie/", NOTLD], ...youtubeReturns([])]);
    const res = await handleStream({ id: "tt0063350", config: CONFIG });
    expect(res).toEqual({ streams: [], cacheMaxAge: AGES.emptyMaxAgeSeconds });
  });

  test("an unknown title is cached for an hour", async () => {
    routeFetch([]);
    expect(await handleStream({ id: "tt0000001", config: CONFIG })).toEqual({ streams: [], cacheMaxAge: AGES.emptyMaxAgeSeconds });
  });

  test("a failed search is retried soon", async () => {
    routeFetch([["/meta/movie/", NOTLD], ["/search?", response({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })]]);
    expect(await handleStream({ id: "tt0063350", config: CONFIG })).toEqual({ streams: [], cacheMaxAge: AGES.failedMaxAgeSeconds });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("search failed: quota"));
  });

  test.each([[undefined], [false], [{}], [{ youtubeKey: "has spaces" }]])("no usable key, %p, is no streams", async (config) => {
    const fetch = routeFetch([]);
    expect(await handleStream({ id: "tt0063350", config })).toEqual({ streams: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("maxAgeFor", () => {
  const ages = { maxAgeSeconds: 21600, emptyMaxAgeSeconds: 3600, failedMaxAgeSeconds: 60 };
  const OLD_FILM = { isEpisode: false, year: 1968, released: "1968-10-04" };
  const today = new Date().toISOString().slice(0, 10);
  const NEW_EPISODE = { isEpisode: true, year: 2019, released: today, releaseYear: Number(today.slice(0, 4)) };

  test("videos found are kept for hours, nothing found for less", () => {
    expect(maxAgeFor({ status: "ok", title: OLD_FILM }, [{}], ages)).toBe(21600);
    expect(maxAgeFor({ status: "ok", title: OLD_FILM }, [], ages)).toBe(3600);
    expect(maxAgeFor({ status: "unknown title" }, [], ages)).toBe(3600);
    expect(maxAgeFor({ status: "search failed", title: OLD_FILM }, [], ages)).toBe(60);
  });

  test("an answer from an out-of-date search is asked for again as soon as an empty one", () => {
    expect(maxAgeFor({ status: "ok", title: OLD_FILM, stale: "quota" }, [{}], ages)).toBe(3600);
  });

  test("an empty answer for a recent release is kept no longer than its search", () => {
    freshCache({ recentSearchMs: 20 * 60 * 1000 });
    expect(maxAgeFor({ status: "ok", title: NEW_EPISODE }, [], ages)).toBe(1200);
    expect(maxAgeFor({ status: "ok", title: NEW_EPISODE }, [{}], ages)).toBe(21600);
  });
});

describe("logResult", () => {
  test("a lookup that stopped early, with and without an error", () => {
    logResult("x", { status: "unknown title" });
    expect(console.log).toHaveBeenLastCalledWith("[stream] x unknown title");
    logResult("x", { status: "search failed", error: { kind: "quota", message: "spent" } });
    expect(console.log).toHaveBeenLastCalledWith("[stream] x search failed: quota -- spent");
  });

  test("a cached lookup with no rejections", () => {
    logResult("x", { status: "ok", query: "q", cached: true, evaluations: [{ ok: true }], matches: [{}] });
    expect(console.log).toHaveBeenLastCalledWith('[stream] x "q" 1 results (cached) -> 1 matches');
  });

  test("an out-of-date cached search, and why it was used", () => {
    logResult("x", { status: "ok", query: "q", cached: true, stale: "quota", evaluations: [], matches: [] });
    expect(console.log).toHaveBeenLastCalledWith('[stream] x "q" 0 results (cached; YouTube failed: quota) -> 0 matches');
  });

  test("rejections are counted, most common first", () => {
    logResult("x", {
      status: "ok",
      query: "q",
      cached: false,
      evaluations: [{ ok: false, reason: "b" }, { ok: false, reason: "a" }, { ok: false, reason: "a" }],
      matches: []
    });
    expect(console.log).toHaveBeenLastCalledWith('[stream] x "q" 3 results -> 0 matches; rejected: a 2, b 1');
  });
});

describe("YouTube catalogs", () => {
  const TRENDING = { youtubeKey: "KEY", catalogs: [{ trending: "all" }], catalogRefresh: "45m" };

  test("a catalog of the reader's lists its videos as YouTube items, kept by the app at most its interval", async () => {
    routeFetch([["/videos?", { items: [apiVideo("trend000001", { snippet: { title: "Trending One" } })] }]]);
    const iface = createAddonInterface();
    const res = await iface.get("catalog", "YouTube", "trending.all", {}, TRENDING);
    expect(res.cacheMaxAge).toBe(45 * 60);
    expect(res.metas).toEqual([
      expect.objectContaining({ id: "youstream:trend000001", type: "YouTube", name: "Trending One", posterShape: "landscape" })
    ]);
  });

  test("an interval longer than an hour is still asked about hourly by the app; the server keeps the rest", async () => {
    routeFetch([["/videos?", { items: [] }]]);
    const res = await handleCatalog({ type: "YouTube", id: "trending.all", extra: {}, config: { ...TRENDING, catalogRefresh: "1d" } });
    expect(res.cacheMaxAge).toBe(60 * 60);
  });

  test("pages follow skip", async () => {
    const fetch = routeFetch([["/videos?", (url) => (new URL(url).searchParams.get("pageToken") ? { items: [apiVideo("second00001")] } : { items: [apiVideo("first000001")], nextPageToken: "N" })]]);
    const res = await handleCatalog({ type: "YouTube", id: "trending.all", extra: { skip: "1" }, config: TRENDING });
    expect(res.metas.map((m) => m.id)).toEqual(["youstream:second00001"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["another type", "movie", "trending.all", TRENDING],
    ["a catalog this reader does not have", "YouTube", "trending.music", TRENDING],
    ["no key", "YouTube", "trending.all", { catalogs: [{ trending: "all" }] }]
  ])("nothing for %s", async (_, type, id, config) => {
    const fetch = routeFetch([]);
    expect(await handleCatalog({ type, id, extra: {}, config })).toEqual({ metas: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("YouTube failing is an empty row, asked again in a minute, and logged", async () => {
    routeFetch([["/videos?", response({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })]]);
    expect(await handleCatalog({ type: "YouTube", id: "trending.all", extra: {}, config: TRENDING })).toEqual({ metas: [], cacheMaxAge: 60 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[catalog] trending.all failed: quota"));
  });
});

describe("YouTube search", () => {
  const search = (query, config = { youtubeKey: "KEY", search: true }, extra = {}) =>
    handleCatalog({ type: "YouTube", id: "search", extra: { search: query, ...extra }, config });

  test("the app's search, answered live from YouTube", async () => {
    jest.spyOn(browse, "searchItems");
    routeFetch([
      ["/search?", { items: [{ id: { videoId: "found000001" } }] }],
      ["/videos?", { items: [apiVideo("found000001")] }]
    ]);
    const res = await search("interstellar");
    expect(res).toEqual({ metas: [expect.objectContaining({ id: "youstream:found000001" })], cacheMaxAge: 60 });
  }, 10000);

  test("nothing to search yet is not kept by the app at all", async () => {
    expect(await search("in")).toEqual({ metas: [], cacheMaxAge: 0 });
  });

  test("with search off -- as it is unless saved on -- nothing, and nothing asked", async () => {
    const fetch = routeFetch([]);
    expect(await search("interstellar", { youtubeKey: "KEY" })).toEqual({ metas: [] });
    expect(await search("interstellar", { youtubeKey: "KEY", search: false })).toEqual({ metas: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a failure is logged without what was searched", async () => {
    routeFetch([["/search?", response({ error: { errors: [{ reason: "backendError" }] } }, { status: 500 })]]);
    expect(await search("my private search")).toEqual({ metas: [], cacheMaxAge: 60 });
    expect(console.log).toHaveBeenCalledWith("[catalog] search failed: unavailable -- YouTube returned HTTP 500");
    expect(console.log.mock.calls.flat().join(" ")).not.toContain("my private search");
  }, 10000);
});

describe("YouTube items: metadata and streams", () => {
  const VIDEO = apiVideo("abcdefghijk", { snippet: { title: "How Example Engines Work", tags: ["engines"], categoryId: "28" } });

  test("a video's details, for its page and the app's library", async () => {
    routeFetch([["/videos?", { items: [VIDEO] }]]);
    const iface = createAddonInterface();
    const res = await iface.get("meta", "YouTube", "youstream:abcdefghijk", {}, { youtubeKey: "KEY" });
    expect(res.cacheMaxAge).toBe(6 * 60 * 60);
    expect(res.meta).toMatchObject({ id: "youstream:abcdefghijk", type: "YouTube", name: "How Example Engines Work", genres: ["Science & Technology", "Engines"] });
  });

  test.each([
    ["an id that is not an item", "YouTube", "tt0063350", { youtubeKey: "KEY" }],
    ["another type", "movie", "youstream:abcdefghijk", { youtubeKey: "KEY" }],
    ["no key", "YouTube", "youstream:abcdefghijk", {}]
  ])("%s is not found, so the router passes it on", async (_, type, id, config) => {
    await expect(handleMeta({ type, id, config })).rejects.toMatchObject({ noHandler: true });
  });

  test("a video YouTube no longer has, or this server blocks, is not found", async () => {
    routeFetch([["/videos?", { items: [] }]]);
    await expect(handleMeta({ type: "YouTube", id: "youstream:gonegonegon", config: { youtubeKey: "KEY" } })).rejects.toMatchObject({ noHandler: true });
    hostConfig.legal.blockedVideos.push("abcdefghijk");
    try {
      routeFetch([["/videos?", { items: [VIDEO] }]]);
      await expect(handleMeta({ type: "YouTube", id: "youstream:abcdefghijk", config: { youtubeKey: "KEY" } })).rejects.toMatchObject({ noHandler: true });
      expect(await handleStream({ id: "youstream:abcdefghijk", config: { youtubeKey: "KEY" } })).toEqual({ streams: [], cacheMaxAge: AGES.emptyMaxAgeSeconds });
    } finally {
      hostConfig.legal.blockedVideos.pop();
    }
  });

  test("YouTube failing is an error the app asks again about, not 'not found'", async () => {
    routeFetch([["/videos?", response({}, { status: 503 })]]);
    await expect(handleMeta({ type: "YouTube", id: "youstream:abcdefghijk", config: { youtubeKey: "KEY" } })).rejects.toMatchObject({ kind: "unavailable" });
  });

  test("its streams: the reader's ways of watching, from the reader's templates", async () => {
    routeFetch([["/videos?", { items: [VIDEO] }]]);
    const res = await handleStream({ id: "youstream:abcdefghijk", config: { youtubeKey: "KEY", playback: ["app", "smarttube"] } });
    expect(res.cacheMaxAge).toBe(AGES.maxAgeSeconds);
    expect(res.streams.map((s) => s.ytId || s.externalUrl)).toEqual(["abcdefghijk", "vnd.youtube:abcdefghijk"]);
    expect(res.streams[0].description.split("\n")[0]).toBe("🎬 How Example Engines Work");
  });

  test("no streams for a video gone, and a minute's wait when YouTube fails", async () => {
    routeFetch([["/videos?", { items: [] }]]);
    expect(await handleStream({ id: "youstream:gonegonegon", config: { youtubeKey: "KEY" } })).toEqual({ streams: [], cacheMaxAge: AGES.emptyMaxAgeSeconds });
    routeFetch([["/videos?", response({}, { status: 503 })]]);
    expect(await handleStream({ id: "youstream:failfailfai", config: { youtubeKey: "KEY" } })).toEqual({ streams: [], cacheMaxAge: 60 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[stream] video failfailfai failed: unavailable"));
  });

  test("streams for YouTube items whatever the reader's film and show types", async () => {
    routeFetch([["/videos?", { items: [VIDEO] }]]);
    const res = await handleStream({ id: "youstream:abcdefghijk", config: { youtubeKey: "KEY", types: [] } });
    expect(res.streams.length).toBeGreaterThan(0);
  });
});
