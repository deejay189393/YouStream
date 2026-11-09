const {
  normalizeEntry,
  normalizeCatalogs,
  toStoredCatalogs,
  parseSourceLink,
  SOURCE_KINDS,
  tidy,
  slug,
  SORTS,
  LENGTH_RANGES,
  MAX_LENGTH_MINUTES,
  lengthOf,
  PERIODS,
  CHANNEL_SHOWS,
  TRENDING,
  PAGE_SIZE,
  MAX_PAGES,
  SKIP_OPTIONS,
  MAX_CATALOGS,
  MAX_QUERY_LENGTH,
  MAX_NAME_LENGTH,
  FILTER_MODES,
  FILTER_SCOPES,
  MAX_FILTER_WORDS,
  MAX_FILTER_WORD_LENGTH,
  filterWords,
  toStoredEntry,
  VIDEO_TYPES,
  ALL_TYPES,
  CHANNEL_TYPES,
  typesOf,
  onlyShorts,
  everyType
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
      within: "any",
      types: ["videos", "shorts", "live"],
      filter: null
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
      types: ["videos"],
      sort: "date",
      length: "any",
      filter: null
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
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", show: "podcasts" }).types).toEqual(["videos"]);
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
      playlist: PLAYLIST,
      types: ["videos", "shorts", "live"],
      length: "any",
      filter: null
    });
    expect(normalizeEntry({ playlist: PLAYLIST }).name).toBe("YouTube playlist");
  });

  test.each([["short"], ["has spaces in it"], [{}]])("no catalog for the playlist id %p", (playlist) => {
    expect(normalizeEntry({ playlist })).toBeNull();
  });
});

describe("a catalog's keyword filter", () => {
  test("keeps only, or leaves out, the videos mentioning its words; stored under its mode", () => {
    const left = normalizeEntry({ q: "indian stand up comedy", sort: "date", exclude: ["Gaurav Kapoor"] });
    expect(left.filter).toEqual({ mode: "exclude", words: ["Gaurav Kapoor"], scope: "all" });
    expect(toStoredEntry(left)).toEqual({ q: "indian stand up comedy", sort: "date", exclude: ["Gaurav Kapoor"] });
    const kept = normalizeEntry({ trending: "all", include: ["cricket", "IPL"] });
    expect(kept.filter).toEqual({ mode: "include", words: ["cricket", "IPL"], scope: "all" });
    expect(toStoredEntry(kept)).toEqual({ trending: "all", include: ["cricket", "IPL"] });
  });

  test("is no part of the catalog's id or name, so editing it never makes a new row", () => {
    const plain = normalizeEntry({ q: "stand up", sort: "date" });
    const filtered = normalizeEntry({ q: "stand up", sort: "date", exclude: ["someone"] });
    expect([filtered.id, filtered.name]).toEqual([plain.id, plain.name]);
    expect(normalizeCatalogs([{ q: "stand up" }, { q: "stand up", exclude: ["x"] }])).toHaveLength(1);
  });

  test("its words: a list or a comma-separated line, tidied, without blanks or repeats in any case", () => {
    expect(normalizeEntry({ trending: "all", exclude: " Gaurav  Kapoor ,gaurav kapoor,, Zakir\nKhan " }).filter.words).toEqual([
      "Gaurav Kapoor",
      "Zakir Khan"
    ]);
    expect(filterWords([7, "  ", "x".repeat(MAX_FILTER_WORD_LENGTH + 5)])).toEqual(["x".repeat(MAX_FILTER_WORD_LENGTH)]);
    const many = Array.from({ length: MAX_FILTER_WORDS + 5 }, (_, i) => `w${i}`);
    expect(filterWords(many)).toHaveLength(MAX_FILTER_WORDS);
    expect(filterWords(null)).toEqual([]);
  });

  test("none without words; leaving out wins over keeping, as only a hand-edited catalog has both", () => {
    expect(normalizeEntry({ trending: "all", exclude: [] }).filter).toBeNull();
    expect(normalizeEntry({ trending: "all", include: ", ," }).filter).toBeNull();
    expect(normalizeEntry({ trending: "all", include: ["a"], exclude: ["b"] }).filter).toEqual({ mode: "exclude", words: ["b"], scope: "all" });
  });

  test("looks in the title and channel only when asked, stored as filterIn only then", () => {
    const titled = normalizeEntry({ q: "stand up", exclude: ["someone"], filterIn: "title" });
    expect(titled.filter).toEqual({ mode: "exclude", words: ["someone"], scope: "title" });
    expect(toStoredEntry(titled)).toEqual({ q: "stand up", exclude: ["someone"], filterIn: "title" });
    expect(normalizeEntry({ q: "stand up", exclude: ["someone"], filterIn: "everywhere" }).filter.scope).toBe("all");
    expect(normalizeEntry({ q: "stand up", filterIn: "title" }).filter).toBeNull();
    expect(toStoredEntry(normalizeEntry({ q: "stand up", filterIn: "title" }))).toEqual({ q: "stand up" });
    expect(FILTER_SCOPES.map((s) => s.id)).toEqual(["all", "title"]);
  });

  test("an entry already normalized normalizes to itself, filter and all", () => {
    for (const raw of [
      { q: "x", exclude: ["a"] },
      { q: "y", exclude: ["a"], filterIn: "title" },
      { channel: CHANNEL, name: "N", include: ["b"] },
      { playlist: PLAYLIST }
    ]) {
      const once = normalizeEntry(raw);
      expect(normalizeEntry(once)).toEqual(once);
    }
    expect(normalizeEntry({ trending: "all", filter: { mode: "bogus", words: ["x"] } }).filter).toBeNull();
    expect(FILTER_MODES.map((m) => m.id)).toEqual(["include", "exclude"]);
  });
});

