const browse = require("../src/browse");
const youtube = require("../src/youtube");
const { browseCache, videoCache, keyCooldown } = require("../src/cache");
const { normalizeConfig } = require("../src/config");
const { normalizeEntry } = require("../src/catalogs");
const { hostConfig } = require("../src/hostConfig");
const { storage } = require("../src/requestContext");
const { response, routeFetch, apiVideo, freshCache } = require("./helpers");

const KEY = "AIzaReader1";
const settingsFor = (config = {}) => normalizeConfig({ youtubeKey: KEY, ...config });
const params = (fetch, i) => Object.fromEntries(new URL(fetch.mock.calls[i][0]).searchParams);
const paths = (fetch) => fetch.mock.calls.map(([url]) => new URL(url).pathname.split("/").pop());
const searchBody = (ids, next) => ({ items: ids.map((videoId) => ({ id: { videoId } })), ...(next ? { nextPageToken: next } : {}) });
const videosBody = (url) => ({ items: new URL(url).searchParams.get("id").split(",").filter((id) => !id.startsWith("gone")).map((id) => apiVideo(id)) });
const ids = (from, count) => Array.from({ length: count }, (_, i) => `${from}${String(i).padStart(3, "0")}`);
const googleError = (status, reason) => response({ error: { code: status, message: reason, errors: [{ reason }] } }, { status });

const NOW = Date.parse("2026-10-19T12:34:56Z");

