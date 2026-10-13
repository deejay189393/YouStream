const {
  buildManifest,
  getUnconfiguredManifest,
  buildInterfaceManifest,
  identity,
  stremioAddonsConfig,
  ADDON_ID,
  ADDON_VERSION,
  UNCONFIGURED_PREFIX
} = require("../src/manifest");
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

  test("the reader's content types", () => {
    expect(buildManifest({ youtubeKey: "k", types: ["series"] }, BASE).types).toEqual(["series", "anime"]);
  });

  test("tmdb: ids are claimed only when there is a TMDB key to read them with", () => {
    expect(buildManifest({ youtubeKey: "k", tmdbKey: "t" }, BASE).idPrefixes).toEqual(["tt", "kitsu:", "tmdb:"]);
    process.env.TMDB_API_KEY = "server";
    expect(buildManifest({ youtubeKey: "k" }, BASE).idPrefixes).toEqual(["tt", "kitsu:", "tmdb:"]);
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
  expect(manifest.resources).toEqual(["stream"]);
  expect(manifest.idPrefixes).toContain("tmdb:");
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
