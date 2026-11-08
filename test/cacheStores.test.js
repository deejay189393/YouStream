const fs = require("fs");
const { EventEmitter } = require("events");
const os = require("os");
const path = require("path");
const RedisMock = require("ioredis-mock");
const { MemoryStore } = require("../src/cache/memory");
const { FileStore } = require("../src/cache/file");
const { RedisStore, CLIENT_OPTIONS } = require("../src/cache/redis");
const { DatabaseStore, POSTGRES_POOL } = require("../src/cache/database");
const { openDatabase } = require("../src/storage");

/**
 * The four stores behind the cache, held to the same contract: text by key
 * until an absolute expiry, cleared and counted by key prefix.
 */

const later = (ms = 60000) => Date.now() + ms;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => jest.restoreAllMocks());

function contract(name, make) {
  describe(`${name}: the shared contract`, () => {
    let store;
    beforeEach(async () => {
      store = await make();
    });
    afterEach(async () => {
      await store.close();
    });

    test("stores text and gives it back", async () => {
      await store.set("p:search:v1:a", "hello", later());
      expect(await store.get("p:search:v1:a")).toBe("hello");
      expect(await store.get("p:search:v1:b")).toBeNull();
    });

    test("replaces an entry", async () => {
      await store.set("p:search:v1:a", "one", later());
      await store.set("p:search:v1:a", "two", later());
      expect(await store.get("p:search:v1:a")).toBe("two");
    });

    test("forgets an entry once it expires", async () => {
      await store.set("p:search:v1:a", "brief", Date.now() + 30);
      await sleep(60);
      expect(await store.get("p:search:v1:a")).toBeNull();
    });

    test("deletes one entry", async () => {
      await store.set("p:search:v1:a", "x", later());
      await store.delete("p:search:v1:a");
      expect(await store.get("p:search:v1:a")).toBeNull();
      await store.delete("p:search:v1:never");
    });

    test("counts and clears by prefix, leaving the rest", async () => {
      await store.set("p:search:v1:a", "x", later());
      await store.set("p:search:v2:b", "x", later());
      await store.set("p:metadata:v1:c", "x", later());
      expect(await store.count("p:search:")).toBe(2);
      expect(await store.clear("p:search:")).toBe(2);
      expect(await store.count("p:search:")).toBe(0);
      expect(await store.get("p:metadata:v1:c")).toBe("x");
      expect(await store.clear("p:nothing:")).toBe(0);
    });

    test("does not count what has expired", async () => {
      await store.set("p:search:v1:a", "x", Date.now() + 30);
      await store.set("p:search:v1:b", "x", later());
      await sleep(60);
      expect(await store.count("p:search:")).toBe(1);
    });
  });
}

// --- memory ------------------------------------------------------------------

contract("MemoryStore", () => new MemoryStore({ maxBytes: 1e6 }));

describe("MemoryStore: size", () => {
  const entry = (n) => "x".repeat(n);

  test("drops the least recently used entries once over its size", async () => {
    const store = new MemoryStore({ maxBytes: 100 });
    await store.set("a", entry(40), later());
    await store.set("b", entry(40), later());
    await store.get("a"); // a is now more recently used than b
    await store.set("c", entry(40), later());
    expect(store.bytes).toBeLessThanOrEqual(100);
    expect(await store.get("a")).not.toBeNull();
    expect(await store.get("b")).toBeNull();
    expect(await store.get("c")).not.toBeNull();
  });

  test("does not keep an entry larger than the whole store", async () => {
    const store = new MemoryStore({ maxBytes: 10 });
    await store.set("a", entry(50), later());
    expect(await store.get("a")).toBeNull();
    expect(store.bytes).toBe(0);
  });

  test("keeps its count of bytes through replacements, expiry and deletes", async () => {
    const store = new MemoryStore({ maxBytes: 1000 });
    await store.set("a", entry(10), later());
    await store.set("a", entry(20), later());
    expect(store.bytes).toBe(21);
    await store.set("b", entry(5), Date.now() - 1);
    await store.get("b");
    await store.delete("a");
    expect(store.bytes).toBe(0);
  });
});

// --- files -------------------------------------------------------------------

