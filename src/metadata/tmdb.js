const { getJson, yearOf, runtimeSeconds } = require("./http");

/**
 * TMDB: optional, but it is what turns "about 51 minutes" into "this episode
 * runs 38". Cinemeta has one typical length for a whole show; TMDB has each
 * episode's own, which is what lets the episode margin be tight. It is also
 * the only way to read a `tmdb:` id at all, and it knows a title's original
 * name and its other release names, which widens what counts as a match.
 *
 * A key comes from the reader's own config or, failing that, the server's
 * TMDB_API_KEY. Both kinds TMDB issues work: the short v3 "API key" goes in
 * the query string, the long v4 "read access token" (a JWT, so it starts
 * "eyJ") in an Authorization header.
 */
const BASE_URL = "https://api.themoviedb.org/3";

/** How many of a title's other names are kept for matching. */
const MAX_ALIASES = 8;

function isBearerToken(key) {
  return key.startsWith("eyJ");
}

function request(key, path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  // The cache key never contains the credential, so it is safe to share and
  // the same title is fetched once whoever's key asked first.
  const cacheKey = `tmdb:${url.pathname}${url.search}`;
  const headers = { accept: "application/json" };
  if (isBearerToken(key)) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  return getJson(url.toString(), { cacheKey, headers });
}

/** The TMDB film or show an IMDb id belongs to. */
async function findByImdb(key, imdbId) {
  const body = await request(key, `/find/${imdbId}`, { external_source: "imdb_id" });
  const first = (list) => (Array.isArray(list) && list[0] && Number.isInteger(list[0].id) ? String(list[0].id) : null);
  return { movieId: first(body && body.movie_results), tvId: first(body && body.tv_results) };
}

/**
 * The other names a title is released under, for the reader's own country
 * first, then the two largest English-language markets. The original-language
 * name is added by the caller, because it is the one most often used by an
 * uploader writing in that language.
 */
function aliasesFrom(list, region) {
  if (!Array.isArray(list)) return [];
  const wanted = [region, "US", "GB"].filter(Boolean);
  const names = [];
  wanted.forEach((country) => {
    list.forEach((entry) => {
      if (entry && entry.iso_3166_1 === country && typeof entry.title === "string" && entry.title.trim()) {
        names.push(entry.title.trim());
      }
    });
  });
  return [...new Set(names)].slice(0, MAX_ALIASES);
}

async function movie(key, tmdbId, region) {
  const body = await request(key, `/movie/${tmdbId}`, { append_to_response: "alternative_titles,external_ids" });
  if (!body || typeof body.title !== "string" || !body.title) return null;
  const alternative = body.alternative_titles && body.alternative_titles.titles;
  return {
    title: body.title,
    originalTitle: typeof body.original_title === "string" ? body.original_title : null,
    year: yearOf(body.release_date),
    runtimeSeconds: runtimeSeconds(body.runtime),
    aliases: aliasesFrom(alternative, region),
    imdbId: body.external_ids && typeof body.external_ids.imdb_id === "string" ? body.external_ids.imdb_id : null
  };
}

async function show(key, tvId, region) {
  const body = await request(key, `/tv/${tvId}`, { append_to_response: "alternative_titles,external_ids" });
  if (!body || typeof body.name !== "string" || !body.name) return null;
  const alternative = body.alternative_titles && body.alternative_titles.results;
  const runTimes = Array.isArray(body.episode_run_time) ? body.episode_run_time : [];
  const seasons = Array.isArray(body.seasons)
    ? body.seasons
        .filter((s) => s && Number.isInteger(s.season_number) && Number.isInteger(s.episode_count))
        .map((s) => ({ season: s.season_number, episodes: s.episode_count }))
    : [];
  return {
    title: body.name,
    originalTitle: typeof body.original_name === "string" ? body.original_name : null,
    year: yearOf(body.first_air_date),
    typicalRuntimeSeconds: runtimeSeconds(runTimes[0]),
    aliases: aliasesFrom(alternative, region),
    seasons,
    imdbId: body.external_ids && typeof body.external_ids.imdb_id === "string" ? body.external_ids.imdb_id : null
  };
}

/**
 * One episode's own name and length. Fetched as the whole season, so the
 * next episode someone watches is already cached.
 */
async function episode(key, tvId, season, episodeNumber) {
  const body = await request(key, `/tv/${tvId}/season/${season}`);
  const episodes = body && Array.isArray(body.episodes) ? body.episodes : [];
  const match = episodes.find((e) => e && e.episode_number === episodeNumber);
  if (!match) return null;
  return {
    episodeTitle: typeof match.name === "string" && match.name ? match.name : null,
    runtimeSeconds: runtimeSeconds(match.runtime)
  };
}

/** The same count Cinemeta's absolute numbering gives, from TMDB's seasons. */
function absoluteEpisode(seasons, season, episodeNumber) {
  if (season < 1) return null;
  return seasons.filter((s) => s.season >= 1 && s.season < season).reduce((n, s) => n + s.episodes, 0) + episodeNumber;
}

/** A cheap call that only succeeds with a working key, for the configure page. */
async function checkKey(key) {
  const url = new URL(`${BASE_URL}/configuration`);
  const headers = { accept: "application/json" };
  if (isBearerToken(key)) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  let response;
  try {
    response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(8000) });
  } catch (_) {
    return "unreachable";
  }
  if (response.ok) return "ok";
  return response.status === 401 ? "invalid" : "unreachable";
}

module.exports = { findByImdb, movie, show, episode, absoluteEpisode, aliasesFrom, checkKey, isBearerToken, BASE_URL };
