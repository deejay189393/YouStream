const crypto = require("crypto");

/**
 * The reader's YouTube catalogs: rows on the app's home screen, in the
 * reader's order -- the order is the setting, so this is a list.
 *
 *   search    a YouTube search, ranked the way YouTube ranks it, or newest,
 *             most viewed or top rated first, optionally kept to a length
 *             or to recent uploads
 *   channel   a channel's uploads, newest or most viewed first: its videos
 *             without Shorts, its Shorts, its live streams, or everything
 *   playlist  a public playlist, in its own order
 *   trending  YouTube's most popular videos in the reader's country, all of
 *             them or one category
 *
 * They cost very different amounts of the reader's quota. A search is 101
 * units a page (search.list is 100 of them) out of 10,000 a day; a channel,
 * a playlist or Trending is 1 or 2.
 *
 * Stored in the install URL compactly, a default left out:
 *
 *   { q: "lofi hip hop", sort: "date", length: "long", within: "week" }
 *   { channel: "UC...", name: "Marques Brownlee", show: "shorts", sort: "viewCount" }
 *   { playlist: "PL...", name: "Lectures" }
 *   { trending: "music" }
 */

/** YouTube search's own orders. Relevance is YouTube's ranking, its default. */
const SORTS = [
  { id: "relevance", label: "Most relevant" },
  { id: "date", label: "Newest", short: "Newest" },
  { id: "viewCount", label: "Most viewed", short: "Most viewed" },
  { id: "rating", label: "Top rated", short: "Top rated" }
];

/** YouTube search's length filter. Shorts are all under four minutes. */
const LENGTHS = [
  { id: "any", label: "Any length" },
  { id: "short", label: "Under 4 minutes", short: "Under 4 min" },
  { id: "medium", label: "4 to 20 minutes", short: "4–20 min" },
  { id: "long", label: "Over 20 minutes", short: "Over 20 min" }
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** How recent an upload must be, as YouTube search's upload-date filter. */
const PERIODS = [
  { id: "any", label: "Any time", ms: 0 },
  { id: "day", label: "Today", short: "Today", ms: DAY_MS },
  { id: "week", label: "This week", short: "This week", ms: 7 * DAY_MS },
  { id: "month", label: "This month", short: "This month", ms: 30 * DAY_MS },
  { id: "year", label: "This year", short: "This year", ms: 365 * DAY_MS }
];

/**
 * What a channel row lists. Each is a playlist YouTube keeps for every
 * channel, named by a prefix in place of the channel id's UC: UULF is the
 * long-form uploads alone, which is how Shorts are left out exactly rather
 * than guessed at by length. Beside each is the same list most viewed
 * first (`popular`, its top 200), so either order costs a unit a page.
 */
const CHANNEL_SHOWS = [
  { id: "videos", label: "Videos", playlist: "UULF", popular: "UULP" },
  { id: "shorts", label: "Shorts", short: "Shorts", playlist: "UUSH", popular: "UUPS" },
  { id: "live", label: "Live streams", short: "Live", playlist: "UULV", popular: "UUPV" },
  { id: "all", label: "Everything", short: "Everything", playlist: "UU", popular: "PU" }
];

/** A channel row's order: as uploaded, the way the channel lists it, or by views. */
const CHANNEL_SORTS = [
  { id: "date", label: "Newest" },
  { id: "viewCount", label: "Most viewed", short: "Most viewed" }
];

/**
 * YouTube's most popular videos, all or by category (the video categories'
 * ids). A category YouTube keeps no chart for in a country is an empty row
 * there.
 */
const TRENDING = [
  { id: "all", label: "Trending", chip: "Trending", category: null },
  { id: "music", label: "Trending Music", chip: "Music", category: "10" },
  { id: "gaming", label: "Trending Gaming", chip: "Gaming", category: "20" },
  { id: "film", label: "Trending Film & Animation", chip: "Film & Animation", category: "1" },
  { id: "entertainment", label: "Trending Entertainment", chip: "Entertainment", category: "24" },
  { id: "sports", label: "Trending Sports", chip: "Sports", category: "17" },
  { id: "news", label: "Trending News", chip: "News", category: "25" },
  { id: "comedy", label: "Trending Comedy", chip: "Comedy", category: "23" },
  { id: "science", label: "Trending Science & Technology", chip: "Science & Tech", category: "28" },
  { id: "education", label: "Trending Education", chip: "Education", category: "27" },
  { id: "howto", label: "Trending Howto & Style", chip: "Howto & Style", category: "26" }
];

/**
 * A catalog page is one page of YouTube results, fifty, and a catalog goes
 * five pages deep: 250 videos, past which scrolling only spends the quota.
 * The steps are declared because the protocol's default page is 100, and a
 * shorter page with no declared step reads as the end of the catalog.
 */
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const SKIP_OPTIONS = Array.from({ length: MAX_PAGES }, (_, i) => String(i * PAGE_SIZE));

/** Keeps the install URL and the manifest small (Stremio's addon sync takes 8 KB). */
const MAX_CATALOGS = 20;
const MAX_QUERY_LENGTH = 100;
const MAX_NAME_LENGTH = 80;

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * One line of text: control characters out, whitespace collapsed, cut to
 * `max` -- with an ellipsis for a name, without one for what is searched.
 */
function tidy(value, max, { ellipsis = true } = {}) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return ellipsis ? `${text.slice(0, max - 1).trimEnd()}…` : text.slice(0, max).trimEnd();
}

