const { dislikeEstimate, API_URL, PAUSE_MS } = require("../src/dislikes");
const { cacheSettings } = require("../src/cache");
const { response, routeFetch, freshCache } = require("./helpers");

beforeEach(() => {
  freshCache();
  jest.restoreAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
});

// What the service answered for an episode of a talent show, a week after it went up.
const votes = (dislikes) => ({ id: "abcdefghijk", likes: 1431473, rawDislikes: 872, rawLikes: 19589, dislikes, rating: 4.93, viewCount: 60556003, deleted: false });

/** Fix the clock at `now` and return a way to move it on. */
function clockAt(now) {
  const spy = jest.spyOn(Date, "now").mockReturnValue(now);
  return (ms) => spy.mockReturnValue(now + ms);
}

test("asks with nothing but the video's id, says who is asking, gives up after a few seconds, and keeps the answer", async () => {
  const fetch = routeFetch([[API_URL, votes(26237)]]);
  expect(await dislikeEstimate("abcdefghijk")).toBe(26237);
  expect(await dislikeEstimate("abcdefghijk")).toBe(26237);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(`${API_URL}?videoId=abcdefghijk`);
  expect(init.headers["User-Agent"]).toMatch(/^YouStream \(\+https:\/\/github\.com\//);
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

test.each([
  ["a video it does not know", 404],
  ["an id it turns down", 400]
])("%s has no estimate, and that answer is kept too", async (_, status) => {
  const fetch = routeFetch([[API_URL, response({ title: "Not Found" }, { status })]]);
  expect(await dislikeEstimate("abcdefghijk")).toBeNull();
  expect(await dislikeEstimate("abcdefghijk")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ["a count that is not a number", { dislikes: "many" }],
  ["a fraction", { dislikes: 2.5 }],
  ["a negative count", { dislikes: -3 }],
  ["no count", {}]
])("%s is no estimate", async (_, body) => {
  routeFetch([[API_URL, body]]);
  expect(await dislikeEstimate("abcdefghijk")).toBeNull();
});

test("a refusal leaves the service alone for a minute, for every video, then it is asked again", async () => {
  const later = clockAt(Date.now());
  let fetch = routeFetch([[API_URL, response({}, { status: 429 })]]);
  expect(await dislikeEstimate("abcdefghijk")).toBeNull();
  expect(await dislikeEstimate("zyxwvutsrqp")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("returned HTTP 429; not asking again for a minute"));
  later(PAUSE_MS - 1);
  expect(await dislikeEstimate("zyxwvutsrqp")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  later(PAUSE_MS + 1);
  fetch = routeFetch([[API_URL, votes(12)]]);
  expect(await dislikeEstimate("zyxwvutsrqp")).toBe(12);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ["cannot be reached", new Error("getaddrinfo ENOTFOUND")],
  ["answers with something that is not JSON", response("<html>", { json: false })],
  ["answers with nothing", response(null)]
])("when the service %s, an estimate kept from before stands, and none is made up", async (_, failure) => {
  const later = clockAt(Date.now());
  routeFetch([[API_URL, votes(500)]]);
  expect(await dislikeEstimate("abcdefghijk")).toBe(500);
  later(cacheSettings().searchMs + 1);
  const fetch = routeFetch([[API_URL, failure]]);
  expect(await dislikeEstimate("abcdefghijk")).toBe(500);
  expect(await dislikeEstimate("abcdefghijk")).toBe(500);
  expect(await dislikeEstimate("zyxwvutsrqp")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
