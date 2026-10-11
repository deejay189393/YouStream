/**
 * Shared test helpers: a fetch double that answers by URL, and builders for
 * the shapes the upstream APIs return.
 */

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

module.exports = { response, routeFetch, video, apiVideo };
