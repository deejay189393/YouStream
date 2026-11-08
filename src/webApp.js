const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DESCRIPTION, ADDON_VERSION, identity } = require("./manifest");

/**
 * The configure page as an app a phone can install: its web app manifest
 * and its service worker. Installed, it opens at /configure in a window of
 * its own, signed in for as long as the sign-in lasts (profiles/session.js),
 * since an installed app shares the browser's cookies.
 *
 * The service worker (web/sw.js) keeps no page: a page can hold the
 * reader's keys. It keeps the icons, and when the network is gone it
 * answers a page request with a short note instead of the browser's error.
 * The page's own script (web/configure.js) is served from here too.
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

/**
 * A module of src/ as a browser script: the file as written, run in a
 * function that gives it a `module` of its own, then `call` with what it
 * exported. The browser runs exactly the file the tests run and measure.
 */
const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const asScript = (source, call) => `(function (module) {\n${source}\n${call}\n})({ exports: {} });\n`;

const SERVICE_WORKER = read("web/sw.js");

function serviceWorkerSource() {
  const settings = { cache: `youstream-${ADDON_VERSION}`, shell: SHELL, offlinePage: OFFLINE_PAGE };
  return `// ${identity().name} ${ADDON_VERSION}\n${asScript(SERVICE_WORKER, `module.exports(self, ${JSON.stringify(settings)});`)}`;
}

/**
 * The configure page's script: the stream formatter and the template check
 * the server uses too, then the page itself (web/configure.js), started
 * with the window. Its version is a digest of it, so the page can let
 * browsers keep it for a year and still never run an old one.
 */
const CONFIGURE_SCRIPT = [
  asScript(read("formatter.js"), "window.createFormatter = module.exports.createFormatter;"),
  asScript(read("templateCheck.js"), "window.templateWarnings = module.exports.templateWarnings;"),
  asScript(read("web/configure.js"), "module.exports(window);")
].join("");
const CONFIGURE_VERSION = crypto.createHash("sha256").update(CONFIGURE_SCRIPT).digest("hex").slice(0, 16);

const configureScript = () => ({ body: CONFIGURE_SCRIPT, version: CONFIGURE_VERSION });

module.exports = { webAppManifest, serviceWorkerSource, configureScript, asScript, BACKGROUND, SHELL, OFFLINE_PAGE };
