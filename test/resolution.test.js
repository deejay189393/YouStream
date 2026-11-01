const {
  estimateResolution,
  cameOutFor,
  resolutionInTitle,
  dependsOnChannel,
  resolutionLabel,
  BIG_CHANNEL_SUBSCRIBERS,
  RECENT_FROM_YEAR
} = require("../src/resolution");

/** An HD upload of this year from a channel of a million, unless told otherwise. */
const video = (overrides = {}) => ({
  definition: "hd",
  title: "An Example Special",
  live: null,
  publishedAt: "2026-10-19T05:00:09Z",
  subscribers: 1000000,
  ...overrides
});

describe("the rule", () => {
  test("its thresholds: 2019 and 300,000 subscribers", () => {
    expect(RECENT_FROM_YEAR).toBe(2019);
    expect(BIG_CHANNEL_SUBSCRIBERS).toBe(300000);
  });

  test("an SD video is 480p, whatever its title claims", () => {
    expect(estimateResolution(video({ definition: "sd", title: "Example Song [4K]" }))).toBe("480p");
  });

  test.each([
    ["Example Teaser [4K]", "2160p"],
    ["Example Song - 8K Video Song", "2160p"],
    ["Example Trailer (UHD)", "2160p"],
    ["Example Film 2160p", "2160p"],
    ["Example Film 4320p", "2160p"],
    ["Example Gameplay 1440p", "1440p"],
    ["Example Film (Full HD)", "1080p"],
    ["Example Film | Full-HD", "1080p"],
    ["Example Clip FHD", "1080p"],
    ["Example Film 1080p", "1080p"],
    ["Example Upload 720p", "720p"],
    ["Example Comparison 1080p vs 4K", "2160p"]
  ])("the title %p names %p, which decides first", (title, resolution) => {
    // Even for a small channel's upload, or a live stream.
    expect(estimateResolution(video({ title, subscribers: 10, live: "live" }))).toBe(resolution);
  });

  test.each([
    ["4K subscribers special", null],
    ["Thanks for 4K subs!", null],
    ["4K views in a day", null],
    ["Example 4Kids episode", null],
    ["Example 2K26 gameplay", null],
    ["Example HD video", null],
    ["Example 480p upload", null],
    [undefined, null]
  ])("%p names no resolution", (title, resolution) => {
    expect(resolutionInTitle(title)).toBe(resolution);
  });

  test("a live stream is 1080p, whatever its channel, though YouTube calls every live stream SD", () => {
    expect(estimateResolution(video({ live: "live", subscribers: 9000000 }))).toBe("1080p");
    expect(estimateResolution(video({ live: "live", definition: "sd" }))).toBe("1080p");
    // Its title still decides first.
    expect(estimateResolution(video({ live: "live", definition: "sd", title: "Example Stream 4K" }))).toBe("2160p");
    // A premiere still to come is no live stream.
    expect(estimateResolution(video({ live: "upcoming", definition: "sd" }))).toBe("480p");
  });

  test.each([
    ["at 300,000 subscribers", 300000, "2160p"],
    ["above them", 8500000, "2160p"],
    ["just under them", 299999, "1080p"],
    ["with the count hidden or not known", undefined, "1080p"],
    ["with it null", null, "1080p"]
  ])("a 2019-or-later upload on a channel %s: %s", (_, subscribers, resolution) => {
    expect(estimateResolution(video({ subscribers }))).toBe(resolution);
  });

  test("before 2019 it is 1080p, however big the channel", () => {
    expect(estimateResolution(video({ publishedAt: "2018-12-31T23:59:59Z", subscribers: 9000000 }))).toBe("1080p");
    expect(estimateResolution(video({ publishedAt: "2019-01-01T00:00:00Z", subscribers: 9000000 }))).toBe("2160p");
  });

  test("a film or episode goes by its own release, not the upload's date", () => {
    expect(estimateResolution(video(), "1968-10-04")).toBe("1080p");
    expect(estimateResolution(video(), 2013)).toBe("1080p");
    expect(estimateResolution(video({ publishedAt: "2015-01-01T00:00:00Z" }), "2026-10-25")).toBe("2160p");
  });

  test("with no date anywhere it is 1080p", () => {
    expect(estimateResolution(video({ publishedAt: undefined }))).toBe("1080p");
    expect(estimateResolution(video({ publishedAt: "not a date" }))).toBe("1080p");
  });
});

describe("cameOutFor", () => {
  test("a film's release date, else its year; an episode's air date, else its year; nothing for a YouTube item", () => {
    expect(cameOutFor({ isEpisode: false, released: "1968-10-04", year: 1968 })).toBe("1968-10-04");
    expect(cameOutFor({ isEpisode: false, released: null, year: 1968 })).toBe(1968);
    expect(cameOutFor({ isEpisode: true, released: "2026-10-25", releaseYear: 2026, year: 2025 })).toBe("2026-10-25");
    // An episode's own year, not the show's.
    expect(cameOutFor({ isEpisode: true, released: null, releaseYear: 2026, year: 2015 })).toBe(2026);
    expect(cameOutFor({ isEpisode: true, released: null, releaseYear: null, year: 2015 })).toBeNull();
    expect(cameOutFor(null)).toBeNull();
  });
});

describe("dependsOnChannel", () => {
  test("only a recent HD upload whose title names nothing and which is not live needs the channel's size", () => {
    expect(dependsOnChannel(video())).toBe(true);
    expect(dependsOnChannel(video({ definition: "sd" }))).toBe(false);
    expect(dependsOnChannel(video({ title: "Example [4K]" }))).toBe(false);
    expect(dependsOnChannel(video({ live: "live" }))).toBe(false);
    expect(dependsOnChannel(video({ publishedAt: "2016-01-01T00:00:00Z" }))).toBe(false);
    expect(dependsOnChannel(video(), "1968-10-04")).toBe(false);
  });
});

test("resolutionLabel: 4K for 2160p, every other one as it is", () => {
  expect(["2160p", "1440p", "1080p", "720p", "480p"].map(resolutionLabel)).toEqual(["4K", "1440p", "1080p", "720p", "480p"]);
});
