const {
  normalizeEntry,
  normalizeCatalogs,
  toStoredCatalogs,
  parseSourceLink,
  SOURCE_KINDS,
  tidy,
  slug,
  SORTS,
  LENGTHS,
  PERIODS,
  CHANNEL_SHOWS,
  TRENDING,
  PAGE_SIZE,
  MAX_PAGES,
  SKIP_OPTIONS,
  MAX_CATALOGS,
  MAX_QUERY_LENGTH,
  MAX_NAME_LENGTH
} = require("../src/catalogs");

const CHANNEL = "UCBJycsmduvYEL83R_U4JriQ";
const PLAYLIST = "PLBCF2DAC6FFB574DE";

describe("a search catalog", () => {
  test("its query, tidied, and YouTube's own ranking unless another order is chosen", () => {
    expect(normalizeEntry({ q: "  lofi \n hip   hop " })).toEqual({
      kind: "search",
      id: expect.stringMatching(/^search\.lofi-hip-hop\.[0-9a-f]{8}$/),
      name: "lofi hip hop",
      q: "lofi hip hop",
      sort: "relevance",
      length: "any",
      within: "any"
    });
  });

  test("its options, named after the query", () => {
    expect(normalizeEntry({ q: "AI news", sort: "date", length: "medium", within: "week" })).toMatchObject({
      name: "AI news · Newest · 4–20 min · This week",
      sort: "date",
      length: "medium",
      within: "week"
    });
    expect(normalizeEntry({ q: "x y z", sort: "viewCount", length: "long", within: "year" }).name).toBe("x y z · Most viewed · Over 20 min · This year");
    expect(normalizeEntry({ q: "x y z", sort: "rating", length: "short", within: "day" }).name).toBe("x y z · Top rated · Under 4 min · Today");
    expect(normalizeEntry({ q: "x y z", within: "month" }).name).toBe("x y z · This month");
  });

  test("an unknown option is the default", () => {
    expect(normalizeEntry({ q: "lofi", sort: "title", length: 5, within: "ever" })).toMatchObject({ sort: "relevance", length: "any", within: "any" });
  });

  test("the id follows what is searched and how: the same search is one row, a different order another", () => {
    const a = normalizeEntry({ q: "Lofi Hip Hop" });
    expect(normalizeEntry({ q: "lofi hip hop" }).id).toBe(a.id);
    expect(normalizeEntry({ q: "lofi hip hop", sort: "date" }).id).not.toBe(a.id);
    expect(normalizeEntry({ q: "lofi hip-hop" }).id).not.toBe(a.id);
  });

  test("a query in another script gets an id all the same", () => {
    expect(normalizeEntry({ q: "हिंदी गाने" }).id).toMatch(/^search\.[0-9a-f]{8}$/);
    expect(normalizeEntry({ q: "Café Olé" }).id).toMatch(/^search\.cafe-ole\.[0-9a-f]{8}$/);
  });

  test("a long query is cut without an ellipsis; its name gets one", () => {
    const entry = normalizeEntry({ q: `${"word ".repeat(30)}end` });
    expect(entry.q.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
    expect(entry.q.endsWith("…")).toBe(false);
    expect(entry.name).toHaveLength(MAX_NAME_LENGTH);
    expect(entry.name.endsWith("…")).toBe(true);
  });

  test.each([[""], ["   "], [5], [null]])("no catalog for the query %p", (q) => {
    expect(normalizeEntry({ q })).toBeNull();
  });
});

describe("a channel catalog", () => {
  test("its videos without Shorts by default, named after the channel", () => {
    expect(normalizeEntry({ channel: CHANNEL, name: "Marques Brownlee" })).toEqual({
      kind: "channel",
      id: `channel.${CHANNEL}.videos`,
      name: "Marques Brownlee",
      title: "Marques Brownlee",
      channel: CHANNEL,
      show: "videos",
      sort: "date"
    });
  });

  test("newest first, as the channel lists them, or most viewed first, each a row of its own", () => {
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", sort: "viewCount" })).toMatchObject({
      id: `channel.${CHANNEL}.videos.viewCount`,
      name: "MKBHD · Most viewed",
      sort: "viewCount"
    });
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", show: "shorts", sort: "viewCount" }).name).toBe("MKBHD · Shorts · Most viewed");
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", sort: "rating" })).toMatchObject({ id: `channel.${CHANNEL}.videos`, sort: "date" });
  });

  test("its Shorts, its live streams, or everything, each a row of its own", () => {
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", show: "shorts" })).toMatchObject({ id: `channel.${CHANNEL}.shorts`, name: "MKBHD · Shorts" });
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", show: "live" }).name).toBe("MKBHD · Live");
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", show: "all" }).name).toBe("MKBHD · Everything");
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", show: "podcasts" }).show).toBe("videos");
  });

  test("without a name it is still a row", () => {
    expect(normalizeEntry({ channel: CHANNEL }).name).toBe("YouTube channel");
  });

  test.each([["UC123"], [`XX${CHANNEL.slice(2)}`], [42]])("no catalog for the channel id %p", (channel) => {
    expect(normalizeEntry({ channel, name: "x" })).toBeNull();
  });
});

