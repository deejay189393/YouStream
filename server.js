const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { decodeConfig, cleanKey, formatMargin } = require("./src/config");
const { buildManifest, getUnconfiguredManifest } = require("./src/manifest");
const { renderConfigurePage } = require("./src/configurePage");
const { renderTermsPage } = require("./src/termsPage");
const { createResourceRouter } = require("./src/addonInterface");
const { findVideos } = require("./src/finder");
const { searchDuration } = require("./src/matching");
const { formatDuration, formatOffset } = require("./src/text");
const youtube = require("./src/youtube");
const tmdb = require("./src/metadata/tmdb");
const { hostConfig, describeCache } = require("./src/hostConfig");
const { NAMESPACES, cacheSettings, cacheStats, clearAllCaches } = require("./src/cache");
const imdb = require("./src/metadata/imdb");
const { resolveSource } = require("./src/browse");
const { trackRequest } = require("./src/requestContext");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Behind Railway's proxy, TLS ends upstream and req.protocol reads "http".
 * The forwarded header says what the client actually used, so the manifest
 * advertises https:// URLs, which Stremio requires of a remote addon.
 */
function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  return `${proto}://${req.get("host")}`;
}

function invalidConfig(res) {
  return res.status(400).json({ error: "Invalid or corrupted addon configuration." });
}

const serverHasTmdbKey = () => Boolean(cleanKey(process.env.TMDB_API_KEY));

/**
 * The data sources this server uses whose terms ask to be credited where
 * their data is used: IMDb's statement, TMDB's notice with its logo (a
 * reader may add a TMDB key even when the server has none), TheTVDB's link,
 * and TVmaze's, whose data is CC BY-SA.
 */
function credits(metadata = hostConfig.metadata) {
  const out = [];
  if (metadata.imdbDatasets) out.push({ text: imdb.ATTRIBUTION, href: "https://www.imdb.com" });
  if (metadata.tvdbKey) out.push({ text: "Episode data from TheTVDB.com", href: "https://thetvdb.com" });
  out.push({
    text: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
    href: "https://www.themoviedb.org",
    image: "/tmdb.svg",
    imageAlt: "TMDB"
  });
  out.push({ text: "Episode runtimes from TVmaze.com (CC BY-SA 4.0)", href: "https://www.tvmaze.com" });
  return out;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/configure"));

app.get("/configure", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: null, serverTmdb: serverHasTmdbKey(), credits: credits() }));
});

app.get("/terms", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderTermsPage({ contact: hostConfig.legal.contact, credits: credits() }));
});

app.get("/health", (req, res) =>
  res.json({ ok: true, cache: cacheSettings().store, imdb: hostConfig.metadata.imdbDatasets ? imdb.status() : "off" })
);

/**
 * The cache, for whoever runs the server: GET for what it holds, DELETE to
 * empty one namespace (search, metadata, cooldown) or all of them. Only
 * there when CACHE_ADMIN_TOKEN is set, and only with that token as a bearer
 * token.
 */
function sameSecret(given, expected) {
  const digest = (text) => crypto.createHash("sha256").update(text).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function requireAdmin(req, res, next) {
  const token = cacheSettings().adminToken;
  if (!token) return res.status(404).json({ error: "Not found" });
  const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!match || !sameSecret(match[1], token)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

/** Express 4 does not catch a rejected handler; a store that is down must not take the server with it. */
const storeAnswer = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    res.status(503).json({ error: `The cache store did not answer: ${err.message}` });
  }
};

app.get(
  "/admin/cache",
  requireAdmin,
  storeAnswer(async (req, res) => res.json(await cacheStats()))
);

app.delete(
  "/admin/cache/:namespace",
  requireAdmin,
  storeAnswer(async (req, res) => {
    const { namespace } = req.params;
    if (namespace === "all") return res.json({ removed: await clearAllCaches() });
    if (!Object.hasOwn(NAMESPACES, namespace)) {
      return res.status(400).json({ error: `Unknown namespace; one of ${[...Object.keys(NAMESPACES), "all"].join(", ")}` });
    }
    res.json({ removed: await NAMESPACES[namespace].clear() });
  })
);

/**
 * Checks the keys a reader typed before their install link is built, so a
 * mistyped key, an API left disabled, or a key locked to websites is caught
 * on the configure page rather than discovered as an empty stream list.
 *
 * POST, so the keys travel in the body and stay out of request logs. Costs
 * the reader one unit of their own YouTube quota.
 */
app.post("/api/check-keys", express.json({ limit: "4kb" }), async (req, res) => {
  // express.json always leaves an object here: {} when the body was not
  // JSON, and strict mode refuses any JSON that is not an object or array.
  const youtubeKey = cleanKey(req.body.youtubeKey);
  const tmdbKey = cleanKey(req.body.tmdbKey);
  const [youtubeStatus, tmdbStatus] = await Promise.all([
    youtubeKey ? youtube.checkKey(youtubeKey) : "missing",
    tmdbKey ? tmdb.checkKey(tmdbKey) : "absent"
  ]);
  res.json({ youtube: youtubeStatus, tmdb: tmdbStatus });
});

