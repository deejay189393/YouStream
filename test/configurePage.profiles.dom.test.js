/**
 * The configure page's profile controls, run in a real DOM with the API
 * answered by a stand-in: creating a profile, saving, signing in and out,
 * the password, the link, deleting, export and import, and the app button.
 */
const { JSDOM, VirtualConsole } = require("jsdom");
const { renderConfigurePage } = require("../src/configurePage");
const startPage = require("../src/web/configure");
const { createFormatter } = require("../src/formatter");
const { templateWarnings } = require("../src/templateCheck");

const BASE = "https://youstream.example";
const ID = "3b84d0e4-1e9d-4508-b9c4-46c8125f335f";
const TOKEN = "nFEm3YBPj-TdEd4E-xFWS-Ffm9Ldl8pkVO0Rfr1oowU";
const INSTALL_URL = `${BASE}/${ID}.${TOKEN}/manifest.json`;
const SIGNED_IN = { enabled: true, signedIn: { id: ID, installUrl: INSTALL_URL, remembered: true } };

const openWindows = [];
afterEach(() => {
  while (openWindows.length) openWindows.pop().close();
});

/** A fetch answering /api/check-keys with good keys, and the API from `routes`. */
function api(routes = {}) {
  return jest.fn(async (url, init = {}) => {
    if (url === "/api/check-keys") return { ok: true, status: 200, json: async () => ({ youtube: "ok", tmdb: "absent" }) };
    const key = `${init.method} ${url}`;
    const reply = routes[key];
    if (!reply) throw new TypeError("Failed to fetch");
    const { status = 200, body = {} } = typeof reply === "function" ? reply(JSON.parse(init.body)) : reply;
    return { ok: status < 300, status, json: async () => (body === null ? Promise.reject(new SyntaxError("no json")) : body) };
  });
}

function loadPage({ profile = { enabled: true }, existing = null, fetch = api(), path = "/configure", before = () => {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => errors.push(err));
  const submitted = [];
  const downloads = [];
  const dom = new JSDOM(renderConfigurePage({ baseUrl: BASE, existing, profile }), {
    url: BASE + path,
    virtualConsole,
    beforeParse(window) {
      window.fetch = fetch;
      window.HTMLFormElement.prototype.submit = function () {
        submitted.push({ action: this.action, method: this.method, fields: Object.fromEntries(new window.FormData(this)) });
      };
      window.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ name: this.download, href: this.href });
      };
      window.URL.createObjectURL = (blob) => {
        downloads.blob = blob;
        return "blob:youstream/1";
      };
      window.URL.revokeObjectURL = () => {};
      before(window);
    }
  });
  openWindows.push(dom.window);
  const { window } = dom;
  const { document } = window;
  const $ = (sel) => document.querySelector(sel);
  // Leaving the page: jsdom cannot follow, so where it went is recorded.
  const went = [];
  window.createFormatter = createFormatter;
  window.templateWarnings = templateWarnings;
  startPage(window, { navigate: (url) => went.push(url) });
  const fire = (el, type, Kind = window.Event) => (typeof el === "string" ? $(el) : el).dispatchEvent(new Kind(type, { bubbles: true, cancelable: true }));
  return {
    window,
    document,
    $,
    errors,
    fetch,
    went,
    submitted,
    downloads,
    set: (id, value) => ($(`#${id}`).value = value),
    click: (el) => fire(el, "click"),
    input: (el) => fire(el, "input"),
    submit: (sel = "#config-form") => fire(sel, "submit"),
    shown: (sel) => !$(sel).hidden,
    text: (sel) => $(sel).textContent,
    sent: (key) => fetch.mock.calls.filter(([url, init]) => `${init && init.method} ${url}` === key).map(([, init]) => JSON.parse(init.body))
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush();
};

test("the script runs in every mode without errors", () => {
  for (const profile of [{ enabled: true }, SIGNED_IN, { enabled: true, signInId: ID }, { enabled: true, unavailable: true }, {}]) {
    expect(loadPage({ profile, existing: profile.signedIn ? { youtubeKey: "K" } : null }).errors).toEqual([]);
  }
});

