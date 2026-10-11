const path = require("path");
const express = require("express");
const { decodeConfig, cleanKey, formatMargin } = require("./src/config");
const { buildManifest, getUnconfiguredManifest } = require("./src/manifest");
const { renderConfigurePage } = require("./src/configurePage");
const { createResourceRouter } = require("./src/addonInterface");
const { findVideos } = require("./src/finder");
const { searchDuration } = require("./src/matching");
const { formatDuration, formatOffset } = require("./src/text");
const youtube = require("./src/youtube");
const tmdb = require("./src/metadata/tmdb");

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

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/configure"));

app.get("/configure", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: null, serverTmdb: serverHasTmdbKey() }));
});

app.get("/health", (req, res) => res.json({ ok: true }));

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
  res.send(renderConfigurePage({ baseUrl: getBaseUrl(req), existing: decoded, serverTmdb: serverHasTmdbKey() }));
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
    out.matches = result.matches.map(describeVideo);
    out.rejected = result.evaluations.filter((e) => !e.ok).map(describeVideo);
  }
  res.json(out);
});

// --- Streams, handled by the real stremio-addon-sdk router.
app.use(createResourceRouter());

module.exports = { app, getBaseUrl };

/* istanbul ignore next -- exercised for real by test/startup.test.js, which
   boots this file as a child process; coverage instrumentation does not span
   process boundaries. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`YouStream addon listening on port ${PORT}`);
  });
}
