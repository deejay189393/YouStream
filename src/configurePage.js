const { DESCRIPTION, ADDON_NAME, identity } = require("./manifest");
const { orderedPlaybackOptions, PLAYBACK_VERSION } = require("./playback");
const {
  PRESETS,
  DEFAULT_FORMAT,
  FORMATTER_LANGUAGES,
  MAX_NAME_TEMPLATE,
  MAX_DESCRIPTION_TEMPLATE,
  previewData
} = require("./streamFormat");
const { COUNTRIES, LANGUAGES } = require("./regions");
const {
  normalizeConfig,
  MARGIN_UNITS,
  DEFAULT_MARGINS,
  DEFAULT_EXCLUDE,
  DEFAULT_EXCLUDE_DESCRIPTION,
  DEFAULT_MOVIE_QUERY,
  DEFAULT_EPISODE_QUERY,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  DEFAULT_MIN_VIEWS,
  MAX_MIN_VIEWS,
  MAX_QUERY_LENGTH,
  SAFE_SEARCH,
  REFRESH_UNITS,
  DEFAULT_CATALOG_REFRESH,
  MIN_CATALOG_REFRESH
} = require("./config");
const catalogs = require("./catalogs");
const { PASSWORD_MIN } = require("./profiles/api");
const { BACKGROUND, configureScript } = require("./webApp");

/** Where the addon's source lives, linked from the footer. */
const REPO_URL = "https://github.com/deejay189393/YouStream";
const YOUTUBE_KEY_URL = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
const YOUTUBE_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const TMDB_KEY_URL = "https://www.themoviedb.org/settings/api";
const FORMATTER_DOCS_URL = "https://docs.aiostreams.viren070.me/reference/custom-formatter";

/**
 * The fields the configure page lists. Every field AIOStreams' formatter
 * documents is accepted too; those YouTube has nothing for are empty.
 */
const FIELD_HELP = [
  ["play.icon", "▶️ in the app, 📱 YouTube app, 📺 SmartTube"],
  ["play.label", "Play in app, YouTube app or SmartTube"],
  ["video.title", "The video's title on YouTube"],
  ["video.channel", "The channel that uploaded it"],
  ["video.official", "true for an upload by a YouTube content partner"],
  ["video.definition", "HD or SD, all YouTube says"],
  ["video.resolution", "4K, 1440p, 1080p, 720p or 480p: YouStream's estimate, also in stream.resolution as 2160p for 4K"],
  ["video.views", "338K"],
  ["video.uploaded", "The upload date, 2023-10-16; ::date('%-d %b %Y') gives 16 Oct 2023"],
  ["video.length", "1h 35m 09s"],
  ["video.offset", "How far from the listed runtime: −51s, +2m 10s or exact"],
  ["video.language", "The language it is spoken in"],
  ["video.ageRestricted", "true for a video YouTube restricts by age"],
  ["video.live", "true while a video is streaming live, which has no length yet"],
  ["video.id, video.url", "The video's id and link"],
  ["stream.filename", "The release-style name AIOStreams parses: title, year, episode, HD, WEB-DL, language"],
  ["stream.resolution", "720p for HD, 480p for SD: what AIOStreams reads"],
  ["stream.quality", "WEB-DL"],
  ["stream.duration", "The length in milliseconds; ::time('[%-Hh ]%-Mm %Ss') gives 1h 35m 09s"],
  ["stream.languages", "The language as a list, also as languageEmojis, languageCodes and smallLanguageCodes"],
  ["stream.seasonEpisode", "S01 and E03 for an episode; ::join('') gives S01E03"],
  ["stream.type", "youtube for in-app rows, external for the others"],
  ["stream.age", "How long ago it was uploaded: 365d"],
  ["stream.message", "A note, such as that a video is age-restricted"],
  ["metadata.title, metadata.year", "The film or show the stream was found for; empty for a YouTube video opened from a catalog or search"],
  ["metadata.episodeTitle", "The episode's own title"],
  ["addon.name", identity().name]
];

