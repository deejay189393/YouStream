const { openDatabase, describeDatabase } = require("../storage");

/**
 * Entries in a table of the database DATABASE_URL names, the one profiles
 * are kept in: kept across restarts and redeploys with neither a Redis nor
 * a volume of YouStream's own, and shared by every instance that uses the
 * same database and CACHE_PREFIX. On PostgreSQL the table is UNLOGGED (see
 * storage/migrations.js).
 *
 * A database that is slow or gone must never hold up a stream list, as with
 * Redis. The first opening is waited for, and only for two seconds, so the
 * requests that arrive as the server starts still use the cache; an opening
 * that fails is tried again in the background, 5 seconds later, then 10,
 * 20... up to every 5 minutes. A statement that fails pauses the store for
 * a few seconds, so a database that stops answering costs one wait, not
 * one per lookup. Meanwhile the caller carries on as if the cache were
 * empty.
 *
 * An expired row is never read. Every hour, the expired rows are deleted --
 * any instance's, since nobody reads them -- and, while this prefix's rows
 * are over the size limit, whatever of it expires soonest.
 */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const FIRST_OPEN_WAIT_MS = 2000;
const RETRY_FIRST_MS = 5 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const PAUSE_AFTER_FAILURE_MS = 10 * 1000;

/** A pool of its own, small, and quick to give up: a lookup is not worth waiting for. */
const POSTGRES_POOL = { max: 8, connectionTimeoutMillis: 1000, query_timeout: 2000 };

const UPSERT = `INSERT INTO cache_entries (id, value, size, expires_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET value = excluded.value, size = excluded.size, expires_at = excluded.expires_at`;
const UNDER = "substr(id, 1, ?) = ?";

class DatabaseStore {
  /**
   * @param {object} p
   * @param {string} p.url        DATABASE_URL
   * @param {string} p.prefix     CACHE_PREFIX: the size limit is this prefix's own
   * @param {number} p.maxBytes
   * @param {function} [p.open]   openDatabase, or a stand-in for tests
   * @param {object} [p.log]
   */
  constructor({
    url,
    prefix,
    maxBytes,
    open = openDatabase,
    log = console,
    sweepEveryMs = SWEEP_EVERY_MS,
    firstOpenWaitMs = FIRST_OPEN_WAIT_MS,
    retryFirstMs = RETRY_FIRST_MS,
    pauseMs = PAUSE_AFTER_FAILURE_MS
  }) {
    this.kind = "database";
    this.url = url;
    this.where = describeDatabase(url);
    this.prefix = `${prefix}:`;
    this.maxBytes = maxBytes;
    this.openDatabase = open;
    this.log = log;
    this.pauseMs = pauseMs;
    this.wait = retryFirstMs;
    this.db = null;
    this.closed = false;
    this.pausedUntil = 0;
    this.retryTimer = null;
    this.writtenSinceSweep = 0;
    this.lastTotal = 0;
    this.sweeping = null;
    this.sweepTimer = setInterval(() => this.sweep(), sweepEveryMs);
    this.sweepTimer.unref();
    this.opening = this.attempt();
    this.firstOpen = Promise.race([
      this.opening,
      new Promise((resolve) => {
        setTimeout(resolve, firstOpenWaitMs).unref();
      })
    ]);
  }

  async attempt() {
    try {
      const { db } = await this.openDatabase(this.url, {}, { postgres: POSTGRES_POOL });
      // Closed while it was opening: nobody is left to use it.
      if (this.closed) return db.close();
      this.db = db;
      this.sweep();
    } catch (err) {
      if (this.closed) return;
      this.log.warn(`[cache] ${this.where} could not be opened: ${err.message}; trying again in ${this.wait / 1000}s`);
      this.retryTimer = setTimeout(() => {
        this.opening = this.attempt();
      }, this.wait);
      this.retryTimer.unref();
      this.wait = Math.min(this.wait * 2, RETRY_MAX_MS);
    }
  }

  /** One statement; one that fails pauses the store. */
  async query(method, sql, params) {
    await this.firstOpen;
    if (!this.db) throw new Error(`${this.where} is not open yet`);
    if (Date.now() < this.pausedUntil) throw new Error(`${this.where} failed a moment ago`);
    try {
      return await this.db[method](sql, params);
    } catch (err) {
      this.pausedUntil = Date.now() + this.pauseMs;
      throw err;
    }
  }

  async get(key) {
    const row = await this.query("get", "SELECT value FROM cache_entries WHERE id = ? AND expires_at > ?", [key, Date.now()]);
    return row ? row.value : null;
  }

  async set(key, text, expiresAt) {
    const size = key.length + text.length;
    if (size > this.maxBytes) return;
    await this.query("run", UPSERT, [key, text, size, Math.round(expiresAt)]);
    this.writtenSinceSweep += size;
    if (this.lastTotal + this.writtenSinceSweep > this.maxBytes) this.sweep();
  }

  async delete(key) {
    await this.query("run", "DELETE FROM cache_entries WHERE id = ?", [key]);
  }

  async clear(prefix) {
    return (await this.query("run", `DELETE FROM cache_entries WHERE ${UNDER}`, [prefix.length, prefix])).changes;
  }

  async count(prefix) {
    const row = await this.query("get", `SELECT COUNT(*) AS n FROM cache_entries WHERE ${UNDER} AND expires_at > ?`, [
      prefix.length,
      prefix,
      Date.now()
    ]);
    return Number(row.n);
  }

  /** This prefix's bytes, as the size limit counts them. */
  async total() {
    const row = await this.db.get(`SELECT COALESCE(SUM(size), 0) AS bytes FROM cache_entries WHERE ${UNDER}`, [
      this.prefix.length,
      this.prefix
    ]);
    return Number(row.bytes);
  }

  /** One at a time: a sweep asked for during a sweep joins it. */
  sweep() {
    if (!this.sweeping) {
      this.sweeping = this.runSweep()
        .catch((err) => this.log.warn(`[cache] database sweep failed: ${err.message}`))
        .finally(() => {
          this.sweeping = null;
        });
    }
    return this.sweeping;
  }

  async runSweep() {
    if (!this.db) return;
    this.writtenSinceSweep = 0;
    await this.db.run("DELETE FROM cache_entries WHERE expires_at <= ?", [Date.now()]);
    let total = await this.total();
    if (total > this.maxBytes) {
      // Keeps the rows that expire last, while they add up to 90% of the
      // limit, so the next few writes do not start another sweep at once.
      await this.db.run(
        `DELETE FROM cache_entries WHERE id IN (
           SELECT id FROM (
             SELECT id, SUM(size) OVER (ORDER BY expires_at DESC, id DESC) AS kept FROM cache_entries WHERE ${UNDER}
           ) ranked WHERE kept > ?
         )`,
        [this.prefix.length, this.prefix, Math.floor(this.maxBytes * 0.9)]
      );
      total = await this.total();
    }
    this.lastTotal = total;
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweepTimer);
    clearTimeout(this.retryTimer);
    // An opening under way closes what it opens, once it sees this.closed.
    await this.opening;
    if (this.sweeping) await this.sweeping;
    const { db } = this;
    this.db = null;
    if (db) await db.close();
  }
}

module.exports = { DatabaseStore, POSTGRES_POOL, SWEEP_EVERY_MS, FIRST_OPEN_WAIT_MS, PAUSE_AFTER_FAILURE_MS };
