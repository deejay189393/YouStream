const { formatDuration, formatOffset, formatCount } = require("./text");
const { languageName, LANGUAGES } = require("./regions");
const { WATCH_URL } = require("./playback");
const { createFormatter } = require("./formatter");

/**
 * What a stream row says, for two readers.
 *
 * The person choosing reads `name` and `description`, rendered from
 * templates in AIOStreams' formatter syntax (formatter.js): one of the
 * presets below, or the reader's own.
 *
 * Aggregators read `behaviorHints`. AIOStreams, which most readers add
 * YouStream to, documents the ones it takes before anything in the text
 * (docs: reference/addon-protocol/streams): `filename`, parsed for the
 * title, year, episode, resolution, quality and languages; `duration`;
 * `publishDate`, for the age; `indexer`, the source. Its filters work from
 * those: title, year and episode matching, languages, resolution and
 * quality, the expressions community templates such as Tamtaro's are built
 * on. `videoSize` is left out because YouTube does not say: the Data API
 * gives a video's length and definition, never its file size or bitrate,
 * and AIOStreams' size and bitrate filters pass a stream without one.
 *
 * What AIOStreams parses out of the text itself (parser/streams.ts) shapes
 * the rest:
 *   - debrid service codes in the name ("RD", "TB", "EN", "PM"...), so
 *     values written into a name are guarded (guardName)
 *   - languages from any flag in the description, seeders from a number
 *     after 👤 or 👥, the size from "1.5 GB", so a YouTube title carrying
 *     those has them removed or broken first (plainText)
 */

const PLAYBACK_ICONS = { app: "▶️", youtube: "📱", smarttube: "📺" };
const PLAYBACK_LABELS = { app: "Play in app", youtube: "YouTube app", smarttube: "SmartTube" };

/**
 * The flags AIOStreams reads back as the same language. A flag several
 * languages share is read as one of them -- India's as Hindi -- so Tamil,
 * Telugu and the others sharing it get none rather than a wrong one, and so
 * do the languages whose flag it maps to nothing.
 */
const LANGUAGE_FLAGS = {
  en: "🇬🇧", hi: "🇮🇳", bn: "🇧🇩", ja: "🇯🇵", ko: "🇰🇷", zh: "🇨🇳", es: "🇪🇸", pt: "🇵🇹", fr: "🇫🇷",
  de: "🇩🇪", it: "🇮🇹", ru: "🇷🇺", ar: "🇸🇦", id: "🇮🇩", th: "🇹🇭", vi: "🇻🇳", nl: "🇳🇱", pl: "🇵🇱"
};

/** Language names, codes and flags, for ::languageCode and ::languageEmoji. */
const FORMATTER_LANGUAGES = LANGUAGES.map(({ code, label }) => ({ name: label, code, flag: LANGUAGE_FLAGS[code] || "" }));

const formatter = createFormatter({ languages: FORMATTER_LANGUAGES });

/**
 * The names AIOStreams knows each debrid and usenet service by, which it
 * looks for in a stream's name (constants.ts, SERVICE_DETAILS knownNames).
 */
