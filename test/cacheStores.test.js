const fs = require("fs");
const { EventEmitter } = require("events");
const os = require("os");
const path = require("path");
const RedisMock = require("ioredis-mock");
const { MemoryStore } = require("../src/cache/memory");
const { FileStore } = require("../src/cache/file");
const { RedisStore, CLIENT_OPTIONS } = require("../src/cache/redis");

/**
 * The three stores behind the cache, held to the same contract: text by key
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
