/**
 * How sharp a YouTube video plays, as near as can be told without YouTube's
 * private player data, which its developer policies forbid reading. Its API
 * says only "hd" (720p or better) or "sd" -- and "sd" for every stream while
 * it is live, which tells nothing. For an HD video, or a live one, the first
 * of these that applies decides:
 *
 *   1. its title names a resolution: 4K, 8K, UHD or 2160p, 1440p, 1080p,
 *      FHD or Full HD, 720p -- the highest it names
 *   2. it is live: 1080p, as few streams are sharper
 *   3. it came out in 2019 or later, on a channel of 300,000 subscribers or
 *      more: 2160p
 *   4. otherwise 1080p
 *
 * Any other SD video is 480p. "Came out" is the film's or episode's release date
 * when the video was found for one -- official channels upload old films,
 * which are rarely 4K -- and the upload date otherwise. 8K counts as 2160p,
 * the sharpest AIOStreams knows.
 */

const BIG_CHANNEL_SUBSCRIBERS = 300000;
const RECENT_FROM_YEAR = 2019;

/** Highest first. "4K" before a milestone ("4K subscribers") is a count. */
const TITLE_RESOLUTIONS = [
  ["2160p", /\b(?:8k|4k|uhd|2160p|4320p)\b(?!\s*(?:subs?|subscribers?|views|followers|likes)\b)/i],
  ["1440p", /\b1440p\b/i],
  ["1080p", /\b(?:1080p|fhd|full[\s-]?hd)\b/i],
  ["720p", /\b720p\b/i]
];

/** The highest resolution a title names, or null. */
function resolutionInTitle(title) {
  const text = typeof title === "string" ? title : "";
  const found = TITLE_RESOLUTIONS.find(([, pattern]) => pattern.test(text));
  return found ? found[0] : null;
}

/** "2026-10-19", "2026-10-19T05:00:09Z", 2026 -> 2026; NaN otherwise. */
function yearOf(value) {
  const match = /^(\d{4})/.exec(String(value === null || value === undefined ? "" : value));
  return match ? Number(match[1]) : NaN;
}

/**
 * When the film or episode a video was found for came out: its release date,
 * else its year; null for a YouTube video opened as an item, which goes by
 * its upload date.
 */
function cameOutFor(title) {
  if (!title) return null;
  return title.released || (title.isEpisode ? title.releaseYear : title.year) || null;
}

/**
 * Whether the estimate for a video turns on its channel's size, which costs
 * a lookup (youtube.channelSubscribers): only an HD video whose title names
 * no resolution, that is not live, and that came out in 2019 or later.
 */
function dependsOnChannel(video, released) {
  if (video.definition !== "hd" || resolutionInTitle(video.title) || video.live === "live") return false;
  return yearOf(released || video.publishedAt) >= RECENT_FROM_YEAR;
}

/**
 * "2160p", "1440p", "1080p", "720p" or "480p".
 *
 * @param video     from youtube.toVideo, with `subscribers` when known
 * @param released  the film's or episode's release date, or null
 */
function estimateResolution(video, released = null) {
  const live = video.live === "live";
  if (video.definition !== "hd" && !live) return "480p";
  const named = resolutionInTitle(video.title);
  if (named) return named;
  if (live) return "1080p";
  return dependsOnChannel(video, released) && video.subscribers >= BIG_CHANNEL_SUBSCRIBERS ? "2160p" : "1080p";
}

/** How the estimate reads in YouStream's own stream text: "4K", else as is. */
const resolutionLabel = (resolution) => (resolution === "2160p" ? "4K" : resolution);

module.exports = {
  estimateResolution,
  cameOutFor,
  resolutionInTitle,
  dependsOnChannel,
  resolutionLabel,
  BIG_CHANNEL_SUBSCRIBERS,
  RECENT_FROM_YEAR
};