/**
 * Looks up a channel or playlist the reader pasted on the configure page --
 * a link, an @handle or an id -- so it can become a catalog: { entry },
 * { error }, or { search: true } for text that is a search instead. POST for
 * the same reason as above; costs the reader 1 unit.
 */
app.post("/api/youtube-source", express.json({ limit: "4kb" }), async (req, res) => {
  const youtubeKey = cleanKey(req.body.youtubeKey);
  if (!youtubeKey) return res.json({ error: "Enter your YouTube API key above first: it is used to look the link up." });
  res.json(await resolveSource(youtubeKey, typeof req.body.input === "string" ? req.body.input.slice(0, 500) : ""));
});

// --- Manifest routes are served here rather than by the SDK router, because
// the manifest varies per reader (their content types, and whether tmdb: ids
// can be read), which the SDK's single static manifest cannot express.
app.get("/manifest.json", (req, res) => {
  res.json(getUnconfiguredManifest(getBaseUrl(req)));
});

app.get("/:config/manifest.json", (req, res) => {
  const decoded = decodeConfig(req.params.config);
  if (!decoded) return invalidConfig(res);
  res.json(buildManifest(decoded, getBaseUrl(req)));
});

// Re-configuration: the app's "Configure" button on an installed addon lands
// here, with the reader's current settings in the path.
app.get("/:config/configure", (req, res) => {
  const decoded = decodeConfig(req.params.config);
  if (!decoded) return invalidConfig(res);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: decoded, serverTmdb: serverHasTmdbKey(), credits: credits() }));
});

/** A video as the explain endpoint shows it. */
function describeVideo(evaluation) {
  const { video } = evaluation;
  const out = {
    id: video.id,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    title: video.title,
    channel: video.channelTitle,
    duration: video.durationSeconds ? formatDuration(video.durationSeconds) : null,
    durationSeconds: video.durationSeconds,
    views: video.views,
    language: video.language
  };
  if (evaluation.ok) {
    out.offset = evaluation.offsetSeconds === null ? null : formatOffset(evaluation.offsetSeconds);
    out.score = evaluation.score;
    out.matchedBy = evaluation.how;
  } else {
    out.reason = evaluation.reason;
  }
  return out;
}

function describeWindow(window) {
  return {
    basis: window.basis,
    runtime: window.target ? formatDuration(window.target) : null,
    margin: window.margin ? formatMargin(window.margin) : null,
    from: formatDuration(window.min),
    to: formatDuration(window.max),
    // When sources disagree, the lengths close to each one, not all between.
    ...(window.spans.length > 1 ? { spans: window.spans.map(([from, to]) => `${formatDuration(from)} to ${formatDuration(to)}`) } : {}),
    youtubeLengthFilter: searchDuration(window) || "any"
  };
}

/**
 * Shows the working behind one stream lookup: what the id was read as, what
 * was searched, every video YouTube returned, and why each one was kept or
 * turned away. For tuning margins, templates and excluded words on evidence.
 * Uses the reader's own key, and a lookup already cached costs nothing.
 */
app.get("/:config/explain/:type/:id.json", async (req, res) => {
  const decoded = decodeConfig(req.params.config);
  if (!decoded || !decoded.youtubeKey) return invalidConfig(res);
  const result = await findVideos(req.params.id, decoded);
  const out = { id: req.params.id, status: result.status };
  if (result.title) out.title = result.title;
  if (result.window) out.length = describeWindow(result.window);
  if (result.query) out.query = result.query;
  if (result.error) out.error = result.error;
  if (result.evaluations) {
    out.cached = result.cached;
    if (result.stale) out.stale = result.stale;
    out.matches = result.matches.map(describeVideo);
    out.rejected = result.evaluations.filter((e) => !e.ok).map(describeVideo);
  }
  res.json(out);
});

// --- Catalogs, metadata and streams, handled by the real stremio-addon-sdk
// router. Each request carries whether the app is still waiting for it
// (requestContext.js), so a search the app has abandoned is not made.
app.use(trackRequest, createResourceRouter());

// What the router passed on -- an item YouTube no longer has -- and any
// other unknown path.
app.use((req, res) => res.status(404).json({ error: "Not found" }));

module.exports = { app, getBaseUrl, credits };

/* istanbul ignore next -- exercised for real by test/startup.test.js, which
   boots this file as a child process; coverage instrumentation does not span
   process boundaries. */
if (require.main === module) {
  hostConfig.warnings.forEach((w) => console.warn(`[config] ${w}`));
  console.log(`[cache] ${describeCache(cacheSettings())}`);
  if (hostConfig.metadata.imdbDatasets) imdb.start();
  app.listen(PORT, () => {
    console.log(`YouStream addon listening on port ${PORT}`);
  });
}
