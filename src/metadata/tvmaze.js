const { getJson, runtimeSeconds } = require("./http");

/**
 * TVmaze: a free, keyless TV database with each episode's own runtime --
 * which is what lets an episode be matched to the minute without a TMDB key.
 *
 * Its runtimes are only trusted where they vary within a season. Measured:
 * a season whose every episode lists the same runtime is listing the
 * broadcast slot, not the episode (Mr. Bean "30" for episodes that run 25,
 * Breaking Bad "60" for 47), while varied ones were within a minute of the
 * real episodes (Aspirants: 46, 38, 46, 49, 38 for 46:17, 39:01, 45:37,
 * 48:54, 39:10).
 */
const BASE_URL = "https://api.tvmaze.com";

/** The show's TVmaze id from its IMDb id, or null. */
async function showId(imdbId) {
  const body = await getJson(`${BASE_URL}/lookup/shows?imdb=${imdbId}`);
  return body && Number.isInteger(body.id) ? body.id : null;
}

/** Whether a season's listed runtimes say anything about each episode. */
function variesWithinSeason(episodes) {
  const runtimes = new Set(episodes.map((e) => e.runtime).filter((r) => Number.isFinite(r) && r > 0));
  return runtimes.size >= 2;
}

/**
 * One episode's own runtime, or null when TVmaze does not know it -- or
 * knows only the slot it airs in.
 */
async function episodeRuntime(imdbId, season, episodeNumber) {
  const id = await showId(imdbId);
  if (!id) return null;
  const body = await getJson(`${BASE_URL}/shows/${id}/episodes`);
  const all = Array.isArray(body) ? body.filter((e) => e && typeof e === "object") : [];
  const inSeason = all.filter((e) => e.season === season);
  const match = inSeason.find((e) => e.number === episodeNumber);
  if (!match || !variesWithinSeason(inSeason)) return null;
  return runtimeSeconds(match.runtime);
}

module.exports = { showId, episodeRuntime, variesWithinSeason, BASE_URL };
