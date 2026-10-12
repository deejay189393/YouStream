/**
 * Shared test helpers: a fetch double that answers by URL, builders for the
 * shapes the upstream APIs return, and a fresh cache for each test.
 */
const fs = require("fs");
const path = require("path");
const { configureCache } = require("../src/cache");
const { readHostConfig } = require("../src/hostConfig");

/** The host's default cache settings, whatever this machine's environment says. */
const TEST_CACHE = readHostConfig({}).cache;

/** An empty in-memory cache with the default lifetimes, or the ones given. */
function freshCache(overrides = {}) {
  return configureCache({ ...TEST_CACHE, ...overrides });
}

/** A fetch Response as far as the addon reads one. */
function response(body, { status = 200, json = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (!json) throw new SyntaxError("Unexpected token");
      return body;
    }
  };
}

/**
 * Install a global fetch that answers from a list of [matcher, reply]
 * routes, where a matcher is a substring of the URL or a RegExp and a reply
 * is a body, a Response from `response`, an Error to throw, or a function of
 * the URL returning any of those. Unrouted URLs answer 404.
 */
function routeFetch(routes) {
  const fn = jest.fn(async (url, init) => {
    const target = String(url);
    const route = routes.find(([match]) => (match instanceof RegExp ? match.test(target) : target.includes(match)));
    if (!route) return response({ error: "not found" }, { status: 404 });
    let reply = route[1];
    if (typeof reply === "function") reply = reply(target, init);
    if (reply instanceof Error) throw reply;
    if (reply && typeof reply.json === "function" && "status" in reply) return reply;
    return response(reply);
  });
  global.fetch = fn;
  return fn;
}

/** A video as youtube.js stores it, with sensible defaults. */
function video(overrides = {}) {
  return {
    id: "vid00000001",
    title: "Some Film (1994) Full Movie",
    description: "",
    channelTitle: "A Channel",
    channelId: "UC123",
    publishedAt: "2020-01-01T00:00:00Z",
    durationSeconds: 8520,
    definition: "hd",
    views: 10000,
    language: null,
    live: null,
    embeddable: true,
    ageRestricted: false,
    licensed: false,
    regionAllowed: null,
    regionBlocked: null,
    ...overrides
  };
}

/** A videos.list item, the raw API shape. */
function apiVideo(id, overrides = {}) {
  return {
    id,
    snippet: {
      title: `Video ${id}`,
      channelTitle: "Channel",
      channelId: "UCchan",
      publishedAt: "2021-05-01T00:00:00Z",
      liveBroadcastContent: "none",
      ...(overrides.snippet || {})
    },
    contentDetails: { duration: "PT2H22M", definition: "hd", ...(overrides.contentDetails || {}) },
    statistics: { viewCount: "12345", ...(overrides.statistics || {}) },
    status: { embeddable: true, ...(overrides.status || {}) }
  };
}

/**
 * A real-data fixture: YouTube search results and IMDb runtimes, which their
 * owners' terms do not let this repository publish. They are kept in the
 * private youstream-fixtures repository and checked out into
 * test/fixtures/private/ (see the README, "Real-data tests"). Null when they
 * are not there, and the suites that need them are then skipped.
 */
function privateFixture(name) {
  const file = path.join(__dirname, "fixtures", "private", name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

module.exports = { response, routeFetch, video, apiVideo, freshCache, TEST_CACHE, privateFixture };
