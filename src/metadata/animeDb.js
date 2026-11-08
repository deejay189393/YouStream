const readline = require("readline");
const { Readable } = require("stream");

/**
 * Every anime's ids and names, from the anime offline database
 * (manami-project/anime-offline-database), as a fork of it keeps it current
 * every week (cedya77/anime-offline-database): some 38,000 entries, each
 * with its pages on MyAnimeList, AniList, Kitsu, AniDB and others, its
 * title and every other name those sites know it by, its kind (TV, MOVIE,
 * OVA...), how many episodes it has and how long they run.
 *
 * It does two things no one site does. It maps one site's id to the others',
 * so an app that names an anime by its MyAnimeList, AniList or AniDB id is
 * understood as well as one using Kitsu's. And it knows the names uploads
 * are written with. Official uploads on YouTube name an anime in English,
 * often an English name one site has and another lacks: measured on 210
 * episodes uploaded by two official channels, Kitsu's names were found in
 * 41% of their titles and AniList's in 44%.
 *
 * Only what lookups need is kept, about 29 MB, rebuilt once a week in the
 * background from a 60 MB download. Until the first build finishes, or if
 * it cannot be fetched, anime are looked up on Kitsu and AniList alone.
 *
 * The data is under the Open Database License, which asks for it to be
 * credited where it is used; the configure page and the terms do.
 */
const DATASET_URL = "https://github.com/cedya77/anime-offline-database/releases/download/latest/anime-offline-database.jsonl";
const ATTRIBUTION = "Anime names and ids from the anime offline database, under the Open Database License (ODbL 1.0)";
const SOURCE_URL = "https://github.com/manami-project/anime-offline-database";
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** The sites an app may name an anime by, and how the address of its page there carries the id. */
const SITES = {
  kitsu: /^https:\/\/kitsu\.(?:app|io)\/anime\/(\d+)$/,
  mal: /^https:\/\/myanimelist\.net\/anime\/(\d+)$/,
  anilist: /^https:\/\/anilist\.co\/anime\/(\d+)$/,
  anidb: /^https:\/\/anidb\.net\/anime\/(\d+)$/
};

/** { ids: { kitsu: Map, mal: Map, anilist: Map, anidb: Map }, size, builtAt } once built. */
let index = null;
let building = null;
let timer = null;
// Each start() is one schedule; a build that finishes after a stop() or a
// newer start() must not reschedule itself on top of it.
let generation = 0;

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/**
 * One line of the database as kept: its ids, its title and its other names
 * (each once, in any case, none shorter than two characters), its kind, and
 * its episodes' count and length. Null for a line that is no anime with an
 * id an app could name it by -- the file's first line, which describes it,
 * among them.
 */
function toEntry(raw) {
  if (!raw || !Array.isArray(raw.sources) || typeof raw.title !== "string" || !raw.title.trim()) return null;
  const ids = {};
  for (const source of raw.sources) {
    for (const [site, pattern] of Object.entries(SITES)) {
      const match = pattern.exec(source);
      if (match) ids[site] = Number(match[1]);
    }
  }
  if (!Object.keys(ids).length) return null;
  const title = raw.title.trim();
  const seen = new Set([title.toLowerCase()]);
  const names = [];
  for (const synonym of Array.isArray(raw.synonyms) ? raw.synonyms : []) {
    const name = typeof synonym === "string" ? synonym.trim() : "";
    const key = name.toLowerCase();
    if (name.length < 2 || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  const duration = raw.duration || {};
  return {
    title,
    names,
    kind: typeof raw.type === "string" ? raw.type : "UNKNOWN",
    episodes: positive(Number(raw.episodes)),
    seconds: duration.unit === "SECONDS" ? positive(Number(duration.value)) : null,
    year: positive(Number((raw.animeSeason || {}).year)),
    ids
  };
}

/** The database's lines, one JSON document each, into an index by every site's id. */
async function buildIndex(lines) {
  const ids = Object.fromEntries(Object.keys(SITES).map((site) => [site, new Map()]));
  let size = 0;
  for await (const line of lines) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const entry = toEntry(raw);
    if (!entry) continue;
    size++;
    for (const [site, id] of Object.entries(entry.ids)) ids[site].set(id, entry);
  }
  if (!size) throw new Error("the anime database listed no anime");
  return { ids, size, builtAt: new Date().toISOString() };
}

/** The database, line by line as it downloads. */
async function downloadLines(url = DATASET_URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`the anime database returned HTTP ${response.status}`);
  return readline.createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
}

/**
 * Builds the index, replacing the one in use only once the new one is
 * complete; a failed build leaves the old one in place. Builds asked for
 * while one is running join it.
 */
function refresh(url) {
  if (!building) {
    building = downloadLines(url)
      .then(buildIndex)
      .then((built) => {
        index = built;
        console.log(`[anime] ${built.size} anime loaded`);
        return true;
      })
      .catch((err) => {
        console.warn(`[anime] could not load the anime database, looking anime up on Kitsu and AniList meanwhile: ${err.message}`);
        return false;
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

/** Loads now, then again every week; after a failure, again in an hour. */
function start({ url, refreshMs = REFRESH_MS, retryMs = RETRY_MS } = {}) {
  stop();
  const mine = generation;
  const run = async () => {
    const ok = await refresh(url);
    if (generation !== mine) return;
    timer = setTimeout(run, ok ? refreshMs : retryMs);
    timer.unref();
  };
  timer = setTimeout(run, 0);
  timer.unref();
}

function stop() {
  generation++;
  clearTimeout(timer);
  timer = null;
}

/**
 * The anime a site's id names -- "kitsu", "mal", "anilist" or "anidb", and
 * the number -- or null when the database does not know it or is not loaded.
 */
function find(site, id) {
  if (!index || !Object.prototype.hasOwnProperty.call(index.ids, site)) return null;
  return index.ids[site].get(Number(id)) || null;
}

function status() {
  return index ? { loaded: true, anime: index.size, builtAt: index.builtAt } : { loaded: false };
}

/** For tests: use this index, or none. */
function useIndex(built) {
  index = built;
}

/** For tests: settles once no build is running. */
async function idle() {
  await building;
}

module.exports = {
  toEntry,
  buildIndex,
  downloadLines,
  refresh,
  start,
  stop,
  find,
  status,
  useIndex,
  idle,
  ATTRIBUTION,
  SOURCE_URL,
  DATASET_URL,
  SITES
};
