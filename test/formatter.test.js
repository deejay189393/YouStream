const { createFormatter } = require("../src/formatter");

const LANGUAGES = [
  { name: "English", code: "en", flag: "🇬🇧" },
  { name: "Japanese", code: "ja", flag: "🇯🇵" },
  { name: "Tamil", code: "ta", flag: "" }
];
const f = createFormatter({ languages: LANGUAGES });

const scope = () => ({
  stream: {
    title: "The Example",
    filename: "The.Example.1999.2160p.mkv",
    resolution: "2160p",
    quality: "BluRay",
    seeders: 52,
    size: 1288490189,
    duration: 5025000,
    languages: ["English", "Japanese"],
    visualTags: ["HDR10+", "DV"],
    empty: [],
    numbers: [10, 2, 33],
    site: "www.Site.org",
    date: "2023-07-04",
    library: true,
    cached: false,
    type: "youtube",
    seasonEpisode: ["S01", "E05"],
    missing: null,
    blank: "   ",
    tracks: [{ lang: "English" }]
  },
  service: { cached: null, id: null },
  user: { languages: ["English"], none: [], one: "Japanese" }
});
const r = (template, s = scope(), guard) => f.render(template, s, guard);

describe("fields and literals", () => {
  test.each([
    ["{stream.title}", "The Example"],
    ["{ Stream.Title }", "The Example"],
    ["{stream.seeders}", "52"],
    ["{stream.library}", "true"],
    ["{stream.languages}", "English,Japanese"],
    ["{stream.missing}", ""],
    ["{'n/a'::upper}", "N/A"],
    ['{"x"}', "x"],
    ["{stream.title::nope}", "{unknown_string_modifier(nope)}"],
    ["{stream.size::nope(1)}", "{unknown_number_modifier(nope(1))}"],
    ["{stream.tracks::upper}", "{unknown_array_modifier(upper)}"],
    ["{stream.foo}", "{unknown_propertyName(stream.foo)}"],
    ["{nope.bar}", "{unknown_variableType(nope)}"],
    ["{notafield}", "{notafield}"],
    ["{a.b.c}", "{a.b.c}"],
    ["{stream.missing::upper}", ""],
    ["{stream.missing::default('—')}", "—"],
    ["{stream.title::default('—')}", "The Example"]
  ])("%s", (template, expected) => {
    expect(r(template)).toBe(expected);
  });

  test("a value is never read as a layout directive", () => {
    expect(r("{stream.title}", { stream: { title: "a\u0012b\u0011c" } })).toBe("abc");
    expect(r("{stream.list::join('-')}", { stream: { list: ["x\u0012", 3] } })).toBe("x-3");
  });

  test("an object's fields are matched without case", () => {
    expect(r("{STREAM.TITLE}", { Stream: { Title: "T" } })).toBe("T");
  });

  test("a value grown past the cap is cut", () => {
    const out = r("{stream.v::replace('a','aaaaaaaaaa')}", { stream: { v: "a".repeat(1000) } });
    expect(out).toHaveLength(8000);
    expect(r("{'b'::replace('b','{stream.v}')}", { stream: { v: "x" } })).toBe("{stream.v}");
  });
});

