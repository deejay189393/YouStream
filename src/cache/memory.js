/**
 * Entries in this process's memory, the oldest-used dropped once their total
 * size passes the limit. Lost on every restart and redeploy, and not shared
 * between instances -- the default, because it needs nothing set up.
 *
 * Sizes are measured as the length of the stored text, which is close
 * enough to bytes for a limit.
 */
class MemoryStore {
  constructor({ maxBytes }) {
    this.kind = "memory";
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.size;
    return true;
  }

  async get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.remove(key);
      return null;
    }
    // Most recently used goes to the back of the line for eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.text;
  }

  async set(key, text, expiresAt) {
    this.remove(key);
    const size = key.length + text.length;
    if (size > this.maxBytes) return;
    this.entries.set(key, { text, expiresAt, size });
    this.bytes += size;
    while (this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
  }

  async delete(key) {
    this.remove(key);
  }

  async clear(prefix) {
    let removed = 0;
    [...this.entries.keys()].forEach((key) => {
      if (key.startsWith(prefix) && this.remove(key)) removed++;
    });
    return removed;
  }

  async count(prefix) {
    const now = Date.now();
    let n = 0;
    this.entries.forEach((entry, key) => {
      if (key.startsWith(prefix) && now < entry.expiresAt) n++;
    });
    return n;
  }

  async close() {}
}

module.exports = { MemoryStore };
