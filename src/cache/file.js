const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

/**
 * Entries as files on disk: kept across restarts, and across redeploys when
 * the directory is a mounted volume. For a single instance with a volume
 * and no Redis.
 *
 * A key's parts become directories -- "youstream:search:v1:ab12" is
 * youstream/search/v1/ab12.json -- so a whole namespace is cleared by
 * removing one directory. Each file starts with the time it expires, and
 * its modification time is set to the same moment, so the sweep that keeps
 * the store within its size can rank files by expiry without reading them.
 *
 * Only files under <dir>/<prefix>/ are ever read, swept or removed, so the
 * directory may be shared with anything else on the volume.
 */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const ABANDONED_TEMP_MS = 60 * 60 * 1000;

class FileStore {
  constructor({ dir, prefix, maxBytes, sweepEveryMs = SWEEP_EVERY_MS }) {
    this.kind = "file";
    this.dir = path.resolve(dir);
    this.root = path.join(this.dir, prefix);
    this.maxBytes = maxBytes;
    this.writtenSinceSweep = 0;
    this.lastTotal = 0;
    this.sweeping = null;
    this.timer = setInterval(() => this.sweep(), sweepEveryMs);
    this.timer.unref();
    // Measures what an earlier run left, so the size limit holds from the start.
    this.sweep();
  }

  pathOf(key) {
    return `${path.join(this.dir, ...key.split(":"))}.json`;
  }

  /** A prefix ending in ":" is a directory: "youstream:search:" -> youstream/search. */
  dirOf(prefix) {
    return path.join(this.dir, ...prefix.split(":").filter(Boolean));
  }

  async get(key) {
    const file = this.pathOf(key);
    let content;
    try {
      content = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const newline = content.indexOf("\n");
    const expiresAt = Number(content.slice(0, newline));
    if (newline < 0 || !(Date.now() < expiresAt)) {
      await fs.rm(file, { force: true });
      return null;
    }
    return content.slice(newline + 1);
  }

  async set(key, text, expiresAt) {
    const file = this.pathOf(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Written beside the target and renamed over it, so a reader never sees
    // half a file and two writers of one key do not interleave.
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const content = `${expiresAt}\n${text}`;
    await fs.writeFile(temp, content);
    await fs.utimes(temp, new Date(), new Date(expiresAt));
    await fs.rename(temp, file);
    this.writtenSinceSweep += Buffer.byteLength(content);
    if (this.lastTotal + this.writtenSinceSweep > this.maxBytes) this.sweep();
  }

  async delete(key) {
    await fs.rm(this.pathOf(key), { force: true });
  }

  /** Every file below a directory, with its size and modification time. */
  async walk(dir) {
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const lists = await Promise.all(
      names.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return this.walk(full);
        if (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")) return [];
        try {
          const stat = await fs.stat(full);
          return [{ file: full, size: stat.size, mtimeMs: stat.mtimeMs }];
        } catch (_) {
          return []; // removed in the meantime
        }
      })
    );
    return lists.flat();
  }

  async clear(prefix) {
    const dir = this.dirOf(prefix);
    const removed = (await this.walk(dir)).filter((f) => f.file.endsWith(".json")).length;
    await fs.rm(dir, { recursive: true, force: true });
    return removed;
  }

  async count(prefix) {
    const now = Date.now();
    return (await this.walk(this.dirOf(prefix))).filter((f) => f.file.endsWith(".json") && f.mtimeMs > now).length;
  }

  /**
   * Removes what has expired and anything a crashed write left behind, then,
   * while the rest is over the size limit, whatever expires soonest. One at
   * a time: a sweep asked for during a sweep joins it.
   */
  sweep() {
    if (!this.sweeping) {
      this.sweeping = this.runSweep()
        .catch((err) => console.warn(`[cache] file sweep failed: ${err.message}`))
        .finally(() => {
          this.sweeping = null;
        });
    }
    return this.sweeping;
  }

  async runSweep() {
    const now = Date.now();
    this.writtenSinceSweep = 0;
    const files = await this.walk(this.root);
    const gone = (f) => (f.file.endsWith(".tmp") ? now - f.mtimeMs > ABANDONED_TEMP_MS : f.mtimeMs <= now);
    const keep = files.filter((f) => !gone(f)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const remove = files.filter(gone);
    let total = keep.reduce((sum, f) => sum + f.size, 0);
    while (total > this.maxBytes * 0.9 && keep.length) {
      const evicted = keep.shift();
      total -= evicted.size;
      remove.push(evicted);
    }
    await Promise.all(remove.map((f) => fs.rm(f.file, { force: true })));
    this.lastTotal = total;
  }

  async close() {
    clearInterval(this.timer);
    if (this.sweeping) await this.sweeping;
  }
}

module.exports = { FileStore, SWEEP_EVERY_MS };
