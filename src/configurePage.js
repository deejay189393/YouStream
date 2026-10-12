const { DESCRIPTION, ADDON_NAME } = require("./manifest");
const { orderedPlaybackOptions, PLAYBACK_VERSION } = require("./playback");
const { COUNTRIES, LANGUAGES } = require("./regions");
const {
  normalizeConfig,
  MARGIN_UNITS,
  DEFAULT_MARGINS,
  DEFAULT_EXCLUDE,
  DEFAULT_MOVIE_QUERY,
  DEFAULT_EPISODE_QUERY,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  DEFAULT_MIN_VIEWS,
  MAX_MIN_VIEWS,
  MAX_QUERY_LENGTH
} = require("./config");

/** Where the addon's source lives, linked from the footer. */
const REPO_URL = "https://github.com/deejay189393/YouStream";
const YOUTUBE_KEY_URL = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
const YOUTUBE_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const TMDB_KEY_URL = "https://www.themoviedb.org/settings/api";

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

const MARGIN_ROWS = [
  {
    name: "movieMargin",
    label: "Movies",
    note: "Around the film's runtime."
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
              <input type="number" class="margin-value" min="0" step="any" inputmode="decimal" value="${escapeHtml(
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
                <input type="checkbox" class="pb-on"${option.enabled ? " checked" : ""} />
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

function options(list, selected, anyLabel) {
  const any = `<option value=""${selected ? "" : " selected"}>${escapeHtml(anyLabel)}</option>`;
  return (
    any +
    list
      .map((item) => `<option value="${item.code}"${item.code === selected ? " selected" : ""}>${escapeHtml(item.label)}</option>`)
      .join("")
  );
}

/**
 * The configure page. Also the RE-configure page: an installed addon's
 * "Configure" button opens /<config>/configure, and the decoded `existing`
 * config pre-fills every field, so the reader edits their setup rather than
 * starting over.
 *
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {object|null} p.existing   a decoded config, or null for a new setup
 * @param {boolean} [p.serverTmdb]   whether this server has its own TMDB key
 */
function renderConfigurePage({ baseUrl, existing, serverTmdb = false }) {
  const isReconfigure = Boolean(existing);
  const s = normalizeConfig(existing);

  const tmdbNote = serverTmdb
    ? "This server already has a TMDB key that everyone shares, so you can leave this blank. Add your own only if you prefer to."
    : "Optional. Without it, episodes are matched against the show's usual episode length, which is looser, and tmdb: ids are not looked up.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${ADDON_NAME} — Configure</title>
<link rel="icon" href="/logo.png" />
<style>
  :root {
    --bg: #0f1013; --card: #17181d; --border: #2b2d36; --field: #0c0d10;
    --text: #eef0f4; --muted: #9ea3ae; --accent: #ff3355; --accent-2: #ff6b81; --warn: #ffb020;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .wrap { max-width: 640px; margin: 0 auto; padding: 32px 16px 60px; }
  header { text-align: center; margin-bottom: 28px; }
  header img { width: 72px; height: 72px; border-radius: 16px; margin-bottom: 12px; }
  header h1 { font-size: 22px; margin: 0 0 6px; }
  header p { color: var(--muted); margin: 0 0 4px; font-size: 14px; line-height: 1.5; }
  .banner {
    background: rgba(255,51,85,.12); border: 1px solid var(--accent);
    border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 18px;
  }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; margin-bottom: 18px; }
  .card h2 { font-size: 15px; margin: 0 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .card .lead { font-size: 13px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  .chip {
    display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 6px; border-radius: 5px; background: rgba(255,51,85,.2); color: var(--accent-2); margin-left: 6px;
    vertical-align: middle;
  }
  input[type="password"], input[type="text"], input[type="number"], select, textarea {
    width: 100%; background: var(--field); border: 1px solid var(--border); color: var(--text);
    padding: 11px 12px; border-radius: 9px; font-size: 15px; font-family: inherit;
  }
  textarea { min-height: 96px; resize: vertical; font-size: 13px; line-height: 1.5; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent-2); }
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
  .key-toggle:hover { color: var(--text); border-color: var(--accent-2); }
  .key-toggle .eye-slash { display: none; }
  .key-toggle[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
  .key-toggle[aria-pressed="true"] .eye-slash { display: inline; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.55; }
  .hint a, .lead a { color: var(--accent-2); }
  .hint ol { margin: 6px 0 0; padding-left: 18px; }
  .check { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; margin: 0; flex: 1 1 auto; }
  .check input { width: 16px; height: 16px; margin-top: 2px; flex: 0 0 auto; accent-color: var(--accent); }
  .check strong { display: block; font-size: 14px; font-weight: 600; }
  .check em { display: block; font-size: 12px; color: var(--muted); font-style: normal; margin-top: 2px; line-height: 1.45; }
  .row-box {
    display: flex; align-items: center; gap: 10px; background: #121318;
    border: 1px solid var(--border); border-radius: 9px; padding: 10px 11px; margin-bottom: 6px;
  }
  .margin-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px; background: #121318;
    border: 1px solid var(--border); border-radius: 9px; padding: 10px 11px; margin-bottom: 6px;
  }
  .margin-label { flex: 1 1 200px; min-width: 0; }
  .margin-label strong { display: block; font-size: 14px; }
  .margin-label em { display: block; font-size: 12px; color: var(--muted); font-style: normal; margin-top: 2px; }
  .margin-inputs { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .margin-inputs .pm { color: var(--muted); font-size: 16px; }
  .margin-inputs input { width: 84px; padding: 8px 10px; font-size: 14px; }
  .margin-inputs select { width: auto; padding: 8px 10px; font-size: 14px; }
  #pb-options { list-style: none; margin: 0; padding: 0; }
  .pb-option {
    display: flex; align-items: center; gap: 10px; background: #121318;
    border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; margin-bottom: 6px;
  }
  .pb-move { display: flex; gap: 4px; flex: 0 0 auto; }
  .pb-move button {
    width: 28px; height: 28px; background: var(--field); border: 1px solid var(--border);
    color: var(--muted); border-radius: 7px; cursor: pointer; font-size: 10px; line-height: 1; padding: 0;
  }
  .pb-move button:disabled { opacity: .3; cursor: default; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 480px) { .grid-2 { grid-template-columns: 1fr; } }
  details summary { cursor: pointer; font-size: 15px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
  details[open] summary { margin-bottom: 12px; }
  .reset { background: none; border: none; color: var(--accent-2); font-size: 12px; cursor: pointer; padding: 0; margin-top: 6px; }
  .submit {
    width: 100%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; border: none;
    padding: 14px; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer;
  }
  .submit:disabled { opacity: .6; cursor: progress; }
  #result { margin-top: 18px; display: none; }
  #result.show { display: block; }
  .result-box { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  .result-box a.install-btn {
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
  .error { color: #ff6b6b; font-size: 13px; margin-top: 10px; line-height: 1.5; }
  .warning { color: var(--warn); font-size: 13px; margin: 0 0 10px; line-height: 1.5; display: none; }
  footer { margin: 26px 0 8px; text-align: center; }
  footer a { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 13px; text-decoration: none; }
  footer a:hover { color: var(--text); text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="/logo.png" alt="${ADDON_NAME}" />
    <h1>${ADDON_NAME}</h1>
    <p>${escapeHtml(DESCRIPTION)}</p>
  </header>

  ${isReconfigure ? '<div class="banner">Editing your current setup: everything is pre-filled. Generate a new link and install it to apply your changes.</div>' : ""}

  <form id="config-form" novalidate>
    <div class="card">
      <h2>YouTube API key</h2>
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
        Your key is stored only inside your personal addon link, never on this server.
      </div>
    </div>

    <div class="card">
      <h2>TMDB key <span class="chip">optional</span></h2>
      <p class="lead">
        TMDB knows each episode's own runtime, so episodes can be matched to the second rather than
        against the show's usual length. It also lets ${ADDON_NAME} read the <code>tmdb:</code> ids Nuvio uses for some titles.
      </p>
      ${keyField({ id: "tmdb-key", label: "TMDB key", value: s.tmdbKey, placeholder: "API key or Read Access Token" })}
      <div class="hint">${escapeHtml(tmdbNote)} Get one free under <a href="${TMDB_KEY_URL}" target="_blank" rel="noopener">TMDB settings &rarr; API</a>; either the API key or the Read Access Token works.</div>
    </div>

    <div class="card">
      <h2>Look for</h2>
      <div class="row-box">
        <label class="check"><input type="checkbox" id="type-movie"${s.types.includes("movie") ? " checked" : ""} />
          <span><strong>Movies</strong><em>Full films uploaded to YouTube.</em></span></label>
      </div>
      <div class="row-box">
        <label class="check"><input type="checkbox" id="type-series"${s.types.includes("series") ? " checked" : ""} />
          <span><strong>Series</strong><em>Episodes, including web series that only exist on YouTube, and anime from channels like Muse Asia and Ani-One.</em></span></label>
      </div>
      <div class="hint">Each type you switch off saves your daily searches for the other.</div>
    </div>

    <div class="card">
      <h2>Runtime matching</h2>
      <p class="lead">
        A video only counts when its length is close to the listed runtime. This is what keeps trailers,
        clips and reviews out. A margin can be in seconds, minutes, or a percentage of the runtime.
        For example, a 23-minute episode with a 25-second margin accepts anything from 22m 35s to 23m 25s.
      </p>
      ${MARGIN_ROWS.map((row) => marginRow(row, s[row.name])).join("")}
    </div>

    <div class="card">
      <h2>When you press play</h2>
      <p class="lead">Each video found is offered these ways, in this order. The first one is what the play button lands on.</p>
      <ul id="pb-options">${playbackRows(s.playback)}
      </ul>
    </div>

    <div class="card">
      <h2>Results</h2>
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
        Your country hides videos that are blocked there and ranks results for it. An audio language drops
        videos in another one &mdash; going by what the title says (&ldquo;Hindi dub&rdquo;) before YouTube's own
        tag, which channels often get wrong &mdash; adds it to movie searches (good for dubbed films), and ranks
        it first. Videos with no language known are kept. The view minimum keeps out nearly unwatched lookalikes;
        0 turns it off.
      </div>
      <div class="row-box">
        <label class="check"><input type="checkbox" id="embeddable-only"${s.embeddableOnly ? " checked" : ""} />
          <span><strong>Only videos that allow embedding</strong><em>Turn on if you use Stremio Web, which plays YouTube in an embedded player. Nuvio and the YouTube app do not need it.</em></span></label>
      </div>
    </div>

    <div class="card">
      <details id="advanced">
        <summary>Advanced</summary>
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
        <div class="hint">A word that is part of the title's own name is ignored for that title, so &ldquo;trailer&rdquo; never hides Trailer Park Boys.</div>
      </details>
    </div>

    <button type="submit" class="submit" id="submit-btn">Generate install link</button>
    <div class="error" id="error" style="display:none" role="alert"></div>
  </form>

  <div id="result">
    <div class="result-box">
      <p class="warning" id="warning"></p>
      <a id="install-link" class="install-btn" href="#">Install in Stremio</a>
      <div class="url-row">
        <input id="manifest-url" type="text" readonly aria-label="Addon URL" />
        <button type="button" id="copy-btn">Copy</button>
      </div>
      <div class="hint">In Nuvio, or if the button does not open Stremio, paste the copied URL into the app's add-addon box. Keep it private: it contains your keys.</div>
    </div>
  </div>

  <footer>
    <a href="${REPO_URL}" target="_blank" rel="noopener">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      Source code on GitHub
    </a>
  </footer>
</div>

<script>
  // NOTE: this script lives inside a JS template literal, which consumes
  // backslash escapes before the browser sees them. A regex or escape written
  // here arrives mangled and can kill the whole script at parse time, which
  // silently disables every control on the page. Keep this block
  // backslash-free; test/configurePage.dom.test.js runs it and enforces that.
  var BASE_URL = ${jsonForScript(baseUrl)};
  var IS_RECONFIGURE = ${isReconfigure ? "true" : "false"};
  var PLAYBACK_VERSION = ${PLAYBACK_VERSION};
  var MARGIN_UNITS = ${jsonForScript(MARGIN_UNITS)};
  var DEFAULT_MARGINS = ${jsonForScript(DEFAULT_MARGINS)};
  var DEFAULT_EXCLUDE = ${jsonForScript(DEFAULT_EXCLUDE)};
  var DEFAULT_MOVIE_QUERY = ${jsonForScript(DEFAULT_MOVIE_QUERY)};
  var DEFAULT_EPISODE_QUERY = ${jsonForScript(DEFAULT_EPISODE_QUERY)};
  var DEFAULT_MAX_RESULTS = ${DEFAULT_MAX_RESULTS};
  var MAX_RESULTS_LIMIT = ${MAX_RESULTS_LIMIT};
  var DEFAULT_MIN_VIEWS = ${DEFAULT_MIN_VIEWS};
  var MAX_MIN_VIEWS = ${MAX_MIN_VIEWS};
  var DEFAULTS = { "movie-query": DEFAULT_MOVIE_QUERY, "episode-query": DEFAULT_EPISODE_QUERY, exclude: DEFAULT_EXCLUDE.join(", ") };
  var KEY_PROBLEMS = {
    missing: "Enter your YouTube API key.",
    invalid: "YouTube says this key is not valid. Copy it again from the Google Cloud console.",
    disabled: "This key's Google Cloud project does not have the YouTube Data API v3 enabled. Enable it, wait a minute, and try again.",
    restricted: "This key is restricted to certain websites, apps or IP addresses, so this server cannot use it. In the Google Cloud console set Application restrictions to None. Limiting it to the YouTube Data API v3 is fine."
  };
  var TMDB_INVALID = "TMDB says this key is not valid. Paste the API key or the Read Access Token from your TMDB settings, or leave it blank.";
  var QUOTA_WARNING = "Your key works, but its YouTube quota for today is already spent. It refills at midnight Pacific time; until then nothing new can be searched.";

  var form = document.getElementById("config-form");
  var errorEl = document.getElementById("error");
  var warningEl = document.getElementById("warning");
  var resultEl = document.getElementById("result");
  var submitBtn = document.getElementById("submit-btn");
  var installLink = document.getElementById("install-link");
  var manifestUrlInput = document.getElementById("manifest-url");
  var copyBtn = document.getElementById("copy-btn");

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
    resultEl.classList.remove("show");
  }

  function hideError() {
    errorEl.style.display = "none";
  }

  // Characters that may appear in a key: letters, digits, dot, dash and
  // underscore. Checked by hand because this script cannot hold a regex.
  function isKeyText(text) {
    var allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
    for (var i = 0; i < text.length; i++) {
      if (allowed.indexOf(text.charAt(i)) === -1) return false;
    }
    return true;
  }

  // Digits only: no sign, no exponent.
  function isWholeNumber(text) {
    if (!text.length) return false;
    for (var i = 0; i < text.length; i++) {
      if ("0123456789".indexOf(text.charAt(i)) === -1) return false;
    }
    return true;
  }

  // Digits with at most one decimal point.
  function isDecimal(text) {
    var parts = text.split(".");
    if (parts.length > 2) return false;
    if (!isWholeNumber(parts[0])) return false;
    return parts.length === 1 || isWholeNumber(parts[1]);
  }

  // Show or hide a key so it can be read back when reconfiguring.
  Array.prototype.forEach.call(document.querySelectorAll(".key-toggle"), function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-for"));
      var reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      btn.setAttribute("aria-pressed", reveal ? "true" : "false");
      btn.setAttribute("title", reveal ? "Hide key" : "Show key");
    });
  });

  // The ways to watch: each on or off, and movable. Their order is the
  // order the app lists them.
  var pbList = document.getElementById("pb-options");
  function pbRows() {
    return Array.prototype.slice.call(pbList.querySelectorAll(".pb-option"));
  }
  function refreshPbArrows() {
    var rows = pbRows();
    rows.forEach(function (row, i) {
      row.querySelector(".pb-up").disabled = i === 0;
      row.querySelector(".pb-down").disabled = i === rows.length - 1;
    });
  }
  function movePb(row, delta) {
    var rows = pbRows();
    var target = rows.indexOf(row) + delta;
    if (target < 0 || target >= rows.length) return;
    if (delta < 0) pbList.insertBefore(row, rows[target]);
    else pbList.insertBefore(rows[target], row);
    refreshPbArrows();
  }
  pbRows().forEach(function (row) {
    row.querySelector(".pb-up").addEventListener("click", function () { movePb(row, -1); });
    row.querySelector(".pb-down").addEventListener("click", function () { movePb(row, 1); });
  });
  refreshPbArrows();

  Array.prototype.forEach.call(document.querySelectorAll(".reset"), function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var id = btn.getAttribute("data-reset");
      document.getElementById(id).value = DEFAULTS[id];
    });
  });

  // A new setup starts in the reader's own country, read from the browser's
  // language tag ("en-IN" is India). Reconfiguring keeps what was saved.
  var regionSelect = document.getElementById("region");
  if (!IS_RECONFIGURE && !regionSelect.value) {
    var tag = (navigator.language || "").split("-");
    var guess = tag.length > 1 ? tag[tag.length - 1].toUpperCase() : "";
    for (var r = 0; r < regionSelect.options.length; r++) {
      if (guess && regionSelect.options[r].value === guess) regionSelect.value = guess;
    }
  }

  // Reads the form into a config, or returns an error message.
  function readConfig() {
    var youtubeKey = document.getElementById("youtube-key").value.trim();
    var tmdbKey = document.getElementById("tmdb-key").value.trim();
    if (!youtubeKey) return "Enter your YouTube API key.";
    if (!isKeyText(youtubeKey)) return "That YouTube key has characters a key never has. Copy it again, without spaces.";
    if (tmdbKey && !isKeyText(tmdbKey)) return "That TMDB key has characters a key never has. Copy it again, without spaces.";

    var types = [];
    if (document.getElementById("type-movie").checked) types.push("movie");
    if (document.getElementById("type-series").checked) types.push("series");
    if (!types.length) return "Choose movies, series, or both.";

    var config = { youtubeKey: youtubeKey };
    if (tmdbKey) config.tmdbKey = tmdbKey;

    var rows = document.querySelectorAll(".margin-row");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var name = row.getAttribute("data-margin");
      var text = row.querySelector(".margin-value").value.trim();
      var unit = row.querySelector(".margin-unit").value;
      var label = row.querySelector("strong").textContent;
      if (!isDecimal(text)) return label + ": enter the margin as a number, 0 or more.";
      var value = parseFloat(text);
      if (value > MARGIN_UNITS[unit].max) return label + ": at most " + MARGIN_UNITS[unit].max + " " + MARGIN_UNITS[unit].label + ".";
      var d = DEFAULT_MARGINS[name];
      if (value !== d.value || unit !== d.unit) config[name] = value + unit;
    }

    var playback = pbRows()
      .filter(function (row) { return row.querySelector(".pb-on").checked; })
      .map(function (row) { return row.getAttribute("data-option"); });
    if (!playback.length) return "Turn on at least one way to watch.";
    config.playback = playback;
    config.playbackVersion = PLAYBACK_VERSION;

    if (types.length === 1) config.types = types;

    var maxText = document.getElementById("max-results").value.trim();
    if (!isWholeNumber(maxText) || parseInt(maxText, 10) < 1 || parseInt(maxText, 10) > MAX_RESULTS_LIMIT) {
      return "Videos to list: a whole number from 1 to " + MAX_RESULTS_LIMIT + ".";
    }
    var maxResults = parseInt(maxText, 10);
    if (maxResults !== DEFAULT_MAX_RESULTS) config.maxResults = maxResults;

    var minViewsText = document.getElementById("min-views").value.trim();
    if (!isWholeNumber(minViewsText) || parseInt(minViewsText, 10) > MAX_MIN_VIEWS) {
      return "Minimum views: a whole number, 0 or more.";
    }
    var minViews = parseInt(minViewsText, 10);
    if (minViews !== DEFAULT_MIN_VIEWS) config.minViews = minViews;

    var region = regionSelect.value;
    if (region) config.region = region;
    var audioLanguage = document.getElementById("audio-language").value;
    if (audioLanguage) config.audioLanguage = audioLanguage;
    if (document.getElementById("embeddable-only").checked) config.embeddableOnly = true;

    var movieQuery = document.getElementById("movie-query").value.trim();
    var episodeQuery = document.getElementById("episode-query").value.trim();
    if (movieQuery.indexOf("{title}") === -1 || episodeQuery.indexOf("{title}") === -1) {
      return "Both searches need {title} in them.";
    }
    if (movieQuery !== DEFAULT_MOVIE_QUERY) config.movieQuery = movieQuery;
    if (episodeQuery !== DEFAULT_EPISODE_QUERY) config.episodeQuery = episodeQuery;

    var exclude = [];
    document.getElementById("exclude").value.split(",").forEach(function (word) {
      var w = word.trim().toLowerCase();
      if (w && exclude.indexOf(w) === -1) exclude.push(w);
    });
    if (exclude.join(",") !== DEFAULT_EXCLUDE.join(",")) config.exclude = exclude;

    return config;
  }

  function showResult(config, warning) {
    // One path segment of encodeURIComponent(JSON.stringify(config)): the
    // stremio-addon-sdk convention.
    var segment = encodeURIComponent(JSON.stringify(config));
    var base = BASE_URL;
    while (base.length && base.charAt(base.length - 1) === "/") base = base.slice(0, -1);
    var httpUrl = base + "/" + segment + "/manifest.json";
    var schemeEnd = httpUrl.indexOf("://");
    installLink.href = schemeEnd === -1 ? httpUrl : "stremio://" + httpUrl.slice(schemeEnd + 3);
    manifestUrlInput.value = httpUrl;
    warningEl.textContent = warning || "";
    warningEl.style.display = warning ? "block" : "none";
    resultEl.classList.add("show");
    if (resultEl.scrollIntoView) resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function finishChecking() {
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate install link";
  }

  // Asks the server to try the keys, so a bad one is caught here rather
  // than discovered later as an empty stream list. If the check itself
  // cannot run, the link is built anyway: the keys may well be fine.
  function checkKeys(config) {
    if (typeof fetch !== "function") {
      showResult(config, "");
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Checking your keys...";
    fetch("/api/check-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ youtubeKey: config.youtubeKey, tmdbKey: config.tmdbKey || "" })
    })
      .then(function (res) { return res.json(); })
      .then(function (status) {
        finishChecking();
        if (KEY_PROBLEMS[status.youtube]) return showError(KEY_PROBLEMS[status.youtube]);
        if (status.tmdb === "invalid") return showError(TMDB_INVALID);
        showResult(config, status.youtube === "quota" ? QUOTA_WARNING : "");
      })
      .catch(function () {
        finishChecking();
        showResult(config, "");
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();
    var config = readConfig();
    if (typeof config === "string") {
      showError(config);
      return;
    }
    checkKeys(config);
  });

  copyBtn.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifestUrlInput.value).then(function () {
        copyBtn.textContent = "Copied!";
        setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
      }).catch(function () { manifestUrlInput.select(); });
    } else {
      manifestUrlInput.select();
    }
  });
</script>
</body>
</html>`;
}

module.exports = { renderConfigurePage, escapeHtml, jsonForScript, REPO_URL };
