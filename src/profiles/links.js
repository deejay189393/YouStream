const crypto = require("crypto");
const { identity } = require("../manifest");
const { getBaseUrl } = require("../baseUrl");

/**
 * A profile's install link:
 *
 *     https://<host>/<profile id>.<link token>/manifest.json
 *
 * One path segment, where a link without a profile carries its settings,
 * so the app asks for /<segment>/stream/..., /<segment>/catalog/... and
 * so on exactly as before. Here that segment is swapped for the settings
 * it opens, and the request goes on to the same handlers.
 *
 * Only the addon's own paths are opened this way. /<segment>/configure is
 * not: it asks for the password (server.js), so a link that gets out lets
 * someone use the addon -- and its owner's YouTube quota -- but never see
 * the settings or the keys in them.
 */

const PROFILE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SEGMENT = new RegExp(`^(${PROFILE_ID})\\.([A-Za-z0-9_-]{43})$`);
const PROFILE_ID_PATTERN = new RegExp(`^${PROFILE_ID}$`);

/** { id, token } for an install link's segment, else null. */
function parseLinkSegment(segment) {
  const match = SEGMENT.exec(String(segment));
  return match ? { id: match[1], token: match[2] } : null;
}

const installUrl = (baseUrl, id, token) => `${baseUrl}/${id}.${token}/manifest.json`;

/**
 * Opened links, for a minute: an app asks several times in a row (the
 * manifest, then rows, then streams). Keyed by the segment's hash, so the
 * tokens are not kept even in memory. Saving, replacing the link or
 * deleting the profile forgets its entries at once.
 */
const CACHE_MS = 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map();

function forget(id) {
  for (const [key, entry] of cache) if (entry.id === id) cache.delete(key);
}

const clearLinkCache = () => cache.clear();

/** The settings an install link opens (cached), or null. Throws when the database does. */
async function settingsFor(store, link, now) {
  const key = crypto.createHash("sha256").update(`${link.id}.${link.token}`).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.config;
  const config = await store.resolveLink(link.id, link.token);
  if (config) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { id: link.id, config, expires: now + CACHE_MS });
  }
  return config;
}

const NOTICES = {
  gone: [
    "This install link no longer works",
    "Its profile was deleted, or the link was replaced. Sign in on YouStream's configure page for the current link."
  ],
  unavailable: ["YouStream can't open its profiles right now", "Its database did not answer. Try again in a minute."]
};

/**
 * What the app gets when the link opens nothing: a row saying why, in
 * place of streams; an empty list for a catalog; an error otherwise. With
 * the CORS header the addon protocol needs, which the SDK's router would
 * otherwise add.
 */
function refuse(req, res, rest, kind) {
  const [title, detail] = NOTICES[kind];
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "max-age=60");
  if (rest.startsWith("/stream/")) {
    return res.json({
      streams: [{ name: identity().name, description: `⚠️ ${title}\n${detail}`, externalUrl: `${getBaseUrl(req)}/configure` }]
    });
  }
  if (rest.startsWith("/catalog/")) return res.json({ metas: [] });
  return res.status(kind === "gone" ? 404 : 503).json({ error: `${title}. ${detail}` });
}

/**
 * Express middleware for the paths under an install link, but /configure.
 *
 * @param {function} getStore  the profile store, or null while there is none
 *                             to ask (profiles off, or the database down)
 * @param {function} isOff     true when this server has profiles turned off
 */
function linkMiddleware({ getStore, isOff, now = Date.now }) {
  return async (req, res, next) => {
    const slash = req.url.indexOf("/", 1);
    const link = slash > 0 ? parseLinkSegment(req.url.slice(1, slash)) : null;
    if (!link) return next();
    const rest = req.url.slice(slash);
    if (/^\/configure(?:[/?]|$)/.test(rest)) return next();
    if (isOff()) return refuse(req, res, rest, "gone");
    const store = getStore();
    if (!store) return refuse(req, res, rest, "unavailable");
    let config;
    try {
      config = await settingsFor(store, link, now());
    } catch (err) {
      console.warn(`[profiles] an install link could not be opened: ${err.message}`);
      return refuse(req, res, rest, "unavailable");
    }
    if (!config) return refuse(req, res, rest, "gone");
    req.url = `/${encodeURIComponent(JSON.stringify(config))}${rest}`;
    next();
  };
}

module.exports = {
  parseLinkSegment,
  installUrl,
  linkMiddleware,
  forget,
  clearLinkCache,
  PROFILE_ID_PATTERN,
  CACHE_MS,
  CACHE_MAX
};