describe("string modifiers", () => {
  test.each([
    ["{stream.title::upper}", "THE EXAMPLE"],
    ["{stream.title::lower}", "the example"],
    ["{' padded '::trim}x", "paddedx"],
    ["{'hELLO wORLD'::title}", "Hello World"],
    ["{stream.title::length}", "11"],
    ["{'abc'::reverse}", "cba"],
    ["{'Hi'::base64}", "SGk="],
    ["{'ab'::base64}", "YWI="],
    ["{'abc'::base64}", "YWJj"],
    ["{'é€😀'::base64}", "w6nigqzwn5iA"],
    ["{stream.title::string}", "The Example"],
    ["{'ready'::smallcaps}", "ʀᴇᴀᴅʏ"],
    ["{stream.resolution::smallcaps}", "2160ᴘ"],
    ["{stream.resolution::subscript::smallcaps}", "₂₁₆₀ᴘ"],
    ["{'(1+2)'::superscript}", "⁽¹⁺²⁾"],
    ["{stream.quality::translate('Bl','Яⅼ')}", "ЯⅼuRay"],
    ["{stream.quality::translate('Bluxyz','Я')}", "ЯluRay"],
    ["{'English'::languageCode} {'en'::languageCode} {'Klingon'::languageCode}", "EN EN KLINGON"],
    ["{'Japanese'::languageEmoji}|{'Tamil'::languageEmoji}|{'Klingon'::languageEmoji}", "🇯🇵||"],
    ["{stream.filename::lower::truncate(20)}", "the.example.1999.216…"],
    ["{'short'::truncate(10)}", "short"],
    ["{'two words'::truncate(4)}", "two…"],
    ["{stream.title::truncate(-1)}", "{unknown_string_modifier(truncate(-1))}"],
    ["{'--x--'::trim('-')}", "x"],
    ["{'xx'::trim('x')}", ""],
    ["{stream.title::trim(x)}", "{unknown_string_modifier(trim(x))}"],
    ["{stream.title::replace('Example','Test')}", "The Test"],
    ["{stream.filename::replace('{stream.site}','')}", "The.Example.1999.2160p.mkv"],
    ["{'a www.Site.org b'::replace('{stream.site}','X')}", "a X b"],
    ["{'a www.Site.org b'::replace({stream.site}, 'Y')}", "a Y b"],
    ["{'a b'::replace('{stream.missing}','X')}", "a b"],
    ["{'a b'::replace('{stream.languages}','X')}", "a b"],
    ["{stream.title::replace('','x')}", "The Example"],
    ["{stream.title::replace('a','b','c')}", "The Example"],
    ["{stream.title::remove('The ', 'mple')}", "Exa"],
    ["{'English is here'::remove({user.languages})}", " is here"],
    ["{stream.title::keep('x')}", "{unknown_string_modifier(keep('x'))}"],
    ["{stream.date::date('%B %o, %Y')::upper}", "JULY 4TH, 2023"],
    ["{stream.date::date('%Y-%m-%d %y %-m/%-d %d %b %A %a')}", "2023-07-04 23 7/4 04 Jul Tuesday Tue"],
    ["{'2023-02-30'::date('%Y')}", "2023-02-30"],
    ["{'soon'::date('%Y')}", "soon"],
    ["{'2023-07-04'::date('%Q %% %[ %]')}", "%Q % [ ]"],
    ["{'2023-07-04'::date('%')}", "%"],
    ["{stream.date::date(x)}", "{unknown_string_modifier(date(x))}"]
  ])("%s", (template, expected) => {
    expect(r(template)).toBe(expected);
  });

  test("ordinals", () => {
    const day = (d) => r(`{'2023-01-${String(d).padStart(2, "0")}'::date('%o')}`);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(day)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"
    ]);
  });
});

describe("number modifiers", () => {
  test.each([
    ["{stream.seeders::hex} {stream.seeders::octal} {stream.seeders::binary}", "34 64 110100"],
    ["{stream.size::bytes} {stream.size::bytes10} {stream.size::sbytes} {stream.size::sbytes10}", "1.29 GB 1.29 GB 1.29 GB 1.29 GB"],
    ["{stream.size::bytes2} {stream.size::sbytes2} {stream.size::rbytes} {stream.size::rbytes10} {stream.size::rbytes2}", "1.2 GiB 1.2 GiB 1 GB 1 GB 1 GiB"],
    ["{stream.zero::bytes}", "0 B"],
    ["{stream.big::sbytes}", "123 GB"],
    ["{stream.mid::sbytes} {stream.mid2::sbytes}", "12.5 GB 12 GB"],
    ["{stream.rate::bitrate} {stream.rate::rbitrate} {stream.rate::sbitrate}", "5.25 Mbps 5 Mbps 5.25 Mbps"],
    ["{stream.zero::bitrate} {stream.zero::sbitrate}", "0 bps 0 bps"],
    ["{stream.seeders::string}", "52"],
    ["{stream.duration::time}", "1h:23m:45s"],
    ["{stream.short::time} {stream.round::time}", "2m:5s 3m"],
    ["{stream.minutes::time}", "1h:30m:0s"],
    ["{stream.negative::time}", "0m"],
    ["{stream.duration::time('%H:%M:%S')}", "01:23:45"],
    ["{stream.duration::time('[%-Hh ]%-Mm[ %-Ss]')}", "1h 23m 45s"],
    ["{stream.short::time('[%-Hh ]%-Mm[ %-Ss]')}", "2m 5s"],
    ["{stream.duration::time('%-M min')}", "83 min"],
    ["{stream.duration::time('%-S')}", "5025"],
    ["{stream.duration::time('[ - ]%X')}", " - %X"],
    ["{stream.duration::time('[%-Hh')}", "1h"],
    ["{stream.duration::time(x)}", "{unknown_number_modifier(time(x))}"],
    ["{stream.title::time('%H')}", "{unknown_string_modifier(time('%H'))}"],
    ["{stream.score::star}|{stream.score::pstar}|{stream.high::pstar}|{stream.low::star}", "★★★⯪|★★★⯪☆|★★★★★|"]
  ])("%s", (template, expected) => {
    const s = scope();
    Object.assign(s.stream, {
      zero: 0, big: 123456789000, mid: 12500000000, mid2: 12000000000, rate: 5250000, short: 125000, round: 180000,
      minutes: 90, negative: -5, score: 70, high: 150, low: -5
    });
    expect(r(template, s)).toBe(expected);
  });
});

