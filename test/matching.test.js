const {
  durationWindow,
  searchDuration,
  marginSeconds,
  parseEpisodeMarkers,
  markerWords,
  usableEpisodeTitle,
  nameMatch,
  numberAfterName,
  isSequel,
  yearVerdict,
  excludedWord,
  regionBlocked,
  evaluate,
  rankMatches,
  UNKNOWN_RUNTIME
} = require("../src/matching");
const { normalizeConfig } = require("../src/config");
const { fold } = require("../src/text");
const { video } = require("./helpers");

const SETTINGS = normalizeConfig({ youtubeKey: "k" });

const MOVIE = {
  isEpisode: false,
  title: "The Shawshank Redemption",
  aliases: [],
  year: 1994,
  runtimeSeconds: 8520,
  runtimeKind: "exact"
};

const EPISODE = {
  isEpisode: true,
  title: "Kota Factory",
  aliases: [],
  year: 2019,
  runtimeSeconds: 2220,
  runtimeKind: "exact",
  season: 1,
  episode: 3,
  absoluteEpisode: 3,
  episodeTitle: "Optimization",
  seasonCount: 3
};

describe("margins and the length window", () => {
  test("a margin in seconds, minutes or percent", () => {
    expect(marginSeconds({ value: 45, unit: "s" }, 1380)).toBe(45);
    expect(marginSeconds({ value: 10, unit: "m" }, 8520)).toBe(600);
    expect(marginSeconds({ value: 10, unit: "%" }, 3000)).toBe(300);
  });

  test("the example asked for: 23 minutes with 25 seconds accepts 22m 40s", () => {
    const title = { ...EPISODE, runtimeSeconds: 23 * 60 };
    const window = durationWindow(title, normalizeConfig({ episodeMargin: "25s" }));
    expect(window.min).toBe(23 * 60 - 25);
    expect(22 * 60 + 40).toBeGreaterThanOrEqual(window.min);
  });

  test("films use the movie margin", () => {
    expect(durationWindow(MOVIE, SETTINGS)).toEqual({
      min: 7920,
      max: 9120,
      target: 8520,
      tolerance: 600,
      margin: { value: 10, unit: "m" },
      basis: "exact"
    });
  });

  test("an episode with its own runtime uses the episode margin", () => {
    expect(durationWindow(EPISODE, SETTINGS)).toMatchObject({ min: 2175, max: 2265, basis: "exact" });
  });

  test("an episode with only the show's usual length uses the wider typical margin", () => {
    const window = durationWindow({ ...EPISODE, runtimeKind: "typical", runtimeSeconds: 3000 }, SETTINGS);
    expect(window).toMatchObject({ min: 2400, max: 3600, basis: "typical", margin: { value: 20, unit: "%" } });
  });

  test("no runtime anywhere falls back to wide bounds", () => {
    expect(durationWindow({ ...MOVIE, runtimeSeconds: null }, SETTINGS)).toEqual({
      ...UNKNOWN_RUNTIME.movie,
      target: null,
      tolerance: null,
      margin: null,
      basis: "unknown"
    });
    expect(durationWindow({ ...EPISODE, runtimeSeconds: null }, SETTINGS)).toMatchObject(UNKNOWN_RUNTIME.episode);
  });

  test("a margin wider than the runtime never goes below zero", () => {
    const window = durationWindow({ ...EPISODE, runtimeSeconds: 60 }, normalizeConfig({ episodeMargin: "5m" }));
    expect(window.min).toBe(0);
  });

  test.each([
    [{ min: 1201, max: 2000 }, "long"],
    [{ min: 1200, max: 2000 }, undefined],
    [{ min: 240, max: 1200 }, "medium"],
    [{ min: 239, max: 1200 }, undefined],
    [{ min: 10, max: 239 }, "short"],
    [{ min: 10, max: 240 }, undefined]
  ])("YouTube's length filter for %p is %p", (window, filter) => {
    expect(searchDuration(window)).toBe(filter);
  });
});

