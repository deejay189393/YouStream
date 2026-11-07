/**
 * Counters per key -- a client's address, a profile -- each over a fixed
 * window, in this process's memory. YouStream runs as one process; a
 * restart clears them, which gains a guesser little: every password guess
 * still costs a tenth of a second of scrypt.
 */

/** Past this many keys, ended windows are swept out on the next count. */
const SWEEP_AT = 10000;

function createLimiter({ windowMs, max, now = Date.now }) {
  const windows = new Map();

  function sweep(t) {
    if (windows.size < SWEEP_AT) return;
    for (const [key, w] of windows) if (w.resetAt <= t) windows.delete(key);
  }

  /** Seconds until `key` may go again; 0 when it may now. */
  function blocked(key) {
    const w = windows.get(key);
    const t = now();
    return w && w.resetAt > t && w.count >= max ? Math.ceil((w.resetAt - t) / 1000) : 0;
  }

  /** Counts one for `key`. */
  function hit(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      sweep(t);
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    w.count += 1;
  }

  /** Counts one for `key` unless it is over: seconds to wait then, else 0. */
  function take(key) {
    const wait = blocked(key);
    if (!wait) hit(key);
    return wait;
  }

  return { blocked, hit, take, size: () => windows.size };
}

module.exports = { createLimiter, SWEEP_AT };