describe("array modifiers", () => {
  test.each([
    ["{stream.languages::join}", "English, Japanese"],
    ["{stream.languages::join(' / ')}", "English / Japanese"],
    ["{stream.languages::join(x)}", "{unknown_array_modifier(join(x))}"],
    ["a{stream.languages::join('{tools.newLine}')}", "aEnglish\nJapanese"],
    ["{stream.title::join(', ')}", "{unknown_string_modifier(join(', '))}"],
    ["{stream.languages::length} {stream.empty::length}", "2 0"],
    ["{stream.languages::first} {stream.languages::last}", "English Japanese"],
    ["[{stream.empty::first}][{stream.empty::last}][{stream.empty::random}]", "[][][]"],
    ["{stream.numbers::sort::join(',')} {stream.numbers::rsort::join(',')} {stream.numbers::lsort::join(',')}", "2,10,33 33,10,2 10,2,33"],
    ["{stream.visualTags::sort::join(',')} {stream.visualTags::rsort::join(',')}", "DV,HDR10+ HDR10+,DV"],
    ["{stream.languages::reverse::join(',')}", "Japanese,English"],
    ["{stream.dupes::unique::join(',')}", "a,b"],
    ["{stream.languages::string}", "English,Japanese"],
    ["{stream.languages::languageCode::join(' ')}", "EN JA"],
    ["{stream.mixed::languageEmoji::join('')}", "🇬🇧"],
    ["{stream.visualTags::replace('HDR10+', 'HDR')::unique::join(' | ')}", "HDR | DV"],
    ["{stream.languages::keep('english')::join(',')}", "English"],
    ["{stream.languages::remove({user.languages})::join(',')}", "Japanese"],
    ["{stream.languages::keep({user.one})::join(',')}", "Japanese"],
    ["{stream.languages::keep({user.none}, {stream.missing})::join(',')}", ""],
    ["{stream.seeders::remove('x')}", "{unknown_number_modifier(remove('x'))}"],
    ["{stream.languages::slice(1)::join(',')} {stream.numbers::slice(0, 2)::join(',')}", "Japanese 10,2"],
    ["{stream.languages::slice(x)}", "{unknown_array_modifier(slice(x))}"],
    ["{stream.title::slice(1)}", "{unknown_string_modifier(slice(1))}"],
    ["{stream.empty::where('lang=English')::exists[\"y\"||\"n\"]}", "n"],
    ["{stream.empty::pluck('lang')::length} {stream.empty::each(\"{track.lang}\")::length}", "0 0"],
    ["{stream.tracks::where('lang=English')}", "{unknown_array_modifier(where('lang=English'))}"],
    ["{stream.seasonEpisode::join('·')::replace('E','ᴇ')::replace('S','s')::translate('0123456789','₀₁₂₃₄₅₆₇₈₉')}", "s₀₁·ᴇ₀₅"]
  ])("%s", (template, expected) => {
    const s = scope();
    Object.assign(s.stream, { dupes: ["a", "A", "b"], mixed: ["English", "Tamil", "Klingon", "English"] });
    expect(r(template, s)).toBe(expected);
  });

  test("random picks one of the list", () => {
    expect(["English", "Japanese"]).toContain(r("{stream.languages::random}"));
  });

  test("a boolean's only modifier is string", () => {
    expect(r("{stream.library::string}")).toBe("true");
    expect(r("{stream.library::upper}")).toBe("{unknown_boolean_modifier(upper)}");
  });

  test("an object field has no modifiers", () => {
    expect(r("{stream.o::upper}", { stream: { o: {} } })).toBe("{unknown_object_modifier(upper)}");
  });
});

