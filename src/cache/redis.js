const Redis = require("ioredis");

/**
 * Entries in Redis: shared by every instance, kept across restarts and
 * redeploys, expired by Redis itself.
 *
 * A Redis that is slow or gone must never hold up a stream list. Only the
 * first connection is waited for, and only for a second, so the requests
 * that arrive as the server starts still use the cache. After that, while
 * Redis is not connected, a command fails at once rather than waiting in a
 * queue for the reconnection (measured: queued, a lookup took 3 to 8 seconds
 * with Redis down); a connected Redis that stops answering is given a
 * second. The caller then carries on as if the cache were empty, while the
 * client keeps reconnecting in the background.
 */
const CLIENT_OPTIONS = {
  // Railway's private network resolves to IPv6; 0 lets either family through.
  family: 0,
  connectTimeout: 5000,
  commandTimeout: 1000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  enableAutoPipelining: true
};

const FIRST_CONNECTION_WAIT_MS = 1000;
const SCAN_BATCH = 500;

class RedisStore {
  /**
   * @param {object} p
   * @param {string} [p.url]
   * @param {object} [p.client]  an ioredis-compatible client, instead of
   *                             connecting to `url`
   * @param {function} [p.onError] told of connection trouble
   * @param {number} [p.firstConnectionWaitMs]
   */
  constructor({ url, client, onError = () => {}, firstConnectionWaitMs = FIRST_CONNECTION_WAIT_MS }) {
    this.kind = "redis";
    this.client = client || new Redis(url, CLIENT_OPTIONS);
    this.client.on("error", onError);
    this.firstConnection =
      this.client.status === "ready"
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimeout(resolve, firstConnectionWaitMs);
            timer.unref();
            this.client.once("ready", () => {
              clearTimeout(timer);
              resolve();
            });
          });
  }

  async get(key) {
    await this.firstConnection;
    return this.client.get(key);
  }

  async set(key, text, expiresAt) {
    await this.firstConnection;
    await this.client.set(key, text, "PX", Math.max(1, Math.round(expiresAt - Date.now())));
  }

  async delete(key) {
    await this.firstConnection;
    await this.client.del(key);
  }

  /** Every key under a prefix, a batch at a time, without blocking Redis. */
  async eachBatch(prefix, fn) {
    await this.firstConnection;
    let cursor = "0";
    do {
      const [next, keys] = await this.client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", SCAN_BATCH);
      cursor = next;
      await fn(keys);
    } while (cursor !== "0");
  }

  async clear(prefix) {
    let removed = 0;
    await this.eachBatch(prefix, async (keys) => {
      // UNLINK frees the memory in the background, unlike DEL.
      if (keys.length) removed += await this.client.unlink(...keys);
    });
    return removed;
  }

  async count(prefix) {
    let n = 0;
    await this.eachBatch(prefix, async (keys) => {
      n += keys.length;
    });
    return n;
  }

  async close() {
    await this.client.quit();
  }
}

module.exports = { RedisStore, CLIENT_OPTIONS, FIRST_CONNECTION_WAIT_MS };