describe("parseEpisodeMarkers", () => {
  const parse = (t) => {
    const m = parseEpisodeMarkers(t);
    return { seasons: [...m.seasons], episodes: [...m.episodes], range: m.range };
  };

  test.each([
    ["Kota Factory - S01 E03 - Optimization", [1], [3]],
    ["Show S01E03", [1], [3]],
    ["Show s1ep3", [1], [3]],
    ["Show S2.E10", [2], [10]],
    ["Show 1x03", [1], [3]],
    ["Show Season 1 Episode 3", [1], [3]],
    ["Show season 1episode 5 | Raksha bandhan", [1], [5]],
    ["Show (S1) - Episode 3", [1], [3]],
    ["Sandeep Bhaiya | Web Series | EP 03 | All In", [], [3]],
    ["EP05 Finale", [], [5]],
    ["Ep. No. 7", [], [7]],
    ["Episode #4", [], [4]],
    ["Temporada 2 Capítulo 4", [2], [4]],
    ["Saison 2 Épisode 4", [2], [4]],
    ["Staffel 2 Folge 4", [2], [4]],
    ["सीज़न 2 एपिसोड 3", [2], [3]],
    ["Fast X 1080p 4k", [], []],
    ["Season finale", [], []]
  ])("%s", (title, seasons, episodes) => {
    expect(parse(title)).toEqual({ seasons, episodes, range: false });
  });

  test.each([["Episodes 1-5"], ["Ep 3 to 4"], ["E1 & E2"], ["Episode 2 – 3"]])("%s is a span of episodes", (title) => {
    expect(parse(title).range).toBe(true);
  });

  test.each([["Episode 5 - 2024"], ["Episode 5 - 3"], ["Episode 1 - 900"]])("%s is not a span", (title) => {
    expect(parse(title).range).toBe(false);
  });

  test("letters and digits are pulled apart; 1x02 is spelled out", () => {
    expect(markerWords("S01E02 2x05")).toEqual(["s", "01", "e", "02", "season", "2", "episode", "05"]);
  });
});

describe("usableEpisodeTitle", () => {
  test("a real name is kept, folded", () => {
    expect(usableEpisodeTitle("The Jury Room")).toBe("the jury room");
  });

  test.each([[null], ["Episode 3"], ["Episode #1.3"], ["Chapter 2"], ["Part 1"], ["Ep"], ["Up"]])("%p names nothing", (t) => {
    expect(usableEpisodeTitle(t)).toBeNull();
  });
});

describe("nameMatch", () => {
  const match = (names, hay) => nameMatch(names, fold(hay));

  test("the whole name as written", () => {
    expect(match(["Kota Factory"], "Kota Factory - S01 E03")).toMatchObject({ ok: true, phrase: true, coverage: 1 });
  });

  test("a short name needs every word", () => {
    expect(match(["TVF Pitchers"], "Pitchers Episode 3").ok).toBe(false);
    expect(match(["TVF Aspirants"], "TVF's Aspirants | S01 E03").ok).toBe(false);
    expect(match(["Aspirants"], "TVF's Aspirants | S01 E03").ok).toBe(true);
  });

  test("the channel name can supply a word", () => {
    expect(match(["TVF Pitchers"], "Pitchers Episode 3 TVF").ok).toBe(true);
  });

  test("a long name needs 60% of its words", () => {
    const name = ["Mission: Impossible – Dead Reckoning Part One"];
    expect(match(name, "Mission Impossible Dead Reckoning Full Movie").ok).toBe(true);
    expect(match(name, "Mission Impossible Full Movie").ok).toBe(false);
  });

  test("another name can carry the match", () => {
    const names = ["Harry Potter and the Philosopher's Stone", "Harry Potter and the Sorcerer's Stone"];
    expect(match(names, "Harry Potter and the Sorcerers Stone full movie")).toMatchObject({ ok: true, phrase: true });
    expect(match(names, "Harry Potter and the Chamber of Secrets").ok).toBe(false);
  });

  test("a name that folds to nothing is skipped", () => {
    expect(match(["!!!", "Kota Factory"], "Kota Factory").ok).toBe(true);
  });

  test("prefers a phrase match, then better coverage, then the first name", () => {
    expect(match(["Kota Season Factory", "Kota Factory"], "kota factory season 1").name).toBe("Kota Factory");
    expect(match(["Alpha Beta Gamma Delta Epsilon", "Alpha Beta Gamma"], "alpha x beta gamma").name).toBe("Alpha Beta Gamma");
    expect(match(["Kota", "Kota Factory"], "kota factory").name).toBe("Kota");
  });
});

