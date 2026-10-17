const { templateWarnings } = require("../src/templateCheck");
const { PRESETS } = require("../src/streamFormat");

describe("templateWarnings", () => {
  test.each(Object.keys(PRESETS))("the %s preset raises none", (id) => {
    expect(templateWarnings(PRESETS[id].name, PRESETS[id].description)).toEqual([]);
  });

  test("a debrid code typed into the name", () => {
    expect(templateWarnings("YouStream EN", "")).toEqual([
      "AIOStreams reads “EN” in a stream's name as a debrid service, and would take these YouTube rows for debrid streams."
    ]);
    expect(templateWarnings("[TorBox] {addon.name}", "")[0]).toContain("“TorBox”");
  });

  test("what a field puts in the name, and WEB-DL, are not the reader's typing", () => {
    expect(templateWarnings("{stream.languageCodes::join(' ')} {stream.quality} WEB-DL web-dl", "")).toEqual([]);
    expect(templateWarnings('{stream.title::exists["{?{x.y}?}"||""]} {? ok ?}', "")).toEqual([]);
  });

  test("seeders' emojis, sizes and flags typed into the description", () => {
    expect(templateWarnings("", "👤 {video.views}\n💾 1.5 GB\n🇬🇧")).toEqual([
      "AIOStreams reads a number after 👤 or 👥 in the description as torrent seeders.",
      "AIOStreams reads a size such as “1.5 GB” in the description as the file's size.",
      "AIOStreams reads a flag in the description as a language every stream is in."
    ]);
    expect(templateWarnings("", "{stream.languageEmojis::join(' ')} 2 GBP")).toEqual([]);
  });

  test("no templates, no warnings", () => {
    expect(templateWarnings(null, undefined)).toEqual([]);
  });
});
