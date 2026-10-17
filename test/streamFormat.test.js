const {
  streamScope,
  renderStreamText,
  previewData,
  releaseName,
  guardName,
  plainText,
  ageText,
  formatter,
  PRESETS,
  SAMPLES,
  DEFAULT_FORMAT,
  FORMATTER_LANGUAGES,
  LANGUAGE_FLAGS,
  MAX_NAME,
  MAX_DESCRIPTION
} = require("../src/streamFormat");
const { normalizeConfig } = require("../src/config");
const { video } = require("./helpers");

const NOW = Date.parse("2026-10-17T00:00:00Z");
const FILM = { isEpisode: false, title: "Example Film", year: 1968, released: "1968-10-01", runtimeSeconds: 5760, aliases: ["Film, The"], sources: ["cinemeta"] };
const EPISODE = { isEpisode: true, title: "Example Show", year: 2019, season: 1, episode: 3, episodeTitle: "The Exam", absoluteEpisode: 3, seasonCount: 2, sources: ["cinemeta", "tvdb"] };
const ANIME = { isEpisode: true, title: "Example Anime", year: 2022, season: 1, episode: 7, sources: ["kitsu"] };

const scopeFor = (overrides = {}, extra = {}, title = FILM, settings = {}, optionId = "app") =>
  streamScope({
    optionId,
    match: { offsetSeconds: -51, video: video({ title: "Example Film (1968) | Full Movie", language: "en", ...overrides }), ...extra },
    title,
    settings,
    addonName: "YouStream",
    now: NOW
  });

describe("releaseName", () => {
  test("a film: its title, its year, HD or SD, WEB-DL, the language", () => {
    expect(releaseName(FILM, { definition: "hd" }, "en")).toBe("Example Film (1968) HD WEB-DL English");
    expect(releaseName({ ...FILM, year: null }, { definition: "sd" }, null)).toBe("Example Film SD WEB-DL");
  });

  test("an episode carries the show's first year and its number", () => {
    expect(releaseName(EPISODE, { definition: "hd" }, "hi")).toBe("Example Show (2019) S01E03 HD WEB-DL Hindi");
    expect(releaseName({ ...EPISODE, season: 12, episode: 104 }, { definition: "hd" }, "xx")).toBe("Example Show (2019) S12E104 HD WEB-DL");
  });

  test("a title with anything AIOStreams could misread is cleared first", () => {
    expect(releaseName({ ...FILM, title: "Two  Sizes 2 GB 🇬🇧" }, { definition: "hd" }, null)).toBe("Two Sizes 2 \u2060GB (1968) HD WEB-DL");
  });
});

describe("guardName", () => {
  test.each([
    ["EN", "E⁠N"],
    ["Hindi EN", "Hindi E⁠N"],
    ["(TB)", "(T⁠B)"],
    ["DR Films", "D⁠R Films"],
    ["Real Debrid", "R⁠eal Debrid"],
    ["put.io", "p⁠ut.io"],
    ["Web-dl", "Web-dl"],
    ["WEBDL DL", "WEBDL D⁠L"],
    ["Trend STAR", "Trend STAR"],
    ["YouStream HD", "YouStream HD"]
  ])("%p", (text, guarded) => {
    expect(guardName(text)).toBe(guarded);
  });
});

describe("plainText", () => {
  test("flags, seeders' emojis and sizes are taken out of free text", () => {
    expect(plainText("🇮🇳 Film 👤 12 👥 [1.5GB] 700 mb x   y")).toBe("Film 12 [1.5⁠GB] 700 ⁠mb x y");
    expect(plainText("2 GBP stays")).toBe("2 GBP stays");
    expect(plainText(null)).toBe("");
  });
});

test("ageText reads hours under a day, days after", () => {
  expect(ageText(5.7)).toBe("5h");
  expect(ageText(-1)).toBe("0h");
  expect(ageText(49)).toBe("2d");
});

