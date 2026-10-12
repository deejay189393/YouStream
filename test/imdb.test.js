const zlib = require("zlib");
const imdb = require("../src/metadata/imdb");
const { routeFetch, response } = require("./helpers");

const HEADER = "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres";
const row = (id, type, minutes) => [id, type, "T", "T", "0", "1975", "\\N", minutes, "Drama"].join("\t");

// As IMDb orders its file: by id as text, so tt10000000 comes before tt2.
const LINES = [
  HEADER,
  row("tt0072783", "movie", "146"),
  row("tt0073707", "movie", "162"),
  row("tt0903747", "tvSeries", "45"),
  row("tt0959621", "tvEpisode", "58"),
  row("tt10000000", "tvMovie", "88"),
  row("tt2000000", "short", "12"),
  row("tt3000000", "video", "\\N"),
  row("tt4000000", "tvSpecial", "0"),
  row("nm0000001", "movie", "90"),
  row("tt5000000", "movie", "70000")
];

async function* lines(list) {
  yield* list;
}

const gz = (list) => zlib.gzipSync(Buffer.from(list.join("\n") + "\n"));
const download = (list) => new Response(gz(list), { status: 200 });

let warn;
beforeEach(async () => {
  imdb.stop();
  // A build the last test left running would otherwise be joined by this
  // test's first refresh, and answer with the last test's download.
  await imdb.idle();
  imdb.useIndex(null);
  jest.restoreAllMocks();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => imdb.stop());

describe("buildIndex", () => {
  test("keeps films, TV films, specials, videos and shorts with a runtime, in id order", async () => {
    const built = await imdb.buildIndex(lines(LINES));
    expect(built.size).toBe(4);
    expect([...built.ids]).toEqual([72783, 73707, 2000000, 10000000]);
    expect([...built.runtimes]).toEqual([146, 162, 12, 88]);
    expect(built.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("grows past its first allocation", async () => {
    const many = [HEADER, ...Array.from({ length: 70000 }, (_, i) => row(`tt${9000000 - i}`, "movie", "100"))];
    const built = await imdb.buildIndex(lines(many));
    expect(built.size).toBe(70000);
    expect(built.ids[0]).toBeLessThan(built.ids[1]);
  });
});

describe("filmRuntimeSeconds", () => {
  test("finds a film by its IMDb id", async () => {
    imdb.useIndex(await imdb.buildIndex(lines(LINES)));
    expect(imdb.filmRuntimeSeconds("tt0072783")).toBe(146 * 60);
    expect(imdb.filmRuntimeSeconds("tt10000000")).toBe(88 * 60);
    expect(imdb.filmRuntimeSeconds("tt2000000")).toBe(12 * 60);
  });

  test("is null for a series, an unknown id, something that is not an id, or before loading", async () => {
    expect(imdb.filmRuntimeSeconds("tt0072783")).toBeNull();
    imdb.useIndex(await imdb.buildIndex(lines(LINES)));
    ["tt0903747", "tt0000001", "tt99999999", "nm0000001", "", null].forEach((id) => expect(imdb.filmRuntimeSeconds(id)).toBeNull());
  });
});

describe("loading", () => {
  test("downloads IMDb's file, decompressing as it goes", async () => {
    const fetch = routeFetch([["title.basics", () => download(LINES)]]);
    expect(await imdb.refresh()).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(imdb.DATASET_URL);
    expect(imdb.status()).toMatchObject({ loaded: true, films: 4 });
    expect(console.log).toHaveBeenCalledWith("[imdb] 4 film runtimes loaded");
  });

  test("a failed download keeps the data already loaded, and says so", async () => {
    routeFetch([["title.basics", () => download(LINES)]]);
    await imdb.refresh();
    routeFetch([["title.basics", response(null, { status: 503 })]]);
    expect(await imdb.refresh()).toBe(false);
    expect(imdb.filmRuntimeSeconds("tt0072783")).toBe(146 * 60);
    expect(warn).toHaveBeenCalledWith(
      "[imdb] could not load IMDb's data, matching on Cinemeta's runtimes meanwhile: IMDb's data returned HTTP 503"
    );
  });

  test("a response with no body is a failure", async () => {
    routeFetch([["title.basics", { ok: true, status: 200, body: null, json: async () => null }]]);
    expect(await imdb.refresh()).toBe(false);
    expect(imdb.status()).toEqual({ loaded: false });
  });

  test("two refreshes at once share one download", async () => {
    const fetch = routeFetch([["title.basics", () => download(LINES)]]);
    const [a, b] = await Promise.all([imdb.refresh(), imdb.refresh()]);
    expect([a, b]).toEqual([true, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("start", () => {
  const until = async (check) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  };

  test("loads at once, then again on schedule", async () => {
    let calls = 0;
    routeFetch([["title.basics", () => (calls++, download(LINES))]]);
    imdb.start({ refreshMs: 10, retryMs: 1e9 });
    await until(() => calls >= 2);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(imdb.status().loaded).toBe(true);
    imdb.stop();
  });

  test("after a failure, tries again sooner", async () => {
    let calls = 0;
    routeFetch([["title.basics", () => (calls++, response(null, { status: 500 }))]]);
    imdb.start({ refreshMs: 1e9, retryMs: 10 });
    await until(() => calls >= 2);
    expect(calls).toBeGreaterThanOrEqual(2);
    imdb.stop();
  });

  test("stopped while loading, it schedules nothing more", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    global.fetch = jest.fn(async () => {
      await gate;
      return download(LINES);
    });
    imdb.start({ refreshMs: 5, retryMs: 5 });
    await until(() => global.fetch.mock.calls.length >= 1);
    imdb.stop();
    release();
    await until(() => imdb.status().loaded);
    await new Promise((r) => setTimeout(r, 40));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("with no options, on IMDb's daily schedule", async () => {
    routeFetch([["title.basics", () => download(LINES)]]);
    imdb.start();
    await until(() => imdb.status().loaded);
    expect(imdb.status().loaded).toBe(true);
    imdb.stop();
  });
});
