const { normalizeConfig, isConfigured, effectiveTmdbKey } = require("./config");
const { ITEM_TYPE, ITEM_PREFIX } = require("./items");
const { SKIP_OPTIONS } = require("./catalogs");

/**
 * The addon's manifest. Two things in one addon:
 *
 *   Films and shows. Streams only: YouStream sits beside whatever provides
 *   their catalogs and metadata (Cinemeta, TMDB, Kitsu), and when the reader
 *   opens a film or an episode, the app asks it, with every other stream
 *   addon, for ways to play it.
 *
 *   YouTube itself. Catalogs (the reader's searches, channels, playlists and
 *   Trending), a search row, and metadata and streams for every video they
 *   list, as items of the type "YouTube" (items.js). Metadata is claimed for
 *   that type and its "youstream:" ids alone, per resource, so the app never
 *   asks YouStream about a film.
 */
const ADDON_ID = "org.deejay189393.youstream";
const ADDON_VERSION = "0.7.4";
const ADDON_NAME = "YouStream";
const CONTACT_EMAIL = "deejay189393@users.noreply.github.com";
const DESCRIPTION =
  "Movies and episodes that are on YouTube, playable from Stremio and Nuvio, matched by runtime so you get the film or the episode, never its trailer. Plus YouTube itself: search it, and keep searches, channels, playlists and Trending as catalogs.";

/** The catalog that answers the app's search; never shown on its own. */
const SEARCH_CATALOG_ID = "search";

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
 * What a manifest with no usable key claims instead: one prefix no title id
 * ever starts with, so an app that installs it anyway never asks it for
 * anything. Stremio will not install it (configurationRequired), but Nuvio
 * ignores that flag. Not an empty list: Nuvio reads an empty idPrefixes, or
 * an empty types, as "every id" and "every type".
 */
const UNCONFIGURED_PREFIX = "youstream-not-configured:";

/**
 * The types films and shows are streamed for. Kitsu-backed anime addons
 * file their titles under "anime" as well as the usual types, so that type
 * is claimed alongside them -- unless the reader turned films and shows off.
 */
function typesFor(settings) {
  return settings.types.length ? [...settings.types, "anime"] : [];
}

/**
 * The reader's catalogs, in their order, then the one that answers search.
 *
 * Search is a single catalog, so a search shows one row of YouTube results,
 * named for the addon. Its `search` extra is required, which keeps it off
 * the home screen and out of Discover, where it would be an empty row.
 * Every catalog declares its page steps (catalogs.SKIP_OPTIONS).
 */
function catalogsFor(settings) {
  const skip = { name: "skip", options: SKIP_OPTIONS };
  return [
    ...settings.catalogs.map((entry) => ({ type: ITEM_TYPE, id: entry.id, name: entry.name, extra: [skip] })),
    ...(settings.search
      ? [{ type: ITEM_TYPE, id: SEARCH_CATALOG_ID, name: identity().name, extra: [{ name: "search", isRequired: true }, skip] }]
      : [])
  ];
}

/**
 * What a configured addon serves. Metadata only for YouTube items; streams
 * for those and for films and shows, each resource with its own types and
 * id prefixes, so neither is asked about the other's ids.
 */
function configuredParts(settings) {
  const types = typesFor(settings);
  const prefixes = types.length ? idPrefixes(settings) : [];
  const catalogs = catalogsFor(settings);
  return {
    resources: [
      ...(catalogs.length ? ["catalog"] : []),
      { name: "meta", types: [ITEM_TYPE], idPrefixes: [ITEM_PREFIX] },
      { name: "stream", types: [...types, ITEM_TYPE], idPrefixes: [...prefixes, ITEM_PREFIX] }
    ],
    types: [...types, ITEM_TYPE],
    idPrefixes: [...prefixes, ITEM_PREFIX],
    catalogs
  };
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
  const parts = configured
    ? configuredParts(settings)
    : { resources: ["stream"], types: typesFor(settings), idPrefixes: [UNCONFIGURED_PREFIX], catalogs: [] };
  return {
    ...identity(),
    version: ADDON_VERSION,
    description: DESCRIPTION,
    // Versioned: apps cache addon artwork by URL, so new bytes at an old
    // URL would leave the old picture on screen indefinitely.
    logo: `${baseUrl}/logo.png?v=${ADDON_VERSION}`,
    background: `${baseUrl}/background.png?v=${ADDON_VERSION}`,
    contactEmail: CONTACT_EMAIL,
    ...parts,
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
 * because the SDK builds one static interface at startup. It needs a
 * non-empty `config` to prefix its routes with the optional `/:config?`, and
 * a catalog for the router to serve catalogs at all; which catalog ids exist
 * is each reader's own (catalogs.js), read from their config per request.
 */
function buildInterfaceManifest() {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: "Internal routing manifest (not served).",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series", "anime", ITEM_TYPE],
    idPrefixes: ["tt", "kitsu:", "tmdb:", ITEM_PREFIX],
    catalogs: [{ type: ITEM_TYPE, id: SEARCH_CATALOG_ID, name: ADDON_NAME, extra: [{ name: "search", isRequired: true }] }],
    config: [{ key: "youtubeKey", type: "password", title: "YouTube API key" }],
    behaviorHints: { configurable: true, configurationRequired: true }
  };
}

module.exports = {
  buildManifest,
  getUnconfiguredManifest,
  buildInterfaceManifest,
  catalogsFor,
  typesFor,
  identity,
  releaseChannel,
  stremioAddonsConfig,
  idPrefixes,
  UNCONFIGURED_PREFIX,
  SEARCH_CATALOG_ID,
  ADDON_ID,
  ADDON_VERSION,
  ADDON_NAME,
  DESCRIPTION
};
