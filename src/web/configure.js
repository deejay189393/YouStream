/**
 * The configure page, in the browser: its tabs, every control, the live
 * preview of a stream's text, the catalogs editor, and profiles -- creating
 * one, saving it, signing in and out, its password, its link, its backups.
 *
 * The server renders the page with every setting filled in, and what this
 * needs to know in JSON blocks (configurePage.js); this makes it work.
 * Everything it builds is made with createElement and textContent, so
 * nothing a reader typed, or YouTube named, is ever read as markup.
 *
 * A module, so that the tests run this very file in a browser-like window
 * and coverage measures it; webApp.js hands it to browsers wrapped to start
 * at once with their own window.
 *
 * @param {Window} window
 * @param {object} [hooks]
 * @param {function} [hooks.navigate]  leaves the page for a URL; the tests
 *                                     record it, as jsdom cannot follow
 */
module.exports = function start(window, hooks = {}) {
  const { document, navigator } = window;
  const $ = (id) => document.getElementById(id);
  const json = (id) => JSON.parse($(id).textContent);
  const PAGE = json("page-data");
  const FORMAT = json("format-data");
  const YT = json("youtube-data");
  const PROFILE = PAGE.profile;
  const navigate =
    hooks.navigate ||
    ((url) => {
      window.location.href = url;
    });

  const KEY_PROBLEMS = {
    missing: "Enter your YouTube API key.",
    invalid: "YouTube says this key is not valid. Copy it again from the Google Cloud console.",
    disabled: "This key's Google Cloud project does not have the YouTube Data API v3 enabled. Enable it, wait a minute, and try again.",
    restricted:
      "This key is restricted to certain websites, apps or IP addresses, so this server cannot use it. In the Google Cloud console set Application restrictions to None. Limiting it to the YouTube Data API v3 is fine."
  };
  const TMDB_INVALID = "TMDB says this key is not valid. Paste the API key or the Read Access Token from your TMDB settings, or leave it blank.";
  const QUOTA_WARNING =
    "Your key works, but its YouTube quota for today is already spent. It refills at midnight Pacific time; until then nothing new can be searched.";
  const DEFAULTS = {
    "movie-query": PAGE.defaultMovieQuery,
    "episode-query": PAGE.defaultEpisodeQuery,
    exclude: PAGE.defaultExclude.join(", "),
    "exclude-description": PAGE.defaultExcludeDescription.join(", ")
  };

  const form = $("config-form");
  const errorEl = $("error");
  const warningEl = $("warning");
  const resultEl = $("result");
  const submitBtn = $("submit-btn");
  const saveStatus = $("save-status");

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // A note under a control: good, bad, or gone when there is no text.
  function say(el, text, kind) {
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
    el.hidden = !text;
  }

  // A button at work: disabled, saying what it is doing; then as it was.
  function busy(button, text) {
    if (!button.getAttribute("data-label")) button.setAttribute("data-label", button.textContent);
    button.disabled = true;
    button.textContent = text;
  }

  function idle(button) {
    button.disabled = false;
    button.textContent = button.getAttribute("data-label");
  }

  // What a select shows, as the reader sees it.
  const shown = (select) => select.options[select.selectedIndex].textContent;

  // Letters, digits, dot, dash and underscore: all a key ever has.
  const isKeyText = (text) => /^[A-Za-z0-9._-]*$/.test(text);
  const isWholeNumber = (text) => /^\d+$/.test(text);
  const isDecimal = (text) => /^\d+(\.\d+)?$/.test(text);

  // A comma-separated list as the server stores it: lower case, trimmed,
  // without blanks or repeats.
  function readList(id) {
    const out = [];
    $(id)
      .value.split(",")
      .forEach((word) => {
        const w = word.trim().toLowerCase();
        if (w && !out.includes(w)) out.push(w);
      });
    return out;
  }

  // --- Tabs ----------------------------------------------------------------
  // Each part of the page is a panel, and the address's #fragment says which
  // is open: the back button goes back a tab, and a link can open one.
  const panels = Array.from(document.querySelectorAll(".panel"));
  const tabLinks = Array.from(document.querySelectorAll(".tab"));
  const tabIds = panels.map((panel) => panel.getAttribute("data-tab"));
  const finishBar = $("finish-bar");

  function askedTab() {
    const id = window.location.hash.slice(1);
    return tabIds.includes(id) ? id : tabIds[0];
  }

  function showTab(id) {
    panels.forEach((panel) => {
      panel.hidden = panel.getAttribute("data-tab") !== id;
    });
    tabLinks.forEach((link) => {
      if (link.getAttribute("data-tab") === id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    // A new setup is finished on the summary; elsewhere a bar leads there.
    if (finishBar) finishBar.hidden = id === "summary";
  }

  function openTab(id) {
    window.location.hash = id;
    showTab(id);
  }

  window.addEventListener("hashchange", () => {
    showTab(askedTab());
    document.documentElement.scrollTop = 0;
  });
  showTab(askedTab());

  // A field the reader has to fix: its tab opened, any fold it is in opened,
  // and the cursor put in it.
  function reveal(fieldId) {
    const field = $(fieldId);
    openTab(field.closest(".panel").getAttribute("data-tab"));
    const fold = field.closest("details");
    if (fold) fold.open = true;
    field.focus();
  }

  function showError(message, fieldId) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
    resultEl.classList.remove("show");
    if (fieldId) reveal(fieldId);
  }

  function hideError() {
    errorEl.style.display = "none";
  }

  // The notes over the page go when tapped.
  errorEl.addEventListener("click", hideError);
  saveStatus.addEventListener("click", () => say(saveStatus, ""));

  // Show or hide a key so it can be read back when reconfiguring.
  document.querySelectorAll(".key-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.getAttribute("data-for"));
      const showing = input.type === "password";
      input.type = showing ? "text" : "password";
      btn.setAttribute("aria-pressed", showing ? "true" : "false");
      btn.setAttribute("title", (showing ? "Hide " : "Show ") + (btn.getAttribute("data-what") || "key"));
    });
  });

  // --- The ways to watch: each on or off, and movable. Their order is the
  // order the app lists them.
  const pbList = $("pb-options");
  const pbRows = () => Array.from(pbList.querySelectorAll(".pb-option"));
  const pbOn = () => pbRows().filter((row) => row.querySelector(".pb-on").checked);

  function refreshPbArrows() {
    const rows = pbRows();
    rows.forEach((row, i) => {
      row.querySelector(".pb-up").disabled = i === 0;
      row.querySelector(".pb-down").disabled = i === rows.length - 1;
    });
  }

  function movePb(row, delta) {
    const rows = pbRows();
    const target = rows.indexOf(row) + delta;
    if (target < 0 || target >= rows.length) return;
    if (delta < 0) pbList.insertBefore(row, rows[target]);
    else pbList.insertBefore(rows[target], row);
    refreshPbArrows();
    renderPreview();
  }

  pbRows().forEach((row) => {
    row.querySelector(".pb-up").addEventListener("click", () => movePb(row, -1));
    row.querySelector(".pb-down").addEventListener("click", () => movePb(row, 1));
  });
  refreshPbArrows();

  document.querySelectorAll(".reset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-reset");
      $(id).value = DEFAULTS[id];
    });
  });

  // --- The stream name and description: a preset or the reader's own
  // templates, previewed live with the very formatter the server uses
  // (formatter.js), for each way of watching turned on.
  const formatter = window.createFormatter({ languages: FORMAT.languages });
  const presetSelect = $("format-preset");
  const nameInput = $("name-template");
  const descriptionInput = $("description-template");
  const previewList = $("format-preview");
  const formatWarnings = $("format-warnings");
  let previewSample = "film";

  function matchingPreset(name, description) {
    return Object.keys(FORMAT.presets).find((id) => FORMAT.presets[id].name === name && FORMAT.presets[id].description === description) || "";
  }

  // What the server will use: a blank template is the default preset's.
  function templatesInUse() {
    const fallback = FORMAT.presets[FORMAT.defaultFormat];
    return {
      name: nameInput.value.trim() || fallback.name,
      description: descriptionInput.value.trim() || fallback.description
    };
  }

  function previewScope(optionId) {
    const base = FORMAT.samples[previewSample];
    return {
      ...base,
      stream: { ...base.stream, type: optionId === "app" ? "youtube" : "external" },
      play: FORMAT.play[optionId]
    };
  }

  function addLine(list, text) {
    const item = node("li", "", text);
    list.appendChild(item);
    return item;
  }

  function renderPreview() {
    const templates = templatesInUse();
    let options = pbOn().map((row) => row.getAttribute("data-option"));
    if (!options.length) options = ["app"];
    let broken = false;
    previewList.textContent = "";
    options.forEach((optionId) => {
      const scope = previewScope(optionId);
      const name = formatter.render(templates.name, scope) || scope.addon.name;
      const description = formatter.render(templates.description, scope) || scope.video.title;
      if (/\{(unknown|cannot)_/.test(name + description)) broken = true;
      const row = addLine(previewList, "");
      row.appendChild(node("div", "p-name", name));
      row.appendChild(node("div", "p-desc", description));
    });
    formatWarnings.textContent = "";
    const warnings = window.templateWarnings(nameInput.value, descriptionInput.value);
    if (broken) warnings.unshift("A field or modifier in these templates is unknown: the preview shows it in braces, as your app would.");
    warnings.forEach((text) => addLine(formatWarnings, text));
  }

  function syncPreset() {
    const templates = templatesInUse();
    presetSelect.value = matchingPreset(templates.name, templates.description) || "custom";
  }

  presetSelect.addEventListener("change", () => {
    const preset = FORMAT.presets[presetSelect.value];
    if (preset) {
      nameInput.value = preset.name;
      descriptionInput.value = preset.description;
    }
    renderPreview();
  });
  [nameInput, descriptionInput].forEach((input) => {
    input.addEventListener("input", () => {
      syncPreset();
      renderPreview();
    });
  });
  const previewTabs = Array.from(document.querySelectorAll(".preview-tab"));
  previewTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      previewSample = tab.getAttribute("data-sample");
      previewTabs.forEach((other) => other.setAttribute("aria-pressed", other === tab ? "true" : "false"));
      renderPreview();
    });
  });
  pbRows().forEach((row) => row.querySelector(".pb-on").addEventListener("change", renderPreview));
  syncPreset();
  renderPreview();

  // A new setup starts in the reader's own country, read from the browser's
  // language tag ("en-IN" is India). Reconfiguring keeps what was saved.
  const regionSelect = $("region");
  if (!PAGE.isReconfigure && !regionSelect.value) {
    const tag = (navigator.language || "").split("-");
    const guess = tag.length > 1 ? tag[tag.length - 1].toUpperCase() : "";
    if (guess && Array.from(regionSelect.options).some((option) => option.value === guess)) regionSelect.value = guess;
  }

  // --- Catalogs: the reader's rows, in their order. CATALOGS is the source
  // of truth for the list on screen and for what is saved.
  const CATALOGS = YT.catalogs;
  const catalogList = $("catalog-list");
  const catalogInput = $("catalog-input");
  const catalogSource = $("catalog-source");
  const catalogAdd = $("catalog-add");
  const catalogNote = $("catalog-note");
  const trendingChips = $("trending-chips");
  const ytSearch = $("yt-search");
  const searchSort = $("search-sort");
  const searchLength = $("search-length");
  const refreshValue = $("refresh-value");
  const refreshUnit = $("refresh-unit");
  const quotaNote = $("quota-note");

  // The server hands over every catalog normalized, so its choices are always in their lists.
  const choice = (list, id) => list.find((item) => item.id === id);

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

  function storedSource(entry) {
    if (entry.kind === "search") {
      const search = { q: entry.q };
      if (entry.sort !== "relevance") search.sort = entry.sort;
      if (entry.length !== "any") search.length = entry.length;
      if (entry.within !== "any") search.within = entry.within;
      return search;
    }
    if (entry.kind === "channel") {
      const channel = { channel: entry.channel, name: entry.title };
      if (entry.show !== "videos") channel.show = entry.show;
      if (entry.sort !== "date") channel.sort = entry.sort;
      return channel;
    }
    if (entry.kind === "playlist") return { playlist: entry.playlist, name: entry.title };
    return { trending: entry.trending };
  }

  // The compact form the install link carries, defaults left out, and the
  // keyword filter when it has words.
  function storedCatalog(entry) {
    const stored = storedSource(entry);
    if (entry.filter && entry.filter.words.length) {
      stored[entry.filter.mode] = entry.filter.words;
      if (entry.filter.scope === "title") stored.filterIn = "title";
    }
    return stored;
  }

  function note(text, warn) {
    catalogNote.textContent = text;
    catalogNote.className = warn ? "hint note-warn" : "hint";
  }

  function smallButton(text, className, title, onClick) {
    const b = node("button", className, text);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  function optionSelect(list, value, label, onChange) {
    const select = node("select");
    select.setAttribute("aria-label", label);
    list.forEach((item) => {
      const option = node("option", "", item.label);
      option.value = item.id;
      if (item.id === value) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", () => onChange(select));
    return select;
  }

  function moveCatalog(from, to) {
    if (to < 0 || to >= CATALOGS.length) return;
    CATALOGS.splice(to, 0, CATALOGS.splice(from, 1)[0]);
    renderCatalogs();
  }

  // A row's option changed: kept, unless the row would then repeat another.
  function changeCatalog(index, field, select, nameEl) {
    const entry = CATALOGS[index];
    const changed = { ...entry, [field]: select.value };
    if (CATALOGS.some((other, i) => i !== index && sameCatalog(other, changed))) {
      select.value = entry[field];
      note("You already have that catalog.", true);
      return;
    }
    CATALOGS[index] = changed;
    nameEl.textContent = catalogName(changed);
    note("");
    renderQuota();
  }

  // A filter's words as the server keeps them: comma separated, trimmed,
  // without blanks or repeats in any case.
  function filterWords(text) {
    const seen = {};
    const words = [];
    text.split(",").forEach((part) => {
      const word = part.replace(/\s+/g, " ").trim().slice(0, YT.maxFilterWord).trim();
      const key = word.toLowerCase();
      if (!word || seen[key] || words.length >= YT.maxFilterWords) return;
      seen[key] = true;
      words.push(word);
    });
    return words;
  }

  // Under a catalog: keep only, or leave out, the videos that mention words
  // in their title and channel name, and in their description unless asked
  // not to look there. Changing a catalog's other options replaces its
  // object in CATALOGS, so the filter is always read and written there, by
  // the row's index.
  function filterControls(index, title) {
    const entry = CATALOGS[index];
    const box = node("div", "cat-filter");
    const modes = [{ id: "", label: "No keyword filter" }].concat(YT.filterModes);
    const words = node("input", "cat-words");
    words.type = "text";
    words.setAttribute("aria-label", "Words to filter " + title + " by, comma separated");
    words.placeholder = "Words or names, comma separated";
    words.value = entry.filter ? entry.filter.words.join(", ") : "";
    const scope = optionSelect(YT.filterScopes, entry.filter ? entry.filter.scope : "all", "Where to look for the words in " + title, () => update());
    const hint = node("div", "cat-fixed", "Whole words, in any case.");
    const select = optionSelect(modes, entry.filter ? entry.filter.mode : "", "Keyword filter for " + title, () => update());
    function show(on) {
      words.hidden = !on;
      scope.hidden = !on;
      hint.hidden = !on;
    }
    function update() {
      const mode = select.value;
      show(Boolean(mode));
      CATALOGS[index].filter = mode ? { mode, words: filterWords(words.value), scope: scope.value } : null;
    }
    words.addEventListener("input", update);
    [select, words, scope, hint].forEach((el) => box.appendChild(el));
    show(Boolean(entry.filter));
    return box;
  }

  function renderCatalogs() {
    catalogList.textContent = "";
    if (!CATALOGS.length) {
      catalogList.appendChild(node("div", "cat-empty", "No catalogs yet. Add a search, a channel, a playlist or a Trending row below."));
    }
    CATALOGS.forEach((entry, index) => {
      const title = catalogName(entry);
      const row = node("div", "cat-row");
      row.setAttribute("data-kind", entry.kind);
      row.appendChild(node("div", "cat-rank", String(index + 1)));
      const main = node("div", "cat-main");
      const label = node("div", "cat-label");
      const name = node("span", "cat-name", title);
      label.appendChild(name);
      label.appendChild(node("span", "chip", entry.kind));
      main.appendChild(label);
      const opts = node("div", "cat-opts");
      const addOption = (list, field, what) => {
        opts.appendChild(optionSelect(list, entry[field], what, (select) => changeCatalog(index, field, select, name)));
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
      const btns = node("div", "btns");
      const up = smallButton("▲", "cat-up", "Move " + title + " up", () => moveCatalog(index, index - 1));
      const down = smallButton("▼", "cat-down", "Move " + title + " down", () => moveCatalog(index, index + 1));
      up.disabled = index === 0;
      down.disabled = index === CATALOGS.length - 1;
      btns.appendChild(up);
      btns.appendChild(down);
      btns.appendChild(
        smallButton("×", "remove", "Remove " + title, () => {
          CATALOGS.splice(index, 1);
          renderCatalogs();
        })
      );
      row.appendChild(btns);
      row.appendChild(filterControls(index, title));
      catalogList.appendChild(row);
    });
    renderTrendingChips();
    renderQuota();
    renderSummary();
  }

  // Only the Trending rows not added yet.
  function renderTrendingChips() {
    trendingChips.textContent = "";
    YT.trending.forEach((chart) => {
      if (CATALOGS.some((entry) => entry.kind === "trending" && entry.trending === chart.id)) return;
      trendingChips.appendChild(smallButton("+ " + chart.chip, "", "Add " + chart.label, () => addCatalog({ kind: "trending", trending: chart.id })));
    });
    if (!trendingChips.childNodes.length) trendingChips.appendChild(node("div", "cat-empty", "Every Trending row is added."));
  }

  function addCatalog(entry) {
    if (CATALOGS.length >= YT.maxCatalogs) return note("You can have at most " + YT.maxCatalogs + " catalogs.", true);
    if (CATALOGS.some((other) => sameCatalog(other, entry))) return note("You already have that catalog.", true);
    CATALOGS.push(entry);
    catalogInput.value = "";
    note("");
    renderCatalogs();
  }

  function addSearch(q) {
    if (q.length > YT.maxQuery) return note("A search can be at most " + YT.maxQuery + " characters long.", true);
    addCatalog({ kind: "search", q, sort: "relevance", length: "any", within: "any" });
  }

  // The add row asks for what the chosen source needs.
  catalogSource.addEventListener("change", () => {
    const source = choice(YT.sources, catalogSource.value);
    catalogInput.placeholder = source.placeholder;
    catalogInput.setAttribute("aria-label", source.prompt);
    note("");
  });

  // A link added as a search is a slip: YouTube would be searched for it.
  const isYoutubeLink = (text) => text.includes("youtube.com/") || text.includes("youtu.be/");

  function addFromInput() {
    const text = catalogInput.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    const kind = catalogSource.value;
    if (kind === "search") {
      if (isYoutubeLink(text)) return note("That is a YouTube link. To add it, choose YouTube playlist or YouTube channel.", true);
      return addSearch(text);
    }
    const key = $("youtube-key").value.trim();
    if (!key) return note("Enter your YouTube API key above first: it is used to look the link up.", true);
    if (typeof window.fetch !== "function") return note("This browser cannot look links up.", true);
    catalogAdd.disabled = true;
    note("Looking it up...");
    window
      .fetch("/api/youtube-source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ youtubeKey: key, input: text, kind })
      })
      .then((res) => res.json())
      .then(
        (answer) => {
          catalogAdd.disabled = false;
          if (answer.entry) return addCatalog(answer.entry);
          note(answer.error || "That could not be looked up.", true);
        },
        () => {
          catalogAdd.disabled = false;
          note("The link could not be looked up. Check your connection and try again.", true);
        }
      );
  }
  catalogAdd.addEventListener("click", addFromInput);
  // Enter in the box adds what was typed rather than submitting the form.
  catalogInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addFromInput();
  });

  // Minutes between refreshes as typed, or NaN.
  function refreshMinutes() {
    const text = refreshValue.value.trim();
    if (!isDecimal(text)) return NaN;
    return (parseFloat(text) * YT.refreshUnits[refreshUnit.value].ms) / 60000;
  }

  // What the search catalogs could cost a day at this interval, shown all day.
  function renderQuota() {
    const searches = CATALOGS.filter((c) => c.kind === "search").length;
    const minutes = refreshMinutes();
    quotaNote.className = "";
    quotaNote.textContent = "";
    if (!searches || !(minutes >= 30)) return;
    const most = Math.ceil(1440 / minutes) * searches;
    if (most >= 100) {
      quotaNote.className = "note-warn";
      quotaNote.textContent =
        "Shown all day, your search catalogs could spend all 100 of your daily searches, leaving none for films and episodes: refresh them less often, or use channels and playlists.";
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

  // --- The summary: the setup at a glance, each line a way to its tab.
  const summaryList = $("summary-list");

  function lookingFor() {
    const movies = $("type-movie").checked;
    const series = $("type-series").checked;
    if (movies && series) return "Movies and series";
    if (movies || series) return movies ? "Movies" : "Series";
    return "Neither: YouTube only";
  }

  function renderSummary() {
    const playing = pbOn().map((row) => row.querySelector("strong").textContent);
    const rows = [
      ["Looks for", lookingFor(), "search"],
      ["YouTube search in your app", ytSearch.checked ? ["On", shown(searchSort), shown(searchLength)].join(" · ") : "Off", "search"],
      [
        "Catalogs",
        CATALOGS.length ? CATALOGS.length + (CATALOGS.length === 1 ? " row: " : " rows: ") + CATALOGS.map(catalogName).join(", ") : "None yet",
        "catalogs"
      ],
      ["When you press play", playing.length ? playing.join(", then ") : "Nothing chosen yet", "streams"],
      ["Stream text", shown(presetSelect), "streams"],
      ["Country and language", shown(regionSelect) + " · " + shown($("audio-language")), "search"]
    ];
    summaryList.textContent = "";
    rows.forEach(([name, value, tab]) => {
      const link = node("a", "summary-row");
      link.href = "#" + tab;
      link.appendChild(node("span", "s-name", name));
      link.appendChild(node("span", "s-value", value));
      const item = node("li");
      item.appendChild(link);
      summaryList.appendChild(item);
    });
  }

  renderCatalogs();

  // --- Reading the form ---------------------------------------------------
  // A config, or { problem, field }: what is wrong, and the field to fix.
  // For an export, a missing key and the unticked terms box are no problem.
  const problem = (text, field) => ({ problem: text, field });

  function readConfig(forExport) {
    const youtubeKey = $("youtube-key").value.trim();
    const tmdbKey = $("tmdb-key").value.trim();
    if (!youtubeKey && !forExport) return problem("Enter your YouTube API key.", "youtube-key");
    if (!isKeyText(youtubeKey)) return problem("That YouTube key has characters a key never has. Copy it again, without spaces.", "youtube-key");
    if (!isKeyText(tmdbKey)) return problem("That TMDB key has characters a key never has. Copy it again, without spaces.", "tmdb-key");

    const types = ["movie", "series"].filter((type) => $("type-" + type).checked);
    if (!types.length && !ytSearch.checked && !CATALOGS.length) {
      return problem("Choose something for YouStream to do: movies, series, YouTube search, or a catalog.", "type-movie");
    }

    const config = {};
    if (youtubeKey) config.youtubeKey = youtubeKey;
    if (tmdbKey) config.tmdbKey = tmdbKey;

    for (const row of document.querySelectorAll(".margin-row")) {
      const name = row.getAttribute("data-margin");
      const input = row.querySelector(".margin-value");
      const text = input.value.trim();
      const unit = row.querySelector(".margin-unit").value;
      const label = row.querySelector("strong").textContent;
      if (!isDecimal(text)) return problem(label + ": enter the margin as a number, 0 or more.", input.id);
      const value = parseFloat(text);
      const limit = PAGE.marginUnits[unit];
      if (value > limit.max) return problem(label + ": at most " + limit.max + " " + limit.label + ".", input.id);
      const usual = PAGE.defaultMargins[name];
      if (value !== usual.value || unit !== usual.unit) config[name] = value + unit;
    }

    const playback = pbOn().map((row) => row.getAttribute("data-option"));
    if (!playback.length) return problem("Turn on at least one way to watch.", pbRows()[0].querySelector(".pb-on").id);
    config.playback = playback;
    config.playbackVersion = PAGE.playbackVersion;

    if (types.length < 2) config.types = types;

    const maxText = $("max-results").value.trim();
    const maxResults = parseInt(maxText, 10);
    if (!isWholeNumber(maxText) || maxResults < 1 || maxResults > PAGE.maxResultsLimit) {
      return problem("Videos to list: a whole number from 1 to " + PAGE.maxResultsLimit + ".", "max-results");
    }
    if (maxResults !== PAGE.defaultMaxResults) config.maxResults = maxResults;

    const minViewsText = $("min-views").value.trim();
    const minViews = parseInt(minViewsText, 10);
    if (!isWholeNumber(minViewsText) || minViews > PAGE.maxMinViews) return problem("Minimum views: a whole number, 0 or more.", "min-views");
    if (minViews !== PAGE.defaultMinViews) config.minViews = minViews;

    if (regionSelect.value) config.region = regionSelect.value;
    const audioLanguage = $("audio-language").value;
    if (audioLanguage) config.audioLanguage = audioLanguage;
    if ($("embeddable-only").checked) config.embeddableOnly = true;
    if ($("official-only").checked) config.officialOnly = true;

    for (const id of ["movie-query", "episode-query"]) {
      if (!$(id).value.includes("{title}")) return problem("Both searches need {title} in them.", id);
    }
    const movieQuery = $("movie-query").value.trim();
    const episodeQuery = $("episode-query").value.trim();
    if (movieQuery !== PAGE.defaultMovieQuery) config.movieQuery = movieQuery;
    if (episodeQuery !== PAGE.defaultEpisodeQuery) config.episodeQuery = episodeQuery;

    const templates = templatesInUse();
    if (templates.name.length > FORMAT.maxName || templates.description.length > FORMAT.maxDescription) {
      return problem("The stream name can be " + FORMAT.maxName + " characters long and the description " + FORMAT.maxDescription + ".", "name-template");
    }
    const preset = matchingPreset(templates.name, templates.description);
    if (!preset) {
      config.nameTemplate = templates.name;
      config.descriptionTemplate = templates.description;
    } else if (preset !== FORMAT.defaultFormat) {
      config.format = preset;
    }

    const exclude = readList("exclude");
    if (exclude.join(",") !== PAGE.defaultExclude.join(",")) config.exclude = exclude;
    const excludeDescription = readList("exclude-description");
    if (excludeDescription.join(",") !== PAGE.defaultExcludeDescription.join(",")) config.excludeDescription = excludeDescription;

    if (!ytSearch.checked) config.search = false;
    if (searchSort.value !== "relevance") config.searchSort = searchSort.value;
    if (searchLength.value !== "any") config.searchLength = searchLength.value;
    const safeSearch = $("safe-search").value;
    if (safeSearch !== "moderate") config.safeSearch = safeSearch;
    if (CATALOGS.length) config.catalogs = CATALOGS.map(storedCatalog);
    const minutes = refreshMinutes();
    if (!(minutes > 0)) return problem("Refresh catalogs every: enter a number.", "refresh-value");
    if (minutes < 30) return problem("Refresh catalogs every: at least 30 minutes.", "refresh-value");
    const refresh = parseFloat(refreshValue.value.trim()) + refreshUnit.value;
    if (refresh !== YT.defaultRefresh.value + YT.defaultRefresh.unit) config.catalogRefresh = refresh;

    if (!$("agree").checked && !forExport) {
      return problem("To install YouStream, agree to the YouTube Terms of Service and YouStream's terms of use and privacy policy.", "agree");
    }
    return config;
  }

  // The link that carries the settings, ready to install.
  function showResult(config, warning) {
    // One path segment of encodeURIComponent(JSON.stringify(config)): the
    // stremio-addon-sdk convention.
    const httpUrl = PAGE.baseUrl.replace(/\/+$/, "") + "/" + encodeURIComponent(JSON.stringify(config)) + "/manifest.json";
    $("install-link").href = httpUrl.replace(/^https?:\/\//, "stremio://");
    $("manifest-url").value = httpUrl;
    warningEl.textContent = warning;
    warningEl.style.display = warning ? "block" : "none";
    resultEl.classList.add("show");
    openTab("summary");
    if (resultEl.scrollIntoView) resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Asks the server to try the keys, so a bad one is caught here rather
  // than discovered later as an empty stream list, then hands the config on
  // with a warning, if any. If the check itself cannot run, it is handed on
  // anyway: the keys may well be fine.
  function checkKeys(config, then) {
    if (typeof window.fetch !== "function") return then(config, "");
    busy(submitBtn, "Checking your keys...");
    window
      .fetch("/api/check-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ youtubeKey: config.youtubeKey, tmdbKey: config.tmdbKey || "" })
      })
      .then((res) => res.json())
      .then(
        (status) => {
          idle(submitBtn);
          if (KEY_PROBLEMS[status.youtube]) return showError(KEY_PROBLEMS[status.youtube], "youtube-key");
          if (status.tmdb === "invalid") return showError(TMDB_INVALID, "tmdb-key");
          then(config, status.youtube === "quota" ? QUOTA_WARNING : "");
        },
        () => {
          idle(submitBtn);
          then(config, "");
        }
      );
  }

  // --- Profiles -------------------------------------------------------------
  // PROFILE.mode: "profile" (signed in, editing it), "signin" (opened from a
  // profile's install link, not signed in to it) or "new".
  let noProfile = !PROFILE.usable;
  let leaving = false;
  let dirty = false;
  const saveBar = $("save-bar");

  // Leaves the page without the unsaved-changes question.
  function go(url) {
    leaving = true;
    navigate(url);
  }

  // Calls the profile API: the answer's data, or an Error with its message.
  function api(method, path, body) {
    return window
      .fetch(path, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      })
      .then(
        (res) => {
          if (res.status === 204) return {};
          return res
            .json()
            .then(null, () => ({}))
            .then((data) => {
              if (!res.ok) throw new Error(data.error || "YouStream answered with an error (" + res.status + "). Try again.");
              return data;
            });
        },
        () => {
          throw new Error("YouStream could not be reached. Check your connection and try again.");
        }
      );
  }

  // Offers the profile ID and password to the browser's password manager,
  // where it can take them (Chrome, Android); waits at most a few seconds.
  function rememberLogin(id, password) {
    let stored = null;
    try {
      if (window.PasswordCredential && navigator.credentials && navigator.credentials.store) {
        stored = navigator.credentials.store(new window.PasswordCredential({ id, password, name: "YouStream profile" }));
      }
    } catch {
      // A browser that will not take it: the profile is made all the same.
    }
    return Promise.race([Promise.resolve(stored).then(null, () => {}), new Promise((done) => window.setTimeout(done, 2500))]);
  }

  // The profile ID in what was typed or pasted: the ID, or a whole install link.
  function profileIdFrom(text) {
    const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(String(text).trim().toLowerCase());
    return match ? match[0] : "";
  }

  function markDirty() {
    if (PROFILE.mode !== "profile" || dirty) return;
    dirty = true;
    saveBar.hidden = false;
    document.body.classList.add("has-save-bar");
    say(saveStatus, "");
  }

  function markClean() {
    dirty = false;
    saveBar.hidden = true;
    document.body.classList.remove("has-save-bar");
  }

  // Any edit to the form: typing, choosing, and every button but the eye on
  // a key and the preview's tabs. The summary follows every one.
  form.addEventListener("input", () => {
    markDirty();
    renderSummary();
  });
  form.addEventListener("change", () => {
    markDirty();
    renderSummary();
  });
  form.addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button || button.type === "submit" || button.matches(".key-toggle, .preview-tab")) return;
    markDirty();
    renderSummary();
  });
  window.addEventListener("beforeunload", (e) => {
    if (!dirty || leaving) return;
    e.preventDefault();
    e.returnValue = "";
  });
  if (PROFILE.imported) {
    markDirty();
    // Reloading should not post the file again: the page reads as /configure.
    window.history.replaceState(null, "", "/configure");
  }
  if (saveBar) {
    $("save-bar-btn").addEventListener("click", () => submitBtn.click());
    // Back to the profile as saved.
    $("save-bar-discard").addEventListener("click", () => go("/configure"));
  }
  if (finishBar) $("finish-go").addEventListener("click", () => reveal("submit-btn"));

  // Saves the signed-in profile's settings.
  function saveProfile(config, warning) {
    busy(submitBtn, "Saving...");
    api("PUT", "/api/profile", { config }).then(
      (data) => {
        idle(submitBtn);
        markClean();
        say(
          saveStatus,
          "Saved. " +
            (data.manifestChanged
              ? "What YouStream offers changed (its rows, or what it finds streams for): Stremio keeps the old list until you reinstall YouStream there; Nuvio picks it up the next time it starts, and AIOStreams within 6 hours."
              : "No need to reinstall: your apps use the new settings from their next request.") +
            (warning ? " " + warning : ""),
          "good"
        );
      },
      (err) => {
        idle(submitBtn);
        showError(err.message);
      }
    );
  }

  // What is wrong with the new profile's passwords, if anything.
  function passwordProblem() {
    const pw = $("create-password").value;
    if (pw.length < PROFILE.passwordMin) return problem("Choose a password of at least " + PROFILE.passwordMin + " characters for your profile.", "create-password");
    if (pw !== $("create-password2").value) return problem("The two passwords are not the same.", "create-password2");
    return null;
  }

  // Creates the profile, signs this browser in, and opens it.
  function createProfile(config) {
    const pw = $("create-password").value;
    busy(submitBtn, "Creating your profile...");
    api("POST", "/api/profile", { config, password: pw, remember: $("create-remember").checked }).then(
      (data) => {
        $("create-id").value = data.id;
        return rememberLogin(data.id, pw).then(() => go("/configure?done=created"));
      },
      (err) => {
        idle(submitBtn);
        showError(err.message);
      }
    );
  }

  const noProfileBtn = $("no-profile-btn");
  if (noProfileBtn) {
    noProfileBtn.addEventListener("click", () => {
      noProfile = !noProfile;
      $("create-card").hidden = noProfile;
      submitBtn.textContent = noProfile ? "Generate install link" : "Create profile and get install link";
      submitBtn.removeAttribute("data-label");
      noProfileBtn.textContent = noProfile
        ? "Create a profile instead: one link that never changes"
        : "Or make an install link that carries your settings, without a profile";
      hideError();
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    hideError();
    say(saveStatus, "");
    const config = readConfig();
    if (config.problem) return showError(config.problem, config.field);
    if (PROFILE.mode === "profile") return checkKeys(config, saveProfile);
    if (!noProfile) {
      const wrong = passwordProblem();
      if (wrong) return showError(wrong.problem, wrong.field);
      return checkKeys(config, createProfile);
    }
    checkKeys(config, showResult);
  });

  // Signing in.
  const signinForm = $("signin-form");
  if (signinForm) {
    signinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = $("signin-msg");
      const btn = $("signin-btn");
      const id = profileIdFrom($("signin-id").value);
      const password = $("signin-password").value;
      if (!id) return say(msg, "Enter your profile ID. It is in your install link, before the dot.", "bad");
      if (!password) return say(msg, "Enter your password.", "bad");
      say(msg, "");
      busy(btn, "Signing in...");
      api("POST", "/api/profile/session", { id, password, remember: $("signin-remember").checked }).then(
        () => rememberLogin(id, password).then(() => go("/configure")),
        (err) => {
          idle(btn);
          say(msg, err.message, "bad");
        }
      );
    });
  }

  // Signing out: this device, or every one.
  const signoutBtn = $("signout-btn");
  if (signoutBtn) {
    const signoutPanel = $("signout-panel");
    const toggle = (open) => {
      signoutPanel.hidden = !open;
      signoutBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    signoutBtn.addEventListener("click", () => toggle(signoutPanel.hidden));
    $("signout-cancel").addEventListener("click", () => toggle(false));
    $("signout-confirm").addEventListener("click", () => {
      const btn = $("signout-confirm");
      busy(btn, "Signing out...");
      api("DELETE", $("signout-all").checked ? "/api/profile/sessions" : "/api/profile/session").then(
        () => go("/configure"),
        (err) => {
          idle(btn);
          say($("signout-msg"), err.message, "bad");
        }
      );
    });
  }

  function copyText(input, button) {
    const clipboard = navigator.clipboard;
    if (!clipboard) return input.select();
    clipboard.writeText(input.value).then(
      () => {
        button.textContent = "Copied!";
        window.setTimeout(() => {
          button.textContent = "Copy";
        }, 1500);
      },
      () => input.select()
    );
  }
  $("copy-btn").addEventListener("click", () => copyText($("manifest-url"), $("copy-btn")));
  const profileCopy = $("profile-copy");
  if (profileCopy) profileCopy.addEventListener("click", () => copyText($("profile-url"), profileCopy));

  // The profile's password, link and existence, each confirmed with the password.
  const value = (id) => $(id).value;

  function secured(buttonId, msgId, run) {
    const btn = $(buttonId);
    if (!btn) return;
    btn.addEventListener("click", () => {
      const msg = $(msgId);
      const wrong = run.check();
      if (wrong) return say(msg, wrong, "bad");
      say(msg, "");
      busy(btn, run.busy);
      run.call().then(
        (data) => {
          idle(btn);
          run.done(data, msg);
        },
        (err) => {
          idle(btn);
          say(msg, err.message, "bad");
        }
      );
    });
  }

  secured("pw-btn", "pw-msg", {
    busy: "Changing...",
    check() {
      if (!value("pw-current")) return "Enter your current password.";
      if (value("pw-new").length < PROFILE.passwordMin) return "Choose a new password of at least " + PROFILE.passwordMin + " characters.";
      if (value("pw-new") !== value("pw-new2")) return "The two new passwords are not the same.";
      return "";
    },
    call: () => api("POST", "/api/profile/password", { currentPassword: value("pw-current"), newPassword: value("pw-new") }),
    done(data, msg) {
      rememberLogin(PROFILE.id, value("pw-new"));
      ["pw-current", "pw-new", "pw-new2"].forEach((id) => {
        $(id).value = "";
      });
      say(msg, "Password changed. Every other device was signed out; this one stays signed in. Your install link is the same.", "good");
    }
  });

  secured("link-btn", "link-msg", {
    busy: "Replacing...",
    check: () => (value("link-password") ? "" : "Enter your password."),
    call: () => api("POST", "/api/profile/link", { password: value("link-password") }),
    done(data, msg) {
      $("link-password").value = "";
      $("profile-url").value = data.installUrl;
      $("profile-install").href = data.installUrl.replace(/^https?:\/\//, "stremio://");
      say(msg, "Replaced: the old link no longer works. Install YouStream again with the new link on the Summary tab, wherever you use it.", "good");
    }
  });

  secured("delete-btn", "delete-msg", {
    busy: "Deleting...",
    check() {
      if (!value("delete-password")) return "Enter your password.";
      return $("delete-sure").checked ? "" : "Tick the box to confirm.";
    },
    call: () => api("DELETE", "/api/profile", { password: value("delete-password") }),
    done: () => go("/configure?done=deleted")
  });

  // --- Backups: the form to a file, and a file to the form.
  const SETTINGS_KEYS = [
    "youtubeKey", "tmdbKey", "movieMargin", "partnerMovieMargin", "episodeMargin", "typicalMargin", "playback", "playbackVersion",
    "types", "maxResults", "minViews", "region", "audioLanguage", "embeddableOnly", "officialOnly", "exclude", "excludeDescription",
    "movieQuery", "episodeQuery", "format", "nameTemplate", "descriptionTemplate", "search", "searchSort", "searchLength",
    "safeSearch", "catalogs", "catalogRefresh"
  ];
  const backupMsg = $("backup-msg");
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) =>
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "." + pad(d.getHours()) + "-" + pad(d.getMinutes()) + "-" + pad(d.getSeconds());

  $("export-btn").addEventListener("click", () => {
    const config = readConfig(true);
    if (config.problem) return say(backupMsg, config.problem, "bad");
    const withoutKeys = $("export-no-keys").checked;
    if (withoutKeys) {
      delete config.youtubeKey;
      delete config.tmdbKey;
    }
    const file = { youstream: "settings", version: 1, exportedAt: new Date().toISOString(), keysIncluded: !withoutKeys, config };
    const link = document.createElement("a");
    link.href = window.URL.createObjectURL(new window.Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    link.download = "youstream-settings-" + stamp(new Date()) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(link.href), 1000);
    say(backupMsg, withoutKeys ? "Exported, without your keys." : "Exported, with your keys in it: keep the file private.", "good");
  });

  // The settings a file holds: an export's, or a bare settings object.
  function settingsIn(parsed) {
    const isObject = (thing) => Boolean(thing) && typeof thing === "object" && !Array.isArray(thing);
    if (!isObject(parsed)) return null;
    const exported = parsed.youstream === "settings";
    const config = exported ? parsed.config : parsed;
    if (!isObject(config)) return null;
    return exported || SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(config, key)) ? config : null;
  }

  // Sends the settings to be shown in the form, for the reader to look over
  // and save: a form post, so the keys stay out of any URL.
  function showImported(config, fileName) {
    const post = document.createElement("form");
    post.method = "post";
    post.action = "/configure";
    post.hidden = true;
    [
      ["config", JSON.stringify(config)],
      ["file", fileName]
    ].forEach(([name, text]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = text;
      post.appendChild(input);
    });
    document.body.appendChild(post);
    leaving = true;
    post.submit();
  }

  const importFile = $("import-file");
  $("import-btn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files[0];
    if (!file) return;
    const reader = new window.FileReader();
    reader.onload = () => {
      let config = null;
      try {
        config = settingsIn(JSON.parse(reader.result));
      } catch (e) {
        config = null;
      }
      importFile.value = "";
      if (!config) return say(backupMsg, "That file holds no YouStream settings. Choose a file exported here.", "bad");
      // Keys the file leaves out stay as they are.
      const current = readConfig(true);
      const merged = { ...config };
      if (!merged.youtubeKey && current.youtubeKey) merged.youtubeKey = current.youtubeKey;
      if (!merged.tmdbKey && current.tmdbKey) merged.tmdbKey = current.tmdbKey;
      showImported(merged, file.name);
    };
    reader.readAsText(file);
  });

  // --- The page as an app: offline note and icons (sw.js), and an install
  // button where the browser offers to install it.
  if (navigator.serviceWorker) navigator.serviceWorker.register("/sw.js").then(null, () => {});
  const installApp = $("install-app");
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    installApp.hidden = false;
  });
  installApp.addEventListener("click", () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    installApp.hidden = true;
    prompt.prompt();
  });
  window.addEventListener("appinstalled", () => {
    installApp.hidden = true;
  });
};
