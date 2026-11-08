const path = require("path");
const { migrate } = require("./migrations");

/**
 * Where profiles are kept, and the cache when CACHE_STORE=database, chosen
 * by DATABASE_URL:
 *
 *   sqlite:///data/youstream.db     a SQLite file at an absolute path -- on
 *                                   Railway, inside a volume's mount path
 *   sqlite://./data/youstream.db    the same, relative to where YouStream runs
 *   sqlite::memory:                 kept in memory, gone on restart (tests)
 *   postgres://user:pass@host/db    PostgreSQL; postgresql:// too
 *
 * Both answer the same calls -- run, all, get, transaction, close -- with
 * the same SQL, so the rest of YouStream never asks which it has.
 */

/** { dialect, filename } or { dialect, connectionString }; throws on anything else. */
function parseDatabaseUrl(raw) {
  const url = String(raw || "").trim();
  if (url === "sqlite::memory:") return { dialect: "sqlite", filename: ":memory:" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error("DATABASE_URL is not a URL: use sqlite:///path/to/file.db or postgres://...");
  }
  if (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") return { dialect: "postgres", connectionString: url };
  if (parsed.protocol !== "sqlite:") {
    throw new Error(`DATABASE_URL must start with sqlite: or postgres:, not ${parsed.protocol}`);
  }
  const file = decodeURIComponent(parsed.pathname);
  if (parsed.hostname === ".") return { dialect: "sqlite", filename: path.join(process.cwd(), file.replace(/^\/+/, "")) };
  if (parsed.hostname || file === "/" || !file) {
    throw new Error("A SQLite DATABASE_URL needs a file: sqlite:///absolute/path.db or sqlite://./relative/path.db");
  }
  return { dialect: "sqlite", filename: file };
}

/** The URL for the log, without a password. */
function describeDatabase(raw) {
  const where = parseDatabaseUrl(raw);
  if (where.dialect === "sqlite") return `SQLite ${where.filename}`;
  const parsed = new URL(where.connectionString);
  return `PostgreSQL ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
}

/**
 * One connection per SQLite file in this process, however many open it:
 * profiles and the cache share it, so their statements take turns in its
 * one queue. Two connections would contend for the file's write lock, and
 * node:sqlite waits for a lock synchronously -- holding up the very
 * transaction it is waiting for. Each opener gets a handle of its own; the
 * connection closes with the last of them. (":memory:" is a new database
 * each time, so it is never shared.)
 */
const sqliteFiles = new Map();

function sqliteHandle(filename, SqliteDriver) {
  if (filename === ":memory:") return new SqliteDriver(filename);
  let file = sqliteFiles.get(filename);
  if (!file) {
    file = { driver: new SqliteDriver(filename), handles: 0 };
    sqliteFiles.set(filename, file);
  }
  file.handles++;
  const { driver } = file;
  let closed = false;
  return {
    dialect: driver.dialect,
    run: (sql, params) => driver.run(sql, params),
    all: (sql, params) => driver.all(sql, params),
    get: (sql, params) => driver.get(sql, params),
    transaction: (fn) => driver.transaction(fn),
    async close() {
      if (closed) return;
      closed = true;
      if (--file.handles > 0) return;
      sqliteFiles.delete(filename);
      await driver.close();
    }
  };
}

/**
 * Opens the database and brings its tables up to date. A database that
 * cannot be reached or migrated is closed again before the error is thrown.
 * `postgres` overrides the pool's settings (see postgres.js).
 *
 * @returns {Promise<{ db, applied: string[] }>}
 */
async function openDatabase(raw, drivers = {}, { postgres = {} } = {}) {
  const where = parseDatabaseUrl(raw);
  const { SqliteDriver = require("./sqlite").SqliteDriver, PostgresDriver = require("./postgres").PostgresDriver } = drivers;
  const db =
    where.dialect === "sqlite" ? sqliteHandle(where.filename, SqliteDriver) : new PostgresDriver(where.connectionString, undefined, postgres);
  try {
    const applied = await migrate(db);
    return { db, applied };
  } catch (err) {
    await Promise.resolve(db.close()).catch(() => {});
    throw err;
  }
}

module.exports = { parseDatabaseUrl, describeDatabase, openDatabase };
