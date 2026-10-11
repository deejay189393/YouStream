const { clearAllCaches } = require("../src/cache");
const youtube = require("../src/youtube");
const { createAddonInterface, handleStream, logResult, CACHE_SECONDS } = require("../src/addonInterface");
const { response, routeFetch, apiVideo } = require("./helpers");

beforeEach(() => {
  clearAllCaches();
  youtube.inFlight.clear();
  jest.restoreAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const CONFIG = { youtubeKey: "KEY" };
const SHAWSHANK = { meta: { name: "The Shawshank Redemption", year: "1994", runtime: "142 min" } };

function youtubeReturns(videos) {
  return [
    ["/search?", { items: videos.map((v) => ({ id: { videoId: v.id } })) }],
    ["/videos?", { items: videos }]
  ];
}

describe("stream handler", () => {
  test("found videos become stream rows, cached for hours", async () => {
    routeFetch([
      ["/meta/movie/tt0111161.json", SHAWSHANK],
      ...youtubeReturns([
        apiVideo("full0000001", { snippet: { title: "The Shawshank Redemption (1994) Full Movie" }, contentDetails: { duration: "PT2H21M" } }),
        apiVideo("trailer0001", { snippet: { title: "The Shawshank Redemption Trailer" }, contentDetails: { duration: "PT2M10S" } })
      ])
    ]);
    const iface = createAddonInterface();
    const res = await iface.get("stream", "movie", "tt0111161", {}, CONFIG);
    expect(res.cacheMaxAge).toBe(CACHE_SECONDS.found);
    expect(res.streams.map((s) => s.ytId || s.externalUrl)).toEqual([
      "full0000001",
      "https://www.youtube.com/watch?v=full0000001"
    ]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("-> 1 matches; rejected: wrong length 1"));
  });

  test("nothing found is cached for an hour", async () => {
    routeFetch([["/meta/movie/", SHAWSHANK], ...youtubeReturns([])]);
    const res = await handleStream({ id: "tt0111161", config: CONFIG });
    expect(res).toEqual({ streams: [], cacheMaxAge: CACHE_SECONDS.none });
  });

  test("an unknown title is cached for an hour", async () => {
    routeFetch([]);
    expect(await handleStream({ id: "tt0000001", config: CONFIG })).toEqual({ streams: [], cacheMaxAge: CACHE_SECONDS.none });
  });

  test("a failed search is retried soon", async () => {
    routeFetch([["/meta/movie/", SHAWSHANK], ["/search?", response({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })]]);
    expect(await handleStream({ id: "tt0111161", config: CONFIG })).toEqual({ streams: [], cacheMaxAge: CACHE_SECONDS.failed });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("search failed: quota"));
  });

  test.each([[undefined], [false], [{}], [{ youtubeKey: "has spaces" }]])("no usable key, %p, is no streams", async (config) => {
    const fetch = routeFetch([]);
    expect(await handleStream({ id: "tt0111161", config })).toEqual({ streams: [] });
    expect(fetch).not.toHaveBeenCalled();
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
