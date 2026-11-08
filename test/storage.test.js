const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseDatabaseUrl, describeDatabase, openDatabase } = require("../src/storage");
const { SqliteDriver } = require("../src/storage/sqlite");
const { PostgresDriver, numbered } = require("../src/storage/postgres");
const { migrate, MIGRATIONS } = require("../src/storage/migrations");

describe("DATABASE_URL", () => {
  test("SQLite: an absolute path, a path relative to where YouStream runs, or memory", () => {
    expect(parseDatabaseUrl("sqlite:///data/youstream.db")).toEqual({ dialect: "sqlite", filename: "/data/youstream.db" });
    expect(parseDatabaseUrl(" sqlite://./data/youstream.db ")).toEqual({
      dialect: "sqlite",
      filename: path.join(process.cwd(), "data/youstream.db")
    });
    expect(parseDatabaseUrl("sqlite:///data/my%20profiles.db").filename).toBe("/data/my profiles.db");
    expect(parseDatabaseUrl("sqlite::memory:")).toEqual({ dialect: "sqlite", filename: ":memory:" });
  });

  test("PostgreSQL, under either name", () => {
    expect(parseDatabaseUrl("postgres://u:p@h:5432/db")).toEqual({ dialect: "postgres", connectionString: "postgres://u:p@h:5432/db" });
    expect(parseDatabaseUrl("postgresql://h/db").dialect).toBe("postgres");
  });

  test("anything else is refused, saying what would do", () => {
    expect(() => parseDatabaseUrl("")).toThrow("DATABASE_URL is not a URL");
    expect(() => parseDatabaseUrl(undefined)).toThrow("DATABASE_URL is not a URL");
    expect(() => parseDatabaseUrl("mysql://h/db")).toThrow("must start with sqlite: or postgres:, not mysql:");
    expect(() => parseDatabaseUrl("sqlite://host/file.db")).toThrow("A SQLite DATABASE_URL needs a file");
    expect(() => parseDatabaseUrl("sqlite:///")).toThrow("A SQLite DATABASE_URL needs a file");
    expect(() => parseDatabaseUrl("sqlite:")).toThrow("A SQLite DATABASE_URL needs a file");
  });

  test("described for the log without a password", () => {
    expect(describeDatabase("postgres://user:secret@db.railway.internal:5432/railway")).toBe("PostgreSQL db.railway.internal:5432/railway");
    expect(describeDatabase("postgres://db/railway")).toBe("PostgreSQL db/railway");
    expect(describeDatabase("sqlite:///data/y.db")).toBe("SQLite /data/y.db");
  });
});

