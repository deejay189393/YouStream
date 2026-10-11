const { normalizeConfig, isConfigured, effectiveTmdbKey } = require("./config");

/**
 * The addon's manifest: a stream-only addon for films and shows.
 *
 * It serves no catalogs and no metadata. It sits beside whatever already
 * provides those (Cinemeta, TMDB, Kitsu), and when the reader opens a film or
 * an episode, the app asks it, along with every other stream addon, for ways
 * to play it.
 */
const ADDON_ID = "org.deejay189393.youstream";
const ADDON_VERSION = "0.1.0";
const ADDON_NAME = "YouStream";
const CONTACT_EMAIL = "deejay189393@users.noreply.github.com";
const DESCRIPTION =
  "Movies and episodes that are on YouTube, playable from Stremio and Nuvio. Matches full uploads by runtime, so you get the film or the episode, never its trailer.";

/**
 * The beta deployment runs the same code from another branch. Marking it
 * with its own id and name lets a reader install both side by side and tell
 * them apart: two addons with one id collide in an app's addon list.
 */
function releaseChannel() {
  return process.env.RELEASE_CHANNEL === "beta" ? "beta" : "stable";
}

function identity() {
  const beta = releaseChannel() === "beta";
  return { id: beta ? `${ADDON_ID}.beta` : ADDON_ID, name: beta ? `${ADDON_NAME} Beta` : ADDON_NAME };
}

/**
 * The stremio-addons.net listing claim, when there is one. That site has
 * the manifest echo back a signature it issues, bound to one manifest URL;
 * none has been issued yet, so it is read from the environment and left out
 * entirely until it is set.
 */
function stremioAddonsConfig() {
  const signature = process.env.STREMIO_ADDONS_CONFIG_SIGNATURE;
  if (!signature) return null;
  return { issuer: process.env.STREMIO_ADDONS_CONFIG_ISSUER || "https://stremio-addons.net", signature };
}

/**
 * The id prefixes this server can read for a given reader. `tmdb:` ids need
 * a TMDB key -- the reader's or the server's -- so without one the prefix is
 * not claimed, and the app does not ask about ids that could only fail.
 */
function idPrefixes(settings) {
  return ["tt", "kitsu:", ...(effectiveTmdbKey(settings) ? ["tmdb:"] : [])];
}

/**
 * Kitsu-backed anime addons file their titles under "anime" as well as the
 * usual types, so that type is claimed alongside them.
 */
function typesFor(settings) {
  return [...settings.types, "anime"];
}

/**
 * Deliberately no native `config` array: the SDK would generate its own flat
 * form from it and route the landing page there, replacing /configure.
 * `behaviorHints.configurable` plus a page at /configure is the documented
 * way to keep a custom one.
 */
function buildManifest(config, baseUrl) {
  const settings = normalizeConfig(config);
  const configured = isConfigured(config);
  const signed = stremioAddonsConfig();
  return {
    ...identity(),
    version: ADDON_VERSION,
    description: DESCRIPTION,
    // Versioned: apps cache addon artwork by URL, so new bytes at an old
    // URL would leave the old picture on screen indefinitely.
    logo: `${baseUrl}/logo.png?v=${ADDON_VERSION}`,
    background: `${baseUrl}/background.png?v=${ADDON_VERSION}`,
    contactEmail: CONTACT_EMAIL,
    resources: ["stream"],
    types: typesFor(settings),
    idPrefixes: idPrefixes(settings),
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: !configured },
    ...(signed ? { stremioAddonsConfig: signed } : {})
  };
}

/** Served with no config in the URL: install is replaced by Configure. */
function getUnconfiguredManifest(baseUrl) {
  return buildManifest(null, baseUrl);
}

/**
 * The manifest the SDK's router is built from. Never served: it exists
 * because the SDK builds one static interface at startup, and it needs a
 * non-empty `config` to prefix its routes with the optional `/:config?`.
 */
function buildInterfaceManifest() {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: "Internal routing manifest (not served).",
    resources: ["stream"],
    types: ["movie", "series", "anime"],
    idPrefixes: ["tt", "kitsu:", "tmdb:"],
    catalogs: [],
    config: [{ key: "youtubeKey", type: "password", title: "YouTube API key" }],
    behaviorHints: { configurable: true, configurationRequired: true }
  };
}

module.exports = {
  buildManifest,
  getUnconfiguredManifest,
  buildInterfaceManifest,
  identity,
  releaseChannel,
  stremioAddonsConfig,
  idPrefixes,
  ADDON_ID,
  ADDON_VERSION,
  ADDON_NAME,
  DESCRIPTION
};
