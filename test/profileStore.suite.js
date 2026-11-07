/**
 * The profile store's behaviour, run against each database it supports:
 * SQLite always (profileStore.test.js), PostgreSQL when POSTGRES_TEST_URL
 * names one (profileStore.postgres.test.js).
 */
const crypto = require("crypto");
const { createProfileStore, MAX_SESSIONS, SESSION_TOUCH_MS, LINK_TOUCH_MS } = require("../src/profiles/store");

/** Cheap scrypt: these tests are about the store, not the cost. */
const FAST = { logN: 4, r: 8, p: 1 };
const DAY = 24 * 60 * 60 * 1000;
const SESSIONS = { rememberedMs: 30 * DAY, maxMs: 90 * DAY, browserMs: DAY };
const CONFIG = { youtubeKey: "AIzaSyTESTKEY", tmdbKey: "tmdb-key", maxResults: 7 };

function storeSuite(label, connect) {
  describe(`the profile store, on ${label}`, () => {
    let db;
    let clock;
    let store;
    const make = (secret) => createProfileStore({ db, secret, sessions: SESSIONS, kdf: FAST, now: () => clock.t });

    beforeAll(async () => {
      db = await connect();
    });
    afterAll(() => db.close());
    beforeEach(async () => {
      await db.run("DELETE FROM profile_sessions");
      await db.run("DELETE FROM profiles");
      await db.run("DELETE FROM profile_store");
      clock = { t: 1800000000000 };
      store = make(crypto.randomBytes(32));
    });

    test("a profile keeps its settings sealed: nothing readable in any column", async () => {
      const { id, linkToken, access } = await store.create(CONFIG, "correct horse battery");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(linkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(access.version).toBe(1);
      const row = await db.get("SELECT * FROM profiles WHERE id = ?", [id]);
      const stored = JSON.stringify(row);
      for (const secretBit of ["AIzaSyTESTKEY", "tmdb-key", "correct horse", linkToken, access.key.toString("base64url")]) {
        expect(stored).not.toContain(secretBit);
      }
      expect(row.password_kdf).toBe("scrypt:4:8:1");
      expect(row.created_at).toBe(clock.t);
      expect(row.last_used_at).toBe(clock.t);
    });

    test("the password opens it; a wrong one, or a profile that is not there, does not", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const opened = await store.verify(id, "correct horse battery");
      expect(opened.version).toBe(1);
      expect(opened.key.equals(access.key)).toBe(true);
      expect(await store.verify(id, "correct horse batterY")).toBeNull();
      expect(await store.verify(crypto.randomUUID(), "correct horse battery")).toBeNull();
    });

    test("read: the settings and the link token, for current access only", async () => {
      const { id, linkToken, access } = await store.create(CONFIG, "correct horse battery");
      expect(await store.read(id, access)).toEqual({ config: CONFIG, linkToken, createdAt: clock.t, updatedAt: clock.t });
      expect(await store.read(id, { key: access.key, version: 2 })).toBeNull();
      expect(await store.read(crypto.randomUUID(), access)).toBeNull();
      // Settings this key does not open (a database tampered with, a key mixed up).
      await db.run("UPDATE profiles SET config = 'v1.broken' WHERE id = ?", [id]);
      expect(await store.read(id, access)).toBeNull();
    });

    test("the install link opens the settings, and nothing else does", async () => {
      const { id, linkToken } = await store.create(CONFIG, "correct horse battery");
      expect(await store.resolveLink(id, linkToken)).toEqual(CONFIG);
      expect(await store.resolveLink(id, linkToken.slice(0, -1) + (linkToken.endsWith("A") ? "B" : "A"))).toBeNull();
      expect(await store.resolveLink(id, "short")).toBeNull();
      expect(await store.resolveLink(crypto.randomUUID(), linkToken)).toBeNull();
      // A profile's link does not open another's settings.
      const other = await store.create({ youtubeKey: "OTHER" }, "another password");
      expect(await store.resolveLink(other.id, linkToken)).toBeNull();
    });

    test("using the link counts as using the profile, at most once an hour", async () => {
      const { id, linkToken } = await store.create(CONFIG, "correct horse battery");
      const lastUsed = async () => (await db.get("SELECT last_used_at FROM profiles WHERE id = ?", [id])).last_used_at;
      const created = clock.t;
      clock.t += LINK_TOUCH_MS - 1;
      await store.resolveLink(id, linkToken);
      expect(await lastUsed()).toBe(created);
      clock.t += 1;
      await store.resolveLink(id, linkToken);
      expect(await lastUsed()).toBe(clock.t);
    });

    test("saving replaces the settings; an out-of-date access, or a profile gone, saves nothing", async () => {
      const { id, linkToken, access } = await store.create(CONFIG, "correct horse battery");
      clock.t += 5000;
      expect(await store.save(id, access, { youtubeKey: "NEW" })).toBe(true);
      expect(await store.resolveLink(id, linkToken)).toEqual({ youtubeKey: "NEW" });
      expect((await store.read(id, access)).updatedAt).toBe(clock.t);
      expect(await store.save(id, { key: access.key, version: 2 }, { youtubeKey: "STALE" })).toBe(false);
      expect(await store.save(crypto.randomUUID(), access, CONFIG)).toBe(false);
      expect(await store.resolveLink(id, linkToken)).toEqual({ youtubeKey: "NEW" });
    });

    test("a new password: a new key, every sign-in ended, the same install link", async () => {
      const { id, linkToken, access } = await store.create(CONFIG, "correct horse battery");
      const session = await store.openSession(id, access, true);
      const renewed = await store.changePassword(id, access, "a whole new password");
      expect(renewed.version).toBe(2);
      expect(renewed.key.equals(access.key)).toBe(false);
      expect(await store.verify(id, "correct horse battery")).toBeNull();
      expect((await store.verify(id, "a whole new password")).version).toBe(2);
      expect(await store.resolveLink(id, linkToken)).toEqual(CONFIG);
      expect(await store.resolveSession(session.token)).toBeNull();
      expect(await store.read(id, renewed)).toEqual(expect.objectContaining({ config: CONFIG, linkToken }));
      // The old key is out of date for everything now.
      expect(await store.read(id, access)).toBeNull();
      expect(await store.changePassword(id, access, "yet another one")).toBeNull();
      expect(await store.changePassword(crypto.randomUUID(), renewed, "yet another one")).toBeNull();
    });

    test("a password change that cannot open what it must re-seal changes nothing", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      await db.run("UPDATE profiles SET link_token = 'v1.broken' WHERE id = ?", [id]);
      expect(await store.changePassword(id, access, "a whole new password")).toBeNull();
      expect((await store.verify(id, "correct horse battery")).version).toBe(1);
    });

    test("a new install link stops the old one at once", async () => {
      const { id, linkToken, access } = await store.create(CONFIG, "correct horse battery");
      const replaced = await store.replaceLink(id, access);
      expect(replaced).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await store.resolveLink(id, linkToken)).toBeNull();
      expect(await store.resolveLink(id, replaced)).toEqual(CONFIG);
      expect((await store.read(id, access)).linkToken).toBe(replaced);
      expect(await store.replaceLink(id, { key: access.key, version: 9 })).toBeNull();
    });

    test("deleting a profile deletes its sign-ins too", async () => {
      const { id, linkToken, access } = await store.create(CONFIG, "correct horse battery");
      const session = await store.openSession(id, access, false);
      expect(await store.remove(id)).toBe(true);
      expect(await store.remove(id)).toBe(false);
      expect(await store.resolveLink(id, linkToken)).toBeNull();
      expect(await store.resolveSession(session.token)).toBeNull();
      expect(await db.get("SELECT COUNT(*) AS n FROM profile_sessions")).toEqual({ n: expect.anything() });
      expect(Number((await db.get("SELECT COUNT(*) AS n FROM profile_sessions")).n)).toBe(0);
    });

    test("a sign-in: remembered for 30 days, or a day; the database keeps only its token's hash", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const remembered = await store.openSession(id, access, true);
      expect(remembered).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), remembered: true, expiresAt: clock.t + 30 * DAY });
      const browser = await store.openSession(id, access, false);
      expect(browser.expiresAt).toBe(clock.t + DAY);
      const rows = JSON.stringify(await db.all("SELECT * FROM profile_sessions"));
      expect(rows).not.toContain(remembered.token);
      expect(rows).not.toContain(browser.token);
      const resolved = await store.resolveSession(remembered.token);
      expect(resolved).toEqual({ id, access: { key: expect.any(Buffer), version: 1 }, remembered: true, expiresAt: clock.t + 30 * DAY, renewed: false });
      expect(resolved.access.key.equals(access.key)).toBe(true);
      expect((await store.resolveSession(browser.token)).remembered).toBe(false);
    });

    test("tokens that are not a sign-in's resolve to nothing", async () => {
      expect(await store.resolveSession("not a token")).toBeNull();
      expect(await store.resolveSession(undefined)).toBeNull();
      expect(await store.resolveSession("A".repeat(43))).toBeNull();
    });

    test("an expired sign-in, or one from before the key changed, is deleted when it is used", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const short = await store.openSession(id, access, false);
      const kept = await store.openSession(id, access, true);
      clock.t += DAY;
      expect(await store.resolveSession(short.token)).toBeNull();
      await db.run("UPDATE profiles SET key_version = 2 WHERE id = ?", [id]);
      expect(await store.resolveSession(kept.token)).toBeNull();
      expect(Number((await db.get("SELECT COUNT(*) AS n FROM profile_sessions")).n)).toBe(0);
    });

    test("a sign-in made under another SECRET_KEY opens nothing", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const session = await store.openSession(id, access, true);
      expect(await make(crypto.randomBytes(32)).resolveSession(session.token)).toBeNull();
    });

    test("in use, a remembered sign-in moves out hourly, never past 90 days from its start", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const started = clock.t;
      const session = await store.openSession(id, access, true);
      clock.t += SESSION_TOUCH_MS - 1;
      expect((await store.resolveSession(session.token)).renewed).toBe(false);
      clock.t += 1;
      const moved = await store.resolveSession(session.token);
      expect(moved).toEqual(expect.objectContaining({ renewed: true, expiresAt: clock.t + 30 * DAY }));
      for (let day = 1; day <= 85; day += 28) {
        clock.t = started + day * DAY;
        await store.resolveSession(session.token);
      }
      clock.t = started + 89 * DAY;
      expect((await store.resolveSession(session.token)).expiresAt).toBe(started + 90 * DAY);
      clock.t = started + 90 * DAY;
      expect(await store.resolveSession(session.token)).toBeNull();
    });

    test("one not remembered never moves out", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const session = await store.openSession(id, access, false);
      clock.t += SESSION_TOUCH_MS;
      expect(await store.resolveSession(session.token)).toEqual(expect.objectContaining({ renewed: false, expiresAt: session.expiresAt }));
    });

    test(`a profile keeps ${MAX_SESSIONS} sign-ins: the longest unused goes first`, async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const tokens = [];
      for (let i = 0; i < MAX_SESSIONS + 2; i++) {
        clock.t += 1000;
        tokens.push((await store.openSession(id, access, true)).token);
      }
      expect(Number((await db.get("SELECT COUNT(*) AS n FROM profile_sessions WHERE profile_id = ?", [id])).n)).toBe(MAX_SESSIONS);
      expect(await store.resolveSession(tokens[0])).toBeNull();
      expect(await store.resolveSession(tokens[1])).toBeNull();
      expect(await store.resolveSession(tokens[2])).not.toBeNull();
      expect(await store.resolveSession(tokens[MAX_SESSIONS + 1])).not.toBeNull();
    });

    test("signing out: one browser, or all of them", async () => {
      const { id, access } = await store.create(CONFIG, "correct horse battery");
      const a = await store.openSession(id, access, true);
      const b = await store.openSession(id, access, true);
      await store.endSession("not a token");
      await store.endSession(a.token);
      expect(await store.resolveSession(a.token)).toBeNull();
      expect(await store.resolveSession(b.token)).not.toBeNull();
      await store.openSession(id, access, false);
      expect(await store.endAllSessions(id)).toBe(2);
      expect(await store.resolveSession(b.token)).toBeNull();
    });

    test("the database remembers which SECRET_KEY sealed it", async () => {
      const secret = crypto.randomBytes(32);
      expect(await make(secret).checkSecret()).toBe(true);
      expect(await make(secret).checkSecret()).toBe(true);
      expect(await make(crypto.randomBytes(32)).checkSecret()).toBe(false);
    });

    test("pruning: expired sign-ins always; unused profiles only when asked", async () => {
      const old = await store.create(CONFIG, "correct horse battery");
      await store.openSession(old.id, old.access, false);
      clock.t += 400 * DAY;
      const fresh = await store.create(CONFIG, "correct horse battery");
      await store.openSession(fresh.id, fresh.access, true);
      expect(await store.prune(0)).toEqual({ sessions: 1, profiles: 0 });
      expect(await store.prune(365 * DAY)).toEqual({ sessions: 0, profiles: 1 });
      expect(await store.resolveLink(old.id, old.linkToken)).toBeNull();
      expect(await store.resolveLink(fresh.id, fresh.linkToken)).toEqual(CONFIG);
    });
  });
}

module.exports = { storeSuite, FAST, SESSIONS, CONFIG, DAY };