describe("the SQLite driver", () => {
  let db;
  beforeEach(() => {
    db = new SqliteDriver(":memory:");
  });
  afterEach(() => db.close());

  test("runs statements, binding booleans and undefined as SQLite can", async () => {
    await db.run("CREATE TABLE t (a INTEGER, b TEXT)");
    expect(await db.run("INSERT INTO t VALUES (?, ?)", [true, undefined])).toEqual({ changes: 1 });
    await db.run("INSERT INTO t VALUES (?, ?)", [false, "x"]);
    expect(await db.all("SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 0, b: "x" },
      { a: 1, b: null }
    ]);
    expect(await db.get("SELECT b FROM t WHERE a = ?", [0])).toEqual({ b: "x" });
    expect(await db.get("SELECT b FROM t WHERE a = ?", [9])).toBeNull();
    // A statement is prepared once and reused.
    await db.get("SELECT b FROM t WHERE a = ?", [1]);
    expect(db.statements.size).toBe(4);
  });

  test("a transaction commits when it resolves, rolls back when it throws", async () => {
    await db.run("CREATE TABLE t (a INTEGER)");
    const result = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (?)", [1]);
      expect(await tx.get("SELECT COUNT(*) AS n FROM t")).toEqual({ n: 1 });
      expect(await tx.all("SELECT a FROM t")).toEqual([{ a: 1 }]);
      return "done";
    });
    expect(result).toBe("done");
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await db.all("SELECT a FROM t")).toEqual([{ a: 1 }]);
  });

  test("the error that failed a transaction is the one reported, even when SQLite already rolled it back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.run("ROLLBACK");
        throw new Error("the real failure");
      })
    ).rejects.toThrow("the real failure");
  });

  test("one failure does not fail what was queued after it", async () => {
    const bad = db.run("SELECT * FROM missing");
    const good = db.get("SELECT 1 AS one");
    await expect(bad).rejects.toThrow(/no such table/);
    expect(await good).toEqual({ one: 1 });
  });

  test("a file database is made in its folder, created if need be", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youstream-sqlite-"));
    const file = path.join(dir, "nested", "profiles.db");
    const fileDb = new SqliteDriver(file);
    expect(await fileDb.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    expect(await fileDb.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    await fileDb.close();
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** pg, as far as the driver uses it: a pool that answers from a script. */
function fakePg(answer = () => ({ rows: [], rowCount: 0 })) {
  const calls = [];
  const released = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.push(["client", sql, params]);
      return answer(sql, params);
    }),
    release: jest.fn((broken) => released.push(broken))
  };
  class Pool {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      Pool.instance = this;
    }
    on(event, fn) {
      this.listeners[event] = fn;
    }
    async query(sql, params) {
      calls.push(["pool", sql, params]);
      return answer(sql, params);
    }
    async connect() {
      return client;
    }
    async end() {
      this.ended = true;
    }
  }
  return { Pool, types: { getTypeParser: jest.fn(() => "default parser") }, calls, client, released };
}

describe("the Postgres driver", () => {
  test("numbers the placeholders, and binds booleans and undefined as SQLite does", async () => {
    expect(numbered("a = ? AND b = ? OR c = ?")).toBe("a = $1 AND b = $2 OR c = $3");
    const pg = fakePg((sql) => (sql.startsWith("SELECT") ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: null }));
    const db = new PostgresDriver("postgres://h/db", pg);
    expect(await db.run("UPDATE t SET a = ? WHERE b = ?", [true, undefined])).toEqual({ changes: 0 });
    expect(pg.calls[0]).toEqual(["pool", "UPDATE t SET a = $1 WHERE b = $2", [1, null]]);
    expect(await db.all("SELECT n FROM t")).toEqual([{ n: 1 }]);
    expect(await db.get("SELECT n FROM t WHERE a = ?", [false])).toEqual({ n: 1 });
    expect(pg.calls[2][2]).toEqual([0]);
    await db.close();
    expect(pg.Pool.instance.ended).toBe(true);
  });

  test("uses the real pg unless given another; nothing connects before the first query", async () => {
    const db = new PostgresDriver("postgres://nobody@127.0.0.1:9/none");
    expect(db.pool.constructor.name).toBe("BoundPool");
    await db.close();
  });

  test("a row that is not there is null", async () => {
    const db = new PostgresDriver("postgres://h/db", fakePg());
    expect(await db.get("SELECT 1")).toBeNull();
  });

  test("reads BIGINT columns as numbers, and every other type as pg would", () => {
    const pg = fakePg();
    new PostgresDriver("postgres://h/db", pg);
    const { getTypeParser } = pg.Pool.instance.options.types;
    expect(getTypeParser(20)("1794070596985")).toBe(1794070596985);
    expect(getTypeParser(25, "text")).toBe("default parser");
    expect(pg.types.getTypeParser).toHaveBeenCalledWith(25, "text");
    expect(pg.Pool.instance.options.connectionString).toBe("postgres://h/db");
  });

  test("a pool's settings can be changed, but never how BIGINT is read", () => {
    const pg = fakePg();
    new PostgresDriver("postgres://h/db", pg, { max: 8, connectionTimeoutMillis: 1000, types: "ignored" });
    expect(pg.Pool.instance.options).toMatchObject({ max: 8, connectionTimeoutMillis: 1000, idleTimeoutMillis: 30000 });
    expect(pg.Pool.instance.options.types.getTypeParser(20)("12")).toBe(12);
  });

  test("an idle connection the server drops is logged, not fatal", () => {
    const pg = fakePg();
    new PostgresDriver("postgres://h/db", pg);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    pg.Pool.instance.listeners.error(new Error("terminated"));
    expect(warn).toHaveBeenCalledWith("[storage] idle Postgres connection lost: terminated");
    warn.mockRestore();
  });

  test("a transaction runs on one connection: committed, or rolled back and the error passed on", async () => {
    const pg = fakePg(() => ({ rows: [{ x: 1 }], rowCount: 1 }));
    const db = new PostgresDriver("postgres://h/db", pg);
    const out = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (?)", [1]);
      return tx.get("SELECT x FROM t");
    });
    expect(out).toEqual({ x: 1 });
    expect(pg.calls.map((c) => c[1])).toEqual(["BEGIN", "INSERT INTO t VALUES ($1)", "SELECT x FROM t", "COMMIT"]);
    expect(pg.released).toEqual([false]);

    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(pg.calls.map((c) => c[1]).slice(-2)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(pg.released).toEqual([false, false]);
  });

  test("a connection that cannot even roll back is closed rather than reused", async () => {
    const pg = fakePg((sql) => {
      if (sql === "ROLLBACK") throw new Error("connection gone");
      return { rows: [], rowCount: 0 };
    });
    const db = new PostgresDriver("postgres://h/db", pg);
    await expect(
      db.transaction(async () => {
        throw new Error("the real failure");
      })
    ).rejects.toThrow("the real failure");
    expect(pg.released).toEqual([true]);
  });
});