describe("creating a profile", () => {
  const ready = (p) => {
    p.set("youtube-key", "AIzaSyTESTKEY");
    p.$("#agree").checked = true;
  };

  test("asks for a long enough password, the same twice, before checking anything", async () => {
    const p = loadPage();
    ready(p);
    p.submit();
    expect(p.text("#error")).toBe("Choose a password of at least 8 characters for your profile.");
    p.set("create-password", "long enough 1");
    p.set("create-password2", "long enough 2");
    p.submit();
    expect(p.text("#error")).toBe("The two passwords are not the same.");
    expect(p.fetch).not.toHaveBeenCalled();
  });

  test("checks the keys, creates it, offers it to the password manager, and opens it", async () => {
    const stored = [];
    const p = loadPage({
      fetch: api({ "POST /api/profile": { status: 201, body: { id: ID, installUrl: INSTALL_URL } } }),
      before(window) {
        window.PasswordCredential = function (data) {
          Object.assign(this, data);
        };
        Object.defineProperty(window.navigator, "credentials", { value: { store: async (c) => stored.push(c) }, configurable: true });
      }
    });
    ready(p);
    p.set("create-password", "long enough 1");
    p.set("create-password2", "long enough 1");
    p.$("#create-remember").checked = false;
    p.submit();
    expect(p.text("#submit-btn")).toBe("Checking your keys...");
    await settle();
    const [body] = p.sent("POST /api/profile");
    expect(body).toEqual({ config: expect.objectContaining({ youtubeKey: "AIzaSyTESTKEY" }), password: "long enough 1", remember: false });
    expect(p.$("#create-id").value).toBe(ID);
    expect(stored).toEqual([{ id: ID, password: "long enough 1", name: "YouStream profile" }]);
    expect(p.went).toEqual(["/configure?done=created"]);
  });

  test("a refusal is shown, and the button is back", async () => {
    const p = loadPage({ fetch: api({ "POST /api/profile": { status: 429, body: { error: "Too many tries. Wait 60 minutes and try again." } } }) });
    ready(p);
    p.set("create-password", "long enough 1");
    p.set("create-password2", "long enough 1");
    p.submit();
    await settle();
    expect(p.text("#error")).toBe("Too many tries. Wait 60 minutes and try again.");
    expect(p.text("#submit-btn")).toBe("Create profile and get install link");
    expect(p.$("#submit-btn").disabled).toBe(false);
    expect(p.went).toEqual([]);
  });

  test("an answer without a message, or no answer at all, still says something", async () => {
    const p = loadPage({ fetch: api({ "POST /api/profile": { status: 502, body: null } }) });
    ready(p);
    p.set("create-password", "long enough 1");
    p.set("create-password2", "long enough 1");
    p.submit();
    await settle();
    expect(p.text("#error")).toBe("YouStream answered with an error (502). Try again.");
    const offline = loadPage({ fetch: api({}) });
    ready(offline);
    offline.set("create-password", "long enough 1");
    offline.set("create-password2", "long enough 1");
    offline.submit();
    await settle();
    expect(offline.text("#error")).toBe("YouStream could not be reached. Check your connection and try again.");
  });

  test("or, without a profile, the link that carries the settings, as before", async () => {
    const p = loadPage();
    ready(p);
    p.click("#no-profile-btn");
    expect(p.shown("#create-card")).toBe(false);
    expect(p.text("#submit-btn")).toBe("Generate install link");
    p.submit();
    await settle();
    expect(p.$("#result").classList.contains("show")).toBe(true);
    expect(p.$("#manifest-url").value).toMatch(new RegExp(`^${BASE}/%7B`));
    expect(p.text("#submit-btn")).toBe("Generate install link");
    p.click("#no-profile-btn");
    expect(p.shown("#create-card")).toBe(true);
    expect(p.text("#submit-btn")).toBe("Create profile and get install link");
    expect(p.text("#no-profile-btn")).toBe("Or make an install link that carries your settings, without a profile");
  });
});

