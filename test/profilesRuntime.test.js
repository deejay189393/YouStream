const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const profiles = require("../src/profiles");
const { openDatabase } = require("../src/storage");
const { secretFingerprint } = require("../src/profiles/crypto");
const { COOKIE } = require("../src/profiles/session");
const { FAST, SESSIONS } = require("./profileStore.suite");

const DAY = 24 * 60 * 60 * 1000;
const settings = (over = {}) => ({
  enabled: true,
  databaseUrl: "sqlite::memory:",
  secret: crypto.randomBytes(32),
  sessions: SESSIONS,
  pruneAfterMs: 0,
  kdf: FAST,
  ...over
});
const quiet = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

afterEach(async () => {
  jest.useRealTimers();
  await profiles.stop();
});

describe("starting", () => {
  test("off unless the host turned profiles on", async () => {
    await profiles.start({ enabled: false });
    expect(profiles.status()).toBe("off");
    expect(profiles.getStore()).toBeNull();
  });

  test("on: the database opened, its tables made", async () => {
    const log = quiet();
    await profiles.start(settings(), { log });
    expect(profiles.status()).toBe("ready");
    expect(profiles.getStore()).not.toBeNull();
    expect(log.log).toHaveBeenCalledWith("[profiles] on, kept in SQLite :memory:; tables set up: profiles");
  });

  test("a database already set up says only where it is", async () => {
    const { db } = await openDatabase("sqlite::memory:");
    const log = quiet();
    await profiles.start(settings(), { open: async () => ({ db, applied: [] }), log });
    expect(log.log).toHaveBeenCalledWith("[profiles] on, kept in SQLite :memory:");
  });

  test("a database that is down is tried again, less and less often, until it answers", async () => {
    jest.useFakeTimers();
    const { db } = await openDatabase("sqlite::memory:");
    const open = jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const log = quiet();
    await profiles.start(settings({ databaseUrl: "postgres://u:pw@db.internal:5432/youstream" }), { open, log });
    expect(profiles.status()).toBe("unavailable");
    expect(profiles.getStore()).toBeNull();
    expect(log.warn).toHaveBeenLastCalledWith(
      "[profiles] PostgreSQL db.internal:5432/youstream could not be opened: connect ECONNREFUSED; trying again in 5s"
    );
    for (const seconds of [10, 20, 40, 80, 160, 300, 300]) {
      await jest.advanceTimersByTimeAsync(RETRY(log));
      expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining(`trying again in ${seconds}s`));
    }
    open.mockResolvedValue({ db, applied: [] });
    await jest.advanceTimersByTimeAsync(300 * 1000);
    expect(profiles.status()).toBe("ready");
    expect(open).toHaveBeenCalledTimes(9);
  });

  test("a database that opens but then fails is closed before the next attempt", async () => {
    jest.useFakeTimers();
    const closed = [];
    const flaky = {
      dialect: "postgres",
      get: async () => Promise.reject(new Error("connection reset")),
      run: async () => ({ changes: 0 }),
      close: async () => {
        closed.push("flaky");
        throw new Error("already gone");
      }
    };
    const { db } = await openDatabase("sqlite::memory:");
    const open = jest.fn().mockResolvedValueOnce({ db: flaky, applied: [] }).mockResolvedValue({ db, applied: [] });
    const log = quiet();
    await profiles.start(settings(), { open, log });
    expect(closed).toEqual(["flaky"]);
    expect(log.warn).toHaveBeenCalledWith("[profiles] SQLite :memory: could not be opened: connection reset; trying again in 5s");
    await jest.advanceTimersByTimeAsync(5000);
    expect(profiles.status()).toBe("ready");
  });

  test("a database sealed with another SECRET_KEY is refused, loudly, and not tried again", async () => {
    jest.useFakeTimers();
    const { db } = await openDatabase("sqlite::memory:");
    await db.run("INSERT INTO profile_store (name, value) VALUES ('secret', ?)", [secretFingerprint(crypto.randomBytes(32))]);
    const open = jest.fn(async () => ({ db, applied: [] }));
    const log = quiet();
    await profiles.start(settings(), { open, log });
    expect(profiles.status()).toBe("unavailable");
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^\[profiles\] SECRET_KEY is not the one the profiles in SQLite :memory: were made with/));
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(open).toHaveBeenCalledTimes(1);
    // And closed: nothing is left holding the file.
    await expect(db.get("SELECT 1")).rejects.toThrow(/not open/);
  });
});

/** The wait before the next attempt, as the last warning says it. */
function RETRY(log) {
  const [line] = log.warn.mock.calls[log.warn.mock.calls.length - 1];
  return Number(/trying again in (\d+)s/.exec(line)[1]) * 1000;
}

