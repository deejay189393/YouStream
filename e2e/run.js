#!/usr/bin/env node
/**
 * YouStream end to end: a running server, against the real YouTube, Kitsu,
 * AniList, Cinemeta and the rest, its pages in a real browser on a phone
 * and on a desktop.
 *
 *   YOUTUBE_KEY=AIza... node e2e/run.js [base URL]     default http://127.0.0.1:3000
 *   YOUTUBE_KEY_FILE=path/to/key node e2e/run.js https://youstream-beta.up.railway.app
 *   E2E_ONLY=server,addon node e2e/run.js               some groups: server, addon,
 *                                                       profiles, browser
 *
 * It spends about 620 of the key's 10,000 daily units, nearly all of them
 * six searches: a search row, the app's search, a film, an episode and an
 * anime episode. A second run within a day costs less, as the server keeps
 * what it found. Profiles are tested when the server has them on: a profile
 * is created, used and deleted. Whatever fails, or if the run is stopped
 * with Ctrl-C, every profile it made is deleted before it ends. The browser
 * checks need Playwright (npm i -g playwright && npx playwright install
 * chromium) and are skipped without it. The key is never printed.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = (process.argv[2] || process.env.E2E_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const KEY = (process.env.YOUTUBE_KEY || (process.env.YOUTUBE_KEY_FILE ? fs.readFileSync(process.env.YOUTUBE_KEY_FILE, "utf8") : "")).trim();
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(",").map((g) => g.trim()) : null;

// Titles known to be on YouTube in full, officially or in the public domain.
const FILM = "tt0063350";
const EPISODE = "tt9432978:1:3";
const ANIME = { kitsu: "kitsu:45398:3", mal: "mal:50265:3", anilist: "anilist:140960:3" };
const CHANNEL = "UCBJycsmduvYEL83R_U4JriQ";
const PLAYLIST = "PLBCF2DAC6FFB574DE";
const PASSWORD = `e2e ${Math.random().toString(36).slice(2)} password`;
const NEW_PASSWORD = `${PASSWORD} changed`;

const results = [];
const redact = (text) => String(text).replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza…").replace(/[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/g, "<link>");
const wanted = (group) => !ONLY || ONLY.includes(group);
let stopping = false;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(group, name, fn) {
  if (stopping) return undefined;
  try {
    const note = await fn();
    results.push({ group, name, ok: true });
    console.log(`  ✓ ${name}${note ? `: ${redact(note)}` : ""}`);
    return true;
  } catch (err) {
    results.push({ group, name, ok: false, error: redact(err.message) });
    console.log(`  ✗ ${name}: ${redact(err.message)}`);
    return false;
  }
}

const segment = (config) => encodeURIComponent(JSON.stringify({ youtubeKey: KEY, ...config }));
const url = (p) => (p.startsWith("http") ? p : BASE + p);

async function getJson(p, init) {
  const res = await fetch(url(p), init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    /* not JSON */
  }
  return { res, body, text };
}

/** A lowercase length, "45 sec", "3 min" or "1h 2m", in seconds. */
function seconds(runtime) {
  if (typeof runtime !== "string") return null;
  const h = /(\d+)h/.exec(runtime);
  const m = /(\d+)\s*m/.exec(runtime);
  const s = /(\d+)\s*sec/.exec(runtime);
  return (h ? h[1] * 3600 : 0) + (m ? m[1] * 60 : 0) + (s ? Number(s[1]) : 0);
}

// --- Test profiles, never left behind -------------------------------------

/** Every profile the run has made and not yet deleted, by ID, with the password it has now. */
const madeProfiles = new Map();

/** Deleted by ID and password, no sign-in needed; "gone" when none of the run's passwords opens it. */
async function deleteProfile(id, passwords) {
  for (const password of passwords) {
    const status = await fetch(url("/api/profile"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password })
    }).then((res) => res.status, () => "no answer");
    if (status === 204) return "deleted";
    if (status !== 401) return typeof status === "number" ? `HTTP ${status}` : status;
  }
  return "gone";
}

