/**
 * The matching rules against real searches.
 *
 * test/fixtures/real-searches.json holds real Cinemeta metadata and the real
 * YouTube results for the exact query the addon sends, each video with the
 * fields videos.list returns for it. Each case states what a person
 * checking those results by hand wants back -- the one official upload of an
 * episode, nothing at all for a title that is not on YouTube -- so a change
 * that trades a real match for a false one shows up here.
 */
const { durationWindow, evaluate, rankMatches, inWindow } = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { buildQuery } = require("../src/finder");
const { video, privateFixture } = require("./helpers");

// Real search results from the private youstream-fixtures repository (see
// the README, "Real-data tests"). Without them, this suite is skipped.
const fixture = privateFixture("real-searches.json");
const { cases } = fixture || { cases: [] };
const describe = fixture ? global.describe : global.describe.skip;
const test = fixture ? global.test : global.test.skip;

const SETTINGS = normalizeConfig({ youtubeKey: "k" });

function run(id, { settings = SETTINGS, title: override = {} } = {}) {
  const found = cases.find((c) => c.id === id);
  const title = { ...found.title, ...override };
  const window = durationWindow(title, settings);
  const evaluations = found.videos.map((v) => evaluate(video({ ...v, definition: "hd" }), title, window, settings));
  return { found, title, evaluations, matches: rankMatches(evaluations).map((e) => e.video) };
}

describe("official uploads of web series are found, and only the right episode", () => {
  test.each([
    ["tt9432978:1:3", "Kota Factory - S01 E03 -  Optimization"],
    ["tt14392248:1:3", "TVF's Aspirants | S01 E03 | Positive Approach Rakh Yaar"],
    ["tt28227737:1:3", "Sandeep Bhaiya | Web Series | EP 03 | All In"]
  ])("%s", (id, uploadTitle) => {
    const { matches } = run(id);
    expect(matches.map((v) => v.title)).toEqual([uploadTitle]);
    expect(matches[0].channelTitle).toBe("The Viral Fever");
  });

  test("the other episodes of the same show, on the same channel, are each turned away by number", () => {
    const { evaluations } = run("tt9432978:1:3");
    const reasons = evaluations.filter((e) => e.video.channelTitle === "The Viral Fever" && !e.ok).map((e) => e.reason);
    expect(reasons).toEqual(expect.arrayContaining(["episode 4", "episode 5", "episode 1"]));
  });

  test("an unofficial upload with nothing to show which show it is from is not offered", () => {
    const { found, title, matches, evaluations } = run("tt10530900:1:5");
    expect(matches).toEqual([]);
    const upload = found.videos.find((v) => v.title.startsWith("Gullak season 1episode 5"));
    // As titled, "1episode" runs the name into a word it does not allow beside it.
    expect(evaluations.find((e) => e.video.id === upload.id).reason).toBe("does not name the title");
    // Spelled out properly, it names the show and the episode, and still
    // shows nothing -- no year, cast or episode title -- that it is this show.
    const spaced = { ...upload, title: upload.title.replace("1episode", "1 episode"), definition: "hd" };
    const window = durationWindow(title, SETTINGS);
    expect(evaluate(video(spaced), title, window, SETTINGS).reason).toBe("no year, credits or episode title");
  });
});

describe("a title that is not on YouTube finds nothing, however many lookalikes there are", () => {
  test("TVF Pitchers: reactions, revisits and rewinds, several of the right length", () => {
    const { matches, evaluations } = run("tt4742876:1:3");
    expect(matches).toEqual([]);
    const revisit = evaluations.find((e) => e.video.title.startsWith("SERIES REVISIT: TVF PITCHERS | S1E3"));
    expect(revisit).toMatchObject({ ok: false, reason: 'says "revisit"' });
  });

  test("The Shawshank Redemption: reviews, explainers and a video essay posing as the full film", () => {
    expect(run("tt0111161").matches).toEqual([]);
  });
});

describe("films", () => {
  test("Hum Aapke Hain Koun: Rajshri's own Telugu upload, 18 minutes short, and none of the 'Review And Facts' fakes", () => {
    const { matches, evaluations } = run("tt0110076");
    expect(matches.map((v) => v.channelTitle)).toEqual(["Rajshri Telugu"]);
    const fakes = evaluations.filter((e) => /review|facts|analysis/i.test(e.video.title));
    expect(fakes.length).toBeGreaterThan(5);
    fakes.forEach((e) => expect(e.ok).toBe(false));
  });

  test("Night of the Living Dead: many genuine uploads, every one naming the film and its year or cast", () => {
    const { matches } = run("tt0063350");
    expect(matches.length).toBeGreaterThanOrEqual(10);
    matches.forEach((v) => expect(v.title.toLowerCase()).toContain("living dead"));
  });
});

describe("why an episode's own runtime matters", () => {
  // TVF Tripling S2E1 runs 35m 36s; the show's usual length is 26 minutes.
  const LENGTH = 35 * 60 + 36;

  test("against the show's usual length, an upload as long as the episode is the wrong length", () => {
    const { matches, evaluations } = run("tt6005644:2:1");
    const asLong = evaluations.filter((e) => e.video.durationSeconds === LENGTH);
    expect(asLong.length).toBeGreaterThan(0);
    asLong.forEach((e) => expect(e.reason).toBe("wrong length"));
    expect(matches).toEqual([]);
  });

  test("against the episode's own runtime, that length is inside the window", () => {
    const { title } = run("tt6005644:2:1", { title: { runtimeSeconds: 36 * 60, runtimeKind: "exact" } });
    expect(inWindow({ durationSeconds: LENGTH }, durationWindow(title, SETTINGS))).toBe(true);
  });
});

test("the fixtures were captured with the query the addon sends today", () => {
  cases.forEach((c) => expect(buildQuery(c.title, SETTINGS)).toBe(c.query));
});
