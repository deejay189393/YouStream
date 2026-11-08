const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const { openDatabase } = require("../src/storage");
const { createProfileStore } = require("../src/profiles/store");
const { createProfileApi, PASSWORD_MIN, PASSWORD_MAX } = require("../src/profiles/api");
const { BusyError } = require("../src/profiles/crypto");
const { readSessionCookie, setSessionCookie, COOKIE } = require("../src/profiles/session");
const { FAST, SESSIONS } = require("./profileStore.suite");

const PASSWORD = "correct horse battery";
const KEY_CONFIG = { youtubeKey: "AIzaSyTESTKEY" };

let db;
let store;
let status;
let clock;
let log;
let app;
let api;

beforeEach(async () => {
  ({ db } = await openDatabase("sqlite::memory:"));
  clock = { t: 1800000000000 };
  store = createProfileStore({ db, secret: crypto.randomBytes(32), sessions: SESSIONS, kdf: FAST, now: () => clock.t });
  status = "ready";
  log = { log: jest.fn(), warn: jest.fn() };
  api = createProfileApi({ getStore: () => store, getStatus: () => status, now: () => clock.t, log });
  app = express();
  app.set("trust proxy", 1);
  app.use("/api/profile", api.router);
});
afterEach(() => db.close());

/** A client with a cookie jar, from one address. */
const client = (ip = "203.0.113.1") => {
  const agent = request.agent(app);
  const send = (method, path) => agent[method](`/api/profile${path}`).set("X-Forwarded-For", ip).set("Host", "youstream.test");
  return {
    agent,
    get: (path = "") => send("get", path),
    post: (path, body) => send("post", path).send(body),
    put: (path, body) => send("put", path).send(body),
    del: (path, body) => send("delete", path).send(body || {})
  };
};