describe("a playlist catalog", () => {
  test("named after the playlist", () => {
    expect(normalizeEntry({ playlist: PLAYLIST, name: "Google Search Stories" })).toEqual({
      kind: "playlist",
      id: `playlist.${PLAYLIST}`,
      name: "Google Search Stories",
      title: "Google Search Stories",
      playlist: PLAYLIST
    });
    expect(normalizeEntry({ playlist: PLAYLIST }).name).toBe("YouTube playlist");
  });

  test.each([["short"], ["has spaces in it"], [{}]])("no catalog for the playlist id %p", (playlist) => {
    expect(normalizeEntry({ playlist })).toBeNull();
  });
});

describe("a Trending catalog", () => {
  test("all of it, or one category", () => {
    expect(normalizeEntry({ trending: "all" })).toEqual({ kind: "trending", id: "trending.all", name: "Trending", trending: "all" });
    expect(normalizeEntry({ trending: "music" }).name).toBe("Trending Music");
    expect(normalizeEntry({ trending: "podcasts" })).toBeNull();
  });

  test("every category has YouTube's id, and a chip to add it with", () => {
    TRENDING.forEach((t) => {
      expect(t.chip).toEqual(expect.any(String));
      if (t.id !== "all") expect(t.category).toMatch(/^\d+$/);
    });
  });
});

test.each([[null], ["lofi"], [[1]], [{}], [{ nothing: true }]])("no catalog at all in %p", (raw) => {
  expect(normalizeEntry(raw)).toBeNull();
});

describe("normalizeCatalogs", () => {
  test("in the reader's order, without repeats or what is not a catalog", () => {
    const entries = normalizeCatalogs([{ trending: "music" }, { q: "lofi" }, { q: "LOFI" }, "junk", { trending: "music" }, { channel: CHANNEL }]);
    expect(entries.map((e) => e.id)).toEqual(["trending.music", expect.stringMatching(/^search\.lofi\./), `channel.${CHANNEL}.videos`]);
  });

  test("at most MAX_CATALOGS", () => {
    const many = Array.from({ length: MAX_CATALOGS + 3 }, (_, i) => ({ q: `query ${i}` }));
    expect(normalizeCatalogs(many)).toHaveLength(MAX_CATALOGS);
    expect(MAX_CATALOGS).toBe(20);
  });

  test("nothing that is not a list", () => {
    expect(normalizeCatalogs({ q: "lofi" })).toEqual([]);
    expect(normalizeCatalogs(undefined)).toEqual([]);
  });

  test("normalizing normalized catalogs changes nothing", () => {
    const once = normalizeCatalogs([
      { channel: CHANNEL, name: "MKBHD", show: "shorts" },
      { playlist: PLAYLIST, name: "Stories" },
      { q: "news", sort: "date" },
      { trending: "all" }
    ]);
    expect(normalizeCatalogs(once)).toEqual(once);
  });
});

