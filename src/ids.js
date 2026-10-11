/**
 * The ids a Stremio-compatible app asks for streams with.
 *
 *   tt0111161              a film, by its IMDb id
 *   tt4742876:1:3          season 1, episode 3 of a show, by the show's IMDb id
 *   tmdb:278               a film by TMDB id -- Nuvio uses these for titles
 *   tmdb:63180:1:3         an episode by the show's TMDB id
 *   kitsu:45398            an anime film by Kitsu id
 *   kitsu:45398:3          episode 3 of an anime; Kitsu has no seasons, each
 *                          season is its own entry
 *
 * Nuvio documents the same shapes when it falls back to a meta request
 * (StreamRepositoryImpl.fetchInlineStreamsFromMeta). The request's `type` is
 * not trusted to say which is which -- an anime can arrive as "anime" or
 * "series" -- so the shape of the id decides.
 */

const IMDB = /^tt\d{5,10}$/;
const NUMERIC = /^\d{1,10}$/;
const NUMBER = /^\d{1,5}$/;

/**
 * @returns {{ source: "imdb"|"tmdb"|"kitsu", id: string, season: number|null,
 *   episode: number|null, isEpisode: boolean } | null}
 */
function parseStreamId(rawId) {
  if (typeof rawId !== "string") return null;
  const parts = rawId.trim().split(":");

  let source;
  let id;
  let rest;
  if (IMDB.test(parts[0])) {
    source = "imdb";
    id = parts[0];
    rest = parts.slice(1);
  } else if ((parts[0] === "tmdb" || parts[0] === "kitsu") && NUMERIC.test(parts[1] || "")) {
    source = parts[0];
    id = parts[1];
    rest = parts.slice(2);
  } else {
    return null;
  }

  if (!rest.every((p) => NUMBER.test(p))) return null;
  const numbers = rest.map(Number);

  if (numbers.length === 0) return { source, id, season: null, episode: null, isEpisode: false };

  // Kitsu numbers its episodes without a season: kitsu:ID:EPISODE. A
  // season-shaped Kitsu id is accepted too, with the episode taken from the
  // end, since the entry itself already is the season.
  if (source === "kitsu") {
    if (numbers.length > 2) return null;
    return { source, id, season: 1, episode: numbers[numbers.length - 1], isEpisode: true };
  }

  if (numbers.length !== 2) return null;
  const [season, episode] = numbers;
  return { source, id, season, episode, isEpisode: true };
}

/** "movie" or "series": what the reader's content-type switches call it. */
function contentKind(parsed) {
  return parsed.isEpisode ? "series" : "movie";
}

module.exports = { parseStreamId, contentKind };
