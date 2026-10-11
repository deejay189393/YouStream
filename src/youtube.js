const crypto = require("crypto");
const { searchCache, keyCooldown, HOUR_MS } = require("./cache");

/**
 * The YouTube Data API, used the way its quota forces.
 *
 * A key gets 10,000 units a day. `search.list` costs 100 of them -- so a key
 * can search 100 times a day, full stop -- while `videos.list` costs 1 for up
 * to 50 videos. So each lookup is exactly one search for the 50 best results,
 * then one `videos.list` to learn what the search does not say: how long each
 * video is, whether it can be embedded, where it is blocked, whether it is
 * age-restricted, and what language it is spoken in.
 *
 * Results are cached for a day and shared by everyone on the server: the
 * same query returns the same videos whoever's key asked, and a second
 * reader opening the same film should not cost anybody a search.
 */
const BASE_URL = "https://www.googleapis.com/youtube/v3";
const MAX_RESULTS = 50;
const SEARCH_TTL_MS = 24 * HOUR_MS;

/**
 * Concurrent lookups for the same query share one request. An app opening a
 * show often asks for the same episode twice in quick succession, and two
 * readers starting the same premiere would otherwise both spend a search.
 */
const inFlight = new Map();

/**
 * Google's error vocabulary, folded into the few things the addon and the
 * configure page need to tell apart. Google states the reason twice, in
 * `errors[].reason` (camelCase) and `details[].reason` (SHOUTING), and not
 * always both, so every reason it gave is considered -- in this order, most
 * telling first: "forbidden" comes with nearly any refusal, so a more
 * specific reason beside it wins.
 */