describe("a Trending catalog", () => {
  test("all of it, or one category", () => {
    expect(normalizeEntry({ trending: "all" })).toEqual({
      kind: "trending",
      id: "trending.all",
      name: "Trending",
      trending: "all",
      types: ["videos", "shorts", "live"],
      length: "any",
      filter: null
    });
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
    { channel: CHANNEL, name: "MKBHD", types: ["live"] },
    { channel: CHANNEL, name: "MKBHD", sort: "viewCount" },
    { channel: CHANNEL, name: "MKBHD", types: ["videos", "shorts", "live"] },
    { playlist: PLAYLIST, name: "Stories" },
    { trending: "gaming" }
  ]);
  expect(normalizeCatalogs(toStoredCatalogs(entries))).toEqual(entries);
});

describe("a row's length", () => {
  test("YouTube's own three, any of four ranges, or minutes, each kept as one word", () => {
    const cases = [
      ["any", "any", null, false, ""],
      ["short", "short", "short", false, "Under 4 min"],
      ["medium", "medium", "medium", false, "4–20 min"],
      ["long", "long", "long", false, "Over 20 min"],
      ["20to60+over60", "long", "long", false, "Over 20 min"],
      ["over60+under4", "under4+over60", null, true, "Under 4 min & over 1 hr"],
      ["under4+4to20", "under4+4to20", null, true, "Under 20 min"],
      ["4to20+20to60", "4to20+20to60", null, true, "4–60 min"],
      ["under4+4to20+20to60", "under4+4to20+20to60", null, true, "Under 1 hr"],
      ["20to60", "20to60", "long", true, "20–60 min"],
      ["over60", "over60", "long", true, "Over 1 hr"],
      ["under4+4to20+20to60+over60", "any", null, false, ""],
      [" 30-45 ", "30-45", "long", true, "30–45 min"],
      ["90-", "90-", "long", true, "Over 90 min"],
      ["60-", "60-", "long", true, "Over 1 hr"],
      ["0-10", "0-10", null, true, "Under 10 min"],
      ["0-3", "0-3", "short", true, "Under 3 min"],
      ["5-15", "5-15", "medium", true, "5–15 min"]
    ];
    for (const [raw, id, youtube, trims, short] of cases) {
      expect([raw, lengthOf(raw)]).toEqual([raw, expect.objectContaining({ id, youtube, trims, short })]);
    }
  });

  test("anything else is any length", () => {
    for (const raw of ["0-", "45-30", "30-30", "0-2000", "1441-", "x", "under4+x", "", null, 7]) expect(lengthOf(raw).id).toBe("any");
  });

  test("the ranges it keeps, in seconds", () => {
    expect(lengthOf("under4+over60").ranges).toEqual([
      [0, 239],
      [3601, Infinity]
    ]);
    expect(lengthOf("30-45").ranges).toEqual([[1800, 2700]]);
    expect(lengthOf("90-").ranges).toEqual([[5400, Infinity]]);
    expect(lengthOf("any").ranges).toEqual([]);
  });

  test("YouTube's length holding a range lets in a second either side of its bounds", () => {
    expect(lengthOf("20-").youtube).toBe("long");
    expect(lengthOf("0-4").youtube).toBe("short");
    expect(lengthOf("4-20").youtube).toBe("medium");
  });

  test("every kind of row may keep to one, said in its name and its id, and stored; rows of any length keep their ids", () => {
    const rows = [
      [{ q: "lofi", length: "20to60" }, /^search\.lofi\./, "lofi · 20–60 min"],
      [{ channel: CHANNEL, name: "N", length: "over60" }, `channel.${CHANNEL}.videos.over60`, "N · Over 1 hr"],
      [{ channel: CHANNEL, name: "N", sort: "viewCount", length: "30-45" }, `channel.${CHANNEL}.videos.viewCount.30-45`, "N · Most viewed · 30–45 min"],
      [{ playlist: PLAYLIST, name: "P", length: "under4+4to20" }, `playlist.${PLAYLIST}.under4+4to20`, "P · Under 20 min"],
      [{ trending: "music", types: ["videos"], length: "long" }, "trending.music.videos.long", "Trending Music · Videos · Over 20 min"]
    ];
    for (const [raw, id, name] of rows) {
      const entry = normalizeEntry(raw);
      expect(entry.id).toEqual(id instanceof RegExp ? expect.stringMatching(id) : id);
      expect(entry.name).toBe(name);
      expect(toStoredEntry(entry).length).toBe(entry.length);
      expect(normalizeEntry(toStoredEntry(entry))).toEqual(entry);
    }
    expect(normalizeEntry({ q: "lofi", length: "20to60" }).id).not.toBe(normalizeEntry({ q: "lofi" }).id);
    expect(normalizeEntry({ q: "lofi", length: "20to60+over60" }).id).toBe(normalizeEntry({ q: "lofi", length: "long" }).id);
    expect(normalizeEntry({ playlist: PLAYLIST }).id).toBe(`playlist.${PLAYLIST}`);
    expect(toStoredEntry(normalizeEntry({ trending: "all", length: "nonsense" }))).toEqual({ trending: "all" });
  });

  test("a row of Shorts alone has none, every Short being under four minutes", () => {
    for (const raw of [{ q: "x", types: ["shorts"], length: "over60" }, { channel: CHANNEL, types: ["shorts"], length: "under4" }, { trending: "all", types: ["shorts"], length: "30-45" }]) {
      expect(normalizeEntry(raw).length).toBe("any");
    }
  });
});