test("the stored form leaves every default out", () => {
  const entries = normalizeCatalogs([
    { q: "lofi" },
    { q: "news", sort: "date", length: "long", within: "day" },
    { channel: CHANNEL, name: "MKBHD" },
    { channel: CHANNEL, name: "MKBHD", show: "live" },
    { channel: CHANNEL, name: "MKBHD", sort: "viewCount" },
    { channel: CHANNEL, name: "MKBHD", show: "all", sort: "date" },
    { playlist: PLAYLIST, name: "Stories" },
    { trending: "gaming" }
  ]);
  expect(toStoredCatalogs(entries)).toEqual([
    { q: "lofi" },
    { q: "news", sort: "date", length: "long", within: "day" },
    { channel: CHANNEL, name: "MKBHD" },
    { channel: CHANNEL, name: "MKBHD", show: "live" },
    { channel: CHANNEL, name: "MKBHD", sort: "viewCount" },
    { channel: CHANNEL, name: "MKBHD", show: "all" },
    { playlist: PLAYLIST, name: "Stories" },
    { trending: "gaming" }
  ]);
  expect(normalizeCatalogs(toStoredCatalogs(entries))).toEqual(entries);
});

describe("parseSourceLink", () => {
  test.each([
    [PLAYLIST, { playlistId: PLAYLIST }],
    ["PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", { playlistId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" }],
    ["OLAK5uy_kVr2k8bnUgIoA0xDoGd5OaVg2JqHBO4vY", { playlistId: "OLAK5uy_kVr2k8bnUgIoA0xDoGd5OaVg2JqHBO4vY" }],
    ["RDCLAK5uy_lBNUteBRencHzKelu5iDHwLF6mYqjL-JU", { playlistId: "RDCLAK5uy_lBNUteBRencHzKelu5iDHwLF6mYqjL-JU" }],
    ["UULFBJycsmduvYEL83R_U4JriQ", { playlistId: "UULFBJycsmduvYEL83R_U4JriQ" }],
    [` https://www.youtube.com/playlist?list=${PLAYLIST} `, { playlistId: PLAYLIST }],
    [`https://music.youtube.com/playlist?list=${PLAYLIST}&si=x`, { playlistId: PLAYLIST }],
    ["music.youtube.com/playlist?list=RDCLAK5uy_lBNUteBRencHzKelu5iDHwLF6mYqjL-JU", { playlistId: "RDCLAK5uy_lBNUteBRencHzKelu5iDHwLF6mYqjL-JU" }],
    [`https://www.youtube.com/watch?v=abcdefghijk&list=${PLAYLIST}&index=2`, { playlistId: PLAYLIST }],
    [`https://youtu.be/abcdefghijk?list=${PLAYLIST}`, { playlistId: PLAYLIST }]
  ])("as a playlist, %s is one", (text, expected) => {
    expect(parseSourceLink(text, "playlist")).toEqual(expected);
  });

  test.each([
    ["@mkbhd", { handle: "@mkbhd" }],
    // A handle typed without its @, in any script.
    ["mkbhd", { handle: "@mkbhd" }],
    ["PLAYSTATION5", { handle: "@PLAYSTATION5" }],
    ["@कोई_चैनल", { handle: "@कोई_चैनल" }],
    ["कोई_चैनल", { handle: "@कोई_चैनल" }],
    [CHANNEL, { id: CHANNEL }],
    ["https://www.youtube.com/@mkbhd", { handle: "@mkbhd" }],
    ["youtube.com/@mkbhd/videos", { handle: "@mkbhd" }],
    ["https://m.youtube.com/%40%E0%A4%95%E0%A5%8B%E0%A4%88", { handle: "@कोई" }],
    [`https://www.youtube.com/channel/${CHANNEL}`, { id: CHANNEL }],
    [`www.youtube.com/channel/${CHANNEL}/featured`, { id: CHANNEL }],
    ["https://www.youtube.com/user/marquesbrownlee", { username: "marquesbrownlee" }]
  ])("as a channel, %s is one", (text, expected) => {
    expect(parseSourceLink(text, "channel")).toEqual(expected);
  });

  test.each([
    ["https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk", "playlist", "made for you"],
    ["https://www.youtube.com/playlist?list=LL", "playlist", "made for you"],
    ["https://www.youtube.com/playlist?list=WL", "channel", "made for you"],
    ["https://www.youtube.com/c/SomeName", "channel", "old /c/ link"],
    ["https://youtu.be/abcdefghijk", "playlist", "one video, not a playlist"],
    ["https://www.youtube.com/watch?v=abcdefghijk", "playlist", "one video, not a playlist"],
    ["https://www.youtube.com/shorts/abcdefghijk", "channel", "one video, not a channel"],
    ["https://www.youtube.com/live/abcdefghijk", "channel", "one video, not a channel"],
    ["https://www.youtube.com/feed/trending", "playlist", "That YouTube link is not a playlist."],
    ["https://www.youtube.com/feed/trending", "channel", "That YouTube link is not a channel."],
    ["https://www.youtube.com/playlist?list=short", "playlist", "That YouTube link is not a playlist."],
    ["https://www.youtube.com/%E0%A4%A", "channel", "That YouTube link is not a channel."],
    [CHANNEL, "playlist", "That is a channel, not a playlist. Choose YouTube channel to add it."],
    ["@mkbhd", "playlist", "Choose YouTube channel"],
    [`https://www.youtube.com/playlist?list=${PLAYLIST}`, "channel", "That is a playlist, not a channel. Choose YouTube playlist to add it."],
    [PLAYLIST, "channel", "Choose YouTube playlist"],
    ["documentaries", "playlist", "Paste a playlist's link, or its ID: the part after list= in the link."],
    ["PLAYSTATION5", "playlist", "the part after list="],
    ["", "playlist", "the part after list="],
    ["lofi hip hop", "channel", "Paste a channel's link or its @handle."],
    ["https://example.com/@mkbhd", "channel", "link or its @handle"],
    ["http://[::1", "channel", "link or its @handle"],
    [null, "channel", "link or its @handle"],
    ["@ab", "channel", "link or its @handle"],
    ["ab", "channel", "link or its @handle"]
  ])("%p as a %s says why it is none: %s", (text, kind, says) => {
    expect(parseSourceLink(text, kind)).toEqual({ error: expect.stringContaining(says) });
  });

  test("the kinds a link can add", () => {
    expect(SOURCE_KINDS).toEqual(["playlist", "channel"]);
  });
});

test("the paging steps are YouTube's page, five deep", () => {
  expect(PAGE_SIZE).toBe(50);
  expect(MAX_PAGES).toBe(5);
  expect(SKIP_OPTIONS).toEqual(["0", "50", "100", "150", "200"]);
});

test("the choices offered are YouTube's own", () => {
  expect(SORTS.map((s) => s.id)).toEqual(["relevance", "date", "viewCount", "rating"]);
  expect(LENGTHS.map((l) => l.id)).toEqual(["any", "short", "medium", "long"]);
  expect(PERIODS.map((p) => p.id)).toEqual(["any", "day", "week", "month", "year"]);
  expect(CHANNEL_SHOWS.map((c) => [c.id, c.playlist])).toEqual([
    ["videos", "UULF"],
    ["shorts", "UUSH"],
    ["live", "UULV"],
    ["all", "UU"]
  ]);
});

test("tidy and slug", () => {
  expect(tidy("a\u0000b\tc", 10)).toBe("a b c");
  expect(tidy(5, 10)).toBe("");
  expect(tidy("abcdefghij", 5)).toBe("abcd…");
  expect(tidy("abcdefghij", 5, { ellipsis: false })).toBe("abcde");
  expect(slug("  --Hello, World!--  ")).toBe("hello-world");
  expect(slug("x".repeat(40))).toHaveLength(32);
});
