const crypto = require("crypto");

/**
 * The reader's YouTube catalogs: rows on the app's home screen, in the
 * reader's order -- the order is the setting, so this is a list.
 *
 *   search    a YouTube search, ranked the way YouTube ranks it, or newest,
 *             most viewed or top rated first, optionally kept to a length
 *             or to recent uploads
 *   channel   a channel's uploads, newest or most viewed first: its videos,
 *             its Shorts, its live streams, any two of them, or everything
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
 *   { channel: "UC...", name: "Marques Brownlee", types: ["shorts"], sort: "viewCount" }
 *   { playlist: "PL...", name: "Lectures" }
 *   { trending: "music" }
 *
 * Any of them can keep to some kinds of video, of videos, Shorts and live
 * streams -- every kind by default, and a channel's videos alone:
 *
 *   { q: "cricket highlights", sort: "date", types: ["videos", "live"] }
 *
 * Any of them can have a name of its own, which apps show in place of the
 * one made from what it lists:
 *
 *   { q: "lofi hip hop", sort: "date", label: "Lofi" }
 *
 * Any of them can stay off the apps' home screens, listed in Discover alone
 * (every catalog is on the home screen too unless the reader says not):
 *
 *   { trending: "music", home: false }
 *
 * Any of them can also keep only, or leave out, the videos that mention some
 * words in their title, channel name or description:
 *
 *   { q: "indian stand up comedy", sort: "date", exclude: ["gaurav kapoor"] }
 *   { trending: "all", include: ["cricket", "ipl"] }
 */

/** YouTube search's own orders. Relevance is YouTube's ranking, its default. */
const SORTS = [
  { id: "relevance", label: "Most relevant" },
  { id: "date", label: "Newest", short: "Newest" },
  { id: "viewCount", label: "Most viewed", short: "Most viewed" },
  { id: "rating", label: "Top rated", short: "Top rated" }
];

/**
 * The lengths a row can keep to: any of four ranges, together or not, or a
 * range of minutes of the reader's own. Kept as one word:
 *
 *   any                    every length
 *   short, medium, long    YouTube's own: under 4 minutes, 4 to 20, over 20
 *   under4+over60          ranges together
 *   30-45, 90-, 0-10       minutes, from and to, either left open
 *
 * YouTube's search knows only its own three, so a search asks for the
 * narrowest that holds the length and trims the rest from its results;
 * every other row trims its own. Ranges that make up one of YouTube's
 * lengths are kept as its word, so a row from before ranges keeps its id.
 * Bounds are in seconds, inclusive.
 */
const LENGTH_RANGES = [
  { id: "under4", label: "Under 4", min: 0, max: 239, from: 0, to: 4 },
  { id: "4to20", label: "4–20", min: 240, max: 1200, from: 4, to: 20 },
  { id: "20to60", label: "20–60", min: 1201, max: 3600, from: 20, to: 60 },
  { id: "over60", label: "Over 60", min: 3601, max: Infinity, from: 60, to: null }
];
const YOUTUBE_LENGTHS = [
  { id: "short", ranges: ["under4"] },
  { id: "medium", ranges: ["4to20"] },
  { id: "long", ranges: ["20to60", "over60"] }
];
const MAX_LENGTH_MINUTES = 1440;
const ANY_LENGTH = { id: "any", ranges: [], youtube: null, trims: false, short: "" };

/**
 * The narrowest of YouTube's lengths that holds [min, max] seconds, or
 * null for none. A second either way of its bounds is let in: a search for
 * "over 20 minutes" leaves out only what runs exactly 20:00.
 */
function youtubeLengthHolding(min, max) {
  if (max <= 240) return "short";
  if (min >= 240 && max <= 1201) return "medium";
  if (min >= 1200) return "long";
  return null;
}

/** "Under 4 min", "4–60 min", "Over 1 hr": minutes, from and to, either open. */
function minutesName(from, to) {
  const say = (m) => (m === 60 ? "1 hr" : `${m} min`);
  if (!from) return `Under ${say(to)}`;
  if (to === null) return `Over ${say(from)}`;
  return `${from}–${to} min`;
}

/** A length made of ranges (their ids), as lengthOf gives it. */
function rangesLength(ids) {
  const chosen = LENGTH_RANGES.filter((range) => ids.includes(range.id));
  if (!chosen.length || chosen.length === LENGTH_RANGES.length) return ANY_LENGTH;
  const key = chosen.map((range) => range.id).join("+");
  const youtube = YOUTUBE_LENGTHS.find((length) => length.ranges.join("+") === key);
  // Side by side, ranges read as one: "under 20 minutes" for the first two.
  const spans = [];
  chosen.forEach((range) => {
    const last = spans[spans.length - 1];
    if (last && LENGTH_RANGES.indexOf(last[1]) === LENGTH_RANGES.indexOf(range) - 1) last[1] = range;
    else spans.push([range, range]);
  });
  const names = spans.map(([first, last], i) => {
    const name = minutesName(first.from, last.to);
    return i ? name.charAt(0).toLowerCase() + name.slice(1) : name;
  });
  return {
    id: youtube ? youtube.id : key,
    ranges: chosen.map((range) => [range.min, range.max]),
    youtube: youtubeLengthHolding(chosen[0].min, chosen[chosen.length - 1].max),
    trims: !youtube,
    short: names.join(" & ")
  };
}