describe("numberAfterName and sequels", () => {
  test("a number straight after the name", () => {
    expect(numberAfterName(fold("Dhoom 2 Full Movie"), ["Dhoom"])).toBe(2);
    expect(numberAfterName(fold("SPY x FAMILY - 03 [English Sub]"), ["SPY x FAMILY"])).toBe(3);
    expect(numberAfterName(fold("The Godfather II"), ["The Godfather"])).toBe(2);
    expect(numberAfterName(fold("Rocky III"), ["Rocky"])).toBe(3);
    expect(numberAfterName(fold("Rocky IV"), ["Rocky"])).toBe(4);
  });

  test("nothing when the name is followed by a word, or ends the title", () => {
    expect(numberAfterName(fold("Dhoom Full Movie"), ["Dhoom"])).toBeNull();
    expect(numberAfterName(fold("Watch Dhoom"), ["Dhoom"])).toBeNull();
    expect(numberAfterName(fold("Dhoom 2"), ["!!!"])).toBeNull();
  });

  test("a number that belongs to one of the title's names does not count", () => {
    expect(numberAfterName(fold("Pushpa 2 The Rule Full Movie"), ["Pushpa 2: The Rule", "Pushpa"])).toBeNull();
  });

  test("a sequel is 2 to 99", () => {
    expect(isSequel(fold("Dhoom 3"), ["Dhoom"])).toBe(true);
    expect(isSequel(fold("Dhoom 1"), ["Dhoom"])).toBe(false);
    expect(isSequel(fold("Dhoom 2004"), ["Dhoom"])).toBe(false);
    expect(isSequel(fold("Dhoom"), ["Dhoom"])).toBe(false);
  });
});

describe("yearVerdict", () => {
  const verdict = (title, year, upload, names = ["Don"]) => yearVerdict(fold(title), year, upload, names);

  test.each([
    ["Don (1978) Full Movie", 1978, 2020, "match"],
    ["Don (1979) Full Movie", 1978, 2020, "match"],
    ["Don Full Movie", 1978, 2020, "absent"],
    ["Don Full Movie 2024 New", 1978, 2024, "upload"],
    ["Don (2006) Full Movie", 1978, 2020, "conflict"],
    ["Don (2006) Full Movie", 1978, null, "conflict"],
    ["Don (2006) Full Movie", null, 2020, "absent"]
  ])("%s for %p", (title, year, upload, expected) => {
    expect(verdict(title, year, upload)).toBe(expected);
  });

  test("a number in the title's own name is not a year", () => {
    expect(verdict("1917 Full Movie", 2019, 2021, ["1917"])).toBe("absent");
    expect(verdict("Blade Runner 2049 (2017)", 2017, 2021, ["Blade Runner 2049"])).toBe("match");
  });
});

describe("excludedWord", () => {
  test("finds a word, or its plural", () => {
    expect(excludedWord(fold("Kota Factory Episode 3 Reaction"), ["reaction"], ["Kota Factory"])).toBe("reaction");
    expect(excludedWord(fold("Film Reviews"), ["review"], ["Film"])).toBe("review");
    expect(excludedWord(fold("Behind the Scenes"), ["behind the scenes"], ["X"])).toBe("behind the scenes");
  });

  test("a word in the title's own name is ignored", () => {
    expect(excludedWord(fold("Trailer Park Boys S01E01"), ["trailer"], ["Trailer Park Boys"])).toBeNull();
    expect(excludedWord(fold("The Reviews S01E01"), ["review"], ["The Reviews"])).toBeNull();
  });

  test("blank words are skipped", () => {
    expect(excludedWord(fold("Anything"), ["", "!!"], ["X"])).toBeNull();
  });
});

