const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { buildInterfaceManifest } = require("./manifest");
const { normalizeConfig } = require("./config");
const { findVideos } = require("./finder");
const { toStreams } = require("./streams");

/**
 * The stream handler, wired into the official stremio-addon-sdk router so
 * request parsing, the config path segment, CORS and cache headers all follow
 * the addon protocol rather than a hand-rolled copy of it.
 *
 * The SDK hands the config over as whatever JSON the URL carried (or `false`
 * when it was not JSON), so it is normalized here before anything reads it.
 */

const HOUR = 60 * 60;

/**
 * How long an app may reuse an answer. Matches are stable, so a found video
 * is kept for hours; "nothing found" is kept shorter, in case a title's
 * upload is simply newer than the search; a failure is retried soon.
 */
const CACHE_SECONDS = {
  found: 6 * HOUR,
  none: HOUR,
  failed: 60
};

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
    `[stream] ${id} "${result.query}" ${result.evaluations.length} results${result.cached ? " (cached)" : ""} -> ${
      result.matches.length
    } matches${rejected ? `; rejected: ${rejected}` : ""}`
  );
}

async function handleStream({ id, config }) {
  const settings = normalizeConfig(config);
  if (!settings.youtubeKey) return { streams: [] };

  const result = await findVideos(id, settings);
  logResult(id, result);

  if (result.status === "search failed") return { streams: [], cacheMaxAge: CACHE_SECONDS.failed };
  if (result.status !== "ok") return { streams: [], cacheMaxAge: CACHE_SECONDS.none };

  const streams = toStreams(result.matches, settings);
  return { streams, cacheMaxAge: streams.length ? CACHE_SECONDS.found : CACHE_SECONDS.none };
}

function createAddonInterface() {
  const builder = new addonBuilder(buildInterfaceManifest());
  builder.defineStreamHandler(handleStream);
  return builder.getInterface();
}

function createResourceRouter() {
  return getRouter(createAddonInterface());
}

module.exports = { createAddonInterface, createResourceRouter, handleStream, logResult, CACHE_SECONDS };
