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
const { hostConfig, describeCache, DAY_MS } = require("./src/hostConfig");
const { NAMESPACES, cacheSettings, cacheStats, clearAllCaches } = require("./src/cache");
const imdb = require("./src/metadata/imdb");
const { resolveSource } = require("./src/browse");
const { SOURCE_KINDS } = require("./src/catalogs");
const { trackRequest } = require("./src/requestContext");
const { getBaseUrl } = require("./src/baseUrl");
const profiles = require("./src/profiles");
const { webAppManifest, serviceWorkerSource } = require("./src/webApp");

const app = express();
const PORT = process.env.PORT || 3000;

// Who the client is, for the limits on sign-in attempts: the address the
// proxy in front (Railway's) saw, from X-Forwarded-For.
app.set("trust proxy", hostConfig.trustProxy);

function invalidConfig(res) {
  return res.status(400).json({ error: "Invalid or corrupted addon configuration." });
}

const serverHasTmdbKey = () => Boolean(cleanKey(process.env.TMDB_API_KEY));

/**
 * The data sources this server uses whose terms ask to be credited where
 * their data is used: IMDb's statement, TMDB's notice with its logo (a
 * reader may add a TMDB key even when the server has none), TheTVDB's link,
 * TVmaze's, whose data is CC BY-SA, and Return YouTube Dislike's.
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
  out.push({ text: "Dislike estimates from Return YouTube Dislike", href: "https://returnyoutubedislike.com" });
  return out;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/configure"));

/** Express 4 does not catch a rejected handler. */
const answer = (handler) => (req, res, next) => handler(req, res).catch(next);

const days = (ms) => Math.max(1, Math.round(ms / DAY_MS));

/** How long a remembered sign-in lasts, in days, as the pages say it. */
const sessionDays = () => ({
  remembered: days(hostConfig.profiles.sessions.rememberedMs),
  max: days(hostConfig.profiles.sessions.maxMs)
});

/** What the terms page says about profiles on this server. */
const profileTerms = () => ({
  enabled: hostConfig.profiles.enabled,
  pruneAfterDays: hostConfig.profiles.pruneAfterMs ? days(hostConfig.profiles.pruneAfterMs) : 0,
  sessionDays: sessionDays()
});

/** One-off notes a page shows after a redirect: ?done=created and so on. */
const DONE = {
  created: "created",
  deleted: "deleted"
};

/**
 * The configure page, for whoever asks: signed in to a profile or not, from
 * an install link or not (profiles/index.js, pageState).
 *
 *   existing     settings to pre-fill the form with -- a link's own, or an
 *                imported file's -- in place of the signed-in profile's
 *   source       where `existing` came from: "link" or "import"
 *   linkSegment  the page was opened from a profile's install link: it is
 *                that profile's page only for its signed-in owner, and asks
 *                anyone else to sign in
 */
async function sendConfigurePage(req, res, { existing = null, source = null, linkSegment = null, fileName = "" } = {}) {
  const state = await profiles.pageState(req, res, linkSegment);
  const { signedIn, link } = state;
  const owner = signedIn && (!link || link.id === signedIn.id) ? signedIn : null;
  const profile = {
    enabled: state.enabled,
    unavailable: state.unavailable,
    signedIn: owner && { id: owner.id, installUrl: owner.installUrl, remembered: owner.remembered },
    signInId: link && !owner ? link.id : null,
    otherProfile: link && signedIn && !owner ? signedIn.id : null,
    linkWorks: link ? link.works : true,
    source: existing ? source : null,
    fileName,
    done: DONE[req.query.done] || null,
    sessionDays: sessionDays()
  };
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    // The page can hold the reader's keys: kept by no cache, shown in no frame.
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY"
  });
  res.send(
    renderConfigurePage({
      baseUrl: getBaseUrl(req),
      existing: existing || (owner ? owner.config : null),
      serverTmdb: serverHasTmdbKey(),
      credits: credits(),
      profile
    })
  );
}

app.get("/configure", answer((req, res) => sendConfigurePage(req, res)));

/**
 * Settings from a file the reader imported, merged on the page with the
 * keys they already had, pre-filled for them to look over and save. Nothing
 * is saved here. A form post, so the file's keys never ride in a URL.
 */
app.post(
  "/configure",
  express.urlencoded({ extended: false, limit: "128kb" }),
  answer(async (req, res) => {
    let imported = null;
    try {
      imported = JSON.parse(req.body.config);
    } catch (_) {
      imported = null;
    }
    if (!imported || typeof imported !== "object" || Array.isArray(imported)) return res.redirect(303, "/configure");
    const fileName = typeof req.body.file === "string" ? req.body.file.slice(0, 120) : "";
    return sendConfigurePage(req, res, { existing: imported, source: "import", fileName });
  })
);

/** The configure page as an installable app (webApp.js). */
app.get("/app.webmanifest", (req, res) => {
  res.set("Content-Type", "application/manifest+json; charset=utf-8");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(JSON.stringify(webAppManifest()));
});

app.get("/sw.js", (req, res) => {
  res.set("Content-Type", "text/javascript; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(serviceWorkerSource());
});

/** Profiles: creating, signing in, saving (profiles/api.js). */
app.use("/api/profile", profiles.apiRouter);

app.get("/terms", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderTermsPage({ contact: hostConfig.legal.contact, credits: credits(), profiles: profileTerms() }));
});

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    cache: cacheSettings().store,
    imdb: hostConfig.metadata.imdbDatasets ? imdb.status() : "off",
    profiles: profiles.status()
  })
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
 * Looks up a playlist or a channel the reader pasted on the configure page
 * -- a link, an @handle or an id -- so it can become a catalog: { entry } or
 * { error }. `kind` is the source they chose, "playlist" or "channel". POST
 * for the same reason as above; costs the reader 1 unit.
 */
app.post("/api/youtube-source", express.json({ limit: "4kb" }), async (req, res) => {
  const youtubeKey = cleanKey(req.body.youtubeKey);
  if (!SOURCE_KINDS.includes(req.body.kind)) return res.json({ error: "Choose YouTube playlist or YouTube channel to look a link up." });
  if (!youtubeKey) return res.json({ error: "Enter your YouTube API key above first: it is used to look the link up." });
  res.json(await resolveSource(youtubeKey, typeof req.body.input === "string" ? req.body.input.slice(0, 500) : "", req.body.kind));
});

// A profile's install link opens its settings here, for every path below
// but /configure (profiles/links.js).
app.use(profiles.links);

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
// here. A profile's link asks for the password, unless its owner is signed
// in; a link that carries its settings pre-fills them.
app.get(
  "/:config/configure",
  answer(async (req, res) => {
    if (profiles.parseLinkSegment(req.params.config)) return sendConfigurePage(req, res, { linkSegment: req.params.config });
    const decoded = decodeConfig(req.params.config);
    if (!decoded) return invalidConfig(res);
    return sendConfigurePage(req, res, { existing: decoded, source: "link" });
  })
);

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
  profiles.start(hostConfig.profiles);
  const server = app.listen(PORT, () => {
    console.log(`YouStream addon listening on port ${PORT}`);
  });
  // A redeploy stops the old container: finish what is in flight, close the
  // database cleanly (SQLite folds its write-ahead log back in), then exit.
  process.once("SIGTERM", () => {
    server.close();
    profiles.stop().finally(() => process.exit(0));
  });
}
