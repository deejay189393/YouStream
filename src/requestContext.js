const { AsyncLocalStorage } = require("async_hooks");

/**
 * Whether the app is still waiting for the answer being worked on.
 *
 * Nuvio searches as the reader types, a moment after each keystroke, and
 * drops the request for the keystroke before. A YouTube search costs a
 * hundredth of a key's day, so one the app has already given up on should
 * not be made. The SDK's handlers never see the request, so the request's
 * fate travels to them in an AsyncLocalStorage that every await keeps.
 */
const storage = new AsyncLocalStorage();

/**
 * Express middleware: the request's own abort signal, aborted when the
 * connection closes before the answer has been sent.
 */
function trackRequest(req, res, next) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  storage.run({ signal: controller.signal }, next);
}

/** The current request's signal, or null outside a request. */
function requestSignal() {
  const store = storage.getStore();
  return store ? store.signal : null;
}

module.exports = { trackRequest, requestSignal, storage };
