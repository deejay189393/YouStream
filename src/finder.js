const { parseStreamId, contentKind } = require("./ids");
const { resolveTitle } = require("./metadata");
const { searchVideos } = require("./youtube");
const { durationWindow, searchDuration, evaluate, rankMatches } = require("./matching");
const { effectiveTmdbKey } = require("./config");
const { languageName } = require("./regions");

/**
 * From a stream id to the YouTube videos that are that film or episode:
 *
 *   id -> what it is (title, year, runtime, episode)    metadata/
 *      -> one YouTube search, of the right length        youtube.js
 *      -> every result judged, the matches ranked        matching.js
 */

const pad = (n) => String(n).padStart(2, "0");

/**
 * The search text, from the reader's template. Placeholders:
 *
 *   {title} {year} {season} {episode} {s00e00} {episodeTitle} {absolute}
 *   {language}  the reader's audio language by name ("Hindi"), or nothing
 *
 * A placeholder with nothing to fill it is dropped, along with the space it
 * leaves.
 */
function buildQuery(title, settings) {
  const template = title.isEpisode ? settings.episodeQuery : settings.movieQuery;
  const values = {
    title: title.title,
    year: title.year,
    season: title.season,
    episode: title.episode,
    s00e00: title.isEpisode ? `S${pad(title.season)}E${pad(title.episode)}` : null,
    episodeTitle: title.episodeTitle,
    absolute: title.absoluteEpisode,
    language: languageName(settings.audioLanguage)
  };
  const query = template
    .replace(/\{(\w+)\}/g, (whole, name) =>
      Object.hasOwn(values, name) ? (values[name] === null || values[name] === undefined ? "" : String(values[name])) : whole
    )
    .replace(/\s+/g, " ")
    .trim();
  return query || title.title;
}

/**
 * Everything learned on the way, so the stream handler can answer and the
 * explain endpoint can show its working.
 *
 * @returns {Promise<{ status: string, parsed?, title?, window?, query?,
 *   evaluations?: object[], matches?: object[], error? }>}
 */
async function findVideos(rawId, settings) {
  const parsed = parseStreamId(rawId);
  if (!parsed) return { status: "unsupported id" };
  if (!settings.types.includes(contentKind(parsed))) return { status: "type switched off", parsed };

  const title = await resolveTitle(parsed, { tmdbKey: effectiveTmdbKey(settings), region: settings.region });
  if (!title) return { status: "unknown title", parsed };

  const window = durationWindow(title, settings);
  const query = buildQuery(title, settings);

  let videos;
  let cached;
  try {
    ({ videos, cached } = await searchVideos({
      apiKey: settings.youtubeKey,
      q: query,
      regionCode: settings.region || undefined,
      relevanceLanguage: settings.audioLanguage || undefined,
      videoDuration: searchDuration(window),
      embeddableOnly: settings.embeddableOnly
    }));
  } catch (err) {
    return { status: "search failed", parsed, title, window, query, error: { kind: err.kind, message: err.message } };
  }

  const evaluations = videos.map((video) => evaluate(video, title, window, settings));
  const matches = rankMatches(evaluations).slice(0, settings.maxResults);
  return { status: "ok", parsed, title, window, query, cached, evaluations, matches };
}

module.exports = { findVideos, buildQuery };
