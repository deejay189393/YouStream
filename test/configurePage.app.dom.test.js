/**
 * The configure page as an app: its tabs and the address that picks one,
 * the bars along the bottom, problems that open the tab and the field to
 * fix, the summary that follows every change, and the corners of the
 * script the other page tests leave alone. The script is loaded through
 * Jest and started on each window, so coverage measures it.
 */
const { JSDOM, VirtualConsole } = require("jsdom");
const { renderConfigurePage } = require("../src/configurePage");
const startPage = require("../src/web/configure");
const { createFormatter } = require("../src/formatter");
const { templateWarnings } = require("../src/templateCheck");
const { normalizeConfig } = require("../src/config");

const BASE = "https://youstream.example";
const ID = "3b84d0e4-1e9d-4508-b9c4-46c8125f335f";
const SIGNED_IN = { enabled: true, signedIn: { id: ID, installUrl: `${BASE}/${ID}.token/manifest.json`, remembered: true } };

const windows = [];
afterEach(() => {
  while (windows.length) windows.pop().close();
});

/** Answers the API from `routes`, keyed "METHOD /path"; check-keys says the keys are fine unless told otherwise. */
function api(routes = {}) {
  return jest.fn(async (url, init = {}) => {
    const key = `${init.method} ${url}`;
    const reply = routes[key] || (url === "/api/check-keys" ? { body: { youtube: "ok", tmdb: "absent" } } : null);
    if (!reply) throw new TypeError("Failed to fetch");
    const { status = 200, body = {} } = reply;
    return { ok: status < 300, status, json: async () => body };
  });
}