describe("a row's name of its own", () => {
  test("is what apps show, tidied; the id and the made name's parts stay", () => {
    const made = normalizeEntry({ q: "cricket highlights", sort: "date" });
    const named = normalizeEntry({ q: "cricket highlights", sort: "date", label: "  My   cricket \n " });
    expect(named).toEqual({ ...made, name: "My cricket", label: "My cricket" });
    expect(toStoredEntry(named)).toEqual({ q: "cricket highlights", sort: "date", label: "My cricket" });
    expect(normalizeEntry(named)).toEqual(named);
  });

  test("a blank one, or one that is no text, is none", () => {
    expect(normalizeEntry({ trending: "all", label: "   " })).not.toHaveProperty("label");
    expect(normalizeEntry({ trending: "all", label: 5 }).name).toBe("Trending");
  });

  test("cut to the longest name a row can have, and stored before the filter", () => {
    const entry = normalizeEntry({ playlist: PLAYLIST, name: "P", label: "x".repeat(200), exclude: ["a"] });
    expect(entry.label).toHaveLength(MAX_NAME_LENGTH);
    expect(Object.keys(toStoredEntry(entry))).toEqual(["playlist", "name", "label", "exclude"]);
  });
});

describe("a catalog's kinds of video", () => {
  test("videos, Shorts and live streams, each told by a format of youtube.js", () => {
    expect(VIDEO_TYPES.map((t) => [t.id, t.label, t.format])).toEqual([
      ["videos", "Videos", "video"],
      ["shorts", "Shorts", "short"],
      ["live", "Live streams", "stream"]
    ]);
    expect(ALL_TYPES).toEqual(["videos", "shorts", "live"]);
    expect(CHANNEL_TYPES).toEqual(["videos"]);
  });

  test("every kind unless chosen, and a channel's videos alone, as rows have always been", () => {
    for (const raw of [{ q: "lofi" }, { playlist: PLAYLIST }, { trending: "all" }]) expect(normalizeEntry(raw).types).toEqual(ALL_TYPES);
    expect(normalizeEntry({ channel: CHANNEL }).types).toEqual(["videos"]);
  });

  test("named in a list or a comma-separated line, in their own order, the unknown left out", () => {
    expect(typesOf(["live", "videos"], ALL_TYPES)).toEqual(["videos", "live"]);
    expect(typesOf(" shorts , live ", ALL_TYPES)).toEqual(["shorts", "live"]);
    expect(typesOf(["podcasts"], ALL_TYPES)).toBe(ALL_TYPES);
    expect(typesOf(5, CHANNEL_TYPES)).toBe(CHANNEL_TYPES);
    expect(typesOf([], CHANNEL_TYPES)).toBe(CHANNEL_TYPES);
    expect(onlyShorts(["shorts"])).toBe(true);
    expect(onlyShorts(["videos", "shorts"])).toBe(false);
    expect(everyType(ALL_TYPES)).toBe(true);
    expect(everyType(["videos", "live"])).toBe(false);
  });

  test("said in a row's name when they are not its usual", () => {
    expect(normalizeEntry({ q: "cricket", types: ["videos", "live"] }).name).toBe("cricket · Videos & live");
    expect(normalizeEntry({ q: "cricket", sort: "date", types: ["videos"] }).name).toBe("cricket · Newest · Videos");
    expect(normalizeEntry({ playlist: PLAYLIST, name: "Stories", types: ["videos", "shorts"] }).name).toBe("Stories · Videos & Shorts");
    expect(normalizeEntry({ trending: "music", types: ["shorts", "live"] }).name).toBe("Trending Music · Shorts & live");
    expect(normalizeEntry({ trending: "music", types: ["live"] }).name).toBe("Trending Music · Live");
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", types: ["videos", "live"], sort: "viewCount" }).name).toBe(
      "MKBHD · Videos & live · Most viewed"
    );
    expect(normalizeEntry({ channel: CHANNEL, name: "MKBHD", types: ALL_TYPES }).name).toBe("MKBHD · Everything");
    expect(normalizeEntry({ q: "cricket", types: ALL_TYPES }).name).toBe("cricket");
  });

  test("a row of every kind keeps the id it had before kinds; another kind is another row", () => {
    const every = normalizeEntry({ q: "cricket highlights", sort: "date" });
    expect(normalizeEntry({ q: "cricket highlights", sort: "date", types: ALL_TYPES }).id).toBe(every.id);
    expect(every.id).toBe("search.cricket-highlights.d572f4de");
    const some = normalizeEntry({ q: "cricket highlights", sort: "date", types: ["videos", "live"] }).id;
    expect(some).toMatch(/^search\.cricket-highlights\.[0-9a-f]{8}$/);
    expect(some).not.toBe(every.id);
    expect(normalizeEntry({ playlist: PLAYLIST, types: ["shorts"] }).id).toBe(`playlist.${PLAYLIST}.shorts`);
    expect(normalizeEntry({ trending: "all", types: ["videos", "live"] }).id).toBe("trending.all.videos-live");
    expect(normalizeEntry({ channel: CHANNEL, types: ["videos", "live"] }).id).toBe(`channel.${CHANNEL}.videos-live`);
  });

  test("a channel row stored as the one list it read is the same row, kept as its kinds", () => {
    for (const [show, types] of [
      ["videos", ["videos"]],
      ["shorts", ["shorts"]],
      ["live", ["live"]],
      ["all", ALL_TYPES]
    ]) {
      const old = normalizeEntry({ channel: CHANNEL, name: "N", show });
      const now = normalizeEntry({ channel: CHANNEL, name: "N", types });
      expect(old).toEqual(now);
      expect(old.id).toBe(`channel.${CHANNEL}.${show}`);
    }
    // Kinds stored win over the list it read.
    expect(normalizeEntry({ channel: CHANNEL, show: "shorts", types: ["live"] }).types).toEqual(["live"]);
  });

  test("a search of Shorts alone has no length of its own: it asks for under four minutes", () => {
    const entry = normalizeEntry({ q: "cricket", length: "long", types: ["shorts"] });
    expect(entry).toMatchObject({ length: "any", types: ["shorts"], name: "cricket · Shorts" });
    expect(normalizeEntry({ q: "cricket", types: ["shorts"] }).id).toBe(entry.id);
    expect(toStoredEntry(entry)).toEqual({ q: "cricket", types: ["shorts"] });
    expect(normalizeEntry({ q: "cricket", length: "long", types: ["videos", "shorts"] }).length).toBe("long");
  });

  test("stored only when they are not the row's usual", () => {
    const entries = normalizeCatalogs([
      { q: "a", types: ["videos", "live"] },
      { channel: CHANNEL, name: "N", types: ["shorts", "live"], sort: "viewCount" },
      { playlist: PLAYLIST, name: "P", types: ["videos"] },
      { trending: "news", types: ["live"] },
      { q: "b", types: ALL_TYPES }
    ]);
    expect(toStoredCatalogs(entries)).toEqual([
      { q: "a", types: ["videos", "live"] },
      { channel: CHANNEL, name: "N", types: ["shorts", "live"], sort: "viewCount" },
      { playlist: PLAYLIST, name: "P", types: ["videos"] },
      { trending: "news", types: ["live"] },
      { q: "b" }
    ]);
    expect(normalizeCatalogs(toStoredCatalogs(entries))).toEqual(entries);
    expect(normalizeCatalogs(entries)).toEqual(entries);
  });
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
  expect(LENGTH_RANGES.map((l) => [l.id, l.min, l.max])).toEqual([
    ["under4", 0, 239],
    ["4to20", 240, 1200],
    ["20to60", 1201, 3600],
    ["over60", 3601, Infinity]
  ]);
  expect(MAX_LENGTH_MINUTES).toBe(1440);
  expect(PERIODS.map((p) => p.id)).toEqual(["any", "day", "week", "month", "year"]);
  expect(CHANNEL_SHOWS.map((c) => [c.id, c.playlist, c.popular])).toEqual([
    ["videos", "UULF", "UULP"],
    ["shorts", "UUSH", "UUPS"],
    ["live", "UULV", "UUPV"],
    ["all", "UU", "PU"]
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
