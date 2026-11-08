const { withKey, keyId, videosById, searchPage, playlistPage, chartPage, findChannel, findPlaylist } = require("./youtube");
const { toItem, toPreview, PREVIEW_DESCRIPTION } = require("./items");
const { fold, hasPhrase } = require("./text");
const { browseCache, videoCache } = require("./cache");
const { isBlocked } = require("./finder");
const { regionBlocked } = require("./matching");
const { refreshMs } = require("./config");
const { requestSignal } = require("./requestContext");
const { MAX_YOUTUBE_DATA_MS } = require("./hostConfig");
const {
  VIDEO_TYPES,
  CHANNEL_SHOWS,
  TRENDING,
  PERIODS,
  PAGE_SIZE,
  MAX_PAGES,
  MAX_QUERY_LENGTH,
  normalizeEntry,
  parseSourceLink,
  onlyShorts,
  everyType,
  tidy
} = require("./catalogs");

/**
 * YouTube browsed from the app: the reader's catalogs, live search, and any
 * one video by id for its metadata and streams.
 *
 * Catalogs are cached per reader -- by a fingerprint of their key -- for as
 * long as the reader chose, two hours by default, and served past that only
 * when YouTube cannot be asked (a spent quota, an outage). Search is live:
 * every new search asks YouTube, and its results are kept two minutes only,
 * so that scrolling further or going back costs nothing.
 *
 * Every video a page lists is also kept by id for everyone (videoCache), so
 * opening one from a row costs nothing more.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Nuvio searches as the reader types, 350 ms after each keystroke, and on a
 * TV remote every letter takes longer than that, so typing a title sends a
 * search per letter -- each a hundredth of the key's day. A search waits
 * this long first, and is dropped when a newer one from the same reader has
 * arrived meanwhile or the app has stopped waiting for it.
 */
const SEARCH_SETTLE_MS = 1000;
/**
 * Longer while the reader is plainly still typing: their last search, under
 * TYPING_GAP_MS ago, was the start of this one or this the start of it. On
 * a remote a letter takes a second or several, so the wait is the slowest
 * gap between their letters so far and half as much again, up to
 * MAX_TYPING_SETTLE_MS: the next letter is all but sure to come sooner than
 * that. Typing a title then costs one search, at whatever pace it is typed,
 * unless the reader stops mid-word for longer than that.
 */
const TYPING_GAP_MS = 5000;
const MAX_TYPING_SETTLE_MS = 5000;
const SEARCH_REUSE_MS = 2 * 60 * 1000;
/**
 * And a search's pages are kept this much longer, no more: long enough to
 * scroll on with their next-page token, or to answer with when YouTube
 * fails, but not days, as a catalog's are.
 */
const SEARCH_STALE_MS = 10 * 60 * 1000;
/**
 * A live stream's details are kept two minutes, not a day: how many are
 * watching, and whether it is live at all, change by the minute.
 */
const LIVE_ITEM_MS = 2 * 60 * 1000;

/** Han, kana and Hangul pack a word into a character or two. */
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Concurrent requests for the same thing share one. */
const inFlight = new Map();

function joined(key, run) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Whether a video can be offered to this reader: not blocked on this server
 * (BLOCKED_VIDEOS, BLOCKED_CHANNELS), not a premiere still to air, watchable
 * in their country, and embeddable if they asked for that.
 */
function playable(item, settings) {
  if (isBlocked(item) || item.live === "upcoming") return false;
  if (regionBlocked(item, settings.region)) return false;
  return !(settings.embeddableOnly && !item.embeddable);
}

/** The upload-date filter as YouTube takes it, on the hour so it is the same all hour. */
function publishedAfter(within, now = Date.now()) {
  const period = PERIODS.find((p) => p.id === within);
  if (!period || !period.ms) return undefined;
  return new Date(Math.floor((now - period.ms) / HOUR_MS) * HOUR_MS).toISOString();
}

function searchSource(q, { sort, length, within, types }, settings) {
  return {
    kind: "search",
    q,
    order: sort,
    // Every Short is under four minutes, so a row of Shorts alone asks for
    // those, and fills with far more of them.
    videoDuration: types && onlyShorts(types) ? "short" : length === "any" ? null : length,
    within,
    safeSearch: settings.safeSearch,
    regionCode: settings.region || null,
    // A ranking hint, not a filter: a search finds what YouTube finds.
    relevanceLanguage: settings.audioLanguage || null,
    embeddableOnly: settings.embeddableOnly
  };
}

/**
 * The list YouTube keeps of a channel's uploads of the row's kind, when it
 * keeps to one; else of all of them, of which the row then keeps its kinds.
 */
const channelShow = (types) => CHANNEL_SHOWS.find((show) => show.id === (types.length === 1 ? types[0] : "all"));