function open({ existing = null, profile = {}, path = "/configure", hooks = { navigate() {} }, fetch, language = "en-US", before = () => {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => errors.push(err.message));
  const dom = new JSDOM(renderConfigurePage({ baseUrl: BASE, existing, profile }), {
    url: BASE + path,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
      if (fetch) window.fetch = fetch;
      before(window);
    }
  });
  windows.push(dom.window);
  const { window } = dom;
  const { document } = window;
  Object.assign(window, { createFormatter, templateWarnings });
  startPage(window, hooks);
  const $ = (sel) => document.querySelector(sel);
  const fire = (el, type) => (typeof el === "string" ? $(el) : el).dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return {
    window,
    document,
    $,
    errors,
    fire,
    set: (id, value) => ($(`#${id}`).value = value),
    check: (id, on) => ($(`#${id}`).checked = on),
    submit: () => fire("#config-form", "submit"),
    tab: () => $(".panel:not([hidden])").getAttribute("data-tab"),
    marked: () => $('.tab[aria-current="page"]').getAttribute("data-tab"),
    focused: () => document.activeElement.id,
    error: () => ($("#error").style.display === "none" ? null : $("#error").textContent),
    summary: () =>
      Object.fromEntries(
        [...document.querySelectorAll("#summary-list .summary-row")].map((row) => [row.querySelector(".s-name").textContent, row.querySelector(".s-value").textContent])
      )
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Opens a tab as a reader does: by its link in the bar. */
async function tapTab(p, id) {
  p.$(`.tab[data-tab="${id}"]`).click();
  await settle();
}

describe("tabs", () => {
  test("it opens on the summary, its tab marked, every other panel hidden", () => {
    const p = open();
    expect(p.tab()).toBe("summary");
    expect(p.marked()).toBe("summary");
    expect([...p.document.querySelectorAll(".panel")].filter((panel) => !panel.hidden)).toHaveLength(1);
  });

  test("a tab's link opens its panel and marks it; back goes back", async () => {
    const p = open();
    await tapTab(p, "catalogs");
    expect([p.tab(), p.marked(), p.window.location.hash]).toEqual(["catalogs", "catalogs", "#catalogs"]);
    await tapTab(p, "streams");
    expect(p.tab()).toBe("streams");
    p.window.history.back();
    await settle();
    expect(p.tab()).toBe("catalogs");
  });

  test("opened at a tab's address it starts there; at any other, on the summary", () => {
    expect(open({ path: "/configure#account" }).tab()).toBe("account");
    expect(open({ path: "/configure#nothing" }).tab()).toBe("summary");
  });

  test("each of the summary's lines opens the tab it is about", () => {
    const p = open();
    expect([...p.document.querySelectorAll("#summary-list .summary-row")].map((row) => row.getAttribute("href"))).toEqual([
      "#search",
      "#search",
      "#catalogs",
      "#streams",
      "#streams",
      "#search"
    ]);
  });
});

describe("the bars along the bottom", () => {
  test("a new setup: away from the summary, a bar leads back to finish it", async () => {
    const p = open();
    expect(p.$("#finish-bar").hidden).toBe(true);
    await tapTab(p, "search");
    expect(p.$("#finish-bar").hidden).toBe(false);
    p.$("#finish-go").click();
    expect([p.tab(), p.focused()]).toEqual(["summary", "submit-btn"]);
    expect(p.$("#finish-bar").hidden).toBe(true);
  });

  test("a profile has the save bar instead, shown only with changes to save", () => {
    const p = open({ profile: SIGNED_IN, existing: normalizeConfig({ youtubeKey: "k" }) });
    expect(p.$("#finish-bar")).toBeNull();
    expect(p.$("#save-bar").hidden).toBe(true);
    p.check("type-series", false);
    p.fire("#type-series", "change");
    expect(p.$("#save-bar").hidden).toBe(false);
  });
});

describe("a problem opens the tab, and the field, to fix", () => {
  test("no key: the summary, in the key box", async () => {
    const p = open();
    await tapTab(p, "streams");
    p.submit();
    expect(p.error()).toBe("Enter your YouTube API key.");
    expect([p.tab(), p.focused()]).toEqual(["summary", "youtube-key"]);
  });

  test("a margin: the search tab, in that margin", () => {
    const p = open();
    p.set("youtube-key", "k");
    p.set("margin-episodeMargin", "lots");
    p.submit();
    expect(p.error()).toBe("Episodes: enter the margin as a number, 0 or more.");
    expect([p.tab(), p.focused()]).toEqual(["search", "margin-episodeMargin"]);
  });

  test("a search without {title}: the fine-tuning fold opened", () => {
    const p = open();
    p.set("youtube-key", "k");
    p.set("episode-query", "{year} episode");
    expect(p.$("#fine-tuning").open).toBe(false);
    p.submit();
    expect(p.error()).toBe("Both searches need {title} in them.");
    expect([p.tab(), p.focused(), p.$("#fine-tuning").open]).toEqual(["search", "episode-query", true]);
  });

  test("no way to watch: the streams tab, at the first one", () => {
    const p = open();
    p.set("youtube-key", "k");
    p.document.querySelectorAll(".pb-on").forEach((box) => (box.checked = false));
    p.submit();
    expect(p.error()).toBe("Turn on at least one way to watch.");
    expect([p.tab(), p.focused()]).toEqual(["streams", "pb-on-app"]);
  });

  test("too long a stream name: the streams tab, in the name", () => {
    const p = open();
    p.set("youtube-key", "k");
    p.set("name-template", "x".repeat(5000));
    p.submit();
    expect(p.error()).toMatch(/^The stream name can be \d+ characters long/);
    expect([p.tab(), p.focused()]).toEqual(["streams", "name-template"]);
  });

  test("too short a refresh: the catalogs tab", () => {
    const p = open();
    p.set("youtube-key", "k");
    p.set("refresh-value", "0.25");
    p.submit();
    expect(p.error()).toBe("Refresh catalogs every: at least 30 minutes.");
    expect([p.tab(), p.focused()]).toEqual(["catalogs", "refresh-value"]);
  });

  test("the terms unticked, and a password too short, a profile's own", async () => {
    const p = open({ profile: { enabled: true } });
    p.set("youtube-key", "k");
    await tapTab(p, "account");
    p.submit();
    expect([p.tab(), p.focused()]).toEqual(["summary", "agree"]);
    p.check("agree", true);
    p.set("create-password", "short");
    p.submit();
    expect(p.focused()).toBe("create-password");
    p.set("create-password", "long enough");
    p.set("create-password2", "not the same");
    p.submit();
    expect([p.error(), p.focused()]).toEqual(["The two passwords are not the same.", "create-password2"]);
  });

  test("keys the server turns down: the box of the one at fault", async () => {
    const youtube = open({ fetch: api({ "POST /api/check-keys": { body: { youtube: "invalid" } } }) });
    youtube.set("youtube-key", "k");
    youtube.check("agree", true);
    youtube.submit();
    await settle();
    expect(youtube.focused()).toBe("youtube-key");
    const tmdb = open({ fetch: api({ "POST /api/check-keys": { body: { youtube: "ok", tmdb: "invalid" } } }) });
    tmdb.set("youtube-key", "k");
    tmdb.set("tmdb-key", "t");
    tmdb.check("agree", true);
    await tapTab(tmdb, "catalogs");
    tmdb.submit();
    await settle();
    expect([tmdb.tab(), tmdb.focused()]).toEqual(["summary", "tmdb-key"]);
  });

  test("the note goes when tapped", () => {
    const p = open();
    p.submit();
    expect(p.error()).not.toBeNull();
    p.$("#error").click();
    expect(p.error()).toBeNull();
  });
});

describe("the summary", () => {
  test("the setup at a glance", () => {
    expect(open().summary()).toEqual({
      "Looks for": "Movies and series",
      "YouTube search in your app": "On · Most relevant · Any length",
      Catalogs: "None yet",
      "When you press play": "Play in app, then Open in the YouTube app",
      "Stream text": "YouStream",
      "Country and language": "United States · Any language"
    });
  });

  test("follows every change, made anywhere", async () => {
    const p = open();
    const change = (id, value) => {
      const el = p.$(`#${id}`);
      if (typeof value === "boolean") el.checked = value;
      else el.value = value;
      p.fire(el, "change");
    };
    change("type-series", false);
    expect(p.summary()["Looks for"]).toBe("Movies");
    change("type-movie", false);
    change("type-series", true);
    expect(p.summary()["Looks for"]).toBe("Series");
    change("type-series", false);
    expect(p.summary()["Looks for"]).toBe("Neither: YouTube only");
    change("search-sort", "date");
    change("search-length", "long");
    expect(p.summary()["YouTube search in your app"]).toBe("On · Newest · Over 20 minutes");
    change("yt-search", false);
    expect(p.summary()["YouTube search in your app"]).toBe("Off");
    p.set("catalog-input", "lofi");
    p.$("#catalog-add").click();
    expect(p.summary().Catalogs).toBe("1 row: lofi");
    [...p.document.querySelectorAll("#trending-chips button")].find((b) => b.textContent === "+ Music").click();
    expect(p.summary().Catalogs).toBe("2 rows: lofi, Trending Music");
    p.document.querySelectorAll(".pb-on").forEach((box) => change(box.id, false));
    expect(p.summary()["When you press play"]).toBe("Nothing chosen yet");
    change("pb-on-smarttube", true);
    expect(p.summary()["When you press play"]).toBe("Open in SmartTube");
    change("format-preset", "compact");
    expect(p.summary()["Stream text"]).toBe("Compact");
    change("region", "IN");
    change("audio-language", "hi");
    expect(p.summary()["Country and language"]).toBe("India · Hindi");
  });
});

describe("leaving the page", () => {
  test("with no one to tell, the page itself goes", async () => {
    const p = open({
      profile: SIGNED_IN,
      existing: normalizeConfig({ youtubeKey: "k" }),
      hooks: {},
      fetch: api({ "DELETE /api/profile/session": { status: 204 } })
    });
    await tapTab(p, "account");
    p.$("#signout-btn").click();
    p.$("#signout-confirm").click();
    expect(p.window.location.hash).toBe("#account");
    await settle();
    // The address the page went to, as far as jsdom goes there.
    expect(p.window.location.href).toBe(BASE + "/configure");
  });
});

describe("the rest of the script", () => {
  test("a template that comes out empty previews as the addon's name, and the video's title", () => {
    const p = open();
    p.set("name-template", '{video.ageRestricted::istrue["18+"||""]}');
    p.set("description-template", '{video.live::istrue["Live"||""]}');
    p.fire("#name-template", "input");
    const first = p.$("#format-preview li");
    expect(first.querySelector(".p-name").textContent).toBe("YouStream");
    expect(first.querySelector(".p-desc").textContent).toBe("Example Film (1968) | Full Movie | Restored");
  });

  test("a browser with no language guesses no country", () => {
    expect(open({ language: "" }).$("#region").value).toBe("");
  });

  test("the same playlist twice is refused, and a channel's usual options are left out of the link", async () => {
    const playlist = { kind: "playlist", id: "playlist.PL1", playlist: "PLBCF2DAC6FFB574DE", title: "Stories" };
    const channel = { kind: "channel", id: "channel.UC1", channel: "UCBJycsmduvYEL83R_U4JriQ", title: "MKBHD", show: "videos", sort: "date" };
    let answer = playlist;
    const fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (url === "/api/youtube-source" ? { entry: answer } : { youtube: "ok", tmdb: "absent" })
    }));
    const p = open({ fetch });
    p.set("youtube-key", "k");
    p.set("catalog-source", "playlist");
    const add = async (text) => {
      p.set("catalog-input", text);
      p.$("#catalog-add").click();
      await settle();
    };
    await add("PLBCF2DAC6FFB574DE");
    await add("PLBCF2DAC6FFB574DE");
    expect(p.$("#catalog-note").textContent).toBe("You already have that catalog.");
    answer = channel;
    p.set("catalog-source", "channel");
    await add("@mkbhd");
    p.check("agree", true);
    p.submit();
    await settle();
    const url = p.$("#manifest-url").value;
    const config = JSON.parse(decodeURIComponent(url.slice(BASE.length + 1, -"/manifest.json".length)));
    expect(config.catalogs).toEqual([
      { playlist: "PLBCF2DAC6FFB574DE", name: "Stories" },
      { channel: "UCBJycsmduvYEL83R_U4JriQ", name: "MKBHD" }
    ]);
    expect(p.tab()).toBe("summary");
  });

  test("the new link is scrolled to, where the browser can", () => {
    const scrolled = [];
    const p = open({
      before(window) {
        window.HTMLElement.prototype.scrollIntoView = function () {
          scrolled.push(this.id);
        };
      }
    });
    p.set("youtube-key", "k");
    p.check("agree", true);
    p.submit();
    expect(scrolled).toEqual(["result"]);
  });

  test("a profile saved on a spent quota says so, and the note goes when tapped", async () => {
    const p = open({
      profile: SIGNED_IN,
      existing: normalizeConfig({ youtubeKey: "k" }),
      fetch: api({ "POST /api/check-keys": { body: { youtube: "quota", tmdb: "absent" } }, "PUT /api/profile": { body: { manifestChanged: false } } })
    });
    p.submit();
    await settle();
    expect(p.$("#save-status").textContent).toMatch(/^Saved\. No need to reinstall: .* Your key works, but its YouTube quota for today is already spent\./);
    p.$("#save-status").click();
    expect(p.$("#save-status").hidden).toBe(true);
  });

  test("an export lets go of its file a moment later", () => {
    const revoked = [];
    const p = open({
      before(window) {
        window.URL.createObjectURL = () => "blob:youstream/1";
        window.URL.revokeObjectURL = (url) => revoked.push(url);
        window.HTMLAnchorElement.prototype.click = () => {};
        window.setTimeout = (fn) => fn();
      }
    });
    p.$("#export-btn").click();
    expect(revoked).toEqual(["blob:youstream/1"]);
  });

  test("a password manager that will not keep the password holds nothing up", async () => {
    const went = [];
    const p = open({
      profile: { enabled: true },
      hooks: { navigate: (url) => went.push(url) },
      fetch: api({ "POST /api/profile": { status: 201, body: { id: ID } } }),
      before(window) {
        window.PasswordCredential = function (data) {
          Object.assign(this, data);
        };
        Object.defineProperty(window.navigator, "credentials", { value: { store: () => Promise.reject(new Error("refused")) }, configurable: true });
      }
    });
    p.set("youtube-key", "k");
    p.check("agree", true);
    p.set("create-password", "a good password");
    p.set("create-password2", "a good password");
    p.submit();
    await settle();
    expect(went).toEqual(["/configure?done=created"]);
  });

  test("a browser that will not even make the credential holds nothing up", async () => {
    const went = [];
    const p = open({
      profile: { enabled: true },
      hooks: { navigate: (url) => went.push(url) },
      fetch: api({ "POST /api/profile": { status: 201, body: { id: ID } } }),
      before(window) {
        window.PasswordCredential = function () {
          throw new TypeError("not allowed");
        };
        Object.defineProperty(window.navigator, "credentials", { value: { store: jest.fn() }, configurable: true });
      }
    });
    p.set("youtube-key", "k");
    p.check("agree", true);
    p.set("create-password", "a good password");
    p.set("create-password2", "a good password");
    p.submit();
    await settle();
    expect(went).toEqual(["/configure?done=created"]);
    expect(p.window.navigator.credentials.store).not.toHaveBeenCalled();
  });

  test("a service worker that will not register is no matter", async () => {
    const p = open({
      before(window) {
        Object.defineProperty(window.navigator, "serviceWorker", { value: { register: () => Promise.reject(new Error("blocked")) }, configurable: true });
      }
    });
    await settle();
    expect(p.errors).toEqual([]);
  });
});