/** Deletes what a failed check or a stop left behind; true when nothing is left. */
async function deleteLeftovers() {
  for (const [id, current] of [...madeProfiles]) {
    const outcome = await deleteProfile(id, [...new Set([current, PASSWORD, NEW_PASSWORD])]);
    if (outcome === "deleted") console.log(`  - deleted test profile ${id.slice(0, 8)}, left by a check that did not finish`);
    if (outcome === "deleted" || outcome === "gone") madeProfiles.delete(id);
    else console.log(`  ✗ test profile ${id} could not be deleted: ${outcome}`);
  }
  return madeProfiles.size === 0;
}

let cleaning = null;
const cleanUp = () => (cleaning = cleaning || deleteLeftovers());

// Stopped part way, the run deletes its profiles first; stopped again, at once.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    const code = 128 + os.constants.signals[signal];
    if (stopping) process.exit(code);
    stopping = true;
    console.log("\nStopped.");
    cleanUp().finally(() => process.exit(code));
  });
}

// --- The server's own pages ----------------------------------------------

async function serverChecks(state) {
  if (!wanted("server")) return;
  console.log("\nserver");
  await check("server", "/health says what is on", async () => {
    const { res, body } = await getJson("/health");
    expect(res.status === 200 && body && body.ok === true, `HTTP ${res.status}`);
    for (const k of ["cache", "imdb", "anime", "profiles"]) expect(k in body, `no "${k}" in it`);
    state.health = body;
    const anime = body.anime === "off" ? "anime off" : body.anime.loaded ? `${body.anime.anime} anime` : "anime loading";
    return `cache ${body.cache}, profiles ${typeof body.profiles === "string" ? body.profiles : JSON.stringify(body.profiles)}, ${anime}`;
  });
  await check("server", "/ leads to the configure page", async () => {
    const res = await fetch(url("/"), { redirect: "manual" });
    expect(res.status >= 300 && res.status < 400 && /\/configure$/.test(res.headers.get("location")), `HTTP ${res.status}`);
  });
  await check("server", "the configure page, its own script only, cached for good by version", async () => {
    const res = await fetch(url("/configure"));
    const html = await res.text();
    expect(res.status === 200, `HTTP ${res.status}`);
    expect(/script-src 'self'/.test(res.headers.get("content-security-policy") || ""), "no script policy");
    const script = /src="(\/configure\.js\?v=[0-9a-f]{16})"/.exec(html);
    expect(script, "no versioned script");
    const js = await fetch(url(script[1]));
    expect(js.status === 200 && /javascript/.test(js.headers.get("content-type")), `script HTTP ${js.status}`);
    expect(/immutable/.test(js.headers.get("cache-control") || ""), "script not cached for good");
  });
  await check("server", "installable: the web app manifest and the service worker", async () => {
    const manifest = await getJson("/app.webmanifest");
    expect(manifest.res.status === 200 && manifest.body && manifest.body.name, `manifest HTTP ${manifest.res.status}`);
    const sw = await fetch(url("/sw.js"));
    expect(sw.status === 200 && /javascript/.test(sw.headers.get("content-type")), `sw HTTP ${sw.status}`);
  });
  await check("server", "the terms credit the sources in use", async () => {
    const res = await fetch(url("/terms"));
    const html = await res.text();
    expect(res.status === 200, `HTTP ${res.status}`);
    const h = state.health || {};
    if (h.imdb && h.imdb !== "off") expect(html.includes("Information courtesy of IMDb"), "no IMDb credit");
    if (h.anime && h.anime !== "off") expect(html.includes("anime offline database"), "no anime database credit");
    for (const credit of ["TMDB", "TVmaze", "Return YouTube Dislike", "Privacy policy"]) expect(html.includes(credit), `no "${credit}"`);
  });
  await check("server", "an addon with no settings asks to be configured and claims no id", async () => {
    const { body } = await getJson("/manifest.json");
    expect(body.behaviorHints.configurationRequired === true, "not configurationRequired");
    expect(JSON.stringify(body.idPrefixes) === '["youstream-not-configured:"]', `claims ${body.idPrefixes}`);
  });
  await check("server", "AIOStreams' browser may read a manifest: CORS on the preflight and the answer", async () => {
    const pre = await fetch(url(`/${segment({})}/manifest.json`), {
      method: "OPTIONS",
      headers: { Origin: "https://aiostreams.example", "Access-Control-Request-Method": "GET" }
    });
    expect(pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*", `preflight HTTP ${pre.status}`);
    const res = await fetch(url(`/${segment({})}/manifest.json`), { headers: { Origin: "https://aiostreams.example" } });
    expect(res.headers.get("access-control-allow-origin") === "*", "no CORS header");
  });
  await check("server", "a key is checked live, and a made-up one is turned away", async () => {
    const ok = await getJson("/api/check-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ youtubeKey: KEY }) });
    expect(ok.body && ok.body.youtube === "ok", `the key: ${ok.body && ok.body.youtube}`);
    const bad = await getJson("/api/check-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtubeKey: "AIzaSyD-not-a-real-key-at-all-0000000000" })
    });
    expect(bad.body && bad.body.youtube === "invalid", `a made-up key: ${bad.body && bad.body.youtube}`);
  });
}

// --- The addon protocol, with settings in the link -----------------------

async function addonChecks(state) {
  if (!wanted("addon")) return;
  console.log("\naddon");
  const rows = [
    { trending: "all" },
    { trending: "all", types: ["videos"] },
    { channel: CHANNEL, name: "Channel" },
    { channel: CHANNEL, name: "Channel", types: ["shorts"] },
    { playlist: PLAYLIST, name: "Playlist" },
    { q: "cricket highlights", sort: "date" },
    { q: "cricket highlights", sort: "date", types: ["videos", "live"] },
    { trending: "all", length: "under4+4to20", label: "Short and medium" },
    { channel: CHANNEL, name: "Channel", length: "20to60" }
  ];
  const config = { catalogs: rows, region: "IN" };
  const seg = segment(config);
  let manifest;
  await check("addon", "the manifest: every row, then search; films', shows' and anime's ids", async () => {
    ({ body: manifest } = await getJson(`/${seg}/manifest.json`));
    expect(manifest.catalogs.length === rows.length + 1, `${manifest.catalogs.length} catalogs`);
    expect(manifest.catalogs[rows.length].id === "search", "search is not last");
    for (const prefix of ["tt", "kitsu:", "mal:", "anilist:", "anidb:", "yt_id:"]) expect(manifest.idPrefixes.includes(prefix), `no ${prefix}`);
    const off = (await getJson(`/${segment({ anime: false })}/manifest.json`)).body;
    expect(!off.idPrefixes.includes("kitsu:") && !off.types.includes("anime"), "anime off still claims anime");
    return `v${manifest.version}, ${manifest.catalogs.length} catalogs`;
  });
  if (!manifest) return;
  const catalog = async (i, extra = "") => {
    const { id } = manifest.catalogs[i];
    const { res, body } = await getJson(`/${seg}/catalog/youtube/${encodeURIComponent(id)}${extra}.json`);
    expect(res.status === 200 && body && Array.isArray(body.metas), `HTTP ${res.status}`);
    return body.metas;
  };
  let trending = [];
  await check("addon", "Trending: YouTube items, each with a name and a poster", async () => {
    trending = await catalog(0);
    expect(trending.length > 0, "empty");
    for (const meta of trending) expect(/^yt_id:/.test(meta.id) && meta.type === "youtube" && meta.name && meta.poster, `odd item ${meta.id}`);
    return `${trending.length} videos`;
  });
  await check("addon", "Trending, videos alone", async () => {
    const videos = await catalog(1);
    expect(videos.length > 0 && videos.length <= trending.length, `${videos.length} of ${trending.length}`);
    return `${videos.length} of ${trending.length}`;
  });
  await check("addon", "a channel's videos, and its Shorts alone, each from YouTube's own list", async () => {
    const videos = await catalog(2);
    const shorts = await catalog(3);
    expect(videos.length > 0 && shorts.length > 0, `${videos.length} videos, ${shorts.length} Shorts`);
    const long = shorts.filter((m) => seconds(m.runtime) > 180);
    expect(!long.length, `${long.length} Shorts over three minutes`);
    return `${videos.length} videos, ${shorts.length} Shorts`;
  });
  await check("addon", "a playlist, in its own order", async () => {
    const items = await catalog(4);
    expect(items.length > 0, "empty");
    return `${items.length} videos`;
  });
  await check("addon", "a search row, and the same without Shorts", async () => {
    const every = await catalog(5);
    const without = await catalog(6);
    expect(every.length > 0 && without.length <= every.length, `${without.length} of ${every.length}`);
    return `${without.length} of ${every.length} kept`;
  });
  await check("addon", "a row's own name is what the app shows", async () => {
    expect(manifest.catalogs[7].name === "Short and medium", `named "${manifest.catalogs[7].name}"`);
  });
  await check("addon", "lengths: Trending under 20 minutes, a channel's 20 to 60, each trimmed here", async () => {
    const short = await catalog(7);
    const long = await catalog(8);
    const outside = (metas, min, max) => metas.filter((m) => m.runtime && (seconds(m.runtime) < min || seconds(m.runtime) > max));
    expect(short.length > 0 && !outside(short, 0, 20 * 60 + 30).length, `${outside(short, 0, 1230).length} of ${short.length} outside`);
    expect(!outside(long, 20 * 60 - 30, 60 * 60 + 30).length, `${outside(long, 1170, 3630).length} of ${long.length} outside`);
    return `${short.length} and ${long.length} videos`;
  });
  await check("addon", "a keyword filter leaves out what mentions its word", async () => {
    const word = (trending.map((m) => (m.name.match(/\p{L}{6,}/u) || [])[0]).find(Boolean) || "").toLowerCase();
    expect(word, "no word to filter by");
    const filtered = segment({ ...config, catalogs: [{ trending: "all", exclude: [word] }] });
    const { body } = await getJson(`/${filtered}/catalog/youtube/trending.all.json`);
    // Whole words, as the filter reads them: a plural or a possessive too.
    const mentions = new RegExp(`(?<![\\p{L}\\p{N}])${word}(?:'?s)?(?![\\p{L}\\p{N}])`, "iu");
    const left = body.metas.filter((m) => mentions.test(m.name));
    expect(!left.length, `${left.length} still mention "${word}"`);
    return `${trending.length - body.metas.length} left out`;
  });
  await check("addon", "the next page of a row starts where the last ended", async () => {
    const next = await catalog(0, `/skip=${trending.length}`);
    expect(!next.some((m) => trending.some((t) => t.id === m.id)), "repeats the first page");
    return `${next.length} more`;
  });
  await check("addon", "the app's search searches YouTube", async () => {
    const { body } = await getJson(`/${seg}/catalog/youtube/search/search=${encodeURIComponent("lofi hip hop radio")}.json`);
    expect(body.metas && body.metas.length > 0, "nothing found");
    return `${body.metas.length} videos`;
  });
  const item = trending[0];
  await check("addon", "a video's page: its details", async () => {
    expect(item, "no video to open");
    const { body } = await getJson(`/${seg}/meta/youtube/${encodeURIComponent(item.id)}.json`);
    expect(body.meta && body.meta.name && body.meta.description !== undefined && body.meta.poster, "missing details");
  });
  await check("addon", "a video's streams: one per way to watch", async () => {
    expect(item, "no video to play");
    const { body } = await getJson(`/${seg}/stream/youtube/${encodeURIComponent(item.id)}.json`);
    expect(body.streams.length >= 1 && body.streams.every((s) => s.ytId || s.externalUrl), "no playable stream");
    return `${body.streams.length} streams`;
  });
  const streams = async (type, id, settings = config) => (await getJson(`/${segment(settings)}/stream/${type}/${id}.json`)).body.streams;
  await check("addon", "a film's full upload", async () => {
    const found = await streams("movie", FILM);
    expect(found.length >= 1, "none found");
    return `${found.length} streams`;
  });
  await check("addon", "a web series episode, from its official channel", async () => {
    const found = await streams("series", EPISODE);
    expect(found.length >= 1, "none found");
    return `${found.length} streams`;
  });
  let animeCount = 0;
  await check("addon", "an anime episode by Kitsu's id", async () => {
    animeCount = (await streams("series", ANIME.kitsu)).length;
    expect(animeCount >= 1, "none found");
    return `${animeCount} streams`;
  });
  await check("addon", "the same episode by MyAnimeList's and AniList's ids", async () => {
    const mal = (await streams("series", ANIME.mal)).length;
    const anilist = (await streams("anime", ANIME.anilist)).length;
    expect(mal >= 1 && anilist >= 1, `${mal} by MyAnimeList, ${anilist} by AniList`);
    return `${mal} and ${anilist}`;
  });
  await check("addon", "anime switched off is never looked for", async () => {
    const found = await streams("series", ANIME.kitsu, { ...config, anime: false });
    expect(found.length === 0, `${found.length} streams`);
  });
  await check("addon", "the explain endpoint shows the working", async () => {
    const { body } = await getJson(`/${seg}/explain/series/${ANIME.kitsu}.json`);
    expect(body.status === "ok" && body.query && Array.isArray(body.matches) && body.matches.length >= 1, `status ${body.status}`);
    return `searched "${body.query}"`;
  });
  await check("addon", "an id nobody uses is no stream", async () => {
    const found = await streams("movie", "xyz123");
    expect(Array.isArray(found) && found.length === 0, "streams for nothing");
  });
  state.trendingCount = trending.length;
}

// --- Profiles, through the API --------------------------------------------

async function profileChecks(state) {
  if (!wanted("profiles")) return;
  console.log("\nprofiles");
  if (!state.health || state.health.profiles !== "ready") {
    console.log("  - skipped: this server has profiles off");
    return;
  }
  let cookie = "";
  const call = async (method, p, body) => {
    const res = await fetch(url(`/api/profile${p}`), {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const manifestOf = async (installUrl) => (await getJson(installUrl)).body;
  let profile;
  await check("profiles", "a profile is made, signed in, with one install link", async () => {
    const made = await call("POST", "", { config: { youtubeKey: KEY, catalogs: [{ trending: "all" }] }, password: PASSWORD, remember: false });
    if (made.body && made.body.id) madeProfiles.set(made.body.id, PASSWORD);
    expect(made.status === 201 && made.body.id && made.body.installUrl, `HTTP ${made.status}`);
    profile = made.body;
    const read = await call("GET", "");
    expect(read.status === 200 && read.body.config.catalogs.length === 1, "settings not read back");
    const manifest = await manifestOf(profile.installUrl);
    expect(manifest.catalogs.some((c) => c.id === "trending.all"), "the install link has not its rows");
  });
  if (!profile) return;
  await check("profiles", "a save reaches the install link at once, and says when apps must reload", async () => {
    const saved = await call("PUT", "", { config: { youtubeKey: KEY, catalogs: [{ trending: "music" }], search: false } });
    expect(saved.status === 200 && saved.body.saved && saved.body.manifestChanged === true, `HTTP ${saved.status}`);
    const manifest = await manifestOf(profile.installUrl);
    expect(manifest.catalogs.map((c) => c.id).join() === "trending.music", `rows: ${manifest.catalogs.map((c) => c.id)}`);
  });
  await check("profiles", "signed out, nothing is read; signed in again, all of it", async () => {
    expect((await call("DELETE", "/session")).status === 204, "not signed out");
    expect((await call("GET", "")).status === 401, "still signed in");
    const back = await call("POST", "/session", { id: profile.id, password: PASSWORD, remember: false });
    expect(back.status === 200, `sign-in HTTP ${back.status}`);
    expect((await call("GET", "")).status === 200, "not signed in");
  });
  await check("profiles", "a wrong password is refused", async () => {
    const wrong = await call("POST", "/session", { id: profile.id, password: `${PASSWORD} not` });
    expect(wrong.status === 401 || wrong.status === 403, `HTTP ${wrong.status}`);
    expect((await call("POST", "/session", { id: profile.id, password: PASSWORD, remember: false })).status === 200, "not signed in again");
  });
  let password = PASSWORD;
  await check("profiles", "the password is changed, and the install link kept", async () => {
    const changed = await call("POST", "/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status === 200 && changed.body.changed, `HTTP ${changed.status}`);
    password = NEW_PASSWORD;
    madeProfiles.set(profile.id, password);
    expect((await manifestOf(profile.installUrl)).catalogs.length === 1, "the install link changed");
  });
  await check("profiles", "a replaced install link works, and the old one no longer does", async () => {
    const replaced = await call("POST", "/link", { password });
    expect(replaced.status === 200 && replaced.body.installUrl !== profile.installUrl, `HTTP ${replaced.status}`);
    const fresh = await manifestOf(replaced.body.installUrl);
    expect(fresh.catalogs.some((c) => c.id === "trending.music"), "the new link has not its rows");
    const old = await getJson(profile.installUrl);
    expect(!(old.body && old.body.catalogs && old.body.catalogs.some((c) => c.id === "trending.music")), "the old link still works");
    profile.installUrl = replaced.body.installUrl;
  });
  await check("profiles", "deleted: gone, and its link says so", async () => {
    const gone = await call("DELETE", "", { password });
    expect(gone.status === 204, `HTTP ${gone.status}`);
    madeProfiles.delete(profile.id);
    const manifest = await manifestOf(profile.installUrl);
    expect(!(manifest && manifest.catalogs && manifest.catalogs.some((c) => c.id === "trending.music")), "still answering");
  });
}

// --- The configure page in a browser --------------------------------------

async function browserChecks(state) {
  if (!wanted("browser")) return;
  console.log("\nbrowser");
  let playwright;
  try {
    playwright = require("playwright");
  } catch (_) {
    console.log("  - skipped: Playwright is not installed");
    return;
  }
  // Playwright's own Ctrl-C handling would end the run before its profiles are deleted.
  const browser = await playwright.chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const devices = [
    ["phone", { ...playwright.devices["iPhone 13"] }],
    ["desktop", { viewport: { width: 1280, height: 900 } }]
  ];
  try {
    for (const [device, options] of devices) await browserRun(browser, device, options, state);
    if (state.health && state.health.profiles === "ready") await profileInBrowser(browser);
  } finally {
    await browser.close();
  }
}

async function openPage(browser, options) {
  const context = await browser.newContext({ ...options, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const summaryLine = (page, name) =>
  page.evaluate((n) => {
    const row = [...document.querySelectorAll("#summary-list .summary-row")].find((r) => r.querySelector(".s-name").textContent === n);
    return row ? row.querySelector(".s-value").textContent : null;
  }, name);

async function browserRun(browser, device, options, state) {
  const { context, page, errors } = await openPage(browser, options);
  try {
    await page.goto(url("/configure"));
    await check("browser", `${device}: every tab opens, at its own address, nothing wider than the screen`, async () => {
      for (const tab of ["streams", "playback", "catalogs", "account", "summary"]) {
        await page.locator(`.tab[data-tab="${tab}"]`).click();
        await page.locator(`.panel[data-tab="${tab}"]`).waitFor({ state: "visible", timeout: 5000 });
        expect(new URL(page.url()).hash === `#${tab}`, `address ${new URL(page.url()).hash}`);
        expect((await overflow(page)) <= 0, `${tab} scrolls sideways`);
      }
    });
    await check("browser", `${device}: the key is checked the moment it is pasted`, async () => {
      await page.goto(url("/configure#summary"));
      await page.fill("#youtube-key", KEY);
      await page.locator("#youtube-key").dispatchEvent("change");
      await page.waitForFunction(() => /works/i.test(document.getElementById("key-status").textContent), null, { timeout: 15000 });
    });
    await check("browser", `${device}: settings made on any tab are on the summary`, async () => {
      await page.goto(url("/configure#streams"));
      await page.uncheck("#type-series");
      expect((await summaryLine(page, "Looks for")) === "Movies and anime", `Looks for: ${await summaryLine(page, "Looks for")}`);
      await page.goto(url("/configure#catalogs"));
      await page.fill("#catalog-input", "lofi hip hop");
      await page.click("#catalog-add");
      await page.locator('#catalog-list .cat-row').first().locator('.cat-types input[value="shorts"]').uncheck();
      await page.locator("#trending-chips button", { hasText: "Music" }).click();
      const line = await summaryLine(page, "Catalogs");
      expect(line === "2 rows: lofi hip hop · Videos & live, Trending Music", `Catalogs: ${line}`);
      // Renamed with its pencil; kept to an hour or more.
      const music = page.locator("#catalog-list .cat-row").nth(1);
      await music.locator(".cat-rename").click();
      await music.locator(".cat-name-input").fill("Music");
      await music.locator(".cat-name-input").press("Enter");
      await music.locator('.cat-lengths input[value="over60"]').check();
      const renamed = await summaryLine(page, "Catalogs");
      expect(renamed === "2 rows: lofi hip hop · Videos & live, Music", `Catalogs: ${renamed}`);
      expect((await music.locator(".cat-made").textContent()) === "Trending Music · Over 1 hr", "no made name beneath");
      expect((await overflow(page)) <= 0, "the rows scroll sideways");
    });
    await check("browser", `${device}: an install link that carries the settings`, async () => {
      await page.goto(url("/configure#summary"));
      await page.check("#agree");
      // With profiles on, the summary offers one first; a plain link is a choice below it.
      if (await page.locator("#no-profile-btn").count()) await page.click("#no-profile-btn");
      await page.click("#submit-btn");
      await page.waitForFunction(() => /manifest\.json$/.test(document.getElementById("manifest-url").value), null, { timeout: 15000 });
      const link = await page.inputValue("#manifest-url");
      const settings = JSON.parse(decodeURIComponent(link.slice(link.indexOf(BASE) + BASE.length + 1, -"/manifest.json".length)));
      expect(JSON.stringify(settings.types) === '["movie"]', `types ${JSON.stringify(settings.types)}`);
      const rows = [{ q: "lofi hip hop", types: ["videos", "live"] }, { trending: "music", length: "over60", label: "Music" }];
      expect(JSON.stringify(settings.catalogs) === JSON.stringify(rows), `rows: ${JSON.stringify(settings.catalogs)}`);
      expect(await page.locator("#install-app").count(), "no Install in Nuvio");
    });
    if (device === "desktop") {
      await check("browser", "desktop: settings exported to a file, and imported into a new page", async () => {
        await page.goto(url("/configure#account"));
        const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
        const file = path.join(os.tmpdir(), `youstream-e2e-${process.pid}.json`);
        await download.saveAs(file);
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        const config = saved.config || saved;
        expect(!config.youtubeKey, "the key was exported");
        expect(config.catalogs && config.catalogs.length === 2, "the rows were not exported");
        const fresh = await openPage(browser, options);
        await fresh.page.goto(url("/configure#account"));
        await fresh.page.setInputFiles("#import-file", file);
        await fresh.page.waitForFunction(() => document.querySelectorAll("#catalog-list .cat-row").length === 2, null, { timeout: 10000 });
        fs.unlinkSync(file);
        await fresh.context.close();
      });
    }
    await check("browser", `${device}: no script error on the way`, async () => {
      expect(!errors.length, errors.join(" | "));
    });
  } finally {
    await context.close();
  }
}

async function profileInBrowser(browser) {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  let id = null;
  try {
    await check("browser", "profile: made from the summary, then its install link", async () => {
      await page.goto(url("/configure"));
      await page.fill("#youtube-key", KEY);
      await page.fill("#create-password", PASSWORD);
      await page.fill("#create-password2", PASSWORD);
      await page.check("#agree");
      // Its ID is noted the moment it is made, so that it is deleted whatever happens next.
      const creating = (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/profile";
      const [created] = await Promise.all([page.waitForResponse(creating, { timeout: 30000 }), page.click("#submit-btn")]);
      const made = await created.json().catch(() => null);
      if (made && made.id) madeProfiles.set(made.id, PASSWORD);
      await page.waitForURL(/done=created/, { timeout: 30000 });
      expect(/\/manifest\.json$/.test(await page.inputValue("#profile-url")), "no install link");
      id = (await page.textContent("#profile-id")).trim();
      expect(/^[0-9a-f-]{36}$/.test(id), "no profile ID on Account");
    });
    if (!id) return;
    await check("browser", "profile: a change brings the save bar, and saved it stays", async () => {
      await page.goto(url("/configure#streams"));
      expect(!(await page.locator("#finish").isVisible()), "a save button besides the bar");
      await page.fill("#max-results", "7");
      await page.locator("#save-bar").waitFor({ state: "visible" });
      await page.click("#save-bar-btn");
      await page.locator("#save-bar").waitFor({ state: "hidden", timeout: 15000 });
      await page.reload();
      expect((await page.inputValue("#max-results")) === "7", "not kept");
    });
    await check("browser", "profile: signed out, then in again by its ID and password", async () => {
      await page.goto(url("/configure#account"));
      await page.click("#signout-btn");
      await page.click("#signout-confirm");
      // Signed out, the page opens again as a new setup, with signing in folded on Account.
      await page.waitForFunction(() => !document.getElementById("profile-id") && document.getElementById("signin-card"), null, { timeout: 15000 });
      await page.goto(url("/configure#account"));
      await page.waitForLoadState();
      if (!(await page.locator("#signin-card").getAttribute("open")) && (await page.locator("#signin-card").getAttribute("open")) !== "") {
        await page.click("#signin-card > summary");
      }
      await page.fill("#signin-id", id);
      await page.fill("#signin-password", PASSWORD);
      await page.click("#signin-btn");
      await page.waitForFunction(() => document.getElementById("profile-id"), null, { timeout: 15000 });
      expect((await page.textContent("#profile-id")).trim() === id, "another profile");
    });
    await check("browser", "profile: deleted, with its password", async () => {
      await page.goto(url("/configure#account"));
      await page.click("#security-card > summary");
      await page.fill("#delete-password", PASSWORD);
      await page.check("#delete-sure");
      await page.click("#delete-btn");
      await page.waitForFunction(() => !document.getElementById("profile-id"), null, { timeout: 15000 });
      madeProfiles.delete(id);
    });
    await check("browser", "profile: no script error on the way", async () => {
      expect(!errors.length, errors.join(" | "));
    });
  } finally {
    // A profile the page made whose ID was never noted is the one it is signed in to.
    const me = await context.request.get(url("/api/profile")).then((res) => (res.ok() ? res.json() : null), () => null);
    if (me && me.id && !madeProfiles.has(me.id)) madeProfiles.set(me.id, PASSWORD);
    await context.close();
  }
}

// --- Run ------------------------------------------------------------------

(async () => {
  if (!KEY) {
    console.error("Set YOUTUBE_KEY, or YOUTUBE_KEY_FILE to a file holding it.");
    process.exit(2);
  }
  console.log(`YouStream end to end at ${BASE}`);
  // What the server has on decides which checks apply, whichever groups run.
  const state = { health: (await getJson("/health").catch(() => ({}))).body };
  await serverChecks(state);
  await addonChecks(state);
  await profileChecks(state);
  await browserChecks(state);
  const clean = await cleanUp();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  process.exit(failed.length || !clean ? 1 : 0);
})().catch(async (err) => {
  console.error(redact(err.stack));
  await cleanUp().catch(() => {});
  process.exit(1);
});
