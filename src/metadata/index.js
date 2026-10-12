const cinemeta = require("./cinemeta");
const tmdb = require("./tmdb");
const kitsu = require("./kitsu");
const tvmaze = require("./tvmaze");
const imdb = require("./imdb");
const tvdb = require("./tvdb");
const { tokens } = require("../text");
const { yearOf } = require("./http");

/**
 * What a stream id refers to, in the terms a YouTube search needs:
 *
 *   {
 *     isEpisode, title, aliases, year,
 *     people,                  // credited cast and directors, for evidence
 *     imdbId,                  // for matching IMDb links in descriptions
 *     runtimeSeconds,          // the length a match has to be close to
 *     otherRuntimes,           // what other sources list, when they differ
 *     runtimeKind,             // "exact": this film's or episode's own length
 *                              // "typical": only the show's usual length
 *                              // null: nothing listed anywhere
 *     released,                // "2021-04-07": the film's release or the
 *                              // episode's first airing, when listed
 *     releaseYear,             // episodes: the year of `released`
 *     season, episode, absoluteEpisode, episodeTitle, seasonCount,
 *     sources                  // which services answered, for the logs
 *   }
 *
 * Each service is asked for what it is best at, and a service that is down
 * costs only what it would have added: a film still resolves from Cinemeta
 * when TMDB is unreachable, and from TMDB when Cinemeta is.
 *
 * A film's runtime is IMDb's own (see imdb.js), with Cinemeta's and TMDB's
 * accepted alongside where they differ. An episode's is TheTVDB's own when
 * this server has a TheTVDB key (see tvdb.js), then TMDB's, then TVmaze's.
 */

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[metadata] ${label}: ${err.message}`);
    return null;
  }
}

/**
 * The names a match may use, without the primary title or any repeat.
 *
 * A name with a subtitle also counts by its main title alone -- uploaders
 * write "Nosferatu (1922)" for "Nosferatu: A Symphony of Horror" -- as long
 * as that main title is not trivially short. A sequel such as "Baahubali:
 * The Conclusion" still fails, because what follows a colon after the name
 * is read as part of it (see anchoredName).
 */
function uniqueAliases(title, candidates) {
  const withMainTitles = [];
  [title, ...candidates].forEach((name) => {
    if (typeof name !== "string") return;
    withMainTitles.push(name);
    const main = name.split(":")[0];
    if (main !== name && tokens(main).join("").length >= 4) withMainTitles.push(main);
  });
  const seen = new Set([title.toLowerCase()]);
  const out = [];
  withMainTitles.forEach((name) => {
    if (!name.trim()) return;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name.trim());
  });
  return out;
}

function runtime(exact, typical) {
  if (exact) return { runtimeSeconds: exact, runtimeKind: "exact" };
  if (typical) return { runtimeSeconds: typical, runtimeKind: "typical" };
  return { runtimeSeconds: null, runtimeKind: null };
}

/** Every distinct runtime other sources list besides the chosen one. */
function others(chosen, ...listed) {
  return [...new Set(listed.filter((r) => r && r !== chosen))];
}

function people(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

async function imdbMovie(id, { tmdbKey, region }) {
  const cine = await attempt(`Cinemeta movie ${id}`, () => cinemeta.movie(id));
  let tm = null;
  if (tmdbKey) {
    const tmdbId =
      (cine && cine.tmdbId) || (await attempt(`TMDB find ${id}`, async () => (await tmdb.findByImdb(tmdbKey, id)).movieId));
    if (tmdbId) tm = await attempt(`TMDB movie ${tmdbId}`, () => tmdb.movie(tmdbKey, tmdbId, region));
  }
  const title = (cine && cine.title) || (tm && tm.title);
  if (!title) return null;
  const listed = imdb.filmRuntimeSeconds(id);
  const chosen = listed || (cine && cine.runtimeSeconds) || (tm && tm.runtimeSeconds);
  return {
    isEpisode: false,
    title,
    aliases: uniqueAliases(title, tm ? [tm.title, tm.originalTitle, ...tm.aliases] : []),
    year: (cine && cine.year) || (tm && tm.year) || null,
    released: (cine && cine.released) || (tm && tm.released) || null,
    people: people(cine ? cine.people : [], tm ? tm.people : []),
    imdbId: id,
    ...runtime(chosen, null),
    otherRuntimes: others(chosen, cine && cine.runtimeSeconds, tm && tm.runtimeSeconds),
    sources: [listed && "imdb", cine && "cinemeta", tm && "tmdb"].filter(Boolean)
  };
}

/** TheTVDB's record of the episode Cinemeta lists, when this server has a key. */
async function tvdbEpisode(cine, season, episode) {
  const creds = tvdb.credentials();
  if (!creds || !cine) return null;
  const label = `TheTVDB ${cine.tvdbId || cine.tvdbEpisodeId} ${season}x${episode}`;
  const inSeason = cine.tvdbId
    ? await attempt(label, () => tvdb.episodeInSeason(creds, cine.tvdbId, season, episode, cine.tvdbEpisodeId))
    : null;
  if (inSeason || !cine.tvdbEpisodeId) return inSeason;
  return attempt(label, () => tvdb.episodeById(creds, cine.tvdbEpisodeId));
}

async function tmdbParts(cine, id, season, episode, { tmdbKey, region }) {
  if (!tmdbKey) return [null, null];
  const tvId =
    (cine && cine.tmdbId) || (await attempt(`TMDB find ${id}`, async () => (await tmdb.findByImdb(tmdbKey, id)).tvId));
  if (!tvId) return [null, null];
  return Promise.all([
    attempt(`TMDB show ${tvId}`, () => tmdb.show(tmdbKey, tvId, region)),
    attempt(`TMDB episode ${tvId} ${season}x${episode}`, () => tmdb.episode(tmdbKey, tvId, season, episode))
  ]);
}

async function imdbEpisode(id, season, episode, options) {
  const [cine, maze] = await Promise.all([
    attempt(`Cinemeta series ${id}`, () => cinemeta.episode(id, season, episode)),
    attempt(`TVmaze ${id} ${season}x${episode}`, () => tvmaze.episodeRuntime(id, season, episode))
  ]);
  const [tv, [show, ep]] = await Promise.all([tvdbEpisode(cine, season, episode), tmdbParts(cine, id, season, episode, options)]);
  const title = (cine && cine.title) || (show && show.title);
  if (!title) return null;
  const released = (cine && cine.released) || (tv && tv.released) || (ep && ep.released) || null;
  const tvExact = tv && tv.runtimeKind === "exact" ? tv.runtimeSeconds : null;
  const tvTypical = tv && tv.runtimeKind === "typical" ? tv.runtimeSeconds : null;
  const exact = tvExact || (ep && ep.runtimeSeconds) || maze;
  return {
    isEpisode: true,
    title,
    aliases: uniqueAliases(title, show ? [show.title, show.originalTitle, ...show.aliases] : []),
    year: (cine && cine.year) || (show && show.year) || null,
    people: people(cine ? cine.people : [], show ? show.people : []),
    imdbId: id,
    // An episode's own runtime, from TheTVDB, TMDB or TVmaze; failing that
    // the show's usual length -- Cinemeta's first, which measured closer
    // than TMDB's list of slot lengths. Where TheTVDB and TMDB both list the
    // episode's own and differ, a video close to either counts; TVmaze, the
    // least accurate measured, only when neither lists one.
    ...runtime(exact, (cine && cine.typicalRuntimeSeconds) || tvTypical || (show && show.typicalRuntimeSeconds)),
    otherRuntimes: others(exact, tvExact, ep && ep.runtimeSeconds),
    season,
    episode,
    absoluteEpisode:
      (cine && cine.absoluteEpisode) || (show && show.seasons.length ? tmdb.absoluteEpisode(show.seasons, season, episode) : null),
    episodeTitle: (cine && cine.episodeTitle) || (ep && ep.episodeTitle) || (tv && tv.episodeTitle) || null,
    released,
    releaseYear: yearOf(released),
    seasonCount: (cine && cine.seasonCount) || (show ? show.seasons.filter((s) => s.season >= 1).length || null : null),
    sources: [cine && "cinemeta", tv && "tvdb", (show || ep) && "tmdb", maze && "tvmaze"].filter(Boolean)
  };
}

async function tmdbMovie(id, { tmdbKey, region }) {
  const tm = await attempt(`TMDB movie ${id}`, () => tmdb.movie(tmdbKey, id, region));
  if (!tm) return null;
  // IMDb's runtime and credits, through Cinemeta, when TMDB links the title.
  const cine = tm.imdbId ? await attempt(`Cinemeta movie ${tm.imdbId}`, () => cinemeta.movie(tm.imdbId)) : null;
  const listed = imdb.filmRuntimeSeconds(tm.imdbId);
  const chosen = listed || tm.runtimeSeconds || (cine && cine.runtimeSeconds);
  return {
    isEpisode: false,
    title: tm.title,
    aliases: uniqueAliases(tm.title, [tm.originalTitle, ...tm.aliases]),
    year: tm.year,
    released: tm.released || (cine && cine.released) || null,
    people: people(tm.people, cine ? cine.people : []),
    imdbId: tm.imdbId,
    ...runtime(chosen, null),
    otherRuntimes: others(chosen, tm.runtimeSeconds, cine && cine.runtimeSeconds),
    sources: ["tmdb", listed && "imdb", cine && "cinemeta"].filter(Boolean)
  };
}

async function tmdbEpisode(id, season, episode, { tmdbKey, region }) {
  const [show, ep] = await Promise.all([
    attempt(`TMDB show ${id}`, () => tmdb.show(tmdbKey, id, region)),
    attempt(`TMDB episode ${id} ${season}x${episode}`, () => tmdb.episode(tmdbKey, id, season, episode))
  ]);
  if (!show) return null;
  const maze = show.imdbId
    ? await attempt(`TVmaze ${show.imdbId} ${season}x${episode}`, () => tvmaze.episodeRuntime(show.imdbId, season, episode))
    : null;
  return {
    isEpisode: true,
    title: show.title,
    aliases: uniqueAliases(show.title, [show.originalTitle, ...show.aliases]),
    year: show.year,
    people: show.people,
    imdbId: show.imdbId,
    ...runtime((ep && ep.runtimeSeconds) || maze, show.typicalRuntimeSeconds),
    otherRuntimes: [],
    season,
    episode,
    absoluteEpisode: tmdb.absoluteEpisode(show.seasons, season, episode),
    episodeTitle: (ep && ep.episodeTitle) || null,
    released: (ep && ep.released) || null,
    releaseYear: yearOf(ep && ep.released),
    seasonCount: show.seasons.filter((s) => s.season >= 1).length || null,
    sources: ["tmdb", maze && "tvmaze"].filter(Boolean)
  };
}

async function kitsuTitle(id, isEpisode, episode) {
  const [entry, ep] = await Promise.all([
    attempt(`Kitsu anime ${id}`, () => kitsu.anime(id)),
    isEpisode ? attempt(`Kitsu episode ${id} ${episode}`, () => kitsu.episode(id, episode)) : null
  ]);
  if (!entry) return null;
  const base = {
    title: entry.title,
    aliases: uniqueAliases(entry.title, entry.aliases),
    year: entry.year,
    released: entry.released,
    people: [],
    imdbId: null,
    otherRuntimes: [],
    sources: ["kitsu"]
  };
  if (!isEpisode) {
    // A film's "episode length" is the film's length.
    return { isEpisode: false, ...base, ...runtime(entry.typicalRuntimeSeconds, null) };
  }
  return {
    isEpisode: true,
    ...base,
    ...runtime(ep && ep.runtimeSeconds, entry.typicalRuntimeSeconds),
    season: 1,
    episode,
    absoluteEpisode: episode,
    episodeTitle: (ep && ep.episodeTitle) || null,
    released: (ep && ep.released) || null,
    releaseYear: yearOf(ep && ep.released),
    seasonCount: 1
  };
}

/**
 * @param parsed   from ids.parseStreamId
 * @param options  { tmdbKey, region }: the key may be the reader's or the
 *                 server's; without one, `tmdb:` ids cannot be read at all.
 */
async function resolveTitle(parsed, { tmdbKey = "", region = "" } = {}) {
  const options = { tmdbKey, region };
  if (parsed.source === "imdb") {
    return parsed.isEpisode
      ? imdbEpisode(parsed.id, parsed.season, parsed.episode, options)
      : imdbMovie(parsed.id, options);
  }
  if (parsed.source === "tmdb") {
    if (!tmdbKey) return null;
    return parsed.isEpisode
      ? tmdbEpisode(parsed.id, parsed.season, parsed.episode, options)
      : tmdbMovie(parsed.id, options);
  }
  return kitsuTitle(parsed.id, parsed.isEpisode, parsed.episode);
}

module.exports = { resolveTitle, uniqueAliases };