describe("signed in", () => {
  const signedIn = (opts = {}) => loadPage({ profile: SIGNED_IN, existing: { youtubeKey: "AIzaSyTESTKEY", maxResults: 5 }, ...opts });

  test("an edit shows the save bar; the eye on a key and the preview's tabs do not count", () => {
    const p = signedIn();
    expect(p.shown("#save-bar")).toBe(false);
    p.click(".key-toggle");
    p.click(".preview-tab");
    expect(p.shown("#save-bar")).toBe(false);
    p.set("max-results", "8");
    p.input("#max-results");
    expect(p.shown("#save-bar")).toBe(true);
    expect(p.document.body.className).toBe("has-save-bar");
  });

  test("a button that changes something counts", () => {
    const p = signedIn();
    p.click(".pb-down");
    expect(p.shown("#save-bar")).toBe(true);
  });

  test("leaving with unsaved changes asks first; not after saving, or when going on purpose", async () => {
    const p = signedIn({ fetch: api({ "PUT /api/profile": { body: { saved: true, manifestChanged: false } } }) });
    const leave = () => {
      const event = new p.window.Event("beforeunload", { cancelable: true });
      p.window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    p.input("#max-results");
    expect(leave()).toBe(true);
    p.click("#save-bar-btn");
    await settle();
    expect(leave()).toBe(false);
  });

  test("saving: the settings sent, and whether anything needs reinstalling", async () => {
    let changed = false;
    const p = signedIn({ fetch: api({ "PUT /api/profile": () => ({ body: { saved: true, manifestChanged: changed } }) }) });
    p.set("max-results", "8");
    p.input("#max-results");
    p.click("#save-bar-btn");
    await settle();
    expect(p.sent("PUT /api/profile")[0].config).toEqual(expect.objectContaining({ youtubeKey: "AIzaSyTESTKEY", maxResults: 8 }));
    expect(p.text("#save-status")).toBe("Saved. No need to reinstall: your apps use the new settings from their next request.");
    expect(p.$("#save-status").className).toBe("msg good");
    expect(p.shown("#save-bar")).toBe(false);
    expect(p.document.body.className).toBe("");
    changed = true;
    p.submit();
    await settle();
    expect(p.text("#save-status")).toMatch(/^Saved\. What YouStream offers changed .* Stremio keeps the old list until you reinstall YouStream there/);
    expect(p.text("#submit-btn")).toBe("Save changes");
  });

  test("a save that fails says why, and keeps the changes", async () => {
    const p = signedIn({ fetch: api({ "PUT /api/profile": { status: 401, body: { error: "You're signed out. Sign in again." } } }) });
    p.input("#max-results");
    p.submit();
    await settle();
    expect(p.text("#error")).toBe("You're signed out. Sign in again.");
    expect(p.shown("#save-bar")).toBe(true);
  });

  test("discarding goes back to the profile as saved", () => {
    const p = signedIn();
    p.input("#max-results");
    p.click("#save-bar-discard");
    expect(p.went).toEqual(["/configure"]);
  });

  test("the install link: copied, and installed through stremio://", async () => {
    const writes = [];
    const p = signedIn({
      before(window) {
        Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => writes.push(t) }, configurable: true });
      }
    });
    expect(p.$("#profile-install").getAttribute("href")).toBe(`stremio://youstream.example/${ID}.${TOKEN}/manifest.json`);
    p.click("#profile-copy");
    await settle();
    expect(writes).toEqual([INSTALL_URL]);
    expect(p.text("#profile-copy")).toBe("Copied!");
  });

  test("signing out: this device, or every one", async () => {
    const p = signedIn({
      fetch: api({ "DELETE /api/profile/session": { status: 204 }, "DELETE /api/profile/sessions": { body: { signedOut: 3 } } })
    });
    expect(p.shown("#signout-panel")).toBe(false);
    p.click("#signout-btn");
    expect(p.shown("#signout-panel")).toBe(true);
    expect(p.$("#signout-btn").getAttribute("aria-expanded")).toBe("true");
    p.click("#signout-cancel");
    expect(p.shown("#signout-panel")).toBe(false);
    p.click("#signout-btn");
    p.click("#signout-confirm");
    await settle();
    expect(p.sent("DELETE /api/profile/session")).toEqual([{}]);
    expect(p.went).toEqual(["/configure"]);
    p.$("#signout-all").checked = true;
    p.click("#signout-confirm");
    await settle();
    expect(p.sent("DELETE /api/profile/sessions")).toEqual([{}]);
  });

  test("a sign-out that fails says so", async () => {
    const p = signedIn({ fetch: api({}) });
    p.click("#signout-btn");
    p.click("#signout-confirm");
    await settle();
    expect(p.text("#signout-msg")).toBe("YouStream could not be reached. Check your connection and try again.");
    expect(p.text("#signout-confirm")).toBe("Sign out");
  });

  test("changing the password: checked here first, then sent", async () => {
    const p = signedIn({ fetch: api({ "POST /api/profile/password": { body: { changed: true } } }) });
    p.click("#pw-btn");
    expect(p.text("#pw-msg")).toBe("Enter your current password.");
    p.set("pw-current", "old password 1");
    p.set("pw-new", "short");
    p.click("#pw-btn");
    expect(p.text("#pw-msg")).toBe("Choose a new password of at least 8 characters.");
    p.set("pw-new", "new password 1");
    p.set("pw-new2", "new password 2");
    p.click("#pw-btn");
    expect(p.text("#pw-msg")).toBe("The two new passwords are not the same.");
    p.set("pw-new2", "new password 1");
    p.click("#pw-btn");
    await settle();
    expect(p.sent("POST /api/profile/password")).toEqual([{ currentPassword: "old password 1", newPassword: "new password 1" }]);
    expect(p.text("#pw-msg")).toBe("Password changed. Every other device was signed out; this one stays signed in. Your install link is the same.");
    expect(["pw-current", "pw-new", "pw-new2"].map((id) => p.$(`#${id}`).value)).toEqual(["", "", ""]);
  });

  test("a wrong current password is the server's to say", async () => {
    const p = signedIn({ fetch: api({ "POST /api/profile/password": { status: 401, body: { error: "That profile ID and password don't match." } } }) });
    p.set("pw-current", "wrong password");
    p.set("pw-new", "new password 1");
    p.set("pw-new2", "new password 1");
    p.click("#pw-btn");
    await settle();
    expect(p.text("#pw-msg")).toBe("That profile ID and password don't match.");
    expect(p.$("#pw-msg").className).toBe("msg bad");
  });

  test("replacing the install link updates it on the page", async () => {
    const NEW_URL = `${BASE}/${ID}.${"N".repeat(43)}/manifest.json`;
    const p = signedIn({ fetch: api({ "POST /api/profile/link": { body: { installUrl: NEW_URL } } }) });
    p.click("#link-btn");
    expect(p.text("#link-msg")).toBe("Enter your password.");
    p.set("link-password", "my password 1");
    p.click("#link-btn");
    await settle();
    expect(p.sent("POST /api/profile/link")).toEqual([{ password: "my password 1" }]);
    expect(p.$("#profile-url").value).toBe(NEW_URL);
    expect(p.$("#profile-install").getAttribute("href")).toBe(`stremio://youstream.example/${ID}.${"N".repeat(43)}/manifest.json`);
    expect(p.$("#link-password").value).toBe("");
    expect(p.text("#link-msg")).toMatch(/^Replaced: the old link no longer works\./);
  });

  test("deleting takes the password and a tick, then leaves", async () => {
    const p = signedIn({ fetch: api({ "DELETE /api/profile": { status: 204 } }) });
    p.set("delete-password", "my password 1");
    p.click("#delete-btn");
    expect(p.text("#delete-msg")).toBe("Tick the box to confirm.");
    p.set("delete-password", "");
    p.$("#delete-sure").checked = true;
    p.click("#delete-btn");
    expect(p.text("#delete-msg")).toBe("Enter your password.");
    p.set("delete-password", "my password 1");
    p.click("#delete-btn");
    await settle();
    expect(p.sent("DELETE /api/profile")).toEqual([{ password: "my password 1" }]);
    expect(p.went).toEqual(["/configure?done=deleted"]);
  });

  test("settings just imported count as unsaved, and a reload does not post the file again", () => {
    const p = loadPage({ profile: { ...SIGNED_IN, source: "import" }, existing: { youtubeKey: "K" } });
    expect(p.shown("#save-bar")).toBe(true);
    expect(p.window.location.pathname).toBe("/configure");
  });
});