describe("streamScope", () => {
  test("a film's fields, under AIOStreams' names", () => {
    const s = scopeFor({ licensed: true, views: 338000, publishedAt: "2026-10-16T00:00:00Z", durationSeconds: 5709 });
    expect(s.addon).toEqual({ name: "YouStream", presetId: "youstream", manifestUrl: null });
    expect(s.config).toEqual({ addonName: "YouStream" });
    expect(s.play).toEqual({ id: "app", label: "Play in app", icon: "▶️" });
    expect(s.video).toMatchObject({
      title: "Example Film (1968) | Full Movie",
      channel: "A Channel",
      official: true,
      ageRestricted: false,
      definition: "HD",
      views: "338K",
      viewCount: 338000,
      uploaded: "2026-10-16",
      length: "1h 35m 09s",
      offset: "−51s",
      offsetSeconds: -51,
      language: "English",
      url: "https://www.youtube.com/watch?v=vid00000001"
    });
    expect(s.stream).toMatchObject({
      type: "youtube",
      indexer: "YouTube",
      filename: "Example Film (1968) HD WEB-DL English",
      title: "Example Film",
      year: "1968",
      resolution: "720p",
      quality: "WEB-DL",
      duration: 5709000,
      languages: ["English"],
      languageEmojis: ["🇬🇧"],
      languageCodes: ["EN"],
      smallLanguageCodes: ["ᴇɴ"],
      uLanguages: [],
      seasonEpisode: [],
      formattedSeasons: null,
      age: "1d",
      ageHours: 24,
      size: null,
      seeders: null,
      message: null
    });
    expect(s.metadata).toMatchObject({
      queryType: "movie",
      type: "movie",
      isAnime: false,
      title: "Example Film",
      titles: ["Example Film", "Film, The"],
      year: 1968,
      runtime: 96,
      episodeRuntime: null,
      season: null,
      daysSinceRelease: 21200
    });
    expect(s.service).toEqual({ id: null, shortName: null, name: null, cached: null });
  });

  test("an episode, and an anime episode", () => {
    const e = scopeFor({}, {}, EPISODE, {}, "smarttube");
    expect(e.stream).toMatchObject({
      type: "external",
      seasons: [1],
      episodes: [3],
      seasonEpisode: ["S01", "E03"],
      formattedSeasons: "S01",
      formattedEpisodes: "E03"
    });
    expect(e.metadata).toMatchObject({
      queryType: "series",
      type: "series",
      season: 1,
      episode: 3,
      absoluteEpisode: 3,
      episodeTitle: "The Exam",
      episodeTitles: ["The Exam"],
      latestSeason: 2,
      runtime: null,
      episodeRuntime: null,
      daysSinceRelease: null,
      titles: ["Example Show"]
    });
    expect(e.play.icon).toBe("📺");
    const a = scopeFor({}, {}, ANIME);
    expect(a.metadata).toMatchObject({ queryType: "anime.series", isAnime: true, episodeTitle: null, episodeTitles: [], latestSeason: null, absoluteEpisode: null });
  });

  test("the language matching settled on, and the reader's own", () => {
    const s = scopeFor({ language: "en" }, { language: "hi" }, FILM, normalizeConfig({ audioLanguage: "hi" }));
    expect(s.stream).toMatchObject({ languages: ["Hindi"], uLanguages: ["Hindi"], uLanguageCodes: ["HI"], uLanguageEmojis: ["🇮🇳"], uSmallLanguageCodes: ["ʜɪ"] });
    expect(s.user.languages).toEqual(["Hindi"]);
    const tamil = scopeFor({ language: "ta" });
    expect(tamil.stream).toMatchObject({ languages: ["Tamil"], languageEmojis: [], languageCodes: ["TA"] });
  });

  test("what YouTube does not say is empty, never missing", () => {
    const s = scopeFor({ language: null, views: null, publishedAt: null, channelTitle: "", definition: "sd", ageRestricted: true }, { offsetSeconds: undefined }, { ...FILM, aliases: undefined, runtimeSeconds: null, released: null, year: null });
    expect(s.video).toMatchObject({ language: null, views: null, viewCount: null, uploaded: null, channel: "YouTube", offset: null, offsetSeconds: null, definition: "SD" });
    expect(s.stream).toMatchObject({ languages: [], age: null, ageHours: null, resolution: "480p", year: null, message: "Age-restricted: opens in YouTube, where you are signed in" });
    expect(s.metadata).toMatchObject({ runtime: null, year: null, daysSinceRelease: null, titles: ["Example Film"] });
  });

  test("an unreadable upload date is no age at all", () => {
    expect(scopeFor({ publishedAt: "soon" }).stream.age).toBeNull();
  });
});

