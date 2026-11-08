/**
 * The server with profiles on: the configure page in each of its modes, an
 * imported file, the app's web manifest and service worker, the privacy
 * page, and an install link answering through the same routes as a link
 * that carries its settings.
 */
const crypto = require("crypto");
const request = require("supertest");
const youtube = require("../src/youtube");
const { app } = require("../server");
const profiles = require("../src/profiles");
const { hostConfig } = require("../src/hostConfig");
const { encodeConfig } = require("../src/config");
const { ADDON_VERSION } = require("../src/manifest");
const { routeFetch, apiVideo, freshCache } = require("./helpers");
const { FAST, SESSIONS } = require("./profileStore.suite");

const HOST = "youstream.test";
const PASSWORD = "correct horse battery";
const DAY = 24 * 60 * 60 * 1000;

const settings = () => ({
  enabled: true,
  databaseUrl: "sqlite::memory:",
  secret: crypto.randomBytes(32),
  sessions: SESSIONS,
  pruneAfterMs: 0,
  kdf: FAST
});
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** HTML as the page escapes it. */
const html = (text) => text.replace(/'/g, "&#39;");

let clients = 0;

/** A browser: cookies kept, always at the same address, from a client of its own. */
function browser() {
  const agent = request.agent(app);
  const ip = `198.51.100.${(clients += 1)}`;
  const at = (method) => (path) => agent[method](path).set("Host", HOST).set("X-Forwarded-For", ip);
  return { get: at("get"), post: at("post"), put: at("put"), delete: at("delete") };
}

async function withProfile(config = { youtubeKey: "AIzaSyPROFILEKEY" }) {
  const b = browser();
  const res = await b.post("/api/profile").send({ config, password: PASSWORD });
  expect(res.status).toBe(201);
  const segment = res.body.installUrl.split("/")[3];
  return { b, ...res.body, segment };
}

beforeEach(async () => {
  freshCache();
  youtube.inFlight.clear();
  jest.restoreAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  await profiles.start(settings(), { log: quiet });
});
afterEach(() => profiles.stop());

describe("the configure page", () => {
  test("new: a sign-in folded away, the form, and creating a profile at its end", async () => {
    const res = await browser().get("/configure");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("same-origin");
    expect(res.text).toContain('<details class="card" id="signin-card">');
    expect(res.text).toContain('id="create-card"');
    expect(res.text).toContain(">Create profile and get install link</button>");
    expect(res.text).toContain('id="no-profile-btn"');
    expect(res.text).toContain("With a profile, your key is kept on this server, encrypted");
    expect(res.text).not.toContain('id="install-card"');
    expect(res.text).not.toContain('class="banner"');
  });

  test("signed in: the profile's own settings, its install link, and its security", async () => {
    const { b, id, installUrl } = await withProfile({ youtubeKey: "AIzaSyPROFILEKEY", maxResults: 9 });
    const res = await b.get("/configure");
    // The whole profile ID, to sign in with elsewhere, and its key in Account, still part of the settings.
    expect(res.text).toContain(`<code id="profile-id">${id}</code>`);
    expect(res.text).toMatch(/id="youtube-key" class="key-input" form="config-form"/);
    expect(res.text).toContain(">Install in Nuvio</a>");
    expect(res.text).toContain(`value="${installUrl}"`);
    expect(res.text).toContain(`href="stremio://${installUrl.slice("http://".length)}"`);
    expect(res.text).toContain('value="AIzaSyPROFILEKEY"');
    expect(res.text).toMatch(/id="max-results"[^>]*value="9"/);
    expect(res.text).toContain(">Save changes</button>");
    expect(res.text).toContain('id="security-card"');
    expect(res.text).toContain('id="save-bar"');
    expect(res.text).not.toContain('id="signin-card"');
    expect(res.text).not.toContain('id="create-card"');
  });

  test("notes after a redirect: created, deleted; anything else is no note", async () => {
    const { b } = await withProfile();
    expect((await b.get("/configure?done=created")).text).toContain("Your profile is ready.");
    expect((await browser().get("/configure?done=deleted")).text).toContain("Your profile was deleted, and its install link no longer works.");
    expect((await browser().get("/configure?done=everything")).text).not.toContain('class="banner"');
  });

  test("from an install link, signed out: a sign-in for that profile, and nothing else", async () => {
    const { id, segment } = await withProfile();
    const res = await browser().get(`/${segment}/configure`);
    expect(res.text).toContain('<details class="card" id="signin-card" open>');
    expect(res.text).toContain(`value="${id}"`);
    expect(res.text).toContain('<div id="setup" hidden>');
    expect(res.text).not.toContain("AIzaSyPROFILEKEY");
    expect(res.text).not.toContain('class="banner"');
  });

  test("from an install link, signed in to it: the profile; signed in to another: a sign-in, saying so", async () => {
    const mine = await withProfile();
    expect((await mine.b.get(`/${mine.segment}/configure`)).text).toContain('id="install-card"');
    const theirs = await withProfile();
    const res = await mine.b.get(`/${theirs.segment}/configure`);
    expect(res.text).toContain(html(`You're signed in to another profile (${mine.id.slice(0, 8)}…). Sign in below to switch to this one.`));
    expect(res.text).toContain(`value="${theirs.id}"`);
  });

  test("from an install link that no longer works", async () => {
    const { id } = await withProfile();
    const res = await browser().get(`/${id}.${"Z".repeat(43)}/configure`);
    expect(res.text).toContain("This install link no longer works: its profile was deleted, or the link was replaced.");
  });

  test("from a link that carries its settings: pre-filled, and offering a profile; signed in, offering to save them to it", async () => {
    const legacy = encodeConfig({ youtubeKey: "AIzaSyLINKKEY", maxResults: 4 });
    const out = await browser().get(`/${legacy}/configure`);
    expect(out.text).toContain("Editing a setup whose install link carries its settings. Create a profile below");
    expect(out.text).toContain('value="AIzaSyLINKKEY"');
    expect(out.text).toContain('id="create-card"');
    const { b } = await withProfile();
    const signedIn = await b.get(`/${legacy}/configure`);
    expect(signedIn.text).toContain(html("These settings come from an install link that carries them itself. Saving makes them your profile's settings"));
    expect(signedIn.text).toContain('value="AIzaSyLINKKEY"');
    expect(signedIn.text).toContain(">Save changes</button>");
    expect((await browser().get("/not-json/configure")).status).toBe(400);
  });

  test("profiles on but the database down: said so, and a link without a profile still made", async () => {
    await profiles.stop();
    await profiles.start(settings(), { open: async () => Promise.reject(new Error("down")), log: quiet });
    const res = await browser().get("/configure");
    expect(res.text).toContain("Profiles are unavailable right now: YouStream cannot reach its database.");
    expect(res.text).toContain(">Generate install link</button>");
    expect(res.text).not.toContain('id="signin-card"');
    await profiles.stop();
  });
});

describe("importing a file", () => {
  const form = (b, fields) => b.post("/configure").type("form").send(fields);

  test("fills the form for a look before saving: signed out, and signed in", async () => {
    const out = await form(browser(), { config: JSON.stringify({ youtubeKey: "AIzaSyFILEKEY", maxResults: 12 }), file: "backup.json" });
    expect(out.status).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.text).toContain("Imported “backup.json”: nothing is saved yet. Look the settings over, then create your profile to use them.");
    expect(out.text).toMatch(/id="max-results"[^>]*value="12"/);
    expect(out.text).toContain('"imported":true');
    const { b } = await withProfile();
    const signedIn = await form(b, { config: JSON.stringify({ maxResults: 3 }) });
    expect(signedIn.text).toContain("Imported a settings file: nothing is saved yet. Look the settings over, then save to keep them.");
    expect(signedIn.text).toContain('id="install-card"');
  });

  test("a file that holds no settings object is sent back to the page", async () => {
    for (const config of ["{oops", "[1,2]", "7", "null"]) {
      const res = await form(browser(), { config });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/configure");
    }
    expect((await browser().post("/configure").send({ config: { youtubeKey: "K" } })).status).toBe(303);
  });

  test("the file's name is cut short, and escaped", async () => {
    const res = await form(browser(), { config: "{}", file: `<b>${"x".repeat(200)}` });
    expect(res.text).toContain(`Imported “&lt;b&gt;${"x".repeat(117)}”`);
  });

  test("on a server without profiles, an import is for a link", async () => {
    await profiles.stop();
    const res = await form(browser(), { config: JSON.stringify({ youtubeKey: "K" }) });
    expect(res.text).toContain("then generate your link to use them.");
  });
});