const optionOf = (list, id) => list.find((option) => option.id === id) || list[0];

/** "Lo-Fi Hip Hop!" -> "lo-fi-hip-hop", for a readable catalog id. */
function slug(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
}

const shortHash = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);

/** A name and the options that set it apart: "AI news · Newest · This week". */
const withOptions = (name, options) => [name, ...options.map((o) => o.short).filter(Boolean)].join(" · ");

/**
 * A search catalog. Its id is derived from what it searches, so re-saving
 * an unchanged config never orphans a row the app already shows, and two
 * rows searching the same thing are one.
 */
function searchEntry(raw) {
  const q = tidy(raw.q, MAX_QUERY_LENGTH, { ellipsis: false });
  if (!q) return null;
  const sort = optionOf(SORTS, raw.sort);
  const length = optionOf(LENGTHS, raw.length);
  const within = optionOf(PERIODS, raw.within);
  const words = slug(q);
  const id = `search.${words ? `${words}.` : ""}${shortHash(JSON.stringify([q.toLowerCase(), sort.id, length.id, within.id]))}`;
  return {
    kind: "search",
    id,
    name: tidy(withOptions(q, [sort, length, within]), MAX_NAME_LENGTH),
    q,
    sort: sort.id,
    length: length.id,
    within: within.id
  };
}

/**
 * A channel's or playlist's own name: `name` as stored, or `title` in an
 * entry already normalized, whose `name` is the row's -- so normalizing
 * twice changes nothing.
 */
const ownTitle = (raw) => (raw.title !== undefined ? raw.title : raw.name);

function channelEntry(raw) {
  if (typeof raw.channel !== "string" || !CHANNEL_ID.test(raw.channel)) return null;
  const show = optionOf(CHANNEL_SHOWS, raw.show);
  const sort = optionOf(CHANNEL_SORTS, raw.sort);
  const title = tidy(ownTitle(raw), MAX_NAME_LENGTH) || "YouTube channel";
  return {
    kind: "channel",
    id: `channel.${raw.channel}.${show.id}${sort === CHANNEL_SORTS[0] ? "" : `.${sort.id}`}`,
    name: tidy(withOptions(title, [show, sort]), MAX_NAME_LENGTH),
    title,
    channel: raw.channel,
    show: show.id,
    sort: sort.id
  };
}

function playlistEntry(raw) {
  if (typeof raw.playlist !== "string" || !PLAYLIST_ID.test(raw.playlist)) return null;
  const title = tidy(ownTitle(raw), MAX_NAME_LENGTH) || "YouTube playlist";
  return { kind: "playlist", id: `playlist.${raw.playlist}`, name: title, title, playlist: raw.playlist };
}

function trendingEntry(raw) {
  const chart = TRENDING.find((t) => t.id === raw.trending);
  return chart ? { kind: "trending", id: `trending.${chart.id}`, name: chart.label, trending: chart.id } : null;
}

/** One stored catalog as the rest of the addon reads it, or null when it is not one. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.q !== undefined) return searchEntry(raw);
  if (raw.channel !== undefined) return channelEntry(raw);
  if (raw.playlist !== undefined) return playlistEntry(raw);
  if (raw.trending !== undefined) return trendingEntry(raw);
  return null;
}

/** The reader's catalogs, in their order, without repeats, at most MAX_CATALOGS. */
function normalizeCatalogs(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length === MAX_CATALOGS) break;
  }
  return out;
}

/** The compact form the install URL carries. */
function toStoredEntry(entry) {
  if (entry.kind === "search") {
    return {
      q: entry.q,
      ...(entry.sort !== "relevance" ? { sort: entry.sort } : {}),
      ...(entry.length !== "any" ? { length: entry.length } : {}),
      ...(entry.within !== "any" ? { within: entry.within } : {})
    };
  }
  if (entry.kind === "channel") {
    return {
      channel: entry.channel,
      name: entry.title,
      ...(entry.show !== "videos" ? { show: entry.show } : {}),
      ...(entry.sort !== "date" ? { sort: entry.sort } : {})
    };
  }
  if (entry.kind === "playlist") return { playlist: entry.playlist, name: entry.title };
  return { trending: entry.trending };
}

const toStoredCatalogs = (entries) => entries.map(toStoredEntry);

