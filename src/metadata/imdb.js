const zlib = require("zlib");
const readline = require("readline");
const { Readable } = require("stream");

/**
 * Films' runtimes from IMDb itself, through IMDb's own published data
 * (https://datasets.imdbws.com, refreshed daily by IMDb), the only way IMDb
 * offers its data for non-commercial use.
 *
 * Cinemeta is built from IMDb, and the two agree on most films. Where they
 * do not, measured against the official and public-domain uploads of 47
 * films, each is right about half the time: IMDb has Chupke Chupke at 146
 * minutes (its uploads run 146; Cinemeta says 129), Cinemeta has Golmaal at
 * 144 (its uploads run 131-139; IMDb says 120). So IMDb's runtime is the
 * one a film is matched against first, and Cinemeta's counts alongside it.
 *
 * Only what matching needs is kept: each film's id and runtime, about
 * 1.6 million of them in 10 MB of typed arrays, rebuilt once a day in the
 * background from a 230 MB download. Until the first build finishes, and if
 * IMDb cannot be reached, films are matched on Cinemeta's runtime alone.
 *
 * IMDb's terms for this data ask for this statement wherever it is used:
 * "Information courtesy of IMDb (https://www.imdb.com). Used with permission."
 * The configure page shows it.
 */
const DATASET_URL = "https://datasets.imdbws.com/title.basics.tsv.gz";
const ATTRIBUTION = "Information courtesy of IMDb (https://www.imdb.com). Used with permission.";
const FILM_TYPES = new Set(["movie", "tvMovie", "tvSpecial", "video", "short"]);
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** { ids: Int32Array, runtimes: Uint16Array, size, builtAt } once built. */
let index = null;
let building = null;
let timer = null;
// Each start() is one schedule; a build that finishes after a stop() or a
// newer start() must not reschedule itself on top of it.
let generation = 0;

/**
 * Reads title.basics rows (tconst, titleType, primaryTitle, originalTitle,
 * isAdult, startYear, endYear, runtimeMinutes, genres) into ids and
 * runtimes ordered by id. IMDb orders the file by id as text (tt10000000
 * before tt2000000), so the rows are sorted here, by number: each id and
 * runtime packed into one number, so a typed array's own sort does it.
 */
async function buildIndex(lines) {
  let packed = new Float64Array(1 << 16);
  let size = 0;
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      continue;
    }
    const fields = line.split("\t");
    if (!FILM_TYPES.has(fields[1])) continue;
    const minutes = Number(fields[7]);
    const id = Number(fields[0].slice(2));
    if (!(minutes > 0 && minutes < 65536) || !/^tt\d+$/.test(fields[0])) continue;
    if (size === packed.length) {
      const grown = new Float64Array(packed.length * 2);
      grown.set(packed);
      packed = grown;
    }
    packed[size++] = id * 65536 + minutes;
  }
  const sorted = packed.subarray(0, size).sort();
  const ids = new Int32Array(size);
  const runtimes = new Uint16Array(size);
  sorted.forEach((value, i) => {
    ids[i] = Math.floor(value / 65536);
    runtimes[i] = value % 65536;
  });
  return { ids, runtimes, size, builtAt: new Date().toISOString() };
}

/** title.basics, decompressed as it downloads, line by line. */
async function downloadLines(url = DATASET_URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`IMDb's data returned HTTP ${response.status}`);
  const text = Readable.fromWeb(response.body).pipe(zlib.createGunzip());
  return readline.createInterface({ input: text, crlfDelay: Infinity });
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
        console.log(`[imdb] ${built.size} film runtimes loaded`);
        return true;
      })
      .catch((err) => {
        console.warn(`[imdb] could not load IMDb's data, matching on Cinemeta's runtimes meanwhile: ${err.message}`);
        return false;
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

/** Loads now, then again every day; after a failure, again in an hour. */
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

/** A film's runtime in seconds, by IMDb id, or null when unknown or not loaded. */
function filmRuntimeSeconds(imdbId) {
  if (!index || typeof imdbId !== "string" || !/^tt\d+$/.test(imdbId)) return null;
  const id = Number(imdbId.slice(2));
  let lo = 0;
  let hi = index.size - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.ids[mid] === id) return index.runtimes[mid] * 60;
    if (index.ids[mid] < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function status() {
  return index ? { loaded: true, films: index.size, builtAt: index.builtAt } : { loaded: false };
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
  buildIndex,
  downloadLines,
  refresh,
  start,
  stop,
  filmRuntimeSeconds,
  status,
  useIndex,
  idle,
  ATTRIBUTION,
  DATASET_URL,
  FILM_TYPES
};