/** What YouTube is asked for to fill a catalog. */
function sourceOf(entry, settings) {
  if (entry.kind === "search") return searchSource(entry.q, entry, settings);
  if (entry.kind === "channel") {
    const show = channelShow(entry.types);
    return { kind: "playlist", playlistId: `${entry.sort === "viewCount" ? show.popular : show.playlist}${entry.channel.slice(2)}` };
  }
  if (entry.kind === "playlist") return { kind: "playlist", playlistId: entry.playlist };
  const chart = TRENDING.find((t) => t.id === entry.trending);
  return { kind: "chart", regionCode: settings.region || null, videoCategoryId: chart.category };
}

/** One page from YouTube: fifty videos at most, and the next page's token. */
async function fetchUpstream(source, apiKey, pageToken) {
  let details;
  let next;
  if (source.kind === "chart") {
    ({ details, next } = await chartPage({
      apiKey,
      regionCode: source.regionCode || undefined,
      videoCategoryId: source.videoCategoryId || undefined,
      pageToken
    }));
  } else {
    const found =
      source.kind === "search"
        ? await searchPage({
            apiKey,
            q: source.q,
            order: source.order,
            videoDuration: source.videoDuration || undefined,
            publishedAfter: publishedAfter(source.within),
            safeSearch: source.safeSearch,
            regionCode: source.regionCode || undefined,
            relevanceLanguage: source.relevanceLanguage || undefined,
            embeddableOnly: source.embeddableOnly,
            pageToken
          })
        : await playlistPage({ apiKey, playlistId: source.playlistId, pageToken });
    details = await videosById(apiKey, found.ids);
    next = found.next;
  }
  const items = details.map(toItem);
  await Promise.all(items.map(keepItem));
  return { items: items.map(toPreview), next };
}

/**
 * A playlist or channel list that is gone or private, or a chart YouTube
 * keeps none of in a country: nothing to list, rather than a failure to
 * retry on every request.
 */
const isMissing = (err) => err.kind === "error" && [400, 403, 404].includes(err.status);

/**
 * What a page is fetched and kept with. `staleMs` is how much longer than
 * `freshMs` it is kept, when that is shorter than the cache's usual.
 * `types` are the kinds of video the row keeps to, when it must tell them
 * apart itself (typesToTell).
 */
function context(settings, source, freshMs, staleMs, types = null) {
  const user = keyId(settings.youtubeKey);
  return { apiKey: settings.youtubeKey, user, source, freshMs, staleMs, types, key: JSON.stringify({ user, source }) };
}

/**
 * Whether a kept page says each video's kind. Pages kept before kinds were
 * told say none, and a row that keeps to some kinds fetches such a page
 * anew, once, rather than let every video through as one.
 */
const toldKinds = (page) => page.items.every((item) => item.format);

/**
 * One upstream page of a catalog or search, from this reader's cache while
 * it is current. Page N is fetched with the token page N-1 ended with.
 */
function loadPage(ctx, index, pageToken) {
  const key = `${ctx.key}#${index}`;
  return joined(key, async () => {
    const hit = await browseCache.get(key);
    if (hit && hit.fresh && (!ctx.types || toldKinds(hit.value))) return hit.value;
    try {
      const page = await withKey(ctx.apiKey, () => fetchUpstream(ctx.source, ctx.apiKey, pageToken));
      await browseCache.set(key, page, ctx.freshMs, ctx.staleMs);
      return page;
    } catch (err) {
      if (hit) return hit.value;
      if (ctx.source.kind !== "search" && isMissing(err)) {
        const empty = { items: [], next: null };
        await browseCache.set(key, empty, ctx.freshMs, ctx.staleMs);
        return empty;
      }
      throw err;
    }
  });
}

const offsetOf = (skip) => Math.max(0, Math.floor(Number(skip) || 0));

/**
 * What a catalog's keyword filter looks in: the video's title, its channel's
 * name and, unless the filter's scope is the title only, its whole
 * description -- the page keeps only the start of a description, so a
 * longer one is read from the video's own cache entry, where it is whole.
 * Folded (text.js).
 */
async function filterText(item, scope) {
  if (scope === "title") return fold(`${item.title}\n${item.channelTitle}`);
  let { description } = item;
  if (description.length >= PREVIEW_DESCRIPTION) {
    const whole = await videoCache.get(item.id);
    if (whole) description = whole.value.description;
  }
  return fold(`${item.title}\n${item.channelTitle}\n${description}`);
}

/**
 * Whether a folded text mentions a filter word: as whole words, with an s
 * after them -- a plural, or a possessive, which folding writes the same
 * ("Kapoor's" is "kapoors") -- or run together, as a hashtag or a handle
 * writes a name (#GauravKapoor).
 */
