const { toVideo } = require("./youtube");
const { formatCount } = require("./text");
const { WATCH_URL } = require("./playback");

/**
 * YouTube videos as items of their own: what the YouTube catalogs and search
 * list, what an app saves to its library, and what YouStream gives metadata
 * and streams for.
 *
 * They have their own type, "YouTube", spelled exactly so: a video is not a
 * film or an episode, and an app's library can then list saved videos apart
 * from everything else (Nuvio's type picker shows it as written). Ids are
 * "youstream:" and the video's id, a prefix no other addon claims, so the app
 * asks YouStream -- and only YouStream -- about them, however long after they
 * were saved.
 */
const ITEM_TYPE = "YouTube";
const ITEM_PREFIX = "youstream:";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** YouTube's own limit on a description. */
const MAX_DESCRIPTION = 5000;
/** A catalog row needs only the start of one, and every page is cached. */
const PREVIEW_DESCRIPTION = 300;

const itemId = (videoId) => `${ITEM_PREFIX}${videoId}`;

/** The video id in an item id, or null when it is not one. */
function videoIdOf(id) {
  if (typeof id !== "string" || !id.startsWith(ITEM_PREFIX)) return null;
  const videoId = id.slice(ITEM_PREFIX.length);
  return VIDEO_ID.test(videoId) ? videoId : null;
}

/**
 * YouTube's video categories. The same everywhere, so kept here rather than
 * asked for (videoCategories.list).
 */
const CATEGORIES = {
  1: "Film & Animation", 2: "Autos & Vehicles", 10: "Music", 15: "Pets & Animals", 17: "Sports",
  18: "Short Movies", 19: "Travel & Events", 20: "Gaming", 21: "Videoblogging", 22: "People & Blogs",
  23: "Comedy", 24: "Entertainment", 25: "News & Politics", 26: "Howto & Style", 27: "Education",
  28: "Science & Technology", 29: "Nonprofits & Activism", 30: "Movies", 31: "Anime/Animation",
  32: "Action/Adventure", 33: "Classics", 34: "Comedy", 35: "Documentary", 36: "Drama", 37: "Family",
  38: "Foreign", 39: "Horror", 40: "Sci-Fi/Fantasy", 41: "Thriller", 42: "Shorts", 43: "Shows", 44: "Trailers"
};

/**
 * The largest of the sizes asked for that the video has. Only maxres
 * (1280x720) and medium (320x180) are 16:9; high and standard are 4:3 with
 * black bars, so a landscape poster takes maxres, else medium.
 */
function thumbnail(thumbnails, sizes) {
  const size = sizes.find((name) => thumbnails[name] && typeof thumbnails[name].url === "string");
  return size ? thumbnails[size].url : null;
}

/**
 * A video as browsing keeps it: everything matching keeps (youtube.toVideo),
 * plus the whole description, the artwork, the tags and the category.
 */
function toItem(detail) {
  const snippet = detail.snippet || {};
  const thumbnails = snippet.thumbnails || {};
  // Every video has this one, whatever the API listed.
  const fallback = `https://i.ytimg.com/vi/${detail.id}/mqdefault.jpg`;
  return {
    ...toVideo(detail),
    description: typeof snippet.description === "string" ? snippet.description.slice(0, MAX_DESCRIPTION) : "",
    poster: thumbnail(thumbnails, ["maxres", "medium"]) || fallback,
    background: thumbnail(thumbnails, ["maxres", "high", "medium"]) || fallback,
    tags: Array.isArray(snippet.tags) ? snippet.tags.filter((t) => typeof t === "string").slice(0, 40) : [],
    category: CATEGORIES[snippet.categoryId] || null
  };
}

/** The same video with only what a catalog row shows, for the per-reader page caches. */
function toPreview(item) {
  const { tags, category, ...rest } = item;
  return { ...rest, description: item.description.slice(0, PREVIEW_DESCRIPTION) };
}

/** "1h 35m", "12 min", "45 sec"; nothing for a live stream, which has no length. */
function runtimeText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes} min`;
}

/** A live stream says so where a grid shows text: on the name. */
const itemName = (item) => `${item.live === "live" ? "🔴 " : ""}${item.title || "Untitled"}`;

const releaseInfo = (item) => (item.publishedAt ? item.publishedAt.slice(0, 10) : undefined);

/** One video in a catalog or in search results. */
function toMetaPreview(item) {
  const id = itemId(item.id);
  return {
    id,
    type: ITEM_TYPE,
    name: itemName(item),
    poster: item.poster,
    posterShape: "landscape",
    background: item.background,
    description: item.description || undefined,
    releaseInfo: releaseInfo(item),
    runtime: runtimeText(item.durationSeconds),
    // Opens the video's own streams rather than a list of episodes.
    behaviorHints: { defaultVideoId: id }
  };
}

/** The description, then who uploaded it and how widely it has been seen. */
function fullDescription(item) {
  const views = formatCount(item.views);
  const credit = [`${item.channelTitle || "YouTube"}${item.licensed ? " ✓" : ""}`, views ? `${views} views` : null]
    .filter(Boolean)
    .join(" · ");
  const notes = item.ageRestricted ? "🔞 Age-restricted: it plays in the YouTube app, where you are signed in." : null;
  return [item.description, credit, notes].filter(Boolean).join("\n\n");
}

/** Everything the detail page shows. */
function toFullMeta(item) {
  return {
    ...toMetaPreview(item),
    description: fullDescription(item),
    released: item.publishedAt || undefined,
    genres: itemGenres(item),
    website: `${WATCH_URL}${item.id}`,
    links: item.channelId
      ? [{ name: item.channelTitle || "YouTube", category: "Channel", url: `https://www.youtube.com/channel/${item.channelId}` }]
      : []
  };
}