const SERVICE_NAMES = [
  "RD", "Real Debrid", "RealDebrid", "Real-Debrid", "AD", "All Debrid", "AllDebrid", "All-Debrid", "PM", "Premiumize",
  "DL", "Debrid Link", "DebridLink", "Debrid-Link", "TB", "TorBox", "TRB", "SN", "Stremio NNTP", "StremioNntp",
  "Stremio-NNTP", "ND", "AIO", "AIO Usenet", "NZB", "Native Usenet", "AM", "OC", "Offcloud", "PO", "put.io", "putio",
  "EN", "Easynews", "ED", "EasyDebrid", "DBD", "DR", "DER", "DB", "Debrider", "PP", "PikPak", "PKP", "SR", "Seedr", "SDR",
  "ST", "StremThru Newz", "StremThruNewz", "TR", "TI", "TRN", "Torrin"
];
const SERVICE_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9])(${SERVICE_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})(?=[^A-Za-z0-9]|$)`,
  "gi"
);
const WORD_JOINER = "⁠";

/**
 * A value on its way into a name, with every service name in it broken by
 * an invisible word joiner: "EN" or a channel called "DR Films" would
 * otherwise make AIOStreams take a YouTube video for a debrid stream.
 */
function guardName(text) {
  return text.replace(SERVICE_PATTERN, (whole, before, word, offset, all) =>
    // AIOStreams takes "WEB-DL" out before it looks, so its "DL" is no code.
    /dl/i.test(word) && word.length === 2 && /web-?$/i.test(all.slice(0, offset + before.length))
      ? whole
      : `${before}${word[0]}${WORD_JOINER}${word.slice(1)}`
  );
}

/**
 * Free text from YouTube, cleared of what AIOStreams would read as data: a
 * flag as a language, "👤 12" as seeders, "1.5 GB" as the file's size.
 */
function plainText(text) {
  return String(text || "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "")
    .replace(/[👤👥]/gu, "")
    .replace(/(\d)(\s?)(KB|MB|GB|TB)(?![A-Za-z])/gi, `$1$2${WORD_JOINER}$3`)
    .replace(/\s+/g, " ")
    .trim();
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A release-style name for the video: what aggregators parse to learn what a
 * stream is. Built from the title the stream was found for, not from the
 * video's own title, so it carries exactly what AIOStreams' title, year and
 * episode filters look for and nothing they could misread:
 *
 *   Night of the Living Dead (1968) HD WEB-DL English
 *   Example Show (2019) S01E03 HD WEB-DL Hindi
 *
 * HD and SD are YouTube's own words for a video's definition (HD is 720p or
 * better; AIOStreams reads it as 720p, SD as 480p). WEB-DL is the scene
 * term for a stream taken from a streaming service as it is served. The
 * year is the film's, or the year the show began: AIOStreams' year filter
 * drops a film without one, and for an episode it checks the show's first
 * year (with the season's and the episode's), which also tells apart two
 * shows of one name. No extension: community filters drop names ending in
 * one they do not know.
 */
function releaseName(title, video, language) {
  const parts = [plainText(title.title)];
  if (title.year) parts.push(`(${title.year})`);
  if (title.isEpisode) parts.push(`S${pad(title.season)}E${pad(title.episode)}`);
  parts.push(video.definition === "hd" ? "HD" : "SD", "WEB-DL");
  const spoken = languageName(language);
  if (spoken) parts.push(spoken);
  return parts.join(" ");
}

/** AIOStreams' way of saying how old a release is: 5h, 12d, 2190d. */
function ageText(hours) {
  return hours < 24 ? `${Math.max(0, Math.floor(hours))}h` : `${Math.floor(hours / 24)}d`;
}

const smallCaps = (text) => formatter.render("{x.v::smallcaps}", { x: { v: text } });

/**
 * One stream's fields, by section, under AIOStreams' names wherever the
 * thing exists there, so a template written for AIOStreams or PenguPlay
 * reads the same here. A field YouTube has nothing for is null (or an empty
 * list), never missing, so such a template renders rather than erring.
 *
 *   play.*    how this row plays: in the app, the YouTube app, SmartTube
 *   video.*   the YouTube video itself
 */
function streamScope({ optionId, match, title, settings, addonName, now = Date.now() }) {
  const { video } = match;
  // The language matching settled on, which trusts what the title declares
  // over YouTube's field.
  const languageCodeOf = match.language !== undefined ? match.language : video.language;
  const spoken = languageName(languageCodeOf);
  const languages = spoken ? [spoken] : [];
  const userLanguages = settings && settings.audioLanguage ? [languageName(settings.audioLanguage)] : [];
  const uLanguages = languages.filter((l) => userLanguages.includes(l));
  const codes = (list) => list.map((l) => FORMATTER_LANGUAGES.find((x) => x.name === l).code.toUpperCase());
  const flags = (list) => list.map((l) => FORMATTER_LANGUAGES.find((x) => x.name === l).flag).filter(Boolean);
  const isAnime = Boolean(title.sources && title.sources.includes("kitsu"));
  const seasons = title.isEpisode ? [title.season] : [];
  const episodes = title.isEpisode ? [title.episode] : [];
  const published = video.publishedAt ? Date.parse(video.publishedAt) : NaN;
  const ageHours = Number.isNaN(published) ? null : Math.max(0, (now - published) / 3600000);
  const released = title.released ? Date.parse(title.released) : NaN;
  const hasOffset = match.offsetSeconds !== null && match.offsetSeconds !== undefined;
  const runtimeMinutes = title.runtimeSeconds ? Math.round(title.runtimeSeconds / 60) : null;
  const filename = releaseName(title, video, languageCodeOf);
  const message = video.ageRestricted ? "Age-restricted: opens in YouTube, where you are signed in" : null;
  const empty = () => [];

  return {
    config: { addonName },
    addon: { name: addonName, presetId: "youstream", manifestUrl: null },
    service: { id: null, shortName: null, name: null, cached: null },
    play: { id: optionId, label: PLAYBACK_LABELS[optionId], icon: PLAYBACK_ICONS[optionId] },
    video: {
      id: video.id,
      url: `${WATCH_URL}${video.id}`,
      title: plainText(video.title),
      channel: plainText(video.channelTitle) || "YouTube",
      official: video.licensed === true,
      ageRestricted: video.ageRestricted === true,
      definition: video.definition === "hd" ? "HD" : "SD",
      views: formatCount(video.views),
      viewCount: Number.isFinite(video.views) ? video.views : null,
      uploaded: video.publishedAt ? video.publishedAt.slice(0, 10) : null,
      length: formatDuration(video.durationSeconds),
      offset: hasOffset ? formatOffset(match.offsetSeconds) : null,
      offsetSeconds: hasOffset ? match.offsetSeconds : null,
      language: spoken || null
    },
    stream: {
      type: optionId === "app" ? "youtube" : "external",
      proxied: false,
      library: false,
      idMatched: false,
      indexer: "YouTube",
      message,
      infoHash: null,
      filename,
      folderName: null,
      size: null,
      folderSize: null,
      bitrate: null,
      duration: video.durationSeconds * 1000,
      container: null,
      extension: null,
      quality: "WEB-DL",
      resolution: video.definition === "hd" ? "720p" : "480p",
      visualTags: empty(),
      encode: null,
      network: null,
      hasChapters: false,
      audioTags: empty(),
      audioChannels: empty(),
      audioTracks: empty(),
      languages,
      languageEmojis: flags(languages),
      languageCodes: codes(languages),
      smallLanguageCodes: codes(languages).map(smallCaps),
      uLanguages,
      uLanguageEmojis: flags(uLanguages),
      uLanguageCodes: codes(uLanguages),
      uSmallLanguageCodes: codes(uLanguages).map(smallCaps),
      dubbed: false,
      subtitles: empty(),
      subtitleEmojis: empty(),
      subtitleCodes: empty(),
      smallSubtitleCodes: empty(),
      uSubtitles: empty(),
      uSubtitleEmojis: empty(),
      uSubtitleCodes: empty(),
      uSmallSubtitleCodes: empty(),
      subtitleTracks: empty(),
      subbed: false,
      mediaInfoQuality: null,
      title: plainText(title.title),
      year: title.year ? String(title.year) : null,
      country: null,
      date: null,
      releaseGroup: null,
      site: null,
      editions: empty(),
      repack: false,
      proper: false,
      regraded: false,
      uncensored: false,
      unrated: false,
      upscaled: false,
      seasonPack: false,
      seasons,
      formattedSeasons: title.isEpisode ? `S${pad(title.season)}` : null,
      folderSeasons: empty(),
      formattedFolderSeasons: null,
      episodes,
      formattedEpisodes: title.isEpisode ? `E${pad(title.episode)}` : null,
      folderEpisodes: empty(),
      formattedFolderEpisodes: null,
      seasonEpisode: title.isEpisode ? [`S${pad(title.season)}`, `E${pad(title.episode)}`] : empty(),
      episodeTitle: null,
      seeders: null,
      private: false,
      freeleech: false,
      age: ageHours === null ? null : ageText(ageHours),
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      seadex: false,
      seadexBest: false,
      regexMatched: null,
      rankedRegexMatched: empty(),
      regexScore: null,
      nRegexScore: null,
      seScore: null,
      nSeScore: null,
      seMatched: null,
      rseMatched: empty(),
      preloading: false
    },
    metadata: {
      queryType: `${isAnime ? "anime." : ""}${title.isEpisode ? "series" : "movie"}`,
      type: title.isEpisode ? "series" : "movie",
      isAnime,
      title: plainText(title.title),
      titles: [...new Set([title.title, ...(title.aliases || [])].map(plainText))],
      year: title.year || null,
      yearEnd: null,
      runtime: title.isEpisode ? null : runtimeMinutes,
      episodeRuntime: title.isEpisode ? runtimeMinutes : null,
      genres: empty(),
      originalLanguage: null,
      country: null,
      season: title.isEpisode ? title.season : null,
      episode: title.isEpisode ? title.episode : null,
      absoluteEpisode: title.absoluteEpisode || null,
      relativeAbsoluteEpisode: null,
      episodeTitle: title.episodeTitle ? plainText(title.episodeTitle) : null,
      episodeTitles: title.episodeTitle ? [plainText(title.episodeTitle)] : empty(),
      latestSeason: title.seasonCount || null,
      daysSinceRelease: Number.isNaN(released) ? null : Math.floor((now - released) / 86400000),
      daysSinceFirstAired: null,
      daysSinceLastAired: null,
      hasNextEpisode: null,
      daysUntilNextEpisode: null,
      anilistId: null,
      malId: null,
      hasSeaDex: false
    },
    user: {
      languages: userLanguages,
      subtitles: userLanguages,
      resolutions: empty(),
      qualities: empty(),
      visualTags: empty(),
      audioTags: empty(),
      audioChannels: empty(),
      encodes: empty(),
      streamTypes: empty(),
      releaseGroups: empty(),
      keywords: empty()
    }
  };
}

/**
 * The presets. Each is written for the reader first; none puts free text
 * in the name, and none uses 👤 or 👥.
 *
 *   youstream  the default: what the stream is, the video, its channel,
 *              and how it plays, one line each, laid out the way PenguPlay
 *              and AIOStreams' own formats are
 *   compact    two lines
 *   tamtaro    the look of Tamtaro's AIOStreams formatter, so YouStream's
 *              rows sit well beside an AIOStreams list using it
 *   classic    Torrentio's layout: the addon and the resolution, the
 *              release name, then the numbers
 */
const PRESETS = {
  youstream: {
    label: "YouStream",
    name: "{play.icon} {addon.name} {video.definition}",
    description: [
      `{metadata.type::=series["📡 {metadata.title}{? ({metadata.year})?}{? • {stream.seasonEpisode::join('')}?}{? • {metadata.episodeTitle}?}"||"🍿 {metadata.title}{? ({metadata.year})?}"]}`,
      "🎬 {video.title}",
      "🎞️ {video.definition} • ⏱️ {stream.duration::time('[%-Hh ]%-Mm %Ss')}{? ({video.offset})?}",
      `📺 {video.channel}{video.official::istrue[" ✓"||""]}{? • 👁 {video.views}?}{? • 📅 {video.uploaded::date('%-d %b %Y')}?}`,
      "{?🎧 {stream.languages::join(', ')}?}",
      "{?🔞 {stream.message}?}",
      "{play.icon} {play.label}"
    ].join("\n")
  },
  compact: {
    label: "Compact",
    name: "{addon.name} {video.definition}",
    description: [
      "{play.icon} {video.title}",
      `⏱️ {stream.duration::time('[%-Hh ]%-Mm')}{? • 👁 {video.views}?}{? • 🎧 {stream.languages::join(', ')}?}{video.ageRestricted::istrue[" • 🔞 18+"||""]}`
    ].join("\n")
  },
  tamtaro: {
    label: "Tamtaro style",
    name: `{stream.resolution::replace('p','P')}{stream.type::=youtube[" ⁽ʸᵗ⁾"||" ⁽ᵉˣᵗ⁾"]}\n  〈{stream.quality::title}〉`,
    description: [
      "✎  {metadata.title::title::truncate(25)}{? ({metadata.year})?}{?  {stream.seasonEpisode::join('·')::replace('E','ᴇ')::replace('S','s')::translate('0123456789','₀₁₂₃₄₅₆₇₈₉')}?}",
      "▦  {?{video.uploaded::date('%-d %b %Y')}  ▪  ?}{video.channel::smallcaps}",
      "{?⛿ {stream.smallLanguageCodes::join(' · ')}?}",
      "{?»  {stream.message::smallcaps}?}",
      "{play.icon} {play.label::smallcaps}"
    ].join("\n")
  },
  classic: {
    label: "Classic (Torrentio)",
    name: "{addon.name}\n{stream.resolution}",
    description: [
      "{stream.filename}",
      "{?👁 {video.views} ?}⏱️ {stream.duration::time('[%-Hh ]%-Mm')} ⚙️ {video.channel}",
      "{?{stream.languageEmojis::join(' / ')}?}",
      "{play.icon} {play.label}"
    ].join("\n")
  }
};
const DEFAULT_FORMAT = "youstream";
const MAX_NAME_TEMPLATE = 300;
const MAX_DESCRIPTION_TEMPLATE = 1500;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;

/**
 * Two made-up streams for the configure page's preview, one film and one
 * episode, built the way real ones are.
 */
const SAMPLES = {
  film: {
    title: { isEpisode: false, title: "Example Film", year: 1968, released: "1968-10-01", runtimeSeconds: 5760, aliases: [], sources: ["cinemeta"] },
    match: {
      offsetSeconds: -51,
      language: "en",
      video: {
        id: "aaaaaaaaaaa", title: "Example Film (1968) | Full Movie | Restored", channelTitle: "Classic Films", channelId: "UCexample1",
        durationSeconds: 5709, definition: "hd", views: 338000, language: "en", publishedAt: "2023-10-16T00:00:09Z", licensed: true,
        ageRestricted: false
      }
    }
  },
  episode: {
    title: {
      isEpisode: true, title: "Example Show", year: 2019, season: 1, episode: 3, episodeTitle: "The Exam", released: "2019-04-30",
      runtimeSeconds: 2280, aliases: [], sources: ["cinemeta"]
    },
    match: {
      offsetSeconds: -69,
      language: "hi",
      video: {
        id: "bbbbbbbbbbb", title: "Example Show | S01E03 - The Exam", channelTitle: "Indie Series", channelId: "UCexample2",
        durationSeconds: 2211, definition: "hd", views: 5100000, language: "hi", publishedAt: "2019-04-30T10:28:12Z", licensed: true,
        ageRestricted: false
      }
    }
  }
};

/**
 * What the configure page previews with: each sample's fields as the
 * in-app row has them, and the play section of every way of watching, which
 * the page swaps in (with stream.type) for the other rows.
 */
function previewData(addonName, now = Date.now()) {
  const samples = {};
  Object.keys(SAMPLES).forEach((key) => {
    samples[key] = streamScope({ optionId: "app", ...SAMPLES[key], settings: {}, addonName, now });
  });
  const play = {};
  Object.keys(PLAYBACK_ICONS).forEach((id) => {
    play[id] = { id, label: PLAYBACK_LABELS[id], icon: PLAYBACK_ICONS[id] };
  });
  return { samples, play };
}

/** The rendered name and description, never empty, never unbounded. */
function renderStreamText(scope, settings) {
  const name = formatter.render(settings.nameTemplate, scope, guardName).slice(0, MAX_NAME) || scope.addon.name;
  const description =
    formatter.render(settings.descriptionTemplate, scope).slice(0, MAX_DESCRIPTION) || scope.video.title;
  return { name, description };
}

module.exports = {
  streamScope,
  renderStreamText,
  previewData,
  releaseName,
  guardName,
  plainText,
  ageText,
  formatter,
  PRESETS,
  SAMPLES,
  DEFAULT_FORMAT,
  FORMATTER_LANGUAGES,
  LANGUAGE_FLAGS,
  PLAYBACK_ICONS,
  PLAYBACK_LABELS,
  SERVICE_NAMES,
  MAX_NAME_TEMPLATE,
  MAX_DESCRIPTION_TEMPLATE,
  MAX_NAME,
  MAX_DESCRIPTION
};