function mentions(text, word) {
  const w = fold(word);
  return [w, `${w}s`, w.replace(/ /g, "")].some((form) => hasPhrase(text, form));
}

/** Whether a video is of a kind a row keeps to: null keeps all. */
function ofKind(item, types) {
  if (!types) return true;
  const type = VIDEO_TYPES.find((option) => option.format === (item.format || "video"));
  return types.includes(type.id);
}

/**
 * The kinds of video a row must tell apart itself, or null: none when it
 * keeps to every kind, nor when YouTube's own list of a channel's uploads
 * of one kind is read, which is exact where telling is not.
 */
function typesToTell(entry) {
  if (everyType(entry.types)) return null;
  if (entry.kind === "channel" && entry.types.length === 1) return null;
  return entry.types;
}

/** Whether a catalog's filter keeps the video: null keeps all. */
async function passes(item, filter) {
  if (!filter) return true;
  const text = await filterText(item, filter.scope);
  const mentioned = filter.words.some((word) => mentions(text, word));
  return filter.mode === "include" ? mentioned : !mentioned;
}

/**
 * The videos from `skip` on, within one upstream page: so an answer costs
 * at most one call to YouTube, which matters most for a search catalog,
 * whose page is a hundredth of the key's day.
 *
 * `skip` counts the videos already listed. Nuvio asks for the next page at
 * the number of videos it has, and Stremio at the steps the manifest
 * declares (catalogs.SKIP_OPTIONS); counting the videos actually offered,
 * rather than YouTube's positions, gives both the same unbroken sequence.
 */
