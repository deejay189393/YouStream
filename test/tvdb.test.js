const tvdb = require("../src/metadata/tvdb");
const { response, routeFetch, freshCache } = require("./helpers");

const CREDS = { key: "KEY", pin: null };
const login = (token = "tok1") => [/\/login$/, () => ({ data: { token }, status: "success" })];

const season = (episodes) => ({ data: { series: { id: 297358 }, episodes }, status: "success" });
const EPISODES = [
  { id: 5245431, seasonNumber: 1, number: 1, name: "Tu Beer Hai", aired: "2015-06-03", runtime: 41, absoluteNumber: 1 },
  { id: 5245432, seasonNumber: 1, number: 2, name: "And Then There Were Four", aired: "2015-06-10", runtime: 48 },
  { id: 5245433, seasonNumber: 1, number: 3, name: " The Jury Room ", aired: "2015-07-20", runtime: 38, absoluteNumber: 3 },
  null
];

beforeEach(() => {
  freshCache();
  tvdb.resetSession();
  jest.restoreAllMocks();
});

describe("credentials", () => {
  test("only when the server has a key", () => {
    expect(tvdb.credentials({ tvdbKey: null, tvdbPin: null })).toBeNull();
    expect(tvdb.credentials({ tvdbKey: "k", tvdbPin: "1234" })).toEqual({ key: "k", pin: "1234" });
    expect(tvdb.credentials()).toBeNull();
  });
});

describe("login", () => {
  test("sends the key, and the PIN only when there is one", async () => {
    const fetch = routeFetch([login()]);
    expect(await tvdb.login(CREDS)).toBe("tok1");
    expect(await tvdb.login({ key: "KEY", pin: "1234" })).toBe("tok1");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ apikey: "KEY" });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ apikey: "KEY", pin: "1234" });
    expect(fetch.mock.calls[0][0]).toBe(`${tvdb.BASE_URL}/login`);
  });

  test("a refused key, a reply without a token, and TheTVDB out of reach", async () => {
    routeFetch([[/\/login$/, response({ status: "failure" }, { status: 401 })]]);
    await expect(tvdb.login(CREDS)).rejects.toMatchObject({ status: 401, message: "TheTVDB refused the key (HTTP 401)" });
    routeFetch([[/\/login$/, response(null, { json: false })]]);
    await expect(tvdb.login(CREDS)).rejects.toMatchObject({ status: 200 });
    routeFetch([[/\/login$/, new Error("ECONNRESET")]]);
    await expect(tvdb.login(CREDS)).rejects.toThrow("Could not reach TheTVDB: ECONNRESET");
  });
});

describe("episodeInSeason", () => {
  test("an episode's own runtime where the season's runtimes vary, found by its TheTVDB id", async () => {
    const fetch = routeFetch([login(), ["/series/297358/episodes/default", season(EPISODES)]]);
    expect(await tvdb.episodeInSeason(CREDS, "297358", 1, 99, "5245433")).toEqual({
      episodeTitle: "The Jury Room",
      released: "2015-07-20",
      runtimeSeconds: 2280,
      runtimeKind: "exact"
    });
    const get = fetch.mock.calls[1];
    expect(get[0]).toBe(`${tvdb.BASE_URL}/series/297358/episodes/default?page=0&season=1`);
    expect(get[1].headers).toEqual({ authorization: "Bearer tok1" });
  });

  test("by its number when no id is given", async () => {
    routeFetch([login(), ["/episodes/default", season(EPISODES)]]);
    expect(await tvdb.episodeInSeason(CREDS, "297358", 1, 2)).toMatchObject({ episodeTitle: "And Then There Were Four", released: "2015-06-10" });
  });

  test("a runtime copied onto every episode of the season is only the usual length", async () => {
    routeFetch([login(), ["/episodes/default", season(EPISODES.filter(Boolean).map((e) => ({ ...e, runtime: 60 })))]]);
    expect(await tvdb.episodeInSeason(CREDS, "1", 1, 1)).toMatchObject({ runtimeSeconds: 3600, runtimeKind: "typical" });
  });

  test("an episode the season does not list, a season with no list, or no series", async () => {
    routeFetch([
      login(),
      ["/series/1/", season(EPISODES)],
      ["/series/2/", { data: { episodes: "none" } }],
      ["/series/3/", response({}, { status: 404 })]
    ]);
    expect(await tvdb.episodeInSeason(CREDS, "1", 1, 7)).toBeNull();
    expect(await tvdb.episodeInSeason(CREDS, "2", 1, 1)).toBeNull();
    expect(await tvdb.episodeInSeason(CREDS, "3", 1, 1)).toBeNull();
  });

  test("an unnamed episode with no date or runtime", async () => {
    routeFetch([login(), ["/episodes/default", season([{ id: 1, seasonNumber: 1, number: 1, name: " " }])]]);
    expect(await tvdb.episodeInSeason(CREDS, "1", 1, 1)).toEqual({
      episodeTitle: null,
      released: null,
      runtimeSeconds: null,
      runtimeKind: "typical"
    });
  });
});