describe("an install link, in the apps", () => {
  test("its manifest is the profile's, with no settings in its address", async () => {
    const { segment } = await withProfile({ youtubeKey: "AIzaSyPROFILEKEY", types: ["movie"], anime: false });
    const res = await request(app).get(`/${segment}/manifest.json`).set("Origin", "https://aiostreams.example");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body.behaviorHints).toEqual({ configurable: true, configurationRequired: false });
    expect(res.body.types).toContain("movie");
    expect(res.body.types).not.toContain("series");
  });

  test("catalogs, details and streams go to the same handlers, with the profile's own key", async () => {
    const fetch = routeFetch([["googleapis.com/youtube/v3/videos", { items: [apiVideo("abcdefghijk", { snippet: { title: "A Video" } })] }]]);
    const { segment } = await withProfile({ youtubeKey: "AIzaSyPROFILEKEY", catalogs: [{ trending: "all" }] });
    const catalog = await request(app).get(`/${segment}/catalog/youtube/trending.all.json`);
    expect(catalog.headers["access-control-allow-origin"]).toBe("*");
    expect(catalog.body.metas[0]).toMatchObject({ id: "yt_id:abcdefghijk", type: "youtube" });
    const meta = await request(app).get(`/${segment}/meta/youtube/yt_id%3Aabcdefghijk.json`);
    expect(meta.body.meta).toMatchObject({ name: "A Video" });
    const streams = await request(app).get(`/${segment}/stream/youtube/yt_id:abcdefghijk.json`);
    expect(streams.body.streams[0].ytId).toBe("abcdefghijk");
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("googleapis.com") || String(url).includes("key=AIzaSyPROFILEKEY"))).toBe(true);
  });

  test("a save reaches the apps at once: no reinstall", async () => {
    const { b, segment } = await withProfile({ youtubeKey: "AIzaSyPROFILEKEY", types: ["movie"], anime: false });
    expect((await request(app).get(`/${segment}/manifest.json`)).body.types).not.toContain("series");
    const saved = await b.put("/api/profile").send({ config: { youtubeKey: "AIzaSyPROFILEKEY", types: ["series"], anime: false } });
    expect(saved.body).toEqual({ saved: true, manifestChanged: true });
    const now = (await request(app).get(`/${segment}/manifest.json`)).body.types;
    expect(now).toContain("series");
    expect(now).not.toContain("movie");
  });

  test("deleted, its link answers with a row saying so", async () => {
    const { b, segment } = await withProfile();
    expect((await b.delete("/api/profile").send({ password: PASSWORD })).status).toBe(204);
    const streams = await request(app).get(`/${segment}/stream/movie/tt0111161.json`);
    expect(streams.body.streams[0].description).toMatch(/^⚠️ This install link no longer works/);
    expect((await request(app).get(`/${segment}/manifest.json`)).status).toBe(404);
  });

  test("on a server with profiles off, a profile's link is one it cannot open", async () => {
    const { segment } = await withProfile();
    await profiles.stop();
    expect((await request(app).get(`/${segment}/manifest.json`)).status).toBe(404);
  });

  test("/health says profiles are ready", async () => {
    expect((await request(app).get("/health")).body.profiles).toBe("ready");
  });
});