async function assemble(ctx, skip, settings, filter = null) {
  const types = ctx.types;
  const offset = offsetOf(skip);
  const seen = new Set();
  let before = 0;
  let token;
  // A deep page is reached by walking the pages before it, each from the
  // cache while it is current. The filter is applied here, on the kept
  // pages, so changing it costs no call to YouTube.
  for (let index = 0; index < MAX_PAGES; index++) {
    const page = await loadPage(ctx, index, token);
    const items = [];
    for (const item of page.items) {
      if (seen.has(item.id) || !playable(item, settings) || !ofKind(item, types) || !(await passes(item, filter))) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (offset < before + items.length) return items.slice(offset - before, offset - before + PAGE_SIZE);
    before += items.length;
    if (!page.next) return [];
    token = page.next;
  }
  return [];
}

/** A page of one of the reader's catalogs, its kinds of video and keyword filter applied. */
function catalogItems({ entry, settings, skip }) {
  const freshMs = Math.min(refreshMs(settings.catalogRefresh), MAX_YOUTUBE_DATA_MS);
  return assemble(context(settings, sourceOf(entry, settings), freshMs, undefined, typesToTell(entry)), skip, settings, entry.filter);
}

/**
 * Worth searching YouTube for: three characters, or one in a script that
 * writes a word in one or two. Nuvio searches from the second keystroke,
 * and two letters find nothing anybody typed them for.
 */
function searchable(query) {
  return [...query].length >= (DENSE_SCRIPT.test(query) ? 1 : 3);
}

/**
 * Each reader's newest search: { ticket, q, at, slowest }, where `slowest`
 * is the longest gap between their letters in what they are typing, 0 when
 * this began it. Kept a minute, so that a search still waiting can always
 * see whether a newer one came after it.
 */
const latestSearch = new Map();
const LATEST_SEARCH_MS = 60 * 1000;
let tickets = 0;

function forgetOldSearches(now) {
  latestSearch.forEach((entry, user) => {
    if (now - entry.at > LATEST_SEARCH_MS) latestSearch.delete(user);
  });
}

/** The slowest gap between the reader's letters so far, or 0 when this search begins what they type. */
function slowestGap(user, q, now) {
  const previous = latestSearch.get(user);
  if (!previous) return 0;
  const gap = now - previous.at;
  const typed = q.toLowerCase();
  const before = previous.q.toLowerCase();
  if (gap >= TYPING_GAP_MS || !(typed.startsWith(before) || before.startsWith(typed))) return 0;
  return Math.max(previous.slowest, gap);
}

/** How long a search waits: a second, or longer while the reader is still typing it, the slower they type. */
function settleMsFor(slowest) {
  if (!slowest) return SEARCH_SETTLE_MS;
  return Math.min(Math.max(SEARCH_SETTLE_MS, slowest * 1.5 + 500), MAX_TYPING_SETTLE_MS);
}

/** Records a reader's newest search, whether or not it is long enough to make. */
function noteSearch(user, q, now) {
  forgetOldSearches(now);
  const entry = { ticket: ++tickets, q, at: now, slowest: slowestGap(user, q, now) };
  latestSearch.set(user, entry);
  return entry;
}

/**
 * Waits for the reader to stop typing. False when a newer, different search
 * from the same reader arrived meanwhile, or the app gave up on this one.
 */
async function settle(user, q, { waitMs, signal = requestSignal() } = {}) {
  const { ticket, slowest } = noteSearch(user, q, Date.now());
  await new Promise((resolve) => setTimeout(resolve, waitMs === undefined ? settleMsFor(slowest) : waitMs));
  const latest = latestSearch.get(user);
  const superseded = Boolean(latest) && latest.ticket !== ticket && latest.q !== q;
  return !superseded && !(signal && signal.aborted);
}

/**
 * YouTube's results for a search typed in the app, ranked as the reader
 * chose (YouTube's own ranking by default). `skipped` when there was
 * nothing to search yet, or the reader had moved on.
 */
async function searchItems({ query, settings, skip, settleOptions }) {
  const q = tidy(query, MAX_QUERY_LENGTH, { ellipsis: false });
  if (!searchable(q)) {
    // Nothing to search yet, but the reader is typing: the search their
    // next letter makes waits for them, and one still waiting gives way.
    if (q) noteSearch(keyId(settings.youtubeKey), q, Date.now());
    return { items: [], skipped: true };
  }
  const source = searchSource(q, { sort: settings.searchSort, length: settings.searchLength, within: "any" }, settings);
  const ctx = context(settings, source, SEARCH_REUSE_MS, SEARCH_STALE_MS);
  if (offsetOf(skip) === 0) {
    const hit = await browseCache.get(`${ctx.key}#0`);
    if (!(hit && hit.fresh) && !(await settle(ctx.user, q, settleOptions))) return { items: [], skipped: true };
  }
  return { items: await assemble(ctx, skip, settings), skipped: false };
}

/** A video kept by id for everyone: a day, or two minutes while it is live. */
function keepItem(item) {
  return videoCache.set(item.id, item, item.live === "live" ? LIVE_ITEM_MS : undefined);
}

/**
 * One video by id, for its metadata and streams: from the shared cache when
 * it is there, else one `videos.list` (1 unit). Null when YouTube has no
 * such video, or no longer has it.
 */
function getItem(videoId, apiKey) {
  return joined(`${keyId(apiKey)}:video:${videoId}`, async () => {
    const hit = await videoCache.get(videoId);
    if (hit && hit.fresh) return hit.value;
    try {
      const [detail] = await withKey(apiKey, () => videosById(apiKey, [videoId]));
      if (!detail) return null;
      const item = toItem(detail);
      await keepItem(item);
      return item;
    } catch (err) {
      if (hit) return hit.value;
      throw err;
    }
  });
}

const SOURCE_PROBLEMS = {
  quota: "Your YouTube key has spent today's quota, so this cannot be looked up until it refills at midnight Pacific time.",
  rate: "YouTube asked to slow down. Try again in a minute.",
  invalid: "YouTube says your API key is not valid. Check it above.",
  disabled: "Your key's Google Cloud project does not have the YouTube Data API v3 enabled.",
  restricted: "Your key is restricted to certain websites, apps or addresses, so this server cannot use it.",
  unavailable: "YouTube could not be reached. Try again in a moment."
};

/**
 * A playlist or a channel the reader pasted, a link, @handle or id, looked
 * up so its catalog can be added: { entry } or { error }. `kind` is the
 * source they chose, "playlist" or "channel". Costs the reader 1 unit.
 */
async function resolveSource(apiKey, input, kind) {
  const link = parseSourceLink(input, kind);
  if (link.error) return { error: link.error };
  try {
    if (link.playlistId) {
      const list = await withKey(apiKey, () => findPlaylist(apiKey, link.playlistId));
      const entry = list && normalizeEntry({ playlist: list.id, name: list.title });
      return entry ? { entry } : { error: "YouTube has no public playlist at that link." };
    }
    const channel = await withKey(apiKey, () => findChannel(apiKey, link));
    const entry = channel && normalizeEntry({ channel: channel.id, name: channel.title });
    return entry ? { entry } : { error: "YouTube has no channel at that link." };
  } catch (err) {
    return { error: SOURCE_PROBLEMS[err.kind] || `YouTube could not look that up: ${err.message}` };
  }
}

module.exports = {
  passes,
  mentions,
  ofKind,
  typesToTell,
  catalogItems,
  searchItems,
  getItem,
  resolveSource,
  sourceOf,
  playable,
  publishedAfter,
  searchable,
  settle,
  slowestGap,
  settleMsFor,
  assemble,
  context,
  latestSearch,
  inFlight,
  SEARCH_SETTLE_MS,
  TYPING_GAP_MS,
  MAX_TYPING_SETTLE_MS,
  SEARCH_REUSE_MS,
  SEARCH_STALE_MS,
  LIVE_ITEM_MS
};
