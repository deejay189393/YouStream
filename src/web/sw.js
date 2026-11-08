/**
 * The configure page's service worker. It keeps no page, as a page can hold
 * the reader's keys: it keeps the icons, and when the network is gone it
 * answers a page request with a short note instead of the browser's error.
 *
 * A module, so that the tests run this very file in a stand-in for a
 * worker's scope and coverage measures it; webApp.js hands it to browsers
 * wrapped to start at once with `self` and these settings.
 *
 * @param {object} self                 the worker's global scope
 * @param {object} settings
 * @param {string} settings.cache       the cache's name: a new version replaces the old
 * @param {string[]} settings.shell     the paths of the icons kept
 * @param {string} settings.offlinePage the note shown with no network
 */
module.exports = function start(self, { cache, shell, offlinePage }) {
  self.addEventListener("install", (event) => {
    event.waitUntil(
      self.caches
        .open(cache)
        .then((store) => store.addAll(shell))
        .then(() => self.skipWaiting())
    );
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      self.caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== cache).map((key) => self.caches.delete(key))))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new self.URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === "navigate") {
      event.respondWith(
        self.fetch(request).catch(() => new self.Response(offlinePage, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
      );
      return;
    }
    if (shell.includes(url.pathname)) event.respondWith(self.caches.match(request).then((hit) => hit || self.fetch(request)));
  });
};
