const { searchCache, keyCooldown } = require("../src/cache");
const youtube = require("../src/youtube");
const { response, routeFetch, apiVideo, freshCache, TEST_CACHE } = require("./helpers");

beforeEach(() => {
  freshCache();
  youtube.inFlight.clear();
  jest.restoreAllMocks();
});

const searchBody = (ids, extra = {}) => ({ items: ids.map((videoId) => ({ id: { videoId } })), ...extra });
const googleError = (status, reasons, { details = [], message = "nope" } = {}) =>
  response(
    { error: { code: status, message, errors: reasons.map((reason) => ({ reason })), details: details.map((reason) => ({ reason })) } },
    { status }
  );

const PARAMS = { apiKey: "KEY", q: "Kota Factory season 1 episode 3" };

describe("searchVideos", () => {
  test("searches once and enriches once, keeping YouTube's order", async () => {
    const fetch = routeFetch([
      ["/search?", searchBody(["b", "a", "gone"])],
      ["/videos?", { items: [apiVideo("a"), apiVideo("b")] }]
    ]);
    const { videos, cached } = await youtube.searchVideos({
      ...PARAMS,
      regionCode: "IN",
      relevanceLanguage: "hi",
      videoDuration: "long",
      embeddableOnly: true
    });
    expect(cached).toBe(false);
    expect(videos.map((v) => v.id)).toEqual(["b", "a"]);

    const search = new URL(fetch.mock.calls[0][0]);
    expect(Object.fromEntries(search.searchParams)).toEqual({
      key: "KEY",
      part: "snippet",
      type: "video",
      q: PARAMS.q,
      maxResults: "50",
      regionCode: "IN",
      relevanceLanguage: "hi",
      videoDuration: "long",
      videoEmbeddable: "true"
    });
    const videosCall = new URL(fetch.mock.calls[1][0]);
    expect(videosCall.searchParams.get("id")).toBe("b,a,gone");
    expect(videosCall.searchParams.get("part")).toBe("snippet,contentDetails,statistics,status");
  });

  test("leaves out the optional filters it was not given", async () => {
    const fetch = routeFetch([["/search?", searchBody([])]]);
    await youtube.searchVideos(PARAMS);
    const params = new URL(fetch.mock.calls[0][0]).searchParams;
    ["regionCode", "relevanceLanguage", "videoDuration", "videoEmbeddable"].forEach((p) => expect(params.has(p)).toBe(false));
  });

  test("an empty search costs no enrichment call", async () => {
    const fetch = routeFetch([["/search?", { items: "nothing" }]]);
    expect((await youtube.searchVideos(PARAMS)).videos).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("skips malformed search items", async () => {
    routeFetch([
      ["/search?", { items: [null, { id: {} }, { id: { videoId: 5 } }, { id: { videoId: "ok" } }] }],
      ["/videos?", { items: "x" }]
    ]);
    expect((await youtube.searchVideos(PARAMS)).videos).toEqual([]);
  });

  test("caches a search for everyone, whoever's key asked", async () => {
    const fetch = routeFetch([
      ["/search?", searchBody(["a"])],
      ["/videos?", { items: [apiVideo("a")] }]
    ]);
    await youtube.searchVideos(PARAMS);
    const again = await youtube.searchVideos({ ...PARAMS, apiKey: "OTHER", q: PARAMS.q.toUpperCase() });
    expect(again.cached).toBe(true);
    expect(again.videos).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("nothing stored names the key", async () => {
    const store = freshCache();
    routeFetch([
      ["/search?", searchBody(["a"])],
      ["/videos?", { items: [apiVideo("a")] }]
    ]);
    await youtube.searchVideos(PARAMS);
    const stored = [...store.entries].map(([key, entry]) => key + entry.text).join();
    expect(stored).not.toContain("KEY");
  });

  test("different filters are different searches", async () => {
    const fetch = routeFetch([["/search?", searchBody([])]]);
    await youtube.searchVideos(PARAMS);
    await youtube.searchVideos({ ...PARAMS, regionCode: "IN" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("concurrent identical lookups share one request", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const fetch = routeFetch([["/search?", async () => (await gate, response(searchBody([])))]]);
    const first = youtube.searchVideos(PARAMS);
    const second = youtube.searchVideos(PARAMS);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(youtube.inFlight.size).toBe(0);
  });

  test("a spent quota puts the key on cooldown, and the next lookup does not call YouTube", async () => {
    const fetch = routeFetch([["/search?", googleError(403, ["quotaExceeded"])]]);
    await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({ kind: "quota" });
    expect(await keyCooldown.get(youtube.keyId("KEY"))).toEqual({ value: true, fresh: true });
    await expect(youtube.searchVideos({ ...PARAMS, q: "other" })).rejects.toMatchObject({ kind: "quota" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a cached search is still served to a key on cooldown", async () => {
    routeFetch([["/search?", searchBody([])]]);
    await youtube.searchVideos(PARAMS);
    await keyCooldown.set(youtube.keyId("KEY"), true);
    expect((await youtube.searchVideos(PARAMS)).cached).toBe(true);
  });

  test("other failures do not start a cooldown, and are not cached", async () => {
    routeFetch([["/search?", googleError(400, ["keyInvalid"])]]);
    await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({ kind: "invalid", status: 400, message: "nope" });
    expect(await keyCooldown.count()).toBe(0);
    expect(await searchCache.count()).toBe(0);
    expect(youtube.inFlight.size).toBe(0);
  });

  test("a search is current for as long as the caller says", async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(start);
    const fetch = routeFetch([["/search?", searchBody([])]]);
    await youtube.searchVideos({ ...PARAMS, freshMs: 60000 });
    clock.mockReturnValue(start + 59000);
    expect((await youtube.searchVideos(PARAMS)).cached).toBe(true);
    clock.mockReturnValue(start + 61000);
    expect((await youtube.searchVideos(PARAMS)).cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("with the cache turned off, every lookup searches", async () => {
    freshCache({ searchMs: 0 });
    const fetch = routeFetch([["/search?", searchBody([])]]);
    await youtube.searchVideos(PARAMS);
    await youtube.searchVideos(PARAMS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe("an out-of-date search", () => {
    let clock;
    let start;
    const searchFails = (error) =>
      routeFetch([["/search?", error], ["/videos?", { items: [apiVideo("a")] }]]);

    beforeEach(async () => {
      start = Date.now();
      clock = jest.spyOn(Date, "now").mockReturnValue(start);
      routeFetch([
        ["/search?", searchBody(["a"])],
        ["/videos?", { items: [apiVideo("a")] }]
      ]);
      await youtube.searchVideos(PARAMS);
      clock.mockReturnValue(start + TEST_CACHE.searchMs + 1);
    });

    test("is searched again", async () => {
      const fetch = routeFetch([["/search?", searchBody([])]]);
      expect(await youtube.searchVideos(PARAMS)).toEqual({ videos: [], cached: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["a spent quota", googleError(403, ["quotaExceeded"]), "quota"],
      ["an outage", response(null, { status: 503, json: false }), "unavailable"],
      ["an unreachable YouTube", new Error("ETIMEDOUT"), "unavailable"]
    ])("stands in for %s, saying so", async (_, error, kind) => {
      searchFails(error);
      const result = await youtube.searchVideos(PARAMS);
      expect(result).toMatchObject({ cached: true, stale: kind });
      expect(result.videos.map((v) => v.id)).toEqual(["a"]);
    });

    test("stands in for a key already on cooldown, without calling YouTube", async () => {
      await keyCooldown.set(youtube.keyId("KEY"), true);
      const fetch = routeFetch([]);
      expect(await youtube.searchVideos(PARAMS)).toMatchObject({ cached: true, stale: "quota" });
      expect(fetch).not.toHaveBeenCalled();
    });

    test("is not kept past 30 days in all, whatever the host asked for", async () => {
      freshCache({ staleMs: 365 * 24 * 60 * 60 * 1000 });
      clock.mockReturnValue(start);
      routeFetch([["/search?", searchBody(["a"])], ["/videos?", { items: [apiVideo("a")] }]]);
      await youtube.searchVideos(PARAMS);
      clock.mockReturnValue(start + 30 * 24 * 60 * 60 * 1000 + 1);
      searchFails(googleError(403, ["quotaExceeded"]));
      await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({ kind: "quota" });
    });
  });

  test("an unreachable YouTube", async () => {
    routeFetch([["/search?", new Error("ETIMEDOUT")]]);
    await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({
      kind: "unavailable",
      message: "Could not reach YouTube: ETIMEDOUT"
    });
  });

  test("a reply that is not JSON", async () => {
    routeFetch([["/search?", response(null, { status: 502, json: false })]]);
    await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({
      kind: "unavailable",
      message: "YouTube returned HTTP 502"
    });
  });

  test("an error body on a 200", async () => {
    routeFetch([["/search?", { error: { errors: "x", details: "y" } }]]);
    await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({ kind: "error" });
  });
});

describe("classify", () => {
  test.each([
    [["quotaExceeded"], "quota"],
    [["dailyLimitExceeded"], "quota"],
    [["userRateLimitExceeded"], "rate"],
    [["RATE_LIMIT_EXCEEDED"], "rate"],
    [["badRequest", "API_KEY_INVALID"], "invalid"],
    [["keyExpired"], "invalid"],
    [["forbidden", "SERVICE_DISABLED"], "disabled"],
    [["accessNotConfigured"], "disabled"],
    [["forbidden", "API_KEY_HTTP_REFERRER_BLOCKED"], "restricted"],
    [["ipRefererBlocked"], "restricted"],
    [["API_KEY_SERVICE_BLOCKED"], "restricted"],
    [["forbidden"], "invalid"]
  ])("%p is %s", (reasons, kind) => {
    expect(youtube.classify(403, reasons)).toBe(kind);
  });

  test("an unexplained server error is an outage, anything else a plain error", () => {
    expect(youtube.classify(503, [])).toBe("unavailable");
    expect(youtube.classify(400, ["invalidRegionCode"])).toBe("error");
  });
});

describe("toVideo", () => {
  test("keeps what matching and the stream list use", () => {
    const v = youtube.toVideo(
      apiVideo("abc", {
        snippet: { title: "T", description: "D".repeat(2000), channelTitle: "C", channelId: "UC1", defaultAudioLanguage: "hi-IN" },
        contentDetails: {
          duration: "PT36M51S",
          definition: "sd",
          licensedContent: true,
          contentRating: { ytRating: "ytAgeRestricted" },
          regionRestriction: { blocked: ["US"] }
        },
        statistics: { viewCount: "1500" },
        status: { embeddable: false }
      })
    );
    expect(v).toEqual({
      id: "abc",
      title: "T",
      description: "D".repeat(1500),
      channelTitle: "C",
      channelId: "UC1",
      publishedAt: "2021-05-01T00:00:00Z",
      durationSeconds: 2211,
      definition: "sd",
      views: 1500,
      language: "hi",
      live: null,
      embeddable: false,
      ageRestricted: true,
      licensed: true,
      regionAllowed: null,
      regionBlocked: ["US"]
    });
  });

  test("is safe on a sparse record", () => {
    expect(youtube.toVideo({ id: "x" })).toEqual({
      id: "x",
      title: "",
      description: "",
      channelTitle: "",
      channelId: "",
      publishedAt: null,
      durationSeconds: null,
      definition: "sd",
      views: null,
      language: null,
      live: null,
      embeddable: true,
      ageRestricted: false,
      licensed: false,
      regionAllowed: null,
      regionBlocked: null
    });
  });

  test("marks live and upcoming broadcasts, and reads an allow-list", () => {
    const v = youtube.toVideo(
      apiVideo("x", {
        snippet: { liveBroadcastContent: "upcoming", defaultLanguage: "en" },
        contentDetails: { regionRestriction: { allowed: ["IN"] } }
      })
    );
    expect(v.live).toBe("upcoming");
    expect(v.language).toBe("en");
    expect(v.regionAllowed).toEqual(["IN"]);
  });
});

describe("durationToSeconds", () => {
  test.each([
    ["PT2H22M", 8520],
    ["PT36M51S", 2211],
    ["PT45S", 45],
    ["P1DT1H", 90000],
    ["P0D", null],
    ["", null],
    [undefined, null]
  ])("%p", (iso, seconds) => {
    expect(youtube.durationToSeconds(iso)).toBe(seconds);
  });
});

describe("checkKey", () => {
  test("ok costs one videos.list call", async () => {
    const fetch = routeFetch([["/videos?", { items: [] }]]);
    expect(await youtube.checkKey("KEY")).toBe("ok");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("part")).toBe("id");
  });

  test.each([
    [["quotaExceeded"], "quota"],
    [["rateLimitExceeded"], "quota"],
    [["keyInvalid"], "invalid"],
    [["accessNotConfigured"], "disabled"],
    [["ipRefererBlocked"], "restricted"],
    [["somethingElse"], "unreachable"]
  ])("%p reads as %s", async (reasons, status) => {
    routeFetch([["/videos?", googleError(403, reasons)]]);
    expect(await youtube.checkKey("KEY")).toBe(status);
  });

  test("a network failure is unreachable", async () => {
    routeFetch([["/videos?", new Error("down")]]);
    expect(await youtube.checkKey("KEY")).toBe("unreachable");
  });
});

describe("quotaCooldownMs", () => {
  test("lasts until the quota resets at midnight Pacific time", () => {
    // 23:30 in Los Angeles (PDT, UTC-7) is 06:30 UTC.
    expect(youtube.quotaCooldownMs(new Date("2026-10-12T06:30:00.000Z"))).toBe(30 * 60 * 1000);
  });

  test("but never more than an hour", () => {
    expect(youtube.quotaCooldownMs(new Date("2026-10-12T15:00:00.000Z"))).toBe(60 * 60 * 1000);
  });

  test("and never less than a second", () => {
    expect(youtube.quotaCooldownMs(new Date("2026-10-12T06:59:59.999Z"))).toBe(1000);
  });

  test("defaults to now", () => {
    expect(youtube.quotaCooldownMs()).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

test("keyId is a short, stable fingerprint, not the key", () => {
  expect(youtube.keyId("KEY")).toBe(youtube.keyId("KEY"));
  expect(youtube.keyId("KEY")).not.toContain("KEY");
  expect(youtube.keyId("KEY")).toHaveLength(16);
});

describe("browsing calls", () => {
  const params = (fetch, i = 0) => Object.fromEntries(new URL(fetch.mock.calls[i][0]).searchParams);

  test("searchPage: ids only, every filter YouTube takes, and the next page's token", async () => {
    const fetch = routeFetch([["/search?", searchBody(["a", "b", null], { nextPageToken: "NEXT" })]]);
    const page = await youtube.searchPage({
      apiKey: "KEY",
      q: "lofi",
      order: "date",
      videoDuration: "long",
      publishedAfter: "2026-10-12T00:00:00.000Z",
      safeSearch: "strict",
      regionCode: "IN",
      relevanceLanguage: "hi",
      embeddableOnly: true,
      pageToken: "TOKEN"
    });
    expect(page).toEqual({ ids: ["a", "b"], next: "NEXT" });
    expect(params(fetch)).toEqual({
      key: "KEY",
      part: "id",
      type: "video",
      q: "lofi",
      maxResults: "50",
      order: "date",
      videoDuration: "long",
      publishedAfter: "2026-10-12T00:00:00.000Z",
      safeSearch: "strict",
      regionCode: "IN",
      relevanceLanguage: "hi",
      videoEmbeddable: "true",
      pageToken: "TOKEN"
    });
  });

  test("searchPage: the last page has no token, and filters not given are left out", async () => {
    const fetch = routeFetch([["/search?", {}]]);
    expect(await youtube.searchPage({ apiKey: "KEY", q: "lofi" })).toEqual({ ids: [], next: null });
    ["order", "videoDuration", "publishedAfter", "safeSearch", "regionCode", "videoEmbeddable", "pageToken"].forEach((p) =>
      expect(params(fetch)).not.toHaveProperty(p)
    );
  });

  test("playlistPage: a playlist's video ids in its order", async () => {
    const fetch = routeFetch([
      ["/playlistItems?", { items: [{ contentDetails: { videoId: "x" } }, { snippet: {} }, { contentDetails: { videoId: "y" } }], nextPageToken: "N" }]
    ]);
    expect(await youtube.playlistPage({ apiKey: "KEY", playlistId: "UULFabc", pageToken: "T" })).toEqual({ ids: ["x", "y"], next: "N" });
    expect(params(fetch)).toEqual({ key: "KEY", part: "contentDetails", playlistId: "UULFabc", maxResults: "50", pageToken: "T" });
    routeFetch([["/playlistItems?", {}]]);
    expect(await youtube.playlistPage({ apiKey: "KEY", playlistId: "UULFabc" })).toEqual({ ids: [], next: null });
  });

  test("chartPage: YouTube's most popular in a country and category, with their details", async () => {
    const fetch = routeFetch([["/videos?", { items: [apiVideo("p")], nextPageToken: "N" }]]);
    const page = await youtube.chartPage({ apiKey: "KEY", regionCode: "IN", videoCategoryId: "10" });
    expect(page.details.map((d) => d.id)).toEqual(["p"]);
    expect(page.next).toBe("N");
    expect(params(fetch)).toEqual({
      key: "KEY",
      part: "snippet,contentDetails,statistics,status",
      chart: "mostPopular",
      regionCode: "IN",
      videoCategoryId: "10",
      maxResults: "50"
    });
    routeFetch([["/videos?", {}]]);
    expect(await youtube.chartPage({ apiKey: "KEY" })).toEqual({ details: [], next: null });
  });

  test("videosById: in the order asked for, leaving out videos that have gone; nothing asked, no call", async () => {
    const fetch = routeFetch([["/videos?", { items: [apiVideo("b"), apiVideo("a")] }]]);
    expect((await youtube.videosById("KEY", ["a", "gone", "b"])).map((v) => v.id)).toEqual(["a", "b"]);
    expect(await youtube.videosById("KEY", [])).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    routeFetch([["/videos?", {}]]);
    expect(await youtube.videosById("KEY", ["a"])).toEqual([]);
  });

  test("findChannel: by id, @handle or username", async () => {
    const fetch = routeFetch([["/channels?", { items: [{ id: "UCx", snippet: { title: "Some Channel" } }] }]]);
    expect(await youtube.findChannel("KEY", { handle: "@some" })).toEqual({ id: "UCx", title: "Some Channel" });
    expect(params(fetch)).toEqual({ key: "KEY", part: "snippet", forHandle: "@some" });
    await youtube.findChannel("KEY", { id: "UCx" });
    expect(params(fetch, 1)).toMatchObject({ id: "UCx" });
    await youtube.findChannel("KEY", { username: "old" });
    expect(params(fetch, 2)).toMatchObject({ forUsername: "old" });
    routeFetch([["/channels?", { items: [{ id: "UCy" }] }]]);
    expect(await youtube.findChannel("KEY", { id: "UCy" })).toEqual({ id: "UCy", title: "" });
    routeFetch([["/channels?", {}]]);
    expect(await youtube.findChannel("KEY", { handle: "@nobody" })).toBeNull();
  });

  test("findPlaylist: a public playlist by id", async () => {
    const fetch = routeFetch([["/playlists?", { items: [{ id: "PLx", snippet: { title: "Lectures" } }] }]]);
    expect(await youtube.findPlaylist("KEY", "PLx")).toEqual({ id: "PLx", title: "Lectures" });
    expect(params(fetch)).toEqual({ key: "KEY", part: "snippet", id: "PLx" });
    routeFetch([["/playlists?", { items: [{ id: "PLy" }] }]]);
    expect(await youtube.findPlaylist("KEY", "PLy")).toEqual({ id: "PLy", title: "" });
    routeFetch([["/playlists?", { items: [] }]]);
    expect(await youtube.findPlaylist("KEY", "PLz")).toBeNull();
    routeFetch([["/playlists?", {}]]);
    expect(await youtube.findPlaylist("KEY", "PLz")).toBeNull();
  });
});

describe("withKey", () => {
  test("runs a call, and a key that spends its quota is left alone until it resets", async () => {
    expect(await youtube.withKey("KEY", async () => "ok")).toBe("ok");
    const quota = Object.assign(new Error("spent"), { kind: "quota" });
    await expect(youtube.withKey("KEY", async () => { throw quota; })).rejects.toBe(quota);
    expect((await keyCooldown.get(youtube.keyId("KEY"))).value).toBe(true);
    const run = jest.fn();
    await expect(youtube.withKey("KEY", run)).rejects.toMatchObject({ kind: "quota" });
    expect(run).not.toHaveBeenCalled();
  });

  test("any other failure says nothing about the key", async () => {
    const outage = Object.assign(new Error("down"), { kind: "unavailable" });
    await expect(youtube.withKey("KEY2", async () => { throw outage; })).rejects.toBe(outage);
    expect(await keyCooldown.get(youtube.keyId("KEY2"))).toBeUndefined();
  });
});
