const { toStreams, buildStream, optionsFor, detailLine } = require("../src/streams");
const { normalizeConfig } = require("../src/config");
const { video } = require("./helpers");

const match = (overrides = {}, extra = {}) => ({
  ok: true,
  score: 120,
  offsetSeconds: -20,
  video: video({ id: "abcdefghijk", title: "Kota Factory - S01 E03", channelTitle: "The Viral Fever", channelId: "UCtvf", durationSeconds: 2211, views: 4500000, language: "hi", ...overrides }),
  ...extra
});

describe("buildStream", () => {
  test("in-app playback is the bare ytId and nothing else that could play", () => {
    const stream = buildStream("app", match());
    expect(stream.ytId).toBe("abcdefghijk");
    expect(stream.url).toBeUndefined();
    expect(stream.externalUrl).toBeUndefined();
    expect(stream.name).toBe("YouStream\nHD");
    expect(stream.behaviorHints).toEqual({ bingeGroup: "youstream-app-UCtvf" });
  });

  test("the YouTube app gets a watch URL", () => {
    const stream = buildStream("youtube", match());
    expect(stream.externalUrl).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(stream.ytId).toBeUndefined();
  });

  test("SmartTube gets vnd.youtube", () => {
    expect(buildStream("smarttube", match()).externalUrl).toBe("vnd.youtube:abcdefghijk");
  });

  test("the description says how, what, who, how long and how close", () => {
    const { description, title } = buildStream("app", match());
    expect(description.split("\n")).toEqual([
      "▶️ Play in app",
      "Kota Factory - S01 E03",
      "📺 The Viral Fever",
      "⏱ 36m 51s (−20s)  👁 4.5M  🗣 Hindi"
    ]);
    expect(title).toBe(description);
  });

  test("an SD video, from a channel with no id or name, with nothing else known", () => {
    const stream = buildStream("youtube", match({ definition: "sd", channelId: "", channelTitle: "", views: null, language: null }, { offsetSeconds: null }));
    expect(stream.name).toBe("YouStream\nSD");
    expect(stream.behaviorHints.bingeGroup).toBe("youstream-youtube");
    expect(stream.description.split("\n").slice(2)).toEqual(["📺 YouTube", "⏱ 36m 51s"]);
  });

  test("an age-restricted video says where it opens", () => {
    expect(buildStream("youtube", match({ ageRestricted: true })).description).toContain("Age-restricted");
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
    const streams = toStreams([match({ id: "first______" }), match({ id: "second_____" })], settings);
    expect(streams.map((s) => s.ytId || s.externalUrl)).toEqual([
      "https://www.youtube.com/watch?v=first______",
      "first______",
      "https://www.youtube.com/watch?v=second_____",
      "second_____"
    ]);
  });

  test("no matches, no rows", () => {
    expect(toStreams([], normalizeConfig({}))).toEqual([]);
  });
});

test("detailLine names the language matching settled on, over YouTube's tag", () => {
  expect(detailLine(match({ language: "en" }, { language: "hi" }))).toContain("Hindi");
  expect(detailLine(match({ language: "ja" }, { language: null }))).not.toContain("Japanese");
});

test("detailLine leaves out what is unknown", () => {
  expect(detailLine(match({ views: null, language: "xx" }, { offsetSeconds: undefined }))).toBe("⏱ 36m 51s");
});
