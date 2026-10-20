const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { buildInterfaceManifest, SEARCH_CATALOG_ID } = require("./manifest");
const { normalizeConfig, refreshMs } = require("./config");
const { findVideos, isBlocked } = require("./finder");
const { toStreams, toItemStreams } = require("./streams");
const { hostConfig } = require("./hostConfig");
const { searchMsFor } = require("./cache");
const { catalogItems, searchItems, getItem } = require("./browse");
const { ITEM_TYPE, videoIdOf, toMetaPreview, toFullMeta } = require("./items");

/**
 * The catalog, meta and stream handlers, wired into the official
 * stremio-addon-sdk router so request parsing, the config path segment, CORS
 * and cache headers all follow the addon protocol rather than a hand-rolled
 * copy of it.
 *
 * The SDK hands the config over as whatever JSON the URL carried (or `false`
 * when it was not JSON), so it is normalized here before anything reads it.
 */

/**
 * How long an app may reuse an answer (see hostConfig.js). Matches are
 * stable, so a list with videos in it is kept for hours. An empty list is
 * kept shorter, in case a title's upload is simply newer than the search --
 * and for a recent release no longer than the server keeps its search. An
 * answer from an out-of-date search stood in for a failure, so it is asked
 * for again as soon as an empty one; a failure is retried in a minute.
 */
function maxAgeFor(result, streams, streamsConfig = hostConfig.streams) {
  if (result.status === "search failed") return streamsConfig.failedMaxAgeSeconds;
  if (streams.length && !result.stale) return streamsConfig.maxAgeSeconds;
  if (!result.title) return streamsConfig.emptyMaxAgeSeconds;
  return Math.min(streamsConfig.emptyMaxAgeSeconds, Math.round(searchMsFor(result.title) / 1000));
}

/** One line per lookup, so the logs show what was searched and why videos lost. */
function logResult(id, result) {
  if (result.status !== "ok") {
    const detail = result.error ? `: ${result.error.kind} -- ${result.error.message}` : "";
    console.log(`[stream] ${id} ${result.status}${detail}`);
    return;
  }
  const reasons = {};
  result.evaluations.forEach((e) => {
    if (!e.ok) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  });
  const rejected = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  console.log(
    `[stream] ${id} "${result.query}" ${result.evaluations.length} results${
      result.stale ? ` (cached; YouTube failed: ${result.stale})` : result.cached ? " (cached)" : ""
    } -> ${
      result.matches.length
    } matches${rejected ? `; rejected: ${rejected}` : ""}`
  );
}

/** Retried a minute later: a failure, or a search the reader had already moved past. */
const RETRY_SECONDS = 60;
/** A search's results, which the app may reuse briefly: going back, scrolling again. */
const SEARCH_MAX_AGE_SECONDS = 60;
/** At most an hour, whatever the reader's refresh interval: the server's cache is what keeps it. */
const MAX_CATALOG_AGE_SECONDS = 60 * 60;
/** A video's details change little: its view count. */
const META_MAX_AGE_SECONDS = 6 * 60 * 60;

/** What an id that is not a YouTube item, or a video that is gone, answers: 404. */
function notFound() {
  const err = new Error("Not found");
  // The SDK's router passes such a request on rather than answering 500,
  // and server.js answers it 404 -- which Nuvio takes as final.
  err.noHandler = true;
  return err;
}

async function handleStream({ id, config }) {
  const settings = normalizeConfig(config);
  if (!settings.youtubeKey) return { streams: [] };

  const videoId = videoIdOf(id);
  if (videoId) return itemStreams(videoId, settings);

  const result = await findVideos(id, settings);
  logResult(id, result);

  const streams = result.status === "ok" ? toStreams(result.matches, settings, result.title) : [];
  return { streams, cacheMaxAge: maxAgeFor(result, streams) };
}

/** The rows for a YouTube video opened from a catalog, search or the library. */
async function itemStreams(videoId, settings) {
  let item;
  try {
    item = await getItem(videoId, settings.youtubeKey);
  } catch (err) {
    console.log(`[stream] video ${videoId} failed: ${err.kind} -- ${err.message}`);
    return { streams: [], cacheMaxAge: RETRY_SECONDS };
  }
  if (!item || isBlocked(item)) return { streams: [], cacheMaxAge: hostConfig.streams.emptyMaxAgeSeconds };
  return { streams: toItemStreams(item, settings), cacheMaxAge: hostConfig.streams.maxAgeSeconds };
}

/**
 * A row of the reader's catalog, or the search row. An empty list rather
 * than an error when YouTube cannot answer, so a spent quota leaves an empty
 * row rather than a broken addon.
 */
async function handleCatalog({ type, id, extra, config }) {
  const settings = normalizeConfig(config);
  if (!settings.youtubeKey || type !== ITEM_TYPE) return { metas: [] };
  const skip = extra && extra.skip;
  try {
    if (id === SEARCH_CATALOG_ID) {
      if (!settings.search) return { metas: [] };
      const result = await searchItems({ query: extra && extra.search, settings, skip });
      return {
        metas: result.items.map(toMetaPreview),
        cacheMaxAge: result.skipped ? 0 : SEARCH_MAX_AGE_SECONDS
      };
    }
    // Only the reader's own catalogs: another install's ids mean nothing
    // here, so the addon is no open proxy for YouTube searches.
    const entry = settings.catalogs.find((c) => c.id === id);
    if (!entry) return { metas: [] };
    const items = await catalogItems({ entry, settings, skip });
    return {
      metas: items.map(toMetaPreview),
      cacheMaxAge: Math.min(Math.round(refreshMs(settings.catalogRefresh) / 1000), MAX_CATALOG_AGE_SECONDS)
    };
  } catch (err) {
    console.log(`[catalog] ${id === SEARCH_CATALOG_ID ? "search" : id} failed: ${err.kind} -- ${err.message}`);
    return { metas: [], cacheMaxAge: RETRY_SECONDS };
  }
}

/**
 * A YouTube video's details, for its page and for an app's library, however
 * long after it was saved. A video YouTube no longer has is a 404; YouTube
 * failing to answer is an error, which the app asks again about.
 */
async function handleMeta({ type, id, config }) {
  const settings = normalizeConfig(config);
  const videoId = videoIdOf(id);
  if (!settings.youtubeKey || type !== ITEM_TYPE || !videoId) throw notFound();
  const item = await getItem(videoId, settings.youtubeKey);
  if (!item || isBlocked(item)) throw notFound();
  return { meta: toFullMeta(item), cacheMaxAge: META_MAX_AGE_SECONDS };
}

function createAddonInterface() {
  const builder = new addonBuilder(buildInterfaceManifest());
  builder.defineCatalogHandler(handleCatalog);
  builder.defineMetaHandler(handleMeta);
  builder.defineStreamHandler(handleStream);
  return builder.getInterface();
}

function createResourceRouter() {
  return getRouter(createAddonInterface());
}

module.exports = {
  createAddonInterface,
  createResourceRouter,
  handleStream,
  handleCatalog,
  handleMeta,
  logResult,
  maxAgeFor
};
