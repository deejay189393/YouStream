const {
  buildManifest,
  getUnconfiguredManifest,
  buildInterfaceManifest,
  identity,
  stremioAddonsConfig,
  catalogsFor,
  ADDON_ID,
  ADDON_VERSION,
  UNCONFIGURED_PREFIX,
  SEARCH_CATALOG_ID
} = require("../src/manifest");
const { normalizeConfig } = require("../src/config");
const { MAX_CATALOGS, MAX_QUERY_LENGTH, SKIP_OPTIONS } = require("../src/catalogs");
const { COUNTRIES, LANGUAGES, languageName } = require("../src/regions");

const BASE = "https://youstream.up.railway.app";

afterEach(() => {
  delete process.env.RELEASE_CHANNEL;
  delete process.env.TMDB_API_KEY;
  delete process.env.STREMIO_ADDONS_CONFIG_SIGNATURE;
  delete process.env.STREMIO_ADDONS_CONFIG_ISSUER;
});

describe("the served manifest", () => {
  test("unconfigured: stream-only, configuration required, and claiming no title's id", () => {
    expect(getUnconfiguredManifest(BASE)).toEqual({
      id: ADDON_ID,
      name: "YouStream",
      version: ADDON_VERSION,
      description: expect.stringContaining("YouTube"),
      logo: `${BASE}/logo.png?v=${ADDON_VERSION}`,
      background: `${BASE}/background.png?v=${ADDON_VERSION}`,
      contactEmail: expect.any(String),
      resources: ["stream"],
      types: ["movie", "series", "anime"],
      idPrefixes: [UNCONFIGURED_PREFIX],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: true }
    });
  });

  test("installed unconfigured anyway (Nuvio ignores configurationRequired), it is never asked about a title", () => {
    // Nuvio's rule: a non-empty idPrefixes list must contain a prefix of the id.
    const { idPrefixes } = getUnconfiguredManifest(BASE);
    expect(idPrefixes.length).toBeGreaterThan(0);
    ["tt0063350", "tt0063350:1:1", "kitsu:45398:3", "tmdb:10331"].forEach((id) =>
      expect(idPrefixes.some((p) => id.startsWith(p))).toBe(false)
    );
    // A config without a key is just as unconfigured.
    expect(buildManifest({ types: ["movie"] }, BASE).idPrefixes).toEqual([UNCONFIGURED_PREFIX]);
  });

  test("configured: installable", () => {
    expect(buildManifest({ youtubeKey: "k" }, BASE).behaviorHints).toEqual({ configurable: true, configurationRequired: false });
  });

  test("the reader's content types, and YouTube's own", () => {
    expect(buildManifest({ youtubeKey: "k", types: ["series"] }, BASE).types).toEqual(["series", "anime", "YouTube"]);
  });

  test("tmdb: ids are claimed only when there is a TMDB key to read them with", () => {
    expect(buildManifest({ youtubeKey: "k" }, BASE).idPrefixes).toEqual(["tt", "kitsu:", "youstream:"]);
    expect(buildManifest({ youtubeKey: "k", tmdbKey: "t" }, BASE).idPrefixes).toEqual(["tt", "kitsu:", "tmdb:", "youstream:"]);
    process.env.TMDB_API_KEY = "server";
    expect(buildManifest({ youtubeKey: "k" }, BASE).idPrefixes).toEqual(["tt", "kitsu:", "tmdb:", "youstream:"]);
  });

  test("metadata only for YouTube items, streams for those and for films and shows, each resource with its own ids", () => {
    const manifest = buildManifest({ youtubeKey: "k", catalogs: [{ trending: "all" }] }, BASE);
    expect(manifest.resources).toEqual([
      "catalog",
      { name: "meta", types: ["YouTube"], idPrefixes: ["youstream:"] },
      { name: "stream", types: ["movie", "series", "anime", "YouTube"], idPrefixes: ["tt", "kitsu:", "youstream:"] }
    ]);
  });

  test("the reader's catalogs in their order, then search, each paged in YouTube's steps", () => {
    const manifest = buildManifest({ youtubeKey: "k", search: true, catalogs: [{ q: "lofi", sort: "date" }, { trending: "music" }] }, BASE);
    expect(manifest.catalogs.map((c) => [c.type, c.name])).toEqual([
      ["YouTube", "lofi · Newest"],
      ["YouTube", "Trending Music"],
      ["YouTube", "YouStream"]
    ]);
    expect(manifest.catalogs[0].extra).toEqual([{ name: "skip", options: SKIP_OPTIONS }]);
    expect(manifest.catalogs[2]).toEqual({
      type: "YouTube",
      id: SEARCH_CATALOG_ID,
      name: "YouStream",
      extra: [{ name: "search", isRequired: true }, { name: "skip", options: SKIP_OPTIONS }]
    });
    expect(SKIP_OPTIONS).toEqual(["0", "50", "100", "150", "200"]);
  });

  test("search alone is a catalog too, on unless switched off, and with search off and no catalogs there is none", () => {
    // An addon installed before search existed has it too.
    expect(buildManifest({ youtubeKey: "k" }, BASE).catalogs.map((c) => c.id)).toEqual([SEARCH_CATALOG_ID]);
    expect(buildManifest({ youtubeKey: "k" }, BASE).resources[0]).toBe("catalog");
    const quiet = buildManifest({ youtubeKey: "k", search: false }, BASE);
    expect(quiet.catalogs).toEqual([]);
    expect(quiet.resources[0]).toEqual({ name: "meta", types: ["YouTube"], idPrefixes: ["youstream:"] });
  });

  test("YouTube alone: with films and shows off, only YouTube items are claimed", () => {
    const manifest = buildManifest({ youtubeKey: "k", types: [], search: true }, BASE);
    expect(manifest.types).toEqual(["YouTube"]);
    expect(manifest.idPrefixes).toEqual(["youstream:"]);
    expect(manifest.resources[2]).toEqual({ name: "stream", types: ["YouTube"], idPrefixes: ["youstream:"] });
  });

  test("the beta's search row is named for the beta", () => {
    process.env.RELEASE_CHANNEL = "beta";
    expect(catalogsFor(normalizeConfig({ search: true })).map((c) => c.name)).toEqual(["YouStream Beta"]);
  });

  test("the fullest config stays within the 8 KB Stremio's addon sync takes", () => {
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "s".repeat(300);
    const catalogs = Array.from({ length: MAX_CATALOGS + 5 }, (_, i) => ({
      q: `${"x".repeat(MAX_QUERY_LENGTH - 3)}${String(i).padStart(3, "0")}`,
      sort: "viewCount",
      length: "medium",
      within: "month"
    }));
    const manifest = buildManifest({ youtubeKey: "k", tmdbKey: "t", search: true, catalogs }, BASE);
    expect(manifest.catalogs).toHaveLength(MAX_CATALOGS + 1);
    expect(JSON.stringify(manifest).length).toBeLessThan(8192);
  });

  test("the beta deployment has its own id and name, so both can be installed", () => {
    process.env.RELEASE_CHANNEL = "beta";
    expect(identity()).toEqual({ id: `${ADDON_ID}.beta`, name: "YouStream Beta" });
    expect(buildManifest({ youtubeKey: "k" }, BASE)).toMatchObject({ id: `${ADDON_ID}.beta`, name: "YouStream Beta" });
  });

  test("any other channel is the stable one", () => {
    process.env.RELEASE_CHANNEL = "nightly";
    expect(identity()).toEqual({ id: ADDON_ID, name: "YouStream" });
  });

  test("the stremio-addons.net claim is served only once one is set", () => {
    expect(stremioAddonsConfig()).toBeNull();
    expect(getUnconfiguredManifest(BASE).stremioAddonsConfig).toBeUndefined();
    process.env.STREMIO_ADDONS_CONFIG_SIGNATURE = "sig";
    expect(getUnconfiguredManifest(BASE).stremioAddonsConfig).toEqual({ issuer: "https://stremio-addons.net", signature: "sig" });
    process.env.STREMIO_ADDONS_CONFIG_ISSUER = "https://other.example";
    expect(stremioAddonsConfig().issuer).toBe("https://other.example");
  });
});

test("the internal routing manifest has the config array the SDK needs for /:config routes", () => {
  const manifest = buildInterfaceManifest();
  expect(manifest.config.length).toBeGreaterThan(0);
  expect(manifest.resources).toEqual(["catalog", "meta", "stream"]);
  expect(manifest.idPrefixes).toEqual(["tt", "kitsu:", "tmdb:", "youstream:"]);
  // One catalog, so the router serves catalogs at all; each reader's own
  // catalog ids are read from their config.
  expect(manifest.catalogs.map((c) => c.id)).toEqual([SEARCH_CATALOG_ID]);
});

describe("regions", () => {
  test("countries and languages are named and sorted", () => {
    expect(COUNTRIES.find((c) => c.code === "IN").label).toBe("India");
    expect(LANGUAGES.find((l) => l.code === "hi").label).toBe("Hindi");
    const labels = COUNTRIES.map((c) => c.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
  });

  test("languageName is empty for anything unlisted", () => {
    expect(languageName("ta")).toBe("Tamil");
    expect(languageName("")).toBe("");
    expect(languageName(null)).toBe("");
  });
});