// --- Tags ----------------------------------------------------------------
//
// The detail page's tag row: the video's category, then the uploader's own
// tags. Those are a channel's SEO as much as a description of the video --
// one upload carried fifteen rewordings of a single phrase -- so they are
// cleaned the way Newsio cleans publishers' keywords: generic words, the
// channel's own name, handles and slugs dropped, rewordings of one phrase
// kept once, Title Case with initialisms upper.

/** Tags that describe YouTube rather than the video. */
const GENERIC_TAGS = new Set([
  "video", "videos", "youtube", "youtube video", "new", "new video", "latest", "latest video", "viral", "trending",
  "official", "official video", "full video", "full hd", "hd", "4k", "1080p", "720p", "shorts", "short", "subscribe",
  "like", "share", "comment", "channel", "watch", "free", "best", "top", "2024", "2025", "2026"
]);

/** Initialisms that read wrong in Title Case. */
const ACRONYMS = new Set([
  "ai", "ar", "vr", "us", "uk", "eu", "un", "usa", "uae", "gdp", "ceo", "ev", "suv", "nasa", "nfl", "nba", "mlb",
  "nhl", "ipl", "fifa", "uefa", "f1", "gps", "api", "tv", "pc", "ps5", "ps4", "gpu", "cpu", "ssd", "usb", "diy",
  "faq", "asmr", "dj", "mv", "ost", "bgm", "lofi", "edm", "rpg", "fps", "mmo", "mmorpg", "pvp", "ui", "ux", "3d", "2d",
  "hbo", "bbc", "cnn", "nbc", "cbs", "abc", "espn", "nhs", "fbi", "cia", "wwe", "ufc", "mma", "kpop", "jpop"
]);

const MAX_TAG_LENGTH = 28;
const MAX_TAGS = 6;

/** Letters and digits only, for comparing a tag with the channel's name. */
const fold = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * "sci-fi" -> "Sci-Fi", "ai tools" -> "AI Tools", "LOFI BEATS" -> "Lofi
 * Beats". A tag already in mixed case is the uploader's own spelling and is
 * kept: "McConaughey", "iPhone", "PlayStation".
 */
function titleCaseTag(tag) {
  if (tag !== tag.toLowerCase() && tag !== tag.toUpperCase()) return tag;
  return tag
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => {
      if (!part.trim() || part === "-") return part;
      if (ACRONYMS.has(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

/**
 * Hyphenated tags that share a segment with another are a channel's own
 * taxonomy ("mkbhd-review", "mkbhd-unboxing"), not subjects. A lone
 * hyphenated tag ("sci-fi") is a real one, and so are two that only share
 * a scrap of a word ("sci-fi", "lo-fi").
 */
function slugFamilySegments(tags) {
  const counts = new Map();
  tags
    .filter((t) => t.includes("-"))
    .forEach((t) => new Set(t.toLowerCase().split("-")).forEach((s) => s.length > 2 && counts.set(s, (counts.get(s) || 0) + 1)));
  return new Set([...counts].filter(([, n]) => n > 1).map(([segment]) => segment));
}

/** The words of a tag that can tell two tags apart. */
function tagWords(tag) {
  return new Set(
    tag
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1)
  );
}

/**
 * Two tags are one family when most of the shorter one's words are in the
 * other: "iphone 17 review" and "iphone 17 pro review". Single words are
 * exempt, since "Radio" and "Visual Radio" are not the same subject.
 */
function isSameFamily(words, previous) {
  if (words.size < 2) return false;
  return previous.some((prior) => {
    if (prior.size < 2) return false;
    let shared = 0;
    words.forEach((word) => {
      if (prior.has(word)) shared += 1;
    });
    return shared / Math.min(words.size, prior.size) >= 0.6;
  });
}

function itemGenres(item) {
  const channel = fold(item.channelTitle);
  const raw = (item.tags || []).map((t) => t.trim()).filter(Boolean);
  const slugs = slugFamilySegments(raw);
  const tags = raw
    .filter((tag) => {
      const lower = tag.toLowerCase();
      if (tag.length > MAX_TAG_LENGTH || GENERIC_TAGS.has(lower)) return false;
      if (tag.includes("_") || tag.startsWith("#") || tag.startsWith("@")) return false;
      if (/^\d+$/.test(tag)) return false;
      // The channel advertising itself, either way round: "Paramount" on
      // Paramount Movies, "Marques Brownlee Reviews" on Marques Brownlee.
      const folded = fold(tag);
      if (channel && folded && (channel.includes(folded) || (channel.length >= 4 && folded.includes(channel)))) return false;
      return !lower.split("-").some((segment) => slugs.has(segment));
    })
    .map(titleCaseTag);

  const seen = new Set();
  const families = [];
  const out = [];
  for (const tag of [...(item.category ? [item.category] : []), ...tags]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const words = tagWords(tag);
    if (isSameFamily(words, families)) continue;
    families.push(words);
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out.length ? out : undefined;
}

module.exports = {
  ITEM_TYPE,
  ITEM_PREFIX,
  CATEGORIES,
  itemId,
  videoIdOf,
  toItem,
  toPreview,
  toMetaPreview,
  toFullMeta,
  fullDescription,
  runtimeText,
  itemGenres,
  titleCaseTag,
  tagWords,
  isSameFamily,
  MAX_DESCRIPTION,
  PREVIEW_DESCRIPTION
};
