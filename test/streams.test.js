const { toStreams, buildStream, optionsFor } = require("../src/streams");
const { normalizeConfig } = require("../src/config");
const { video } = require("./helpers");

const EPISODE = {
  isEpisode: true,
  title: "Example Show",
  year: 2019,
  season: 1,
  episode: 3,
  episodeTitle: "The Exam",
  sources: ["cinemeta"]
};
const FILM = { isEpisode: false, title: "Example Film", year: 1968, sources: ["cinemeta"] };

const match = (overrides = {}, extra = {}) => ({
  ok: true,
  score: 120,
  offsetSeconds: -20,
  video: video({
    id: "abcdefghijk",
    title: "Example Show - S01 E03",
    channelTitle: "Indie Series",
    channelId: "UCindie",
    durationSeconds: 2211,
    views: 4500000,
    language: "hi",
    publishedAt: "2019-04-30T10:28:12Z",
    ...overrides
  }),
  ...extra
});
const context = (settings = {}, title = EPISODE) => ({ title, settings: normalizeConfig(settings) });

describe("buildStream", () => {
  test("in-app playback is the bare ytId and nothing else that could play", () => {
    const stream = buildStream("app", match(), context());
    expect(stream.ytId).toBe("abcdefghijk");
    expect(stream.url).toBeUndefined();
    expect(stream.externalUrl).toBeUndefined();
    expect(stream.name).toBe("▶️ YouStream HD");
  });

  test("the hints AIOStreams reads before anything in the text", () => {
    expect(buildStream("app", match(), context()).behaviorHints).toEqual({
      bingeGroup: "youstream-app-UCindie",
      filename: "Example Show (2019) S01E03 HD WEB-DL Hindi",
      duration: 2211,
      publishDate: "2019-04-30T10:28:12Z",
      indexer: "YouTube"
    });
  });

  test("the YouTube app gets a watch URL", () => {
    const stream = buildStream("youtube", match(), context());
    expect(stream.externalUrl).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(stream.ytId).toBeUndefined();
    expect(stream.name).toBe("📱 YouStream HD");
  });

  test("SmartTube gets vnd.youtube", () => {
    expect(buildStream("smarttube", match(), context()).externalUrl).toBe("vnd.youtube:abcdefghijk");
  });

  test("by default the description says what it is, the video, how long, whose, what language and how it plays", () => {
    const { description, title } = buildStream("app", match(), context());
    expect(description.split("\n")).toEqual([
      "📡 Example Show (2019) • S01E03 • The Exam",
      "🎬 Example Show - S01 E03",
      "🎞️ HD • ⏱️ 36m 51s (−20s)",
      "📺 Indie Series • 👁 4.5M • 📅 30 Apr 2019",
      "🎧 Hindi",
      "▶️ Play in app"
    ]);
    expect(title).toBe(description);
  });

  test("a film, from an official channel", () => {
    const { description, behaviorHints } = buildStream("app", match({ title: "Example Film (1968)", licensed: true, language: "en" }, { offsetSeconds: 0 }), context({}, FILM));
    expect(description.split("\n").slice(0, 4)).toEqual([
      "🍿 Example Film (1968)",
      "🎬 Example Film (1968)",
      "🎞️ HD • ⏱️ 36m 51s (exact)",
      "📺 Indie Series ✓ • 👁 4.5M • 📅 30 Apr 2019"
    ]);
    expect(behaviorHints.filename).toBe("Example Film (1968) HD WEB-DL English");
  });

  test("an SD video, from a channel with no id or name, with nothing else known", () => {
    const stream = buildStream(
      "youtube",
      match({ definition: "sd", channelId: "", channelTitle: "", views: null, language: null, publishedAt: null }, { offsetSeconds: null }),
      context()
    );
    expect(stream.name).toBe("📱 YouStream SD");
    expect(stream.behaviorHints).toEqual({
      bingeGroup: "youstream-youtube",
      filename: "Example Show (2019) S01E03 SD WEB-DL",
      duration: 2211,
      indexer: "YouTube"
    });
    expect(stream.description.split("\n").slice(2)).toEqual(["🎞️ SD • ⏱️ 36m 51s", "📺 YouTube", "📱 YouTube app"]);
  });

  test("an age-restricted video says where it opens", () => {
    expect(buildStream("youtube", match({ ageRestricted: true }), context()).description).toContain(
      "🔞 Age-restricted: opens in YouTube, where you are signed in"
    );
  });

  test("the reader's own templates, and a preset", () => {
    const own = buildStream("app", match(), context({ nameTemplate: "{addon.name} {stream.resolution}", descriptionTemplate: "{video.title::upper}" }));
    expect(own.name).toBe("YouStream 720p");
    expect(own.description).toBe("EXAMPLE SHOW - S01 E03");
    const compact = buildStream("app", match(), context({ format: "compact" }));
    expect(compact.name).toBe("YouStream HD");
    expect(compact.description).toBe("▶️ Example Show - S01 E03\n⏱️ 36m • 👁 4.5M • 🎧 Hindi");
  });

  test("the beta names itself", () => {
    const before = process.env.RELEASE_CHANNEL;
    process.env.RELEASE_CHANNEL = "beta";
    try {
      expect(buildStream("app", match(), context()).name).toBe("▶️ YouStream Beta HD");
    } finally {
      if (before === undefined) delete process.env.RELEASE_CHANNEL;
      else process.env.RELEASE_CHANNEL = before;
    }
  });
});

describe("optionsFor", () => {
  test("every chosen option for an ordinary video", () => {
    expect(optionsFor(match(), ["youtube", "app"])).toEqual(["youtube", "app"]);
  });

  test("no in-app row for an age-restricted video", () => {
    expect(optionsFor(match({ ageRestricted: true }), ["app", "smarttube"])).toEqual(["smarttube"]);
  });

  test("an age-restricted video still gets a row when in-app is the only choice", () => {
    expect(optionsFor(match({ ageRestricted: true }), ["app"])).toEqual(["youtube"]);
  });
});

describe("toStreams", () => {
  test("for each video, best first, one row per way of watching, in the reader's order", () => {
    const settings = normalizeConfig({ playback: ["youtube", "app"] });
    const streams = toStreams([match({ id: "first______" }), match({ id: "second_____" })], settings, EPISODE);
    expect(streams.map((s) => s.ytId || s.externalUrl)).toEqual([
      "https://www.youtube.com/watch?v=first______",
      "first______",
      "https://www.youtube.com/watch?v=second_____",
      "second_____"
    ]);
  });

  test("no matches, no rows", () => {
    expect(toStreams([], normalizeConfig({}), EPISODE)).toEqual([]);
  });
});
