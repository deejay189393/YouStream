const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { buildInterfaceManifest } = require("./manifest");
const { normalizeConfig } = require("./config");
const { findVideos } = require("./finder");
const { toStreams } = require("./streams");
const { hostConfig } = require("./hostConfig");
const { searchMsFor } = require("./cache");

/**
 * The stream handler, wired into the official stremio-addon-sdk router so
 * request parsing, the config path segment, CORS and cache headers all follow
 * the addon protocol rather than a hand-rolled copy of it.
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

async function handleStream({ id, config }) {
  const settings = normalizeConfig(config);
  if (!settings.youtubeKey) return { streams: [] };

  const result = await findVideos(id, settings);
  logResult(id, result);

  const streams = result.status === "ok" ? toStreams(result.matches, settings) : [];
  return { streams, cacheMaxAge: maxAgeFor(result, streams) };
}

function createAddonInterface() {
  const builder = new addonBuilder(buildInterfaceManifest());
  builder.defineStreamHandler(handleStream);
  return builder.getInterface();
}

function createResourceRouter() {
  return getRouter(createAddonInterface());
}

module.exports = { createAddonInterface, createResourceRouter, handleStream, logResult, maxAgeFor };
