/**
 * The matching rules against a live run of the real YouTube Data API.
 *
 * test/fixtures/live-api-searches.json holds what search.list + videos.list
 * returned for the exact queries the addon sent, with the metadata it
 * resolved, captured from a live run against a real key. Each case states
 * what a person checking those 50 results by hand wants back.
 */
const { durationWindow, evaluate, rankMatches } = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { toStreams } = require("../src/streams");
const { video, privateFixture } = require("./helpers");

// Real search results from the private youstream-fixtures repository (see
// the README, "Real-data tests"). Without them, this suite is skipped.
const fixture = privateFixture("live-api-searches.json");
const { cases } = fixture || { cases: [] };
const describe = fixture ? global.describe : global.describe.skip;
const test = fixture ? global.test : global.test.skip;

function run(id, settingsOverride = {}, which = 0) {
  const found = cases.filter((c) => c.id === id)[which];
  const settings = normalizeConfig({ youtubeKey: "k", ...found.settings, ...settingsOverride });
  const window = durationWindow(found.title, settings);
  const evaluations = found.videos.map((v) => evaluate(video({ ...v, definition: "hd" }), found.title, window, settings));
  const matches = rankMatches(evaluations);
  return { found, settings, evaluations, matches, titles: matches.map((m) => m.video.title) };
}

describe("TVF web series: the official upload of the right episode, and nothing else", () => {
  test.each([
    ["tt9432978:1:3", "Kota Factory - S01 E03 -  Optimization"],
    ["tt14392248:1:2", "TVF's Aspirants | S01 E02 | Teacher Sahi Hona Chahiye"],
    ["tt28227737:1:5", "Sandeep Bhaiya | Web Series | EP 05 Finale | Believe"]
  ])("%s", (id, title) => {
    expect(run(id).titles).toEqual([title]);
  });

  test("TVF links each episode's IMDb page, which is evidence in itself", () => {
    expect(run("tt28227737:1:5").matches[0].evidence).toContain("imdb link");
  });

  test("a 205-view podcast titled like the episode is kept out, by views and by name", () => {
    const { evaluations } = run("tt14392248:1:2");
    const podcast = evaluations.find((e) => e.video.title.includes("SOFTLIFE ASPIRANTs"));
    expect(podcast).toMatchObject({ ok: false, reason: "too few views" });
    // "SOFTLIFE ASPIRANTs" is another name that ends in the show's.
    const unfloored = run("tt14392248:1:2", { minViews: 0 }).evaluations.find((e) => e.video.id === podcast.video.id);
    expect(unfloored).toMatchObject({ ok: false, reason: "does not name the title" });
  });

  test("TVF Pitchers, which has left YouTube, finds nothing among its reactions", () => {
    const { matches, evaluations } = run("tt4742876:1:3");
    expect(matches).toEqual([]);
    expect(evaluations.filter((e) => /reaction|revisit/.test(e.reason || "")).length).toBeGreaterThanOrEqual(10);
  });
});

describe("films", () => {
  test("Charade: the most-watched genuine upload first", () => {
    const { matches } = run("tt0056923");
    expect(matches).toHaveLength(5);
    expect(matches[0].video).toMatchObject({ id: "VhGNhwOtbVs", channelTitle: "Cult Cinema Classics" });
  });

  test("Night of the Living Dead: genuine uploads within a minute of the runtime", () => {
    const { matches } = run("tt0063350");
    expect(matches.length).toBeGreaterThanOrEqual(5);
    matches.slice(0, 5).forEach((m) => expect(Math.abs(m.offsetSeconds)).toBeLessThan(60));
  });

  test("The Shawshank Redemption, not on YouTube, finds nothing -- not even a partner's video essay titled like the film", () => {
    const { matches, evaluations } = run("tt0111161");
    expect(matches).toEqual([]);
    expect(evaluations.find((e) => e.video.channelTitle === "Reel Mechanics").reason).toBe('description says "video essay"');
  });

  test("Vivah: Rajshri's own Tamil upload first", () => {
    expect(run("tt0494290").matches[0].video.channelTitle).toBe("Rajshri Tamil");
  });

  test("Vivah: Rajshri's Telugu upload, 16 minutes short, is inside the official channels' margin", () => {
    const { matches, evaluations } = run("tt0494290");
    expect(evaluations.find((e) => e.video.channelTitle === "Rajshri Telugu").reason).not.toBe("wrong length");
    expect(matches.every((m) => m.video.views >= 1000)).toBe(true);
  });

  test("Vivah's 'Review & Facts' uploads are all turned away, at any margin", () => {
    run("tt0494290", { movieMargin: "20%" })
      .evaluations.filter((e) => /review|fact/i.test(e.video.title))
      .forEach((e) => expect(e.ok).toBe(false));
  });
});

describe("anime through Kitsu: Muse India's Spy x Family S1E3", () => {
  test("every official upload of episode 3, by the publisher's own numbering, and no other episode or season", () => {
    const { matches, evaluations } = run("kitsu:45398:3");
    expect(matches.map((m) => m.video.channelTitle).sort()).toEqual(["Muse Hindi Dub", "Muse India", "Muse India", "Muse India"]);
    matches.forEach((m) => {
      expect(m.video.title).toMatch(/Episode 03/);
      expect(m.evidence).toContain("official numbering");
    });
    expect(evaluations.filter((e) => e.reason === "season 3").length).toBeGreaterThan(5);
  });

  test("English audio: only the English dub, though YouTube tags it Japanese", () => {
    expect(run("kitsu:45398:3", { audioLanguage: "en" }).titles).toEqual(["SPY×FAMILY - Episode 03 (S1E03) [English Dub]"]);
  });

  test("Hindi audio: both Hindi dubs, though YouTube tags one of them English", () => {
    const { titles } = run("kitsu:45398:3", { audioLanguage: "hi" });
    expect(titles).toHaveLength(2);
    titles.forEach((t) => expect(t).toMatch(/Hindi dub/i));
  });

  test("the stream row names the language the title declares", () => {
    const { matches, settings } = run("kitsu:45398:3");
    const hindiDub = matches.find((m) => m.video.title.endsWith("[Hindi dub]"));
    expect(hindiDub.video.language).toBe("en");
    expect(toStreams([hindiDub], settings)[0].description).toContain("Hindi");
  });
});