describe("audio languages", () => {
  const { titleLanguages, audioLanguages } = require("../src/matching");
  const langs = (title) => [...titleLanguages(title)];

  test.each([
    ["SPY\u00d7FAMILY - Episode 03 (S1E03) [Hindi dub]", ["hi"]],
    ["[Hindi Dub] SPY\u00d7FAMILY - Episode 03", ["hi"]],
    ["Vivah | Tamil Dubbed Hindi Movie", ["ta"]],
    ["Full Movie in English | HD", ["en"]],
    ["Dubbed in Telugu", ["te"]],
    ["Movie Explained in Bangla", ["bn"]],
    ["Full Movie Bengali Version", ["bn"]],
    ["Japanese Audio", ["ja"]],
    ["SPY\u00d7FAMILY - Episode 03 (S1E03) [English Sub]", []],
    ["Charade (1963) | Full Movie | English", []],
    ["Hindi", []]
  ])("%s declares %p", (title, codes) => {
    expect(langs(title)).toEqual(codes);
  });

  test("the title first, then YouTube's tag, and 'no linguistic content' is no language", () => {
    expect([...audioLanguages(video({ title: "X [Hindi dub]", language: "en" }))]).toEqual(["hi"]);
    expect([...audioLanguages(video({ title: "X", language: "en" }))]).toEqual(["en"]);
    expect([...audioLanguages(video({ title: "X", language: "zxx" }))]).toEqual([]);
    expect([...audioLanguages(video({ title: "X", language: null }))]).toEqual([]);
  });
});

describe("regionBlocked", () => {
  test("with no country set, nothing is blocked", () => {
    expect(regionBlocked(video({ regionBlocked: ["IN"] }), "")).toBe(false);
  });

  test("a block list or an allow list", () => {
    expect(regionBlocked(video({ regionBlocked: ["IN"] }), "IN")).toBe(true);
    expect(regionBlocked(video({ regionAllowed: ["US"] }), "IN")).toBe(true);
    expect(regionBlocked(video({ regionAllowed: ["IN"] }), "IN")).toBe(false);
    expect(regionBlocked(video({ regionBlocked: ["US"] }), "IN")).toBe(false);
  });
});

