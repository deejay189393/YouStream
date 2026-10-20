const {
  ITEM_TYPE,
  ITEM_PREFIX,
  itemId,
  videoIdOf,
  toItem,
  toPreview,
  toMetaPreview,
  toFullMeta,
  runtimeText,
  itemGenres,
  titleCaseTag,
  MAX_DESCRIPTION,
  PREVIEW_DESCRIPTION
} = require("../src/items");
const { apiVideo } = require("./helpers");

const detail = (overrides = {}) =>
  apiVideo("abcdefghijk", {
    snippet: {
      title: "How Example Engines Work",
      description: "An engine, explained.",
      channelTitle: "Example Science",
      channelId: "UCscience",
      publishedAt: "2025-03-14T15:00:00Z",
      categoryId: "28",
      tags: ["engines", "how it works"],
      thumbnails: {
        default: { url: "https://i.ytimg.com/vi/abcdefghijk/default.jpg" },
        medium: { url: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" },
        high: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" },
        maxres: { url: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg" }
      },
      ...(overrides.snippet || {})
    },
    contentDetails: { duration: "PT12M34S", ...(overrides.contentDetails || {}) },
    statistics: { viewCount: "1200000", ...(overrides.statistics || {}) },
    status: overrides.status || {}
  });

describe("item ids", () => {
  test("the type is YouTube, spelled so, and ids carry the youstream: prefix", () => {
    expect(ITEM_TYPE).toBe("YouTube");
    expect(ITEM_PREFIX).toBe("youstream:");
    expect(itemId("abcdefghijk")).toBe("youstream:abcdefghijk");
  });

  test.each([
    ["youstream:abcdefghijk", "abcdefghijk"],
    ["youstream:a-b_c-d_e-f", "a-b_c-d_e-f"],
    ["youstream:short", null],
    ["youstream:abcdefghijk:1:2", null],
    ["tt0063350", null],
    ["abcdefghijk", null],
    [null, null]
  ])("videoIdOf(%p)", (id, videoId) => {
    expect(videoIdOf(id)).toBe(videoId);
  });
});

describe("toItem", () => {
  test("what matching keeps, plus the description in full, artwork, tags and category", () => {
    const item = toItem(detail({ snippet: { description: "x".repeat(MAX_DESCRIPTION + 10) } }));
    expect(item).toMatchObject({
      id: "abcdefghijk",
      title: "How Example Engines Work",
      channelTitle: "Example Science",
      durationSeconds: 754,
      views: 1200000,
      poster: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      background: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      tags: ["engines", "how it works"],
      category: "Science & Technology"
    });
    expect(item.description).toHaveLength(MAX_DESCRIPTION);
  });

  test("without maxres, a 16:9 medium poster and the largest backdrop", () => {
    const thumbnails = {
      medium: { url: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" },
      high: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" }
    };
    const item = toItem({ ...detail(), snippet: { ...detail().snippet, thumbnails } });
    expect(item.poster).toBe("https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg");
    expect(item.background).toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
  });

  test("no artwork listed, or nothing at all: YouTube's own thumbnail, and empty fields", () => {
    const item = toItem({ id: "abcdefghijk" });
    expect(item.poster).toBe("https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg");
    expect(item.background).toBe(item.poster);
    expect(item).toMatchObject({ description: "", tags: [], category: null });
    expect(toItem(detail({ snippet: { tags: ["ok", 5], categoryId: "999" } }))).toMatchObject({ tags: ["ok"], category: null });
  });

  test("a preview keeps the start of the description and nothing a row does not show", () => {
    const preview = toPreview(toItem(detail({ snippet: { description: "y".repeat(1000) } })));
    expect(preview.description).toHaveLength(PREVIEW_DESCRIPTION);
    expect(preview.tags).toBeUndefined();
    expect(preview.category).toBeUndefined();
    expect(preview.poster).toBeDefined();
  });
});

test.each([
  [754, "13 min"],
  [45, "45 sec"],
  [3600, "1h 0m"],
  [5709, "1h 35m"],
  [3599, "1h 0m"],
  [null, undefined],
  [0, undefined]
])("runtimeText(%p) is %p", (seconds, text) => {
  expect(runtimeText(seconds)).toBe(text);
});

describe("toMetaPreview", () => {
  test("a landscape card that opens straight to the video's streams", () => {
    expect(toMetaPreview(toPreview(toItem(detail())))).toEqual({
      id: "youstream:abcdefghijk",
      type: "YouTube",
      name: "How Example Engines Work",
      poster: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      posterShape: "landscape",
      background: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      description: "An engine, explained.",
      releaseInfo: "2025-03-14",
      runtime: "13 min",
      behaviorHints: { defaultVideoId: "youstream:abcdefghijk" }
    });
  });

  test("a live stream says so on its name, and an untitled, undated video still shows", () => {
    const live = toMetaPreview(toItem(detail({ snippet: { liveBroadcastContent: "live" }, contentDetails: { duration: "P0D" } })));
    expect(live.name).toBe("🔴 How Example Engines Work");
    expect(live.runtime).toBeUndefined();
    const bare = toMetaPreview(toItem({ id: "abcdefghijk" }));
    expect(bare).toMatchObject({ name: "Untitled", description: undefined, releaseInfo: undefined });
  });
});

describe("toFullMeta", () => {
  test("the description, who uploaded it and how widely it has been seen, the tags and the channel", () => {
    expect(toFullMeta(toItem(detail({ status: {}, contentDetails: { licensedContent: true } })))).toEqual({
      id: "youstream:abcdefghijk",
      type: "YouTube",
      name: "How Example Engines Work",
      poster: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      posterShape: "landscape",
      background: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      description: "An engine, explained.\n\nExample Science ✓ · 1.2M views",
      releaseInfo: "2025-03-14",
      runtime: "13 min",
      released: "2025-03-14T15:00:00Z",
      genres: ["Science & Technology", "Engines", "How It Works"],
      website: "https://www.youtube.com/watch?v=abcdefghijk",
      links: [{ name: "Example Science", category: "Channel", url: "https://www.youtube.com/channel/UCscience" }],
      behaviorHints: { defaultVideoId: "youstream:abcdefghijk" }
    });
  });

  test("an age-restricted video says where it plays; one with nothing known still reads", () => {
    const restricted = toFullMeta(toItem(detail({ contentDetails: { contentRating: { ytRating: "ytAgeRestricted" } } })));
    expect(restricted.description).toContain("🔞 Age-restricted");
    const bare = toFullMeta(toItem({ id: "abcdefghijk" }));
    expect(bare).toMatchObject({ description: "YouTube", links: [], genres: undefined, released: undefined });
    const unnamed = toFullMeta(toItem({ id: "abcdefghijk", snippet: { channelId: "UCsomeone" } }));
    expect(unnamed.links).toEqual([{ name: "YouTube", category: "Channel", url: "https://www.youtube.com/channel/UCsomeone" }]);
  });
});

describe("the tag row", () => {
  const genres = (tags, extra = {}) => itemGenres({ channelTitle: "Example Science", category: null, tags, ...extra });

  test("the category first, then the uploader's tags, at most six", () => {
    expect(itemGenres({ channelTitle: "X", category: "Music", tags: ["one", "two", "three", "four", "five", "six", "seven"] })).toEqual([
      "Music",
      "One",
      "Two",
      "Three",
      "Four",
      "Five"
    ]);
  });

  test("words about YouTube, numbers, handles, hashtags, slugs and over-long tags are left out", () => {
    expect(genres(["video", "4K", "Official Video", "2025", "1968", "#engines", "@science", "snake_case", "a".repeat(29), "turbines"])).toEqual([
      "Turbines"
    ]);
  });

  test("the channel advertising itself, either way round", () => {
    expect(genres(["Example Science", "example", "Example Science Clips", "Science", "physics"])).toEqual(["Physics"]);
    expect(itemGenres({ channelTitle: "", category: null, tags: ["physics"] })).toEqual(["Physics"]);
    expect(itemGenres({ channelTitle: "abc", category: null, tags: ["abcd thing", "ab"] })).toEqual(["Abcd Thing"]);
  });

  test("a channel's own slug taxonomy is dropped, a lone hyphenated tag kept", () => {
    expect(genres(["mkb-review", "mkb-unboxing", "sci-fi"])).toEqual(["Sci-Fi"]);
    expect(genres(["sci-fi", "lo-fi"])).toEqual(["Sci-Fi", "Lo-Fi"]);
  });

  test("rewordings of one phrase are kept once; single words are not a family", () => {
    expect(genres(["iphone 17 review", "iphone 17 pro review", "review", "radio", "visual radio", "iphone 17 review"])).toEqual([
      "Iphone 17 Review",
      "Review",
      "Radio",
      "Visual Radio"
    ]);
  });

  test("no tags at all is no row", () => {
    expect(genres([])).toBeUndefined();
    expect(itemGenres({ channelTitle: "X", category: null })).toBeUndefined();
  });

  test.each([
    ["sci-fi", "Sci-Fi"],
    ["ai tools", "AI Tools"],
    ["LOFI BEATS", "LOFI Beats"],
    ["McConaughey", "McConaughey"],
    ["iPhone 17", "iPhone 17"],
    ["ps5  games", "PS5  Games"]
  ])("titleCaseTag(%p)", (tag, out) => {
    expect(titleCaseTag(tag)).toBe(out);
  });
});
