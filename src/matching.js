const { fold, tokens, hasPhrase, STOPWORDS } = require("./text");
const { LANGUAGE_BY_NAME } = require("./regions");

/**
 * Deciding whether a YouTube video is the film or the episode asked for.
 *
 * Length is the backbone, because it is the one thing a trailer, a clip, a
 * review or a compilation cannot fake: a 2h 22m film is not a 2-minute
 * trailer. But length alone cannot tell episode 3 from episode 4 of the same
 * show, nor a film from its sequel, so a video also has to name what it is:
 *
 *   1. it is a finished, playable upload (not live, not a premiere)
 *   2. its length is inside the reader's margin around the listed runtime
 *   3. it is not blocked in the reader's country, nor spoken in a language
 *      other than the one the reader asked for, and has been watched at
 *      least the reader's minimum number of times
 *   4. its title carries none of the reader's excluded words ("trailer",
 *      "reaction", ...) -- unless the word is part of the title's own name
 *   5. its title (or channel) names the film or show
 *   6. a film: it does not name a different year, nor a sequel
 *      an episode: it names this episode -- by number, by absolute number,
 *      or by the episode's own title -- and no other season or episode
 *
 * Every check that fails says why, so the explain endpoint can show what was
 * turned away and the rules can be tuned on evidence.
 */

// --- Length --------------------------------------------------------------

/**
 * The lengths allowed when nothing anywhere lists a runtime: wide enough to
 * keep any real film or episode, narrow enough to keep out Shorts and clips.
 */
const UNKNOWN_RUNTIME = {
  movie: { min: 40 * 60, max: 6 * 3600 },
  episode: { min: 4 * 60, max: 3 * 3600 }
};

function marginSeconds(margin, runtimeSeconds) {
  if (margin.unit === "%") return (runtimeSeconds * margin.value) / 100;
  if (margin.unit === "m") return margin.value * 60;
  return margin.value;
}

/**
 * The span of lengths that counts as a match.
 *
 * Three margins, because three different things are known:
 *   a film's own runtime                         the movie margin
 *   an episode's own runtime                     the episode margin
 *   only the show's usual episode length         the typical margin, wider,
 *                                                since a show's episodes vary
 *
 * When two sources list different runtimes for a film (Cinemeta has Chupke
 * Chupke at 129 minutes; it runs 146), a video close to either counts.
 *
 * A film also gets a second, wider span for official channels -- uploads
 * YouTube marks as a content partner's. Measured: the studios' own uploads
 * of Indian films run 10 to 25 minutes off the listed runtime (songs trimmed,
 * TV cuts), and every partner upload in that band was the right film, while
 * the unofficial uploads there included fakes.
 */
function durationWindow(title, settings) {
  if (!title.runtimeSeconds) {
    const bounds = title.isEpisode ? UNKNOWN_RUNTIME.episode : UNKNOWN_RUNTIME.movie;
    return { ...bounds, target: null, tolerance: null, margin: null, basis: "unknown" };
  }
  const runtimes = [title.runtimeSeconds, ...(title.otherRuntimes || [])];
  const shortest = Math.min(...runtimes);
  const longest = Math.max(...runtimes);
  const basis = title.isEpisode ? title.runtimeKind : "exact";
  const margin = !title.isEpisode
    ? settings.movieMargin
    : basis === "exact"
      ? settings.episodeMargin
      : settings.typicalMargin;
  const tolerance = marginSeconds(margin, title.runtimeSeconds);
  const window = {
    min: Math.max(0, shortest - tolerance),
    max: longest + tolerance,
    target: title.runtimeSeconds,
    tolerance,
    margin,
    basis
  };
  if (!title.isEpisode) {
    const partner = Math.max(tolerance, marginSeconds(settings.partnerMovieMargin, title.runtimeSeconds));
    window.partnerMin = Math.max(0, shortest - partner);
    window.partnerMax = longest + partner;
  }
  return window;
}

