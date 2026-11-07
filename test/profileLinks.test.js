const express = require("express");
const request = require("supertest");
const {
  parseLinkSegment,
  installUrl,
  linkMiddleware,
  forget,
  clearLinkCache,
  CACHE_MS,
  CACHE_MAX
} = require("../src/profiles/links");

const ID = "3b84d0e4-1e9d-4508-b9c4-46c8125f335f";
const TOKEN = "nFEm3YBPj-TdEd4E-xFWS-Ffm9Ldl8pkVO0Rfr1oowU";
const SEGMENT = `${ID}.${TOKEN}`;
const CONFIG = { youtubeKey: "AIzaSyTESTKEY", maxResults: 3 };

let store;
let off;
let clock;
let app;
let warn;

beforeEach(() => {
  clearLinkCache();
  clock = { t: 1000 };
  off = false;
  store = { resolveLink: jest.fn(async (id, token) => (id === ID && token === TOKEN ? CONFIG : null)) };
  app = express();
  app.use(linkMiddleware({ getStore: () => store, isOff: () => off, now: () => clock.t }));
  // What the routes after it see.
  app.use((req, res) => res.json({ url: req.url }));
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const opened = (rest) => `/${encodeURIComponent(JSON.stringify(CONFIG))}${rest}`;

describe("an install link's segment", () => {
  test("is a profile ID and a 43-character token, joined by a dot", () => {
    expect(parseLinkSegment(SEGMENT)).toEqual({ id: ID, token: TOKEN });
    expect(parseLinkSegment(`${ID}.${TOKEN}x`)).toBeNull();
    expect(parseLinkSegment(`${ID.toUpperCase()}.${TOKEN}`)).toBeNull();
    expect(parseLinkSegment("%7B%22youtubeKey%22%3A%22K%22%7D")).toBeNull();
    expect(parseLinkSegment(undefined)).toBeNull();
    expect(installUrl("https://h", ID, TOKEN)).toBe(`https://h/${SEGMENT}/manifest.json`);
  });
});

describe("the install link middleware", () => {
  test("swaps the segment for the settings it opens, for every addon path", async () => {
    for (const rest of ["/manifest.json", "/stream/movie/tt0111161.json", "/catalog/youtube/search/search=a%20b.json", "/explain/movie/tt1.json"]) {
      expect((await request(app).get(`/${SEGMENT}${rest}`)).body.url).toBe(opened(rest));
    }
  });

  test("leaves alone: paths without a link, and the link's configure page", async () => {
    expect((await request(app).get("/manifest.json")).body.url).toBe("/manifest.json");
    expect((await request(app).get("/configure")).body.url).toBe("/configure");
    expect((await request(app).get(`/${SEGMENT}`)).body.url).toBe(`/${SEGMENT}`);
    expect((await request(app).get(`/${SEGMENT}/configure`)).body.url).toBe(`/${SEGMENT}/configure`);
    expect((await request(app).get(`/${SEGMENT}/configure?x=1`)).body.url).toBe(`/${SEGMENT}/configure?x=1`);
    expect((await request(app).get("/%7B%7D/manifest.json")).body.url).toBe("/%7B%7D/manifest.json");
    expect(store.resolveLink).not.toHaveBeenCalled();
  });

  test("a link that opens nothing: a row saying why for streams, an empty row, or a 404", async () => {
    const bad = `${ID}.${"B".repeat(43)}`;
    const stream = await request(app).get(`/${bad}/stream/movie/tt0111161.json`);
    expect(stream.status).toBe(200);
    expect(stream.headers["access-control-allow-origin"]).toBe("*");
    expect(stream.headers["cache-control"]).toBe("max-age=60");
    expect(stream.body).toEqual({
      streams: [
        {
          name: "YouStream",
          description:
            "⚠️ This install link no longer works\nIts profile was deleted, or the link was replaced. Sign in on YouStream's configure page for the current link.",
          externalUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/configure$/)
        }
      ]
    });
    expect((await request(app).get(`/${bad}/catalog/youtube/x.json`)).body).toEqual({ metas: [] });
    const manifest = await request(app).get(`/${bad}/manifest.json`);
    expect(manifest.status).toBe(404);
    expect(manifest.body.error).toMatch(/^This install link no longer works\. Its profile was deleted/);
  });

  test("a server with profiles off says the same: the link is not one it can open", async () => {
    off = true;
    expect((await request(app).get(`/${SEGMENT}/manifest.json`)).status).toBe(404);
    expect(store.resolveLink).not.toHaveBeenCalled();
  });

  test("a database not there yet, or failing: try again in a minute", async () => {
    const saved = store;
    store = null;
    const waiting = await request(app).get(`/${SEGMENT}/manifest.json`);
    expect(waiting.status).toBe(503);
    expect(waiting.body.error).toBe("YouStream can't open its profiles right now. Its database did not answer. Try again in a minute.");
    store = saved;
    store.resolveLink.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    const stream = await request(app).get(`/${SEGMENT}/stream/movie/tt1.json`);
    expect(stream.body.streams[0].description).toMatch(/^⚠️ YouStream can't open its profiles right now/);
    expect(warn).toHaveBeenCalledWith("[profiles] an install link could not be opened: SQLITE_BUSY");
  });

  test("an opened link is kept a minute; forgetting the profile drops it at once", async () => {
    await request(app).get(`/${SEGMENT}/manifest.json`);
    await request(app).get(`/${SEGMENT}/stream/movie/tt1.json`);
    expect(store.resolveLink).toHaveBeenCalledTimes(1);
    clock.t += CACHE_MS;
    await request(app).get(`/${SEGMENT}/manifest.json`);
    expect(store.resolveLink).toHaveBeenCalledTimes(2);
    forget("someone-else");
    await request(app).get(`/${SEGMENT}/manifest.json`);
    expect(store.resolveLink).toHaveBeenCalledTimes(2);
    forget(ID);
    await request(app).get(`/${SEGMENT}/manifest.json`);
    expect(store.resolveLink).toHaveBeenCalledTimes(3);
  });

  test("a link that opens nothing is not kept", async () => {
    const bad = `${ID}.${"C".repeat(43)}`;
    await request(app).get(`/${bad}/manifest.json`);
    await request(app).get(`/${bad}/manifest.json`);
    expect(store.resolveLink).toHaveBeenCalledTimes(2);
  });

  test(`at most ${CACHE_MAX} links are kept: the oldest goes first`, async () => {
    store.resolveLink = jest.fn(async () => CONFIG);
    const middleware = linkMiddleware({ getStore: () => store, isOff: () => false, now: () => clock.t });
    const run = (segment) =>
      new Promise((resolve) => middleware({ url: `/${segment}/manifest.json` }, {}, () => resolve()));
    const segmentFor = (i) => `${ID}.${String(i).padStart(43, "A")}`;
    for (let i = 0; i <= CACHE_MAX; i++) await run(segmentFor(i));
    expect(store.resolveLink).toHaveBeenCalledTimes(CACHE_MAX + 1);
    await run(segmentFor(CACHE_MAX));
    expect(store.resolveLink).toHaveBeenCalledTimes(CACHE_MAX + 1);
    await run(segmentFor(0));
    expect(store.resolveLink).toHaveBeenCalledTimes(CACHE_MAX + 2);
  });

  test("uses the clock by default", async () => {
    const plain = express();
    plain.use(linkMiddleware({ getStore: () => store, isOff: () => false }));
    plain.use((req, res) => res.json({ url: req.url }));
    expect((await request(plain).get(`/${SEGMENT}/manifest.json`)).body.url).toBe(opened("/manifest.json"));
  });
});
