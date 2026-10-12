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
 * from one source is not asked about again until the entry expires. Anything
 * else that goes wrong is not cached, and throws -- unless an out-of-date
 * answer is still kept, which is then used instead: titles and runtimes
 * rarely change, and an old answer beats none while a service is down.
 */
async function getJson(url, { cacheKey = url, headers } = {}) {
  const hit = await metadataCache.get(cacheKey);
  if (hit && hit.fresh) return hit.value.body;
  try {
    const body = await fetchJson(url, headers);
    await metadataCache.set(cacheKey, { body });
    return body;
  } catch (err) {
    if (hit) return hit.value.body;
    throw err;
  }
}

async function fetchJson(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const wrapped = new Error(`Could not reach ${new URL(url).host}: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  if (response.status === 404) return null;

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
  return body;
}

/** "2015-06-17", "2015-06-17T00:00:00.000Z" -> "2015-06-17"; null otherwise. */
function dateOf(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(typeof value === "string" ? value : "");
  return match ? match[1] : null;
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

module.exports = { getJson, yearOf, dateOf, runtimeSeconds, TIMEOUT_MS };