describe("signing in", () => {
  test("from an install link: the ID is filled in, the password asked", async () => {
    const p = loadPage({ profile: { enabled: true, signInId: ID }, path: `/${ID}.${TOKEN}/configure`, fetch: api({ "POST /api/profile/session": { body: { id: ID } } }) });
    expect(p.$("#signin-card").open).toBe(true);
    expect(p.$("#signin-id").value).toBe(ID);
    expect(p.shown("#setup")).toBe(false);
    p.submit("#signin-form");
    expect(p.text("#signin-msg")).toBe("Enter your password.");
    p.set("signin-password", "my password 1");
    p.$("#signin-remember").checked = false;
    p.submit("#signin-form");
    expect(p.text("#signin-btn")).toBe("Signing in...");
    await settle();
    expect(p.sent("POST /api/profile/session")).toEqual([{ id: ID, password: "my password 1", remember: false }]);
    expect(p.went).toEqual(["/configure"]);
  });

  test("the ID can be typed in capitals, or the whole install link pasted", async () => {
    const p = loadPage({ fetch: api({ "POST /api/profile/session": { body: { id: ID } } }) });
    p.set("signin-id", `  ${INSTALL_URL.toUpperCase().replace("HTTPS", "https")}  `);
    p.set("signin-password", "my password 1");
    p.submit("#signin-form");
    await settle();
    expect(p.sent("POST /api/profile/session")[0].id).toBe(ID);
  });

  test("no ID in what was typed; a wrong password", async () => {
    const p = loadPage({ fetch: api({ "POST /api/profile/session": { status: 401, body: { error: "That profile ID and password don't match." } } }) });
    p.set("signin-id", "my profile");
    p.submit("#signin-form");
    expect(p.text("#signin-msg")).toBe("Enter your profile ID. It is in your install link, before the dot.");
    p.set("signin-id", ID.replace(/-/g, "_"));
    p.submit("#signin-form");
    expect(p.text("#signin-msg")).toBe("Enter your profile ID. It is in your install link, before the dot.");
    p.set("signin-id", ID.replace("3", "g"));
    p.submit("#signin-form");
    expect(p.fetch).not.toHaveBeenCalled();
    p.set("signin-id", ID);
    p.set("signin-password", "wrong password");
    p.submit("#signin-form");
    await settle();
    expect(p.text("#signin-msg")).toBe("That profile ID and password don't match.");
    expect(p.text("#signin-btn")).toBe("Sign in");
    expect(p.went).toEqual([]);
  });
});