/** A length in minutes, from and to, either one open. */
function minutesLength(from, to) {
  if (from === 0 && to === null) return ANY_LENGTH;
  const min = from * 60;
  const max = to === null ? Infinity : to * 60;
  return {
    id: `${from}-${to === null ? "" : to}`,
    ranges: [[min, max]],
    youtube: youtubeLengthHolding(min, max),
    trims: true,
    short: minutesName(from, to)
  };
}

/**
 * A row's length, from the word it is kept as: its id, the ranges in
 * seconds it keeps (none for any length), YouTube's own length a search
 * asks for, whether results must be trimmed beyond that, and its name in
 * the row's name. Anything else is any length.
 */
function lengthOf(raw) {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const youtube = YOUTUBE_LENGTHS.find((length) => length.id === text);
  if (youtube) return rangesLength(youtube.ranges);
  const ids = text.split("+");
  if (ids.every((id) => LENGTH_RANGES.some((range) => range.id === id))) return rangesLength(ids);
  const minutes = /^(\d{1,4})-(\d{1,4})?$/.exec(text);
  if (minutes) {
    const from = Number(minutes[1]);
    const to = minutes[2] === undefined ? null : Number(minutes[2]);
    if (from <= MAX_LENGTH_MINUTES && (to === null || (to > from && to <= MAX_LENGTH_MINUTES))) return minutesLength(from, to);
  }
  return ANY_LENGTH;
}

/** The end of a row's id for its length, unless it is any length. */
const lengthSuffix = (length) => (length.id === "any" ? "" : `.${length.id}`);

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
 * The kinds of video a row can keep to, any of them. YouTube's API has no
 * field for them, so each video's is told from its details (youtube.js
 * formatOf, its `format` here). A premiere counts as a video, as YouTube
 * counts it. `inner` is the name after the first in a row's name.
 */
const VIDEO_TYPES = [
  { id: "videos", label: "Videos", short: "Videos", inner: "videos", format: "video" },
  { id: "shorts", label: "Shorts", short: "Shorts", inner: "Shorts", format: "short" },
  { id: "live", label: "Live streams", short: "Live", inner: "live", format: "stream" }
];
const ALL_TYPES = VIDEO_TYPES.map((type) => type.id);

/**
 * What a channel row reads. Each is a playlist YouTube keeps for every
 * channel, named by a prefix in place of the channel id's UC: UULF is the
 * long-form uploads alone, which is how Shorts are left out exactly rather
 * than guessed at. Beside each is the same list most viewed first
 * (`popular`, its top 200), so either order costs a unit a page. A row of
 * one kind reads that kind's list; of two, every upload, with the third
 * kind told and left out as on any other row.
 */
const CHANNEL_SHOWS = [
  { id: "videos", playlist: "UULF", popular: "UULP" },
  { id: "shorts", playlist: "UUSH", popular: "UUPS" },
  { id: "live", playlist: "UULV", popular: "UUPV" },
  { id: "all", playlist: "UU", popular: "PU" }
];

/** What a channel row keeps to unless told otherwise: its videos, as it always has. */
const CHANNEL_TYPES = ["videos"];

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

/**
 * A catalog's keyword filter: keep only the videos that mention one of its
 * words, or leave them out. Words are matched whole, in any case, with or
 * without accents (text.js), in the title, the channel's name and the
 * description, or in the first two only, for when a description that
 * credits or tags someone would hide too much.
 */
const FILTER_MODES = [
  { id: "include", label: "Only videos mentioning" },
  { id: "exclude", label: "Hide videos mentioning" }
];
const FILTER_SCOPES = [
  { id: "all", label: "In the title, channel or description" },
  { id: "title", label: "In the title or channel only" }
];
const MAX_FILTER_WORDS = 20;
const MAX_FILTER_WORD_LENGTH = 60;

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
 * A row's kinds of video: those of VIDEO_TYPES it names, in a list or a
 * comma-separated line, in VIDEO_TYPES' order; `usual` when it names none.
 */
function typesOf(raw, usual) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((part) => part.trim()) : [];
  const types = ALL_TYPES.filter((id) => list.includes(id));
  return types.length ? types : usual;
}

