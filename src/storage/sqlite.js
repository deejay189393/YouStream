const fs = require("fs");
const path = require("path");

/**
 * SQLite through node:sqlite, which is built into Node 22.13 and later: no
 * native module to compile, so the Alpine image builds as before. Loaded
 * only when DATABASE_URL names a SQLite file.
 *
 * node:sqlite is synchronous and has one connection, so every statement
 * waits its turn in one queue. A transaction holds the queue from BEGIN to
 * COMMIT, so nothing from another request lands in the middle of it.
 */

/** node:sqlite binds neither booleans nor undefined. */
const bindable = (params) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p));

/** Rows come back with a null prototype; callers expect plain objects. */
const plain = (row) => ({ ...row });

class SqliteDriver {
  /**
   * @param {string} filename  a path, or ":memory:"
   */
  constructor(filename) {
    const { DatabaseSync } = require("node:sqlite");
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.dialect = "sqlite";
    this.db = new DatabaseSync(filename);
    // WAL lets a read run while a write commits; NORMAL is durable in WAL
    // mode short of power loss; foreign keys are off in SQLite by default.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.statements = new Map();
    this.queue = Promise.resolve();
    // What a transaction's callback gets: the same calls, straight to the
    // connection the transaction already holds.
    this.inTransaction = {
      run: async (sql, params = []) => this.runNow(sql, params),
      all: async (sql, params = []) => this.allNow(sql, params),
      get: async (sql, params = []) => this.getNow(sql, params)
    };
  }

  statement(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  runNow(sql, params) {
    const result = this.statement(sql).run(...bindable(params));
    return { changes: Number(result.changes) };
  }

  allNow(sql, params) {
    return this.statement(sql).all(...bindable(params)).map(plain);
  }

  getNow(sql, params) {
    return this.allNow(sql, params)[0] || null;
  }

  /** Runs `task` once everything queued before it has finished. */
  serial(task) {
    const next = this.queue.then(task);
    // One failure must not fail everything queued after it.
    this.queue = next.catch(() => {});
    return next;
  }

  run(sql, params = []) {
    return this.serial(() => this.runNow(sql, params));
  }

  all(sql, params = []) {
    return this.serial(() => this.allNow(sql, params));
  }

  get(sql, params = []) {
    return this.serial(() => this.getNow(sql, params));
  }

  /**
   * Runs `fn(tx)` in a transaction: committed when it resolves, rolled back
   * when it throws. `tx` has run, all and get.
   */
  transaction(fn) {
    return this.serial(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.inTransaction);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch (_) {
          // SQLite already rolled it back; the error that caused it matters.
        }
        throw err;
      }
    });
  }

  close() {
    return this.serial(() => this.db.close());
  }
}

module.exports = { SqliteDriver };