describe("checks", () => {
  test.each([
    ['{stream.library::istrue["y"||"n"]}', "y"],
    ['{stream.cached::isfalse["y"||"n"]}', "y"],
    ['{stream.missing::istrue["y"||"n"]}', "n"],
    ['{stream.missing::isfalse["y"||"n"]}', "n"],
    ['{stream.title::exists["y"||"n"]} {stream.blank::exists["y"||"n"]} {stream.empty::exists["y"||"n"]}', "y n n"],
    ['{stream.seeders::>1["Seeders: {stream.seeders}"||""]}', "Seeders: 52"],
    ['{stream.seeders::>=52["y"||"n"]}{stream.seeders::<=52["y"||"n"]}{stream.seeders::<53["y"||"n"]}{stream.seeders::=52["y"||"n"]}', "yyyy"],
    ['{stream.seeders::>52["y"||"n"]}{stream.seeders::<52["y"||"n"]}', "nn"],
    ['{stream.missing::>1["y"||"n"]}', "n"],
    ['{stream.type::=YouTube["y"||"n"]}{stream.type::=p2p["y"||"n"]}', "yn"],
    ['{stream.title::=the example["y"||"n"]}', "y"],
    // spaces in a check are ignored when the value has none, as AIOStreams does
    ['{stream.quality::= blu ray["y"||"n"]}', "y"],
    ['{stream.title::~exam["y"||"n"]}{stream.title::$The["y"||"n"]}{stream.title::^ple["y"||"n"]}', "yyy"],
    ['{stream.languages::~japanese["y"||"n"]}{stream.languages::$english["y"||"n"]}{stream.languages::^english["y"||"n"]}', "yyn"],
    ['{stream.title::>a["y"||"n"]}{stream.title::<a["y"||"n"]}{stream.title::>=the["y"||"n"]}{stream.title::<=the["y"||"n"]}', "ynyn"],
    ["{service.id::in('torbox','realdebrid')[\"🟩\"||\"⬜\"]}", "⬜"],
    ["{stream.type::in('YOUTUBE')[\"y\"||\"n\"]}{stream.languages::in('english')[\"y\"||\"n\"]}{stream.languages::in({user.languages})[\"⭐\"||\"\"]}", "yy⭐"],
    ["{stream.title::in()}", "{unknown_string_modifier(in())}"],
    ['{service.cached["Cached"||"Uncached"||"Unknown"]}', "Unknown"],
    ['{stream.cached["Cached"||"Uncached"||"Unknown"]}', "Uncached"],
    ['{stream.missing["y"||"n"]}', ""],
    ['{stream.title["y"||"n"]}', "{cannot_coerce_boolean_for_check_from(The Example)}"],
    ['{stream.title::exists["say \\"hi\\""||""]}', 'say "hi"'],
    ['{stream.title::exists[ "spaced" || "no" ]}', "spaced"],
    ['{stream.title::exists["a"||"b"||"c"||"d"]}', '{stream.title::exists["a"||"b"||"c"||"d"]}'],
    ['{stream.title::exists["a"]}', '{stream.title::exists["a"]}'],
    ['{stream.title::exists["a"||b]}', '{stream.title::exists["a"||b]}'],
    ['{stream.title::exists["a"||"b"]x}', '{stream.title::exists["a"||"b"]x}'],
    ['{stream.title::exists["a"||"b}', '{stream.title::exists["a"||"b}'],
    ['{stream.title::~[x]["y"||"n"]}', "n"],
    ["{stream.foo::exists[\"y\"||\"n\"]}", "{unknown_propertyName(stream.foo)}"],
    [
      '{stream.resolution::exists["{stream.quality::exists["{stream.resolution} {stream.quality}"||"{stream.resolution}"]}"||"Unknown"]}',
      "2160p BluRay"
    ]
  ])("%s", (template, expected) => {
    expect(r(template)).toBe(expected);
  });

  test("checks join with and, or and xor, left to right", () => {
    expect(r('{service.cached::isfalse::or::stream.type::=p2p::and::stream.seeders::>0["y"||"n"]}')).toBe("n");
    expect(r('{stream.library::istrue::and::stream.seeders::>1["y"||"n"]}')).toBe("y");
    expect(r('{stream.cached::istrue::and::stream.foo::exists["y"||"n"]}')).toBe("n");
    expect(r('{stream.library::istrue::or::stream.foo::exists["y"||"n"]}')).toBe("y");
    expect(r('{stream.library::istrue::xor::stream.cached::istrue["y"||"n"]}')).toBe("y");
    expect(r('{stream.library::istrue::xor::stream.library::istrue["y"||"n"]}')).toBe("n");
    expect(r('{stream.library::istrue::neq::stream.cached::istrue["y"||"n"]}')).toBe("y");
    expect(r('{stream.library::istrue::equal::stream.cached::istrue["y"||"n"]}')).toBe("n");
    expect(r('{stream.library::istrue::left::stream.cached::istrue["y"||"n"]}')).toBe("y");
    expect(r('{stream.library::istrue::right::stream.cached::istrue["y"||"n"]}')).toBe("n");
    expect(r('{stream.cached::istrue::or::stream.foo::exists["y"||"n"]}')).toBe("{unknown_propertyName(stream.foo)}");
    expect(r('{stream.foo::exists::or::stream.library::istrue["y"||"n"]}')).toBe("{unknown_propertyName(stream.foo)}");
    expect(r('{stream.library::istrue::and::stream.cached::isfalse::or::stream.missing::exists["y"||"n"]}')).toBe("y");
  });

  test("a joiner with nothing after it is a modifier, and a joined part must be a field", () => {
    expect(r("{stream.library::and}")).toBe("{unknown_boolean_modifier(and)}");
    expect(r("{stream.library::and::nope}")).toBe("{stream.library::and::nope}");
  });

  test("checks nest five deep, and deeper is text", () => {
    const deep = (n) => (n === 0 ? "{stream.title}" : `{stream.library::istrue["${deep(n - 1)}"||""]}`);
    expect(r(deep(5))).toBe("The Example");
    expect(r(deep(6))).toBe("{stream.title}");
  });
});

