const youtube = require("../src/youtube");
const { createAddonInterface, handleStream, logResult, maxAgeFor } = require("../src/addonInterface");
const { hostConfig } = require("../src/hostConfig");

const AGES = hostConfig.streams;
const { response, routeFetch, apiVideo, freshCache } = require("./helpers");

beforeEach(() => {
  freshCache();
  youtube.inFlight.clear();
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
