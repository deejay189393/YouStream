const { externalUrlFor, OPTIONS_BY_ID } = require("./playback");
const { formatDuration, formatOffset, formatCount } = require("./text");
const { languageName } = require("./regions");

/**
 * Stream rows for the matched videos: for each video, best first, one row per
 * way of watching the reader turned on, in their order. The first row is the
 * best match played the reader's preferred way, which is what an app's
 * autoplay picks.
 *
 * The protocol draws the line that matters here: `ytId` plays in the app's
 * own player, `externalUrl` is handed to the device to open.
 */

const ADDON_NAME = "YouStream";
const ICONS = { app: "▶️", youtube: "📱", smarttube: "📺" };

function detailLine(match) {
  const { video } = match;
  const parts = [`⏱ ${formatDuration(video.durationSeconds)}`];
  if (match.offsetSeconds !== null && match.offsetSeconds !== undefined) parts[0] += ` (${formatOffset(match.offsetSeconds)})`;
  const views = formatCount(video.views);
  if (views) parts.push(`👁 ${views}`);
  const language = languageName(video.language);
  if (language) parts.push(`🗣 ${language}`);
  return parts.join("  ");
}

function buildStream(optionId, match) {
  const { video } = match;
  const option = OPTIONS_BY_ID.get(optionId);
  const lines = [`${ICONS[optionId]} ${option.short}`, video.title, `📺 ${video.channelTitle || "YouTube"}`, detailLine(match)];
  if (video.ageRestricted) lines.push("🔞 Age-restricted: opens in YouTube, where you are signed in");
  const description = lines.join("\n");

  const stream = {
    name: `${ADDON_NAME}\n${video.definition === "hd" ? "HD" : "SD"}`,
    title: description,
    description,
    behaviorHints: {
      // Lets an app's next-episode autoplay pick the same way of watching
      // from the same channel, rather than whatever happens to rank first.
      bingeGroup: `youstream-${optionId}${video.channelId ? `-${video.channelId}` : ""}`
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

function toStreams(matches, settings) {
  return matches.flatMap((match) => optionsFor(match, settings.playback).map((id) => buildStream(id, match)));
}

module.exports = { toStreams, buildStream, optionsFor, detailLine, ADDON_NAME };