describe("the installable app", () => {
  test("its web manifest: standalone, opening at /configure, with icons for any shape", async () => {
    const res = await request(app).get("/app.webmanifest");
    expect(res.headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    const manifest = JSON.parse(res.text);
    expect(manifest).toMatchObject({ id: "/configure", start_url: "/configure", scope: "/", display: "standalone", name: "YouStream" });
    expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]);
    for (const icon of manifest.icons) {
      const file = await request(app).get(icon.src);
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toBe("image/png");
    }
  });

  test("its service worker, renewed with every version", async () => {
    const res = await request(app).get("/sw.js");
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.text).toContain(`"cache":"youstream-${ADDON_VERSION}"`);
  });

  test("the page links them", async () => {
    const res = await browser().get("/configure");
    expect(res.text).toContain('<link rel="manifest" href="/app.webmanifest" />');
    expect(res.text).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(res.text).toContain('<meta name="theme-color" content="#0f1013" />');
    expect((await request(app).get("/apple-touch-icon.png")).status).toBe(200);
  });
});

describe("the privacy policy, on a server that keeps profiles", () => {
  test("says what a profile keeps, for how long, and the one cookie", async () => {
    const saved = { ...hostConfig.profiles };
    Object.assign(hostConfig.profiles, { enabled: true, pruneAfterMs: 400 * DAY, sessions: { ...SESSIONS, rememberedMs: 14 * DAY } });
    try {
      const text = (await request(app).get("/terms")).text;
      expect(text).toContain("YouStream does not track you and sets no cookie unless you sign in to a profile.");
      expect(text).toContain("until you delete it, or until no app or sign-in has used it for 400 days");
      expect(text).toContain("for 14 days from when you last use YouStream there and 90 days at most.");
      expect(text).toContain("Without a profile, YouStream keeps nothing that identifies you");
      expect(text).toContain("a profile's link does not, but lets anyone who has it use YouStream with them.");
      Object.assign(hostConfig.profiles, { pruneAfterMs: 0 });
      expect((await request(app).get("/terms")).text).toContain("A profile is kept until you delete it.");
      // And the configure page's "stay signed in" says the same.
      expect((await browser().get("/configure")).text).toContain("For 14 days from when you last use YouStream here, 90 at most.");
    } finally {
      Object.assign(hostConfig.profiles, saved);
    }
  });
});
