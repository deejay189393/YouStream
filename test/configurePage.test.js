const { renderConfigurePage, escapeHtml, jsonForScript } = require("../src/configurePage");
const { normalizeConfig } = require("../src/config");

const BASE = "https://youstream.up.railway.app";
const page = (existing = null, extra = {}) => renderConfigurePage({ baseUrl: BASE, existing, ...extra });

describe("escaping", () => {
  test("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  test("jsonForScript cannot end the script early", () => {
    expect(jsonForScript("</script><b>")).not.toContain("</script>");
    expect(jsonForScript("a b c")).toBe('"a\\u2028b\\u2029c"');
  });

  test("a hostile Host header cannot break out of the page script", () => {
    const html = renderConfigurePage({ baseUrl: "http://x</script><script>alert(1)//", existing: null });
    expect(html).not.toContain("</script><script>alert(1)");
  });
});

describe("a new setup", () => {
  const html = page();

  test("asks for the YouTube key, with the steps to get one", () => {
    expect(html).toContain('id="youtube-key"');
    expect(html).toContain("YouTube Data API v3");
    expect(html).toContain("Application restrictions");
  });

  test("offers the TMDB key as optional, and says what it is for", () => {
    expect(html).toContain('id="tmdb-key"');
    expect(html).toContain("Without it, episodes are matched against the show");
  });

  test("shows the default margins", () => {
    expect(html).toMatch(/data-margin="movieMargin"[\s\S]*?value="10"[\s\S]*?<option value="m" selected>/);
    expect(html).toMatch(/data-margin="partnerMovieMargin"[\s\S]*?value="20"[\s\S]*?<option value="%" selected>/);
    expect(html).toMatch(/data-margin="episodeMargin"[\s\S]*?value="90"[\s\S]*?<option value="s" selected>/);
    expect(html).toMatch(/data-margin="typicalMargin"[\s\S]*?value="30"[\s\S]*?<option value="%" selected>/);
  });

  test("offers the official-channels switch, off", () => {
    expect(html).toContain('id="official-only" />');
  });

  test("lists the ways to watch, in-app first", () => {
    const order = [...html.matchAll(/class="pb-option" data-option="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["app", "youtube", "smarttube"]);
  });

  test("is not marked as editing", () => {
    expect(html).not.toContain("Editing your current setup");
  });
});

describe("reconfiguring", () => {
  const existing = normalizeConfig({
    youtubeKey: "AIzaMine",
    tmdbKey: "tmdbMine",
    movieMargin: "15%",
    playback: ["youtube"],
    types: ["series"],
    region: "IN",
    audioLanguage: "hi",
    embeddableOnly: true,
    officialOnly: true,
    exclude: ["trailer", "reaction"],
    excludeDescription: ["fan movie"],
    movieQuery: "{title} movie"
  });
  const html = page(existing);

  test("pre-fills every setting", () => {
    expect(html).toContain('value="AIzaMine"');
    expect(html).toContain('value="tmdbMine"');
    expect(html).toMatch(/data-margin="movieMargin"[\s\S]*?value="15"[\s\S]*?<option value="%" selected>/);
    expect(html).toContain('id="type-movie" />');
    expect(html).toContain('id="type-series" checked />');
    expect(html).toContain('<option value="IN" selected>India</option>');
    expect(html).toContain('<option value="hi" selected>Hindi</option>');
    expect(html).toContain('id="embeddable-only" checked');
    expect(html).toContain('id="official-only" checked');
    expect(html).toContain(">fan movie</textarea>");
    expect(html).toContain(">trailer, reaction</textarea>");
    expect(html).toContain('value="{title} movie"');
    expect(html).toContain("Editing your current setup");
  });

  test("lists the reader's ways to watch first", () => {
    const order = [...html.matchAll(/class="pb-option" data-option="(\w+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("youtube");
  });
});

test("a movies-only setup leaves series unticked", () => {
  const html = page(normalizeConfig({ youtubeKey: "k", types: ["movie"] }));
  expect(html).toContain('id="type-movie" checked />');
  expect(html).toContain('id="type-series" />');
});

test("says when the server has its own TMDB key", () => {
  expect(page(null, { serverTmdb: true })).toContain("This server already has a TMDB key");
});