describe("evaluate: films", () => {
  const window = durationWindow(MOVIE, SETTINGS);
  const judge = (overrides, settings = SETTINGS, title = MOVIE) =>
    evaluate(video({ title: "The Shawshank Redemption (1994) Full Movie", ...overrides }), title, window, settings);

  test("a full upload of the right length matches, scored", () => {
    const result = judge({ durationSeconds: 8500 });
    expect(result).toMatchObject({ ok: true, offsetSeconds: -20, how: null });
    expect(result.score).toBeGreaterThan(100);
  });

  test.each([
    [{ live: "live" }, "live stream"],
    [{ live: "upcoming" }, "not aired yet"],
    [{ durationSeconds: null }, "no length"],
    [{ durationSeconds: 150 }, "wrong length"],
    [{ durationSeconds: 99999 }, "wrong length"],
    [{ title: "The Shawshank Redemption Trailer" }, 'says "trailer"'],
    [{ title: "Totally Different Film (1994)" }, "does not name the title"],
    [{ title: "The Shawshank Redemption (2004) Full Movie" }, "names another year"],
    [{ title: "The Shawshank Redemption 2 Full Movie" }, "a sequel"]
  ])("%p is turned away: %s", (overrides, reason) => {
    expect(judge(overrides)).toMatchObject({ ok: false, reason });
  });

  test("too few views, unless the count is hidden or the floor is off", () => {
    expect(judge({ views: 999 })).toMatchObject({ ok: false, reason: "too few views" });
    expect(judge({ views: 1000 }).ok).toBe(true);
    expect(judge({ views: null }).ok).toBe(true);
    expect(judge({ views: 3 }, normalizeConfig({ minViews: 0 })).ok).toBe(true);
  });

  test("the reader's country, audio language and embedding settings", () => {
    const settings = normalizeConfig({ region: "IN", audioLanguage: "en", embeddableOnly: true });
    expect(judge({ regionBlocked: ["IN"] }, settings)).toMatchObject({ ok: false, reason: "blocked in IN" });
    expect(judge({ language: "hi" }, settings)).toMatchObject({ ok: false, reason: "hi audio" });
    expect(judge({ embeddable: false }, settings)).toMatchObject({ ok: false, reason: "not embeddable" });
    expect(judge({ language: "zxx" }, settings).ok).toBe(true);
    expect(judge({ language: null }, settings).ok).toBe(true);
  });

  test("the reader's audio language ranks first, whether tagged or named in the title", () => {
    const settings = normalizeConfig({ audioLanguage: "en" });
    const untagged = judge({ language: null }, settings).score;
    expect(judge({ language: "en" }, settings).score).toBeGreaterThan(untagged);
    expect(judge({ title: "The Shawshank Redemption (1994) Full Movie in English" }, settings).score).toBeGreaterThan(untagged);
  });

  test("what the title declares overrides YouTube's tag, both ways", () => {
    const hindi = normalizeConfig({ audioLanguage: "hi" });
    // Measured on Muse India: the "[Hindi dub]" upload is tagged English.
    expect(judge({ title: "The Shawshank Redemption (1994) [Hindi dub]", language: "en" }, hindi)).toMatchObject({ ok: true, language: "hi" });
    expect(judge({ title: "The Shawshank Redemption (1994) [English Dub]", language: "hi" }, hindi)).toMatchObject({
      ok: false,
      reason: "en audio"
    });
  });

  test("a match reports the language it settled on", () => {
    expect(judge({ language: "zxx" })).toMatchObject({ ok: true, language: null });
    expect(judge({ language: "ta" })).toMatchObject({ ok: true, language: "ta" });
  });

  test("the right year, the whole name, HD and views all rank higher", () => {
    const plain = judge({ title: "Shawshank Redemption full movie", definition: "sd", views: null });
    expect(judge({ title: "Shawshank Redemption 1994 full movie", definition: "sd", views: null }).score).toBeGreaterThan(plain.score);
    expect(judge({ title: "The Shawshank Redemption full movie", definition: "sd", views: null }).score).toBeGreaterThan(plain.score);
    expect(judge({ title: "Shawshank Redemption full movie", definition: "hd", views: null }).score).toBeGreaterThan(plain.score);
    expect(judge({ title: "Shawshank Redemption full movie", definition: "sd", views: 1e6 }).score).toBeGreaterThan(plain.score);
  });

  test("closer to the runtime ranks higher", () => {
    expect(judge({ durationSeconds: 8520 }).score).toBeGreaterThan(judge({ durationSeconds: 8900 }).score);
  });

  test("an upload with no publish date is judged on the title's years alone", () => {
    expect(judge({ publishedAt: null, title: "The Shawshank Redemption 2020 Full Movie" })).toMatchObject({
      ok: false,
      reason: "names another year"
    });
  });

  test("with no runtime known, any length inside the wide bounds counts, with no offset", () => {
    const title = { ...MOVIE, runtimeSeconds: null };
    const result = evaluate(video({ title: "The Shawshank Redemption", durationSeconds: 5000 }), title, durationWindow(title, SETTINGS), SETTINGS);
    expect(result).toMatchObject({ ok: true, offsetSeconds: null });
  });

  test("a zero margin still scores an exact match", () => {
    const settings = normalizeConfig({ movieMargin: "0s" });
    const exact = evaluate(video({ durationSeconds: 8520, title: "The Shawshank Redemption" }), MOVIE, durationWindow(MOVIE, settings), settings);
    expect(exact.ok).toBe(true);
  });
});

