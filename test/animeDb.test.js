const animeDb = require("../src/metadata/animeDb");
const { routeFetch, response } = require("./helpers");

// As the database writes its file: a line describing it, then one anime a line.
const HEADER = { $schema: "https://example.com/schema.json", license: { name: "ODbL" }, lastUpdate: "2026-11-01" };
const SPY = {
  sources: [
    "https://anidb.net/anime/16591",
    "https://anilist.co/anime/140960",
    "https://kitsu.app/anime/45398",
    "https://myanimelist.net/anime/50265",
    "https://anime-planet.com/anime/spy-x-family"
  ],
  title: "SPY x FAMILY",
  type: "TV",
  episodes: 12,
  animeSeason: { season: "SPRING", year: 2022 },
  duration: { value: 1440, unit: "SECONDS" },
  synonyms: ["Spy x Family", "SxF", "间谍过家家", " Spy Family ", "x", "", 7]
};
const FILM = {
  sources: ["https://kitsu.io/anime/11614", "https://myanimelist.net/anime/32281"],
  title: "Kimi no Na wa.",
  type: "MOVIE",
  episodes: 1,
  animeSeason: { season: "SUMMER", year: 2016 },
  duration: { value: 106, unit: "MINUTES" },
  synonyms: ["Your Name."]
};
const ONLY_ELSEWHERE = { sources: ["https://anime-planet.com/anime/somewhere"], title: "Somewhere Else", type: "TV", synonyms: [] };
const LINES = [HEADER, SPY, FILM, ONLY_ELSEWHERE, { sources: ["https://kitsu.app/anime/1"], title: "   " }].map((line) => JSON.stringify(line));

async function* lines(list) {
  yield* list;
}

const download = (list) => new Response(list.join("\n") + "\n", { status: 200 });

