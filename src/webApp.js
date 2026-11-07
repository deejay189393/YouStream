const { DESCRIPTION, ADDON_VERSION, identity } = require("./manifest");

/**
 * The configure page as an app a phone can install: its web app manifest
 * and its service worker. Installed, it opens at /configure in a window of
 * its own, signed in for as long as the sign-in lasts (profiles/session.js),
 * since an installed app shares the browser's cookies.
 *
 * The service worker keeps no page: a page can hold the reader's keys. It
 * keeps the icons, and when the network is gone it answers a page request
 * with a short note instead of the browser's error.
 */

const BACKGROUND = "#0f1013";

function webAppManifest() {
  const { name } = identity();
  return {
    id: "/configure",
    name,
    short_name: name,
    description: DESCRIPTION,
    start_url: "/configure",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

/** Kept by the service worker; a new version replaces them all. */
const SHELL = ["/logo.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-192.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];

const OFFLINE_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Offline</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${BACKGROUND};color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}img{width:72px;height:72px;border-radius:16px}p{color:#9ea3ae;font-size:14px;line-height:1.5}button{background:#7a1a2b;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px}</style>
</head><body><div><img src="/logo.png" alt="" /><h1>You're offline</h1><p>YouStream needs the internet to load your settings.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

function serviceWorkerSource() {
  return `// ${identity().name} ${ADDON_VERSION}
const CACHE = ${JSON.stringify(`youstream-${ADDON_VERSION}`)};
const SHELL = ${JSON.stringify(SHELL)};
const OFFLINE_PAGE = ${JSON.stringify(OFFLINE_PAGE)};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    );
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
  }
});
`;
}

module.exports = { webAppManifest, serviceWorkerSource, BACKGROUND, SHELL };
