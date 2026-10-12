/**
 * The matching rules against a live run of the real YouTube Data API.
 *
 * test/fixtures/live-api-searches.json holds what search.list + videos.list
 * returned for the exact queries the addon sent, with the metadata it
 * resolved, captured from a live run against a real key. Each case states
 * what a person checking those 50 results by hand wants back.
 */
const { cases } = require("./fixtures/live-api-searches.json");
const { durationWindow, evaluate, rankMatches } = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { toStreams } = require("../src/streams");
const { video } = require("./helpers");

function run(id, settingsOverride = {}, which = 0) {
  const found = cases.filter((c) => c.id === id)[which];
  const settings = normalizeConfig({ youtubeKey: "k", ...found.settings, ...settingsOverride });
  const window = durationWindow(found.title, settings);
  const evaluations = found.videos.map((v) => evaluate(video({ ...v, publishedAt: null, definition: "hd" }), found.title, window, settings));
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

  test("a 205-view podcast titled like the episode is kept out by the view minimum", () => {
    const { evaluations } = run("tt14392248:1:2");
    const podcast = evaluations.find((e) => e.video.title.includes("SOFTLIFE ASPIRANTs"));
    expect(podcast).toMatchObject({ ok: false, reason: "too few views" });
    // Every other check passed it: with the floor off, it would be listed.
    expect(run("tt14392248:1:2", { minViews: 0 }).titles).toContain(podcast.video.title);
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

  test("Night of the Living Dead: five genuine uploads within a minute of the runtime", () => {
    const { matches } = run("tt0063350");
    expect(matches.length).toBeGreaterThanOrEqual(5);
    matches.slice(0, 5).forEach((m) => expect(Math.abs(m.offsetSeconds)).toBeLessThan(60));
  });

  test("The Shawshank Redemption, not on YouTube, finds nothing", () => {
    expect(run("tt0111161").matches).toEqual([]);
  });

  test("Vivah: Rajshri's own Tamil upload, just inside the default margin", () => {
    expect(run("tt0494290").matches[0].video.channelTitle).toBe("Rajshri Tamil");
  });

  test("Vivah at a 15% margin: Rajshri's Telugu upload, 16 minutes short, joins; the misspelt fake does not", () => {
    const { matches, evaluations } = run("tt0494290", { movieMargin: "15%" });
    expect(matches.map((m) => m.video.channelTitle)).toContain("Rajshri Telugu");
    const fake = evaluations.find((e) => e.video.title.includes("Full Explaine & Ditails"));
    expect(fake).toMatchObject({ ok: false, reason: 'says "explaine"' });
  });

  test("Vivah's 'Review & Facts' uploads are all turned away", () => {
    run("tt0494290", { movieMargin: "15%" })
      .evaluations.filter((e) => /review|fact/i.test(e.video.title))
      .forEach((e) => expect(e.ok).toBe(false));
  });
});

describe("anime through Kitsu: Muse India's Spy x Family S1E3", () => {
  test("every official upload of episode 3, and no other episode or season", () => {
    const { matches, evaluations } = run("kitsu:45398:3");
    expect(matches.map((m) => m.video.channelTitle).sort()).toEqual(["Muse Hindi Dub", "Muse India", "Muse India", "Muse India"]);
    matches.forEach((m) => expect(m.video.title).toMatch(/Episode 03/));
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
