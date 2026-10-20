const { externalUrlFor } = require("./playback");
const { streamScope, renderStreamText } = require("./streamFormat");
const { identity } = require("./manifest");

/**
 * Stream rows for the matched videos: for each video, best first, one row per
 * way of watching the reader turned on, in their order. The first row is the
 * best match played the reader's preferred way, which is what an app's
 * autoplay picks.
 *
 * The protocol draws the line that matters here: `ytId` plays in the app's
 * own player, `externalUrl` is handed to the device to open. What each row
 * says comes from the reader's templates (streamFormat.js).
 */

/**
 * @param {string} optionId  app | youtube | smarttube
 * @param {object} match     from matching.js, or { video } for a YouTube item
 * @param {object} context   { title: what the stream was found for -- null for
 *                           a YouTube video opened as an item -- and settings }
 */
function buildStream(optionId, match, { title, settings }) {
  const { video } = match;
  const scope = streamScope({ optionId, match, title, settings, addonName: identity().name });
  const { name, description } = renderStreamText(scope, settings);

  const stream = {
    name,
    title: description,
    description,
    behaviorHints: {
      // Lets an app's next-episode autoplay pick the same way of watching
      // from the same channel, rather than whatever happens to rank first.
      bingeGroup: `youstream-${optionId}${video.channelId ? `-${video.channelId}` : ""}`,
      // Read by AIOStreams before anything in the text; Stremio passes the
      // filename to subtitle addons and ignores the rest.
      filename: scope.stream.filename,
      // A live stream has no length yet.
      ...(scope.stream.duration ? { duration: video.durationSeconds } : {}),
      ...(video.publishedAt ? { publishDate: video.publishedAt } : {}),
      indexer: "YouTube"
    }
  };

  const external = externalUrlFor(optionId, video.id);
  if (external) stream.externalUrl = external;
  // Nothing but the id: an app resolves a `ytId` itself only when the
  // stream has no `url` or `externalUrl` it could use instead.
  else stream.ytId = video.id;
  return stream;
}

/**
 * Age-restricted videos only play for a signed-in viewer, which an app's own
 * player is not, so they get no in-app row. If the reader has in-app as their
 * only option, such a video gets a YouTube-app row instead of none at all.
 */
function optionsFor(match, playback) {
  if (!match.video.ageRestricted) return playback;
  const external = playback.filter((id) => id !== "app");
  return external.length ? external : ["youtube"];
}

function toStreams(matches, settings, title) {
  return matches.flatMap((match) => optionsFor(match, settings.playback).map((id) => buildStream(id, match, { title, settings })));
}

/** The rows for a YouTube video opened as an item of its own (items.js). */
function toItemStreams(item, settings) {
  const match = { video: item };
  return optionsFor(match, settings.playback).map((id) => buildStream(id, match, { title: null, settings }));
}

module.exports = { toStreams, toItemStreams, buildStream, optionsFor };
