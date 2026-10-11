const { fold, tokens, hasPhrase, significantTokens } = require("./text");

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
 *      other than the one the reader asked for
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
 */
function durationWindow(title, settings) {
  if (!title.runtimeSeconds) {
    const bounds = title.isEpisode ? UNKNOWN_RUNTIME.episode : UNKNOWN_RUNTIME.movie;
    return { ...bounds, target: null, tolerance: null, margin: null, basis: "unknown" };
  }
  const basis = title.isEpisode ? title.runtimeKind : "exact";
  const margin = !title.isEpisode
    ? settings.movieMargin
    : basis === "exact"
      ? settings.episodeMargin
      : settings.typicalMargin;
  const tolerance = marginSeconds(margin, title.runtimeSeconds);
  return {
    min: Math.max(0, title.runtimeSeconds - tolerance),
    max: title.runtimeSeconds + tolerance,
    target: title.runtimeSeconds,
    tolerance,
    margin,
    basis
  };
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
 * How well a video names the title: the share of a name's significant words
 * present in the video's title or channel name, and whether the whole name
 * appears as written.
 *
 * Short names need every word ("TVF Pitchers"); longer ones need 60% of them,
 * because uploaders shorten long titles -- "Mission Impossible Dead
 * Reckoning" for "Mission: Impossible -- Dead Reckoning Part One" -- and a
 * film's other names (from TMDB) catch the rest: "Harry Potter and the
 * Sorcerer's Stone" for "... Philosopher's Stone".
 */
function nameMatch(names, haystack) {
  const hayTokens = new Set(haystack.split(" "));
  let best = { ok: false, phrase: false, coverage: 0, name: null };
  names.forEach((name) => {
    const significant = significantTokens(name);
    if (!significant.length) return;
    const present = significant.filter((t) => hayTokens.has(t)).length;
    const required = significant.length <= 2 ? significant.length : Math.ceil(significant.length * 0.6);
    const phrase = hasPhrase(haystack, fold(name));
    const candidate = { ok: phrase || present >= required, phrase, coverage: present / significant.length, name };
    const better =
      candidate.ok !== best.ok
        ? candidate.ok
        : candidate.phrase !== best.phrase
          ? candidate.phrase
          : candidate.coverage > best.coverage;
    if (better) best = candidate;
  });
  return best;
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

function regionBlocked(video, region) {
  if (!region) return false;
  if (video.regionBlocked && video.regionBlocked.includes(region)) return true;
  return Boolean(video.regionAllowed && !video.regionAllowed.includes(region));
}

/**
 * Judge one video. Returns `{ ok: true, score, ... }` or `{ ok: false,
 * reason }`, where the reason is the first check that failed.
 */
function evaluate(video, title, window, settings) {
  const base = { video };
  const fail = (reason) => ({ ...base, ok: false, reason });

  if (video.live) return fail(video.live === "upcoming" ? "not aired yet" : "live stream");
  if (!video.durationSeconds) return fail("no length");
  if (video.durationSeconds < window.min || video.durationSeconds > window.max) return fail("wrong length");
  if (regionBlocked(video, settings.region)) return fail(`blocked in ${settings.region}`);
  if (settings.audioLanguage && video.language && video.language !== "zxx" && video.language !== settings.audioLanguage) {
    return fail(`${video.language} audio`);
  }
  if (settings.embeddableOnly && !video.embeddable) return fail("not embeddable");

  const names = [title.title, ...title.aliases];
  const foldedTitle = fold(video.title);
  const excluded = excludedWord(foldedTitle, settings.exclude, [...names, title.episodeTitle || ""]);
  if (excluded) return fail(`says "${excluded}"`);

  const named = nameMatch(names, fold(`${video.title} ${video.channelTitle}`));
  if (!named.ok) return fail("does not name the title");

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

  const offsetSeconds = window.target ? video.durationSeconds - window.target : null;
  if (window.target) score -= Math.min(30, (Math.abs(offsetSeconds) / Math.max(window.tolerance, 1)) * 30);
  if (named.phrase) score += 10;
  if (settings.audioLanguage && video.language === settings.audioLanguage) score += 10;
  if (video.definition === "hd") score += 5;
  if (video.views) score += Math.min(20, Math.log10(video.views + 1) * 2);

  return { ...base, ok: true, score: Math.round(score * 10) / 10, offsetSeconds, how };
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
  nameMatch,
  numberAfterName,
  isSequel,
  yearVerdict,
  excludedWord,
  episodeVerdict,
  regionBlocked,
  evaluate,
  rankMatches,
  UNKNOWN_RUNTIME
};
