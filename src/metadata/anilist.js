const { postJson, runtimeSeconds } = require("./http");

/**
 * AniList: a free, keyless anime database with a GraphQL API, which also
 * knows each anime's MyAnimeList id, so an app naming an anime by either is
 * looked up here in one request.
 *
 * Asked for what Kitsu may lack: an English title, which official uploads
 * are named with, and the names AniList knows an anime by.
 */
const BASE_URL = "https://graphql.anilist.co";

const QUERY = `query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    id
    idMal
    format
    episodes
    duration
    title { english romaji native }
    synonyms
    startDate { year month day }
  }
}`;

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const pad = (n) => String(n).padStart(2, "0");

/** "2019-04-06" from AniList's date parts, when they are whole. */
function dateOf(date) {
  return date && date.year && date.month && date.day ? `${date.year}-${pad(date.month)}-${pad(date.day)}` : null;
}

/**
 * An anime by AniList's id or MyAnimeList's (`{ anilist }` or `{ mal }`):
 * English title first, as Kitsu's are; null when AniList has no such anime.
 */
async function anime({ anilist, mal }) {
  const variables = anilist ? { id: Number(anilist) } : { idMal: Number(mal) };
  const cacheKey = `anilist:${anilist ? `id:${anilist}` : `mal:${mal}`}`;
  const body = await postJson(BASE_URL, { query: QUERY, variables }, { cacheKey });
  const media = body && body.data && body.data.Media;
  if (!media) return null;
  const title = media.title || {};
  const names = [title.english, title.romaji, title.native, ...(Array.isArray(media.synonyms) ? media.synonyms : [])].map(text).filter(Boolean);
  if (!names.length) return null;
  const start = media.startDate || {};
  return {
    title: names[0],
    english: text(title.english),
    aliases: [...new Set(names.slice(1))].filter((name) => name !== names[0]),
    year: start.year || null,
    released: dateOf(start),
    typicalRuntimeSeconds: runtimeSeconds(media.duration),
    isMovie: media.format === "MOVIE",
    ids: { anilist: media.id || null, mal: media.idMal || null }
  };
}

module.exports = { anime, BASE_URL, QUERY };