let warn;
beforeEach(async () => {
  animeDb.stop();
  await animeDb.idle();
  animeDb.useIndex(null);
  jest.restoreAllMocks();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => animeDb.stop());

describe("an anime as kept", () => {
  test("its ids on the sites an app names anime by, its title and its other names, each once", () => {
    expect(animeDb.toEntry(SPY)).toEqual({
      title: "SPY x FAMILY",
      names: ["SxF", "间谍过家家", "Spy Family"],
      kind: "TV",
      episodes: 12,
      seconds: 1440,
      year: 2022,
      ids: { anidb: 16591, anilist: 140960, kitsu: 45398, mal: 50265 }
    });
  });

  test("Kitsu's old address too; a length not in seconds, or none, is no length", () => {
    expect(animeDb.toEntry(FILM)).toMatchObject({ ids: { kitsu: 11614, mal: 32281 }, seconds: null, kind: "MOVIE", names: ["Your Name."] });
    expect(animeDb.toEntry({ sources: ["https://kitsu.app/anime/7"], title: "Bare" })).toEqual({
      title: "Bare",
      names: [],
      kind: "UNKNOWN",
      episodes: null,
      seconds: null,
      year: null,
      ids: { kitsu: 7 }
    });
  });

  test("none for the file's own description, an untitled line, or an anime no app names by id", () => {
    expect(animeDb.toEntry(HEADER)).toBeNull();
    expect(animeDb.toEntry(null)).toBeNull();
    expect(animeDb.toEntry({ sources: ["https://kitsu.app/anime/1"], title: " " })).toBeNull();
    expect(animeDb.toEntry(ONLY_ELSEWHERE)).toBeNull();
  });
});

describe("buildIndex and find", () => {
  test("every anime by each of its ids; what is no anime, or no JSON, is passed over", async () => {
    const built = await animeDb.buildIndex(lines([...LINES, "{not json"]));
    expect(built.size).toBe(2);
    expect(built.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    animeDb.useIndex(built);
    for (const [site, id] of [
      ["kitsu", 45398],
      ["mal", "50265"],
      ["anilist", 140960],
      ["anidb", 16591]
    ]) {
      expect(animeDb.find(site, id).title).toBe("SPY x FAMILY");
    }
    expect(animeDb.find("kitsu", 11614).title).toBe("Kimi no Na wa.");
    expect(animeDb.find("kitsu", 999)).toBeNull();
    expect(animeDb.find("anidb", 11614)).toBeNull();
    expect(animeDb.find("toString", 1)).toBeNull();
  });

  test("a file with no anime in it is a failure, not an empty database", async () => {
    await expect(animeDb.buildIndex(lines([JSON.stringify(HEADER)]))).rejects.toThrow("the anime database listed no anime");
  });

  test("nothing is found before it is loaded", () => {
    expect(animeDb.find("kitsu", 45398)).toBeNull();
    expect(animeDb.status()).toEqual({ loaded: false });
  });
});

describe("loading", () => {
  test("downloads the database, line by line", async () => {
    const fetch = routeFetch([["anime-offline-database", () => download(LINES)]]);
    expect(await animeDb.refresh()).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(animeDb.DATASET_URL);
    expect(animeDb.status()).toMatchObject({ loaded: true, anime: 2 });
    expect(console.log).toHaveBeenCalledWith("[anime] 2 anime loaded");
  });

  test("a failed download keeps the database already loaded, and says so", async () => {
    routeFetch([["anime-offline-database", () => download(LINES)]]);
    await animeDb.refresh();
    routeFetch([["anime-offline-database", response(null, { status: 503 })]]);
    expect(await animeDb.refresh()).toBe(false);
    expect(animeDb.find("mal", 50265).title).toBe("SPY x FAMILY");
    expect(warn).toHaveBeenCalledWith(
      "[anime] could not load the anime database, looking anime up on Kitsu and AniList meanwhile: the anime database returned HTTP 503"
    );
  });

  test("a response with no body is a failure", async () => {
    routeFetch([["anime-offline-database", { ok: true, status: 200, body: null, json: async () => null }]]);
    expect(await animeDb.refresh()).toBe(false);
    expect(animeDb.status()).toEqual({ loaded: false });
  });

  test("two refreshes at once share one download", async () => {
    const fetch = routeFetch([["anime-offline-database", () => download(LINES)]]);
    const [a, b] = await Promise.all([animeDb.refresh(), animeDb.refresh()]);
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
    routeFetch([["anime-offline-database", () => (calls++, download(LINES))]]);
    animeDb.start({ refreshMs: 10, retryMs: 1e9 });
    await until(() => calls >= 2);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(animeDb.status().loaded).toBe(true);
    animeDb.stop();
  });

  test("after a failure, tries again sooner", async () => {
    let calls = 0;
    routeFetch([["anime-offline-database", () => (calls++, response(null, { status: 500 }))]]);
    animeDb.start({ refreshMs: 1e9, retryMs: 10 });
    await until(() => calls >= 2);
    expect(calls).toBeGreaterThanOrEqual(2);
    animeDb.stop();
  });

  test("stopped while loading, it schedules nothing more", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    global.fetch = jest.fn(async () => {
      await gate;
      return download(LINES);
    });
    animeDb.start({ refreshMs: 5, retryMs: 5 });
    await until(() => global.fetch.mock.calls.length >= 1);
    animeDb.stop();
    release();
    await until(() => animeDb.status().loaded);
    await new Promise((r) => setTimeout(r, 40));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("with no options, weekly", async () => {
    routeFetch([["anime-offline-database", () => download(LINES)]]);
    animeDb.start();
    await until(() => animeDb.status().loaded);
    expect(animeDb.status().loaded).toBe(true);
    animeDb.stop();
  });
});

test("credits the database as its licence asks", () => {
  expect(animeDb.ATTRIBUTION).toBe("Anime names and ids from the anime offline database, under the Open Database License (ODbL 1.0)");
  expect(animeDb.SOURCE_URL).toBe("https://github.com/manami-project/anime-offline-database");
  expect(Object.keys(animeDb.SITES)).toEqual(["kitsu", "mal", "anilist", "anidb"]);
});
