const {
  ITEM_TYPE,
  ITEM_PREFIX,
  itemId,
  videoIdOf,
  isItemType,
  toItem,
  toPreview,
  toMetaPreview,
  toFullMeta,
  itemDescription,
  AGE_NOTE,
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
    status: overrides.status || {},
    liveStreamingDetails: overrides.liveStreamingDetails
  });

describe("item ids", () => {
  test("the type is youtube, lower case like movie and series, and ids name YouTube: yt_id: and the video's id", () => {
    expect(ITEM_TYPE).toBe("youtube");
    expect(ITEM_PREFIX).toBe("yt_id:");
    expect(itemId("abcdefghijk")).toBe("yt_id:abcdefghijk");
  });

  test.each([
    ["yt_id:abcdefghijk", "abcdefghijk"],
    ["yt_id:a-b_c-d_e-f", "a-b_c-d_e-f"],
    // Before 0.8.0.
    ["youstream:abcdefghijk", "abcdefghijk"],
    // A video of a channel in Stremio's own YouTube add-on.
    ["yt_id:UCrDkAvwZum-UTjHmzDI2iIw:9bZkp7q19f0", "9bZkp7q19f0"],
    // That channel itself is no video.
    ["yt_id:UCrDkAvwZum-UTjHmzDI2iIw", null],
    ["yt_id:short", null],
    ["yt_id:abcdefghijk:1:2", null],
    ["youstream:abcdefghijk:1:2", null],
    ["yt:abcdefghijk", null],
    ["tt0063350", null],
    ["abcdefghijk", null],
    [null, null]
  ])("videoIdOf(%p)", (id, videoId) => {
    expect(videoIdOf(id)).toBe(videoId);
  });

  test.each([
    ["youtube", true],
    ["YouTube", true],
    ["YOUTUBE", true],
    ["channel", false],
    ["movie", false],
    [undefined, false]
  ])("isItemType(%p)", (type, yes) => {
    expect(isItemType(type)).toBe(yes);
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
      id: "yt_id:abcdefghijk",
      type: "youtube",
      name: "How Example Engines Work",
      poster: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      posterShape: "landscape",
      background: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      description: "Example Science\n1.2M views\n\nAn engine, explained.",
      releaseInfo: "2025-03-14",
      runtime: "13 min",
      behaviorHints: { defaultVideoId: "yt_id:abcdefghijk" }
    });
  });

  test("a card has the views and likes, never a dislike estimate: that is looked up for the page only", () => {
    const card = toMetaPreview(toPreview(toItem(detail({ statistics: { likeCount: "45000" } }))));
    expect(card.description).toBe("Example Science\n1.2M views · 👍🏻 45K\n\nAn engine, explained.");
  });

  test("a live stream says so on its name, and an untitled, undated video still shows", () => {
    const live = toMetaPreview(toItem(detail({ snippet: { liveBroadcastContent: "live" }, contentDetails: { duration: "P0D" } })));
    expect(live.name).toBe("🔴 How Example Engines Work");
    expect(live.runtime).toBeUndefined();
    const bare = toMetaPreview(toItem({ id: "abcdefghijk" }));
    expect(bare).toMatchObject({ name: "Untitled", description: undefined, releaseInfo: undefined });
  });

  test.each([
    ["🔴LIVE | Example Game Night | Day 6", "🔴LIVE | Example Game Night | Day 6"],
    ["🔴 WATCH LIVE - Example Surf Pro, Day 2", "🔴 WATCH LIVE - Example Surf Pro, Day 2"],
    ["🔴Live🔴Example Quiz Night", "🔴Live🔴Example Quiz Night"],
    // Only a title that starts with one: a 🔴 further in, or another red sign, is the uploader's.
    ["Example Game LIVE 🔴 Can We Escape?", "🔴 Example Game LIVE 🔴 Can We Escape?"],
    ["🛑EXAMPLE NEWS LIVE | Headlines", "🔴 🛑EXAMPLE NEWS LIVE | Headlines"],
    ["LIVE: Example Rally", "🔴 LIVE: Example Rally"]
  ])("a live title %p is named %p: a 🔴 the uploader put first is not doubled", (title, name) => {
    expect(toMetaPreview(toItem(detail({ snippet: { title, liveBroadcastContent: "live" } }))).name).toBe(name);
  });

  test("a card can carry the type and id an app asked with, for a video saved before 0.8.0", () => {
    const card = toMetaPreview(toItem(detail()), { type: "YouTube", id: "youstream:abcdefghijk" });
    expect(card).toMatchObject({ id: "youstream:abcdefghijk", type: "YouTube", behaviorHints: { defaultVideoId: "youstream:abcdefghijk" } });
    expect(toFullMeta(toItem(detail()), null, { type: "youtube", id: "youstream:abcdefghijk" })).toMatchObject({
      id: "youstream:abcdefghijk",
      type: "youtube",
      website: "https://www.youtube.com/watch?v=abcdefghijk"
    });
  });

  test("a title with a 🔴 is left as it is once the stream is over", () => {
    expect(toMetaPreview(toItem(detail({ snippet: { title: "🔴LIVE | Example Game Night" } }))).name).toBe("🔴LIVE | Example Game Night");
  });
});

