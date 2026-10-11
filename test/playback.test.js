const {
  normalizePlayback,
  orderedPlaybackOptions,
  externalUrlFor,
  DEFAULT_PLAYBACK,
  OPTION_IDS
} = require("../src/playback");

describe("normalizePlayback", () => {
  test("keeps a valid list in its order", () => {
    expect(normalizePlayback(["youtube", "app"])).toEqual(["youtube", "app"]);
  });

  test("drops unknown, repeated and non-string entries", () => {
    expect(normalizePlayback(["smarttube", "bogus", 3, "smarttube", "app"])).toEqual(["smarttube", "app"]);
  });

  test("falls back to the default when nothing usable is left", () => {
    expect(normalizePlayback([])).toEqual(DEFAULT_PLAYBACK);
    expect(normalizePlayback("app")).toEqual(DEFAULT_PLAYBACK);
    expect(normalizePlayback(undefined)).toEqual(DEFAULT_PLAYBACK);
  });

  test("returns a copy of the default, not the default itself", () => {
    normalizePlayback(null).push("x");
    expect(DEFAULT_PLAYBACK).toEqual(["app", "youtube"]);
  });
});

describe("orderedPlaybackOptions", () => {
  test("lists the enabled options first, then the rest switched off", () => {
    const rows = orderedPlaybackOptions(["youtube"]);
    expect(rows.map((r) => [r.id, r.enabled])).toEqual([
      ["youtube", true],
      ["app", false],
      ["smarttube", false]
    ]);
    expect(rows[0].label).toBe("Open in the YouTube app");
  });

  test("covers every option exactly once", () => {
    expect(orderedPlaybackOptions(undefined).map((r) => r.id).sort()).toEqual([...OPTION_IDS].sort());
  });
});

describe("externalUrlFor", () => {
  test("a watch URL for the YouTube app", () => {
    expect(externalUrlFor("youtube", "abc")).toBe("https://www.youtube.com/watch?v=abc");
  });

  test("vnd.youtube for SmartTube, which no browser claims", () => {
    expect(externalUrlFor("smarttube", "abc")).toBe("vnd.youtube:abc");
  });

  test("nothing for in-app playback", () => {
    expect(externalUrlFor("app", "abc")).toBeNull();
  });
});
