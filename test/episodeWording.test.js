/**
 * Episode searches worded "{title} {s00e00}" ("Going My Home S01E02") rather
 * than the default "{title} season {season} episode {episode}": 36 live
 * searches through the YouTube Data API, the episodes of the broad sample
 * (corpus.test.js) and of shows made for YouTube or uploaded by their own
 * channels, with every video matched labelled by hand. Where that wording
 * found less than the earlier recordings, the default wording was searched
 * again the same day (episode-wording.json in youstream-fixtures).
 */
const { durationWindow, evaluate, rankMatches } = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { video, privateFixture } = require("./helpers");

// Real search results from the private youstream-fixtures repository (see
// the README, "Real-data tests"). Without them, this suite is skipped.
const fixture = privateFixture("episode-wording.json");
const { cases, labels } = fixture || { cases: [], labels: {} };
const describe = fixture ? global.describe : global.describe.skip;
const test = fixture ? global.test : global.test.skip;

const S00E00 = "{title} {s00e00}";

function matchesFor(id, wording) {
  const found = cases.find((c) => c.id === id && (c.settings.episodeQuery || null) === wording);
  const settings = normalizeConfig({ youtubeKey: "k", ...found.settings });
  const window = durationWindow(found.title, settings);
  const ranked = rankMatches(found.videos.map((v) => evaluate(video({ ...v, definition: "hd" }), found.title, window, settings)));
  return ranked.slice(0, settings.maxResults).map((m) => m.video.id);
}

describe('episodes searched as "S01E02"', () => {
  const worded = cases.filter((c) => c.settings.episodeQuery === S00E00);
  const all = worded.flatMap((c) => matchesFor(c.id, S00E00));

  test("the query is the title and the episode's code", () => {
    expect(worded.find((c) => c.id === "tt39314779:1:3").query).toBe("The Nation Wants to Guess with Gursimran Kamba S01E03");
    expect(worded).toHaveLength(36);
  });

  test("every match was checked by hand", () => {
    all.forEach((id) => expect([id, labels[id]]).toEqual([id, expect.any(String)]));
  });

  // "Champion of Champions 1 - Episode 1 | Full Episode | Taskmaster", which
  // today's wording returns and matches too.
  test("the one wrong match is the special numbered like a first episode", () => {
    expect(all.filter((id) => labels[id] === "W")).toEqual(["hGOUR26pLz0"]);
  });

  test("the official episodes are found", () => {
    expect(matchesFor("tt39314779:1:3", S00E00)).toEqual(["hMuyfGbwwZE"]);
    expect(matchesFor("tt6556992:31:2", S00E00)).toEqual(["YqugY2zTIoI"]);
    expect(matchesFor("tt4934214:1:1", S00E00)).toContain("v4YhsooE5xY");
  });

  test("shows not on YouTube still find nothing", () => {
    ["tt0903747:1:1", "tt0944947:1:1", "tt0108778:1:1", "tt4574334:1:1", "tt12004706:1:1", "tt6468322:1:1", "tt7235466:1:1"].forEach((id) =>
      expect([id, matchesFor(id, S00E00)]).toEqual([id, []])
    );
  });
});

describe("where the S01E02 wording found less than earlier recordings, the default wording the same day", () => {
  test("a show's own upload no longer returned either way: nothing found by both", () => {
    expect(matchesFor("tt4087032:30:1", null)).toEqual([]);
    expect(matchesFor("tt4087032:30:1", S00E00)).toEqual([]);
  });

  // The official upload is the first result both ways, and turned away both
  // ways: its description links another IMDb entry for the show.
  test("only an unofficial copy is lost to the S01E02 wording", () => {
    expect(matchesFor("tt14650074:1:1", null)).toEqual(["6FViIrcmBdY"]);
    expect(labels["6FViIrcmBdY"]).toBe("P");
    expect(matchesFor("tt14650074:1:1", S00E00)).toEqual([]);
  });
});
