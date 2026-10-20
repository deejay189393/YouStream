const crypto = require("crypto");
const { searchCache, keyCooldown } = require("./cache");

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
 * Results are cached and shared by everyone on the server (see cache/): the
 * same query returns the same videos whoever's key asked, and a second
 * reader opening the same film should not cost anybody a search.
 */
const BASE_URL = "https://www.googleapis.com/youtube/v3";
const MAX_RESULTS = 50;
const HOUR_MS = 60 * 60 * 1000;

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
 * purpose: every cached search holds fifty of them.
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
    // The start of the description is evidence both ways: genuine uploads
    // credit the cast and director, fakes and re-uploads give themselves away.
    description: typeof snippet.description === "string" ? snippet.description.slice(0, 1500) : "",
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
    licensed: content.licensedContent === true,
    regionAllowed: Array.isArray(restriction.allowed) ? restriction.allowed : null,
    regionBlocked: Array.isArray(restriction.blocked) ? restriction.blocked : null
  };
}

/** A fingerprint of a key, so cooldowns are tracked without holding the key. */
function keyId(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * How long a key that spent its quota is left alone: until the quota resets
 * at midnight Pacific time, as Google's does, but never more than an hour,
 * so a key whose quota was raised is soon tried again. A refused call costs
 * no quota, only the round trip.
 */
function quotaCooldownMs(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  }).formatToParts(now);
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  const elapsed = (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000 + now.getMilliseconds();
  return Math.max(1000, Math.min(HOUR_MS, 24 * HOUR_MS - elapsed));
}

function quotaSpent() {
  const err = new Error("This YouTube key's daily quota is spent");
  err.kind = "quota";
  return err;
}

/**
 * Runs calls with a reader's key, unless that key is known to have spent
 * today's quota, and remembers when it has -- so the next request does not
 * spend a round trip learning it again.
 */
async function withKey(apiKey, run) {
  if (await keyCooldown.get(keyId(apiKey))) throw quotaSpent();
  try {
    return await run();
  } catch (err) {
    if (err.kind === "quota") await keyCooldown.set(keyId(apiKey), true, quotaCooldownMs());
    throw err;
  }
}

/** Every video's details at once, which is what `videos.list` charges one unit for. */
const VIDEO_PARTS = "snippet,contentDetails,statistics,status";

const idsOf = (items, pick) =>
  (Array.isArray(items) ? items : []).map((item) => item && pick(item)).filter((id) => typeof id === "string" && id);

/**
 * Details for up to fifty videos, in the order asked for. A video that has
 * gone since it was listed -- deleted, made private -- is left out.
 */
