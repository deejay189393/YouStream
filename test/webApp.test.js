const vm = require("vm");
const { webAppManifest, serviceWorkerSource, SHELL, BACKGROUND } = require("../src/webApp");
const { ADDON_VERSION } = require("../src/manifest");

describe("the web app manifest", () => {
  afterEach(() => delete process.env.RELEASE_CHANNEL);

  test("installs the configure page as an app of its own", () => {
    expect(webAppManifest()).toEqual({
      id: "/configure",
      name: "YouStream",
      short_name: "YouStream",
      description: expect.stringMatching(/^Movies and episodes that are on YouTube/),
      start_url: "/configure",
      scope: "/",
      display: "standalone",
      background_color: BACKGROUND,
      theme_color: BACKGROUND,
      icons: expect.any(Array)
    });
  });

  test("the beta installs under its own name, beside the stable one", () => {
    process.env.RELEASE_CHANNEL = "beta";
    expect(webAppManifest()).toMatchObject({ name: "YouStream Beta", short_name: "YouStream Beta" });
  });
});

/**
 * The service worker, run in a stand-in for a browser's worker scope: its
 * events are fired by hand and what it does with them is recorded.
 */
function loadWorker({ network = async () => ({ ok: true, from: "network" }), cached = {} } = {}) {
  const listeners = {};
  const store = { added: null, deleted: [] };
  const self = {
    location: { origin: "https://youstream.example" },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: jest.fn(async () => {}),
    clients: { claim: jest.fn(async () => {}) }
  };
  const caches = {
    open: jest.fn(async (name) => ({ addAll: async (urls) => (store.added = { name, urls }) })),
    keys: async () => ["youstream-0.0.1", `youstream-${ADDON_VERSION}`, "something-else"],
    delete: async (name) => store.deleted.push(name),
    match: async (request) => cached[new URL(request.url).pathname]
  };
  class Response {
    constructor(body, init) {
      this.body = body;
      this.headers = init.headers;
    }
  }
  const context = vm.createContext({ self, caches, fetch: jest.fn(network), Response, URL, Promise });
  vm.runInContext(serviceWorkerSource(), context);

  /** Fires an event; resolves to what the worker answered with, if it did. */
  async function fire(type, init = {}) {
    let waited = null;
    let answered;
    const event = {
      ...init,
      waitUntil: (p) => (waited = p),
      respondWith: (p) => (answered = p)
    };
    listeners[type](event);
    await waited;
    return answered === undefined ? undefined : await answered;
  }
  return { fire, store, self, context };
}

const get = (path, mode = "cors") => ({ request: { method: "GET", url: `https://youstream.example${path}`, mode } });

describe("the service worker", () => {
  test("on install keeps the icons, under this version's name, and takes over at once", async () => {
    const w = loadWorker();
    await w.fire("install");
    expect(w.store.added).toEqual({ name: `youstream-${ADDON_VERSION}`, urls: SHELL });
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  test("on activate drops every other version's cache", async () => {
    const w = loadWorker();
    await w.fire("activate");
    expect(w.store.deleted).toEqual(["youstream-0.0.1", "something-else"]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  test("pages come from the network, and never from a cache: one can hold the reader's keys", async () => {
    const w = loadWorker();
    expect(await w.fire("fetch", get("/configure", "navigate"))).toEqual({ ok: true, from: "network" });
  });

  test("offline, a page request gets a short note instead of the browser's error", async () => {
    const w = loadWorker({ network: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const answer = await w.fire("fetch", get("/configure", "navigate"));
    expect(answer.headers).toEqual({ "Content-Type": "text/html; charset=utf-8" });
    expect(answer.body).toContain("You're offline");
  });

  test("the icons from the cache, or the network when not there yet", async () => {
    const w = loadWorker({ cached: { "/icon-192.png": { from: "cache" } } });
    expect(await w.fire("fetch", get("/icon-192.png"))).toEqual({ from: "cache" });
    expect(await w.fire("fetch", get("/icon-512.png"))).toEqual({ ok: true, from: "network" });
  });

  test("everything else is left to the browser: the API, the addon, other sites, and anything but GET", async () => {
    const w = loadWorker();
    expect(await w.fire("fetch", get("/api/profile"))).toBeUndefined();
    expect(await w.fire("fetch", get("/manifest.json"))).toBeUndefined();
    expect(await w.fire("fetch", { request: { method: "GET", url: "https://www.youtube.com/watch?v=x", mode: "navigate" } })).toBeUndefined();
    expect(await w.fire("fetch", { request: { method: "POST", url: "https://youstream.example/configure", mode: "navigate" } })).toBeUndefined();
  });
});
