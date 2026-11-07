/**
 * PostgreSQL through pg's connection pool. Statements are written once, with
 * ? placeholders, for both databases; they are numbered $1, $2... here.
 * Nothing YouStream writes has a literal ? in it.
 */

const INT8_OID = 20;

/** "a = ? AND b = ?" -> "a = $1 AND b = $2" */
function numbered(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** As the SQLite driver binds them: true and false as 1 and 0, undefined as null. */
const bindable = (params) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p));

/** Calls against one client or the pool, which answer the same query(). */
function calls(target) {
  const query = (sql, params) => target.query(numbered(sql), bindable(params));
  return {
    run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount || 0 }),
    all: async (sql, params = []) => (await query(sql, params)).rows,
    get: async (sql, params = []) => (await query(sql, params)).rows[0] || null
  };
}

class PostgresDriver {
  /**
   * @param {string} connectionString  postgres://user:password@host:port/db
   * @param {object} [pg]              the pg module; a stand-in for tests
   */
  constructor(connectionString, pg = require("pg")) {
    this.dialect = "postgres";
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // Times are kept as epoch milliseconds in BIGINT columns, which pg
      // otherwise returns as strings to be safe beyond 2^53.
      types: {
        getTypeParser: (oid, format) => (oid === INT8_OID ? Number : pg.types.getTypeParser(oid, format))
      }
    });
    // A connection the server drops while idle is replaced on next use;
    // without a listener, the pool's error event would end the process.
    this.pool.on("error", (err) => console.warn(`[storage] idle Postgres connection lost: ${err.message}`));
    Object.assign(this, calls(this.pool));
  }

  /**
   * Runs `fn(tx)` in a transaction on one connection: committed when it
   * resolves, rolled back when it throws.
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await fn(calls(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      // A connection that could not even roll back is closed, not reused.
      client.release(broken);
    }
  }

  close() {
    return this.pool.end();
  }
}

module.exports = { PostgresDriver, numbered };