async function videosById(apiKey, ids) {
  if (!ids.length) return [];
  const details = await call("videos", { key: apiKey, part: VIDEO_PARTS, id: ids.join(","), maxResults: MAX_RESULTS });
  const byId = new Map((Array.isArray(details.items) ? details.items : []).map((v) => [v.id, v]));
  return ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

async function fetchVideos({ apiKey, q, regionCode, relevanceLanguage, videoDuration, embeddableOnly }) {
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
  // In the search's order, which is YouTube's own relevance ranking.
  const details = await videosById(apiKey, idsOf(data.items, (item) => item.id && item.id.videoId));
  return details.map(toVideo);
}

async function lookup(cacheKey, params) {
  const hit = await searchCache.get(cacheKey);
  if (hit && hit.fresh) return { videos: hit.value, cached: true };
  try {
    const videos = await withKey(params.apiKey, () => fetchVideos(params));
    await searchCache.set(cacheKey, videos, params.freshMs);
    return { videos, cached: false };
  } catch (err) {
    // Past its lifetime, a cached search is still better than nothing when
    // YouTube cannot be asked: a spent quota, an outage.
    if (!hit) throw err;
    return { videos: hit.value, cached: true, stale: err.kind };
  }
}

/**
 * One page of a search for browsing: the ids, in YouTube's order, and the
 * token for the page after. `search.list` costs 100 units whatever it
 * returns, so it only says which videos; `videosById` says the rest.
 *
 * @param {object} p
 * @param {string} [p.order]           relevance (YouTube's ranking) | date |
 *                                     viewCount | rating
 * @param {string} [p.videoDuration]   short (< 4 min) | medium | long (> 20 min)
 * @param {string} [p.publishedAfter]  RFC 3339
 * @param {string} [p.safeSearch]      moderate (YouTube's default) | strict | none
 */
async function searchPage({ apiKey, q, order, videoDuration, publishedAfter, safeSearch, regionCode, relevanceLanguage, embeddableOnly, pageToken }) {
  const data = await call("search", {
    key: apiKey,
    part: "id",
    type: "video",
    q,
    maxResults: MAX_RESULTS,
    order,
    videoDuration,
    publishedAfter,
    safeSearch,
    regionCode,
    relevanceLanguage,
    videoEmbeddable: embeddableOnly ? "true" : undefined,
    pageToken
  });
  return { ids: idsOf(data.items, (item) => item.id && item.id.videoId), next: data.nextPageToken || null };
}

/**
 * One page of a playlist's videos, in its own order: 1 unit. A channel's
 * uploads are a playlist too -- UU plus the channel id after its UC -- and
 * so are its long videos without Shorts (UULF), its Shorts (UUSH) and its
 * live streams (UULV).
 */
async function playlistPage({ apiKey, playlistId, pageToken }) {
  const data = await call("playlistItems", { key: apiKey, part: "contentDetails", playlistId, maxResults: MAX_RESULTS, pageToken });
  return { ids: idsOf(data.items, (item) => item.contentDetails && item.contentDetails.videoId), next: data.nextPageToken || null };
}

/**
 * One page of YouTube's most popular videos in a country, all of them or
 * one category, with every video's details: 1 unit for fifty.
 */
async function chartPage({ apiKey, regionCode, videoCategoryId, pageToken }) {
  const data = await call("videos", {
    key: apiKey,
    part: VIDEO_PARTS,
    chart: "mostPopular",
    regionCode,
    videoCategoryId,
    maxResults: MAX_RESULTS,
    pageToken
  });
  return { details: Array.isArray(data.items) ? data.items : [], next: data.nextPageToken || null };
}

/** A channel by its id, its @handle or an old username, or null: 1 unit. */
async function findChannel(apiKey, { id, handle, username }) {
  const data = await call("channels", { key: apiKey, part: "snippet", id, forHandle: handle, forUsername: username });
  const channel = Array.isArray(data.items) ? data.items[0] : null;
  return channel ? { id: channel.id, title: (channel.snippet && channel.snippet.title) || "" } : null;
}

/** A public playlist by id, or null: 1 unit. */
async function findPlaylist(apiKey, id) {
  const data = await call("playlists", { key: apiKey, part: "snippet", id });
  const list = Array.isArray(data.items) ? data.items[0] : null;
  return list ? { id: list.id, title: (list.snippet && list.snippet.title) || "" } : null;
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
 * @param {number} [p.freshMs]           how long the results stay current;
 *                                       the host's default when not given
 * @returns {Promise<{ videos: object[], cached: boolean, stale?: string }>}
 *   `stale` names the failure an out-of-date answer stood in for.
 */
async function searchVideos(params) {
  const cacheKey = JSON.stringify({
    q: params.q.toLowerCase(),
    regionCode: params.regionCode || null,
    relevanceLanguage: params.relevanceLanguage || null,
    videoDuration: params.videoDuration || null,
    embeddableOnly: Boolean(params.embeddableOnly)
  });
  // Joined before anything is awaited, so two lookups arriving together
  // cannot both miss the cache and both spend a search.
  if (inFlight.has(cacheKey)) return { ...(await inFlight.get(cacheKey)), cached: true };
  const run = lookup(cacheKey, params).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, run);
  return run;
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
  withKey,
  videosById,
  searchPage,
  playlistPage,
  chartPage,
  findChannel,
  findPlaylist,
  classify,
  durationToSeconds,
  primaryLanguage,
  toVideo,
  keyId,
  quotaCooldownMs,
  inFlight,
  MAX_RESULTS,
  BASE_URL
};
