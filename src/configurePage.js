const fs = require("fs");
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

/** Where the addon's source lives, linked from the footer. */
const REPO_URL = "https://github.com/deejay189393/YouStream";
const YOUTUBE_KEY_URL = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
const YOUTUBE_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const TMDB_KEY_URL = "https://www.themoviedb.org/settings/api";
const FORMATTER_DOCS_URL = "https://docs.aiostreams.viren070.me/reference/custom-formatter";

/**
 * A module's code as a plain script for the page: the file as written,
 * without its module.exports line. Read from disk rather than taken from
 * the loaded function, whose text a coverage tool may have rewritten.
 */
function browserSource(file) {
  const text = fs.readFileSync(require.resolve(file), "utf8").replace(/\nmodule\.exports = [^\n]*\n*$/, "\n");
  if (/<\/script/i.test(text)) throw new Error(`${file} cannot be inlined in a page`);
  return text;
}
const FORMATTER_SOURCE = browserSource("./formatter");
const TEMPLATE_CHECK_SOURCE = browserSource("./templateCheck");

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
  ["video.definition", "HD or SD"],
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
 * @param {Array<{ text: string, href: string }>} [p.credits]
 *                                   the data sources' attribution, shown in
 *                                   the footer as their terms ask
 */
function renderConfigurePage({ baseUrl, existing, serverTmdb = false, credits = [] }) {
  const isReconfigure = Boolean(existing);
  const s = normalizeConfig(existing);
  // A new setup starts with search on and no catalogs, for the reader to
  // add the rows they want. Reconfiguring shows exactly what was saved --
  // for an addon installed before search existed, search off.
  const searchOn = isReconfigure ? s.search : true;
  const startCatalogs = isReconfigure ? s.catalogs : [];

  const tmdbNote = serverTmdb
    ? "This server already has a TMDB key that everyone shares, so you can leave this blank. Add your own only if you prefer to."
    : "Optional.";

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
    --text: #eef0f4; --muted: #9ea3ae; --accent: #7a1a2b; --accent-2: #a3263c; --link: #e29aa7; --warn: #ffb020;
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
    background: rgba(122,26,43,.25); border: 1px solid var(--accent-2);
    border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 18px;
  }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; margin-bottom: 18px; }
  .card h2 { font-size: 15px; margin: 0 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .card .lead { font-size: 13px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  .chip {
    display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 6px; border-radius: 5px; background: rgba(122,26,43,.45); color: var(--link); margin-left: 6px;
    vertical-align: middle;
  }
  input[type="password"], input[type="text"], input[type="number"], select, textarea {
    width: 100%; background: var(--field); border: 1px solid var(--border); color: var(--text);
    padding: 11px 12px; border-radius: 9px; font-size: 15px; font-family: inherit;
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
  .hint a, .lead a { color: var(--link); }
  .hint ol { margin: 6px 0 0; padding-left: 18px; }
  .check { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; margin: 0; flex: 1 1 auto; }
  .check input { width: 16px; height: 16px; margin-top: 2px; flex: 0 0 auto; accent-color: var(--accent-2); }
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
  .reset { background: none; border: none; color: var(--link); font-size: 12px; cursor: pointer; padding: 0; margin-top: 6px; }
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
  footer .credits, footer .disclaimer { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
  footer .credits a, footer .disclaimer a { display: inline; font-size: 12px; }
  footer .credits img { vertical-align: middle; margin-right: 4px; }
  footer .disclaimer a { text-decoration: underline; }
  textarea.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; min-height: 0; }
  .format { margin-bottom: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
  .format .hint code, .fields-help code { color: var(--text); font-size: 11.5px; }
  .preview-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
  .preview-head .label-text { margin: 0; }
  .preview-tabs { display: flex; gap: 6px; }
  .preview-tabs button {
    background: var(--field); border: 1px solid var(--border); color: var(--muted); border-radius: 7px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .preview-tabs button[aria-pressed="true"] { color: var(--text); border-color: var(--link); }
  .preview { list-style: none; margin: 0 0 10px; padding: 0; }
  .preview li {
    display: flex; gap: 12px; background: #121318; border: 1px solid var(--border); border-radius: 9px;
    padding: 10px 12px; margin-bottom: 6px;
  }
  .preview .p-name { flex: 0 0 32%; font-weight: 700; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .preview .p-desc { flex: 1 1 auto; min-width: 0; font-size: 12.5px; color: #d8dbe2; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  @media (max-width: 480px) { .preview li { flex-direction: column; gap: 4px; } .preview .p-name { flex-basis: auto; } }
  .format-warnings { list-style: none; padding: 0; margin: 0 0 10px; }
  .format-warnings li { color: var(--warn); font-size: 12px; line-height: 1.5; margin-bottom: 4px; }
  .fields-help summary { font-size: 12px; text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--link); }
  .fields-help table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
  .fields-help td { padding: 3px 8px 3px 0; vertical-align: top; color: var(--muted); line-height: 1.45; }
  .fields-help td:first-child { white-space: nowrap; }
  .agree { margin: 18px 0 4px; font-size: 13px; color: var(--muted); }
  .agree a { color: var(--link); }
  .sub-label { display: block; font-size: 12px; color: var(--muted); margin: 16px 0 8px; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
  #catalog-list { display: flex; flex-direction: column; gap: 6px; }
  .cat-row {
    display: flex; align-items: flex-start; gap: 10px; background: #121318; border: 1px solid var(--border);
    border-radius: 9px; padding: 9px 10px;
  }
  .cat-rank {
    flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; background: var(--accent); color: #fff;
    font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 3px;
  }
  .cat-main { flex: 1 1 auto; min-width: 0; }
  .cat-label { font-size: 14px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; padding-top: 3px; }
  .cat-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .cat-opts select { width: auto; max-width: 100%; padding: 5px 8px; font-size: 12.5px; border-radius: 7px; }
  .cat-empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }
  .cat-lead { margin: 0 0 10px; }
  .cat-fixed { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .btns { flex: 0 0 auto; display: flex; gap: 4px; }
  .btns button {
    width: 28px; height: 28px; padding: 0; font-size: 11px; background: var(--field); border: 1px solid var(--border);
    color: var(--muted); border-radius: 7px; cursor: pointer;
  }
  .btns button:disabled { opacity: .3; cursor: default; }
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
  .chips button {
    background: var(--field); border: 1px solid var(--border); color: var(--text); padding: 6px 11px;
    font-size: 13px; border-radius: 999px; cursor: pointer;
  }
  .chips button:hover { border-color: var(--link); }
  .inline-inputs { display: flex; gap: 8px; }
  .inline-inputs input { flex: 1 1 auto; min-width: 0; }
  .inline-inputs select { width: auto; flex: 0 0 auto; }
  .note-warn { color: var(--warn); }
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
        Your key is kept only inside your personal addon link; YouStream never stores it (see the <a href="/terms" target="_blank" rel="noopener">privacy policy</a>).
      </div>
    </div>

    <div class="card">
      <h2>TMDB key <span class="chip">optional</span></h2>
      <p class="lead">
        Lets ${ADDON_NAME} read the <code>tmdb:</code> ids Nuvio uses for some titles, and adds TMDB's cast
        lists and other names to the evidence a match needs.
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
      <div class="hint">Each type you switch off saves your daily searches for the rest. Switch both off to use ${ADDON_NAME} for YouTube alone.</div>
    </div>

    <div class="card" id="youtube-card">
      <h2>YouTube in your app</h2>
      <p class="lead">
        Search YouTube from your app, and keep searches, channels, playlists and Trending as rows on its home
        screen. A video you open there plays the ways you choose under &ldquo;When you press play&rdquo;, and one
        you save to your library is listed under the type <strong>YouTube</strong>.
      </p>
      <div class="row-box">
        <label class="check"><input type="checkbox" id="yt-search"${searchOn ? " checked" : ""} />
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

      <span class="sub-label">Catalogs</span>
      <p class="hint cat-lead">
        Each one is a row on your app's home screen, <strong>in this order</strong>: use the arrows to arrange
        them. Choose where a row's videos come from, type the search or paste the playlist or channel, then choose
        how its videos are ordered.
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

      <div class="grid-2" style="margin-top:16px">
        <div class="field">
          <span class="label-text">Refresh catalogs every</span>
          <div class="inline-inputs">
            <input type="number" id="refresh-value" min="0" step="any" inputmode="decimal" value="${escapeHtml(s.catalogRefresh.value)}" aria-label="Refresh catalogs every" />
            <select id="refresh-unit" aria-label="Refresh unit">${Object.entries(REFRESH_UNITS)
              .map(([unit, info]) => `<option value="${unit}"${unit === s.catalogRefresh.unit ? " selected" : ""}>${escapeHtml(info.label)}</option>`)
              .join("")}</select>
          </div>
        </div>
        <label class="field">
          <span class="label-text">SafeSearch</span>
          <select id="safe-search">${SAFE_SEARCH.map(
            (id) => `<option value="${id}"${id === s.safeSearch ? " selected" : ""}>${escapeHtml(SAFE_SEARCH_LABELS[id])}</option>`
          ).join("")}</select>
        </label>
      </div>
      <div class="hint">
        A search catalog costs one of your 100 daily searches each time it refreshes; a channel, a playlist or a
        Trending row costs almost nothing. A row refreshes only when your app shows it after this long: every
        ${DEFAULT_CATALOG_REFRESH.value} hours unless you change it, and at most every 30 minutes. YouTube's terms let a
        server keep its data 30 days at most, so anything longer refreshes then. SafeSearch applies to searches.
        <span id="quota-note"></span>
      </div>
    </div>

    <div class="card">
      <h2>Runtime matching</h2>
      <p class="lead">
        A video only counts when its length is close to the listed runtime. This is what keeps trailers
        and clips out. A margin can be in seconds, minutes, or a percentage of the runtime. For example,
        a 23-minute episode with a 25-second margin accepts anything from 22m 35s to 23m 25s. The defaults
        come from measuring real uploads against their listings; the episode number, not the length, is
        what keeps the wrong episode out.
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
      <details id="advanced">
        <summary>Advanced</summary>
        <div class="format">
          <span class="label-text">Stream name and description</span>
          <p class="hint" style="margin:0 0 10px">
            How each stream reads in your app. Templates use AIOStreams' formatter syntax, which PenguPlay uses too,
            so one made for either works here: <code>{video.channel::upper}</code>,
            <code>{video.official::istrue["✓"||""]}</code>, and <code>{? … ?}</code> for a part shown only when its
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

    <label class="check agree"><input type="checkbox" id="agree"${isReconfigure ? " checked" : ""} />
      <span>I agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube Terms of Service</a> and to YouStream's <a href="/terms" target="_blank" rel="noopener">terms of use and privacy policy</a>.</span></label>

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
  </footer>
</div>

<script type="application/json" id="youtube-data">${jsonForScript(youtubeData(startCatalogs))}</script>
<script type="application/json" id="format-data">${jsonForScript({
    presets: PRESETS,
    defaultFormat: DEFAULT_FORMAT,
    languages: FORMATTER_LANGUAGES,
    maxName: MAX_NAME_TEMPLATE,
    maxDescription: MAX_DESCRIPTION_TEMPLATE,
    ...previewData(identity().name)
  })}</script>
<script>${FORMATTER_SOURCE}</script>
<script>${TEMPLATE_CHECK_SOURCE}</script>
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
  var DEFAULT_EXCLUDE_DESCRIPTION = ${jsonForScript(DEFAULT_EXCLUDE_DESCRIPTION)};
  var DEFAULT_MOVIE_QUERY = ${jsonForScript(DEFAULT_MOVIE_QUERY)};
  var DEFAULT_EPISODE_QUERY = ${jsonForScript(DEFAULT_EPISODE_QUERY)};
  var DEFAULT_MAX_RESULTS = ${DEFAULT_MAX_RESULTS};
  var MAX_RESULTS_LIMIT = ${MAX_RESULTS_LIMIT};
  var DEFAULT_MIN_VIEWS = ${DEFAULT_MIN_VIEWS};
  var MAX_MIN_VIEWS = ${MAX_MIN_VIEWS};
  var DEFAULTS = {
    "movie-query": DEFAULT_MOVIE_QUERY,
    "episode-query": DEFAULT_EPISODE_QUERY,
    exclude: DEFAULT_EXCLUDE.join(", "),
    "exclude-description": DEFAULT_EXCLUDE_DESCRIPTION.join(", ")
  };

  // A comma-separated list as the server stores it: lower case, trimmed,
  // without blanks or repeats.
  function readList(id) {
    var out = [];
    document.getElementById(id).value.split(",").forEach(function (word) {
      var w = word.trim().toLowerCase();
      if (w && out.indexOf(w) === -1) out.push(w);
    });
    return out;
  }
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
    renderPreview();
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

  // The stream name and description: a preset or the reader's own
  // templates, previewed live with the very formatter the server uses
  // (formatter.js, inlined above), for each way of watching turned on.
  var FORMAT = JSON.parse(document.getElementById("format-data").textContent);
  var formatter = createFormatter({ languages: FORMAT.languages });
  var presetSelect = document.getElementById("format-preset");
  var nameInput = document.getElementById("name-template");
  var descriptionInput = document.getElementById("description-template");
  var previewList = document.getElementById("format-preview");
  var formatWarnings = document.getElementById("format-warnings");
  var previewSample = "film";

  function matchingPreset(name, description) {
    var ids = Object.keys(FORMAT.presets);
    for (var i = 0; i < ids.length; i++) {
      var preset = FORMAT.presets[ids[i]];
      if (preset.name === name && preset.description === description) return ids[i];
    }
    return "";
  }
  // What the server will use: a blank template is the default preset's.
  function templatesInUse() {
    var fallback = FORMAT.presets[FORMAT.defaultFormat];
    return {
      name: nameInput.value.trim() || fallback.name,
      description: descriptionInput.value.trim() || fallback.description
    };
  }
  function previewScope(optionId) {
    var base = FORMAT.samples[previewSample];
    var scope = {};
    Object.keys(base).forEach(function (key) { scope[key] = base[key]; });
    var stream = {};
    Object.keys(base.stream).forEach(function (key) { stream[key] = base.stream[key]; });
    stream.type = optionId === "app" ? "youtube" : "external";
    scope.stream = stream;
    scope.play = FORMAT.play[optionId];
    return scope;
  }
  function addLine(list, className, text) {
    var item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    list.appendChild(item);
    return item;
  }
  function renderPreview() {
    var templates = templatesInUse();
    var options = pbRows()
      .filter(function (row) { return row.querySelector(".pb-on").checked; })
      .map(function (row) { return row.getAttribute("data-option"); });
    if (!options.length) options = ["app"];
    var broken = false;
    previewList.innerHTML = "";
    options.forEach(function (optionId) {
      var scope = previewScope(optionId);
      var name = formatter.render(templates.name, scope) || scope.addon.name;
      var description = formatter.render(templates.description, scope) || scope.video.title;
      if ((name + description).indexOf("{unknown_") !== -1 || (name + description).indexOf("{cannot_") !== -1) broken = true;
      var row = addLine(previewList, "", "");
      var nameEl = document.createElement("div");
      nameEl.className = "p-name";
      nameEl.textContent = name;
      var descriptionEl = document.createElement("div");
      descriptionEl.className = "p-desc";
      descriptionEl.textContent = description;
      row.appendChild(nameEl);
      row.appendChild(descriptionEl);
    });
    formatWarnings.innerHTML = "";
    var warnings = templateWarnings(nameInput.value, descriptionInput.value);
    if (broken) warnings.unshift("A field or modifier in these templates is unknown: the preview shows it in braces, as your app would.");
    warnings.forEach(function (text) { addLine(formatWarnings, "", text); });
  }
  function syncPreset() {
    var templates = templatesInUse();
    presetSelect.value = matchingPreset(templates.name, templates.description) || "custom";
  }
  presetSelect.addEventListener("change", function () {
    var preset = FORMAT.presets[presetSelect.value];
    if (preset) {
      nameInput.value = preset.name;
      descriptionInput.value = preset.description;
    }
    renderPreview();
  });
  [nameInput, descriptionInput].forEach(function (input) {
    input.addEventListener("input", function () {
      syncPreset();
      renderPreview();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".preview-tab"), function (tab) {
    tab.addEventListener("click", function () {
      previewSample = tab.getAttribute("data-sample");
      Array.prototype.forEach.call(document.querySelectorAll(".preview-tab"), function (other) {
        other.setAttribute("aria-pressed", other === tab ? "true" : "false");
      });
      renderPreview();
    });
  });
  pbRows().forEach(function (row) {
    row.querySelector(".pb-on").addEventListener("change", renderPreview);
  });
  syncPreset();
  renderPreview();

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

  // The YouTube card: search, and the reader's catalogs in their order.
  // CATALOGS is the source of truth for the list on screen and for what is
  // saved; rows are built with createElement and textContent, so nothing a
  // reader typed or YouTube named can be read as markup.
  var YT = JSON.parse(document.getElementById("youtube-data").textContent);
  var CATALOGS = YT.catalogs;
  var catalogList = document.getElementById("catalog-list");
  var catalogInput = document.getElementById("catalog-input");
  var catalogSource = document.getElementById("catalog-source");
  var catalogAdd = document.getElementById("catalog-add");
  var catalogNote = document.getElementById("catalog-note");
  var trendingChips = document.getElementById("trending-chips");
  var ytSearch = document.getElementById("yt-search");
  var searchSort = document.getElementById("search-sort");
  var searchLength = document.getElementById("search-length");
  var refreshValue = document.getElementById("refresh-value");
  var refreshUnit = document.getElementById("refresh-unit");
  var quotaNote = document.getElementById("quota-note");

  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function choice(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0];
  }
  // What a row is called: the names the server gives catalogs.
  function catalogName(entry) {
    if (entry.kind === "search") {
      return [entry.q, choice(YT.sorts, entry.sort).short, choice(YT.lengths, entry.length).short, choice(YT.periods, entry.within).short]
        .filter(Boolean)
        .join(" · ");
    }
    if (entry.kind === "channel") {
      return [entry.title, choice(YT.shows, entry.show).short, choice(YT.channelSorts, entry.sort).short].filter(Boolean).join(" · ");
    }
    if (entry.kind === "playlist") return entry.title;
    return choice(YT.trending, entry.trending).label;
  }
  // Two rows that would list the same videos.
  function sameCatalog(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind === "search") {
      return a.q.toLowerCase() === b.q.toLowerCase() && a.sort === b.sort && a.length === b.length && a.within === b.within;
    }
    if (a.kind === "channel") return a.channel === b.channel && a.show === b.show && a.sort === b.sort;
    if (a.kind === "playlist") return a.playlist === b.playlist;
    return a.trending === b.trending;
  }
  // The compact form the install link carries, defaults left out.
  function storedCatalog(entry) {
    if (entry.kind === "search") {
      var search = { q: entry.q };
      if (entry.sort !== "relevance") search.sort = entry.sort;
      if (entry.length !== "any") search.length = entry.length;
      if (entry.within !== "any") search.within = entry.within;
      return search;
    }
    if (entry.kind === "channel") {
      var channel = { channel: entry.channel, name: entry.title };
      if (entry.show !== "videos") channel.show = entry.show;
      if (entry.sort !== "date") channel.sort = entry.sort;
      return channel;
    }
    if (entry.kind === "playlist") return { playlist: entry.playlist, name: entry.title };
    return { trending: entry.trending };
  }
  function note(text, warn) {
    catalogNote.textContent = text;
    catalogNote.className = warn ? "hint note-warn" : "hint";
  }
  function smallButton(text, className, title, onClick) {
    var b = node("button", className, text);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }
  function optionSelect(list, value, label, onChange) {
    var select = node("select");
    select.setAttribute("aria-label", label);
    list.forEach(function (item) {
      var option = node("option", "", item.label);
      option.value = item.id;
      if (item.id === value) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", function () { onChange(select); });
    return select;
  }
  function moveCatalog(from, to) {
    if (to < 0 || to >= CATALOGS.length) return;
    var moved = CATALOGS.splice(from, 1)[0];
    CATALOGS.splice(to, 0, moved);
    renderCatalogs();
  }
  // A row's option changed: kept, unless the row would then repeat another.
  function changeCatalog(index, field, select, nameEl) {
    var entry = CATALOGS[index];
    var changed = {};
    Object.keys(entry).forEach(function (key) { changed[key] = entry[key]; });
    changed[field] = select.value;
    for (var i = 0; i < CATALOGS.length; i++) {
      if (i !== index && sameCatalog(CATALOGS[i], changed)) {
        select.value = entry[field];
        note("You already have that catalog.", true);
        return;
      }
    }
    CATALOGS[index] = changed;
    nameEl.textContent = catalogName(changed);
    note("");
    renderQuota();
  }
  function renderCatalogs() {
    catalogList.textContent = "";
    if (!CATALOGS.length) {
      catalogList.appendChild(node("div", "cat-empty", "No catalogs yet. Add a search, a channel, a playlist or a Trending row below."));
    }
    CATALOGS.forEach(function (entry, index) {
      var title = catalogName(entry);
      var row = node("div", "cat-row");
      row.setAttribute("data-kind", entry.kind);
      row.appendChild(node("div", "cat-rank", String(index + 1)));
      var main = node("div", "cat-main");
      var label = node("div", "cat-label");
      var name = node("span", "cat-name", title);
      label.appendChild(name);
      label.appendChild(node("span", "chip", entry.kind));
      main.appendChild(label);
      var opts = node("div", "cat-opts");
      var addOption = function (list, field, what) {
        opts.appendChild(optionSelect(list, entry[field], what, function (select) { changeCatalog(index, field, select, name); }));
      };
      if (entry.kind === "search") {
        addOption(YT.sorts, "sort", "Order of " + title);
        addOption(YT.lengths, "length", "Length of videos in " + title);
        addOption(YT.periods, "within", "Upload date of videos in " + title);
      } else if (entry.kind === "channel") {
        addOption(YT.shows, "show", "What to list from " + title);
        addOption(YT.channelSorts, "sort", "Order of " + title);
      }
      if (opts.childNodes.length) main.appendChild(opts);
      // The rest have one order, which YouTube keeps.
      if (entry.kind === "playlist") main.appendChild(node("div", "cat-fixed", "In the playlist's own order"));
      if (entry.kind === "trending") main.appendChild(node("div", "cat-fixed", "Ranked by YouTube, for your country"));
      row.appendChild(main);
      var btns = node("div", "btns");
      var up = smallButton("▲", "cat-up", "Move " + title + " up", function () { moveCatalog(index, index - 1); });
      var down = smallButton("▼", "cat-down", "Move " + title + " down", function () { moveCatalog(index, index + 1); });
      up.disabled = index === 0;
      down.disabled = index === CATALOGS.length - 1;
      btns.appendChild(up);
      btns.appendChild(down);
      btns.appendChild(smallButton("×", "remove", "Remove " + title, function () {
        CATALOGS.splice(index, 1);
        renderCatalogs();
      }));
      row.appendChild(btns);
      catalogList.appendChild(row);
    });
    renderTrendingChips();
    renderQuota();
  }
  // Only the Trending rows not added yet.
  function renderTrendingChips() {
    trendingChips.textContent = "";
    YT.trending.forEach(function (chart) {
      for (var i = 0; i < CATALOGS.length; i++) {
        if (CATALOGS[i].kind === "trending" && CATALOGS[i].trending === chart.id) return;
      }
      trendingChips.appendChild(smallButton("+ " + chart.chip, "", "Add " + chart.label, function () {
        addCatalog({ kind: "trending", trending: chart.id });
      }));
    });
    if (!trendingChips.childNodes.length) trendingChips.appendChild(node("div", "cat-empty", "Every Trending row is added."));
  }
  function addCatalog(entry) {
    if (CATALOGS.length >= YT.maxCatalogs) return note("You can have at most " + YT.maxCatalogs + " catalogs.", true);
    for (var i = 0; i < CATALOGS.length; i++) {
      if (sameCatalog(CATALOGS[i], entry)) return note("You already have that catalog.", true);
    }
    CATALOGS.push(entry);
    catalogInput.value = "";
    note("");
    renderCatalogs();
  }
  function addSearch(q) {
    if (q.length > YT.maxQuery) return note("A search can be at most " + YT.maxQuery + " characters long.", true);
    addCatalog({ kind: "search", q: q, sort: "relevance", length: "any", within: "any" });
  }
  // The add row asks for what the chosen source needs.
  function syncSource() {
    var source = choice(YT.sources, catalogSource.value);
    catalogInput.placeholder = source.placeholder;
    catalogInput.setAttribute("aria-label", source.prompt);
    note("");
  }
  catalogSource.addEventListener("change", syncSource);
  // A link added as a search is a slip: YouTube would be searched for it.
  function isYoutubeLink(text) {
    return text.indexOf("youtube.com/") !== -1 || text.indexOf("youtu.be/") !== -1;
  }
  // Runs of whitespace as single spaces, by character code: this script
  // cannot hold the escape a whitespace regex needs.
  function collapseSpaces(text) {
    var words = [];
    var word = "";
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) <= 32) {
        if (word) words.push(word);
        word = "";
      } else {
        word += text.charAt(i);
      }
    }
    if (word) words.push(word);
    return words.join(" ");
  }
  function addFromInput() {
    var text = collapseSpaces(catalogInput.value);
    if (!text) return;
    var kind = catalogSource.value;
    if (kind === "search") {
      if (isYoutubeLink(text)) return note("That is a YouTube link. To add it, choose YouTube playlist or YouTube channel.", true);
      return addSearch(text);
    }
    var key = document.getElementById("youtube-key").value.trim();
    if (!key) return note("Enter your YouTube API key above first: it is used to look the link up.", true);
    if (typeof fetch !== "function") return note("This browser cannot look links up.", true);
    catalogAdd.disabled = true;
    note("Looking it up...");
    fetch("/api/youtube-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ youtubeKey: key, input: text, kind: kind })
    })
      .then(function (res) { return res.json(); })
      .then(function (answer) {
        catalogAdd.disabled = false;
        if (answer.entry) return addCatalog(answer.entry);
        note(answer.error || "That could not be looked up.", true);
      })
      .catch(function () {
        catalogAdd.disabled = false;
        note("The link could not be looked up. Check your connection and try again.", true);
      });
  }
  catalogAdd.addEventListener("click", addFromInput);
  // Enter in the box adds what was typed rather than submitting the form.
  catalogInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
  // Minutes between refreshes as typed, or NaN.
  function refreshMinutes() {
    var text = refreshValue.value.trim();
    if (!isDecimal(text)) return NaN;
    return (parseFloat(text) * YT.refreshUnits[refreshUnit.value].ms) / 60000;
  }
  // What the search catalogs could cost a day at this interval, shown all day.
  function renderQuota() {
    var searches = CATALOGS.filter(function (c) { return c.kind === "search"; }).length;
    var minutes = refreshMinutes();
    quotaNote.className = "";
    quotaNote.textContent = "";
    if (!searches || !(minutes >= 30)) return;
    var most = Math.ceil(1440 / minutes) * searches;
    if (most >= 100) {
      quotaNote.className = "note-warn";
      quotaNote.textContent = "Shown all day, your search catalogs could spend all 100 of your daily searches, leaving none for films and episodes: refresh them less often, or use channels and playlists.";
    } else {
      quotaNote.textContent = "Shown all day, your search catalogs would spend at most " + most + " of your 100 daily searches.";
    }
  }
  refreshValue.addEventListener("input", renderQuota);
  refreshUnit.addEventListener("change", renderQuota);
  function syncSearch() {
    searchSort.disabled = !ytSearch.checked;
    searchLength.disabled = !ytSearch.checked;
  }
  ytSearch.addEventListener("change", syncSearch);
  syncSearch();
  renderCatalogs();

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
    if (!types.length && !ytSearch.checked && !CATALOGS.length) {
      return "Choose something for YouStream to do: movies, series, YouTube search, or a catalog.";
    }

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

    if (types.length < 2) config.types = types;

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
    if (document.getElementById("official-only").checked) config.officialOnly = true;

    var movieQuery = document.getElementById("movie-query").value.trim();
    var episodeQuery = document.getElementById("episode-query").value.trim();
    if (movieQuery.indexOf("{title}") === -1 || episodeQuery.indexOf("{title}") === -1) {
      return "Both searches need {title} in them.";
    }
    if (movieQuery !== DEFAULT_MOVIE_QUERY) config.movieQuery = movieQuery;
    if (episodeQuery !== DEFAULT_EPISODE_QUERY) config.episodeQuery = episodeQuery;

    var templates = templatesInUse();
    if (templates.name.length > FORMAT.maxName || templates.description.length > FORMAT.maxDescription) {
      return "The stream name can be " + FORMAT.maxName + " characters long and the description " + FORMAT.maxDescription + ".";
    }
    var preset = matchingPreset(templates.name, templates.description);
    if (!preset) {
      config.nameTemplate = templates.name;
      config.descriptionTemplate = templates.description;
    } else if (preset !== FORMAT.defaultFormat) {
      config.format = preset;
    }

    var exclude = readList("exclude");
    if (exclude.join(",") !== DEFAULT_EXCLUDE.join(",")) config.exclude = exclude;
    var excludeDescription = readList("exclude-description");
    if (excludeDescription.join(",") !== DEFAULT_EXCLUDE_DESCRIPTION.join(",")) config.excludeDescription = excludeDescription;

    if (ytSearch.checked) config.search = true;
    if (searchSort.value !== "relevance") config.searchSort = searchSort.value;
    if (searchLength.value !== "any") config.searchLength = searchLength.value;
    var safeSearch = document.getElementById("safe-search").value;
    if (safeSearch !== "moderate") config.safeSearch = safeSearch;
    if (CATALOGS.length) config.catalogs = CATALOGS.map(storedCatalog);
    var minutes = refreshMinutes();
    if (!(minutes > 0)) return "Refresh catalogs every: enter a number.";
    if (minutes < 30) return "Refresh catalogs every: at least 30 minutes.";
    var refresh = parseFloat(refreshValue.value.trim()) + refreshUnit.value;
    if (refresh !== YT.defaultRefresh.value + YT.defaultRefresh.unit) config.catalogRefresh = refresh;

    if (!document.getElementById("agree").checked) {
      return "To install YouStream, agree to the YouTube Terms of Service and YouStream's terms of use and privacy policy.";
    }
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

module.exports = { renderConfigurePage, escapeHtml, jsonForScript, browserSource, REPO_URL, FORMATTER_DOCS_URL };