describe("pruning", () => {
  test("at start and every 6 hours: expired sign-ins, and profiles unused past the host's limit", async () => {
    jest.useFakeTimers({ now: Date.now() });
    const { db } = await openDatabase("sqlite::memory:");
    await db.run(
      `INSERT INTO profiles (id, password_salt, password_kdf, key_by_password, key_by_link, link_token, config, key_version,
         created_at, updated_at, last_used_at) VALUES ('old', 's', 'scrypt:4:8:1', 'x', 'x', 'x', 'x', 1, 0, 0, 0)`
    );
    await db.run(
      `INSERT INTO profile_sessions (id, profile_id, profile_key, key_version, remembered, created_at, last_used_at, expires_at)
       VALUES ('gone', 'old', 'x', 1, 0, 0, 0, 1)`
    );
    const log = quiet();
    await profiles.start(settings({ pruneAfterMs: 365 * DAY }), { open: async () => ({ db, applied: [] }), log });
    expect(log.log).toHaveBeenCalledWith("[profiles] pruned 1 unused profiles and 1 expired sign-ins");
    const prune = jest.spyOn(profiles.getStore(), "prune");
    await jest.advanceTimersByTimeAsync(profiles.PRUNE_EVERY_MS);
    expect(prune).toHaveBeenCalledWith(365 * DAY);
    expect(log.log).toHaveBeenCalledTimes(2);
    prune.mockRejectedValueOnce(new Error("database is locked"));
    await jest.advanceTimersByTimeAsync(profiles.PRUNE_EVERY_MS);
    expect(log.warn).toHaveBeenCalledWith("[profiles] pruning failed: database is locked");
  });
});

describe("what the configure page is told", () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use("/api/profile", profiles.apiRouter);
    app.get("/state", async (req, res) => res.json(await profiles.pageState(req, res, req.query.link)));
  });

  test("profiles off", async () => {
    expect((await request(app).get("/state")).body).toEqual({ enabled: false, unavailable: false, signedIn: null, link: null });
  });

  test("on, but the database not reachable", async () => {
    jest.useFakeTimers();
    await profiles.start(settings(), { open: async () => Promise.reject(new Error("down")), log: quiet() });
    expect((await request(app).get("/state")).body).toEqual({ enabled: true, unavailable: true, signedIn: null, link: null });
  });

  test("signed in or not; and, from an install link, whether the link works", async () => {
    await profiles.start(settings(), { log: quiet() });
    expect((await request(app).get("/state")).body).toEqual({ enabled: true, unavailable: false, signedIn: null, link: null });
    const agent = request.agent(app);
    const created = (
      await agent.post("/api/profile").set("Host", "youstream.test").send({ config: { youtubeKey: "AIzaSyTESTKEY" }, password: "correct horse battery" })
    ).body;
    const segment = created.installUrl.split("/")[3];
    const state = (await agent.get("/state").set("Host", "youstream.test").query({ link: segment })).body;
    expect(state).toEqual({
      enabled: true,
      unavailable: false,
      signedIn: {
        id: created.id,
        installUrl: created.installUrl,
        remembered: true,
        config: { youtubeKey: "AIzaSyTESTKEY", playback: ["app", "youtube"], playbackVersion: 1 }
      },
      link: { id: created.id, works: true }
    });
    expect((await agent.get("/state").query({ link: `${created.id}.${"Z".repeat(43)}` })).body.link).toEqual({ id: created.id, works: false });
    expect((await agent.get("/state").query({ link: "not-a-link" })).body.link).toBeNull();
  });

  test("a sign-in whose profile no longer opens is ended", async () => {
    await profiles.start(settings(), { log: quiet() });
    const agent = request.agent(app);
    const { id } = (await agent.post("/api/profile").send({ config: { youtubeKey: "K" }, password: "correct horse battery" })).body;
    // Its settings no longer open (a database restored from elsewhere, say).
    await profiles.getStore().save(id, { key: crypto.randomBytes(32), version: 1 }, { youtubeKey: "K" });
    const res = await agent.get("/state");
    expect(res.body.signedIn).toBeNull();
    expect(res.headers["set-cookie"].join()).toMatch(new RegExp(`${COOKIE}=;`));
    expect((await agent.get("/api/profile")).status).toBe(401);
  });

  test("a database that fails mid-way reads as unavailable", async () => {
    await profiles.start(settings(), { log: quiet() });
    jest.spyOn(profiles.getStore(), "resolveSession").mockRejectedValueOnce(new Error("disk I/O error"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(app).get("/state").set("Cookie", `${COOKIE}=${"A".repeat(43)}`);
    expect(res.body).toEqual({ enabled: true, unavailable: true, signedIn: null, link: null });
    expect(warn).toHaveBeenCalledWith("[profiles] the configure page could not read profiles: disk I/O error");
    warn.mockRestore();
  });
});