describe("FileStore", () => {
  let dir;
  const stores = [];
  const open = (options = {}) => {
    const store = new FileStore({ dir, prefix: "p", maxBytes: 1e6, ...options });
    stores.push(store);
    return store;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "youstream-cache-"));
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.close()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  contract("FileStore", () => new FileStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "youstream-cache-")), prefix: "p", maxBytes: 1e6 }));

  test("lays a key out as directories, each file headed by its expiry, its time set to match", async () => {
    const store = open();
    const expiresAt = later();
    await store.set("p:search:v1:abc", "hello", expiresAt);
    const file = path.join(dir, "p", "search", "v1", "abc.json");
    expect(fs.readFileSync(file, "utf8")).toBe(`${expiresAt}\nhello`);
    expect(Math.abs(fs.statSync(file).mtimeMs - expiresAt)).toBeLessThan(1000);
  });

  test("removes an expired or unreadable file when it is read", async () => {
    const store = open();
    const file = path.join(dir, "p", "search", "v1", "old.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${Date.now() - 1}\nold`);
    expect(await store.get("p:search:v1:old")).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, "no header");
    expect(await store.get("p:search:v1:old")).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  test("a read that fails for another reason is an error", async () => {
    const store = open();
    fs.mkdirSync(path.join(dir, "p", "search", "v1", "adir.json"), { recursive: true });
    await expect(store.get("p:search:v1:adir")).rejects.toMatchObject({ code: "EISDIR" });
  });

  describe("the sweep", () => {
    const write = (name, expiresAt, size = 10) => {
      const file = path.join(dir, "p", "search", "v1", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${expiresAt}\n${"x".repeat(size)}`);
      fs.utimesSync(file, new Date(), new Date(expiresAt));
      return file;
    };

    test("removes expired entries and abandoned temporary files, and touches nothing outside its prefix", async () => {
      const store = open();
      await store.sweeping;
      const expired = write("expired.json", Date.now() - 1000);
      const current = write("current.json", later());
      const abandoned = write("x.json.1.ab.tmp", Date.now() - 2 * 60 * 60 * 1000);
      const writing = write("y.json.1.cd.tmp", later());
      const outside = path.join(dir, "other.json");
      fs.writeFileSync(outside, "{}");
      fs.utimesSync(outside, new Date(0), new Date(0));
      fs.writeFileSync(path.join(dir, "p", "notes.txt"), "kept");
      await store.sweep();
      expect([expired, current, abandoned, writing, outside].map((f) => fs.existsSync(f))).toEqual([false, true, false, true, true]);
      expect(fs.existsSync(path.join(dir, "p", "notes.txt"))).toBe(true);
    });

    test("over its size, removes whatever expires soonest", async () => {
      const store = open({ maxBytes: 100 });
      await store.sweeping;
      const soon = write("soon.json", later(60000), 40);
      const mid = write("mid.json", later(120000), 40);
      const last = write("last.json", later(180000), 40);
      await store.sweep();
      expect([soon, mid, last].map((f) => fs.existsSync(f))).toEqual([false, false, true]);
      expect(store.lastTotal).toBeLessThanOrEqual(90);
    });

    test("runs on its own once writes pass the size", async () => {
      const store = open({ maxBytes: 50 });
      await store.sweeping;
      await store.set("p:search:v1:a", "x".repeat(30), later(60000));
      await store.set("p:search:v1:b", "x".repeat(30), later(120000));
      await store.sweeping;
      expect(await store.get("p:search:v1:a")).toBeNull();
      expect(await store.get("p:search:v1:b")).not.toBeNull();
    });

    test("runs on a timer", async () => {
      const store = open({ sweepEveryMs: 20 });
      await store.sweeping;
      const expired = write("expired.json", Date.now() - 1000);
      await sleep(80);
      await store.sweeping;
      expect(fs.existsSync(expired)).toBe(false);
    });

    test("one at a time", async () => {
      const store = open();
      await store.sweeping;
      expect(store.sweep()).toBe(store.sweep());
      await store.sweeping;
    });

    test("a file gone between listing and reading is skipped", async () => {
      const store = open();
      await store.sweeping;
      write("a.json", later());
      jest.spyOn(fs.promises, "stat").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
      expect(await store.walk(path.join(dir, "p"))).toEqual([]);
    });

    test("a sweep that fails is logged, not thrown", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      fs.writeFileSync(path.join(dir, "p"), "a file where the directory should be");
      const store = open();
      await store.sweeping;
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[cache\] file sweep failed: ENOTDIR/));
    });
  });

  test("closing stops the timer and waits for a sweep under way", async () => {
    const store = open();
    const running = store.sweeping;
    await store.close();
    expect(store.sweeping).toBeNull();
    await running;
  });
});

// --- Redis -------------------------------------------------------------------

contract("RedisStore", async () => {
  const store = new RedisStore({ client: new RedisMock() });
  await store.client.flushall();
  return store;
});

describe("RedisStore", () => {
  test("waits for the first connection before its first command", async () => {
    const client = new RedisMock();
    const get = jest.spyOn(client, "get");
    const store = new RedisStore({ client });
    const pending = store.get("k");
    expect(get).not.toHaveBeenCalled();
    expect(await pending).toBeNull();
  });

  test("but not for long, and not when it is already connected", async () => {
    // A client whose first connection never comes.
    const silent = Object.assign(new EventEmitter(), { get: async () => null });
    const started = Date.now();
    expect(await new RedisStore({ client: silent, firstConnectionWaitMs: 30 }).get("k")).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const ready = new RedisMock();
    ready.status = "ready";
    expect(await new RedisStore({ client: ready }).get("k")).toBeNull();
  });

  test("hands Redis the expiry as a lifetime, never less than a millisecond", async () => {
    const client = new RedisMock();
    const set = jest.spyOn(client, "set");
    const store = new RedisStore({ client });
    await store.set("k", "v", Date.now() - 5000);
    expect(set).toHaveBeenCalledWith("k", "v", "PX", 1);
  });

  test("counts and clears in batches", async () => {
    const client = new RedisMock();
    await client.flushall();
    const scan = jest
      .spyOn(client, "scan")
      .mockResolvedValueOnce(["7", ["p:a", "p:b"]])
      .mockResolvedValueOnce(["0", []]);
    const store = new RedisStore({ client });
    expect(await store.count("p:")).toBe(2);
    expect(scan).toHaveBeenCalledWith("0", "MATCH", "p:*", "COUNT", 500);
    expect(scan).toHaveBeenCalledWith("7", "MATCH", "p:*", "COUNT", 500);
  });

  test("passes connection trouble on", () => {
    const client = new RedisMock();
    const onError = jest.fn();
    // eslint-disable-next-line no-new
    new RedisStore({ client, onError });
    client.emit("error", new Error("ECONNREFUSED"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "ECONNREFUSED" }));
  });

  test("with no one to tell, connection trouble is still not an uncaught error", () => {
    const client = new RedisMock();
    // eslint-disable-next-line no-new
    new RedisStore({ client });
    expect(() => client.emit("error", new Error("ECONNREFUSED"))).not.toThrow();
  });

  test("connects to a URL itself, set up for Railway's network and to fail fast", () => {
    const store = new RedisStore({ url: "redis://127.0.0.1:1" });
    store.client.disconnect();
    expect(store.client.options).toMatchObject({ family: 0, commandTimeout: 1000, enableOfflineQueue: false, port: 1 });
    expect(CLIENT_OPTIONS.family).toBe(0);
  });
});

// --- the database ------------------------------------------------------------

const quietLog = () => ({ warn: jest.fn() });

/** A store on a database that is open before the test starts. */
async function openStore(url, options = {}) {
  const store = new DatabaseStore({ url, prefix: "p", maxBytes: 1e6, log: quietLog(), ...options });
  await store.opening;
  // The sweep that follows opening, out of the test's way.
  await store.sweeping;
  // A shared PostgreSQL keeps what earlier runs left.
  await store.db.run("DELETE FROM cache_entries WHERE substr(id, 1, 2) IN ('p:', 'q:')");
  return store;
}

contract("DatabaseStore on SQLite", () => openStore("sqlite::memory:"));

const postgresUrl = process.env.POSTGRES_TEST_URL;
if (postgresUrl) {
  contract("DatabaseStore on PostgreSQL", () => openStore(postgresUrl));

  test("DatabaseStore on PostgreSQL: the table is unlogged, and the pool is the cache's own", async () => {
    const store = await openStore(postgresUrl);
    const row = await store.db.get("SELECT relpersistence FROM pg_class WHERE relname = 'cache_entries'");
    expect(row.relpersistence).toBe("u");
    expect(store.db.pool.options).toMatchObject({ max: 8, connectionTimeoutMillis: 1000, query_timeout: 2000 });
    await store.close();
  });
} else {
  test.skip("DatabaseStore on PostgreSQL (set POSTGRES_TEST_URL to run it)", () => {});
}

describe("DatabaseStore", () => {
  const stores = [];
  const track = (store) => {
    stores.push(store);
    return store;
  };
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.close()));
  });

  /** An opening that is held until the test lets it go. */
  function heldOpen() {
    let release;
    const open = jest.fn(
      () =>
        new Promise((resolve) => {
          release = async () => resolve(await openDatabase("sqlite::memory:"));
        })
    );
    return { open, release: () => release() };
  }

  test("opens DATABASE_URL's database with a small, quick pool of its own", async () => {
    const open = jest.fn(() => openDatabase("sqlite::memory:"));
    const store = track(new DatabaseStore({ url: "postgres://u:pw@db.internal:5432/railway", prefix: "p", maxBytes: 1e6, open }));
    await store.opening;
    expect(open).toHaveBeenCalledWith("postgres://u:pw@db.internal:5432/railway", {}, { postgres: POSTGRES_POOL });
    expect(store.kind).toBe("database");
    expect(store.where).toBe("PostgreSQL db.internal:5432/railway");
  });

  test("waits for its first opening, but not for long", async () => {
    const { open, release } = heldOpen();
    const log = quietLog();
    const store = track(new DatabaseStore({ url: "sqlite::memory:", prefix: "p", maxBytes: 1e6, open, log, firstOpenWaitMs: 30 }));
    const started = Date.now();
    await expect(store.get("p:a")).rejects.toThrow("SQLite :memory: is not open yet");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    await release();
    await store.opening;
    await store.set("p:a", "x", later());
    expect(await store.get("p:a")).toBe("x");
  });

  test("an opening that fails is tried again, less and less often, until it works", async () => {
    const log = quietLog();
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockImplementation(() => openDatabase("sqlite::memory:"));
    const store = track(new DatabaseStore({ url: "sqlite::memory:", prefix: "p", maxBytes: 1e6, open, log, retryFirstMs: 10 }));
    await expect(store.get("p:a")).rejects.toThrow("is not open yet");
    await sleep(100);
    await store.opening;
    expect(open).toHaveBeenCalledTimes(3);
    expect(log.warn.mock.calls.map((c) => c[0])).toEqual([
      "[cache] SQLite :memory: could not be opened: connect ECONNREFUSED; trying again in 0.01s",
      "[cache] SQLite :memory: could not be opened: connect ECONNREFUSED; trying again in 0.02s"
    ]);
    expect(await store.get("p:a")).toBeNull();
  });

  test("after a statement fails, it stops asking for a while, then asks again", async () => {
    const store = track(await openStore("sqlite::memory:", { pauseMs: 40 }));
    const get = jest.spyOn(store.db, "get").mockRejectedValueOnce(new Error("Connection terminated"));
    await expect(store.get("p:a")).rejects.toThrow("Connection terminated");
    await expect(store.get("p:a")).rejects.toThrow("SQLite :memory: failed a moment ago");
    expect(get).toHaveBeenCalledTimes(1);
    await sleep(60);
    expect(await store.get("p:a")).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("does not keep an entry larger than the whole store, and rounds the expiry to a whole millisecond", async () => {
    const store = track(await openStore("sqlite::memory:", { maxBytes: 20 }));
    await store.set("p:a", "x".repeat(50), later());
    expect(await store.get("p:a")).toBeNull();
    await store.set("p:b", "x", Date.now() + 60000.4);
    expect(Number.isInteger((await store.db.get("SELECT expires_at FROM cache_entries WHERE id = 'p:b'")).expires_at)).toBe(true);
  });

  describe("the sweep", () => {
    const row = (store, id, expiresAt, size = 10) =>
      store.db.run("INSERT INTO cache_entries (id, value, size, expires_at) VALUES (?, ?, ?, ?)", [id, "x".repeat(size), size, expiresAt]);
    // Sorted here, not by the database, whose collation may differ.
    const ids = async (store) =>
      (await store.db.all("SELECT id FROM cache_entries WHERE substr(id, 1, 2) IN ('p:', 'q:')")).map((r) => r.id).sort();

    const onEach = (name, url) =>
      describe(`on ${name}`, () => {
        test("removes every expired row, whoever wrote it", async () => {
          const store = track(await openStore(url));
          await row(store, "p:old", Date.now() - 1000);
          await row(store, "q:old", Date.now() - 1000);
          await row(store, "p:new", later());
          await store.sweep();
          expect(await ids(store)).toEqual(["p:new"]);
        });

        test("over its size, removes what of its own prefix expires soonest, down to 90%", async () => {
          const store = track(await openStore(url, { maxBytes: 100 }));
          await row(store, "p:soon", later(60000), 40);
          await row(store, "p:mid", later(120000), 40);
          await row(store, "p:last", later(180000), 40);
          await row(store, "q:other", later(30000), 400);
          await store.sweep();
          expect(await ids(store)).toEqual(["p:last", "p:mid", "q:other"]);
          expect(store.lastTotal).toBe(80);
        });

        test("runs on its own once writes pass the size", async () => {
          const store = track(await openStore(url, { maxBytes: 80 }));
          await store.sweeping;
          await store.set("p:a", "x".repeat(30), later(60000));
          await store.set("p:b", "x".repeat(30), later(120000));
          expect(store.sweeping).toBeNull();
          await store.set("p:c", "x".repeat(30), later(180000));
          await store.sweeping;
          expect(await ids(store)).toEqual(["p:b", "p:c"]);
        });
      });
    onEach("SQLite", "sqlite::memory:");
    if (postgresUrl) onEach("PostgreSQL", postgresUrl);

    test("runs once the database opens, and then on a timer", async () => {
      const store = track(await openStore("sqlite::memory:", { sweepEveryMs: 20 }));
      await row(store, "p:old", Date.now() - 1000);
      await sleep(80);
      await store.sweeping;
      expect(await ids(store)).toEqual([]);
    });

    test("one at a time, and nothing to do before the database is open", async () => {
      const store = track(await openStore("sqlite::memory:"));
      expect(store.sweep()).toBe(store.sweep());
      await store.sweeping;
      const { open, release } = heldOpen();
      const waiting = track(new DatabaseStore({ url: "sqlite::memory:", prefix: "p", maxBytes: 1e6, open, log: quietLog() }));
      await waiting.sweep();
      expect(waiting.lastTotal).toBe(0);
      await release();
    });

    test("a sweep that fails is logged, not thrown", async () => {
      const log = quietLog();
      const store = track(await openStore("sqlite::memory:", { log }));
      jest.spyOn(store.db, "run").mockRejectedValueOnce(new Error("disk I/O error"));
      await store.sweep();
      expect(log.warn).toHaveBeenCalledWith("[cache] database sweep failed: disk I/O error");
    });
  });

  test("closing stops its timers, waits for a sweep under way, and closes the database", async () => {
    const store = await openStore("sqlite::memory:");
    const close = jest.spyOn(store.db, "close");
    const running = store.sweep();
    await store.close();
    await running;
    expect(close).toHaveBeenCalled();
    expect(store.db).toBeNull();
    await store.close();
  });

  test("closed while opening, it closes the database once it opens, and tries no more", async () => {
    const { open, release } = heldOpen();
    const store = new DatabaseStore({ url: "sqlite::memory:", prefix: "p", maxBytes: 1e6, open, log: quietLog() });
    const closing = store.close();
    await release();
    await closing;
    expect(store.db).toBeNull();
    const failing = new DatabaseStore({
      url: "sqlite::memory:",
      prefix: "p",
      maxBytes: 1e6,
      open: () => Promise.reject(new Error("refused")),
      log: quietLog()
    });
    await failing.close();
    expect(failing.retryTimer).toBeNull();
  });
});