const sessionCookie = (res) => (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${COOKIE}=`));

async function created(c = client(), body = {}) {
  const res = await c.post("", { config: KEY_CONFIG, password: PASSWORD, ...body });
  expect(res.status).toBe(201);
  return { c, ...res.body, res };
}

describe("creating a profile", () => {
  test("signs this browser in, remembered by default, and gives the install link", async () => {
    const { id, installUrl, remembered, expiresAt, res } = await created();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(installUrl).toMatch(new RegExp(`^http://youstream\\.test/${id}\\.[A-Za-z0-9_-]{43}/manifest\\.json$`));
    expect(remembered).toBe(true);
    expect(expiresAt).toBe(clock.t + SESSIONS.rememberedMs);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(log.log).toHaveBeenCalledWith(`[profiles] created ${id.slice(0, 8)}`);
  });

  test("over HTTPS the cookie is Secure; not remembered, it goes when the browser closes", async () => {
    const res = await request(app)
      .post("/api/profile")
      .set("X-Forwarded-Proto", "https")
      .send({ config: KEY_CONFIG, password: PASSWORD, remember: false });
    expect(res.body.remembered).toBe(false);
    expect(res.body.installUrl).toMatch(/^https:\/\//);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toMatch(/Max-Age|Expires/);
  });

  test("keeps the settings as a link would carry them: normalized, defaults left out", async () => {
    const { c } = await created(client(), { config: { youtubeKey: " AIzaSyTESTKEY ", maxResults: 5, junk: "x", region: "IN" } });
    const res = await c.get();
    expect(res.body.config).toEqual({ youtubeKey: "AIzaSyTESTKEY", playback: ["app", "youtube"], playbackVersion: 1, region: "IN" });
  });

  test("a password too short or too long, or no usable settings, is refused", async () => {
    const c = client();
    const tooShort = "x".repeat(PASSWORD_MIN - 1);
    expect((await c.post("", { config: KEY_CONFIG, password: tooShort })).body.error).toBe(
      `Use a password of at least ${PASSWORD_MIN} characters.`
    );
    expect((await c.post("", { config: KEY_CONFIG })).status).toBe(400);
    expect((await c.post("", { config: KEY_CONFIG, password: "x".repeat(PASSWORD_MAX + 1) })).body.error).toBe(
      `Use a password of at most ${PASSWORD_MAX} characters.`
    );
    expect((await c.post("", { password: PASSWORD })).body.error).toBe("No settings were sent.");
    expect((await c.post("", { config: ["a"], password: PASSWORD })).body.error).toBe("No settings were sent.");
    expect((await c.post("", { config: { maxResults: 3 }, password: PASSWORD })).body.error).toBe("Enter your YouTube API key.");
  });

  test("a browser signed in to one profile is signed out of it by creating another", async () => {
    const first = await created();
    const firstToken = readSessionCookie({ headers: { cookie: sessionCookie(first.res).split(";")[0] } });
    await created(first.c);
    expect(await store.resolveSession(firstToken)).toBeNull();
  });

  test("ten new profiles an hour from one client", async () => {
    const c = client("198.51.100.7");
    for (let i = 0; i < 10; i++) expect((await c.post("", { config: KEY_CONFIG, password: PASSWORD })).status).toBe(201);
    const res = await c.post("", { config: KEY_CONFIG, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many tries. Wait 60 minutes and try again.");
    expect(res.headers["retry-after"]).toBe("3600");
    expect((await client("198.51.100.8").post("", { config: KEY_CONFIG, password: PASSWORD })).status).toBe(201);
  });
});

describe("reading and saving", () => {
  test("the signed-in profile: its settings, its link, its sign-in", async () => {
    const { c, id, installUrl } = await created();
    const res = await c.get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      installUrl,
      config: { youtubeKey: "AIzaSyTESTKEY", playback: ["app", "youtube"], playbackVersion: 1 },
      createdAt: clock.t,
      updatedAt: clock.t,
      remembered: true,
      expiresAt: clock.t + SESSIONS.rememberedMs
    });
  });

  test("a remembered sign-in in use is pushed out again, and its cookie with it", async () => {
    const { c } = await created();
    clock.t += 60 * 60 * 1000;
    const res = await c.get();
    expect(res.body.expiresAt).toBe(clock.t + SESSIONS.rememberedMs);
    expect(sessionCookie(res)).toMatch(/Max-Age=2592000/);
    // Not again within the hour.
    clock.t += 1000;
    expect(sessionCookie(await c.get())).toBeUndefined();
  });

  test("no sign-in, or a dead one, is a 401 that clears the cookie", async () => {
    expect((await client().get()).status).toBe(401);
    const res = await request(app).get("/api/profile").set("Cookie", `${COOKIE}=${"A".repeat(43)}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("You're signed out. Sign in again.");
    expect(sessionCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  test("a sign-in whose profile no longer opens is ended", async () => {
    const { c, id } = await created();
    await db.run("UPDATE profiles SET config = 'v1.broken' WHERE id = ?", [id]);
    expect((await c.get()).status).toBe(401);
    expect(Number((await db.get("SELECT COUNT(*) AS n FROM profile_sessions")).n)).toBe(0);
    expect((await c.put("", { config: KEY_CONFIG })).status).toBe(401);
  });

  test("saving says whether the manifest an app keeps changed", async () => {
    const { c, installUrl } = await created();
    const token = installUrl.split("/")[3].split(".")[1];
    const id = installUrl.split("/")[3].split(".")[0];
    const plain = await c.put("", { config: { ...KEY_CONFIG, maxResults: 9 } });
    expect(plain.body).toEqual({ saved: true, manifestChanged: false });
    expect(await store.resolveLink(id, token)).toEqual(expect.objectContaining({ maxResults: 9 }));
    const rows = await c.put("", { config: { ...KEY_CONFIG, maxResults: 9, types: ["movie"], anime: false } });
    expect(rows.body).toEqual({ saved: true, manifestChanged: true });
    const catalog = await c.put("", { config: { ...KEY_CONFIG, types: ["movie"], catalogs: [{ q: "lofi music" }] } });
    expect(catalog.body.manifestChanged).toBe(true);
  });

  test("saving needs a sign-in and usable settings", async () => {
    expect((await client().put("", { config: KEY_CONFIG })).status).toBe(401);
    const { c } = await created();
    expect((await c.put("", { config: {} })).body.error).toBe("Enter your YouTube API key.");
  });

  test("a save that raced a password change elsewhere is refused", async () => {
    const { c } = await created();
    jest.spyOn(store, "save").mockResolvedValueOnce(false);
    const res = await c.put("", { config: KEY_CONFIG });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Your profile changed on another device. Reload the page and try again.");
  });
});

describe("signing in and out", () => {
  test("the right password signs in, remembered or not; the previous sign-in on this browser ends", async () => {
    const { id, c } = await created();
    const before = c.agent.jar.getCookie(COOKIE, { path: "/", domain: "127.0.0.1", secure: false, script: false }).value;
    const res = await c.post("/session", { id: ` ${id.toUpperCase()} `, password: PASSWORD, remember: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, remembered: false, expiresAt: clock.t + SESSIONS.browserMs });
    expect(sessionCookie(res)).not.toMatch(/Max-Age/);
    expect(await store.resolveSession(before)).toBeNull();
    expect((await c.get()).body.id).toBe(id);
  });

  test("a wrong password, or none, or a malformed ID", async () => {
    const { id } = await created();
    const c = client();
    expect((await c.post("/session", { id, password: "wrong password" })).body.error).toBe("That profile ID and password don't match.");
    expect((await c.post("/session", { id, password: "" })).body.error).toBe("Enter your password.");
    expect((await c.post("/session", { id })).status).toBe(400);
    expect((await c.post("/session", { id: "not-an-id", password: PASSWORD })).body.error).toMatch(/^A profile ID looks like/);
    expect((await c.post("/session", { id: 42, password: PASSWORD })).status).toBe(400);
    // A password longer than any can be is wrong without being checked.
    expect((await c.post("/session", { id, password: "x".repeat(PASSWORD_MAX + 1) })).status).toBe(401);
  });

  test("ten wrong passwords from one client: a 15-minute wait, for it alone", async () => {
    const { id } = await created();
    const c = client("192.0.2.10");
    for (let i = 0; i < 10; i++) expect((await c.post("/session", { id, password: `wrong ${i}` })).status).toBe(401);
    const blocked = await c.post("/session", { id, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too many tries. Wait 15 minutes and try again.");
    expect((await client("192.0.2.11").post("/session", { id, password: PASSWORD })).status).toBe(200);
    clock.t += 15 * 60 * 1000;
    expect((await c.post("/session", { id, password: PASSWORD })).status).toBe(200);
  });

  test("twenty wrong passwords for one profile, from anywhere: it waits too", async () => {
    const { id } = await created();
    for (let i = 0; i < 20; i++) {
      expect((await client(`192.0.2.${100 + Math.floor(i / 5)}`).post("/session", { id, password: `wrong ${i}` })).status).toBe(401);
    }
    const blocked = await client("192.0.2.200").post("/session", { id, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/^Too many tries\. Wait \d+ (seconds|minutes)/);
  });

  test("signing out ends this browser's sign-in; with no sign-in it is still fine", async () => {
    const { c } = await created();
    const res = await c.del("/session");
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await c.get()).status).toBe(401);
    expect((await client().del("/session")).status).toBe(204);
  });

  test("signing out everywhere ends every sign-in of the profile", async () => {
    const { c, id } = await created();
    const other = client("203.0.113.9");
    await other.post("/session", { id, password: PASSWORD });
    const res = await c.del("/sessions");
    expect(res.body).toEqual({ signedOut: 2 });
    expect((await other.get()).status).toBe(401);
    expect((await client().del("/sessions")).status).toBe(401);
  });
});

describe("changing the password", () => {
  test("takes the current password; every sign-in ends, this one starts again, the link stays", async () => {
    const { c, id, installUrl } = await created();
    const other = client("203.0.113.9");
    await other.post("/session", { id, password: PASSWORD });
    const res = await c.post("/password", { currentPassword: PASSWORD, newPassword: "a whole new password" });
    expect(res.body).toEqual({ changed: true });
    expect(sessionCookie(res)).toMatch(/Max-Age/);
    expect((await c.get()).body.installUrl).toBe(installUrl);
    expect((await other.get()).status).toBe(401);
    expect((await client().post("/session", { id, password: PASSWORD })).status).toBe(401);
    expect((await client().post("/session", { id, password: "a whole new password" })).status).toBe(200);
    expect(log.log).toHaveBeenCalledWith(`[profiles] password changed for ${id.slice(0, 8)}`);
  });

  test("a sign-in that was not remembered starts again not remembered", async () => {
    const { c, id } = await created(client(), { remember: false });
    const res = await c.post("/password", { currentPassword: PASSWORD, newPassword: "a whole new password" });
    expect(sessionCookie(res)).not.toMatch(/Max-Age/);
    expect((await c.get()).body).toEqual(expect.objectContaining({ id, remembered: false }));
  });

  test("refused: a wrong current password, a short new one, the same one again", async () => {
    const { c } = await created();
    expect((await c.post("/password", { currentPassword: "wrong password", newPassword: "a whole new password" })).status).toBe(401);
    expect((await c.post("/password", { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
    const same = await c.post("/password", { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.error).toBe("That's the password you have now. Choose another.");
  });

  test("works without a sign-in, given the profile's ID; then no cookie is set", async () => {
    const { id } = await created();
    const c = client();
    expect((await c.post("/password", { currentPassword: PASSWORD, newPassword: "a whole new password" })).body.error).toBe(
      "Sign in first, or give your profile ID."
    );
    const res = await c.post("/password", { id, currentPassword: PASSWORD, newPassword: "a whole new password" });
    expect(res.body).toEqual({ changed: true });
    expect(sessionCookie(res)).toBeUndefined();
  });

  test("signed in to one profile, changing another's leaves this sign-in alone", async () => {
    const mine = await created();
    const theirs = await created(client("203.0.113.50"));
    const res = await mine.c.post("/password", { id: theirs.id, currentPassword: PASSWORD, newPassword: "a whole new password" });
    expect(res.body).toEqual({ changed: true });
    expect(sessionCookie(res)).toBeUndefined();
    expect((await mine.c.get()).body.id).toBe(mine.id);
  });

  test("a change that raced another is refused", async () => {
    const { c } = await created();
    jest.spyOn(store, "changePassword").mockResolvedValueOnce(null);
    expect((await c.post("/password", { currentPassword: PASSWORD, newPassword: "a whole new password" })).status).toBe(409);
  });
});

describe("replacing the install link", () => {
  test("takes the password; the old link stops", async () => {
    const { c, id, installUrl } = await created();
    expect((await c.post("/link", { password: "wrong password" })).status).toBe(401);
    const res = await c.post("/link", { password: PASSWORD });
    expect(res.body.installUrl).toMatch(new RegExp(`/${id}\\.[A-Za-z0-9_-]{43}/manifest\\.json$`));
    expect(res.body.installUrl).not.toBe(installUrl);
    const oldToken = installUrl.split("/")[3].split(".")[1];
    expect(await store.resolveLink(id, oldToken)).toBeNull();
    expect((await c.get()).body.installUrl).toBe(res.body.installUrl);
    expect(log.log).toHaveBeenCalledWith(`[profiles] install link replaced for ${id.slice(0, 8)}`);
  });

  test("a replacement that raced a password change is refused", async () => {
    const { c } = await created();
    jest.spyOn(store, "replaceLink").mockResolvedValueOnce(null);
    expect((await c.post("/link", { password: PASSWORD })).status).toBe(409);
  });
});

describe("deleting a profile", () => {
  test("takes the password; the profile, its link and its sign-ins go, and this cookie with them", async () => {
    const { c, id } = await created();
    expect((await c.del("", { password: "wrong password" })).status).toBe(401);
    const res = await c.del("", { password: PASSWORD });
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await store.verify(id, PASSWORD)).toBeNull();
    expect(log.log).toHaveBeenCalledWith(`[profiles] deleted ${id.slice(0, 8)}`);
  });

  test("by ID and password without a sign-in, or of another profile than the one signed in", async () => {
    const theirs = await created(client("203.0.113.50"));
    expect((await client().del("", { id: theirs.id, password: PASSWORD })).status).toBe(204);
    const mine = await created();
    const other = await created(client("203.0.113.51"));
    const res = await mine.c.del("", { id: other.id, password: PASSWORD });
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toBeUndefined();
    expect((await mine.c.get()).status).toBe(200);
  });
});

describe("what is refused before anything else", () => {
  test("changes asked for by another site", async () => {
    const evil = await request(app).post("/api/profile/session").set("Origin", "https://evil.example").send({});
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe("Requests from other sites are refused.");
    expect((await request(app).post("/api/profile/session").set("Sec-Fetch-Site", "cross-site").send({})).status).toBe(403);
    expect((await request(app).post("/api/profile/session").set("Sec-Fetch-Site", "same-site").send({})).status).toBe(403);
    // The page's own requests pass, and reading is not a change.
    const own = await request(app)
      .post("/api/profile/session")
      .set("Host", "youstream.example")
      .set("Origin", "http://youstream.example")
      .set("Sec-Fetch-Site", "same-origin")
      .send({});
    expect(own.status).toBe(400);
    expect((await request(app).post("/api/profile/session").set("Sec-Fetch-Site", "none").send({})).status).toBe(400);
    expect((await request(app).get("/api/profile").set("Origin", "https://evil.example")).status).toBe(401);
  });

  test("profiles off, or a database not reachable", async () => {
    status = "off";
    expect((await client().get()).body).toEqual({ error: "Profiles are not available on this server." });
    expect((await client().get()).status).toBe(404);
    status = "unavailable";
    const res = await client().get();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/^Profiles are unavailable right now/);
    status = "starting";
    expect((await client().get()).status).toBe(503);
  });

  test("more than 120 requests a minute from one client", async () => {
    const c = client("192.0.2.77");
    for (let i = 0; i < 120; i++) await c.get();
    const res = await c.get();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many tries. Wait 60 seconds and try again.");
  });

  test("a body that is not JSON, or too large", async () => {
    const bad = await request(app).post("/api/profile/session").set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("That request was not valid JSON.");
    const big = await request(app)
      .put("/api/profile")
      .send({ config: { youtubeKey: "K", exclude: ["x".repeat(70000)] } });
    expect(big.status).toBe(413);
    expect(big.body.error).toBe("Those settings are larger than YouStream keeps.");
  });

  test("too many passwords being checked at once: busy, try again shortly", async () => {
    const { id } = await created();
    jest.spyOn(store, "verify").mockRejectedValueOnce(new BusyError());
    const res = await client().post("/session", { id, password: PASSWORD });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body.error).toBe("YouStream is busy checking passwords. Try again in a few seconds.");
  });

  test("anything unexpected is a 500, logged", async () => {
    jest.spyOn(store, "resolveSession").mockRejectedValueOnce(new Error("disk I/O error"));
    const res = await request(app).get("/api/profile").set("Cookie", `${COOKIE}=${"A".repeat(43)}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Something went wrong on YouStream's side. Try again in a minute.");
    expect(log.warn).toHaveBeenCalledWith("[profiles] GET /api/profile/ failed: disk I/O error");
  });
});

