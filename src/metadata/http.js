const { metadataCache } = require("../cache");

/**
 * Metadata services answer in well under a second, but an app waiting on a
 * stream list gives up after a few seconds more, so a stalled one is cut off
 * rather than allowed to hold the whole answer hostage.
 */
const TIMEOUT_MS = 8000;

/**
 * GET a JSON document, cached by `cacheKey` (the URL without any credential).
 *
 * Returns the parsed body, or null when the service says the thing does not
 * exist (404) -- which is cached like any other answer, so a title missing
 * from one source is not asked about again for a day. Anything else that
 * goes wrong throws, and is not cached: a timeout or an outage says nothing
 * about tomorrow.
 */
async function getJson(url, { cacheKey = url, headers } = {}) {
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) return cached.body;

  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const wrapped = new Error(`Could not reach ${new URL(url).host}: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  if (response.status === 404) {
    metadataCache.set(cacheKey, { body: null });
    return null;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* not JSON */
  }

  if (!response.ok || body === null) {
    const err = new Error(`${new URL(url).host} returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  metadataCache.set(cacheKey, { body });
  return body;
}

/** "2015", "2015-06-17", "2015–2022" -> 2015. */
function yearOf(value) {
  const match = /(\d{4})/.exec(typeof value === "string" ? value : String(value == null ? "" : value));
  return match ? Number(match[1]) : null;
}

/**
 * A listed runtime in seconds. Accepts a number of minutes or the text forms
 * metadata services write: "142 min", "2h 22min", "1h", "45m".
 */
function runtimeSeconds(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value * 60) : null;
  if (typeof value !== "string") return null;
  const hours = /(\d+(?:\.\d+)?)\s*h/i.exec(value);
  const minutes = /(\d+(?:\.\d+)?)\s*m/i.exec(value);
  if (!hours && !minutes) {
    const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    return bare ? runtimeSeconds(Number(bare[1])) : null;
  }
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? Math.round(total * 60) : null;
}

module.exports = { getJson, yearOf, runtimeSeconds, TIMEOUT_MS };
