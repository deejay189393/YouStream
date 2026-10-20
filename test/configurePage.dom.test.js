/**
 * Behavioural tests for the configure page's inline script.
 *
 * Asserting on the rendered HTML cannot tell whether the script actually
 * runs: a script with a syntax error still contains all the right
 * substrings. Newsio learned this the hard way -- a regex's escapes were
 * eaten by the template literal, the script died at parse time, and the
 * submit button fell through to a native form GET. So the page is executed
 * in a real DOM here and its controls are driven.
 */
const { JSDOM, VirtualConsole } = require("jsdom");
const { renderConfigurePage } = require("../src/configurePage");
const { decodeConfig, normalizeConfig, DEFAULT_EXCLUDE, DEFAULT_EXCLUDE_DESCRIPTION } = require("../src/config");

const BASE = "https://youstream.up.railway.app";

const openWindows = [];
afterEach(() => {
  while (openWindows.length) openWindows.pop().close();
});

/**
 * The page, loaded and run. The terms box is ticked, as a reader who goes
 * on to install has ticked it, unless `agreed` says otherwise.
 */
function loadPage({ existing = null, language = "en-US", fetch, clipboard, agreed = true } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => errors.push(err));

  const dom = new JSDOM(renderConfigurePage({ baseUrl: BASE + "/", existing }), {
    runScripts: "dangerously",
    url: BASE + "/configure",
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
      if (fetch) window.fetch = fetch;
      if (clipboard) Object.defineProperty(window.navigator, "clipboard", { value: clipboard, configurable: true });
    }
  });
  openWindows.push(dom.window);
  const { document } = dom.window;
  const $ = (sel) => document.querySelector(sel);
  if (agreed) $("#agree").checked = true;

  return {
    dom,
    document,
    errors,
    $,
    set(id, value) {
      $(`#${id}`).value = value;
    },
    check(id, on) {
      $(`#${id}`).checked = on;
    },
    click(el) {
      (typeof el === "string" ? $(el) : el).dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
    },
    submit() {
      $("#config-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    },
    error: () => ($("#error").style.display === "none" ? null : $("#error").textContent),
    shown: () => $("#result").classList.contains("show"),
    generated() {
      const url = $("#manifest-url").value;
      return decodeConfig(url.slice(BASE.length + 1, -"/manifest.json".length));
    },
    rawGenerated() {
      const url = $("#manifest-url").value;
      return JSON.parse(decodeURIComponent(url.slice(BASE.length + 1, -"/manifest.json".length)));
    },
    playbackOrder: () => [...document.querySelectorAll(".pb-option")].map((r) => r.getAttribute("data-option"))
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("the page script contains no backslash, so the template literal cannot mangle it", () => {
  const html = renderConfigurePage({ baseUrl: BASE, existing: null });
  const script = html.slice(html.lastIndexOf("<script>"), html.lastIndexOf("</script>"));
  // jsonForScript's own escapes are the only backslashes allowed, and the
  // values it embeds here contain none.
  expect(script).not.toContain("\\");
});

test("the script runs without errors", () => {
  const p = loadPage();
  expect(p.errors).toEqual([]);
});

describe("building the install link", () => {
  test("a key alone gives a minimal config, the stremio:// link and the https URL", () => {
    const p = loadPage();
    p.set("youtube-key", "  AIzaKey_1  ");
    p.submit();
    expect(p.error()).toBeNull();
    expect(p.shown()).toBe(true);
    // A new setup starts with search on and no catalogs.
    expect(p.rawGenerated()).toEqual({
      youtubeKey: "AIzaKey_1",
      playback: ["app", "youtube"],
      playbackVersion: 1,
      region: "US",
      search: true
    });
    expect(p.$("#install-link").href).toMatch(/^stremio:\/\/youstream\.up\.railway\.app\/%7B/);
    expect(p.$("#warning").style.display).toBe("none");
  });

  test("every setting changed reaches the config, exactly as the server reads it", () => {
    const p = loadPage();
    p.set("youtube-key", "AIzaKey");
    p.set("tmdb-key", "eyJtoken.part-2");
    p.check("type-movie", false);
    const movie = p.$('[data-margin="movieMargin"]');
    movie.querySelector(".margin-value").value = "12.5";
    movie.querySelector(".margin-unit").value = "%";
    p.$('[data-margin="episodeMargin"] .margin-value').value = "60";
    p.set("max-results", "8");
    p.set("min-views", "0");
    p.set("region", "IN");
    p.set("audio-language", "hi");
    p.check("embeddable-only", true);
    p.check("official-only", true);
    p.set("exclude-description", "Fan Movie, , fan movie");
    p.set("movie-query", "{title} film");
    p.set("episode-query", "{title} {s00e00}");
    p.set("exclude", "Trailer, reaction, , trailer");
    p.submit();
    expect(p.error()).toBeNull();
    expect(p.rawGenerated()).toEqual({
      youtubeKey: "AIzaKey",
      tmdbKey: "eyJtoken.part-2",
      movieMargin: "12.5%",
      episodeMargin: "60s",
      playback: ["app", "youtube"],
      playbackVersion: 1,
      types: ["series"],
      maxResults: 8,
      minViews: 0,
      region: "IN",
      audioLanguage: "hi",
      embeddableOnly: true,
      officialOnly: true,
      movieQuery: "{title} film",
      episodeQuery: "{title} {s00e00}",
      exclude: ["trailer", "reaction"],
      excludeDescription: ["fan movie"],
      search: true
    });
    expect(p.generated()).toMatchObject({ movieMargin: { value: 12.5, unit: "%" }, types: ["series"] });
  });

  test("the playback rows can be reordered and switched off", () => {
    const p = loadPage();
    const rows = () => [...p.document.querySelectorAll(".pb-option")];
    expect(rows()[0].querySelector(".pb-up").disabled).toBe(true);
    expect(rows()[2].querySelector(".pb-down").disabled).toBe(true);
    p.click(rows()[2].querySelector(".pb-up")); // smarttube above youtube
    p.click(rows()[0].querySelector(".pb-up")); // already first: nothing moves
    p.click(rows()[2].querySelector(".pb-down")); // already last: nothing moves
    expect(p.playbackOrder()).toEqual(["app", "smarttube", "youtube"]);
    p.click(rows()[0].querySelector(".pb-down")); // app below smarttube
    expect(p.playbackOrder()).toEqual(["smarttube", "app", "youtube"]);
    rows()[0].querySelector(".pb-on").checked = true;
    rows()[2].querySelector(".pb-on").checked = false;
    p.set("youtube-key", "k");
    p.submit();
    expect(p.rawGenerated().playback).toEqual(["smarttube", "app"]);
  });

  test("an emptied exclusion list is saved as empty", () => {
    const p = loadPage();
    p.set("youtube-key", "k");
    p.set("exclude", " ");
    p.submit();
    expect(p.rawGenerated().exclude).toEqual([]);
  });

  test("reset puts the defaults back", () => {
    const p = loadPage();
    p.set("movie-query", "x");
    p.set("episode-query", "y");
    p.set("exclude", "z");
    p.set("exclude-description", "w");
    p.document.querySelectorAll(".reset").forEach((b) => p.click(b));
    expect(p.$("#movie-query").value).toBe("{title} {year} full movie {language}");
    expect(p.$("#episode-query").value).toBe("{title} season {season} episode {episode}");
    expect(p.$("#exclude").value).toBe(DEFAULT_EXCLUDE.join(", "));
    expect(p.$("#exclude-description").value).toBe(DEFAULT_EXCLUDE_DESCRIPTION.join(", "));
  });
});

describe("validation", () => {
  const attempt = (setup) => {
    const p = loadPage();
    p.set("youtube-key", "AIzaKey");
    setup(p);
    p.submit();
    return p;
  };

  test.each([
    ["a missing key", (p) => p.set("youtube-key", " "), "Enter your YouTube API key."],
    ["a key with spaces", (p) => p.set("youtube-key", "AIza Key"), "That YouTube key has characters"],
    ["a TMDB key with symbols", (p) => p.set("tmdb-key", "tm<db"), "That TMDB key has characters"],
    [
      "nothing to do: no films, no shows, no search and no catalog",
      (p) => {
        p.check("type-movie", false);
        p.check("type-series", false);
        p.check("yt-search", false);
      },
      "Choose something for YouStream to do: movies, series, YouTube search, or a catalog."
    ],
    ["a refresh interval that is no number", (p) => p.set("refresh-value", "soon"), "Refresh catalogs every: enter a number."],
    ["a refresh interval of nothing", (p) => p.set("refresh-value", "0"), "Refresh catalogs every: enter a number."],
    [
      "a refresh interval under half an hour",
      (p) => {
        p.set("refresh-value", "20");
        p.set("refresh-unit", "m");
      },
      "Refresh catalogs every: at least 30 minutes."
    ],
    ["a margin that is not a number", (p) => (p.$('[data-margin="movieMargin"] .margin-value').value = ""), "Movies: enter the margin"],
    ["a margin with two points", (p) => (p.$('[data-margin="movieMargin"] .margin-value').value = "1.2.3"), "Movies: enter the margin"],
    ["a margin with a bad decimal part", (p) => (p.$('[data-margin="movieMargin"] .margin-value').value = "1.x"), "Movies: enter the margin"],
    [
      "a margin too large for its unit",
      (p) => {
        p.$('[data-margin="episodeMargin"] .margin-value').value = "101";
        p.$('[data-margin="episodeMargin"] .margin-unit').value = "%";
      },
      "Episodes: at most 100 %."
    ],
    [
      "no way to watch",
      (p) => p.document.querySelectorAll(".pb-on").forEach((b) => (b.checked = false)),
      "Turn on at least one way to watch."
    ],
    ["too many results", (p) => p.set("max-results", "21"), "Videos to list: a whole number from 1 to 20."],
    ["zero results", (p) => p.set("max-results", "0"), "Videos to list"],
    ["a fractional count", (p) => p.set("max-results", "2.5"), "Videos to list"],
    ["a negative view minimum", (p) => p.set("min-views", "-5"), "Minimum views: a whole number, 0 or more."],
    ["too large a view minimum", (p) => p.set("min-views", "100000001"), "Minimum views"],
    ["a search without {title}", (p) => p.set("episode-query", "season {season}"), "Both searches need {title} in them."]
  ])("%s", (_, setup, message) => {
    const p = attempt(setup);
    expect(p.error()).toContain(message);
    expect(p.shown()).toBe(false);
  });

  test("fixing the problem clears the error", () => {
    const p = attempt((x) => x.set("max-results", "0"));
    p.set("max-results", "3");
    p.submit();
    expect(p.error()).toBeNull();
    expect(p.shown()).toBe(true);
  });
});

describe("checking the keys with the server", () => {
  const replying = (status) => jest.fn(() => Promise.resolve({ json: () => Promise.resolve(status) }));

  test("good keys build the link, after a POST that carries both keys", async () => {
    const fetch = replying({ youtube: "ok", tmdb: "ok" });
    const p = loadPage({ fetch });
    p.set("youtube-key", "AIzaKey");
    p.set("tmdb-key", "tm");
    p.submit();
    expect(p.$("#submit-btn").disabled).toBe(true);
    await flush();
    expect(fetch).toHaveBeenCalledWith("/api/check-keys", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ youtubeKey: "AIzaKey", tmdbKey: "tm" });
    expect(p.shown()).toBe(true);
    expect(p.$("#submit-btn").disabled).toBe(false);
  });

  test.each([
    ["invalid", "not valid"],
    ["disabled", "does not have the YouTube Data API v3 enabled"],
    ["restricted", "Application restrictions to None"],
    ["missing", "Enter your YouTube API key."]
  ])("a %s YouTube key is explained, and no link is built", async (status, message) => {
    const p = loadPage({ fetch: replying({ youtube: status, tmdb: "absent" }) });
    p.set("youtube-key", "AIzaKey");
    p.submit();
    await flush();
    expect(p.error()).toContain(message);
    expect(p.shown()).toBe(false);
  });

  test("an invalid TMDB key is explained", async () => {
    const p = loadPage({ fetch: replying({ youtube: "ok", tmdb: "invalid" }) });
    p.set("youtube-key", "AIzaKey");
    p.set("tmdb-key", "bad");
    p.submit();
    await flush();
    expect(p.error()).toContain("TMDB says this key is not valid");
  });

  test("a spent quota builds the link with a warning", async () => {
    const p = loadPage({ fetch: replying({ youtube: "quota", tmdb: "absent" }) });
    p.set("youtube-key", "AIzaKey");
    p.submit();
    await flush();
    expect(p.shown()).toBe(true);
    expect(p.$("#warning").style.display).toBe("block");
    expect(p.$("#warning").textContent).toContain("quota for today is already spent");
  });

  test("when the check itself fails, the link is built anyway", async () => {
    const p = loadPage({ fetch: jest.fn(() => Promise.reject(new Error("offline"))) });
    p.set("youtube-key", "AIzaKey");
    p.submit();
    await flush();
    expect(p.shown()).toBe(true);
    expect(p.$("#submit-btn").textContent).toBe("Generate install link");
  });
});

describe("the country", () => {
  test("a new setup starts in the browser's country", () => {
    expect(loadPage({ language: "en-IN" }).$("#region").value).toBe("IN");
  });

  test("a language tag without a country, or with one YouTube does not list, leaves it on any country", () => {
    expect(loadPage({ language: "en" }).$("#region").value).toBe("");
    expect(loadPage({ language: "en-ZZ" }).$("#region").value).toBe("");
  });

  test("reconfiguring keeps what was saved, even when that is any country", () => {
    const existing = normalizeConfig({ youtubeKey: "k" });
    expect(loadPage({ existing, language: "en-IN" }).$("#region").value).toBe("");
  });
});

describe("small controls", () => {
  test("the eye shows and hides a key", () => {
    const p = loadPage();
    const toggle = p.$('.key-toggle[data-for="youtube-key"]');
    p.click(toggle);
    expect(p.$("#youtube-key").type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    p.click(toggle);
    expect(p.$("#youtube-key").type).toBe("password");
    expect(toggle.getAttribute("title")).toBe("Show key");
  });

  test("copy uses the clipboard and says so", async () => {
    const writeText = jest.fn(() => Promise.resolve());
    const p = loadPage({ clipboard: { writeText } });
    p.set("youtube-key", "k");
    p.submit();
    p.click("#copy-btn");
    await flush();
    expect(writeText).toHaveBeenCalledWith(p.$("#manifest-url").value);
    expect(p.$("#copy-btn").textContent).toBe("Copied!");
    await new Promise((r) => setTimeout(r, 1600));
    expect(p.$("#copy-btn").textContent).toBe("Copy");
  });

  test("copy falls back to selecting the URL", async () => {
    const p = loadPage({ clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    const select = jest.spyOn(p.$("#manifest-url"), "select");
    p.click("#copy-btn");
    await flush();
    expect(select).toHaveBeenCalled();
  });

  test("copy without a clipboard selects the URL", () => {
    const p = loadPage();
    const select = jest.spyOn(p.$("#manifest-url"), "select");
    p.click("#copy-btn");
    expect(select).toHaveBeenCalled();
  });
});

test("a base URL with no scheme still yields a link", () => {
  const dom = new JSDOM(renderConfigurePage({ baseUrl: "youstream.local", existing: null }), {
    runScripts: "dangerously",
    url: BASE + "/configure"
  });
  openWindows.push(dom.window);
  const { document } = dom.window;
  document.getElementById("youtube-key").value = "k";
  document.getElementById("agree").checked = true;
  document.getElementById("config-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  expect(document.getElementById("install-link").getAttribute("href")).toMatch(/^youstream\.local\/%7B/);
});

describe("agreeing to the terms", () => {
  test("no link is built until the reader agrees to YouTube's terms and YouStream's", () => {
    const p = loadPage({ agreed: false });
    expect(p.$("#agree").checked).toBe(false);
    p.set("youtube-key", "AIzaKEY");
    p.submit();
    expect(p.error()).toBe(
      "To install YouStream, agree to the YouTube Terms of Service and YouStream's terms of use and privacy policy."
    );
    expect(p.shown()).toBe(false);
    p.check("agree", true);
    p.submit();
    expect(p.error()).toBeNull();
    expect(p.shown()).toBe(true);
  });

  test("the box links both, and someone editing a setup they installed has already agreed", () => {
    const p = loadPage({ agreed: false });
    const links = [...p.document.querySelectorAll(".agree a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://www.youtube.com/t/terms", "/terms"]);
    expect(loadPage({ existing: { youtubeKey: "AIzaKEY" }, agreed: false }).$("#agree").checked).toBe(true);
  });
});

describe("the stream name and description", () => {
  const { PRESETS } = require("../src/streamFormat");
  const fire = (p, id, type) => p.$(`#${id}`).dispatchEvent(new p.dom.window.Event(type, { bubbles: true }));
  const rows = (p) =>
    [...p.document.querySelectorAll("#format-preview li")].map((li) => ({
      name: li.querySelector(".p-name").textContent,
      description: li.querySelector(".p-desc").textContent
    }));
  const warnings = (p) => [...p.document.querySelectorAll("#format-warnings li")].map((li) => li.textContent);

  test("starts on the default preset, previewing one row per way of watching", () => {
    const p = loadPage();
    expect(p.$("#format-preset").value).toBe("youstream");
    expect(p.$("#name-template").value).toBe(PRESETS.youstream.name);
    expect(p.$("#description-template").value).toBe(PRESETS.youstream.description);
    const preview = rows(p);
    expect(preview.map((r) => r.name)).toEqual(["▶️ YouStream HD", "📱 YouStream HD"]);
    expect(preview[0].description.split("\n")[0]).toBe("🍿 Example Film (1968)");
    expect(preview[1].description.split("\n").pop()).toBe("📱 YouTube app");
    expect(warnings(p)).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  test("a preset fills both templates, and the link names it", () => {
    const p = loadPage();
    p.set("format-preset", "tamtaro");
    fire(p, "format-preset", "change");
    expect(p.$("#name-template").value).toBe(PRESETS.tamtaro.name);
    expect(rows(p)[0].name).toBe("720P ⁽ʸᵗ⁾\n  〈Web-dl〉");
    expect(rows(p)[1].name).toBe("720P ⁽ᵉˣᵗ⁾\n  〈Web-dl〉");
    p.set("youtube-key", "k");
    p.submit();
    expect(p.rawGenerated()).toMatchObject({ format: "tamtaro" });
    expect(p.rawGenerated().nameTemplate).toBeUndefined();
    expect(p.generated()).toMatchObject({ format: "tamtaro", nameTemplate: PRESETS.tamtaro.name });
  });

  test("choosing Custom keeps the templates as they are", () => {
    const p = loadPage();
    p.set("format-preset", "custom");
    fire(p, "format-preset", "change");
    expect(p.$("#name-template").value).toBe(PRESETS.youstream.name);
  });

  test("an edited template is the reader's own, previewed as typed, and the link carries both", () => {
    const p = loadPage();
    p.set("name-template", "{addon.name} {video.channel::upper}");
    fire(p, "name-template", "input");
    expect(p.$("#format-preset").value).toBe("custom");
    expect(rows(p)[0].name).toBe("YouStream CLASSIC FILMS");
    p.set("youtube-key", "k");
    p.submit();
    expect(p.rawGenerated()).toMatchObject({
      nameTemplate: "{addon.name} {video.channel::upper}",
      descriptionTemplate: PRESETS.youstream.description
    });
    expect(p.rawGenerated().format).toBeUndefined();
    expect(p.generated()).toMatchObject({ format: "custom", nameTemplate: "{addon.name} {video.channel::upper}" });
  });

  test("templates edited back into a preset's are that preset again, and blank ones are the default", () => {
    const p = loadPage();
    p.set("name-template", PRESETS.compact.name);
    p.set("description-template", PRESETS.compact.description);
    fire(p, "description-template", "input");
    expect(p.$("#format-preset").value).toBe("compact");
    p.set("name-template", " ");
    p.set("description-template", "");
    fire(p, "name-template", "input");
    expect(p.$("#format-preset").value).toBe("youstream");
    expect(rows(p)[0].name).toBe("▶️ YouStream HD");
    p.set("youtube-key", "k");
    p.submit();
    expect(p.rawGenerated()).toEqual({ youtubeKey: "k", playback: ["app", "youtube"], playbackVersion: 1, region: "US", search: true });
  });

  test("the episode tab previews an episode", () => {
    const p = loadPage();
    p.click('.preview-tab[data-sample="episode"]');
    expect(p.$('.preview-tab[data-sample="episode"]').getAttribute("aria-pressed")).toBe("true");
    expect(p.$('.preview-tab[data-sample="film"]').getAttribute("aria-pressed")).toBe("false");
    expect(rows(p)[0].description.split("\n")[0]).toBe("📡 Example Show (2019) • S01E03 • The Exam");
  });

  test("the preview follows the ways of watching: switched off, moved, or none at all", () => {
    const p = loadPage();
    const option = (id) => p.$(`.pb-option[data-option="${id}"]`);
    option("smarttube").querySelector(".pb-on").checked = true;
    option("smarttube").querySelector(".pb-on").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    expect(rows(p).map((r) => r.name)).toEqual(["▶️ YouStream HD", "📱 YouStream HD", "📺 YouStream HD"]);
    p.click(option("smarttube").querySelector(".pb-up"));
    expect(rows(p).map((r) => r.name)).toEqual(["▶️ YouStream HD", "📺 YouStream HD", "📱 YouStream HD"]);
    ["app", "youtube", "smarttube"].forEach((id) => {
      option(id).querySelector(".pb-on").checked = false;
      option(id).querySelector(".pb-on").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    });
    expect(rows(p).map((r) => r.name)).toEqual(["▶️ YouStream HD"]);
  });

  test("what AIOStreams would misread is pointed out, and so is an unknown field", () => {
    const p = loadPage();
    p.set("name-template", "YouStream EN");
    p.set("description-template", "👤 {stream.foo}");
    fire(p, "description-template", "input");
    expect(rows(p)[0].description).toBe("👤 {unknown_propertyName(stream.foo)}");
    expect(warnings(p)).toEqual([
      "A field or modifier in these templates is unknown: the preview shows it in braces, as your app would.",
      "AIOStreams reads “EN” in a stream's name as a debrid service, and would take these YouTube rows for debrid streams.",
      "AIOStreams reads a number after 👤 or 👥 in the description as torrent seeders."
    ]);
    p.set("description-template", '{video.title["a"||"b"]}');
    fire(p, "description-template", "input");
    expect(warnings(p)[0]).toMatch(/unknown/);
  });

  test("a template longer than the link can carry is refused", () => {
    const p = loadPage();
    p.set("youtube-key", "k");
    p.set("name-template", "x".repeat(301));
    p.submit();
    expect(p.error()).toBe("The stream name can be 300 characters long and the description 1500.");
    p.set("name-template", "x");
    p.set("description-template", "y".repeat(1501));
    p.submit();
    expect(p.error()).toBe("The stream name can be 300 characters long and the description 1500.");
  });

  test("reconfiguring shows the saved templates, the reader's own or a preset", () => {
    const own = loadPage({ existing: normalizeConfig({ youtubeKey: "k", nameTemplate: "N <b>", descriptionTemplate: "D & {video.title}" }) });
    expect(own.$("#format-preset").value).toBe("custom");
    expect(own.$("#name-template").value).toBe("N <b>");
    expect(own.$("#description-template").value).toBe("D & {video.title}");
    expect(rows(own)[0]).toEqual({ name: "N <b>", description: "D & Example Film (1968) | Full Movie | Restored" });
    const preset = loadPage({ existing: normalizeConfig({ youtubeKey: "k", format: "classic" }) });
    expect(preset.$("#format-preset").value).toBe("classic");
    expect(rows(preset)[0].name).toBe("YouStream\n720p");
  });

  test("the fields are listed, with the syntax a link away", () => {
    const p = loadPage();
    const fields = [...p.document.querySelectorAll(".fields-help code")].map((c) => c.textContent);
    expect(fields).toEqual(expect.arrayContaining(["{video.title}", "{stream.filename}", "{play.icon}", "{addon.name}"]));
    expect(p.$(".format a").href).toBe("https://docs.aiostreams.viren070.me/reference/custom-formatter");
  });
});

const CHANNEL = "UCBJycsmduvYEL83R_U4JriQ";
const names = (p) => [...p.document.querySelectorAll("#catalog-list .cat-name")].map((n) => n.textContent);
const kinds = (p) => [...p.document.querySelectorAll("#catalog-list .cat-row")].map((r) => r.getAttribute("data-kind"));
const chips = (p) => [...p.document.querySelectorAll("#trending-chips button")].map((b) => b.textContent);
const note = (p) => p.$("#catalog-note").textContent;
const type = (p, text) => p.set("catalog-input", text);
const add = (p, text) => {
  type(p, text);
  p.click("#catalog-add");
};
const press = (p, key) => p.$("#catalog-input").dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const pick = (p, select, value) => {
  select.value = value;
  select.dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
};
const lookups = (answer) =>
  jest.fn(async (url, init) => {
    if (url === "/api/check-keys") return { json: async () => ({ youtube: "ok", tmdb: "absent" }) };
    const reply = typeof answer === "function" ? answer(JSON.parse(init.body)) : answer;
    if (reply instanceof Error) throw reply;
    return { json: async () => reply };
  });

describe("the YouTube card", () => {

  test("a new setup starts with search on and no catalogs; reconfiguring shows the reader's own, exactly", () => {
    const fresh = loadPage();
    expect(names(fresh)).toEqual([]);
    expect(fresh.$(".cat-empty").textContent).toBe("No catalogs yet. Add a search, a channel, a playlist or a Trending row below.");
    expect(fresh.$("#yt-search").checked).toBe(true);
    const existing = normalizeConfig({
      youtubeKey: "k",
      search: true,
      catalogs: [{ channel: CHANNEL, name: "Marques Brownlee", show: "shorts", sort: "viewCount" }, { q: "lofi", sort: "date" }]
    });
    const p = loadPage({ existing });
    expect(names(p)).toEqual(["Marques Brownlee · Shorts · Most viewed", "lofi · Newest"]);
    expect(kinds(p)).toEqual(["channel", "search"]);
    expect(p.$("#yt-search").checked).toBe(true);
    // An addon installed before search and catalogs existed, as it was.
    const old = loadPage({ existing: normalizeConfig({ youtubeKey: "k" }) });
    expect(names(old)).toEqual([]);
    expect(old.$("#yt-search").checked).toBe(false);
  });

  test("a search is added as typed, by the button or by Enter, and never twice", () => {
    const p = loadPage();
    add(p, "  lofi   hip hop ");
    type(p, "documentaries");
    press(p, "Enter");
    press(p, "a");
    expect(names(p)).toEqual(["lofi hip hop", "documentaries"]);
    expect(p.$("#catalog-input").value).toBe("");
    add(p, "LOFI HIP HOP");
    expect(note(p)).toBe("You already have that catalog.");
    expect(p.$("#catalog-note").className).toContain("note-warn");
    add(p, "   ");
    expect(names(p)).toHaveLength(2);
    add(p, "x".repeat(101));
    expect(note(p)).toBe("A search can be at most 100 characters long.");
  });

  test("a channel or playlist link is looked up with the reader's key", async () => {
    const fetch = lookups((body) =>
      body.input.indexOf("@") === 0
        ? { entry: { kind: "channel", id: `channel.${CHANNEL}.videos`, name: "Marques Brownlee", title: "Marques Brownlee", channel: CHANNEL, show: "videos", sort: "date" } }
        : { entry: { kind: "playlist", id: "playlist.PLBCF2DAC6FFB574DE", name: "Stories", title: "Stories", playlist: "PLBCF2DAC6FFB574DE" } }
    );
    const p = loadPage({ fetch });
    p.set("youtube-key", " AIzaKey ");
    add(p, "@mkbhd");
    expect(note(p)).toBe("Looking it up...");
    expect(p.$("#catalog-add").disabled).toBe(true);
    await flush();
    expect(p.$("#catalog-add").disabled).toBe(false);
    add(p, "https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE");
    await flush();
    expect(names(p)).toEqual(["Marques Brownlee", "Stories"]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ youtubeKey: "AIzaKey", input: "@mkbhd" });
    expect(fetch.mock.calls[0][0]).toBe("/api/youtube-source");
  });

  test.each([
    [CHANNEL],
    ["PLBCF2DAC6FFB574DE"],
    ["OLAK5uy_kVr2k8bnUgIoA0xDoGd5OaVg2JqHBO4vY"],
    ["youtu.be/abcdefghijk"]
  ])("%s is sent to be looked up", async (text) => {
    const fetch = lookups({ error: "no" });
    const p = loadPage({ fetch });
    p.set("youtube-key", "k");
    add(p, text);
    await flush();
    expect(fetch).toHaveBeenCalled();
  });

  test.each([["PLAYSTATION5"], ["UCLA basketball"], ["UC"]])("%s is a search, with no lookup", (text) => {
    const fetch = lookups({});
    const p = loadPage({ fetch });
    p.set("youtube-key", "k");
    add(p, text);
    expect(fetch).not.toHaveBeenCalled();
    expect(names(p)).toContain(text);
  });

  test("what the server finds is no link is added as a search; what it cannot find, or cannot reach, is said", async () => {
    let answer = { search: true };
    const p = loadPage({ fetch: lookups(() => answer) });
    p.set("youtube-key", "k");
    add(p, "PLAYSTATIONPORTALREVIEW");
    await flush();
    expect(names(p)).toContain("PLAYSTATIONPORTALREVIEW");
    answer = { error: "YouTube has no channel at that link." };
    add(p, "@nobody");
    await flush();
    expect(note(p)).toBe("YouTube has no channel at that link.");
    answer = {};
    add(p, "@nobody");
    await flush();
    expect(note(p)).toBe("That could not be looked up.");
    answer = new Error("offline");
    add(p, "@nobody");
    await flush();
    expect(note(p)).toContain("could not be looked up");
    expect(p.$("#catalog-add").disabled).toBe(false);
  });

  test("a link needs the key first, and a browser that can ask", () => {
    const p = loadPage({ fetch: lookups({}) });
    add(p, "@mkbhd");
    expect(note(p)).toContain("Enter your YouTube API key above first");
    const old = loadPage();
    delete old.dom.window.fetch;
    old.set("youtube-key", "k");
    add(old, "@mkbhd");
    expect(note(old)).toBe("This browser cannot look links up.");
  });

  test("Trending rows are offered as chips until each is added", () => {
    const p = loadPage();
    expect(chips(p).slice(0, 2)).toEqual(["+ Trending", "+ Music"]);
    p.click([...p.document.querySelectorAll("#trending-chips button")].find((b) => b.textContent === "+ Music"));
    expect(names(p)).toEqual(["Trending Music"]);
    expect(p.$("#catalog-list .cat-fixed").textContent).toBe("Ranked by YouTube, for your country");
    expect(chips(p)).not.toContain("+ Music");
    while (p.document.querySelector("#trending-chips button")) p.click("#trending-chips button");
    expect(p.$("#trending-chips").textContent).toBe("Every Trending row is added.");
  });

  test("rows move and go, and the arrows know the ends", () => {
    const p = loadPage();
    add(p, "one");
    add(p, "two");
    add(p, "three");
    const row = (i) => p.document.querySelectorAll("#catalog-list .cat-row")[i];
    expect(row(0).querySelector(".cat-up").disabled).toBe(true);
    expect(row(0).querySelector(".cat-down").disabled).toBe(false);
    expect(row(2).querySelector(".cat-down").disabled).toBe(true);
    expect(row(0).querySelector(".cat-up").getAttribute("aria-label")).toBe("Move one up");
    p.click(row(2).querySelector(".cat-up"));
    expect(names(p)).toEqual(["one", "three", "two"]);
    p.click(row(0).querySelector(".cat-down"));
    expect(names(p)).toEqual(["three", "one", "two"]);
    p.click(row(0).querySelector(".cat-up"));
    p.click(row(2).querySelector(".cat-down"));
    expect(names(p)).toEqual(["three", "one", "two"]);
    p.click(row(1).querySelector(".remove"));
    expect(names(p)).toEqual(["three", "two"]);
    expect(p.$("#catalog-list .cat-rank").textContent).toBe("1");
    expect(row(1).querySelector(".cat-rank").textContent).toBe("2");
    p.set("youtube-key", "k");
    p.submit();
    expect(p.rawGenerated().catalogs).toEqual([{ q: "three" }, { q: "two" }]);
    p.click(row(0).querySelector(".remove"));
    p.click(row(0).querySelector(".remove"));
    expect(p.$(".cat-empty")).not.toBeNull();
  });

  test("a search row's order, length and date, and a channel row's videos and order, are saved compactly", () => {
    const existing = normalizeConfig({ youtubeKey: "k", catalogs: [{ channel: CHANNEL, name: "MKBHD" }, { playlist: "PLBCF2DAC6FFB574DE", name: "Stories" }] });
    const p = loadPage({ existing });
    add(p, "news");
    const selects = (i) => p.document.querySelectorAll("#catalog-list .cat-row")[i].querySelectorAll("select");
    const labels = (i) => [...selects(i)].map((select) => [...select.options].map((o) => o.textContent));
    expect(labels(0)).toEqual([["Videos", "Shorts", "Live streams", "Everything"], ["Newest", "Most viewed"]]);
    expect(labels(2)[0]).toEqual(["Most relevant", "Newest", "Most viewed", "Top rated"]);
    pick(p, selects(2)[0], "date");
    pick(p, selects(2)[1], "medium");
    pick(p, selects(2)[2], "day");
    pick(p, selects(0)[0], "live");
    pick(p, selects(0)[1], "viewCount");
    expect(names(p)).toEqual(["MKBHD · Live · Most viewed", "Stories", "news · Newest · 4–20 min · Today"]);
    expect(selects(1)).toHaveLength(0);
    expect(p.document.querySelectorAll("#catalog-list .cat-row")[1].querySelector(".cat-fixed").textContent).toBe("In the playlist's own order");
    p.submit();
    expect(p.rawGenerated().catalogs).toEqual([
      { channel: CHANNEL, name: "MKBHD", show: "live", sort: "viewCount" },
      { playlist: "PLBCF2DAC6FFB574DE", name: "Stories" },
      { q: "news", sort: "date", length: "medium", within: "day" }
    ]);
    expect(p.generated().catalogs.map((c) => c.name)).toEqual(names(p));
  });

  test("an option that would make a row repeat another is put back", () => {
    const existing = normalizeConfig({ youtubeKey: "k", catalogs: [{ channel: CHANNEL, name: "MKBHD" }, { channel: CHANNEL, name: "MKBHD", sort: "viewCount" }] });
    const p = loadPage({ existing });
    const select = (row, i) => p.document.querySelectorAll("#catalog-list .cat-row")[row].querySelectorAll("select")[i];
    add(p, "news");
    add(p, "NEWS");
    expect(note(p)).toBe("You already have that catalog.");
    p.click("#trending-chips button");
    pick(p, select(2, 0), "date");
    add(p, "news");
    expect(names(p)).toEqual(["MKBHD", "MKBHD · Most viewed", "news · Newest", "Trending", "news"]);
    const sort = select(4, 0);
    pick(p, sort, "date");
    expect(sort.value).toBe("relevance");
    expect(note(p)).toBe("You already have that catalog.");
    pick(p, sort, "rating");
    expect(note(p)).toBe("");
    expect(names(p)[4]).toBe("news · Top rated");
    // A channel's order, too.
    pick(p, select(1, 1), "date");
    expect(select(1, 1).value).toBe("viewCount");
    expect(note(p)).toBe("You already have that catalog.");
  });

  test("at most twenty catalogs", () => {
    const p = loadPage();
    for (let i = 1; i <= 20; i++) add(p, `search ${i}`);
    expect(names(p)).toHaveLength(20);
    add(p, "one more");
    expect(note(p)).toBe("You can have at most 20 catalogs.");
    expect(names(p)).toHaveLength(20);
  });

  test("how much of the day's searches the search catalogs could spend", () => {
    const p = loadPage();
    const fire = (id, event) => p.$(`#${id}`).dispatchEvent(new p.dom.window.Event(event, { bubbles: true }));
    expect(p.$("#quota-note").textContent).toBe("");
    add(p, "news");
    expect(p.$("#quota-note").textContent).toBe("Shown all day, your search catalogs would spend at most 12 of your 100 daily searches.");
    add(p, "lofi");
    p.set("refresh-value", "30");
    p.set("refresh-unit", "m");
    fire("refresh-unit", "change");
    expect(p.$("#quota-note").textContent).toBe("Shown all day, your search catalogs would spend at most 96 of your 100 daily searches.");
    add(p, "music");
    expect(p.$("#quota-note").className).toBe("note-warn");
    expect(p.$("#quota-note").textContent).toContain("all 100 of your daily searches");
    p.set("refresh-value", "15");
    fire("refresh-value", "input");
    expect(p.$("#quota-note").textContent).toBe("");
  });

  test("search: off, or ranked and limited as the reader chose, and SafeSearch, stored only when changed", () => {
    const p = loadPage();
    p.set("youtube-key", "k");
    p.set("search-sort", "date");
    p.set("search-length", "long");
    p.set("safe-search", "strict");
    p.set("refresh-value", "3");
    p.check("yt-search", false);
    p.$("#yt-search").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    expect(p.$("#search-sort").disabled).toBe(true);
    p.submit();
    expect(p.rawGenerated()).toMatchObject({ searchSort: "date", searchLength: "long", safeSearch: "strict", catalogRefresh: "3h" });
    expect(p.rawGenerated()).not.toHaveProperty("search");
    p.check("yt-search", true);
    p.$("#yt-search").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    expect(p.$("#search-length").disabled).toBe(false);
    p.submit();
    expect(p.rawGenerated().search).toBe(true);
  });

  test("films and shows can both be off when YouTube is used", () => {
    const p = loadPage();
    p.set("youtube-key", "k");
    p.check("type-movie", false);
    p.check("type-series", false);
    p.submit();
    expect(p.error()).toBeNull();
    expect(p.rawGenerated().types).toEqual([]);
    expect(p.generated().types).toEqual([]);
  });

  test("reconfiguring shows every YouTube setting as saved", () => {
    const existing = normalizeConfig({ youtubeKey: "k", search: false, searchSort: "rating", searchLength: "short", safeSearch: "none", catalogRefresh: "45m" });
    const p = loadPage({ existing });
    expect(p.$("#yt-search").checked).toBe(false);
    expect(p.$("#search-sort").value).toBe("rating");
    expect(p.$("#search-length").value).toBe("short");
    expect(p.$("#safe-search").value).toBe("none");
    expect(p.$("#refresh-value").value).toBe("45");
    expect(p.$("#refresh-unit").value).toBe("m");
    p.submit();
    expect(p.rawGenerated()).toMatchObject({ searchSort: "rating", searchLength: "short", safeSearch: "none", catalogRefresh: "45m" });
    expect(p.rawGenerated()).not.toHaveProperty("search");
    expect(p.rawGenerated().catalogs).toBeUndefined();
  });

  test("the YouTube video tab previews a video opened from a catalog", () => {
    const p = loadPage();
    p.click('.preview-tab[data-sample="video"]');
    const first = p.document.querySelector("#format-preview li .p-desc").textContent.split("\n")[0];
    expect(first).toBe("🎬 How Example Engines Work");
  });
});

describe("editing an installed addon", () => {
  /**
   * Install links exactly as 0.6.0's configure page built them, before
   * search and catalogs existed. The keys are made up.
   */
  const OLD_LINKS = {
    "a key alone":
      "%7B%22youtubeKey%22%3A%22AIzaReaderKey_1%22%2C%22playback%22%3A%5B%22app%22%2C%22youtube%22%5D%2C%22playbackVersion%22%3A1%2C%22region%22%3A%22US%22%7D",
    "every setting of its day changed":
      "%7B%22youtubeKey%22%3A%22AIzaReaderKey_2%22%2C%22tmdbKey%22%3A%22eyJtoken.part-2%22%2C%22movieMargin%22%3A%2212.5%25%22%2C%22episodeMargin%22%3A%2260s%22%2C%22typicalMargin%22%3A%223m%22%2C%22playback%22%3A%5B%22app%22%2C%22smarttube%22%5D%2C%22playbackVersion%22%3A1%2C%22types%22%3A%5B%22series%22%5D%2C%22maxResults%22%3A8%2C%22minViews%22%3A0%2C%22region%22%3A%22IN%22%2C%22audioLanguage%22%3A%22hi%22%2C%22embeddableOnly%22%3Atrue%2C%22officialOnly%22%3Atrue%2C%22movieQuery%22%3A%22%7Btitle%7D%20film%22%2C%22episodeQuery%22%3A%22%7Btitle%7D%20%7Bs00e00%7D%22%2C%22nameTemplate%22%3A%22YouStream%20%7Bvideo.definition%7D%22%2C%22descriptionTemplate%22%3A%22%7Bvideo.title%7D%5Cn%7Bvideo.channel%7D%22%2C%22exclude%22%3A%5B%22trailer%22%2C%22reaction%22%5D%2C%22excludeDescription%22%3A%5B%22fan%20movie%22%5D%7D",
    "a preset, one type and any country":
      "%7B%22youtubeKey%22%3A%22AIzaReaderKey_3%22%2C%22playback%22%3A%5B%22app%22%2C%22youtube%22%5D%2C%22playbackVersion%22%3A1%2C%22types%22%3A%5B%22movie%22%5D%2C%22format%22%3A%22compact%22%7D"
  };
  const segmentOf = (p) => p.$("#manifest-url").value.slice(BASE.length + 1, -"/manifest.json".length);

  test.each(Object.entries(OLD_LINKS))("an addon installed before search and catalogs, %s, comes back as the very same link", (_, segment) => {
    const p = loadPage({ existing: decodeConfig(segment) });
    expect(p.errors).toEqual([]);
    expect(p.$("#yt-search").checked).toBe(false);
    expect(names(p)).toEqual([]);
    p.submit();
    expect(p.error()).toBeNull();
    expect(segmentOf(p)).toBe(segment);
  });

  test("every setting changed, YouTube's too, is shown as saved and comes back as the very same link", async () => {
    const fetch = lookups((body) =>
      body.input.indexOf("@") === 0
        ? { entry: { kind: "channel", id: `channel.${CHANNEL}.videos`, name: "Marques Brownlee", title: "Marques Brownlee", channel: CHANNEL, show: "videos", sort: "date" } }
        : { entry: { kind: "playlist", id: "playlist.PLBCF2DAC6FFB574DE", name: "Stories", title: "Stories", playlist: "PLBCF2DAC6FFB574DE" } }
    );
    const first = loadPage({ fetch });
    first.set("youtube-key", "AIzaReaderKey_4");
    first.set("tmdb-key", "eyJtoken.part-2");
    first.check("type-movie", false);
    first.$('[data-margin="movieMargin"] .margin-value').value = "12.5";
    first.$('[data-margin="movieMargin"] .margin-unit').value = "%";
    first.$('[data-margin="typicalMargin"] .margin-value').value = "3";
    first.$('[data-margin="typicalMargin"] .margin-unit').value = "m";
    const pbRows = () => [...first.document.querySelectorAll(".pb-option")];
    first.click(pbRows()[2].querySelector(".pb-up"));
    pbRows().forEach((row) => (row.querySelector(".pb-on").checked = true));
    first.set("max-results", "8");
    first.set("min-views", "250");
    first.set("region", "GB");
    first.set("audio-language", "en");
    first.check("embeddable-only", true);
    first.set("exclude", "trailer, reaction");
    first.set("episode-query", "{title} {s00e00}");
    first.set("name-template", "YouStream {video.definition}");
    first.set("description-template", "{video.title}");
    first.set("search-sort", "viewCount");
    first.set("search-length", "long");
    first.set("safe-search", "strict");
    first.set("refresh-value", "1.5");
    first.set("refresh-unit", "d");
    add(first, "lofi hip hop");
    add(first, "@mkbhd");
    await flush();
    add(first, "https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE");
    await flush();
    first.click([...first.document.querySelectorAll("#trending-chips button")].find((b) => b.textContent === "+ Music"));
    const selects = (p, row) => p.document.querySelectorAll("#catalog-list .cat-row")[row].querySelectorAll("select");
    pick(first, selects(first, 0)[0], "date");
    pick(first, selects(first, 0)[2], "week");
    pick(first, selects(first, 1)[0], "shorts");
    pick(first, selects(first, 1)[1], "viewCount");
    first.click(first.document.querySelectorAll("#catalog-list .cat-up")[3]);
    first.submit();
    await flush();
    expect(first.error()).toBeNull();
    const segment = segmentOf(first);
    expect(JSON.parse(decodeURIComponent(segment))).toMatchObject({
      typicalMargin: "3m",
      playback: ["app", "smarttube", "youtube"],
      search: true,
      searchSort: "viewCount",
      safeSearch: "strict",
      catalogs: [
        { q: "lofi hip hop", sort: "date", within: "week" },
        { channel: CHANNEL, name: "Marques Brownlee", show: "shorts", sort: "viewCount" },
        { trending: "music" },
        { playlist: "PLBCF2DAC6FFB574DE", name: "Stories" }
      ],
      catalogRefresh: "1.5d"
    });

    // Opened again from the app, as the server decodes the link.
    const again = loadPage({ existing: decodeConfig(segment), fetch });
    expect(again.errors).toEqual([]);
    expect(again.$("#youtube-key").value).toBe("AIzaReaderKey_4");
    expect(again.$("#tmdb-key").value).toBe("eyJtoken.part-2");
    expect(again.$("#type-movie").checked).toBe(false);
    expect(again.$('[data-margin="typicalMargin"] .margin-unit').value).toBe("m");
    expect(again.playbackOrder()).toEqual(["app", "smarttube", "youtube"]);
    expect(again.$("#region").value).toBe("GB");
    expect(again.$("#name-template").value).toBe("YouStream {video.definition}");
    expect(again.$("#yt-search").checked).toBe(true);
    expect(again.$("#search-sort").value).toBe("viewCount");
    expect(again.$("#safe-search").value).toBe("strict");
    expect([again.$("#refresh-value").value, again.$("#refresh-unit").value]).toEqual(["1.5", "d"]);
    expect(names(again)).toEqual(names(first));
    expect([...selects(again, 1)].map((select) => select.value)).toEqual(["shorts", "viewCount"]);
    again.submit();
    await flush();
    expect(again.error()).toBeNull();
    expect(segmentOf(again)).toBe(segment);
  });
});

test("a channel or playlist name from YouTube is text on the page, never markup", () => {
  const hostile = "</script><img src=x onerror=alert(1)><b>bold</b>";
  const existing = normalizeConfig({ youtubeKey: "k", catalogs: [{ channel: "UCBJycsmduvYEL83R_U4JriQ", name: hostile }] });
  const p = loadPage({ existing });
  expect(p.errors).toEqual([]);
  expect(p.document.querySelector("#catalog-list b")).toBeNull();
  expect(p.document.querySelector("img[src=x]")).toBeNull();
  expect(p.$("#catalog-list .cat-name").textContent).toBe(hostile);
});
