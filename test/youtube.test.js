const { clearAllCaches, searchCache, keyCooldown } = require("../src/cache");
const youtube = require("../src/youtube");
const { response, routeFetch, apiVideo } = require("./helpers");

beforeEach(() => {
  clearAllCaches();
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
    expect([...searchCache.store.keys()].join()).not.toContain("KEY");
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
    expect(keyCooldown.has(youtube.keyId("KEY"))).toBe(true);
    await expect(youtube.searchVideos({ ...PARAMS, q: "other" })).rejects.toMatchObject({ kind: "quota" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a cached search is still served to a key on cooldown", async () => {
    routeFetch([["/search?", searchBody([])]]);
    await youtube.searchVideos(PARAMS);
    keyCooldown.set(youtube.keyId("KEY"), true);
    expect((await youtube.searchVideos(PARAMS)).cached).toBe(true);
  });

  test("other failures do not start a cooldown, and are not cached", async () => {
    routeFetch([["/search?", googleError(400, ["keyInvalid"])]]);
    await expect(youtube.searchVideos(PARAMS)).rejects.toMatchObject({ kind: "invalid", status: 400, message: "nope" });
    expect(keyCooldown.size).toBe(0);
    expect(searchCache.size).toBe(0);
    expect(youtube.inFlight.size).toBe(0);
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

test("keyId is a short, stable fingerprint, not the key", () => {
  expect(youtube.keyId("KEY")).toBe(youtube.keyId("KEY"));
  expect(youtube.keyId("KEY")).not.toContain("KEY");
  expect(youtube.keyId("KEY")).toHaveLength(16);
});
