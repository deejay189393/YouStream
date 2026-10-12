const { getJson, dateOf, runtimeSeconds } = require("./http");
const { hostConfig } = require("../hostConfig");

/**
 * TheTVDB, for episodes: each one's own runtime and air date.
 *
 * Cinemeta's episode lists are TheTVDB's -- every episode it lists carries
 * its TheTVDB id -- so the season and episode in an app's id are TheTVDB's
 * numbering, and an episode is looked up here by the very id Cinemeta gives
 * it: never another episode by mistake. (tmdb: ids are numbered by TMDB,
 * which can differ, so they are not looked up here.)
 *
 * A runtime is the episode's own only where the season's runtimes vary. A
 * number copied onto every episode of a season is the broadcast slot, not
 * the episode -- TVmaze lists every episode of 24 at 60 minutes; they run 41
 * -- and is used as the show's usual length instead, with its wider margin.
 *
 * Needs the host's own key (TVDB_API_KEY; TVDB_PIN for a subscriber-
 * supported key). TheTVDB's terms ask for a credit with a link to
 * thetvdb.com, which the configure page shows.
 */
const BASE_URL = "https://api4.thetvdb.com/v4";
const TIMEOUT_MS = 8000;
// TheTVDB's tokens last a month; renewed well before.
const TOKEN_MS = 25 * 24 * 60 * 60 * 1000;

let session = null;

/** The host's key, or null when this server has none. */
function credentials(metadata = hostConfig.metadata) {
  return metadata.tvdbKey ? { key: metadata.tvdbKey, pin: metadata.tvdbPin } : null;
}

async function login({ key, pin }) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pin ? { apikey: key, pin } : { apikey: key }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw new Error(`Could not reach TheTVDB: ${err.message}`);
  }
  const body = await response.json().catch(() => null);
  const token = body && body.data && body.data.token;
  if (!response.ok || typeof token !== "string") {
    const err = new Error(`TheTVDB refused the key (HTTP ${response.status})`);
    err.status = response.status;
    throw err;
  }
  return token;
}

async function tokenFor(creds) {
  if (session && session.key === creds.key && Date.now() < session.expires) return session.token;
  const token = await login(creds);
  session = { key: creds.key, token, expires: Date.now() + TOKEN_MS };
  return token;
}

/**
 * GET a path with a token, logging in again once if TheTVDB says the token
 * has expired. Cached by URL, without the token.
 */
async function request(creds, path) {
  const get = async () =>
    getJson(`${BASE_URL}${path}`, { headers: { authorization: `Bearer ${await tokenFor(creds)}` } });
  try {
    return await get();
  } catch (err) {
    if (err.status !== 401) throw err;
    session = null;
    return get();
  }
}

function toEpisode(e) {
  return {
    episodeTitle: typeof e.name === "string" && e.name.trim() ? e.name.trim() : null,
    released: dateOf(e.aired),
    runtimeSeconds: runtimeSeconds(e.runtime)
  };
}

/**
 * One episode, from its season's listing in TheTVDB's default order, found
 * by its TheTVDB id when Cinemeta gave one and by its number otherwise.
 * Fetched as the whole season, so the next episode is already cached and
 * the season's runtimes can be compared.
 *
 * @returns {Promise<{ episodeTitle, released, runtimeSeconds, runtimeKind } | null>}
 *   runtimeKind "exact" when the season's
 *   runtimes vary, "typical" when one number is copied onto all of them
 */
async function episodeInSeason(creds, seriesId, season, number, episodeId = null) {
  const body = await request(creds, `/series/${seriesId}/episodes/default?page=0&season=${season}`);
  const episodes = body && body.data && Array.isArray(body.data.episodes) ? body.data.episodes.filter((e) => e && typeof e === "object") : [];
  const match =
    (episodeId && episodes.find((e) => String(e.id) === String(episodeId))) ||
    episodes.find((e) => e.seasonNumber === season && e.number === number);
  if (!match) return null;
  const varies = new Set(episodes.map((e) => e.runtime).filter((r) => Number.isFinite(r) && r > 0)).size >= 2;
  return { ...toEpisode(match), runtimeKind: varies ? "exact" : "typical" };
}

/**
 * One episode by its TheTVDB id alone, for one beyond the first page of a
 * long season. Its runtime cannot be compared with the season's, so it
 * counts only as the usual length.
 */
async function episodeById(creds, episodeId) {
  const body = await request(creds, `/episodes/${episodeId}`);
  const e = body && body.data;
  if (!e || typeof e !== "object") return null;
  return { ...toEpisode(e), runtimeKind: "typical" };
}

/** For tests: forget the token. */
function resetSession() {
  session = null;
}

module.exports = { credentials, episodeInSeason, episodeById, login, resetSession, BASE_URL, TOKEN_MS };