function presetOptions(selected) {
  return [
    ...Object.entries(PRESETS).map(
      ([id, preset]) => `<option value="${escapeHtml(id)}"${id === selected ? " selected" : ""}>${escapeHtml(preset.label)}</option>`
    ),
    `<option value="custom"${selected === "custom" ? " selected" : ""}>Custom</option>`
  ].join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

/**
 * Embed a value as a JavaScript literal inside an inline <script>.
 *
 * JSON.stringify alone is not enough: the HTML parser ends a script at the
 * first literal "</script>" however the JS is quoted, and baseUrl is built
 * from the request's Host header. Escaping "<" closes that, and escaping
 * U+2028/U+2029 covers the two characters that end a line in JavaScript but
 * are legal raw inside a JSON string.
 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const EYE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/><line class="eye-slash" x1="3.5" y1="20.5" x2="20.5" y2="3.5"/></svg>';

function keyField({ id, label, value, placeholder }) {
  return `
        <div class="key-row">
          <input type="password" id="${id}" class="key-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(
            value
          )}" aria-label="${escapeHtml(label)}" autocomplete="off" spellcheck="false" />
          <button type="button" class="key-toggle" data-for="${id}" title="Show key" aria-label="Show ${escapeHtml(
            label
          )}" aria-pressed="false">${EYE_ICON}</button>
        </div>`;
}

/** A password box with the same show/hide button as a key's. */
function passwordField({ id, label, autocomplete, name = "", placeholder = "" }) {
  return `
        <label class="field" for="${id}"><span class="label-text">${escapeHtml(label)}</span>
        <div class="key-row">
          <input type="password" id="${id}"${name ? ` name="${name}"` : ""} autocomplete="${autocomplete}" placeholder="${escapeHtml(
            placeholder
          )}" spellcheck="false" autocapitalize="none" />
          <button type="button" class="key-toggle" data-for="${id}" data-what="password" title="Show password" aria-label="Show ${escapeHtml(
            label.toLowerCase()
          )}" aria-pressed="false">${EYE_ICON}</button>
        </div></label>`;
}

/** No profiles: what the page is given when the server has none, or the caller says nothing. */
const NO_PROFILES = {
  sessionDays: { remembered: 30, max: 90 },
  enabled: false,
  unavailable: false,
  signedIn: null,
  signInId: null,
  otherProfile: null,
  linkWorks: true,
  source: null,
  fileName: "",
  done: null
};

/** A profile's id as the page shows it: its first eight characters. */
const shortId = (id) => `${id.slice(0, 8)}…`;

/** The notes at the top of the page, for the mode it is in and how it got there. */
function profileBanners(p, mode, usable, isReconfigure) {
  const notes = [];
  if (p.done === "created") {
    notes.push(
      "Your profile is ready. Install YouStream with the link below, once: from now on, whatever you save here reaches your apps without reinstalling."
    );
  }
  if (p.done === "deleted") notes.push("Your profile was deleted, and its install link no longer works.");
  if (p.enabled && p.unavailable) {
    notes.push(
      "Profiles are unavailable right now: YouStream cannot reach its database. Try again in a minute, or make an install link that holds your settings instead."
    );
  }
  if (mode === "signin" && !p.linkWorks) {
    notes.push("This install link no longer works: its profile was deleted, or the link was replaced. Sign in to see the current one.");
  }
  if (mode === "signin" && p.otherProfile) {
    notes.push(`You're signed in to another profile (${shortId(p.otherProfile)}). Sign in below to switch to this one.`);
  }
  if (p.source === "import") {
    const then = mode === "profile" ? "save to keep them" : usable ? "create your profile to use them" : "generate your link to use them";
    notes.push(`Imported ${p.fileName ? `“${p.fileName}”` : "a settings file"}: nothing is saved yet. Look the settings over, then ${then}.`);
  } else if (p.source === "link" && mode === "profile") {
    notes.push(
      "These settings come from an install link that carries them itself. Saving makes them your profile's settings, in place of the ones it has."
    );
  } else if (isReconfigure && mode !== "profile" && usable) {
    notes.push(
      "Editing a setup whose install link carries its settings. Create a profile below for a link that never changes, which you can edit from any device."
    );
  } else if (isReconfigure && mode !== "profile") {
    notes.push("Editing your current setup: everything is pre-filled. Generate a new link and install it to apply your changes.");
  }
  return notes.map((text) => `<div class="banner">${escapeHtml(text)}</div>`).join("\n  ");
}

/** Signed in: who, and the way out. */
function profileBar(p) {
  return `
  <div class="profile-bar card">
    <span><span class="dot" aria-hidden="true"></span>Signed in <span class="muted">· profile <code title="${escapeHtml(
      p.signedIn.id
    )}">${escapeHtml(shortId(p.signedIn.id))}</code></span></span>
    <button type="button" class="ghost-btn" id="signout-btn" aria-expanded="false" aria-controls="signout-panel">Sign out</button>
  </div>
  <div class="card small" id="signout-panel" hidden>
    <label class="check"><input type="checkbox" id="signout-all" />
      <span><strong>Sign out on all devices</strong><em>Every phone and computer signed in to this profile will have to sign in again. Your install link keeps working.</em></span></label>
    <div class="btn-row">
      <button type="button" class="danger-btn" id="signout-confirm">Sign out</button>
      <button type="button" class="ghost-btn" id="signout-cancel">Cancel</button>
    </div>
    <div class="msg" id="signout-msg" role="alert" hidden></div>
  </div>`;
}

const stremioLink = (url) => url.replace(/^https?:\/\//, "stremio://");

/** The profile's install link: the one thing to put in an app, once. */
function installCard(p) {
  const url = p.signedIn.installUrl;
  return `
  <div class="card" id="install-card">
    <h3>Your install link</h3>
    <p class="lead">Install it once, in Stremio, Nuvio or AIOStreams. It never changes: whatever you save here reaches your apps without reinstalling.</p>
    <a id="profile-install" class="install-btn" href="${escapeHtml(stremioLink(url))}">Install in Stremio</a>
    <div class="url-row">
      <input id="profile-url" type="text" readonly value="${escapeHtml(url)}" aria-label="Your install link" />
      <button type="button" id="profile-copy">Copy</button>
    </div>
    <div class="hint">In Nuvio or AIOStreams, paste the copied link where addons are added. Using an older YouStream link there? Swap it for this one, once.<br />
    Keep it private: whoever has it can use YouStream on your YouTube quota, though they can never see or change your settings or keys.</div>
  </div>`;
}

/** Sign in: open from an install link, folded away on a new setup. */
/** How long "stay signed in" lasts, as the host set it. */
const rememberText = ({ remembered, max }) => `For ${remembered} days from when you last use YouStream here, ${max} at most.`;

function signInCard(p, mode) {
  const remember = rememberText(p.sessionDays);
  return `
  <details class="card" id="signin-card"${mode === "signin" ? " open" : ""}>
    <summary>${mode === "signin" ? "Sign in to your profile" : "Have a profile? Sign in"}</summary>
    <form id="signin-form" novalidate>
      <p class="lead">To change your settings from any device. Your apps keep the same install link.</p>
      <label class="field" for="signin-id"><span class="label-text">Profile ID</span>
        <input type="text" id="signin-id" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"
          placeholder="1b4e28ba-2fa1-41d2-883f-0016d3cca427" value="${escapeHtml(p.signInId || "")}" /></label>
      ${passwordField({ id: "signin-password", label: "Password", autocomplete: "current-password", name: "password" })}
      <label class="check stay"><input type="checkbox" id="signin-remember" checked />
        <span><strong>Stay signed in on this device</strong><em>${remember}</em></span></label>
      <button type="submit" class="submit" id="signin-btn">Sign in</button>
      <div class="msg" id="signin-msg" role="alert" hidden></div>
      <div class="hint">Your profile ID is in your install link, after the address and before the dot: you can paste the whole link. A password cannot be reset, as it is what unlocks your settings. If yours is lost, <a href="/configure">start a new setup</a> and install its link in place of the old one.</div>
    </form>
  </details>`;
}

/** Creating a profile: the end of the form for a new setup. */
function createSection(p) {
  return `
    <div class="card create" id="create-card">
      <h3>Your profile</h3>
      <p class="lead">Your settings are kept on this server, encrypted, behind a password. You get one install link that never changes: change anything here later, from any device, and your apps use it without reinstalling.</p>
      <input type="text" id="create-id" name="username" autocomplete="username" readonly hidden />
      ${passwordField({ id: "create-password", label: `Password (at least ${PASSWORD_MIN} characters)`, autocomplete: "new-password", name: "new-password" })}
      ${passwordField({ id: "create-password2", label: "The same password again", autocomplete: "new-password" })}
      <label class="check stay"><input type="checkbox" id="create-remember" checked />
        <span><strong>Stay signed in on this device</strong><em>${rememberText(p.sessionDays)}</em></span></label>
      <div class="hint">Let your browser or password manager save it: a password cannot be reset, as it is what unlocks your settings.</div>
    </div>`;
}

/** Export and import, in every mode but signing in. */
function backupsCard() {
  return `
  <div class="card" id="backups-card">
    <h3>Backups</h3>
    <p class="lead">Save your settings to a file, or fill the form from one. An import is only saved when you save.</p>
    <label class="check"><input type="checkbox" id="export-no-keys" checked />
      <span><strong>Leave my keys out of the file</strong><em>Your YouTube and TMDB keys. Importing a file without keys keeps the keys already filled in.</em></span></label>
    <div class="btn-row">
      <button type="button" class="ghost-btn" id="export-btn">Export settings</button>
      <button type="button" class="ghost-btn" id="import-btn">Import settings</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden />
    </div>
    <div class="msg" id="backup-msg" role="alert" hidden></div>
  </div>`;
}

/** The profile's password, link and existence: each asks for the password. */
function securityCard() {
  return `
  <details class="card" id="security-card">
    <summary>Profile and security</summary>
    <div class="sec">
      <h4>Change your password</h4>
      <p class="lead">Signs out every other device. Your install link stays the same.</p>
      ${passwordField({ id: "pw-current", label: "Current password", autocomplete: "current-password" })}
      ${passwordField({ id: "pw-new", label: `New password (at least ${PASSWORD_MIN} characters)`, autocomplete: "new-password" })}
      ${passwordField({ id: "pw-new2", label: "The new password again", autocomplete: "new-password" })}
      <button type="button" class="ghost-btn" id="pw-btn">Change password</button>
      <div class="msg" id="pw-msg" role="alert" hidden></div>
    </div>
    <div class="sec">
      <h4>Replace your install link</h4>
      <p class="lead">If your link got out. The old link stops working at once, so install YouStream again with the new one wherever you use it.</p>
      ${passwordField({ id: "link-password", label: "Password", autocomplete: "current-password" })}
      <button type="button" class="ghost-btn" id="link-btn">Replace install link</button>
      <div class="msg" id="link-msg" role="alert" hidden></div>
    </div>
    <div class="sec">
      <h4>Delete your profile</h4>
      <p class="lead">Deletes your settings from this server, and your install link stops working. Export your settings first if you may want them again.</p>
      ${passwordField({ id: "delete-password", label: "Password", autocomplete: "current-password" })}
      <label class="check"><input type="checkbox" id="delete-sure" /><span><strong>Yes, delete my profile</strong></span></label>
      <button type="button" class="danger-btn" id="delete-btn">Delete profile</button>
      <div class="msg" id="delete-msg" role="alert" hidden></div>
    </div>
  </details>`;
}

const MARGIN_ROWS = [
  {
    name: "movieMargin",
    label: "Movies",
    note: "Around the film's runtime."
  },
  {
    name: "partnerMovieMargin",
    label: "Movies, official channels",
    note: "Studios' own uploads are often cut differently: Indian films run 10 to 25 minutes short."
  },
  {
    name: "episodeMargin",
    label: "Episodes",
    note: "Around the episode's own runtime, when it is listed."
  },
  {
    name: "typicalMargin",
    label: "Episodes, usual length only",
    note: "When only the show's usual episode length is known. Episodes vary, so this one is wider."
  }
];

function marginRow(row, margin) {
  const units = Object.entries(MARGIN_UNITS)
    .map(
      ([unit, info]) =>
        `<option value="${escapeHtml(unit)}"${unit === margin.unit ? " selected" : ""}>${escapeHtml(info.label)}</option>`
    )
    .join("");
  return `
          <div class="margin-row" data-margin="${row.name}">
            <div class="margin-label"><strong>${escapeHtml(row.label)}</strong><em>${escapeHtml(row.note)}</em></div>
            <div class="margin-inputs">
              <span class="pm" aria-hidden="true">&plusmn;</span>
              <input type="number" class="margin-value" id="margin-${row.name}" min="0" step="any" inputmode="decimal" value="${escapeHtml(
                margin.value
              )}" aria-label="${escapeHtml(row.label)} margin" />
              <select class="margin-unit" aria-label="${escapeHtml(row.label)} margin unit">${units}</select>
            </div>
          </div>`;
}

function playbackRows(enabled) {
  return orderedPlaybackOptions(enabled)
    .map(
      (option) => `
            <li class="pb-option" data-option="${escapeHtml(option.id)}">
              <label class="check">
                <input type="checkbox" class="pb-on" id="pb-on-${escapeHtml(option.id)}"${option.enabled ? " checked" : ""} />
                <span><strong>${escapeHtml(option.label)}</strong><em>${escapeHtml(option.note)}</em></span>
              </label>
              <div class="pb-move">
                <button type="button" class="pb-up" title="Move up" aria-label="Move ${escapeHtml(option.label)} up">&#9650;</button>
                <button type="button" class="pb-down" title="Move down" aria-label="Move ${escapeHtml(option.label)} down">&#9660;</button>
              </div>
            </li>`
    )
    .join("");
}

/** A select's options from a list of { id, label }. */
function choiceOptions(list, selected) {
  return list
    .map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selected ? " selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");
}

const SAFE_SEARCH_LABELS = { moderate: "Moderate (YouTube's default)", strict: "Strict", none: "Off" };

/** Where a catalog's videos can come from, and what the add row then asks for. */
const CATALOG_SOURCES = [
  { id: "search", label: "YouTube search", placeholder: "A search, such as lofi hip hop", prompt: "What to search YouTube for" },
  { id: "playlist", label: "YouTube playlist", placeholder: "A playlist's link or ID", prompt: "A YouTube playlist's link or ID" },
  { id: "channel", label: "YouTube channel", placeholder: "A channel's link or @handle", prompt: "A YouTube channel's link or @handle" }
];

/**
 * What the page's YouTube card works from, as JSON for its script: the
 * reader's catalogs, and the choices each kind of catalog offers.
 */
function youtubeData(entries) {
  const pick = (list) => list.map(({ id, label, short }) => ({ id, label, short: short || "" }));
  return {
    catalogs: entries,
    sorts: pick(catalogs.SORTS),
    lengths: pick(catalogs.LENGTHS),
    periods: pick(catalogs.PERIODS),
    shows: pick(catalogs.CHANNEL_SHOWS),
    channelSorts: pick(catalogs.CHANNEL_SORTS),
    filterModes: catalogs.FILTER_MODES,
    filterScopes: catalogs.FILTER_SCOPES,
    maxFilterWords: catalogs.MAX_FILTER_WORDS,
    maxFilterWord: catalogs.MAX_FILTER_WORD_LENGTH,
    trending: catalogs.TRENDING.map(({ id, label, chip }) => ({ id, label, chip })),
    sources: CATALOG_SOURCES,
    maxCatalogs: catalogs.MAX_CATALOGS,
    maxQuery: catalogs.MAX_QUERY_LENGTH,
    refreshUnits: REFRESH_UNITS,
    defaultRefresh: DEFAULT_CATALOG_REFRESH,
    minRefresh: MIN_CATALOG_REFRESH
  };
}

function options(list, selected, anyLabel) {
  const any = `<option value=""${selected ? "" : " selected"}>${escapeHtml(anyLabel)}</option>`;
  return (
    any +
    list
      .map((item) => `<option value="${item.code}"${item.code === selected ? " selected" : ""}>${escapeHtml(item.label)}</option>`)
      .join("")
  );
}

/** The page's sections: a bar of tabs along the bottom of a phone, a column down the side of a wider screen. */
const ICONS = {
  summary:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="4.5" rx="1.5"/><rect x="13.5" y="11" width="7" height="9.5" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20.5 20.5"/></svg>',
  catalogs:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="4" width="17" height="6.5" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5"/></svg>',
  streams:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.6v6.8l5.6-3.4z"/></svg>',
  account:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/></svg>'
};

function tabs(accountLabel) {
  const list = [
    ["summary", "Summary"],
    ["search", "Search"],
    ["catalogs", "Catalogs"],
    ["streams", "Streams"],
    ["account", accountLabel]
  ];
  return list.map(([id, label]) => `<a class="tab" href="#${id}" data-tab="${id}">${ICONS[id]}<span>${label}</span></a>`).join("\n      ");
}

/** A section of the page, as a tab shows it. */
const panelHead = (id, title, lead) => `<h2 class="panel-title" id="h-${id}">${title}</h2>
      <p class="panel-lead">${lead}</p>`;

/** Where the addon comes from, its data's credits, and the terms: the end of the Account tab, and of the sign-in page. */
function about(credits) {
  return `<footer class="about">
      <a href="${REPO_URL}" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
        Source code on GitHub
      </a>${
        credits.length
          ? `
      <p class="credits">${credits
        .map(
          (c) =>
            `<a href="${escapeHtml(c.href)}" target="_blank" rel="noopener">${
              c.image ? `<img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.imageAlt || "")}" height="11" />` : ""
            }${escapeHtml(c.text)}</a>`
        )
        .join("<br />")}</p>`
          : ""
      }
      <p class="disclaimer">YouStream links to videos hosted on YouTube; it does not host, store or download any video. YouTube is a trademark of Google LLC. YouStream is not affiliated with or endorsed by YouTube, Google, Stremio or Nuvio. <a href="/terms">Terms of use and privacy</a></p>
    </footer>`;
}

const STYLE = `
  :root {
    --bg: #0f1013; --card: #17181d; --raised: #121318; --border: #2b2d36; --field: #0c0d10;
    --text: #eef0f4; --muted: #9ea3ae; --accent: #7a1a2b; --accent-2: #a3263c; --link: #e29aa7; --warn: #ffb020;
    --tabbar: 62px; --nav: 240px; --safe-bottom: env(safe-area-inset-bottom, 0px);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  body { padding-top: env(safe-area-inset-top, 0px); }
  [hidden] { display: none !important; }
  a { color: var(--link); }

  /* Phones first: the content in one column, the tabs in a bar along the bottom. */
  .content { max-width: 720px; margin: 0 auto; padding: 18px 16px calc(var(--tabbar) + 120px + var(--safe-bottom)); }
  .tabbar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex;
    background: rgba(18,19,24,.97); border-top: 1px solid var(--border); padding: 0 4px var(--safe-bottom);
    -webkit-backdrop-filter: saturate(140%) blur(12px); backdrop-filter: saturate(140%) blur(12px);
  }
  .tabbar .brand { display: none; }
  .tab {
    flex: 1 1 0; min-width: 0; height: var(--tabbar); display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; color: var(--muted); text-decoration: none; font-size: 11px; font-weight: 600; -webkit-tap-highlight-color: transparent;
  }
  .tab svg { width: 23px; height: 23px; flex: 0 0 auto; }
  .tab span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab[aria-current="page"] { color: var(--text); }
  .tab[aria-current="page"] svg { color: var(--link); }
  .tab:focus-visible { outline: 2px solid var(--link); outline-offset: -4px; border-radius: 10px; }

  .action-bar {
    position: fixed; left: 0; right: 0; bottom: calc(var(--tabbar) + var(--safe-bottom)); z-index: 25;
    display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 10px 16px;
    background: rgba(23,24,29,.97); border-top: 1px solid var(--border); font-size: 14px; color: var(--muted);
  }
  .action-bar > span { margin-right: auto; }
  .action-bar .primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; border: 0; border-radius: 9px;
    padding: 10px 18px; font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit; white-space: nowrap;
  }
  .toasts {
    position: fixed; left: 12px; right: 12px; bottom: calc(var(--tabbar) + 70px + var(--safe-bottom)); z-index: 40;
    max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  }
  .toasts > * { pointer-events: auto; }
  /* Notes over the page: what is wrong, or that it saved. A tap dismisses one. */
  .toasts > p {
    position: relative; margin: 0; padding: 12px 38px 12px 14px; border-radius: 11px; font-size: 13.5px; line-height: 1.5; cursor: pointer;
    background: #1d1f26; border: 1px solid var(--border); box-shadow: 0 8px 28px rgba(0,0,0,.45);
  }
  .toasts > p::after { content: "\\00d7"; position: absolute; right: 13px; top: 9px; font-size: 18px; color: var(--muted); }
  .toasts #error, .toasts .msg.bad { color: #ff8d8d; border-color: #6b2630; }
  .toasts .msg.good { color: #6fdca6; border-color: #1f5a41; }

  /* A wider screen: the tabs in a column down the side, the content beside it. */
  @media (min-width: 900px) {
    .app { display: grid; grid-template-columns: var(--nav) minmax(0, 1fr); min-height: 100vh; }
    .tabbar {
      position: sticky; top: 0; height: 100vh; flex-direction: column; align-items: stretch; gap: 3px;
      padding: 22px 14px; border-top: 0; border-right: 1px solid var(--border); background: var(--raised);
    }
    .tabbar .brand {
      display: flex; align-items: center; gap: 11px; padding: 2px 10px 22px; color: var(--text); text-decoration: none;
      font-weight: 700; font-size: 16px;
    }
    .tabbar .brand img { width: 36px; height: 36px; border-radius: 10px; }
    .tab { flex: 0 0 auto; height: auto; flex-direction: row; justify-content: flex-start; gap: 12px; padding: 10px 12px; border-radius: 10px; font-size: 14.5px; }
    .tab:hover { background: rgba(255,255,255,.045); color: var(--text); }
    .tab[aria-current="page"] { background: rgba(122,26,43,.34); }
    .content { padding: 36px 40px 150px; }
    .action-bar { left: var(--nav); bottom: 0; padding: 12px 40px; }
    .toasts { left: calc(var(--nav) + 24px); right: 24px; bottom: 86px; }
  }

  .panel-title { font-size: 24px; margin: 6px 0 6px; letter-spacing: -.01em; }
  .panel-lead { color: var(--muted); font-size: 14px; line-height: 1.55; margin: 0 0 20px; }
  .hero { display: flex; align-items: flex-start; gap: 14px; margin: 4px 0 18px; }
  .hero img { width: 52px; height: 52px; border-radius: 14px; flex: 0 0 auto; margin-top: 2px; }
  .hero h1 { font-size: 22px; margin: 0 0 4px; }
  .hero p { color: var(--muted); margin: 0; font-size: 13px; line-height: 1.5; }
  @media (min-width: 900px) { .hero img { display: none; } }
  #install-app { margin: 0 0 16px; }

  .banner {
    background: rgba(122,26,43,.25); border: 1px solid var(--accent-2);
    border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 16px; line-height: 1.5;
  }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px; margin-bottom: 14px; }
  .card h3 { font-size: 13px; margin: 0 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .card .lead { font-size: 13px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  .chip {
    display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 6px; border-radius: 5px; background: rgba(122,26,43,.45); color: var(--link); margin-left: 6px;
    vertical-align: middle;
  }
  input[type="password"], input[type="text"], input[type="number"], select, textarea {
    width: 100%; background: var(--field); border: 1px solid var(--border); color: var(--text);
    padding: 11px 12px; border-radius: 9px; font-size: 16px; font-family: inherit;
  }
  textarea { min-height: 96px; resize: vertical; font-size: 13px; line-height: 1.5; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--link); }
  .field { display: block; margin-bottom: 14px; }
  .field:last-child { margin-bottom: 0; }
  .label-text { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  .key-row { display: flex; gap: 8px; align-items: stretch; }
  .key-row input { flex: 1 1 auto; min-width: 0; }
  .key-toggle {
    flex: 0 0 auto; width: 44px; background: var(--field); border: 1px solid var(--border);
    color: var(--muted); border-radius: 9px; cursor: pointer; padding: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .key-toggle:hover { color: var(--text); border-color: var(--link); }
  .key-toggle .eye-slash { display: none; }
  .key-toggle[aria-pressed="true"] { color: var(--link); border-color: var(--link); }
  .key-toggle[aria-pressed="true"] .eye-slash { display: inline; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.55; }
  .hint ol { margin: 6px 0 0; padding-left: 18px; }
  .check { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; margin: 0; flex: 1 1 auto; }
  .check input { width: 18px; height: 18px; margin-top: 1px; flex: 0 0 auto; accent-color: var(--accent-2); }
  .check strong { display: block; font-size: 14px; font-weight: 600; }
  .check em { display: block; font-size: 12px; color: var(--muted); font-style: normal; margin-top: 2px; line-height: 1.45; }
  .row-box, .margin-row, .pb-option {
    display: flex; align-items: center; gap: 10px; background: var(--raised);
    border: 1px solid var(--border); border-radius: 9px; padding: 10px 11px; margin-bottom: 6px;
  }
  .margin-row { flex-wrap: wrap; }
  .margin-label { flex: 1 1 200px; min-width: 0; }
  .margin-label strong { display: block; font-size: 14px; }
  .margin-label em { display: block; font-size: 12px; color: var(--muted); font-style: normal; margin-top: 2px; }
  .margin-inputs { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .margin-inputs .pm { color: var(--muted); font-size: 16px; }
  .margin-inputs input { width: 84px; padding: 8px 10px; font-size: 15px; }
  .margin-inputs select { width: auto; padding: 8px 10px; font-size: 15px; }
  #pb-options { list-style: none; margin: 0; padding: 0; }
  .pb-move { display: flex; gap: 4px; flex: 0 0 auto; }
  .pb-move button, .btns button {
    width: 30px; height: 30px; background: var(--field); border: 1px solid var(--border);
    color: var(--muted); border-radius: 7px; cursor: pointer; font-size: 10px; line-height: 1; padding: 0;
  }
  .pb-move button:disabled, .btns button:disabled { opacity: .3; cursor: default; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
  @media (max-width: 480px) { .grid-2 { grid-template-columns: 1fr; } }
  details summary { cursor: pointer; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
  details[open] summary { margin-bottom: 12px; }
  .reset { background: none; border: none; color: var(--link); font-size: 12px; cursor: pointer; padding: 0; margin-top: 6px; }
  .submit {
    width: 100%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; border: none;
    padding: 14px; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  .submit:disabled { opacity: .6; cursor: progress; }
  #result { margin-top: 16px; display: none; }
  #result.show { display: block; }
  .install-btn {
    display: block; text-align: center; text-decoration: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; padding: 14px;
    border-radius: 10px; font-weight: 600; margin-bottom: 10px;
  }
  .url-row { display: flex; gap: 8px; }
  .url-row input { font-size: 12px; color: var(--muted); }
  .url-row button {
    flex: 0 0 auto; background: var(--field); border: 1px solid var(--border); color: var(--text);
    padding: 10px 14px; border-radius: 9px; font-size: 13px; cursor: pointer;
  }
  .warning { color: var(--warn); font-size: 13px; margin: 0 0 10px; line-height: 1.5; display: none; }
  .summary { list-style: none; margin: 0; padding: 0; }
  .summary-row { display: flex; align-items: baseline; gap: 12px; padding: 11px 2px; border-top: 1px solid var(--border); color: inherit; text-decoration: none; }
  .summary li:first-child .summary-row { border-top: 0; padding-top: 2px; }
  .summary-row::after { content: "\\203a"; color: var(--muted); font-size: 18px; line-height: 1; }
  .summary-row:hover .s-value { color: var(--link); }
  .s-name { flex: 0 0 36%; color: var(--muted); font-size: 13px; }
  .s-value { flex: 1 1 auto; min-width: 0; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
  .about { margin: 26px 0 8px; text-align: center; }
  .about a { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 13px; text-decoration: none; }
  .about a:hover { color: var(--text); text-decoration: underline; }
  .about .credits, .about .disclaimer { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .about .credits a, .about .disclaimer a { display: inline; font-size: 12px; }
  .about .credits img { vertical-align: middle; margin-right: 4px; }
  .about .disclaimer a { text-decoration: underline; }
  textarea.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; min-height: 0; }
  .format .hint code, .fields-help code { color: var(--text); font-size: 11.5px; }
  .preview-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .preview-head .label-text { margin: 0; }
  .preview-tabs { display: flex; gap: 6px; }
  .preview-tabs button {
    background: var(--field); border: 1px solid var(--border); color: var(--muted); border-radius: 7px;
    padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  .preview-tabs button[aria-pressed="true"] { color: var(--text); border-color: var(--link); }
  .preview { list-style: none; margin: 0 0 10px; padding: 0; }
  .preview li { display: flex; gap: 12px; background: var(--raised); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; margin-bottom: 6px; }
  .preview .p-name { flex: 0 0 32%; font-weight: 700; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .preview .p-desc { flex: 1 1 auto; min-width: 0; font-size: 12.5px; color: #d8dbe2; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  @media (max-width: 480px) { .preview li { flex-direction: column; gap: 4px; } .preview .p-name { flex-basis: auto; } }
  .format-warnings { list-style: none; padding: 0; margin: 0 0 10px; }
  .format-warnings li { color: var(--warn); font-size: 12px; line-height: 1.5; margin-bottom: 4px; }
  .fields-help summary { font-size: 12px; text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--link); }
  .fields-help table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
  .fields-help td { padding: 3px 8px 3px 0; vertical-align: top; color: var(--muted); line-height: 1.45; }
  .fields-help td:first-child { white-space: nowrap; }
  .agree { margin: 4px 0 14px; font-size: 13px; color: var(--muted); }
  .sub-label { display: block; font-size: 12px; color: var(--muted); margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
  #catalog-list { display: flex; flex-direction: column; gap: 6px; }
  .cat-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0 10px; background: var(--raised); border: 1px solid var(--border); border-radius: 9px; padding: 9px 10px; }
  .cat-rank {
    flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; background: var(--accent); color: #fff;
    font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 3px;
  }
  .cat-main { flex: 1 1 0; min-width: 0; }
  .cat-label { font-size: 14px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; padding-top: 3px; }
  .cat-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .cat-opts select { width: auto; max-width: 100%; padding: 6px 8px; font-size: 13px; border-radius: 7px; }
  .cat-empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }
  .cat-fixed { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  /* A line of its own under the row, as wide as the row past its number, so a
     phone shows the filter's choices whole. */
  .cat-filter { flex: 0 0 calc(100% - 32px); margin: 7px 0 0 32px; display: flex; flex-direction: column; gap: 6px; }
  .cat-filter select { width: 100%; padding: 6px 8px; font-size: 13px; border-radius: 7px; }
  .cat-filter .cat-words { padding: 8px 9px; font-size: 14px; border-radius: 7px; }
  .btns { flex: 0 0 auto; display: flex; gap: 4px; }
  .btns button { font-size: 11px; }
  .btns button.remove { color: #ff6b6b; }
  .add-row { display: flex; gap: 8px; margin-top: 10px; }
  .add-row input { flex: 1 1 0; min-width: 0; }
  #catalog-source { width: auto; flex: 0 0 auto; }
  @media (max-width: 480px) { .source-row { flex-wrap: wrap; } #catalog-source { flex: 1 1 100%; } }
  .add-btn {
    flex: 0 0 auto; background: var(--field); border: 1px solid var(--border); color: var(--text);
    padding: 0 16px; border-radius: 9px; font-size: 14px; cursor: pointer;
  }
  .add-btn:disabled { opacity: .5; cursor: progress; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips button { background: var(--field); border: 1px solid var(--border); color: var(--text); padding: 7px 12px; font-size: 13px; border-radius: 999px; cursor: pointer; }
  .chips button:hover { border-color: var(--link); }
  .inline-inputs { display: flex; gap: 8px; }
  .inline-inputs input { flex: 1 1 auto; min-width: 0; }
  .inline-inputs select { width: auto; flex: 0 0 auto; }
  .note-warn { color: var(--warn); }
  .profile-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; font-size: 14px; }
  .profile-bar .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3ecf8e; margin-right: 8px; vertical-align: middle; }
  .profile-bar .muted { color: var(--muted); }
  .profile-bar code, .sec code { font-size: 12.5px; color: var(--text); }
  .card.small { padding: 14px 16px; }
  .ghost-btn, .danger-btn {
    background: var(--field); border: 1px solid var(--border); color: var(--text); padding: 9px 14px;
    border-radius: 9px; font-size: 14px; cursor: pointer; font-family: inherit;
  }
  .ghost-btn:hover { border-color: var(--link); }
  .danger-btn { color: #ff8d8d; border-color: #6b2630; }
  .ghost-btn:disabled, .danger-btn:disabled { opacity: .6; cursor: progress; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .link-btn { background: none; border: none; color: var(--link); font-size: 13px; cursor: pointer; padding: 0; margin-top: 12px; font-family: inherit; text-decoration: underline; }
  .msg { font-size: 13px; margin-top: 10px; line-height: 1.5; }
  .msg.good { color: #6fdca6; }
  .msg.bad { color: #ff6b6b; }
  .stay { margin: 4px 0 14px; }
  #signin-card .submit { margin-top: 2px; }
  .sec { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 14px; }
  .sec:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .sec h4 { font-size: 14px; margin: 0 0 4px; }
  .sec .check { margin: 4px 0 12px; }
  .signin-view { max-width: 560px; margin: 0 auto; padding: 28px 16px 40px; }
`;

/**
 * The configure page. Also the RE-configure page: an installed addon's
 * "Configure" button opens /<config>/configure, and the decoded `existing`
 * config pre-fills every field, so the reader edits their setup rather than
 * starting over.
 *
 * Laid out as an app: Summary (the keys, the setup at a glance, the install
 * link), Search, Catalogs, Streams, and Account (profiles, backups, the
 * terms), one at a time, chosen from a bar of tabs along the bottom of a
 * phone or a column down the side of a wider screen. Every setting is in
 * one form whichever tab shows it; web/configure.js makes it all work.
 *
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {object|null} p.existing   a decoded config, or null for a new setup
 * @param {boolean} [p.serverTmdb]   whether this server has its own TMDB key
 * @param {Array<{ text: string, href: string }>} [p.credits]
 *                                   the data sources' attribution, shown in
 *                                   the Account tab as their terms ask
 * @param {object} [p.profile]       profiles' state for this request (profiles/index.js)
 */
function renderConfigurePage({ baseUrl, existing, serverTmdb = false, credits = [], profile = {} }) {
  const isReconfigure = Boolean(existing);
  const s = normalizeConfig(existing);
  const p = { ...NO_PROFILES, ...profile };
  // profile: signed in, editing it. signin: opened from a profile's install
  // link by someone not signed in to it. new: everything else.
  const mode = p.signedIn ? "profile" : p.signInId ? "signin" : "new";
  // Whether a profile can be made or signed in to right now.
  const usable = p.enabled && !p.unavailable;
  const submitLabel = mode === "profile" ? "Save changes" : usable ? "Create profile and get install link" : "Generate install link";
  // A new setup starts with no catalogs, for the reader to add the rows
  // they want; reconfiguring shows exactly what was saved. Search is on
  // unless switched off, either way.
  const startCatalogs = isReconfigure ? s.catalogs : [];
  const banners = profileBanners(p, mode, usable, isReconfigure);

  const tmdbNote = serverTmdb
    ? "This server already has a TMDB key that everyone shares, so you can leave this blank. Add your own only if you prefer to."
    : "Optional.";

  const pageData = {
    baseUrl,
    isReconfigure,
    playbackVersion: PLAYBACK_VERSION,
    marginUnits: MARGIN_UNITS,
    defaultMargins: DEFAULT_MARGINS,
    defaultExclude: DEFAULT_EXCLUDE,
    defaultExcludeDescription: DEFAULT_EXCLUDE_DESCRIPTION,
    defaultMovieQuery: DEFAULT_MOVIE_QUERY,
    defaultEpisodeQuery: DEFAULT_EPISODE_QUERY,
    defaultMaxResults: DEFAULT_MAX_RESULTS,
    maxResultsLimit: MAX_RESULTS_LIMIT,
    defaultMinViews: DEFAULT_MIN_VIEWS,
    maxMinViews: MAX_MIN_VIEWS,
    profile: { mode, usable, id: p.signedIn ? p.signedIn.id : null, imported: p.source === "import", passwordMin: PASSWORD_MIN }
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${ADDON_NAME} — Configure</title>
<link rel="icon" href="/logo.png" />
<link rel="manifest" href="/app.webmanifest" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="theme-color" content="${BACKGROUND}" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="${ADDON_NAME}" />
<style>${STYLE}</style>
</head>
<body>
${
  mode === "signin"
    ? `<div class="signin-view" id="signin-view">
  <header class="hero"><img src="/logo.png" alt="" /><div><h1>${ADDON_NAME}</h1><p>${escapeHtml(DESCRIPTION)}</p></div></header>
  ${banners}
  ${signInCard(p, mode)}
  <p class="hint">Not your profile, or starting over? <a href="/configure">Start a new setup</a>.</p>
  ${about(credits)}
</div>
`
    : ""
}<div id="setup"${mode === "signin" ? " hidden" : ""}>
<div class="app">
  <nav class="tabbar" aria-label="Sections">
      <a class="brand" href="#summary"><img src="/logo.png" alt="" /><span>${ADDON_NAME}</span></a>
      ${tabs(p.enabled ? "Account" : "More")}
  </nav>
  <main class="content">
  <form id="config-form" novalidate>
    <section class="panel" data-tab="summary" aria-labelledby="h-summary">
      <header class="hero">
        <img src="/logo.png" alt="" />
        <div><h1 id="h-summary">${ADDON_NAME}</h1><p>${escapeHtml(DESCRIPTION)}</p></div>
      </header>
      <button type="button" class="ghost-btn" id="install-app" hidden>Install the ${ADDON_NAME} app</button>
      ${banners}
      ${mode === "profile" ? installCard(p) : ""}

      <div class="card">
        <h3>YouTube API key</h3>
        <p class="lead">
          ${ADDON_NAME} searches YouTube with your own key, which is free. A key can search 100 times a day.
          A search is spent the first time a title is looked up, and nothing is spent after that for a day,
          however often it is opened again.
        </p>
        ${keyField({ id: "youtube-key", label: "YouTube API key", value: s.youtubeKey, placeholder: "AIza..." })}
        <div class="hint">
          How to get one:
          <ol>
            <li>Open the <a href="${YOUTUBE_KEY_URL}" target="_blank" rel="noopener">YouTube Data API v3</a> page in Google Cloud, pick or create a project, and press <strong>Enable</strong>.</li>
            <li>Go to <a href="${YOUTUBE_CREDENTIALS_URL}" target="_blank" rel="noopener">Credentials</a>, then <strong>Create credentials &rarr; API key</strong>.</li>
            <li>Leave <strong>Application restrictions</strong> at <strong>None</strong>: this server makes the calls, not your browser. Limiting the key to the YouTube Data API v3 is fine.</li>
          </ol>
          ${
            p.enabled
              ? "With a profile, your key is kept on this server, encrypted, and only your password or your install link opens it; without one, it lives only inside your install link"
              : "Your key is kept only inside your personal addon link; YouStream never stores it"
          } (see the <a href="/terms" target="_blank" rel="noopener">privacy policy</a>).
        </div>
      </div>

      <div class="card">
        <h3>TMDB key <span class="chip">optional</span></h3>
        <p class="lead">
          Lets ${ADDON_NAME} read the <code>tmdb:</code> ids Nuvio uses for some titles, and adds TMDB's cast
          lists and other names to the evidence a match needs.
        </p>
        ${keyField({ id: "tmdb-key", label: "TMDB key", value: s.tmdbKey, placeholder: "API key or Read Access Token" })}
        <div class="hint">${escapeHtml(tmdbNote)} Get one free under <a href="${TMDB_KEY_URL}" target="_blank" rel="noopener">TMDB settings &rarr; API</a>; either the API key or the Read Access Token works.</div>
      </div>

      <div class="card">
        <h3>Your setup</h3>
        <ul class="summary" id="summary-list"></ul>
      </div>

      ${usable && mode === "new" ? createSection(p) : ""}
      <div class="card" id="finish">
        <label class="check agree"${mode === "profile" ? " hidden" : ""}><input type="checkbox" id="agree"${isReconfigure ? " checked" : ""} />
          <span>I agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube Terms of Service</a> and to YouStream's <a href="/terms" target="_blank" rel="noopener">terms of use and privacy policy</a>.</span></label>
        <button type="submit" class="submit" id="submit-btn">${submitLabel}</button>
        ${
          usable && mode === "new"
            ? '<button type="button" class="link-btn" id="no-profile-btn">Or make an install link that carries your settings, without a profile</button>'
            : ""
        }
        <div id="result">
          <p class="warning" id="warning"></p>
          <a id="install-link" class="install-btn" href="#">Install in Stremio</a>
          <div class="url-row">
            <input id="manifest-url" type="text" readonly aria-label="Addon URL" />
            <button type="button" id="copy-btn">Copy</button>
          </div>
          <div class="hint">In Nuvio, or if the button does not open Stremio, paste the copied URL into the app's add-addon box. Keep it private: it contains your keys.</div>
        </div>
      </div>
    </section>

    <section class="panel" data-tab="search" aria-labelledby="h-search" hidden>
      ${panelHead("search", "Search", `How ${ADDON_NAME} finds films and episodes on YouTube, and what your app's own YouTube search shows.`)}
      <div class="card">
        <h3>Look for</h3>
        <div class="row-box">
          <label class="check"><input type="checkbox" id="type-movie"${s.types.includes("movie") ? " checked" : ""} />
            <span><strong>Movies</strong><em>Full films uploaded to YouTube.</em></span></label>
        </div>
        <div class="row-box">
          <label class="check"><input type="checkbox" id="type-series"${s.types.includes("series") ? " checked" : ""} />
            <span><strong>Series</strong><em>Episodes, including web series that only exist on YouTube, and anime from channels like Muse Asia and Ani-One.</em></span></label>
        </div>
        <div class="hint">Each type you switch off saves your daily searches for the rest. Switch both off to use ${ADDON_NAME} for YouTube alone.</div>
      </div>

      <div class="card">
        <h3>Results</h3>
        <div class="grid-2">
          <label class="field">
            <span class="label-text">Videos to list per title</span>
            <input type="number" id="max-results" min="1" max="${MAX_RESULTS_LIMIT}" step="1" inputmode="numeric" value="${s.maxResults}" />
          </label>
          <label class="field">
            <span class="label-text">Your country</span>
            <select id="region">${options(COUNTRIES, s.region, "Any country")}</select>
          </label>
        </div>
        <div class="grid-2">
          <label class="field">
            <span class="label-text">Audio language</span>
            <select id="audio-language">${options(LANGUAGES, s.audioLanguage, "Any language")}</select>
          </label>
          <label class="field">
            <span class="label-text">Minimum views</span>
            <input type="number" id="min-views" min="0" max="${MAX_MIN_VIEWS}" step="1" inputmode="numeric" value="${s.minViews}" />
          </label>
        </div>
        <div class="hint" style="margin-top:0;margin-bottom:12px">
          Your country hides videos that are blocked there and ranks results for it, YouTube search and Trending
          included. An audio language drops
          videos in another one &mdash; going by what the title says (&ldquo;Hindi dub&rdquo;) before YouTube's own
          tag, which channels often get wrong &mdash; adds it to movie searches (good for dubbed films), and ranks
          it first. Videos with no language known are kept. The view minimum keeps out nearly unwatched lookalikes;
          0 turns it off.
        </div>
        <div class="row-box">
          <label class="check"><input type="checkbox" id="official-only"${s.officialOnly ? " checked" : ""} />
            <span><strong>Only official channels</strong><em>Only uploads from YouTube content partners: studios, TV networks and the channels they license. Leaves out every unofficial copy, and with it some public-domain classics.</em></span></label>
        </div>
        <div class="row-box">
          <label class="check"><input type="checkbox" id="embeddable-only"${s.embeddableOnly ? " checked" : ""} />
            <span><strong>Only videos that allow embedding</strong><em>Turn on if you use Stremio Web, which plays YouTube in an embedded player. Nuvio and the YouTube app do not need it.</em></span></label>
        </div>
      </div>

      <div class="card">
        <h3>Runtime matching</h3>
        <p class="lead">
          A video only counts when its length is close to the listed runtime. This is what keeps trailers
          and clips out. A margin can be in seconds, minutes, or a percentage of the runtime. For example,
          a 23-minute episode with a 25-second margin accepts anything from 22m 35s to 23m 25s. The defaults
          come from measuring real uploads against their listings; the episode number, not the length, is
          what keeps the wrong episode out.
        </p>
        ${MARGIN_ROWS.map((row) => marginRow(row, s[row.name])).join("")}
      </div>

      <div class="card" id="youtube-card">
        <h3>YouTube search in your app</h3>
        <div class="row-box">
          <label class="check"><input type="checkbox" id="yt-search"${s.search ? " checked" : ""} />
            <span><strong>Search YouTube</strong><em>Your app's search shows a row of YouTube's own results, live. Each search costs one of your 100 a day, so ${ADDON_NAME} waits until you stop typing and skips anything under 3 letters.</em></span></label>
        </div>
        <div class="grid-2" style="margin-top:10px">
          <label class="field">
            <span class="label-text">Order search results by</span>
            <select id="search-sort">${choiceOptions(catalogs.SORTS, s.searchSort)}</select>
          </label>
          <label class="field">
            <span class="label-text">Video length</span>
            <select id="search-length">${choiceOptions(catalogs.LENGTHS, s.searchLength)}</select>
          </label>
        </div>
        <label class="field">
          <span class="label-text">SafeSearch</span>
          <select id="safe-search">${SAFE_SEARCH.map(
            (id) => `<option value="${id}"${id === s.safeSearch ? " selected" : ""}>${escapeHtml(SAFE_SEARCH_LABELS[id])}</option>`
          ).join("")}</select>
        </label>
        <div class="hint">SafeSearch applies to this search and to your search catalogs.</div>
      </div>

      <div class="card">
        <details id="fine-tuning">
          <summary>Fine-tuning</summary>
          <label class="field">
            <span class="label-text">Movie search</span>
            <input type="text" id="movie-query" maxlength="${MAX_QUERY_LENGTH}" value="${escapeHtml(s.movieQuery)}" spellcheck="false" />
            <button type="button" class="reset" data-reset="movie-query">Reset to default</button>
          </label>
          <label class="field">
            <span class="label-text">Episode search</span>
            <input type="text" id="episode-query" maxlength="${MAX_QUERY_LENGTH}" value="${escapeHtml(s.episodeQuery)}" spellcheck="false" />
            <button type="button" class="reset" data-reset="episode-query">Reset to default</button>
          </label>
          <div class="hint" style="margin-bottom:14px">
            Placeholders: {title} {year} {season} {episode} {s00e00} {episodeTitle} {absolute} {language}.
            {title} is required. Every search costs one of your 100 a day, so there is one per title.
          </div>
          <label class="field">
            <span class="label-text">Skip videos whose title says (comma separated)</span>
            <textarea id="exclude" spellcheck="false">${escapeHtml(s.exclude.join(", "))}</textarea>
            <button type="button" class="reset" data-reset="exclude">Reset to default</button>
          </label>
          <div class="hint" style="margin-bottom:14px">A word that is part of the title's own name is ignored for that title, so &ldquo;trailer&rdquo; never hides Trailer Park Boys.</div>
          <label class="field">
            <span class="label-text">Skip videos whose description says (comma separated)</span>
            <textarea id="exclude-description" spellcheck="false">${escapeHtml(s.excludeDescription.join(", "))}</textarea>
            <button type="button" class="reset" data-reset="exclude-description">Reset to default</button>
          </label>
          <div class="hint">How fan films, explainers, video essays and unofficial copies describe themselves: &ldquo;fan movie&rdquo;, &ldquo;in this video&rdquo;, &ldquo;video essay&rdquo;, &ldquo;fair use&rdquo;.</div>
        </details>
      </div>
    </section>

    <section class="panel" data-tab="catalogs" aria-labelledby="h-catalogs" hidden>
      ${panelHead(
        "catalogs",
        "Catalogs",
        "Rows on your app's home screen, <strong>in this order</strong>: YouTube searches, channels, playlists and Trending. A video you open from one plays the ways you choose under Streams, and one you save to your library is listed under the type <strong>youtube</strong>."
      )}
      <div class="card">
        <h3>Your rows</h3>
        <p class="hint cat-lead">
          Choose where a row's videos come from, type the search or paste the playlist or channel, then choose
          how its videos are ordered. Use the arrows to arrange them.
        </p>
        <div id="catalog-list"></div>
        <div class="add-row source-row">
          <select id="catalog-source" aria-label="Where the catalog's videos come from">${choiceOptions(CATALOG_SOURCES, CATALOG_SOURCES[0].id)}</select>
          <input type="text" id="catalog-input" maxlength="500" placeholder="${escapeHtml(CATALOG_SOURCES[0].placeholder)}" aria-label="${escapeHtml(CATALOG_SOURCES[0].prompt)}" spellcheck="false" />
          <button type="button" class="add-btn" id="catalog-add">Add</button>
        </div>
        <div class="hint" id="catalog-note" role="status"></div>
        <span class="sub-label">Trending in your country</span>
        <div class="chips" id="trending-chips"></div>
      </div>

      <div class="card">
        <h3>Refreshing</h3>
        <div class="field">
          <span class="label-text">Refresh catalogs every</span>
          <div class="inline-inputs">
            <input type="number" id="refresh-value" min="0" step="any" inputmode="decimal" value="${escapeHtml(s.catalogRefresh.value)}" aria-label="Refresh catalogs every" />
            <select id="refresh-unit" aria-label="Refresh unit">${Object.entries(REFRESH_UNITS)
              .map(([unit, info]) => `<option value="${unit}"${unit === s.catalogRefresh.unit ? " selected" : ""}>${escapeHtml(info.label)}</option>`)
              .join("")}</select>
          </div>
        </div>
        <div class="hint">
          A search catalog costs one of your 100 daily searches each time it refreshes; a channel, a playlist or a
          Trending row costs almost nothing. A row refreshes only when your app shows it after this long: every
          ${DEFAULT_CATALOG_REFRESH.value} hours unless you change it, and at most every 30 minutes. YouTube's terms let a
          server keep its data 30 days at most, so anything longer refreshes then.
          <span id="quota-note"></span>
        </div>
      </div>
    </section>

    <section class="panel" data-tab="streams" aria-labelledby="h-streams" hidden>
      ${panelHead("streams", "Streams", "How each video found is offered in your app, and how its stream reads there.")}
      <div class="card">
        <h3>When you press play</h3>
        <p class="lead">Each video found is offered these ways, in this order. The first one is what the play button lands on.</p>
        <ul id="pb-options">${playbackRows(s.playback)}
        </ul>
      </div>

      <div class="card format">
        <h3>Stream name and description</h3>
        <p class="hint" style="margin:0 0 12px">
          How each stream reads in your app. Templates use AIOStreams' formatter syntax, which PenguPlay uses too,
          so one made for either works here: <code>{video.channel::upper}</code>,
          <code>{video.live::istrue["🔴 Live"||""]}</code>, and <code>{? … ?}</code> for a part shown only when its
          fields have values. <a href="${FORMATTER_DOCS_URL}" target="_blank" rel="noopener">The syntax</a>
        </p>
        <label class="field">
          <span class="label-text">Preset</span>
          <select id="format-preset">${presetOptions(s.format)}</select>
        </label>
        <label class="field">
          <span class="label-text">Name</span>
          <textarea id="name-template" class="code" rows="2" maxlength="${MAX_NAME_TEMPLATE}" spellcheck="false">${escapeHtml(s.nameTemplate)}</textarea>
        </label>
        <label class="field">
          <span class="label-text">Description</span>
          <textarea id="description-template" class="code" rows="8" maxlength="${MAX_DESCRIPTION_TEMPLATE}" spellcheck="false">${escapeHtml(s.descriptionTemplate)}</textarea>
        </label>
        <div class="preview-head">
          <span class="label-text">Preview</span>
          <div class="preview-tabs">
            <button type="button" class="preview-tab" data-sample="film" aria-pressed="true">Film</button>
            <button type="button" class="preview-tab" data-sample="episode" aria-pressed="false">Episode</button>
            <button type="button" class="preview-tab" data-sample="video" aria-pressed="false">YouTube video</button>
          </div>
        </div>
        <ul id="format-preview" class="preview" aria-live="polite"></ul>
        <ul id="format-warnings" class="format-warnings"></ul>
        <details class="fields-help">
          <summary>Fields</summary>
          <table>${FIELD_HELP.map(([field, about]) => `<tr><td><code>{${escapeHtml(field)}}</code></td><td>${escapeHtml(about)}</td></tr>`).join("")}</table>
          <p class="hint">Every field AIOStreams documents works too; those YouTube has nothing for, such as sizes and seeders, are empty.
          AIOStreams itself reads each stream's resolution, quality, year, episode and language from the release name,
          so its filters and sorting work the same whatever these templates say.</p>
        </details>
      </div>
    </section>
  </form>

    <section class="panel" data-tab="account" aria-labelledby="h-account" hidden>
      ${panelHead(
        "account",
        p.enabled ? "Account" : "More",
        mode === "profile"
          ? "Your profile: signing out, backups, its password and its install link."
          : usable
            ? "Sign in to a profile, or keep your settings in a file."
            : "Keep your settings in a file."
      )}
      ${mode === "profile" ? profileBar(p) : ""}
      ${usable && mode === "new" ? signInCard(p, mode) : ""}
      ${backupsCard()}
      ${mode === "profile" ? securityCard() : ""}
      ${about(credits)}
    </section>
  </main>
</div>
  <div class="toasts" aria-live="polite">
    <p id="error" style="display:none" role="alert" title="Dismiss"></p>
    <p class="msg" id="save-status" role="status" hidden></p>
  </div>
  ${
    mode === "profile"
      ? '<div class="action-bar" id="save-bar" hidden><span>Unsaved changes</span><button type="button" class="ghost-btn" id="save-bar-discard">Discard</button><button type="button" class="primary" id="save-bar-btn">Save</button></div>'
      : '<div class="action-bar" id="finish-bar" hidden><span>Ready to install?</span><button type="button" class="primary" id="finish-go">Get install link</button></div>'
  }
</div>

<script type="application/json" id="page-data">${jsonForScript(pageData)}</script>
<script type="application/json" id="youtube-data">${jsonForScript(youtubeData(startCatalogs))}</script>
<script type="application/json" id="format-data">${jsonForScript({
    presets: PRESETS,
    defaultFormat: DEFAULT_FORMAT,
    languages: FORMATTER_LANGUAGES,
    maxName: MAX_NAME_TEMPLATE,
    maxDescription: MAX_DESCRIPTION_TEMPLATE,
    ...previewData(identity().name)
  })}</script>
<script src="/configure.js?v=${configureScript().version}" defer></script>
</body>
</html>`;
}

module.exports = { renderConfigurePage, escapeHtml, jsonForScript, REPO_URL, FORMATTER_DOCS_URL };