describe("tokens", () => {
  test("one login serves many requests, and the answers are cached without the token", async () => {
    const fetch = routeFetch([login(), ["/episodes/default", season(EPISODES)]]);
    await tvdb.episodeInSeason(CREDS, "297358", 1, 1);
    await tvdb.episodeInSeason(CREDS, "297358", 1, 2);
    await tvdb.episodeInSeason(CREDS, "297358", 2, 1);
    expect(fetch.mock.calls.map((c) => new URL(c[0]).pathname + new URL(c[0]).search)).toEqual([
      "/v4/login",
      "/v4/series/297358/episodes/default?page=0&season=1",
      "/v4/series/297358/episodes/default?page=0&season=2"
    ]);
  });

  test("an expired token is replaced once, when TheTVDB says so", async () => {
    let tokens = 0;
    const fetch = routeFetch([
      [/\/login$/, () => ({ data: { token: `tok${++tokens}` } })],
      ["/episodes/default", (url, init) => (init.headers.authorization === "Bearer tok2" ? season(EPISODES) : response({}, { status: 401 }))]
    ]);
    expect(await tvdb.episodeInSeason(CREDS, "297358", 1, 3)).toMatchObject({ runtimeSeconds: 2280 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test("a second refusal, or any other failure, is an error", async () => {
    routeFetch([login(), ["/series/1/", response({}, { status: 401 })], ["/series/2/", response({}, { status: 500 })]]);
    await expect(tvdb.episodeInSeason(CREDS, "1", 1, 1)).rejects.toMatchObject({ status: 401 });
    await expect(tvdb.episodeInSeason(CREDS, "2", 1, 1)).rejects.toMatchObject({ status: 500 });
  });

  test("a month on, or with another key, it logs in again", async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(start);
    const fetch = routeFetch([login(), ["/episodes/", { data: EPISODES[0] }]]);
    await tvdb.episodeById(CREDS, "1");
    clock.mockReturnValue(start + tvdb.TOKEN_MS + 1);
    await tvdb.episodeById(CREDS, "2");
    await tvdb.episodeById({ key: "OTHER" }, "3");
    expect(fetch.mock.calls.filter((c) => c[0].endsWith("/login"))).toHaveLength(3);
  });
});

describe("episodeById", () => {
  test("its runtime cannot be compared with the season's, so it is only the usual length", async () => {
    routeFetch([login(), ["/episodes/5245433", { data: EPISODES[2] }]]);
    expect(await tvdb.episodeById(CREDS, "5245433")).toMatchObject({ runtimeSeconds: 2280, runtimeKind: "typical", released: "2015-07-20" });
  });

  test("nothing for an episode it does not have", async () => {
    routeFetch([login(), ["/episodes/1", { data: null }], ["/episodes/2", response({}, { status: 404 })]]);
    expect(await tvdb.episodeById(CREDS, "1")).toBeNull();
    expect(await tvdb.episodeById(CREDS, "2")).toBeNull();
  });
});
