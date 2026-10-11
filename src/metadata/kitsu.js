const { getJson, yearOf, runtimeSeconds } = require("./http");

/**
 * Kitsu: the anime database behind Stremio's anime addons, free and keyless.
 *
 * Worth supporting because anime is one of the places full, legitimate
 * episodes really are on YouTube -- Muse Asia and Ani-One upload whole series
 * to their own channels. Each Kitsu entry is one season, numbered from
 * episode 1, and carries a typical episode length; an episode's own record
 * sometimes carries its exact length too.
 */
const BASE_URL = "https://kitsu.io/api/edge";

function attributesOf(body) {
  const data = body && body.data;
  return data && typeof data === "object" && data.attributes && typeof data.attributes === "object"
    ? data.attributes
    : null;
}

/** Every name the entry is known by, English first. */
function namesOf(attributes) {
  const titles = attributes.titles && typeof attributes.titles === "object" ? attributes.titles : {};
  const candidates = [
    attributes.canonicalTitle,
    titles.en,
    titles.en_us,
    titles.en_jp,
    titles.ja_jp,
    ...(Array.isArray(attributes.abbreviatedTitles) ? attributes.abbreviatedTitles : [])
  ];
  return [...new Set(candidates.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))];
}

async function anime(kitsuId) {
  const attributes = attributesOf(await getJson(`${BASE_URL}/anime/${kitsuId}`));
  if (!attributes) return null;
  const names = namesOf(attributes);
  if (!names.length) return null;
  // English first when Kitsu has it: an English title is what most uploads
  // aimed at this addon's readers are written with.
  const english = typeof (attributes.titles || {}).en === "string" && attributes.titles.en.trim();
  const title = english || names[0];
  return {
    title,
    aliases: names.filter((n) => n !== title),
    year: yearOf(attributes.startDate),
    typicalRuntimeSeconds: runtimeSeconds(attributes.episodeLength),
    isMovie: attributes.subtype === "movie"
  };
}

async function episode(kitsuId, episodeNumber) {
  const url = `${BASE_URL}/anime/${kitsuId}/episodes?filter%5Bnumber%5D=${episodeNumber}`;
  const body = await getJson(url);
  const list = body && Array.isArray(body.data) ? body.data : [];
  const match = list.find((e) => e && e.attributes && Number(e.attributes.number) === episodeNumber);
  if (!match) return null;
  const title = match.attributes.canonicalTitle;
  return {
    episodeTitle: typeof title === "string" && title.trim() ? title.trim() : null,
    runtimeSeconds: runtimeSeconds(match.attributes.length)
  };
}

module.exports = { anime, episode, namesOf, BASE_URL };
