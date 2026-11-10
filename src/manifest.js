const { normalizeConfig, isConfigured, effectiveTmdbKey, CONTENT_TYPES } = require("./config");
const { ANIME_SOURCES } = require("./ids");
const { ITEM_TYPE, ITEM_PREFIX, LEGACY_TYPE, LEGACY_PREFIX, CHANNEL_TYPE } = require("./items");
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
 *   list, as items of the type "youtube" with yt_id: ids (items.js).
 *   Metadata is claimed for that type and those ids alone, per resource, so
 *   the app never asks YouStream about a film. Videos saved before 0.8.0
 *   ("YouTube", youstream:) are claimed too, and the videos of Stremio's own
 *   YouTube add-on ("channel", yt_id:) get streams.
 */
const ADDON_ID = "org.deejay189393.youstream";
const ADDON_VERSION = "0.17.0";
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

/** The ids anime databases name an anime by (ids.js): kitsu:, mal:, anilist:, anidb:. */
const ANIME_PREFIXES = ANIME_SOURCES.map((source) => `${source}:`);

/**
 * The id prefixes this server can read for a given reader: films' and
 * shows' when they are switched on, anime's when anime is. `tmdb:` ids need
 * a TMDB key -- the reader's or the server's -- so without one the prefix is
 * not claimed, and the app does not ask about ids that could only fail.
 */
function idPrefixes(settings) {
  const titles = settings.types.length ? ["tt", ...(effectiveTmdbKey(settings) ? ["tmdb:"] : [])] : [];
  return [...titles, ...(settings.anime ? ANIME_PREFIXES : [])];
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
 * The types titles are streamed for: films and shows as switched on, and
 * with anime "anime" -- which Kitsu-backed addons file anime under -- and
 * the usual two, which they file some under too. An app matches a type and
 * a prefix each on its own, so a film's id may then be asked about with
 * films off; the stream handler answers only what is switched on (finder.js).
 */
function typesFor(settings) {
  return settings.anime ? [...CONTENT_TYPES, "anime"] : [...settings.types];
}

/**
 * The reader's catalogs, in their order, then the one that answers search.
 *
 * Search is a single catalog, so a search shows one row of YouTube results,
 * named for the addon. Its `search` extra is required, which keeps it off
 * the home screen and out of Discover, where it would be an empty row.
 * Every catalog declares its page steps (catalogs.SKIP_OPTIONS).
 *
 * A catalog the reader keeps off the home screen requires a genre, of one
 * option. Stremio's home screen (its Board) and Nuvio's list only catalogs
 * that need nothing, while both Discovers list a catalog whose required
 * extras have options, asking for the first: so it is in Discover alone,
 * the same videos under the same id.
 */
const DISCOVER_ONLY = { name: "genre", options: ["All"], isRequired: true };

function catalogsFor(settings) {
  const skip = { name: "skip", options: SKIP_OPTIONS };
  return [
    ...settings.catalogs.map((entry) => ({ type: ITEM_TYPE, id: entry.id, name: entry.name, extra: entry.home ? [skip] : [DISCOVER_ONLY, skip] })),
    ...(settings.search
      ? [{ type: ITEM_TYPE, id: SEARCH_CATALOG_ID, name: identity().name, extra: [{ name: "search", isRequired: true }, skip] }]
      : [])
  ];
}

/** The types and id prefixes a YouTube video comes with (items.js). */
const VIDEO_TYPES = [ITEM_TYPE, LEGACY_TYPE];
const VIDEO_PREFIXES = [ITEM_PREFIX, LEGACY_PREFIX];

/**
 * What a configured addon serves. Metadata only for YouTube items; streams
 * for those and for films and shows, each resource with its own types and
 * id prefixes, so neither is asked about the other's ids. The top-level
 * types are what the addon lists, so the old type and "channel" appear only
 * where they are answered.
 */
function configuredParts(settings) {
  const types = typesFor(settings);
  const prefixes = types.length ? idPrefixes(settings) : [];
  const catalogs = catalogsFor(settings);
  return {
    resources: [
      ...(catalogs.length ? ["catalog"] : []),
      { name: "meta", types: VIDEO_TYPES, idPrefixes: VIDEO_PREFIXES },
      { name: "stream", types: [...types, ...VIDEO_TYPES, CHANNEL_TYPE], idPrefixes: [...prefixes, ...VIDEO_PREFIXES] }
    ],
    types: [...types, ITEM_TYPE],
    idPrefixes: [...prefixes, ...VIDEO_PREFIXES],
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
    idPrefixes: ["tt", "tmdb:", ...ANIME_PREFIXES, ...VIDEO_PREFIXES],
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
  ANIME_PREFIXES,
  UNCONFIGURED_PREFIX,
  SEARCH_CATALOG_ID,
  ADDON_ID,
  ADDON_VERSION,
  ADDON_NAME,
  DESCRIPTION
};
