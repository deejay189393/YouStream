/**
 * Precision across a broad sample: 79 titles, about 1,500 real YouTube
 * results, every video ever returned as a match labelled by hand.
 *
 *   films not on YouTube, which attract fakes: The Dark Knight, Oppenheimer,
 *     Spider-Man: No Way Home ...
 *   short or common names: Up, Her, It, Us, Drive, Taken, Home, Don, Heat
 *   remakes and namesakes: Don 1978 and 2006, Drishyam, Chupke Chupke
 *   Bollywood and South Indian films, official and not
 *   public-domain classics with many genuine uploads
 *   shows not on YouTube, which attract reactions and recaps: Breaking Bad,
 *     Game of Thrones, Panchayat, Mirzapur ...
 *   shows that are: TVF's and Dice Media's web series, Mr. Bean, Taarak
 *     Mehta, Malgudi Days, Pokemon
 *   names that are numbers: The 100, 9-1-1, 1899, 24
 *
 * Before the rules were rebuilt on this sample, 33 of the 147 labelled
 * matches (22%) were the wrong content. The assertions below are the
 * standard the rules are held to now.
 */
const { durationWindow, evaluate, rankMatches } = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { uniqueAliases } = require("../src/metadata");
const { variesWithinSeason } = require("../src/metadata/tvmaze");
const { video, privateFixture } = require("./helpers");

// Real search results from the private youstream-fixtures repository (see
// the README, "Real-data tests"). Without them, this suite is skipped.
const fixture = privateFixture("corpus.json");
const { cases, labels } = fixture || { cases: [], labels: {} };
const describe = fixture ? global.describe : global.describe.skip;
const test = fixture ? global.test : global.test.skip;

/**
 * The title as the resolver builds it today, from what was captured: with
 * IMDb's own runtime for a film when IMDb's data is loaded, and Cinemeta's
 * alongside where it differs; with Cinemeta's alone before then.
 */
function titleOf(c, { imdb }) {
  const title = {
    ...c.title,
    aliases: uniqueAliases(c.title.title, c.title.aliases || []),
    people: [...c.cast, ...c.director],
    imdbId: c.streamId.split(":")[0],
    otherRuntimes: []
  };
  if (imdb && !title.isEpisode && c.imdbRuntimeMinutes) {
    const listed = c.imdbRuntimeMinutes * 60;
    const cinemeta = title.runtimeSeconds;
    Object.assign(title, { runtimeSeconds: listed, otherRuntimes: cinemeta && cinemeta !== listed ? [cinemeta] : [] });
  }
  if (title.isEpisode && c.tvmaze) {
    const season = c.tvmaze.episodes;
    const ep = season.find((e) => e.number === title.episode);
    if (ep && ep.runtime && variesWithinSeason(season)) Object.assign(title, { runtimeSeconds: ep.runtime * 60, runtimeKind: "exact" });
  }
  return title;
}

function matchesFor(settings, sources) {
  return cases.map((c) => {
    const title = titleOf(c, sources);
    const s = normalizeConfig({ youtubeKey: "k", ...settings });
    const window = durationWindow(title, s);
    const evaluations = c.videos.map((v) => evaluate(video({ ...v, definition: "hd" }), title, window, s));
    return { c, matches: rankMatches(evaluations).slice(0, s.maxResults) };
  });
}

function tally(results) {
  const counts = { C: 0, P: 0, W: 0, U: 0 };
  results.forEach(({ matches }) => matches.forEach((m) => counts[labels[m.video.id]]++));
  return counts;
}

describe.each([
  ["Cinemeta's runtimes alone", { imdb: false }],
  ["IMDb's runtimes for films", { imdb: true }]
])("with the default settings, %s", (_, sources) => {
  const results = matchesFor({}, sources);
  const counts = tally(results);

  test("not one match is the wrong content", () => {
    const wrong = results.flatMap(({ c, matches }) => matches.filter((m) => labels[m.video.id] === "W").map((m) => `${c.label}: ${m.video.title}`));
    expect(wrong).toEqual([]);
  });

  test("every match was checked by hand", () => {
    results.forEach(({ matches }) => matches.forEach((m) => expect(labels[m.video.id]).toBeDefined()));
  });

  test("the unsure ones stay few", () => {
    expect(counts.U).toBeLessThanOrEqual(5);
  });

  test("official uploads and public-domain films are still found", () => {
    expect(counts.C).toBeGreaterThanOrEqual(65);
  });

  test("films not on YouTube, and shows that have left it, find nothing", () => {
    const empty = [
      "The Dark Knight (2008)",
      "Inception (2010)",
      "Titanic (1997)",
      "Avengers: Endgame (2019)",
      "Interstellar (2014)",
      "Pulp Fiction (1994)",
      "Oppenheimer (2023)",
      "Joker (2019)",
      "Spider-Man: No Way Home (2021)",
      "Her (2013)",
      "Us (2019)",
      "Taken (2008)",
      "Breaking Bad (2008) S1E1",
      "Game of Thrones (2011) S1E1",
      "Panchayat (2020) S1E1",
      "Little Things (2016) S1E1",
      "9-1-1 (2018) S1E1"
    ];
    empty.forEach((label) => expect([label, results.find((r) => r.c.label === label).matches.length]).toEqual([label, 0]));
  });

  test("official uploads of web series and classic TV are found", () => {
    ["Aspirants (2021) S1E4", "Kota Factory (2019) S1E2", "Mr. Bean (1990) S1E1", "Taarak Mehta Ka Ooltah Chashmah (2008) S1E1", "What the Folks (2017) S1E1", "Cubicles (2019) S1E1", "Malgudi Days (1987) S1E1"].forEach(
      (label) => {
        const { matches } = results.find((r) => r.c.label === label);
        expect([label, matches.some((m) => labels[m.video.id] === "C")]).toEqual([label, true]);
      }
    );
  });
});

describe.each([
  ["Cinemeta's runtimes alone", { imdb: false }],
  ["IMDb's runtimes for films", { imdb: true }]
])("with only official channels, %s", (_, sources) => {
  const results = matchesFor({ officialOnly: true }, sources);
  const counts = tally(results);

  // The one unsure match is a restored Metropolis (1927), public domain since
  // 2023, from a channel with Content ID whose description is AI boilerplate:
  // likely the film, not verified.
  test("nothing wrong, at most one unsure, and nearly nothing unofficial", () => {
    expect(counts.W).toBe(0);
    expect(counts.U).toBeLessThanOrEqual(1);
    expect(counts.P).toBeLessThanOrEqual(5);
    expect(counts.C).toBeGreaterThanOrEqual(55);
  });
});