describe("groups and tools", () => {
  test.each([
    ["{?📅 {stream.missing} ?}X", "X"],
    ["{?📅 {stream.date} ?}X", "📅 2023-07-04 X"],
    ["{?[{stream.resolution}{? · {stream.quality}?}]?}", "[2160p · BluRay]"],
    ["{?[{stream.resolution}{? · {stream.missing}?}]?}", "[2160p]"],
    ["{?{stream.missing::default('d')}?}", "d"],
    ["{?{stream.type::replace('youtube','')}!?}", "!"],
    ['{?{stream.missing::exists["y"||"n"]}?}', "n"],
    ["{?{stream.foo} after?}", "{unknown_propertyName(stream.foo)} after"],
    ["{?{'literal'} {stream.title}?}", "literal The Example"],
    ["{?{stream.library::istrue::and::stream.missing::exists} x?}", ""],
    ["{?{stream.missing::exists::or::stream.title::exists} y?}", "true y"],
    ["{? unclosed {stream.title}", "{? unclosed The Example"],
    ["{?a{stream.title?}", "{?a{stream.title?}"],
    ["a{tools.newLine}b", "a\nb"],
    ["keep\n{tools.removeLine} gone\n\n   \nc", "keep\nc"],
    ["{tools.newLine::upper}", "{unknown_variableType(tools)}"],
    ["line\\nbreak", "line\nbreak"],
    ['{stream.library::istrue["a{tools.newLine}b"||""]}', "a\nb"]
  ])("%s", (template, expected) => {
    expect(r(template)).toBe(expected);
  });
});