const sameTypes = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const everyType = (types) => types.length === ALL_TYPES.length;
const onlyShorts = (types) => types.length === 1 && types[0] === "shorts";

/**
 * The kinds of video as an option of a row's name, said only when they are
 * not the row's usual: "Shorts", "Videos & live", and "Everything" for a
 * channel's every kind.
 */
function typesOption(types, usual) {
  if (sameTypes(types, usual)) return { short: "" };
  if (everyType(types)) return { short: "Everything" };
  const named = VIDEO_TYPES.filter((type) => types.includes(type.id));
  return { short: named.map((type, i) => (i ? type.inner : type.short)).join(" & ") };
}

/** The kinds of video in a row's id: "shorts", "videos-live", "all". */
const typesKey = (types) => (everyType(types) ? "all" : types.join("-"));

/** The end of a row's id for its kinds, when they are not every kind: rows from before kinds keep their ids. */
const typesSuffix = (types) => (everyType(types) ? "" : `.${typesKey(types)}`);

/**
 * A search catalog. Its id is derived from what it searches, so re-saving
 * an unchanged config never orphans a row the app already shows, and two
 * rows searching the same thing are one.
 */
function searchEntry(raw) {
  const q = tidy(raw.q, MAX_QUERY_LENGTH, { ellipsis: false });
  if (!q) return null;
  const sort = optionOf(SORTS, raw.sort);
  const types = typesOf(raw.types, ALL_TYPES);
  // A row of Shorts alone asks YouTube for videos under four minutes, which
  // every Short is (browse.js), so a length it was given has no say.
  const length = rowLength(raw, types);
  const within = optionOf(PERIODS, raw.within);
  const words = slug(q);
  // A row of every kind keeps the id it had before kinds could be chosen.
  const parts = [q.toLowerCase(), sort.id, length.id, within.id, ...(everyType(types) ? [] : [typesKey(types)])];
  const id = `search.${words ? `${words}.` : ""}${shortHash(JSON.stringify(parts))}`;
  return {
    kind: "search",
    id,
    name: tidy(withOptions(q, [sort, length, within, typesOption(types, ALL_TYPES)]), MAX_NAME_LENGTH),
    q,
    sort: sort.id,
    length: length.id,
    within: within.id,
    types
  };
}

/** A row's length: none of its own for Shorts alone, which are all short. */
const rowLength = (raw, types) => (onlyShorts(types) ? ANY_LENGTH : lengthOf(raw.length));

/**
 * A channel's or playlist's own name: `name` as stored, or `title` in an
 * entry already normalized, whose `name` is the row's -- so normalizing
 * twice changes nothing.
 */
const ownTitle = (raw) => (raw.title !== undefined ? raw.title : raw.name);

/**
 * A channel row's kinds of video: as stored, or as a row stored before they
 * could be mixed says, by the one list it read (`show`), which its id kept.
 */
function channelTypes(raw) {
  if (raw.types !== undefined) return typesOf(raw.types, CHANNEL_TYPES);
  const show = CHANNEL_SHOWS.find((option) => option.id === raw.show);
  if (!show) return CHANNEL_TYPES;
  return show.id === "all" ? ALL_TYPES : [show.id];
}

function channelEntry(raw) {
  if (typeof raw.channel !== "string" || !CHANNEL_ID.test(raw.channel)) return null;
  const types = channelTypes(raw);
  const sort = optionOf(CHANNEL_SORTS, raw.sort);
  const length = rowLength(raw, types);
  const title = tidy(ownTitle(raw), MAX_NAME_LENGTH) || "YouTube channel";
  return {
    kind: "channel",
    id: `channel.${raw.channel}.${typesKey(types)}${sort === CHANNEL_SORTS[0] ? "" : `.${sort.id}`}${lengthSuffix(length)}`,
    name: tidy(withOptions(title, [typesOption(types, CHANNEL_TYPES), sort, length]), MAX_NAME_LENGTH),
    title,
    channel: raw.channel,
    types,
    sort: sort.id,
    length: length.id
  };
}

function playlistEntry(raw) {
  if (typeof raw.playlist !== "string" || !PLAYLIST_ID.test(raw.playlist)) return null;
  const title = tidy(ownTitle(raw), MAX_NAME_LENGTH) || "YouTube playlist";
  const types = typesOf(raw.types, ALL_TYPES);
  const length = rowLength(raw, types);
  return {
    kind: "playlist",
    id: `playlist.${raw.playlist}${typesSuffix(types)}${lengthSuffix(length)}`,
    name: tidy(withOptions(title, [typesOption(types, ALL_TYPES), length]), MAX_NAME_LENGTH),
    title,
    playlist: raw.playlist,
    types,
    length: length.id
  };
}