describe("evaluate: episodes", () => {
  const window = durationWindow(EPISODE, SETTINGS);
  const judge = (title, overrides = {}, t = EPISODE) =>
    evaluate(video({ title, durationSeconds: 2211, channelTitle: "The Viral Fever", ...overrides }), t, window, SETTINGS);

  test("season and episode", () => {
    expect(judge("Kota Factory - S01 E03 - Optimization")).toMatchObject({ ok: true, how: "season and episode" });
  });

  test("naming the episode as well ranks higher", () => {
    expect(judge("Kota Factory - S01 E03 - Optimization").score).toBeGreaterThan(judge("Kota Factory - S01 E03").score);
  });

  test("an episode number alone, for the first season", () => {
    expect(judge("Kota Factory Episode 3", {}, { ...EPISODE, seasonCount: 3 })).toMatchObject({ ok: true, how: "episode" });
  });

  test("the episode's name alone", () => {
    expect(judge("Kota Factory | Optimization")).toMatchObject({ ok: true, how: "episode title" });
  });

  test.each([
    ["Kota Factory - S01 E04 - Shutdown", "episode 4"],
    ["Kota Factory - S02 E03", "season 2"],
    ["Kota Factory Episodes 1-5", "covers several episodes"],
    ["Kota Factory full series", "names no episode"]
  ])("%s is turned away: %s", (title, reason) => {
    expect(judge(title)).toMatchObject({ ok: false, reason });
  });

  test("a number straight after the show's name is the episode when nothing else is", () => {
    expect(judge("Kota Factory 03 [English Sub]")).toMatchObject({ ok: true, how: "episode" });
    expect(judge("Kota Factory 04 [English Sub]")).toMatchObject({ ok: false, reason: "episode 4" });
  });

  test("and the season when the title numbers the episode too", () => {
    expect(judge("Kota Factory 2 | Episode 3")).toMatchObject({ ok: false, reason: "season 2" });
    expect(judge("Kota Factory 1 | Episode 3").ok).toBe(true);
  });

  test("a three-digit number after the name is not a season", () => {
    expect(judge("Kota Factory 150 | Episode 3")).toMatchObject({ ok: true, how: "episode" });
  });

  test("a year or a large number after the name is neither", () => {
    expect(judge("Kota Factory 2019 | Episode 3").ok).toBe(true);
    expect(judge("Kota Factory 2019")).toMatchObject({ ok: false, reason: "names no episode" });
  });

  describe("a later season", () => {
    const S2 = { ...EPISODE, season: 2, episode: 1, absoluteEpisode: 6, episodeTitle: "The Valley", seasonCount: 2 };
    const w = durationWindow(S2, SETTINGS);
    const judge2 = (title, t = S2) => evaluate(video({ title, durationSeconds: 2211 }), t, w, SETTINGS);

    test("with its season stated", () => {
      expect(judge2("Kota Factory S2 E1")).toMatchObject({ ok: true, how: "season and episode" });
    });

    test("by its number across the show", () => {
      expect(judge2("Kota Factory Episode 6")).toMatchObject({ ok: true, how: "absolute episode" });
    });

    test('"Episode 1" with no season is more likely season 1\'s', () => {
      expect(judge2("Kota Factory Episode 1")).toMatchObject({ ok: false, reason: "episode number without a season" });
    });

    test("unless it also carries this episode's name", () => {
      expect(judge2("Kota Factory Episode 1 The Valley")).toMatchObject({ ok: true, how: "episode" });
    });

    test("or the show has one season", () => {
      expect(judge2("Kota Factory Episode 1", { ...S2, seasonCount: 1 }).ok).toBe(true);
      expect(judge2("Kota Factory Episode 1", { ...S2, seasonCount: null }).ok).toBe(true);
    });

    test("when the absolute number and the season's number coincide, it counts as absolute", () => {
      const t = { ...S2, episode: 3, absoluteEpisode: 3 };
      expect(judge2("Kota Factory Episode 3", t)).toMatchObject({ ok: true, how: "absolute episode" });
    });

    test("with no absolute number known, a bare number from another season is turned away", () => {
      expect(judge2("Kota Factory Episode 6", { ...S2, absoluteEpisode: null })).toMatchObject({ ok: false, reason: "episode 6" });
    });
  });
});

describe("rankMatches", () => {
  test("keeps the matches, best first", () => {
    const ranked = rankMatches([
      { ok: true, score: 100, video: { id: "a" } },
      { ok: false, reason: "x", video: { id: "b" } },
      { ok: true, score: 120, video: { id: "c" } }
    ]);
    expect(ranked.map((e) => e.video.id)).toEqual(["c", "a"]);
  });
});