describe("backups", () => {
  /** The exported file, read back as the browser would. */
  const exported = (p) =>
    new Promise((resolve) => {
      const reader = new p.window.FileReader();
      reader.onload = () => resolve(JSON.parse(reader.result));
      reader.readAsText(p.downloads.blob);
    });

  test("export leaves the keys out unless told otherwise, and works without a key or the terms ticked", async () => {
    const p = loadPage({ existing: null });
    p.set("max-results", "9");
    p.click("#export-btn");
    expect(p.downloads[0].name).toMatch(/^youstream-settings-\d{4}-\d\d-\d\d\.\d\d-\d\d-\d\d\.json$/);
    const file = await exported(p);
    expect(file).toEqual({ youstream: "settings", version: 1, exportedAt: expect.any(String), keysIncluded: false, config: expect.objectContaining({ maxResults: 9 }) });
    expect(file.config).not.toHaveProperty("youtubeKey");
    expect(p.text("#backup-msg")).toBe("Exported, without your keys.");
  });

  test("export with the keys, when asked", async () => {
    const p = loadPage({ profile: SIGNED_IN, existing: { youtubeKey: "AIzaSyTESTKEY", tmdbKey: "tmdbkey" } });
    p.$("#export-no-keys").checked = false;
    p.click("#export-btn");
    const file = await exported(p);
    expect(file.keysIncluded).toBe(true);
    expect(file.config).toEqual(expect.objectContaining({ youtubeKey: "AIzaSyTESTKEY", tmdbKey: "tmdbkey" }));
    expect(p.text("#backup-msg")).toBe("Exported, with your keys in it: keep the file private.");
  });

  test("a form that cannot be read cannot be exported", () => {
    const p = loadPage();
    p.set("max-results", "0");
    p.click("#export-btn");
    expect(p.text("#backup-msg")).toMatch(/^Videos to list/);
    expect(p.downloads).toEqual([]);
  });

  async function importFile(p, content, name = "youstream-settings.json") {
    const file = new p.window.File([content], name, { type: "application/json" });
    Object.defineProperty(p.$("#import-file"), "files", { value: [file], configurable: true });
    p.window.HTMLInputElement.prototype.click = () => {};
    p.click("#import-btn");
    p.$("#import-file").dispatchEvent(new p.window.Event("change"));
    for (let i = 0; i < 20 && !p.submitted.length && p.$("#backup-msg").hidden; i++) await flush();
  }

  test("import: an export's settings go to the page to look over, keeping the keys already filled in", async () => {
    const p = loadPage({ profile: SIGNED_IN, existing: { youtubeKey: "AIzaSyMINE", tmdbKey: "mine" } });
    await importFile(p, JSON.stringify({ youstream: "settings", version: 1, keysIncluded: false, config: { maxResults: 12 } }));
    expect(p.submitted).toHaveLength(1);
    const [post] = p.submitted;
    expect(post).toMatchObject({ action: `${BASE}/configure`, method: "post" });
    expect(JSON.parse(post.fields.config)).toEqual({ maxResults: 12, youtubeKey: "AIzaSyMINE", tmdbKey: "mine" });
    expect(post.fields.file).toBe("youstream-settings.json");
  });

  test("import: a file's own keys win; a bare settings object, as an old link carried, will do", async () => {
    const p = loadPage({ profile: SIGNED_IN, existing: { youtubeKey: "AIzaSyMINE" } });
    await importFile(p, JSON.stringify({ youtubeKey: "AIzaSyFILE", catalogs: [{ trending: "all" }] }));
    expect(JSON.parse(p.submitted[0].fields.config)).toEqual({ youtubeKey: "AIzaSyFILE", catalogs: [{ trending: "all" }] });
  });

  test("import: nothing usable in the file, nothing done", async () => {
    for (const content of ["not json", "[1]", JSON.stringify({ presets: [] }), JSON.stringify({ youstream: "settings", config: 5 }), "null"]) {
      const p = loadPage();
      await importFile(p, content);
      expect(p.text("#backup-msg")).toBe("That file holds no YouStream settings. Choose a file exported here.");
      expect(p.submitted).toEqual([]);
    }
  });

  test("import: an export of all-default settings is still one", async () => {
    const p = loadPage();
    await importFile(p, JSON.stringify({ youstream: "settings", version: 1, config: {} }));
    expect(JSON.parse(p.submitted[0].fields.config)).toEqual({});
  });

  test("import: choosing no file does nothing", () => {
    const p = loadPage();
    Object.defineProperty(p.$("#import-file"), "files", { value: [], configurable: true });
    p.$("#import-file").dispatchEvent(new p.window.Event("change"));
    expect(p.submitted).toEqual([]);
  });
});

describe("the app", () => {
  test("registers its service worker where there is one", () => {
    const registered = [];
    loadPage({
      before(window) {
        Object.defineProperty(window.navigator, "serviceWorker", {
          value: { register: async (url) => registered.push(url) },
          configurable: true
        });
      }
    });
    expect(registered).toEqual(["/sw.js"]);
  });

  test("an install button when the browser offers to install it", async () => {
    const p = loadPage();
    expect(p.shown("#install-app")).toBe(false);
    p.click("#install-app");
    const prompt = jest.fn();
    const offer = new p.window.Event("beforeinstallprompt", { cancelable: true });
    offer.prompt = prompt;
    p.window.dispatchEvent(offer);
    expect(offer.defaultPrevented).toBe(true);
    expect(p.shown("#install-app")).toBe(true);
    p.click("#install-app");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(p.shown("#install-app")).toBe(false);
    p.window.dispatchEvent(offer);
    p.window.dispatchEvent(new p.window.Event("appinstalled"));
    expect(p.shown("#install-app")).toBe(false);
  });
});