beforeEach(() => {
  freshCache();
  browse.inFlight.clear();
  browse.latestSearch.clear();
  jest.restoreAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("a search catalog", () => {
  const entry = normalizeEntry({ q: "lofi hip hop", sort: "date", length: "long", within: "week" });

  test("one search and one videos.list for a page, with every filter, in YouTube's order", async () => {
    const fetch = routeFetch([
      ["/search?", searchBody(["v2", "v1", "gone1"], "NEXT")],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor({ region: "IN", audioLanguage: "hi", safeSearch: "strict", embeddableOnly: true });
    const items = await browse.catalogItems({ entry, settings, skip: undefined });
    expect(items.map((i) => i.id)).toEqual(["v2", "v1"]);
    expect(params(fetch, 0)).toEqual({
      key: KEY,
      part: "id",
      type: "video",
      q: "lofi hip hop",
      maxResults: "50",
      order: "date",
      videoDuration: "long",
      publishedAfter: "2026-10-12T12:00:00.000Z",
      safeSearch: "strict",
      regionCode: "IN",
      relevanceLanguage: "hi",
      videoEmbeddable: "true"
    });
    expect(params(fetch, 1).id).toBe("v2,v1,gone1");
    // A catalog row holds the start of each description only.
    expect(items[0].tags).toBeUndefined();
  });

  test("YouTube's own ranking and any length are not sent as filters", async () => {
    const fetch = routeFetch([["/search?", searchBody([])]]);
    await browse.catalogItems({ entry: normalizeEntry({ q: "lofi" }), settings: settingsFor(), skip: 0 });
    expect(params(fetch, 0)).toMatchObject({ order: "relevance", safeSearch: "moderate" });
    ["videoDuration", "publishedAfter", "regionCode", "relevanceLanguage", "videoEmbeddable"].forEach((p) =>
      expect(params(fetch, 0)).not.toHaveProperty(p)
    );
    expect(paths(fetch)).toEqual(["search"]);
  });

  test("kept for the reader's refresh interval, for that reader alone", async () => {
    const fetch = routeFetch([
      ["/search?", searchBody(["v1"])],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor({ catalogRefresh: "3h" });
    await browse.catalogItems({ entry, settings });
    await browse.catalogItems({ entry, settings });
    expect(fetch).toHaveBeenCalledTimes(2);
    // Another reader's key asks YouTube for their own.
    await browse.catalogItems({ entry, settings: normalizeConfig({ youtubeKey: "AIzaReader2", catalogRefresh: "3h" }) });
    expect(fetch).toHaveBeenCalledTimes(4);
    // Still current just before three hours, asked again after.
    Date.now.mockReturnValue(NOW + 3 * 60 * 60 * 1000 - 1);
    await browse.catalogItems({ entry, settings });
    expect(fetch).toHaveBeenCalledTimes(4);
    Date.now.mockReturnValue(NOW + 3 * 60 * 60 * 1000 + 1);
    await browse.catalogItems({ entry, settings });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  test("past its interval, served stale when YouTube cannot be asked", async () => {
    routeFetch([
      ["/search?", searchBody(["v1"])],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor();
    await browse.catalogItems({ entry, settings });
    Date.now.mockReturnValue(NOW + 3 * 60 * 60 * 1000);
    routeFetch([["/search?", googleError(403, "quotaExceeded")]]);
    expect((await browse.catalogItems({ entry, settings })).map((i) => i.id)).toEqual(["v1"]);
    // The spent key is then left alone: nothing more is asked of YouTube.
    const fetch = routeFetch([]);
    expect((await browse.catalogItems({ entry, settings })).map((i) => i.id)).toEqual(["v1"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a failure with nothing cached is thrown, and a search answering 400 is a failure, not an empty row", async () => {
    routeFetch([["/search?", googleError(400, "invalidSearchFilter")]]);
    await expect(browse.catalogItems({ entry, settings: settingsFor() })).rejects.toMatchObject({ kind: "error", status: 400 });
  });

  test("an interval past YouTube's 30 days is kept 30 days", async () => {
    const set = jest.spyOn(browseCache, "set");
    routeFetch([["/search?", searchBody([])]]);
    await browse.catalogItems({ entry, settings: settingsFor({ catalogRefresh: "90d" }) });
    expect(set.mock.calls[0][2]).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("two requests for the same page at once share one", async () => {
    const fetch = routeFetch([
      ["/search?", searchBody(["v1"])],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor();
    const [a, b] = await Promise.all([browse.catalogItems({ entry, settings }), browse.catalogItems({ entry, settings })]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("channel, playlist and Trending catalogs", () => {
  test("a channel's videos without Shorts, or its Shorts, newest or most viewed first, from the playlists YouTube keeps", async () => {
    const fetch = routeFetch([
      ["/playlistItems?", { items: [{ contentDetails: { videoId: "c1" } }] }],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor();
    const lists = [
      [{}, "UULF"],
      [{ show: "shorts" }, "UUSH"],
      [{ sort: "viewCount" }, "UULP"],
      [{ show: "shorts", sort: "viewCount" }, "UUPS"],
      [{ show: "live", sort: "viewCount" }, "UUPV"],
      [{ show: "all", sort: "viewCount" }, "PU"],
      [{ show: "all" }, "UU"]
    ];
    for (const [options] of lists) {
      await browse.catalogItems({ entry: normalizeEntry({ channel: "UCBJycsmduvYEL83R_U4JriQ", name: "MKBHD", ...options }), settings });
    }
    const asked = fetch.mock.calls.map((_, i) => params(fetch, i).playlistId).filter(Boolean);
    expect(asked).toEqual(lists.map(([, prefix]) => `${prefix}BJycsmduvYEL83R_U4JriQ`));
  });

  test("a playlist in its own order", async () => {
    const fetch = routeFetch([
      ["/playlistItems?", { items: [{ contentDetails: { videoId: "p2" } }, { contentDetails: { videoId: "p1" } }] }],
      ["/videos?", videosBody]
    ]);
    const items = await browse.catalogItems({ entry: normalizeEntry({ playlist: "PLBCF2DAC6FFB574DE", name: "x" }), settings: settingsFor() });
    expect(items.map((i) => i.id)).toEqual(["p2", "p1"]);
    expect(params(fetch, 0).playlistId).toBe("PLBCF2DAC6FFB574DE");
  });

  test("Trending in the reader's country, all or one category, in a single call", async () => {
    const fetch = routeFetch([["/videos?", { items: [apiVideo("t1"), apiVideo("t2")] }]]);
    const items = await browse.catalogItems({ entry: normalizeEntry({ trending: "music" }), settings: settingsFor({ region: "IN" }) });
    expect(items.map((i) => i.id)).toEqual(["t1", "t2"]);
    expect(params(fetch, 0)).toMatchObject({ chart: "mostPopular", regionCode: "IN", videoCategoryId: "10" });
    await browse.catalogItems({ entry: normalizeEntry({ trending: "all" }), settings: settingsFor() });
    expect(params(fetch, 1)).not.toHaveProperty("regionCode");
    expect(params(fetch, 1)).not.toHaveProperty("videoCategoryId");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("a playlist that is gone or private, or a chart a country lacks, is an empty row, kept like any other", async () => {
    let fetch = routeFetch([["/playlistItems?", googleError(404, "playlistNotFound")]]);
    const entry = normalizeEntry({ playlist: "PLBCF2DAC6FFB574DE", name: "x" });
    expect(await browse.catalogItems({ entry, settings: settingsFor() })).toEqual([]);
    expect(await browse.catalogItems({ entry, settings: settingsFor() })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch = routeFetch([["/videos?", googleError(400, "videoChartNotFound")]]);
    expect(await browse.catalogItems({ entry: normalizeEntry({ trending: "howto" }), settings: settingsFor({ region: "IS" }) })).toEqual([]);
  });

  test("an outage on a playlist is a failure, not an empty row", async () => {
    routeFetch([["/playlistItems?", googleError(503, "backendError")]]);
    await expect(
      browse.catalogItems({ entry: normalizeEntry({ playlist: "PLBCF2DAC6FFB574DE", name: "x" }), settings: settingsFor() })
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("pages", () => {
  const entry = normalizeEntry({ playlist: "PLBCF2DAC6FFB574DE", name: "x" });
  // Three pages of fifty, then the end; page 2 lost one video since it was listed.
  const playlist = (url) => {
    const token = new URL(url).searchParams.get("pageToken");
    if (!token) return { items: ids("a", 50).map((videoId) => ({ contentDetails: { videoId } })), nextPageToken: "P1" };
    if (token === "P1") return { items: [...ids("b", 49), "gone"].map((videoId) => ({ contentDetails: { videoId } })), nextPageToken: "P2" };
    return { items: ids("c", 50).map((videoId) => ({ contentDetails: { videoId } })) };
  };

  test("each answer stays within one page of YouTube's, and skip counts the videos already given", async () => {
    const fetch = routeFetch([
      ["/playlistItems?", playlist],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor();
    const first = await browse.catalogItems({ entry, settings, skip: "0" });
    expect(first).toHaveLength(50);
    expect(first[0].id).toBe("a000");
    // Nuvio asks again at the count it has.
    const second = await browse.catalogItems({ entry, settings, skip: "50" });
    expect(second.map((i) => i.id)).toEqual(ids("b", 49));
    const third = await browse.catalogItems({ entry, settings, skip: String(50 + 49) });
    expect(third.map((i) => i.id)).toEqual(ids("c", 50));
    // Stremio's declared steps land inside a page.
    expect((await browse.catalogItems({ entry, settings, skip: "100" })).map((i) => i.id)).toEqual(ids("c", 50).slice(1));
    // After the last page, nothing, and nothing more is asked of YouTube.
    const calls = fetch.mock.calls.length;
    expect(await browse.catalogItems({ entry, settings, skip: "149" })).toEqual([]);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  test("a deep page walks there through the pages before it, once", async () => {
    const fetch = routeFetch([
      ["/playlistItems?", playlist],
      ["/videos?", videosBody]
    ]);
    const items = await browse.catalogItems({ entry, settings: settingsFor(), skip: 120 });
    expect(items[0].id).toBe("c021");
    expect(paths(fetch).filter((p) => p === "playlistItems")).toHaveLength(3);
  });

  test("past their interval, the pages before a deep one are asked again on the way to it", async () => {
    routeFetch([
      ["/playlistItems?", playlist],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor();
    await browse.catalogItems({ entry, settings, skip: 50 });
    Date.now.mockReturnValue(NOW + 3 * 60 * 60 * 1000);
    const fetch = routeFetch([
      ["/playlistItems?", playlist],
      ["/videos?", videosBody]
    ]);
    expect((await browse.catalogItems({ entry, settings, skip: 50 }))[0].id).toBe("b000");
    const tokens = fetch.mock.calls.filter(([url]) => url.includes("/playlistItems?")).map(([url]) => new URL(url).searchParams.get("pageToken"));
    expect(tokens).toEqual([null, "P1"]);
  });

  test("never more than five pages deep, and skip that is no number is the start", async () => {
    const forever = (url) => {
      const token = new URL(url).searchParams.get("pageToken") || "0";
      const n = Number(token);
      return { items: ids(`p${n}x`, 50).map((videoId) => ({ contentDetails: { videoId } })), nextPageToken: String(n + 1) };
    };
    const fetch = routeFetch([
      ["/playlistItems?", forever],
      ["/videos?", videosBody]
    ]);
    const settings = settingsFor();
    expect(await browse.catalogItems({ entry, settings, skip: 250 })).toEqual([]);
    expect(paths(fetch).filter((p) => p === "playlistItems")).toHaveLength(5);
    expect((await browse.catalogItems({ entry, settings, skip: "soon" }))[0].id).toBe("p0x000");
    expect((await browse.catalogItems({ entry, settings, skip: -5 }))[0].id).toBe("p0x000");
  });

  test("an empty page with more after it is passed over", async () => {
    const sparse = (url) =>
      new URL(url).searchParams.get("pageToken")
        ? { items: [{ contentDetails: { videoId: "late1" } }] }
        : { items: [{ contentDetails: { videoId: "gone1" } }], nextPageToken: "T" };
    routeFetch([
      ["/playlistItems?", sparse],
      ["/videos?", videosBody]
    ]);
    expect((await browse.catalogItems({ entry, settings: settingsFor() })).map((i) => i.id)).toEqual(["late1"]);
  });
});

describe("what is offered", () => {
  const entry = normalizeEntry({ trending: "all" });
  const chart = (items) => routeFetch([["/videos?", { items }]]);

  test("not a premiere still to air, not blocked in the reader's country, embeddable when asked, never repeated", async () => {
    chart([
      apiVideo("ok1"),
      apiVideo("soon", { snippet: { liveBroadcastContent: "upcoming" } }),
      apiVideo("live", { snippet: { liveBroadcastContent: "live" }, contentDetails: { duration: "P0D" } }),
      apiVideo("notin", { contentDetails: { regionRestriction: { blocked: ["IN"] } } }),
      apiVideo("noembed", { status: { embeddable: false } }),
      apiVideo("ok1")
    ]);
    expect((await browse.catalogItems({ entry, settings: settingsFor({ region: "IN" }) })).map((i) => i.id)).toEqual(["ok1", "live", "noembed"]);
    expect((await browse.catalogItems({ entry, settings: settingsFor({ region: "IN", embeddableOnly: true }) })).map((i) => i.id)).toEqual([
      "ok1",
      "live"
    ]);
  });

  test("never what this server was asked to block", async () => {
    hostConfig.legal.blockedVideos.push("bad1");
    hostConfig.legal.blockedChannels.push("UCblocked");
    try {
      chart([apiVideo("ok1"), apiVideo("bad1"), apiVideo("ok2", { snippet: { channelId: "UCblocked" } })]);
      expect((await browse.catalogItems({ entry, settings: settingsFor() })).map((i) => i.id)).toEqual(["ok1"]);
    } finally {
      hostConfig.legal.blockedVideos.pop();
      hostConfig.legal.blockedChannels.pop();
    }
  });

  test("every video listed is then known by id, so opening one costs nothing", async () => {
    chart([apiVideo("ok1", { snippet: { tags: ["engines"], categoryId: "28" } })]);
    await browse.catalogItems({ entry, settings: settingsFor() });
    const fetch = routeFetch([]);
    const item = await browse.getItem("ok1", KEY);
    expect(item).toMatchObject({ id: "ok1", tags: ["engines"], category: "Science & Technology" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("getItem", () => {
  test("one videos.list when the video is not known, then kept for everyone", async () => {
    const fetch = routeFetch([["/videos?", videosBody]]);
    expect((await browse.getItem("abcdefghijk", KEY)).id).toBe("abcdefghijk");
    expect(params(fetch, 0)).toMatchObject({ id: "abcdefghijk", part: "snippet,contentDetails,statistics,status" });
    expect((await browse.getItem("abcdefghijk", "AIzaSomeoneElse")).id).toBe("abcdefghijk");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("null for a video YouTube no longer has, even one known before", async () => {
    await videoCache.set("gone12345ab", { id: "gone12345ab" });
    Date.now.mockReturnValue(NOW + 2 * 24 * 60 * 60 * 1000);
    routeFetch([["/videos?", { items: [] }]]);
    expect(await browse.getItem("gone12345ab", KEY)).toBeNull();
  });

  test("an old copy when YouTube fails, else the failure", async () => {
    await videoCache.set("abcdefghijk", { id: "abcdefghijk", title: "old" });
    Date.now.mockReturnValue(NOW + 2 * 24 * 60 * 60 * 1000);
    routeFetch([["/videos?", googleError(503, "backendError")]]);
    expect((await browse.getItem("abcdefghijk", KEY)).title).toBe("old");
    await expect(browse.getItem("zzzzzzzzzzz", KEY)).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("live search", () => {
  const noWait = { settleOptions: { waitMs: 0, signal: null } };
  const searchRoutes = () =>
    routeFetch([
      ["/search?", (url) => searchBody([`${new URL(url).searchParams.get("q").replace(/\W/g, "")}1`], "NEXT")],
      ["/videos?", videosBody]
    ]);

  test("YouTube's results, ranked as the reader chose, with their length filter and SafeSearch", async () => {
    const fetch = searchRoutes();
    const settings = settingsFor({ searchSort: "viewCount", searchLength: "medium", safeSearch: "none", region: "GB" });
    const result = await browse.searchItems({ query: "  interstellar   docking ", settings, ...noWait });
    expect(result).toEqual({ items: [expect.objectContaining({ id: "interstellardocking1" })], skipped: false });
    expect(params(fetch, 0)).toMatchObject({ q: "interstellar docking", order: "viewCount", videoDuration: "medium", safeSearch: "none", regionCode: "GB" });
    expect(params(fetch, 0)).not.toHaveProperty("publishedAfter");
  });

  test.each([[""], ["in"], ["  a "], [undefined], [5]])("nothing is searched for %p", async (query) => {
    const fetch = searchRoutes();
    expect(await browse.searchItems({ query, settings: settingsFor(), ...noWait })).toEqual({ items: [], skipped: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a character or two is enough in a script that packs a word into them", async () => {
    searchRoutes();
    expect((await browse.searchItems({ query: "猫", settings: settingsFor(), ...noWait })).skipped).toBe(false);
    expect((await browse.searchItems({ query: "고양", settings: settingsFor(), ...noWait })).skipped).toBe(false);
    expect(browse.searchable("int")).toBe(true);
    expect(browse.searchable("in")).toBe(false);
  });

  test("kept two minutes, so going back or scrolling on costs nothing, then asked again", async () => {
    const fetch = searchRoutes();
    const settings = settingsFor();
    await browse.searchItems({ query: "interstellar", settings, ...noWait });
    // No wait for typing to settle when the answer is already here.
    const wait = { settleOptions: { waitMs: 60000, signal: null } };
    expect((await browse.searchItems({ query: "interstellar", settings, ...wait })).skipped).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    Date.now.mockReturnValue(NOW + 2 * 60 * 1000 + 1);
    await browse.searchItems({ query: "interstellar", settings, ...noWait });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test("its pages are kept minutes, not days", async () => {
    const set = jest.spyOn(browseCache, "set");
    searchRoutes();
    await browse.searchItems({ query: "interstellar", settings: settingsFor(), ...noWait });
    expect(set.mock.calls[0].slice(2)).toEqual([browse.SEARCH_REUSE_MS, browse.SEARCH_STALE_MS]);
    expect(browse.SEARCH_STALE_MS).toBe(10 * 60 * 1000);
  });

  test("scrolling on does not wait for typing to settle", async () => {
    const fetch = searchRoutes();
    const settings = settingsFor();
    const wait = { settleOptions: { waitMs: 60000, signal: null } };
    await browse.searchItems({ query: "interstellar", settings, ...noWait });
    const more = await browse.searchItems({ query: "interstellar", settings, skip: "1", ...wait });
    expect(more.skipped).toBe(false);
    expect(params(fetch, 2).pageToken).toBe("NEXT");
  });

  test("a search overtaken by a newer one from the same reader is never made", async () => {
    const fetch = searchRoutes();
    const settings = settingsFor();
    const first = browse.searchItems({ query: "inte", settings, settleOptions: { waitMs: 30, signal: null } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = browse.searchItems({ query: "interstellar", settings, settleOptions: { waitMs: 0, signal: null } });
    expect(await first).toEqual({ items: [], skipped: true });
    expect((await second).items[0].id).toBe("interstellar1");
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("q")).filter(Boolean)).toEqual(["interstellar"]);
  });

  test("but the same search sent twice is made once, and another reader's never stands in the way", async () => {
    const fetch = searchRoutes();
    const a = browse.searchItems({ query: "interstellar", settings: settingsFor(), settleOptions: { waitMs: 20, signal: null } });
    const b = browse.searchItems({ query: "interstellar", settings: settingsFor(), settleOptions: { waitMs: 0, signal: null } });
    const other = browse.searchItems({ query: "dune", settings: normalizeConfig({ youtubeKey: "AIzaReader2" }), settleOptions: { waitMs: 0, signal: null } });
    expect((await a).skipped).toBe(false);
    expect((await b).skipped).toBe(false);
    expect((await other).skipped).toBe(false);
    expect(paths(fetch).filter((p) => p === "search")).toHaveLength(2);
  });

  test("a search the app gave up on while it waited is never made", async () => {
    const fetch = searchRoutes();
    const controller = new AbortController();
    const pending = browse.searchItems({ query: "interstellar", settings: settingsFor(), settleOptions: { waitMs: 20, signal: controller.signal } });
    controller.abort();
    expect(await pending).toEqual({ items: [], skipped: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("the request's own signal is used when none is given", async () => {
    searchRoutes();
    const controller = new AbortController();
    controller.abort();
    const result = await storage.run({ signal: controller.signal }, () => browse.settle("user", "q", { waitMs: 0 }));
    expect(result).toBe(false);
    expect(await browse.settle("user", "q", { waitMs: 0 })).toBe(true);
  });

  test("a reader's newest search is remembered a minute, then forgotten", async () => {
    await browse.settle("someone", "q", { waitMs: 0, signal: null });
    expect(browse.latestSearch.has("someone")).toBe(true);
    Date.now.mockReturnValue(NOW + 61 * 1000);
    await browse.settle("someone else", "q", { waitMs: 0, signal: null });
    expect(browse.latestSearch.has("someone")).toBe(false);
    // Forgotten while it waited, a search still goes through.
    const pending = browse.settle("someone", "q", { waitMs: 10, signal: null });
    browse.latestSearch.clear();
    expect(await pending).toBe(true);
  });

  test("still typing: their last search, seconds ago, began this one or this began it, and the slowest gap between their letters is kept", () => {
    expect(browse.slowestGap("typist", "interstellar", NOW)).toBe(0);
    browse.latestSearch.set("typist", { ticket: 1, q: "Inter", at: NOW - 1000, slowest: 0 });
    expect(browse.slowestGap("typist", "interstellar", NOW)).toBe(1000);
    // Deleting letters is typing too.
    expect(browse.slowestGap("typist", "INT", NOW)).toBe(1000);
    // Something else, or the same after a pause, begins anew.
    expect(browse.slowestGap("typist", "dune", NOW)).toBe(0);
    expect(browse.slowestGap("typist", "interstellar", NOW + 4000)).toBe(0);
    expect(browse.slowestGap("someone else", "interstellar", NOW)).toBe(0);
    browse.latestSearch.set("typist", { ticket: 2, q: "Inter", at: NOW - 1000, slowest: 3000 });
    expect(browse.slowestGap("typist", "interstellar", NOW)).toBe(3000);
  });

  test("the wait: a second, or while typing the slowest gap and half as much again, at most five seconds", () => {
    expect(browse.settleMsFor(0)).toBe(browse.SEARCH_SETTLE_MS);
    expect(browse.settleMsFor(200)).toBe(browse.SEARCH_SETTLE_MS);
    expect(browse.settleMsFor(1000)).toBe(2000);
    expect(browse.settleMsFor(2000)).toBe(3500);
    expect(browse.settleMsFor(4999)).toBe(browse.MAX_TYPING_SETTLE_MS);
  });

  test("two letters are not searched, but say the reader is typing", async () => {
    const fetch = searchRoutes();
    const settings = settingsFor();
    expect(await browse.searchItems({ query: " in ", settings, ...noWait })).toEqual({ items: [], skipped: true });
    // The search their next letter makes waits for the one after it.
    expect(browse.slowestGap(youtube.keyId(KEY), "int", NOW + 2000)).toBe(2000);
    // A search still waiting when they delete back to two letters is dropped.
    const pending = browse.searchItems({ query: "dune", settings, settleOptions: { waitMs: 30, signal: null } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await browse.searchItems({ query: "du", settings, ...noWait });
    expect(await pending).toEqual({ items: [], skipped: true });
    // Nothing at all is not typing.
    browse.latestSearch.clear();
    await browse.searchItems({ query: "  ", settings, ...noWait });
    expect(browse.latestSearch.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("the defaults: a second's wait, longer while the reader is still typing", async () => {
    expect(browse.SEARCH_SETTLE_MS).toBe(1000);
    expect(browse.TYPING_GAP_MS).toBe(5000);
    expect(browse.MAX_TYPING_SETTLE_MS).toBe(5000);
    jest.useFakeTimers({ doNotFake: ["Date"] });
    const waits = async (q, ms) => {
      const pending = browse.settle("timed", q);
      let done = false;
      pending.then(() => {
        done = true;
      });
      jest.advanceTimersByTime(ms - 1);
      await Promise.resolve();
      expect(done).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await pending).toBe(true);
    };
    try {
      await waits("dun", 1000);
      // The next letter, two seconds later.
      Date.now.mockReturnValue(NOW + 2000);
      await waits("dune", 3500);
      Date.now.mockReturnValue(NOW + 4000);
      await waits("matrix", 1000);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("resolveSource", () => {
  test("text that is no link is a search", async () => {
    expect(await browse.resolveSource(KEY, "lofi hip hop")).toEqual({ search: true });
  });

  test("a YouTube link that is no channel or playlist says why, without asking YouTube", async () => {
    const fetch = routeFetch([]);
    expect((await browse.resolveSource(KEY, "https://youtu.be/abcdefghijk")).error).toContain("one video");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a channel by @handle becomes a channel catalog", async () => {
    const fetch = routeFetch([["/channels?", { items: [{ id: "UCBJycsmduvYEL83R_U4JriQ", snippet: { title: "Marques Brownlee" } }] }]]);
    expect(await browse.resolveSource(KEY, "@mkbhd")).toEqual({ entry: normalizeEntry({ channel: "UCBJycsmduvYEL83R_U4JriQ", name: "Marques Brownlee" }) });
    expect(params(fetch, 0).forHandle).toBe("@mkbhd");
  });

  test("a playlist link becomes a playlist catalog", async () => {
    routeFetch([["/playlists?", { items: [{ id: "PLBCF2DAC6FFB574DE", snippet: { title: "Stories" } }] }]]);
    expect(await browse.resolveSource(KEY, "https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE")).toEqual({
      entry: normalizeEntry({ playlist: "PLBCF2DAC6FFB574DE", name: "Stories" })
    });
  });

  test("no such channel or playlist", async () => {
    routeFetch([
      ["/channels?", {}],
      ["/playlists?", { items: [] }]
    ]);
    expect((await browse.resolveSource(KEY, "@nobodyatall")).error).toContain("no channel");
    expect((await browse.resolveSource(KEY, "PLBCF2DAC6FFB574DE")).error).toContain("no public playlist");
    // An answer YouTube gives that is not a usable id is no catalog either.
    routeFetch([["/channels?", { items: [{ id: "not-a-channel-id" }] }]]);
    expect((await browse.resolveSource(KEY, "@odd")).error).toContain("no channel");
  });

  test("YouTube refusing says why in the reader's terms", async () => {
    routeFetch([["/channels?", googleError(403, "quotaExceeded")]]);
    expect((await browse.resolveSource(KEY, "@mkbhd")).error).toContain("spent today's quota");
    expect((await browse.resolveSource(KEY, "@mkbhd")).error).toContain("spent today's quota");
    routeFetch([["/channels?", googleError(400, "keyInvalid")]]);
    expect((await browse.resolveSource("AIzaOther", "@mkbhd")).error).toContain("not valid");
    routeFetch([["/channels?", googleError(400, "somethingElse")]]);
    expect((await browse.resolveSource("AIzaOther", "@mkbhd")).error).toBe("YouTube could not look that up: somethingElse");
    expect(await keyCooldown.get(youtube.keyId("AIzaOther"))).toBeUndefined();
  });
});

test("publishedAfter: the period before now, on the hour; nothing for any time", () => {
  expect(browse.publishedAfter("day", NOW)).toBe("2026-10-18T12:00:00.000Z");
  expect(browse.publishedAfter("year", NOW)).toBe("2025-10-19T12:00:00.000Z");
  expect(browse.publishedAfter("any", NOW)).toBeUndefined();
  expect(browse.publishedAfter("never", NOW)).toBeUndefined();
  expect(browse.publishedAfter("week")).toBe("2026-10-12T12:00:00.000Z");
});