/** Whether a video's length is inside the window, the official one included. */
function inWindow(video, window) {
  const d = video.durationSeconds;
  if (d >= window.min && d <= window.max) return true;
  return Boolean(video.licensed && window.partnerMin !== undefined && d >= window.partnerMin && d <= window.partnerMax);
}

/**
 * YouTube's own length filter, applied by the search itself, so the fifty
 * results a search costs are fifty of the right length rather than mostly
 * trailers. YouTube's buckets: short is under 4 minutes, medium 4 to 20,
 * long over 20. A window that straddles a boundary searches all lengths.
 */
function searchDuration(window) {
  if (window.min > 20 * 60) return "long";
  if (window.min >= 4 * 60 && window.max <= 20 * 60) return "medium";
  if (window.max < 4 * 60) return "short";
  return undefined;
}

// --- Episode numbers -----------------------------------------------------

const SEASON_WORDS = new Set(["season", "seasons", "temporada", "saison", "staffel", "stagione", "seizoen", "sezon"]);
// Hindi, which TVF-style uploads often use, folded the same way titles are.
["सीजन", "सीज़न"].forEach((w) => SEASON_WORDS.add(fold(w)));

const EPISODE_WORDS = new Set([
  "episode", "episodes", "episodio", "episodios", "epizod", "folge", "capitulo", "capitulos", "cap", "ep", "eps",
  "epi", "e"
]);
EPISODE_WORDS.add(fold("एपिसोड"));

/** Words that may sit between "episode" and its number: "Ep. No. 5". */
const NUMBER_FILLERS = new Set(["no", "nr", "number", "num"]);

const NUMBER = /^\d{1,4}$/;

/**
 * Two numbers joined as a span -- "Episodes 1-5", "Ep 3 to 4", "E1 & E2" --
 * read from the raw title, since folding turns the dash into a space. The
 * second number is limited to three digits so "Episode 5 - 2024" is not a
 * span of two thousand episodes.
 */
const RANGE =
  /(?:^|[^\p{L}])(?:episodes?|eps?|e)\s*\.?\s*#?\s*(\d{1,4})\s*(?:-|–|—|to|&|and|\+)\s*(?:episodes?|eps?|e)?\s*\.?\s*#?\s*(\d{1,3})(?!\d)/iu;

/**
 * The words of a title with letters and digits pulled apart, so every glued
 * form reads the same as its spaced one: "S01E02" is "s 01 e 02", "Ep05" is
 * "ep 05", "Season 1Episode 5" is "season 1 episode 5". "1x02" is the one
 * form that cannot be split that way, and is rewritten in full.
 */
