const request = require("supertest");
const youtube = require("../src/youtube");
const { encodeConfig } = require("../src/config");
const { app, getBaseUrl, credits } = require("../server");
const { searchCache, metadataCache } = require("../src/cache");
const { response, routeFetch, apiVideo, freshCache } = require("./helpers");

beforeEach(() => {
  freshCache();
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
    expect(res.body).toEqual({ ok: true, cache: "memory", imdb: { loaded: false } });
  });

  test("/health says when IMDb's data is turned off", async () => {
    const { hostConfig } = require("../src/hostConfig");
    hostConfig.metadata.imdbDatasets = false;
    try {
      expect((await request(app).get("/health")).body.imdb).toBe("off");
    } finally {
      hostConfig.metadata.imdbDatasets = true;
    }
  });

  test("/configure credits the data sources whose terms ask for it", async () => {
    const html = (await request(app).get("/configure")).text;
    expect(html).toContain("Information courtesy of IMDb (https://www.imdb.com). Used with permission.");
    expect(html).not.toContain("TheTVDB");
  });

  test("credits follow the sources in use; TMDB's and TVmaze's always, since a reader may use either", () => {
    const always = ["https://www.themoviedb.org", "https://www.tvmaze.com"];
    expect(credits({ imdbDatasets: false, tvdbKey: null }).map((c) => c.href)).toEqual(always);
    expect(credits({ imdbDatasets: false, tvdbKey: "k" })[0]).toEqual({ text: "Episode data from TheTVDB.com", href: "https://thetvdb.com" });
    expect(credits().map((c) => c.href)).toEqual(["https://www.imdb.com", ...always]);
    expect(credits()[1]).toMatchObject({
      text: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
      image: "/tmdb.svg"
    });
  });

  test("/configure says what YouStream is not, and links the terms", async () => {
    const html = (await request(app).get("/configure")).text;
    expect(html).toContain("YouTube is a trademark of Google LLC. YouStream is not affiliated with or endorsed by YouTube, Google, Stremio or Nuvio.");
    expect(html).toContain('<a href="/terms">Terms of use and privacy</a>');
    expect(html).toContain('<img src="/tmdb.svg" alt="TMDB" height="11" />');
  });

  test("/terms: YouTube's terms, Google's privacy policy, the disclaimer, a contact and the credits", async () => {
    const res = await request(app).get("/terms");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("By using YouStream you agree to be bound by the");
    expect(res.text).toContain('href="https://www.youtube.com/t/terms"');
    expect(res.text).toContain('href="https://policies.google.com/privacy"');
    expect(res.text).toContain("does not host, store, download, copy, proxy or modify any video");
    expect(res.text).toContain('<a href="https://github.com/deejay189393/YouStream/issues">');
    expect(res.text).toContain("This product uses the TMDB API but is not endorsed or certified by TMDB.");
    expect((await request(app).get("/tmdb.svg")).status).toBe(200);
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
    // A film's rows say when the video went up: AIOStreams has the film's release to weigh it against.
    expect(res.body.streams[0].behaviorHints.publishDate).toBe("2021-05-01T00:00:00Z");
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

describe("POST /api/youtube-source", () => {
  test("a channel link, as a channel, becomes a catalog the page can add", async () => {
    routeFetch([["googleapis.com/youtube/v3/channels", { items: [{ id: "UCBJycsmduvYEL83R_U4JriQ", snippet: { title: "Marques Brownlee" } }] }]]);
    const res = await request(app).post("/api/youtube-source").send({ youtubeKey: "KEY", input: "https://www.youtube.com/@mkbhd", kind: "channel" });
    expect(res.body.entry).toMatchObject({ kind: "channel", channel: "UCBJycsmduvYEL83R_U4JriQ", name: "Marques Brownlee" });
  });

  test("a playlist's id, as a playlist, too", async () => {
    routeFetch([["googleapis.com/youtube/v3/playlists", { items: [{ id: "PLBCF2DAC6FFB574DE", snippet: { title: "Stories" } }] }]]);
    const res = await request(app).post("/api/youtube-source").send({ youtubeKey: "KEY", input: "PLBCF2DAC6FFB574DE", kind: "playlist" });
    expect(res.body.entry).toMatchObject({ kind: "playlist", playlist: "PLBCF2DAC6FFB574DE", name: "Stories" });
  });

  test("without a kind to look up, a key, or anything pasted, it says what is missing and asks YouTube nothing", async () => {
    const fetch = routeFetch([]);
    const post = (body) => request(app).post("/api/youtube-source").send(body);
    expect((await post({ youtubeKey: "KEY", input: "@mkbhd" })).body.error).toBe("Choose YouTube playlist or YouTube channel to look a link up.");
    expect((await post({ youtubeKey: "KEY", input: "@mkbhd", kind: "search" })).body.error).toContain("Choose YouTube playlist");
    expect((await post({ youtubeKey: "KEY", input: "@mkbhd", kind: "constructor" })).body.error).toContain("Choose YouTube playlist");
    expect((await post({ input: "@mkbhd", kind: "channel" })).body.error).toContain("API key");
    expect((await post({ youtubeKey: "KEY", input: 5, kind: "playlist" })).body.error).toContain("the part after list=");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("YouTube items over HTTP", () => {
  const KEYED = () => encodeConfig({ youtubeKey: "KEY", catalogs: [{ trending: "all" }] });

  test("a catalog, then the video's details and its streams, the way an app asks", async () => {
    routeFetch([["googleapis.com/youtube/v3/videos", { items: [apiVideo("abcdefghijk", { snippet: { title: "Trending One" } })] }]]);
    const catalog = await request(app).get(`/${KEYED()}/catalog/YouTube/trending.all.json`);
    expect(catalog.status).toBe(200);
    expect(catalog.headers["access-control-allow-origin"]).toBe("*");
    expect(catalog.body.metas[0]).toMatchObject({ id: "youstream:abcdefghijk", type: "YouTube" });
    // Nuvio puts skip in the path, its next request starting at the count it has.
    const more = await request(app).get(`/${KEYED()}/catalog/YouTube/trending.all/skip=1.json`);
    expect(more.body.metas).toEqual([]);
    const meta = await request(app).get(`/${KEYED()}/meta/YouTube/youstream%3Aabcdefghijk.json`);
    expect(meta.body.meta).toMatchObject({ id: "youstream:abcdefghijk", name: "Trending One" });
    const streams = await request(app).get(`/${KEYED()}/stream/YouTube/youstream:abcdefghijk.json`);
    expect(streams.body.streams[0].ytId).toBe("abcdefghijk");
    // No upload date: AIOStreams has no release for a YouTube item, and would drop it as a fake.
    streams.body.streams.forEach((stream) => expect(stream.behaviorHints).not.toHaveProperty("publishDate"));
    expect(streams.body.streams[0].behaviorHints).toMatchObject({ indexer: "YouTube", duration: expect.any(Number) });
  });

  test("a video that is gone is a 404, with the protocol's CORS header, which Nuvio takes as final", async () => {
    routeFetch([["googleapis.com/youtube/v3/videos", { items: [] }]]);
    const res = await request(app).get(`/${KEYED()}/meta/YouTube/youstream:gonegonegon.json`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  test("YouTube failing on a video's details is an error, not a 404", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    routeFetch([["googleapis.com/youtube/v3/videos", response({}, { status: 503 })]]);
    const res = await request(app).get(`/${KEYED()}/meta/YouTube/youstream:abcdefghijk.json`);
    expect(res.status).toBe(500);
  });

  test("any other unknown path is a JSON 404", async () => {
    const res = await request(app).get("/not/a/route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
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

  test("an answer from an out-of-date search says why it was used", async () => {
    const nightOfTheLivingDead = [
      ["/meta/movie/", { meta: { name: "Night of the Living Dead", year: "1968", runtime: "96 min" } }],
      ["/videos?", { items: [apiVideo("full0000001", { snippet: { title: "Night of the Living Dead (1968)" }, contentDetails: { duration: "PT1H35M" } })] }]
    ];
    routeFetch([...nightOfTheLivingDead, ["/search?", { items: [{ id: { videoId: "full0000001" } }] }]]);
    await request(app).get(`/${CFG()}/explain/movie/tt0063350.json`);
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 24 * 60 * 60 * 1000);
    routeFetch([...nightOfTheLivingDead, ["/search?", response({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })]]);
    const res = await request(app).get(`/${CFG()}/explain/movie/tt0063350.json`);
    expect(res.body).toMatchObject({ status: "ok", cached: true, stale: "quota", matches: [{ id: "full0000001" }] });
  });

  test("a film whose sources disagree shows the lengths close to each", async () => {
    const imdb = require("../src/metadata/imdb");
    async function* lines() {
      yield "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres";
      yield ["tt0073707", "movie", "Sholay", "Sholay", "0", "1975", "\\N", "162", "Action"].join("\t");
    }
    imdb.useIndex(await imdb.buildIndex(lines()));
    try {
      routeFetch([
        ["/meta/movie/", { meta: { name: "Sholay", year: "1975", runtime: "208 min" } }],
        ["/search?", { items: [] }]
      ]);
      const res = await request(app).get(`/${CFG()}/explain/movie/tt0073707.json`);
      expect(res.body.length).toMatchObject({ runtime: "2h 42m 00s", spans: ["2h 32m 00s to 2h 52m 00s", "3h 18m 00s to 3h 38m 00s"] });
      expect(res.body.title.sources).toEqual(["imdb", "cinemeta"]);
    } finally {
      imdb.useIndex(null);
    }
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

describe("/admin/cache", () => {
  const auth = (token) => ({ authorization: `Bearer ${token}` });

  test("is not there without CACHE_ADMIN_TOKEN", async () => {
    expect((await request(app).get("/admin/cache")).status).toBe(404);
    expect((await request(app).delete("/admin/cache/all")).status).toBe(404);
  });

  describe("with a token", () => {
    beforeEach(async () => {
      freshCache({ adminToken: "s3cret" });
      await searchCache.set("q1", []);
      await searchCache.set("q2", []);
      await metadataCache.set("url", { body: null });
    });

    test("refuses a request without it, or with another", async () => {
      expect((await request(app).get("/admin/cache")).status).toBe(401);
      expect((await request(app).get("/admin/cache").set(auth("wrong"))).status).toBe(401);
      expect((await request(app).get("/admin/cache").set({ authorization: "s3cret" })).status).toBe(401);
      expect(await searchCache.count()).toBe(2);
    });

    test("says what the cache holds", async () => {
      const res = await request(app).get("/admin/cache").set(auth("s3cret"));
      expect(res.body).toMatchObject({ store: "memory", prefix: "youstream", entries: { search: 2, metadata: 1, cooldown: 0 } });
      expect(res.body.description).toContain("searches 1d");
      expect(JSON.stringify(res.body)).not.toContain("s3cret");
    });

    test("empties one namespace", async () => {
      const res = await request(app).delete("/admin/cache/search").set(auth("s3cret"));
      expect(res.body).toEqual({ removed: 2 });
      expect(await searchCache.count()).toBe(0);
      expect(await metadataCache.count()).toBe(1);
    });

    test("or all of them", async () => {
      expect((await request(app).delete("/admin/cache/all").set(auth("s3cret"))).body).toEqual({ removed: 3 });
      expect(await metadataCache.count()).toBe(0);
    });

    test("a store that is down is a 503, not a crash", async () => {
      const store = freshCache({ adminToken: "s3cret" });
      store.count = store.clear = async () => {
        throw new Error("ECONNREFUSED");
      };
      for (const call of [request(app).get("/admin/cache"), request(app).delete("/admin/cache/all")]) {
        const res = await call.set(auth("s3cret"));
        expect(res.status).toBe(503);
        expect(res.body.error).toBe("The cache store did not answer: ECONNREFUSED");
      }
    });

    test("names the namespaces when given another", async () => {
      const res = await request(app).delete("/admin/cache/videos").set(auth("s3cret"));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unknown namespace; one of search, metadata, cooldown, browse, video, all");
    });
  });
});
