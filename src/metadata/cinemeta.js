const { getJson, yearOf, dateOf, runtimeSeconds } = require("./http");

/**
 * Cinemeta: Stremio's own metadata addon, keyed by IMDb id and free to use.
 *
 * For a film it carries the name, the year and IMDb's runtime ("142 min").
 * For a show it carries the name, a single typical episode length, and every
 * episode's name and season -- but not each episode's own length, which is
 * why TMDB is asked as well when a key is available.
 *
 * It also carries the TMDB id (`moviedb_id`), which saves a lookup there.
 */
const BASE_URL = "https://v3-cinemeta.strem.io/meta";

async function fetchMeta(type, imdbId) {
  const body = await getJson(`${BASE_URL}/${type}/${imdbId}.json`);
  const meta = body && body.meta;
  return meta && typeof meta === "object" && typeof meta.name === "string" && meta.name ? meta : null;
}

/** A numeric id as Cinemeta gives it (a number, or digits), as a string. */
function idOf(value) {
  return /^\d+$/.test(String(value)) ? String(value) : null;
}

/** The credited people Cinemeta lists: its top-billed cast and the directors. */
function peopleOf(meta) {
  const names = [...(Array.isArray(meta.cast) ? meta.cast : []), ...(Array.isArray(meta.director) ? meta.director : [])];
  return [...new Set(names.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()))];
}

async function movie(imdbId) {
  const meta = await fetchMeta("movie", imdbId);
  if (!meta) return null;
  return {
    title: meta.name,
    people: peopleOf(meta),
    year: yearOf(meta.year || meta.releaseInfo || meta.released),
    released: dateOf(meta.released),
    runtimeSeconds: runtimeSeconds(meta.runtime),
    tmdbId: Number.isInteger(meta.moviedb_id) ? String(meta.moviedb_id) : null
  };
}

/**
 * Episodes are numbered within their season, but uploads are often numbered
 * across the whole show ("Episode 15" for season 2, episode 5). This counts
 * the regular episodes of every earlier season. Specials (season 0) never
 * count.
 */
function absoluteEpisode(videos, season, episode) {
  if (season < 1) return null;
  const earlier = videos.filter((v) => Number(v.season) >= 1 && Number(v.season) < season).length;
  return earlier + episode;
}

async function episode(imdbId, season, episodeNumber) {
  const meta = await fetchMeta("series", imdbId);
  if (!meta) return null;
  const videos = Array.isArray(meta.videos) ? meta.videos.filter((v) => v && typeof v === "object") : [];
  const match = videos.find(
    (v) => Number(v.season) === season && Number(v.episode !== undefined ? v.episode : v.number) === episodeNumber
  );
  const seasons = new Set(videos.map((v) => Number(v.season)).filter((s) => s >= 1));
  return {
    title: meta.name,
    people: peopleOf(meta),
    year: yearOf(meta.year || meta.releaseInfo || meta.released),
    typicalRuntimeSeconds: runtimeSeconds(meta.runtime),
    episodeTitle: match && typeof (match.name || match.title) === "string" ? match.name || match.title : null,
    released: match ? dateOf(match.released || match.firstAired) : null,
    absoluteEpisode: absoluteEpisode(videos, season, episodeNumber),
    seasonCount: seasons.size || null,
    tmdbId: Number.isInteger(meta.moviedb_id) ? String(meta.moviedb_id) : null,
    // Cinemeta's episodes are TheTVDB's, each with its TheTVDB id.
    tvdbId: idOf(meta.tvdb_id),
    tvdbEpisodeId: match ? idOf(match.tvdb_id) : null
  };
}

module.exports = { movie, episode, absoluteEpisode, peopleOf, BASE_URL };