/**
 * A playlist's id on its own -- the part after list= in its link -- in the
 * shapes YouTube makes them: PL and 16 or 32 more, an album's OLAK5uy_ or a
 * YouTube Music list's RDCLAK5uy_ and 33, or a channel's own lists (UU,
 * UULF, PU...) and its id's 22. Exactly, so a handle such as PLAYSTATION5
 * stays one.
 */
const PLAYLIST_ALONE = /^(PL[A-Za-z0-9_-]{16}([A-Za-z0-9_-]{16})?|(OLAK5uy_|RDCLAK5uy_)[A-Za-z0-9_-]{33}|(UU|PU)[A-Z]{0,2}[A-Za-z0-9_-]{22})$/;

/**
 * What a YouTube link or id points at: { id }, { handle } or { username }
 * for a channel, { playlistId } for a playlist, { problem } for a YouTube
 * link that is neither, or null for text that is no YouTube link at all.
 *
 *   @mkbhd                                   youtube.com/@mkbhd/videos
 *   youtube.com/channel/UC...                UC... on its own
 *   youtube.com/playlist?list=PL...          PL... on its own
 *   youtube.com/watch?v=...&list=PL...       youtube.com/user/name
 */
function readLink(text) {
  if (!text || /\s/.test(text)) return null;
  let match = /^@([^/?#@]{3,100})$/.exec(text);
  if (match) return { handle: `@${match[1]}` };
  if (CHANNEL_ID.test(text)) return { id: text };
  if (PLAYLIST_ALONE.test(text)) return { playlistId: text };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch (_) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;

  const list = url.searchParams.get("list");
  if (list) {
    // Mixes are made per viewer, and Liked and Watch later are private;
    // YouTube Music's own curated lists (RDCLAK) are public.
    if (/^(RD(?!CLAK)|LL|WL|LM)/.test(list)) return { problem: "personal" };
    if (PLAYLIST_ID.test(list)) return { playlistId: list };
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch (_) {
    path = url.pathname;
  }
  if ((match = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(path))) return { id: match[1] };
  if ((match = /^\/(@[^/]{3,100})(?:\/|$)/.exec(path))) return { handle: match[1] };
  if ((match = /^\/user\/([^/]+)/.exec(path))) return { username: match[1] };
  if (/^\/c\//.test(path)) return { problem: "custom" };
  if (host === "youtu.be" || /^\/(watch|shorts|live|embed)\b/.test(path)) return { problem: "video" };
  return { problem: "other" };
}

/**
 * A handle typed without its @: letters in any script (with their vowel
 * signs and accents), digits, dots, dashes and underscores.
 */
const BARE_HANDLE = /^[\p{L}\p{M}\p{N}._-]{3,100}$/u;

/** The kinds of catalog a pasted link can add. */
const SOURCE_KINDS = ["playlist", "channel"];

const SOURCE_TEXT = {
  personal: "That is one of YouTube's own lists made for you, which it shares with nobody. Save the videos to a public playlist and add that.",
  custom: "YouTube cannot look up an old /c/ link. Paste the channel's @handle, or its link from the channel's About page.",
  playlist: {
    video: "That is a link to one video, not a playlist. Open the playlist on YouTube and copy its link.",
    other: "That YouTube link is not a playlist.",
    channel: "That is a channel, not a playlist. Choose YouTube channel to add it.",
    none: "Paste a playlist's link, or its ID: the part after list= in the link."
  },
  channel: {
    video: "That is a link to one video, not a channel. Paste the channel's link or its @handle.",
    other: "That YouTube link is not a channel.",
    playlist: "That is a playlist, not a channel. Choose YouTube playlist to add it.",
    none: "Paste a channel's link or its @handle."
  }
};

/**
 * What a reader pasted to add a catalog of the kind they chose, "playlist"
 * or "channel": { playlistId }, or { id }, { handle } or { username } for a
 * channel, or { error } saying what is wrong with it. A channel's handle may
 * be typed without its @.
 */
function parseSourceLink(raw, kind) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const found = readLink(text);
  const say = SOURCE_TEXT[kind];
  if (found && found.problem) return { error: SOURCE_TEXT[found.problem] || say[found.problem] };
  if (kind === "playlist") {
    if (found && found.playlistId) return found;
    return { error: found ? say.channel : say.none };
  }
  if (found && found.playlistId) return { error: say.playlist };
  if (found) return found;
  return BARE_HANDLE.test(text) ? { handle: `@${text}` } : { error: say.none };
}

module.exports = {
  SORTS,
  LENGTHS,
  PERIODS,
  CHANNEL_SHOWS,
  CHANNEL_SORTS,
  TRENDING,
  PAGE_SIZE,
  MAX_PAGES,
  SKIP_OPTIONS,
  MAX_CATALOGS,
  MAX_QUERY_LENGTH,
  MAX_NAME_LENGTH,
  normalizeEntry,
  normalizeCatalogs,
  toStoredEntry,
  toStoredCatalogs,
  parseSourceLink,
  SOURCE_KINDS,
  tidy,
  slug
};
