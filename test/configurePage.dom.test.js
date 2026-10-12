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
    expect(p.rawGenerated()).toEqual({ youtubeKey: "AIzaKey_1", playback: ["app", "youtube"], playbackVersion: 1, region: "US" });
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
      excludeDescription: ["fan movie"]
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
      "no content type",
      (p) => {
        p.check("type-movie", false);
        p.check("type-series", false);
      },
      "Choose movies, series, or both."
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