function trendingEntry(raw) {
  const chart = TRENDING.find((t) => t.id === raw.trending);
  if (!chart) return null;
  const types = typesOf(raw.types, ALL_TYPES);
  const length = rowLength(raw, types);
  return {
    kind: "trending",
    id: `trending.${chart.id}${typesSuffix(types)}${lengthSuffix(length)}`,
    name: withOptions(chart.label, [typesOption(types, ALL_TYPES), length]),
    trending: chart.id,
    types,
    length: length.id
  };
}

/**
 * A filter's words: a list or a comma-separated line, each one tidied,
 * without blanks or repeats (in any case), at most MAX_FILTER_WORDS.
 */
function filterWords(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set();
  const words = [];
  for (const item of list) {
    const word = tidy(item, MAX_FILTER_WORD_LENGTH, { ellipsis: false });
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length === MAX_FILTER_WORDS) break;
  }
  return words;
}

/**
 * A stored catalog's filter, { mode, words, scope }, or null. Leaving out
 * wins if a catalog somehow has both, as only a hand-edited one could. The
 * scope is stored as filterIn only when it is not the whole video. Also
 * reads an entry already normalized, whose filter is under `filter`.
 */
function filterOf(raw) {
  const normalized = raw.filter && typeof raw.filter === "object";
  const stored = normalized ? { [raw.filter.mode]: raw.filter.words } : raw;
  const scope = (normalized ? raw.filter.scope : raw.filterIn) === "title" ? "title" : "all";
  for (const { id } of [...FILTER_MODES].reverse()) {
    const words = filterWords(stored[id]);
    if (words.length) return { mode: id, words, scope };
  }
  return null;
}

/** One stored catalog as the rest of the addon reads it, or null when it is not one. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let entry = null;
  if (raw.q !== undefined) entry = searchEntry(raw);
  else if (raw.channel !== undefined) entry = channelEntry(raw);
  else if (raw.playlist !== undefined) entry = playlistEntry(raw);
  else if (raw.trending !== undefined) entry = trendingEntry(raw);
  if (!entry) return null;
  // A name of the reader's own is what apps show; like the filter, it is no
  // part of the id, so renaming a row never makes it a new one.
  const label = tidy(raw.label, MAX_NAME_LENGTH);
  // Nor is where the row shows, home screen and Discover or Discover alone.
  return { ...entry, ...(label ? { name: label, label } : {}), home: raw.home !== false, filter: filterOf(raw) };
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
  const source = { ...toStoredSource(entry), ...(entry.label ? { label: entry.label } : {}), ...(entry.home === false ? { home: false } : {}) };
  if (!entry.filter) return source;
  const { mode, words, scope } = entry.filter;
  return { ...source, [mode]: words, ...(scope === "title" ? { filterIn: "title" } : {}) };
}

/** A row's kinds of video, stored only when they are not its usual. */
const storedTypes = (types, usual) => (sameTypes(types, usual) ? {} : { types });

function toStoredSource(entry) {
  if (entry.kind === "search") {
    return {
      q: entry.q,
      ...(entry.sort !== "relevance" ? { sort: entry.sort } : {}),
      ...(entry.length !== "any" ? { length: entry.length } : {}),
      ...(entry.within !== "any" ? { within: entry.within } : {}),
      ...storedTypes(entry.types, ALL_TYPES)
    };
  }
  const length = entry.length !== "any" ? { length: entry.length } : {};
  if (entry.kind === "channel") {
    return {
      channel: entry.channel,
      name: entry.title,
      ...storedTypes(entry.types, CHANNEL_TYPES),
      ...(entry.sort !== "date" ? { sort: entry.sort } : {}),
      ...length
    };
  }
  if (entry.kind === "playlist") return { playlist: entry.playlist, name: entry.title, ...storedTypes(entry.types, ALL_TYPES), ...length };
  return { trending: entry.trending, ...storedTypes(entry.types, ALL_TYPES), ...length };
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
  LENGTH_RANGES,
  MAX_LENGTH_MINUTES,
  lengthOf,
  PERIODS,
  VIDEO_TYPES,
  ALL_TYPES,
  CHANNEL_TYPES,
  CHANNEL_SHOWS,
  CHANNEL_SORTS,
  TRENDING,
  PAGE_SIZE,
  MAX_PAGES,
  SKIP_OPTIONS,
  MAX_CATALOGS,
  MAX_QUERY_LENGTH,
  MAX_NAME_LENGTH,
  FILTER_MODES,
  FILTER_SCOPES,
  MAX_FILTER_WORDS,
  MAX_FILTER_WORD_LENGTH,
  filterWords,
  typesOf,
  onlyShorts,
  everyType,
  normalizeEntry,
  normalizeCatalogs,
  toStoredEntry,
  toStoredCatalogs,
  parseSourceLink,
  SOURCE_KINDS,
  tidy,
  slug
};