describe("parsing", () => {
  test.each([
    ["{", "{"],
    ["a { b", "a { b"],
    ["{stream.title", "{stream.title"],
    ["{stream.title::replace('a','b'}", "{stream.title::replace('a','b'}"],
    ["{stream.title::replace('}','x')}", "The Example"],
    ["{stream.title::replace(')x(', 'y')}", "The Example"],
    ["{stream.title::replace('The', 'A \\'quoted\\'')}", "A \\'quoted\\' Example"],
    ["{stream.title::~don't}", "false"],
    ['{stream.title::exists["{stream.quality}"||"{stream.foo"]}', '{stream.title::exists["BluRay"||"{stream.foo"]}'],
    ['{stream.library::istrue["x {? {stream.title} ?}"||"y"]}', "x  The Example "],
    ['{stream.library::istrue["{? {stream.title} "||"y"]}', "{? The Example "],
    ['{stream.library::istrue["{"||"y"]}', '{stream.library::istrue["{"||"y"]}'],
    ["{stream.library::istrue[\"a\\\\\"||\"y\"]}", "a\\\\"],
    ["{'a::b'::upper}", "{'a::b'::upper}"],
    ["{stream.title::replace('x','{stream.title}')}", "The E{stream.title}ample"],
    ["{stream.title::replace('The','\\\"')}", '\\" Example']
  ])("%s", (template, expected) => {
    expect(r(template)).toBe(expected);
  });

  test("an unclosed nested block inside a branch or group stays text", () => {
    expect(r('{stream.library::istrue["{stream.title"||"y"]}')).toBe('{stream.library::istrue["{stream.title"||"y"]}');
    expect(r("{?{stream.title?}")).toBe("{?{stream.title?}");
  });

  test("an unclosed quote ends nothing", () => {
    expect(r('{stream.library::istrue["open||"y"]}')).toBe('{stream.library::istrue["open||"y"]}');
    expect(r("{stream.title::replace('open)}")).toBe("{stream.title::replace('open)}");
  });

  test("templates are parsed once, and the cache starts over when full", () => {
    for (let i = 0; i < 205; i++) expect(f.render(`#${i} {stream.title}`, scope())).toBe(`#${i} The Example`);
    expect(f.render("#0 {stream.title}", scope())).toBe("#0 The Example");
  });

  test("nothing renders as nothing, and a guard sees every value on its way out", () => {
    expect(f.render(null, scope())).toBe("");
    expect(f.render(undefined, scope())).toBe("");
    expect(r("[{stream.title}] {stream.library::istrue[\"{stream.quality}\"||\"\"]} lit", scope(), (t) => t.toUpperCase())).toBe(
      "[THE EXAMPLE] BLURAY lit"
    );
  });

  test("works without options", () => {
    expect(createFormatter().render("{'English'::languageCode}", {})).toBe("ENGLISH");
  });
});

describe("the corners", () => {
  test.each([
    ["{'a'::base64}", "YQ=="],
    ['{stream.title::remove("The ")}', "Example"],
    ['{stream.title::replace("The","A")}', "A Example"],
    ["{stream.title::replace('The', 'A \\'quoted\\'')}", "A \\'quoted\\' Example"],
    ["{stream.languages::keep({user.languages}, {user.languages})::join(',')}", "English"],
    ["{stream.languages::keep({nope.x})::length}", "0"],
    ["{stream.seeders::replace('{stream.site}','x')}", "{unknown_number_modifier(replace('{stream.site}','x'))}"],
    ["{stream.seeders::replace('','x')}", "{unknown_number_modifier(replace('','x'))}"],
    ["{stream.seeders::replace('a','b')}", "{unknown_number_modifier(replace('a','b'))}"],
    ["{stream.seeders::truncate(3)}", "{unknown_number_modifier(truncate(3))}"],
    ["{stream.title::default(x)}", "{unknown_string_modifier(default(x))}"],
    ["{stream.seeders::trim('x')}", "{unknown_number_modifier(trim('x'))}"],
    ["{stream.title::translate('a')}", "{unknown_string_modifier(translate('a'))}"],
    ["{stream.seeders::translate('1','2')}", "{unknown_number_modifier(translate('1','2'))}"],
    ["{stream.seeders::date('%Y')}", "{unknown_number_modifier(date('%Y'))}"],
    ["{?{stream.title::replace('a ?}", "{stream.title::replace('a "],
    ["{a.b::keep({?x)}", "{a.b::keep({?x)}"],
    ['{stream.title::exists["x"||}', '{stream.title::exists["x"||}'],
    ['{stream.title::exists["x"}', '{stream.title::exists["x"}'],
    ["{tools.other}", "{unknown_variableType(tools)}"],
    ["{'x'::exists::and::stream.title::exists[\"y\"||\"n\"]}", "y"],
    ["{stream.missing::default('d')::exists::and::stream.title::exists[\"y\"||\"n\"]}", "y"],
    ['{stream.title::exists::and::nope.x::exists["y"||"n"]}', "{unknown_variableType(nope)}"],
    ['{stream.cached::istrue::xor::stream.library::istrue["y"||"n"]}', "y"]
  ])("%s", (template, expected) => {
    expect(r(template)).toBe(expected);
  });
});
