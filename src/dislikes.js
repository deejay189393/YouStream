const { dislikeCache } = require("./cache");

/**
 * How many people dislike a video, as Return YouTube Dislike estimates it
 * (returnyoutubedislike.com). YouTube stopped publishing dislike counts in
 * December 2021, and its API now gives them only to a video's owner, so this
 * is the one source left: the votes of that project's own users, and counts
 * archived before the change, scaled to the video's likes. An estimate, which
 * the description marks as one, credited where the data sources are.
 *
 * Asked for a video's detail page only, with nothing but the video's id. The
 * service allows a client 100 requests a minute and 10,000 a day, and this
 * server is one client for all its readers, so an answer is kept as long as
 * the video's own details are, and after a refusal or an error the service
 * is left alone for a minute. Nothing here fails a page: without an estimate
 * the page just has no dislike count.
 */
const API_URL = "https://returnyoutubedislikeapi.com/votes";
const TIMEOUT_MS = 3000;
const PAUSE_MS = 60 * 1000;
const USER_AGENT = "YouStream (+https://github.com/deejay189393/YouStream)";
/** Kept beside the estimates; no video id can be spelled so. */
const PAUSED = "~paused";

/** The estimate for one video, or null when there is none to give. */
async function dislikeEstimate(videoId) {
  const hit = await dislikeCache.get(videoId);
  if (hit && hit.fresh) return hit.value;
  const paused = await dislikeCache.get(PAUSED);
  if (paused && paused.fresh) return hit ? hit.value : null;
  try {
    const count = await askEstimate(videoId);
    await dislikeCache.set(videoId, count);
    return count;
  } catch (err) {
    await dislikeCache.set(PAUSED, true, PAUSE_MS, 0);
    console.log(`[dislikes] ${videoId}: ${err.message}; not asking again for a minute`);
    return hit ? hit.value : null;
  }
}

/** The count, or null when the service knows no such video. Throws when it fails. */
async function askEstimate(videoId) {
  const response = await fetch(`${API_URL}?videoId=${encodeURIComponent(videoId)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(`returnyoutubedislikeapi.com returned HTTP ${response.status}`);
  const { dislikes } = await response.json();
  return Number.isInteger(dislikes) && dislikes >= 0 ? dislikes : null;
}

module.exports = { dislikeEstimate, API_URL, PAUSE_MS };