test("the first request notes how many addresses the proxies pass on, never which", async () => {
  await request(app).get("/api/profile").set("X-Forwarded-For", "198.51.100.1, 203.0.113.9");
  await request(app).get("/api/profile");
  const notes = log.log.mock.calls.map(([line]) => line).filter((line) => line.includes("X-Forwarded-For"));
  expect(notes).toEqual(["[profiles] requests arrive with 2 address(es) in X-Forwarded-For; the limits count the one TRUST_PROXY points to"]);
  expect(notes.join()).not.toContain("198.51.100.1");
});

describe("the sign-in cookie", () => {
  test("is read out of whatever else the browser sends", () => {
    const read = (cookie) => readSessionCookie({ headers: { cookie } });
    expect(readSessionCookie({ headers: {} })).toBeNull();
    expect(read("a=1; youstream_session=TOKEN; b=2")).toBe("TOKEN");
    expect(read("youstream_session_old=X; =Y; junk")).toBeNull();
    expect(read("youstream_session=")).toBeNull();
  });

  test("lasts as long as the sign-in, by the clock it is given", () => {
    const res = { cookie: jest.fn() };
    const req = { get: () => undefined, protocol: "http" };
    req.get = (h) => (h === "host" ? "h" : undefined);
    setSessionCookie(req, res, { token: "T", remembered: true, expiresAt: 5000 }, 1000);
    expect(res.cookie).toHaveBeenCalledWith(COOKIE, "T", { httpOnly: true, sameSite: "lax", path: "/", secure: false, maxAge: 4000 });
    setSessionCookie(req, res, { token: "T", remembered: true, expiresAt: 500 }, 1000);
    expect(res.cookie).toHaveBeenLastCalledWith(COOKIE, "T", expect.objectContaining({ maxAge: 0 }));
  });
});