describe("toFullMeta", () => {
  test("the channel, how widely it has been seen, then the description; the tags and the channel's link", () => {
    expect(toFullMeta(toItem(detail({ status: {}, contentDetails: { licensedContent: true } })))).toEqual({
      id: "yt_id:abcdefghijk",
      type: "youtube",
      name: "How Example Engines Work",
      poster: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      posterShape: "landscape",
      background: "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      description: "Example Science\n1.2M views\n\nAn engine, explained.",
      releaseInfo: "2025-03-14",
      runtime: "13 min",
      released: "2025-03-14T15:00:00Z",
      genres: ["Science & Technology", "Engines", "How It Works"],
      website: "https://www.youtube.com/watch?v=abcdefghijk",
      links: [{ name: "Example Science", category: "Channel", url: "https://www.youtube.com/channel/UCscience" }],
      behaviorHints: { defaultVideoId: "yt_id:abcdefghijk" }
    });
  });

  test("the dislike estimate goes beside the likes, marked as one", () => {
    const meta = toFullMeta(toItem(detail({ statistics: { likeCount: "45000" } })), 1300);
    expect(meta.description).toBe("Example Science\n1.2M views · 👍🏻 45K · 👎🏻 ~1.3K\n\nAn engine, explained.");
  });

  test("an age-restricted video says where it plays, between the counts and the description; one with nothing known still reads", () => {
    const restricted = toFullMeta(toItem(detail({ contentDetails: { contentRating: { ytRating: "ytAgeRestricted" } } })));
    expect(restricted.description).toBe(`Example Science\n1.2M views\n\n${AGE_NOTE}\n\nAn engine, explained.`);
    const bare = toFullMeta(toItem({ id: "abcdefghijk" }));
    expect(bare).toMatchObject({ description: undefined, links: [], genres: undefined, released: undefined });
    const unnamed = toFullMeta(toItem({ id: "abcdefghijk", snippet: { channelId: "UCsomeone" } }));
    expect(unnamed.links).toEqual([{ name: "YouTube", category: "Channel", url: "https://www.youtube.com/channel/UCsomeone" }]);
  });
});

describe("itemDescription", () => {
  const item = (fields) => ({ channelTitle: "Example Science", views: 1200000, likes: 45000, ageRestricted: false, description: "An engine, explained.", ...fields });

  test.each([
    ["every part", {}, 26237, "Example Science\n1.2M views · 👍🏻 45K · 👎🏻 ~26.2K\n\nAn engine, explained."],
    ["likes hidden by the uploader", { likes: null }, 26237, "Example Science\n1.2M views · 👎🏻 ~26.2K\n\nAn engine, explained."],
    ["no estimate", {}, null, "Example Science\n1.2M views · 👍🏻 45K\n\nAn engine, explained."],
    ["no view count", { views: null }, null, "Example Science\n👍🏻 45K\n\nAn engine, explained."],
    ["no counts at all", { views: null, likes: null }, null, "Example Science\n\nAn engine, explained."],
    ["counts of nought are still counts", { views: 0, likes: 0 }, 0, "Example Science\n0 views · 👍🏻 0 · 👎🏻 ~0\n\nAn engine, explained."],
    ["no channel name", { channelTitle: "" }, null, "1.2M views · 👍🏻 45K\n\nAn engine, explained."],
    ["no description", { description: "" }, null, "Example Science\n1.2M views · 👍🏻 45K"],
    ["age-restricted", { ageRestricted: true }, null, `Example Science\n1.2M views · 👍🏻 45K\n\n${AGE_NOTE}\n\nAn engine, explained.`],
    ["only the description", { channelTitle: "", views: null, likes: null }, null, "An engine, explained."]
  ])("%s", (_, fields, dislikes, text) => {
    expect(itemDescription(item(fields), dislikes)).toBe(text);
  });

  test.each([
    ["a live stream says who is watching now, in place of its views", { live: "live", watching: 12400, likes: 1600000 }, 20000,
      "Example Science\n🔴 Live · 12.4K watching · 👍🏻 1.6M · 👎🏻 ~20K\n\nAn engine, explained."],
    ["a live stream whose channel hides the count still says it is live", { live: "live", watching: null }, null,
      "Example Science\n🔴 Live · 👍🏻 45K\n\nAn engine, explained."],
    ["a premiere still to come counts its views, as any other video", { live: "upcoming", watching: null }, null,
      "Example Science\n1.2M views · 👍🏻 45K\n\nAn engine, explained."]
  ])("%s", (_, fields, dislikes, text) => {
    expect(itemDescription(item(fields), dislikes)).toBe(text);
  });

  test("a live stream's card says so too, without a dislike estimate", () => {
    const card = toMetaPreview(
      toItem(detail({ snippet: { liveBroadcastContent: "live" }, statistics: { likeCount: "3400" }, liveStreamingDetails: { concurrentViewers: "980" } }))
    );
    expect(card.description).toBe("Example Science\n🔴 Live · 980 watching · 👍🏻 3.4K\n\nAn engine, explained.");
    expect(card.name).toBe("🔴 How Example Engines Work");
  });

  test("nothing known is no description at all", () => {
    expect(itemDescription({ channelTitle: "", views: null, likes: null, description: "" })).toBeUndefined();
  });

  test("the channel is named plainly: no mark beside it, whatever YouTube says of its licence", () => {
    expect(itemDescription(item({ licensed: true }))).not.toContain("✓");
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