const KINDS = [
  ["quota", ["quotaExceeded", "dailyLimitExceeded"]],
  ["rate", ["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]],
  ["disabled", ["accessNotConfigured", "SERVICE_DISABLED"]],
  [
    "restricted",
    ["ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_SERVICE_BLOCKED"]
  ],
  ["invalid", ["keyInvalid", "keyExpired", "API_KEY_INVALID", "forbidden"]]
];

function classify(httpStatus, reasons) {
  const found = KINDS.find(([, names]) => reasons.some((r) => names.includes(r)));
  if (found) return found[0];
  return httpStatus >= 500 ? "unavailable" : "error";
}

async function call(path, params) {
  const url = new URL(`${BASE_URL}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  let response;
  try {
    response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    const wrapped = new Error(`Could not reach YouTube: ${err.message}`);
    wrapped.kind = "unavailable";
    throw wrapped;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* not JSON */
  }

  if (!response.ok || !body || body.error) {
    const error = (body && body.error) || {};
    const reasons = [...(Array.isArray(error.errors) ? error.errors : []), ...(Array.isArray(error.details) ? error.details : [])]
      .map((e) => e && e.reason)
      .filter((r) => typeof r === "string");
    const err = new Error(error.message || `YouTube returned HTTP ${response.status}`);
    err.kind = classify(response.status, reasons);
    err.status = response.status;
    throw err;
  }
  return body;
}

/** PT1H2M3S -> 3723. Null for a live stream or anything unparseable. */
function durationToSeconds(iso) {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

/** "en-IN" and "en-GB" are English; compare on the primary subtag only. */
function primaryLanguage(tag) {
  return typeof tag === "string" && tag ? tag.toLowerCase().split("-")[0] : null;
}

/**
 * One video, reduced to what matching and the stream list use. Kept small on
 * purpose: a day of cached searches is a thousand of these lists.
 */
function toVideo(detail) {
  const snippet = detail.snippet || {};
  const content = detail.contentDetails || {};
  const status = detail.status || {};
  const stats = detail.statistics || {};
  const restriction = content.regionRestriction || {};
  const views = Number(stats.viewCount);
  return {
    id: detail.id,
    title: typeof snippet.title === "string" ? snippet.title : "",
    channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle : "",
    channelId: typeof snippet.channelId === "string" ? snippet.channelId : "",
    publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : null,
    durationSeconds: durationToSeconds(content.duration),
    definition: content.definition === "hd" ? "hd" : "sd",
    views: Number.isFinite(views) ? views : null,
    language: primaryLanguage(snippet.defaultAudioLanguage || snippet.defaultLanguage),
    live: snippet.liveBroadcastContent && snippet.liveBroadcastContent !== "none" ? snippet.liveBroadcastContent : null,
    embeddable: status.embeddable !== false,
    ageRestricted: Boolean(content.contentRating && content.contentRating.ytRating === "ytAgeRestricted"),
    regionAllowed: Array.isArray(restriction.allowed) ? restriction.allowed : null,
    regionBlocked: Array.isArray(restriction.blocked) ? restriction.blocked : null
  };
}

/** A fingerprint of a key, so cooldowns are tracked without holding the key. */
function keyId(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * One search plus its enrichment, as a list of videos in YouTube's order.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.q
 * @param {string} [p.regionCode]        ISO 3166-1 alpha-2: ranks for, and
 *                                       hides videos blocked in, a country
 * @param {string} [p.relevanceLanguage] ISO 639-1: a ranking hint only
 * @param {string} [p.videoDuration]     "short" | "medium" | "long"
 * @param {boolean} [p.embeddableOnly]
 * @returns {Promise<{ videos: object[], cached: boolean }>}
 */
async function searchVideos({ apiKey, q, regionCode, relevanceLanguage, videoDuration, embeddableOnly }) {
  const cacheKey = JSON.stringify({
    q: q.toLowerCase(),
    regionCode: regionCode || null,
    relevanceLanguage: relevanceLanguage || null,
    videoDuration: videoDuration || null,
    embeddableOnly: Boolean(embeddableOnly)
  });
  const cached = searchCache.get(cacheKey);
  if (cached) return { videos: cached, cached: true };
  if (inFlight.has(cacheKey)) return { videos: await inFlight.get(cacheKey), cached: true };

  // A key that reported its day's quota spent stays spent for a while, so
  // the next request does not spend a round trip discovering it again.
  if (keyCooldown.has(keyId(apiKey))) {
    const err = new Error("This YouTube key's daily quota is spent");
    err.kind = "quota";
    throw err;
  }

  const run = (async () => {
    try {
      const data = await call("search", {
        key: apiKey,
        part: "snippet",
        type: "video",
        q,
        maxResults: MAX_RESULTS,
        regionCode,
        relevanceLanguage,
        videoDuration,
        videoEmbeddable: embeddableOnly ? "true" : undefined
      });
      const ids = (Array.isArray(data.items) ? data.items : [])
        .map((item) => item && item.id && item.id.videoId)
        .filter((id) => typeof id === "string" && id);
      let videos = [];
      if (ids.length) {
        const details = await call("videos", {
          key: apiKey,
          part: "snippet,contentDetails,statistics,status",
          id: ids.join(","),
          maxResults: MAX_RESULTS
        });
        const byId = new Map((Array.isArray(details.items) ? details.items : []).map((v) => [v.id, v]));
        // In the search's order, which is YouTube's own relevance ranking;
        // a video the search found but that has since gone is skipped.
        videos = ids.filter((id) => byId.has(id)).map((id) => toVideo(byId.get(id)));
      }
      searchCache.set(cacheKey, videos, SEARCH_TTL_MS);
      return videos;
    } catch (err) {
      if (err.kind === "quota") keyCooldown.set(keyId(apiKey), true);
      throw err;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey, run);
  return { videos: await run, cached: false };
}

/**
 * Whether a key works, for the configure page, at the cost of one unit: a
 * `videos.list` of a single, long-lived public video.
 *
 * Returns "ok", "quota" (works, but today's allowance is spent), "invalid",
 * "disabled" (the YouTube Data API is not enabled in the key's project),
 * "restricted" (the key is limited to websites or addresses this server is
 * not), or "unreachable".
 */
async function checkKey(apiKey) {
  try {
    await call("videos", { key: apiKey, part: "id", id: "jNQXAC9IVRw" });
    return "ok";
  } catch (err) {
    if (["quota", "rate"].includes(err.kind)) return "quota";
    if (["invalid", "disabled", "restricted"].includes(err.kind)) return err.kind;
    return "unreachable";
  }
}

module.exports = {
  searchVideos,
  checkKey,
  classify,
  durationToSeconds,
  primaryLanguage,
  toVideo,
  keyId,
  inFlight,
  MAX_RESULTS,
  BASE_URL
};