function markerWords(rawTitle) {
  const words = [];
  tokens(rawTitle).forEach((word) => {
    const cross = /^(\d{1,2})x(\d{1,4})$/.exec(word);
    if (cross) words.push("season", cross[1], "episode", cross[2]);
    else words.push(...word.split(/(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/u));
  });
  return words;
}

/**
 * Season and episode numbers a video's title states.
 *
 * Recognises S01E02, S1 E2, S01EP02, 1x02, "Season 1 Episode 2", "Ep. 2",
 * "E02", "Episode #2", "Ep. No. 2", "season 1episode 2", and the same in
 * Spanish, Portuguese, French, German, Italian and Hindi.
 */
function parseEpisodeMarkers(rawTitle) {
  const seasons = new Set();
  const episodes = new Set();

  const range = RANGE.exec(rawTitle);
  const isRange = Boolean(range && Number(range[2]) > Number(range[1]) && Number(range[2]) - Number(range[1]) <= 200);

  const words = markerWords(rawTitle);
  const numberAt = (i) => {
    let j = i;
    while (j < words.length && NUMBER_FILLERS.has(words[j])) j++;
    return j < words.length && NUMBER.test(words[j]) ? Number(words[j]) : null;
  };

  words.forEach((word, i) => {
    const isSeason = word === "s" || SEASON_WORDS.has(word);
    if (!isSeason && !EPISODE_WORDS.has(word)) return;
    const n = numberAt(i + 1);
    if (n === null) return;
    (isSeason ? seasons : episodes).add(n);
  });

  return { seasons, episodes, range: isRange };
}

/**
 * An episode title worth looking for. Placeholders the databases use for
 * unnamed episodes ("Episode 3", "Episode #1.3", "Chapter 2") name nothing,
 * and a title of one or two letters would match by accident.
 */
function usableEpisodeTitle(episodeTitle) {
  if (!episodeTitle) return null;
  const words = tokens(episodeTitle);
  const generic = words.every((w) => NUMBER.test(w) || ["episode", "chapter", "part", "ep"].includes(w));
  const folded = words.join(" ");
  return generic || folded.replace(/ /g, "").length < 3 ? null : folded;
}

// --- Names ---------------------------------------------------------------

/**
 * Words that may stand beside a title's name without changing which title it
 * is: "Don (1978) Full Hindi Movie HD", "Kota Factory | Web Series | S01 E03",
 * "Maine Pyar Kiya Tamil Dubbed Movie". Language names, years and episode
 * markers are allowed too, and so are the names of the title's own cast and
 * director ("Buster Keaton in The General").
 */
const GENERIC_WORDS = new Set(
  (
    "full movie movies film films picture complete feature length watch online free exclusive official original " +
    "hd fhd uhd sd hq 2k 4k 8k 1080p 720p 480p 360p 2160p 1080 720 bluray blu ray brrip bdrip webrip web dl webdl " +
    "hdrip dvdrip dvd rip x264 x265 hevc remastered remaster restored colorized colourized colorised colour color " +
    "uncut uncensored extended version edition directors cut new latest released release superhit super hit hits " +
    "blockbuster classic classics cult premiere special dubbed dub dubbing dual audio multi subtitle subtitles " +
    "subtitled sub subs subbed esub esubs eng cc with in series webseries show tv serial season seasons episode " +
    "episodes ep eps epi e s part pilot finale mini miniseries anime cartoon animated animation kids drama comedy " +
    "action thriller horror romance romantic family crime mystery suspense adventure fantasy scifi sci fi musical " +
    "war western documentary biopic sports emotional epic silent noir bollywood hollywood tollywood kollywood " +
    "mollywood sandalwood south indian"
  ).split(" ")
);

const YEAR = /^(?:19|20)\d{2}$/;
const MARKER = /^(?:s\d{1,2}|e\d{1,4}|ep\d{1,4}|s\d{1,2}e(?:p)?\d{1,4}|\d{1,2}x\d{1,4}|season\d{1,2}|episode\d{1,4})$/;
const POSSESSIVE = /(?:['\u2019]s|s['\u2019])$/i;

/**
 * Characters that divide a video title into parts: "Don (1978) | Full Movie |
 * Amitabh Bachchan" is four parts. A name may span parts ("Spider-Man: No Way
 * Home" is three), but what stands beside it inside its own part says
 * whether it is this title or another one that contains its words.
 */
const SEPARATORS = /[|\u2016\u2022\u00b7:;\/\\()[\]{}"\u201c\u201d\u201e\u00ab\u00bb!?#,*~=+<>\u3010\u3011\u300c\u300d\u300e\u300f\-\u2013\u2014_.]+/u;

/**
 * The title's words, each with the part it is in, whether it is possessive,
 * and whether its part follows a colon. A capital "I" standing alone is read
 * as a divider, the way some channels type a bar: "Horror Movie I Carnival
 * of Souls (1962) I Full Movie".
 */
function titleWords(rawTitle) {
  const words = [];
  const text = String(rawTitle).normalize("NFKC").replace(/\s+I\s+/g, " | ");
  const parts = text.split(new RegExp(`(${SEPARATORS.source})`, "u"));
  let seg = 0;
  let colon = false;
  parts.forEach((part, k) => {
    if (k % 2 === 1) {
      seg++;
      colon = part.includes(":");
      return;
    }
    part.split(/\s+/).forEach((raw) => {
      const folded = tokens(raw);
      folded.forEach((t, i) => words.push({ t, seg, colon, possessive: i === folded.length - 1 && POSSESSIVE.test(raw) }));
    });
  });
  return words;
}

/** Every word of the cast's and director's names, for allowing credits. */
function peopleWords(people) {
  return new Set((people || []).flatMap((p) => tokens(p)));
}

function allowedBeside(word, people) {
  return GENERIC_WORDS.has(word) || LANGUAGE_BY_NAME.has(word) || YEAR.test(word) || MARKER.test(word) || people.has(word);
}

/**
 * Whether a video's title names the title as a title, not as words inside
 * another one.
 *
 * Measured over 79 real searches, the coverage of a name's words was the
 * largest source of wrong matches: "Yeh Meri Zindagi" for Yeh Meri Family,
 * "Chori Chori Chupke Chupke" for Chupke Chupke, "Liam Neeson in TAKEN
 * IDENTITY" for Taken, "Everything About Her" for Her, "Cesar 911" for 9-1-1.
 * So the name must appear whole, and within its part of the title:
 *
 *   before it   only generic words, years, the cast's or director's names, or
 *               a possessive credit ("F.W. Murnau's Nosferatu", "TVF's
 *               Aspirants", "Ed Wood's Classic Plan 9 ...")
 *   after it    the first two words must be generic words, years, numbers or
 *               credits: "Kota Factory 03", "Andhadhun Superhit Thriller", but
 *               not "Taken Identity", "Pokemon Indigo League", "Up in the Air"
 *               -- nor, after a colon, "Joker: Folie a Deux"
 */
function anchoredName(rawTitle, names, people) {
  const words = titleWords(rawTitle);
  const credits = peopleWords(people);
  for (const name of names) {
    const own = tokens(name);
    if (!own.length) continue;
    for (let i = 0; i + own.length <= words.length; i++) {
      if (!own.every((w, k) => words[i + k].t === w)) continue;
      const end = i + own.length;
      const before = [];
      for (let j = i - 1; j >= 0 && words[j].seg === words[i].seg; j--) before.unshift(words[j]);
      const lastCredit = before.map((w) => w.possessive).lastIndexOf(true);
      const leftOk = before.slice(lastCredit + 1).every((w) => allowedBeside(w.t, credits));
      // What follows a colon still belongs to the name: "Joker: Folie a Deux"
      // is another film, "Baahubali: The Conclusion" another part.
      const lastSeg = words[end - 1].seg;
      const after = [];
      for (let j = end; j < words.length && after.length < 2; j++) {
        if (words[j].seg !== lastSeg && !(words[j].seg === lastSeg + 1 && words[j].colon)) break;
        after.push(words[j]);
      }
      const rightOk = after.every((w) => allowedBeside(w.t, credits) || NUMBER.test(w.t));
      if (leftOk && rightOk) return { ok: true, name };
    }
  }
  return { ok: false, name: null };
}

// --- Corroboration -------------------------------------------------------

/**
 * Surnames too common to identify a film by: "Khan" is in the credits of
 * half of Bollywood. A person is recognised by their full name, or by a
 * surname of five letters or more that is not on this list.
 */
const COMMON_SURNAMES = new Set(
  (
    "khan kumar singh sharma kapoor gupta patel shah reddy verma joshi mehta jain yadav chopra malhotra das " +
    "smith johnson williams brown jones miller davis wilson taylor anderson thomas jackson white harris martin " +
    "thompson moore clark lewis walker allen young wright scott green baker adams nelson carter mitchell " +
    "roberts turner phillips campbell parker evans edwards collins stewart morris murphy cooper bailey kelly " +
    "howard watson brooks james bennett hughes price myers foster garcia rodriguez martinez hernandez lopez"
  ).split(" ")
);

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

function namesPerson(text, person) {
  const parts = tokens(person);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  const full = parts.join(" ");
  if (!full) return false;
  if (hasPhrase(text, full)) return true;
  const surname = parts[parts.length - 1];
  return parts.length > 1 && surname.length >= 5 && !COMMON_SURNAMES.has(surname) && hasPhrase(text, surname);
}

/** Whether two words differ by at most one letter (an edit, insertion or deletion). */
function nearlyEqual(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Whether a text names the episode, allowing for how titles get respelt:
 * "Swamy And Friends I" is "Swami And Friends" on Malgudi Days' own upload.
 * Every significant word must be present, a word of five letters or more
 * may differ by one letter, and a trailing part number is ignored.
 */
function namesEpisodeTitle(text, episodeTitle) {
  const folded = usableEpisodeTitle(episodeTitle);
  if (!folded) return false;
  if (hasPhrase(text, folded)) return true;
  const words = folded.split(" ").filter((w) => !STOPWORDS.has(w));
  while (words.length > 1 && (ROMAN_PARTS.has(words[words.length - 1]) || NUMBER.test(words[words.length - 1]))) words.pop();
  const present = text.split(" ");
  return words.length > 0 && words.every((w) => present.some((p) => p === w || (w.length >= 5 && nearlyEqual(p, w))));
}

const ROMAN_PARTS = new Set(["i", "ii", "iii", "iv", "v"]);

/** IMDb ids a description links to: "imdb.com/title/tt28227737". */
function linkedImdbIds(description) {
  return [...String(description || "").matchAll(/imdb\.com\/title\/(tt\d{5,10})/gi)].map((m) => m[1].toLowerCase());
}

/**
 * Independent evidence that a video is this title, from its title and
 * description:
 *
 *   year              a film's year, give or take one
 *   credits           a credited person: "Amitabh Bachchan", "Directed by
 *                     Sriram Raghavan" -- what genuine uploads write
 *   episode title     the episode's own name
 *   imdb link         the description links this title's IMDb page, as TVF's
 *                     do ("Rate us on IMDb")
 *
 * Measured over 79 real searches, 87% of genuine uploads carry one of these
 * and 68% of wrong matches carry none -- requiring one is what took the wrong
 * matches from 22% of everything returned to none. (A fifth, official
 * numbering, depends on the episode check and is added there.)
 */
function corroboration(video, title) {
  const text = fold(`${video.title} ${video.description || ""}`);
  const words = new Set(text.split(" "));
  const evidence = [];
  if (!title.isEpisode && title.year && [title.year - 1, title.year, title.year + 1].some((y) => words.has(String(y)))) {
    evidence.push("year");
  }
  if ((title.people || []).some((p) => namesPerson(text, p))) evidence.push("credits");
  if (title.isEpisode && namesEpisodeTitle(text, title.episodeTitle)) evidence.push("episode title");
  if (title.imdbId && linkedImdbIds(video.description).includes(title.imdbId)) evidence.push("imdb link");
  return evidence;
}

const ROMAN_NUMERALS = { ii: 2, iii: 3, iv: 4 };

/**
 * The number written straight after the name, if any: "Dhoom 2", "Pushpa 2
 * The Rule", "Godfather II", "Spy x Family 03". A number that is itself part
 * of one of the title's names ("Pushpa 2" when an alias is plain "Pushpa")
 * does not count. What the number means is the caller's to decide.
 */
function numberAfterName(videoTitle, names) {
  const words = videoTitle.split(" ");
  const nameWords = new Set(names.flatMap((n) => tokens(n)));
  for (const name of names) {
    const own = tokens(name);
    if (!own.length) continue;
    for (let i = 0; i + own.length < words.length; i++) {
      if (!own.every((w, k) => words[i + k] === w)) continue;
      const next = words[i + own.length];
      if (nameWords.has(next)) continue;
      if (NUMBER.test(next)) return Number(next);
      if (Object.hasOwn(ROMAN_NUMERALS, next)) return ROMAN_NUMERALS[next];
    }
  }
  return null;
}

/** A film's sequel, as uploads write it: 2 to 99 straight after the name. */
function isSequel(videoTitle, names) {
  const n = numberAfterName(videoTitle, names);
  return n !== null && n >= 2 && n <= 99;
}

/**
 * A film's year against the years a video's title names.
 *
 *   "match"     it names the film's year, give or take one (release dates
 *               differ by country)
 *   "absent"    it names no year
 *   "upload"    it names only the year it was uploaded -- "Full Movie 2024"
 *               is search-engine bait, not a claim about the film
 *   "conflict"  it names some other year: another film of the same name
 *
 * Numbers that belong to the name itself ("1917", "Blade Runner 2049") are
 * not years.
 */
function yearVerdict(videoTitle, year, uploadYear, names) {
  if (!year) return "absent";
  const nameWords = new Set(names.flatMap((n) => tokens(n)));
  const years = videoTitle
    .split(" ")
    .filter((w) => /^(?:19|20)\d{2}$/.test(w) && !nameWords.has(w))
    .map(Number);
  if (!years.length) return "absent";
  if (years.some((y) => Math.abs(y - year) <= 1)) return "match";
  if (uploadYear && years.every((y) => Math.abs(y - uploadYear) <= 1)) return "upload";
  return "conflict";
}

// --- Exclusions ----------------------------------------------------------

/**
 * The first of the reader's excluded words the video's title contains, or
 * null. A word that is part of the film's or show's own name is skipped:
 * "trailer" cannot exclude every episode of Trailer Park Boys. A plain
 * plural counts too, so "review" also catches "reviews".
 */
function excludedWord(videoTitle, words, names) {
  const folded = names.map(fold);
  for (const word of words) {
    const w = fold(word);
    if (!w || folded.some((n) => hasPhrase(n, w) || hasPhrase(n, `${w}s`))) continue;
    if (hasPhrase(videoTitle, w) || hasPhrase(videoTitle, `${w}s`)) return word;
  }
  return null;
}

// --- The verdict ---------------------------------------------------------

/** How many calendar years back a release counts as recent. */
const RECENT_YEARS = 5;

function isRecent(title, now = new Date()) {
  const year = title.releaseYear || (!title.isEpisode && title.year);
  return Boolean(year && now.getUTCFullYear() - year < RECENT_YEARS);
}

/** What a show's episode is called in uploads, best first. */
function episodeVerdict(video, title, foldedTitle, names) {
  const markers = parseEpisodeMarkers(video.title);
  // A number straight after the show's name is the season when the title
  // numbers the episode as well ("Pitchers 2 | Episode 1"), and the episode
  // when it does not -- the way anime uploads are named ("Spy x Family 03").
  const afterName = numberAfterName(foldedTitle, names);
  if (afterName !== null && afterName <= 999) {
    if (markers.episodes.size) {
      if (!markers.seasons.size && afterName <= 99) markers.seasons.add(afterName);
    } else {
      markers.episodes.add(afterName);
    }
  }
  const episodeTitle = usableEpisodeTitle(title.episodeTitle);
  const namesEpisode = Boolean(episodeTitle && hasPhrase(foldedTitle, episodeTitle));

  if (markers.range) return { ok: false, reason: "covers several episodes" };
  if (markers.seasons.size && !markers.seasons.has(title.season)) {
    return { ok: false, reason: `season ${[...markers.seasons].join("/")}` };
  }
  if (markers.episodes.size) {
    if (markers.episodes.has(title.episode)) {
      // "Episode 1" with no season, for season 2 of a show, is more likely
      // season 1's. It counts only if it also carries this episode's name,
      // or if the show has a single season.
      if (markers.seasons.size || title.season <= 1 || namesEpisode || !(title.seasonCount > 1)) {
        return { ok: true, how: markers.seasons.size ? "season and episode" : "episode", namesEpisode };
      }
      if (!(title.absoluteEpisode && markers.episodes.has(title.absoluteEpisode))) {
        return { ok: false, reason: "episode number without a season" };
      }
    }
    if (!markers.seasons.size && title.absoluteEpisode && markers.episodes.has(title.absoluteEpisode)) {
      return { ok: true, how: "absolute episode", namesEpisode };
    }
    return { ok: false, reason: `episode ${[...markers.episodes].join("/")}` };
  }
  if (namesEpisode) return { ok: true, how: "episode title", namesEpisode };
  return { ok: false, reason: "names no episode" };
}

// --- Audio language ------------------------------------------------------

const DUB_WORDS = new Set(["dub", "dubbed", "dubbing", "audio", "version"]);

/**
 * The audio languages a title declares: "[Hindi dub]", "Tamil Dubbed",
 * "Full Movie in Hindi", "Dubbed in Telugu". A language named before "sub"
 * or "subtitles" is a subtitle, not the audio, and is not counted.
 *
 * This is trusted over the audio-language field. Measured on Muse India's
 * Spy x Family uploads, the field is set per channel, not per video: the
 * "[Hindi dub]" upload is tagged English and the "[English Dub]" upload
 * Japanese.
 */
function titleLanguages(videoTitle) {
  const words = tokens(videoTitle);
  const found = new Set();
  words.forEach((word, i) => {
    const code = LANGUAGE_BY_NAME.get(word);
    if (!code) return;
    if (DUB_WORDS.has(words[i + 1]) || words[i - 1] === "in") found.add(code);
  });
  return found;
}

/**
 * The languages a video is spoken in, as far as can be told: what its title
 * declares, else what YouTube's field says. Empty when neither says, or when
 * the field says "zxx" -- ISO for "no linguistic content", silent footage.
 */
function audioLanguages(video) {
  const declared = titleLanguages(video.title);
  if (declared.size) return declared;
  return new Set(video.language && video.language !== "zxx" ? [video.language] : []);
}

function regionBlocked(video, region) {
  if (!region) return false;
  if (video.regionBlocked && video.regionBlocked.includes(region)) return true;
  return Boolean(video.regionAllowed && !video.regionAllowed.includes(region));
}

/**
 * Judge one video. Returns `{ ok: true, score, ... }` or `{ ok: false,
 * reason }`, where the reason is the first check that failed.
 *
 * Every match must also carry independent evidence that it is this title
 * (see corroboration).
 */
function evaluate(video, title, window, settings) {
  const base = { video };
  const fail = (reason) => ({ ...base, ok: false, reason });

  if (video.live) return fail(video.live === "upcoming" ? "not aired yet" : "live stream");
  if (!video.durationSeconds) return fail("no length");
  if (!inWindow(video, window)) return fail("wrong length");
  if (regionBlocked(video, settings.region)) return fail(`blocked in ${settings.region}`);
  const languages = audioLanguages(video);
  if (settings.audioLanguage && languages.size && !languages.has(settings.audioLanguage)) {
    return fail(`${[...languages].join("/")} audio`);
  }
  if (settings.embeddableOnly && !video.embeddable) return fail("not embeddable");
  // A hidden count is not a low one, so a video without one is kept.
  if (video.views !== null && video.views < settings.minViews) return fail("too few views");

  const names = [title.title, ...title.aliases];
  const ownWords = [...names, title.episodeTitle || ""];
  const foldedTitle = fold(video.title);
  const excluded = excludedWord(foldedTitle, settings.exclude, ownWords);
  if (excluded) return fail(`says "${excluded}"`);
  const excludedInDescription = excludedWord(fold(video.description || ""), settings.excludeDescription, ownWords);
  if (excludedInDescription) return fail(`description says "${excludedInDescription}"`);

  if (!anchoredName(video.title, names, title.people).ok) return fail("does not name the title");
  const links = linkedImdbIds(video.description);
  if (title.imdbId && links.length && !links.includes(title.imdbId)) return fail("links another title on IMDb");

  let score = 100;
  let how = null;
  let namesEpisode = false;
  if (title.isEpisode) {
    const verdict = episodeVerdict(video, title, foldedTitle, names);
    if (!verdict.ok) return fail(verdict.reason);
    how = verdict.how;
    namesEpisode = verdict.namesEpisode;
    score += { "season and episode": 15, episode: 10, "absolute episode": 10, "episode title": 8 }[how];
    if (namesEpisode && how !== "episode title") score += 5;
  } else {
    const uploadYear = video.publishedAt ? new Date(video.publishedAt).getUTCFullYear() : null;
    const year = yearVerdict(foldedTitle, title.year, uploadYear, names);
    if (year === "conflict") return fail("names another year");
    if (isSequel(foldedTitle, names)) return fail("a sequel");
    if (year === "match") score += 10;
  }

  const evidence = corroboration(video, title);
  // An official channel numbering the episode exactly as listed, at the
  // length listed for that very episode: how anime publishers such as Muse
  // India title their uploads, with nothing else in the description to go on.
  if (video.licensed && window.basis === "exact" && (how === "season and episode" || (how === "episode" && title.seasonCount === 1))) {
    evidence.push("official numbering");
  }
  if (!evidence.length) return fail("no year, credits or episode title");

  // Recent films and episodes are not free on YouTube except from their own
  // studios and networks, all of them partner channels. An unofficial "full
  // movie" of a release from the last few years -- "Oppenheimer (2023) | HD
  // Full Movie" -- is a fake or a copy, so only partner uploads count.
  if (!video.licensed && (settings.officialOnly || isRecent(title))) {
    return fail(settings.officialOnly ? "not an official channel" : "recent release, not an official channel");
  }
  if (evidence.includes("credits")) score += 10;
  // Uploaded by a channel linked to a YouTube content partner: true of every
  // official channel measured (studios, TV networks, TVF, Dice Media) and of
  // few unofficial uploads.
  if (video.licensed) score += 10;

  // Inside the window, closeness counts for less than how widely a video
  // has been watched. Measured: the studios' own uploads of Indian films run
  // 10 to 25 minutes under the listed runtime, songs trimmed, so the closest
  // upload is often a re-upload while the canonical one, with tens of
  // millions of views, sits further away.
  const offsetSeconds = window.target ? video.durationSeconds - window.target : null;
  if (window.target) score -= Math.min(15, (Math.abs(offsetSeconds) / Math.max(window.tolerance, 1)) * 15);
  if (settings.audioLanguage && languages.has(settings.audioLanguage)) score += 10;
  if (video.definition === "hd") score += 5;
  if (video.views) score += Math.min(25, Math.log10(video.views + 1) * 3);

  return {
    ...base,
    ok: true,
    score: Math.round(score * 10) / 10,
    offsetSeconds,
    how,
    evidence,
    language: [...languages][0] || null
  };
}

/** The matches, best first. */
function rankMatches(evaluations) {
  return evaluations.filter((e) => e.ok).sort((a, b) => b.score - a.score);
}

module.exports = {
  durationWindow,
  searchDuration,
  marginSeconds,
  parseEpisodeMarkers,
  markerWords,
  usableEpisodeTitle,
  titleWords,
  anchoredName,
  corroboration,
  linkedImdbIds,
  namesEpisodeTitle,
  nearlyEqual,
  isRecent,
  inWindow,
  namesPerson,
  numberAfterName,
  isSequel,
  yearVerdict,
  excludedWord,
  episodeVerdict,
  regionBlocked,
  titleLanguages,
  audioLanguages,
  evaluate,
  rankMatches,
  UNKNOWN_RUNTIME
};
