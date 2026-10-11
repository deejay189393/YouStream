const cinemeta = require("./cinemeta");
const tmdb = require("./tmdb");
const kitsu = require("./kitsu");

/**
 * What a stream id refers to, in the terms a YouTube search needs:
 *
 *   {
 *     isEpisode, title, aliases, year,
 *     runtimeSeconds,          // the length a match has to be close to
 *     runtimeKind,             // "exact": this film's or episode's own length
 *                              // "typical": only the show's usual length
 *                              // null: nothing listed anywhere
 *     season, episode, absoluteEpisode, episodeTitle, seasonCount,
 *     sources                  // which services answered, for the logs
 *   }
 *
 * Each service is asked for what it is best at, and a service that is down
 * costs only what it would have added: a film still resolves from Cinemeta
 * when TMDB is unreachable, and from TMDB when Cinemeta is.
 */

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[metadata] ${label}: ${err.message}`);
    return null;
  }
}

/** The names a match may use, without the primary title or any repeat. */
function uniqueAliases(title, candidates) {
  const seen = new Set([title.toLowerCase()]);
  const out = [];
  candidates.forEach((name) => {
    if (typeof name !== "string" || !name.trim()) return;
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
  return {
    isEpisode: false,
    title,
    aliases: uniqueAliases(title, tm ? [tm.title, tm.originalTitle, ...tm.aliases] : []),
    year: (cine && cine.year) || (tm && tm.year) || null,
    ...runtime((cine && cine.runtimeSeconds) || (tm && tm.runtimeSeconds), null),
    sources: [cine && "cinemeta", tm && "tmdb"].filter(Boolean)
  };
}

async function imdbEpisode(id, season, episode, { tmdbKey, region }) {
  const cine = await attempt(`Cinemeta series ${id}`, () => cinemeta.episode(id, season, episode));
  let show = null;
  let ep = null;
  if (tmdbKey) {
    const tvId =
      (cine && cine.tmdbId) || (await attempt(`TMDB find ${id}`, async () => (await tmdb.findByImdb(tmdbKey, id)).tvId));
    if (tvId) {
      [show, ep] = await Promise.all([
        attempt(`TMDB show ${tvId}`, () => tmdb.show(tmdbKey, tvId, region)),
        attempt(`TMDB episode ${tvId} ${season}x${episode}`, () => tmdb.episode(tmdbKey, tvId, season, episode))
      ]);
    }
  }
  const title = (cine && cine.title) || (show && show.title);
  if (!title) return null;
  return {
    isEpisode: true,
    title,
    aliases: uniqueAliases(title, show ? [show.title, show.originalTitle, ...show.aliases] : []),
    year: (cine && cine.year) || (show && show.year) || null,
    ...runtime(ep && ep.runtimeSeconds, (show && show.typicalRuntimeSeconds) || (cine && cine.typicalRuntimeSeconds)),
    season,
    episode,
    absoluteEpisode:
      (cine && cine.absoluteEpisode) || (show && show.seasons.length ? tmdb.absoluteEpisode(show.seasons, season, episode) : null),
    episodeTitle: (cine && cine.episodeTitle) || (ep && ep.episodeTitle) || null,
    seasonCount: (cine && cine.seasonCount) || (show ? show.seasons.filter((s) => s.season >= 1).length || null : null),
    sources: [cine && "cinemeta", (show || ep) && "tmdb"].filter(Boolean)
  };
}

async function tmdbMovie(id, { tmdbKey, region }) {
  const tm = await attempt(`TMDB movie ${id}`, () => tmdb.movie(tmdbKey, id, region));
  if (!tm) return null;
  // TMDB leaves some runtimes empty; IMDb's, through Cinemeta, fills them.
  const cine =
    !tm.runtimeSeconds && tm.imdbId ? await attempt(`Cinemeta movie ${tm.imdbId}`, () => cinemeta.movie(tm.imdbId)) : null;
  return {
    isEpisode: false,
    title: tm.title,
    aliases: uniqueAliases(tm.title, [tm.originalTitle, ...tm.aliases]),
    year: tm.year,
    ...runtime(tm.runtimeSeconds || (cine && cine.runtimeSeconds), null),
    sources: ["tmdb", cine && "cinemeta"].filter(Boolean)
  };
}

async function tmdbEpisode(id, season, episode, { tmdbKey, region }) {
  const [show, ep] = await Promise.all([
    attempt(`TMDB show ${id}`, () => tmdb.show(tmdbKey, id, region)),
    attempt(`TMDB episode ${id} ${season}x${episode}`, () => tmdb.episode(tmdbKey, id, season, episode))
  ]);
  if (!show) return null;
  return {
    isEpisode: true,
    title: show.title,
    aliases: uniqueAliases(show.title, [show.originalTitle, ...show.aliases]),
    year: show.year,
    ...runtime(ep && ep.runtimeSeconds, show.typicalRuntimeSeconds),
    season,
    episode,
    absoluteEpisode: tmdb.absoluteEpisode(show.seasons, season, episode),
    episodeTitle: (ep && ep.episodeTitle) || null,
    seasonCount: show.seasons.filter((s) => s.season >= 1).length || null,
    sources: ["tmdb"]
  };
}

async function kitsuTitle(id, isEpisode, episode) {
  const [entry, ep] = await Promise.all([
    attempt(`Kitsu anime ${id}`, () => kitsu.anime(id)),
    isEpisode ? attempt(`Kitsu episode ${id} ${episode}`, () => kitsu.episode(id, episode)) : null
  ]);
  if (!entry) return null;
  const base = { title: entry.title, aliases: entry.aliases, year: entry.year, sources: ["kitsu"] };
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
