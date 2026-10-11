/**
 * The matching rules against real searches.
 *
 * test/fixtures/real-searches.json holds real Cinemeta metadata and the real
 * YouTube results (title, channel, length, views) for the exact query the
 * addon sends, captured while the rules were tuned. Each case below states
 * what a person checking those results by hand would want back -- the one
 * official upload of an episode, nothing at all for a title that is not on
 * YouTube -- so a change to the rules that trades a real match for a false
 * one shows up here.
 */
const { cases } = require("./fixtures/real-searches.json");
const { durationWindow, evaluate, rankMatches } = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { buildQuery } = require("../src/finder");
const { video } = require("./helpers");

const SETTINGS = normalizeConfig({ youtubeKey: "k" });

function run(id, { settings = SETTINGS, title: override = {} } = {}) {
  const found = cases.find((c) => c.id === id);
  const title = { ...found.title, ...override };
  const window = durationWindow(title, settings);
  const evaluations = found.videos.map((v) => evaluate(video({ ...v, publishedAt: null, definition: "hd" }), title, window, settings));
  return { found, title, evaluations, matches: rankMatches(evaluations).map((e) => e.video) };
}

describe("official uploads of web series are found, and only the right episode", () => {
  test.each([
    ["tt9432978:1:3", "gIwgSpEg6ZY", "Kota Factory - S01 E03 -  Optimization"],
    ["tt14392248:1:3", null, "TVF's Aspirants | S01 E03 | Positive Approach Rakh Yaar"],
    ["tt28227737:1:3", null, "Sandeep Bhaiya | Web Series | EP 03 | All In"],
    ["tt10530900:1:5", "gPx5rU82h-k", "Gullak season 1episode 5 | Raksha bandhan | full webseries "]
  ])("%s", (id, videoId, uploadTitle) => {
    const { matches } = run(id);
    expect(matches.map((v) => v.title)).toEqual([uploadTitle]);
    if (videoId) expect(matches[0].id).toBe(videoId);
  });

  test("the other episodes of the same show, on the same channel, are each turned away by number", () => {
    const { evaluations } = run("tt9432978:1:3");
    const reasons = evaluations.filter((e) => e.video.channelTitle === "The Viral Fever" && !e.ok).map((e) => e.reason);
    expect(reasons).toEqual(expect.arrayContaining(["episode 4", "episode 5", "episode 1"]));
  });
});

describe("a title that is not on YouTube finds nothing, however many lookalikes there are", () => {
  test("TVF Pitchers: reactions, revisits and rewinds, several of the right length", () => {
    const { matches, evaluations } = run("tt4742876:1:3");
    expect(matches).toEqual([]);
    const revisit = evaluations.find((e) => e.video.title.startsWith("SERIES REVISIT: TVF PITCHERS | S1E3"));
    expect(revisit).toMatchObject({ ok: false, reason: 'says "revisit"' });
  });

  test("The Shawshank Redemption: reviews and explainers posing as the full film", () => {
    expect(run("tt0111161").matches).toEqual([]);
  });

  test('Hum Aapke Hain Koun: "Full Movie | Review And Facts" uploads of feature length', () => {
    const { matches, evaluations } = run("tt0110076");
    expect(matches).toEqual([]);
    const fakes = evaluations.filter((e) => /review|facts|analysis/i.test(e.video.title));
    expect(fakes.length).toBeGreaterThan(5);
    fakes.forEach((e) => expect(e.ok).toBe(false));
  });
});

describe("a film with many genuine uploads", () => {
  test("Night of the Living Dead: every upload of the right length that names it, and nothing else", () => {
    const { matches } = run("tt0063350");
    expect(matches.length).toBeGreaterThanOrEqual(10);
    matches.forEach((v) => {
      expect(v.title.toLowerCase()).toContain("living dead");
      expect(Math.abs(v.durationSeconds - 5760)).toBeLessThanOrEqual(600);
    });
  });

  test("an audio language keeps out an upload YouTube has tagged with another one", () => {
    const settings = normalizeConfig({ audioLanguage: "en" });
    const found = cases.find((c) => c.id === "tt0063350");
    const genuine = run("tt0063350").matches[0];
    const result = evaluate(
      video({ ...genuine, language: "es", publishedAt: null }),
      found.title,
      durationWindow(found.title, settings),
      settings
    );
    expect(result).toMatchObject({ ok: false, reason: "es audio" });
  });
});

describe("why an episode's own runtime matters", () => {
  test("TVF Tripling S2E1 runs 35m 36s; against the show's usual 26 minutes it is missed", () => {
    expect(run("tt6005644:2:1").matches).toEqual([]);
  });

  test("with the episode's own runtime, as TMDB provides it, it is found", () => {
    const { matches } = run("tt6005644:2:1", { title: { runtimeSeconds: 36 * 60, runtimeKind: "exact" } });
    expect(matches.map((v) => v.id)).toEqual(["FGMhA8UY190"]);
  });
});

test("the fixtures were captured with the query the addon sends today", () => {
  cases.forEach((c) => expect(buildQuery(c.title, SETTINGS)).toBe(c.query));
});