describe("migrations", () => {
  test("a new database gets every table, once", async () => {
    const db = new SqliteDriver(":memory:");
    expect(await migrate(db)).toEqual(["profiles", "cache"]);
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);
    expect(tables).toEqual(["cache_entries", "profile_sessions", "profile_store", "profiles", "schema_migrations"]);
    await db.close();
  });

  test("a later migration is applied on top of the earlier ones", async () => {
    const db = new SqliteDriver(":memory:");
    await migrate(db);
    const next = [...MIGRATIONS, { id: 3, name: "extra", up: { sqlite: ["CREATE TABLE extra (a INTEGER)"], postgres: [] } }];
    expect(await migrate(db, next)).toEqual(["extra"]);
    expect(await db.all("SELECT id, name FROM schema_migrations ORDER BY id")).toEqual([
      { id: 1, name: "profiles" },
      { id: 2, name: "cache" },
      { id: 3, name: "extra" }
    ]);
    await db.close();
  });

  test("a database another program migrated is refused, and left as it was", async () => {
    const db = new SqliteDriver(":memory:");
    await db.run("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
    await db.run("INSERT INTO schema_migrations VALUES (1, 'something else', 0)");
    await expect(migrate(db)).rejects.toThrow('migration 1 in this database is "something else", not "profiles"');
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'profiles'")).toBeNull();
    await db.close();
  });

  test("on Postgres, a lock holds off a second process starting at the same moment", async () => {
    const applied = [
      { id: "1", name: "profiles" },
      { id: "2", name: "cache" }
    ];
    const pg = fakePg((sql) => (sql.startsWith("SELECT id, name") ? { rows: applied, rowCount: 2 } : { rows: [], rowCount: 0 }));
    const db = new PostgresDriver("postgres://h/db", pg);
    expect(await migrate(db)).toEqual([]);
    expect(pg.calls.map((c) => c[1]).slice(0, 2)).toEqual(["BEGIN", "SELECT pg_advisory_xact_lock(59780312)"]);
  });

  test("on Postgres, the cache's table is unlogged; on SQLite there is no such thing", async () => {
    const pg = fakePg((sql) => (sql.startsWith("SELECT id, name") ? { rows: [{ id: "1", name: "profiles" }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    expect(await migrate(new PostgresDriver("postgres://h/db", pg))).toEqual(["cache"]);
    expect(pg.calls.some((c) => c[1].startsWith("CREATE UNLOGGED TABLE IF NOT EXISTS cache_entries"))).toBe(true);
    const cache = MIGRATIONS.find((m) => m.name === "cache");
    expect(cache.up.sqlite[0]).toMatch(/^CREATE TABLE IF NOT EXISTS cache_entries/);
  });
});

describe("openDatabase", () => {
  test("opens SQLite and brings it up to date", async () => {
    const { db, applied } = await openDatabase("sqlite::memory:");
    expect(db.dialect).toBe("sqlite");
    expect(applied).toEqual(["profiles", "cache"]);
    await db.close();
  });

  test("opens Postgres with the driver for it, and the pool settings asked for", async () => {
    class FakePostgres {
      constructor(connectionString, pg, options) {
        Object.assign(this, { connectionString, pg, options, dialect: "postgres" });
      }
      async transaction(fn) {
        return fn({ run: async () => ({ changes: 0 }), all: async () => [{ id: 1, name: "profiles" }], get: async () => null });
      }
    }
    const { db, applied } = await openDatabase("postgres://h/db", { PostgresDriver: FakePostgres });
    expect(db.connectionString).toBe("postgres://h/db");
    expect(db.pg).toBeUndefined();
    expect(db.options).toEqual({});
    expect(applied).toEqual(["cache"]);
    const quick = await openDatabase("postgres://h/db", { PostgresDriver: FakePostgres }, { postgres: { max: 8 } });
    expect(quick.db.options).toEqual({ max: 8 });
  });

  describe("a SQLite file opened twice, by profiles and by the cache", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    let dir;
    let url;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "youstream-db-"));
      url = `sqlite://${path.join(dir, "shared.db")}`;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("shares one connection: a write waits for the other's transaction instead of failing on its lock", async () => {
      const a = await openDatabase(url);
      const b = await openDatabase(url);
      expect([a.applied, b.applied]).toEqual([["profiles", "cache"], []]);
      const order = [];
      const transaction = a.db.transaction(async (tx) => {
        await tx.run("INSERT INTO profile_store (name, value) VALUES ('first', '1')");
        // Real waiting inside the transaction, as across a network.
        await new Promise((resolve) => setTimeout(resolve, 30));
        await tx.run("INSERT INTO profile_store (name, value) VALUES ('second', '2')");
        order.push("transaction");
      });
      const write = b.db.run("INSERT INTO cache_entries (id, value, size, expires_at) VALUES ('k', 'v', 2, 1)").then(() => order.push("write"));
      await Promise.all([transaction, write]);
      expect(order).toEqual(["transaction", "write"]);
      expect(await b.db.get("SELECT COUNT(*) AS n FROM profile_store")).toEqual({ n: 2 });
      await a.db.close();
      await a.db.close();
      // Still open for the other.
      expect(await b.db.get("SELECT value FROM cache_entries WHERE id = 'k'")).toEqual({ value: "v" });
      await b.db.close();
      // Opened afresh once both had closed it.
      const c = await openDatabase(url);
      expect(c.applied).toEqual([]);
      expect(await c.db.all("SELECT name FROM profile_store ORDER BY name")).toEqual([{ name: "first" }, { name: "second" }]);
      await c.db.close();
    });

    test("in memory, each is a database of its own", async () => {
      const a = await openDatabase("sqlite::memory:");
      const b = await openDatabase("sqlite::memory:");
      await a.db.run("INSERT INTO profile_store (name, value) VALUES ('x', '1')");
      expect(await b.db.get("SELECT name FROM profile_store")).toBeNull();
      await a.db.close();
      await b.db.close();
    });
  });

  test("a database that cannot be migrated is closed again, and the error thrown", async () => {
    const closed = [];
    class Unreachable {
      constructor() {
        this.dialect = "postgres";
      }
      async transaction() {
        throw new Error("connect ECONNREFUSED");
      }
      async close() {
        closed.push(true);
        throw new Error("closing fails too");
      }
    }
    await expect(openDatabase("postgres://h/db", { PostgresDriver: Unreachable })).rejects.toThrow("connect ECONNREFUSED");
    expect(closed).toEqual([true]);
  });
});