describe("the presets", () => {
  const sample = (key, optionId = "app") =>
    streamScope({ optionId, ...SAMPLES[key], settings: {}, addonName: "YouStream", now: NOW });

  test.each(Object.keys(PRESETS))("%s renders a film and an episode, every row, without an error", (id) => {
    for (const key of Object.keys(SAMPLES)) {
      for (const optionId of ["app", "youtube", "smarttube"]) {
        const { name, description } = renderStreamText(sample(key, optionId), PRESETS[id] && { nameTemplate: PRESETS[id].name, descriptionTemplate: PRESETS[id].description });
        expect(name).not.toMatch(/\{(unknown|cannot)_/);
        expect(description).not.toMatch(/\{(unknown|cannot)_/);
        expect(name.length).toBeGreaterThan(0);
        expect(description.split("\n").length).toBeGreaterThan(1);
        // Nothing AIOStreams would misread: no seeders' emoji, no size.
        expect(description).not.toMatch(/[👤👥]|\d\s?[KMGT]B/u);
      }
    }
  });

  test("the default", () => {
    expect(DEFAULT_FORMAT).toBe("youstream");
    const settings = { nameTemplate: PRESETS.youstream.name, descriptionTemplate: PRESETS.youstream.description };
    expect(renderStreamText(sample("film"), settings)).toEqual({
      name: "▶️ YouStream HD",
      description: [
        "🍿 Example Film (1968)",
        "🎬 Example Film (1968) | Full Movie | Restored",
        "🎞️ HD • ⏱️ 1h 35m 09s (−51s)",
        "📺 Classic Films ✓ • 👁 338K • 📅 16 Oct 2023",
        "🎧 English",
        "▶️ Play in app"
      ].join("\n")
    });
    expect(renderStreamText(sample("episode", "youtube"), settings).description.split("\n")[0]).toBe("📡 Example Show (2019) • S01E03 • The Exam");
  });

  test("Tamtaro style marks a YouTube row and an external one", () => {
    const settings = { nameTemplate: PRESETS.tamtaro.name, descriptionTemplate: PRESETS.tamtaro.description };
    expect(renderStreamText(sample("film"), settings).name).toBe("720P ⁽ʸᵗ⁾\n  〈Web-dl〉");
    expect(renderStreamText(sample("film", "youtube"), settings).name).toBe("720P ⁽ᵉˣᵗ⁾\n  〈Web-dl〉");
    expect(renderStreamText(sample("episode"), settings).description.split("\n")[0]).toBe("✎  Example Show (2019)  s₀₁·ᴇ₀₃");
  });
});

describe("renderStreamText", () => {
  const s = () => streamScope({ optionId: "app", ...SAMPLES.film, settings: {}, addonName: "YouStream", now: NOW });

  test("a template that renders to nothing falls back to the addon's name and the video's title", () => {
    expect(renderStreamText(s(), { nameTemplate: "{stream.size}", descriptionTemplate: "{stream.seeders}" })).toEqual({
      name: "YouStream",
      description: "Example Film (1968) | Full Movie | Restored"
    });
  });

  test("a name's values are guarded, and both are bounded", () => {
    const scope = s();
    scope.video.channel = "EN Films";
    const { name, description } = renderStreamText(scope, { nameTemplate: "EN {video.channel} {'x'::replace('x','{stream.filename}')}", descriptionTemplate: "{video.channel}" });
    expect(name).toBe("EN E⁠N Films {stream.filename}");
    expect(description).toBe("EN Films");
    const long = renderStreamText(s(), { nameTemplate: "{video.title}".repeat(20), descriptionTemplate: "{video.title}\n".repeat(60) });
    expect(long.name).toHaveLength(MAX_NAME);
    expect(long.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
  });
});

test("previewData: each sample's in-app fields and every way of watching", () => {
  const data = previewData("YouStream Beta", NOW);
  expect(Object.keys(data.samples)).toEqual(["film", "episode"]);
  expect(data.samples.film.addon.name).toBe("YouStream Beta");
  expect(data.samples.episode.stream.type).toBe("youtube");
  expect(data.play).toEqual({
    app: { id: "app", label: "Play in app", icon: "▶️" },
    youtube: { id: "youtube", label: "YouTube app", icon: "📱" },
    smarttube: { id: "smarttube", label: "SmartTube", icon: "📺" }
  });
  expect(typeof previewData("X").samples.film.stream.ageHours).toBe("number");
});

test("the formatter knows each language's code and, where it is safe, its flag", () => {
  expect(FORMATTER_LANGUAGES.find((l) => l.code === "hi")).toEqual({ name: "Hindi", code: "hi", flag: "🇮🇳" });
  expect(FORMATTER_LANGUAGES.find((l) => l.code === "ta")).toEqual({ name: "Tamil", code: "ta", flag: "" });
  expect(formatter.render("{'Tamil'::languageCode} {'Hindi'::languageEmoji}", {})).toBe("TA 🇮🇳");
  // A flag only where AIOStreams reads it back as the same language.
  expect(LANGUAGE_FLAGS.ta).toBeUndefined();
  expect(LANGUAGE_FLAGS.tr).toBeUndefined();
});
