const request = require("supertest");
const { clearAllCaches } = require("../src/cache");
const youtube = require("../src/youtube");
const { encodeConfig } = require("../src/config");
const { app, getBaseUrl } = require("../server");
const { response, routeFetch, apiVideo } = require("./helpers");

beforeEach(() => {
  clearAllCaches();
  youtube.inFlight.clear();
  jest.restoreAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.TMDB_API_KEY;
});

const CFG = () => encodeConfig({ youtubeKey: "KEY" });

describe("basic routes", () => {
  test("/ redirects to the configure page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/configure");
  });

  test("/configure serves the page", async () => {
    const res = await request(app).get("/configure");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("YouTube API key");
  });

  test("/configure says when the server has its own TMDB key", async () => {
    process.env.TMDB_API_KEY = "server";
    expect((await request(app).get("/configure")).text).toContain("This server already has a TMDB key");
  });

  test("/health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("serves the artwork", async () => {
    expect((await request(app).get("/logo.png")).headers["content-type"]).toMatch(/image\/png/);
    expect((await request(app).get("/background.png")).status).toBe(200);
  });
});

describe("manifests", () => {
  test("the bare manifest requires configuration, and uses the forwarded protocol", async () => {
    const res = await request(app).get("/manifest.json").set("x-forwarded-proto", "https, http").set("host", "yt.example");
    expect(res.body.behaviorHints.configurationRequired).toBe(true);
    expect(res.body.logo).toMatch(/^https:\/\/yt\.example\/logo\.png/);
  });

  test("a configured manifest is installable", async () => {
    const res = await request(app).get(`/${CFG()}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.behaviorHints.configurationRequired).toBe(false);
  });

  test("a broken config is a 400", async () => {
    expect((await request(app).get("/not-json/manifest.json")).status).toBe(400);
    expect((await request(app).get("/not-json/configure")).status).toBe(400);
  });

  test("reconfiguring pre-fills the page", async () => {
    const res = await request(app).get(`/${encodeConfig({ youtubeKey: "MYKEY123", region: "IN" })}/configure`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('value="MYKEY123"');
    expect(res.text).toContain("Editing your current setup");
  });
});

describe("streams through the SDK router", () => {
  test("serves streams for a configured addon, with CORS and cache headers", async () => {
    routeFetch([
      ["/meta/movie/", { meta: { name: "Night of the Living Dead", year: "1968", runtime: "96 min" } }],
      ["/search?", { items: [{ id: { videoId: "notld000001" } }] }],
      ["/videos?", { items: [apiVideo("notld000001", { snippet: { title: "Night of the Living Dead (1968)" }, contentDetails: { duration: "PT1H35M" } })] }]
    ]);
    const res = await request(app).get(`/${CFG()}/stream/movie/tt0063350.json`);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toContain("max-age=21600");
    expect(res.body.streams[0].ytId).toBe("notld000001");
  });

  test("a series id with its season and episode", async () => {
    routeFetch([]);
    const res = await request(app).get(`/${CFG()}/stream/series/tt9432978:1:3.json`);
    expect(res.status).toBe(200);
    expect(res.body.streams).toEqual([]);
  });
});

describe("POST /api/check-keys", () => {
  test("checks both keys", async () => {
    routeFetch([
      ["googleapis.com/youtube/v3/videos", { items: [] }],
      ["api.themoviedb.org/3/configuration", response({}, { status: 401 })]
    ]);
    const res = await request(app).post("/api/check-keys").send({ youtubeKey: "KEY", tmdbKey: "BAD" });
    expect(res.body).toEqual({ youtube: "ok", tmdb: "invalid" });
  });

  test("a missing YouTube key and no TMDB key", async () => {
    const fetch = routeFetch([]);
    const res = await request(app).post("/api/check-keys").send({});
    expect(res.body).toEqual({ youtube: "missing", tmdb: "absent" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a body that is not an object", async () => {
    routeFetch([]);
    const res = await request(app).post("/api/check-keys").set("content-type", "application/json").send("[]");
    expect(res.body).toEqual({ youtube: "missing", tmdb: "absent" });
  });

  test("a body that is not JSON at all", async () => {
    routeFetch([]);
    const res = await request(app).post("/api/check-keys").set("content-type", "text/plain").send("hello");
    expect(res.body).toEqual({ youtube: "missing", tmdb: "absent" });
  });
});

describe("GET /:config/explain/:type/:id.json", () => {
  test("shows what was searched, what matched and why the rest did not, without the key", async () => {
    routeFetch([
      ["/meta/movie/", { meta: { name: "Night of the Living Dead", year: "1968", runtime: "96 min" } }],
      ["/search?", { items: [{ id: { videoId: "full0000001" } }, { id: { videoId: "trailer0001" } }] }],
      [
        "/videos?",
        {
          items: [
            apiVideo("full0000001", { snippet: { title: "Night of the Living Dead (1968)" }, contentDetails: { duration: "PT1H35M" } }),
            apiVideo("trailer0001", { snippet: { title: "Night of the Living Dead Trailer" }, contentDetails: { duration: "PT0S" } })
          ]
        }
      ]
    ]);
    const res = await request(app).get(`/${CFG()}/explain/movie/tt0063350.json`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "tt0063350",
      status: "ok",
      query: "Night of the Living Dead 1968 full movie",
      cached: false,
      length: { basis: "exact", runtime: "1h 36m 00s", margin: "10m", from: "1h 26m 00s", to: "1h 46m 00s", youtubeLengthFilter: "long" },
      matches: [{ id: "full0000001", url: "https://www.youtube.com/watch?v=full0000001", offset: "−1m 00s", matchedBy: null }],
      rejected: [{ id: "trailer0001", duration: null, reason: "no length" }]
    });
    expect(JSON.stringify(res.body)).not.toContain("KEY");
  });

  test("a lookup with no runtime known", async () => {
    routeFetch([
      ["/meta/movie/", { meta: { name: "Untimed", releaseInfo: "1990" } }],
      ["/search?", { items: [{ id: { videoId: "a" } }] }],
      ["/videos?", { items: [apiVideo("a", { snippet: { title: "Untimed (1990)" }, contentDetails: { duration: "PT1H30M" } })] }]
    ]);
    const res = await request(app).get(`/${CFG()}/explain/movie/tt1234567.json`);
    expect(res.body.length).toMatchObject({ basis: "unknown", runtime: null, margin: null });
    expect(res.body.matches[0].offset).toBeNull();
  });

  test("a lookup that stopped early, and one whose search failed", async () => {
    routeFetch([
      ["/meta/movie/tt1111111", { meta: { name: "Film", runtime: "90 min" } }],
      ["/search?", response({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })]
    ]);
    expect((await request(app).get(`/${CFG()}/explain/movie/nonsense.json`)).body).toEqual({ id: "nonsense", status: "unsupported id" });
    const failed = (await request(app).get(`/${CFG()}/explain/movie/tt1111111.json`)).body;
    expect(failed).toMatchObject({ status: "search failed", error: { kind: "quota" } });
    expect(failed.matches).toBeUndefined();
  });

  test("a window that straddles YouTube's length buckets searches every length", async () => {
    routeFetch([
      ["/meta/series/", { meta: { name: "Short Show", videos: [] } }],
      ["/search?", { items: [] }]
    ]);
    const res = await request(app).get(`/${CFG()}/explain/series/tt1234567:1:1.json`);
    expect(res.body.length).toMatchObject({ basis: "unknown", youtubeLengthFilter: "any" });
  });

  test("needs a configured key", async () => {
    expect((await request(app).get(`/${encodeConfig({})}/explain/movie/tt0063350.json`)).status).toBe(400);
    expect((await request(app).get("/nope/explain/movie/tt0063350.json")).status).toBe(400);
  });
});

describe("getBaseUrl", () => {
  test("falls back to the request's own protocol", () => {
    const req = { get: (h) => (h === "host" ? "localhost:3000" : undefined), protocol: "http" };
    expect(getBaseUrl(req)).toBe("http://localhost:3000");
  });
});
