# YouStream — YouTube as a stream source for Stremio and Nuvio

YouStream is a stream addon. When you open a film or an episode in Stremio or
Nuvio, it finds that film or episode **in full** on YouTube and offers it as a
stream. It plays in the app's own player, or opens in the YouTube app if you
prefer.

It exists for everything that legitimately lives on YouTube: web series made
for YouTube, films their studios upload themselves, public-domain classics,
and anime that licensed channels publish in full. It never
returns trailers. A trailer, a clip, a review or a reaction is not the length
of the thing it is about, and every video must be within your margin of the
listed runtime.

It is built to be **wrong as rarely as possible**: across 79 titles and about
1,500 real search results, every match it offers was checked by hand, and
none is the wrong content (see [Measured, not guessed](#measured-not-guessed)).
When it cannot show a video is the title you asked for, it offers nothing.

It also brings **YouTube itself** into the app: a YouTube row in the app's
search, and your own catalogs on its home screen (searches, channels,
playlists and Trending), each video with real metadata, playable the same
ways, and saveable to your library (see
[YouTube in your app](#youtube-in-your-app-search-catalogs-and-your-library)).

It only ever returns YouTube video ids and YouTube links. Nothing is
downloaded, proxied or re-hosted.

---

## How it works

```
tt…:1:3                                         the id the app asks about
  -> the show, S1 E3, the episode's name,      metadata: Cinemeta, IMDb, TheTVDB, TMDB; Kitsu, AniList and the anime offline database
     runs ~43 min, cast, IMDb id
  -> "<show> season 1 episode 3"               one YouTube search, long videos only
  -> 50 results, each judged                   length, name, episode, exclusions
  -> the official S01 E03 upload               ranked matches -> stream rows
```

1. **Read the id.** `tt…` (IMDb), `tmdb:…` (Nuvio uses these for some titles)
   and, for anime, `kitsu:…`, `mal:…` (MyAnimeList), `anilist:…` and
   `anidb:…`, for films and for `:season:episode` episodes (an anime's
   `:episode`, numbered within its season). See [Anime](#anime).
2. **Learn what it is**: the name, the year, the runtime, the cast and
   director, the IMDb id and, for an episode, its name, its air date and its
   number across the whole show.
3. **Search YouTube once**, using YouTube's own length filter, so the 50
   results the search costs are 50 of roughly the right length.
4. **Enrich all 50 in one call** (`videos.list`, 1 quota unit) for what a
   search does not say: exact length, embeddability, region blocks, age
   restriction, spoken language.
5. **Judge every result**, rank what is left, and turn the best into stream
   rows.

Searches and metadata are cached, shared by everyone on the server, in memory,
Redis, files or the database (see [Caching](#caching)).

## What counts as a match

A video has to pass every check. The first one it fails is its reason, and
the reasons are logged and shown by the [explain endpoint](#explain-endpoint).

| Check | Turns away |
|---|---|
| finished upload | live streams, premieres that have not aired |
| **length within your margin** | trailers, clips, recaps, compilations, "full season" dumps |
| your country | videos blocked where you are (if you set a country) |
| your audio language | videos in another language, by what the title declares ("Hindi dub", "Tamil Dubbed", "in Hindi") and otherwise by YouTube's tag (if you set one) |
| **minimum views** (1,000) | nearly unwatched lookalikes |
| excluded words in the title | "reaction", "review", "explain", "revisit", "trailer", … ([full list](src/config.js)) |
| excluded phrases in the description | "fan movie", "in this video we delve", "video essay", "fair use", "this is not a movie, just a review", … |
| **names the title** | other shows and films of the same length, and names that only contain it |
| links another IMDb title | a description linking a different film's IMDb page |
| **films:** year, sequel | a remake's year when you asked for the original; "Title 2" when you asked for *Title* |
| **episodes:** names this episode | every other episode of the same show |
| **evidence it is this title** | anything that cannot show it is the film or episode asked for |
| recent releases: official channel | unofficial uploads of anything released in the last five years |

**Names the title** means the name stands at the head of its part of the
video's title, with only generic words beside it ("full movie", "HD",
"Hindi dubbed", "S01E03"), a year, or a credited cast member's name. So
"Title: Part Two" is not *Title*, a longer name that only ends in the
title's is not the title, and "Title 2" is not *Title*.

**Evidence** is what a namesake, a fan film or a recap cannot fake by having
the right length and name. A match needs at least one of:

- the film's **year**, in the title or the description;
- a **credited name**: a top-billed actor or the director (from Cinemeta and
  TMDB);
- the **episode's own title**, allowing one typo or different spacing;
- a link to the title's **IMDb page** (some studios link every episode's);
- an **official channel's own numbering**: a content partner's "S01 E03" for
  an episode whose runtime is known exactly.

**Official channels** are what YouTube marks as a content partner's upload
(`licensedContent`): studios, TV networks and the channels they license.
Anything released in the last five years is offered only from one of them,
because a recent film or show on an unofficial channel is far more often a
fake than a copy. The **Only official channels** setting extends that to
everything, at the cost of some public-domain uploads.

Episodes are where length alone is not enough, since every episode of a show
runs about the same. So a video has to name the episode, and the parser reads
the ways uploads actually write it: `S01E03`, `S1 E3`, `1x03`,
`Season 1 Episode 3`, `EP 03`, `Ep. No. 3`, a bare `<show> 03`, the
episode's own title, and the same words in Spanish, Portuguese, French,
German, Italian and Hindi (`सीज़न 2 एपिसोड 3`). A video naming a different
season or episode is turned away, and so is one naming a span ("Episodes
1-5"). For season 2 onwards, a bare "Episode 1" with no season is more likely
season 1's, so it only counts if it also carries this episode's name. Uploads
numbered across the whole show ("Episode 6" for S2E1) are matched too.

An excluded word that is part of the title's own name is ignored for that
title, so a show with "Trailer" in its name is not hidden by the word
"trailer".

### Measured, not guessed

**The broad sample.** 79 titles, chosen to be hard: blockbusters that are not
on YouTube and attract fakes, films with short or common one-word names,
remakes and namesakes, Hindi and South Indian films, public-domain classics,
shows that are not on YouTube and attract reactions, shows that are (web
series on their creators' channels, classic TV on its rights holders'
channels, anime on licensed channels), and names that are numbers. About
1,500 real results, every video ever returned as a match labelled by hand,
asserted in
[`test/corpus.test.js`](test/corpus.test.js) (see [Real-data
tests](#real-data-tests)):

| | Matches offered | Wrong content | Official | Genuine, unofficial | Unsure |
|---|---|---|---|---|---|
| Before these rules | 147 checked | **33 (22%)** | | | |
| Default settings | 109 | **0** | 69 | 37 | 3 |
| Only official channels | 64 | **0** | 60 | 3 | 1 |

Every film and show in the sample that is not on YouTube finds nothing, and
the official uploads that are there are found.

**Single titles in detail**, from YouTube's results page and then from the
live Data API with a real key, asserted in
[`test/realWorld.test.js`](test/realWorld.test.js) and
[`test/liveApi.test.js`](test/liveApi.test.js):

| Asked for | YouTube returned | YouStream returns |
|---|---|---|
| an episode of a web series, on its creator's channel | the official upload, every other episode of the season, reactions, a 3-hour "full season" | **only** the official episode |
| two more series from the same creator | the same pattern | **only** the right episode |
| an episode of a series no longer on YouTube | 20 results: 13 reactions, "SERIES REVISIT"s and "REWIND"s, several the right length, and other shows from the same creator | nothing |
| a famous film not on YouTube | feature-length "Full Movie … Review", "Ending Explained", and a content partner's video essay titled like the film | nothing |
| a 1990s Hindi film | nine "Full Movie \| Review/Analysis And Facts" uploads, 2¼–3½ hours long | only the studio's own upload |
| public-domain classics | many genuine full uploads, one with 6.6M views | the genuine ones, each naming the year or cast, the most watched first |
| an episode, through the live API | the official upload, plus a 205-view podcast whose name only ends in the show's | **only** the official upload |
| an anime episode via Kitsu, country India (live API) | the licensed channel's Hindi dub, English sub and English dub, and its Hindi channel's upload; episodes 1–12 and season 3 | all four uploads of that episode. With English audio, only the English dub; with Hindi, both Hindi dubs |

What the sample taught, in order of how much it mattered:

- **Reactions, reviews and explainers** run as long as what they are about,
  and on Indian web series they outnumber the episodes. The excluded words
  handle them, including the misspellings they use ("Full Explaine",
  "Commentry", "Full Explain").
- **Some fakes are only given away by their description**: fan films ("our
  new full fan movie"), Hindi recaps ("is video mein"), explainers ("in this
  video, we delve into"), a partner channel's video essays titled exactly like
  the film, and review channels that title uploads "Full Movie" and then say
  "this is not a movie, this is just a movie review".
- **Namesakes need evidence**, not just the right length and name: a year, a
  credited name or the episode's title.
- **YouTube's audio-language field is unreliable for dubs.** One licensed
  anime channel tags its "[Hindi dub]" upload English and its "[English Dub]"
  upload Japanese. So
  a language the title declares is trusted over the field, and a language
  named before "Sub" is read as subtitles, not audio.

## Anime

Anime is looked for when **Anime** is on, in Streams, under Look for. It is
on for every setup that looks for films or series, as anime always came with
them, and has had a switch of its own since 0.14.0.

**Ids.** Apps and addons name an anime by its id on one of the anime
databases: `kitsu:`, `mal:` (MyAnimeList), `anilist:` or `anidb:`. Each is an
entry for one season, with `:3` for its third episode. All four are read,
and claimed in the manifest only while Anime is on.

**Names.** Official uploads name an anime in English, and an English name
one site lists another often lacks. With **Anime names from: Automatic**,
the default, YouStream asks every source, none of which needs a key:

- **the anime offline database**, a free database of some 38,000 anime with
  each one's id on every site and every name those sites know it by. A
  fork keeps it current every week, and it is loaded weekly, kept in
  memory (about 29 MB). `ANIME_DATASET=off` leaves it out;
- **Kitsu**, for its names, and for an episode's own title and length;
- **AniList**, for an English name when Kitsu has none, by AniList or
  MyAnimeList id. It is asked only then, as it answers a limited number of
  requests a minute, and the database already holds its other names.

The database maps any of the four ids to the others, so each source can be
asked. The name searched for is the English one, in the short form uploads
write: the part before a colon, when that is a name of its own, as light
novels' adaptations carry their whole subtitle in their English titles.
Without an English name anywhere, it is the database's own title. All the
names count when an upload is matched, except names under four letters from
AniList and the database: abbreviations that any title may happen to
contain. **Kitsu alone** asks Kitsu only, as anime were looked up before,
and needs the database to read any id but Kitsu's.

Measured on 253 episode uploads of two official anime channels, numbered the
way the matcher reads them: Kitsu's names alone named 107 (42%), every
source's 233 (92%). The uploads were tied to their anime by the database's
names, so 92% is the ceiling here. End to end, an episode asked for by its
MyAnimeList id, from a country the official channel streams it to, was found
with every source and not with Kitsu alone, which had no English name to
search for.

## Runtime margins

Four margins, because different things can be known:

| Margin | Applies when | Default |
|---|---|---|
| **Movies** | a film's runtime | **±10 minutes** |
| **Movies, official channels** | the same, for an official channel's upload | **±20%** |
| **Episodes** | an episode's own runtime is listed (TheTVDB, TMDB, TVmaze, Kitsu) | **±90 seconds** |
| **Episodes, usual length only** | only the show's typical episode length is known | **±30%** |

Each can be set in **seconds, minutes, or a percentage** of the runtime. A
23-minute episode with a 25-second margin accepts 22m 35s to 23m 25s.

Why these defaults, from the sample:

- **Official uploads of Indian films run 10 to 25 minutes short** of IMDb's
  runtime (songs trimmed, TV cuts). Every official upload in that band was
  the right film, while the unofficial uploads there included fakes. Hence
  the wider margin for official channels only.
- **Exact episode runtimes are listed in whole minutes**, and YouTube cuts
  differ from them by up to 70 seconds. At ±45 s, two of five official
  episodes of one web series were missed; at ±90 s none are.
- **A show's usual length is only a guide**: one measured episode runs 29%
  under it.

### Where runtimes come from

**Films: IMDb.** Each film is matched against IMDb's own runtime, from the
data IMDb publishes for non-commercial use, loaded daily. Cinemeta is built
from IMDb and agrees on most films, but where the two differ each is right
about half the time, measured against 47 films' genuine uploads: for one
film IMDb says 146 minutes (its uploads run 146; Cinemeta says 129), for
another Cinemeta says 144 (its uploads run 131–139; IMDb says 120). So a
video close to either counts, and TMDB's counts too when a key is set. Close
to one or the other, not anywhere between: a film listed at 162 and 208
minutes is not matched by a three-hour upload. Until IMDb's data has loaded
after a restart (about 20 seconds), films are matched on Cinemeta's runtime.

**Episodes: TheTVDB**, when the server has a TheTVDB key. Cinemeta's episode
lists are TheTVDB's, so the season and episode in an app's id are TheTVDB's
numbering, and each episode is looked up by the TheTVDB id Cinemeta gives it.
Without a key, an episode's own runtime comes from TMDB (with a key) or
**TVmaze**, which needs none. Whatever the source, a runtime is taken as the
episode's own only where the season's runtimes vary: one number copied onto
every episode of a season is the broadcast slot (an hour-long drama's
episodes, listed at 60 minutes, run about 41), and is used as the show's
usual length, with its wider margin. Measured: one web-series episode runs
35m 36s against the show's usual 26 minutes. It is missed with the usual
length alone and found with its own.

IMDb's per-episode runtimes were measured too, and are not used: they found
four official uploads of a 1990s series that were missed before, and lost
three official uploads of a sitcom, which run two minutes over the listing.

## Ways to watch

Each matched video is offered these ways, each on or off, in your order. The
first is what the play button and an app's autoplay land on.

| Option | What it sends | Notes |
|---|---|---|
| **Play in app** | `ytId` and nothing else | the app fetches the video itself, at the best quality YouTube offers |
| **Open in the YouTube app** | `https://www.youtube.com/watch?v=…` | a browser can take this too |
| **Open in SmartTube** | `vnd.youtube:<id>` | no browser claims it, so it can only land in a YouTube app. Off by default |

**Play in app** sends a bare `ytId`, with no `url` or `externalUrl`: that is
what has Nuvio (newer than 1.1.0-beta.2) resolve the video on the device,
through the extractor its trailers use, at every quality YouTube offers, and
Stremio play it in its built-in YouTube player. Nothing passes through this
server.

Age-restricted videos play only for a signed-in viewer, so they get no in-app
row, only the external ones. Each row's `bingeGroup` names the way of
watching and the channel, so next-episode autoplay stays on the same choice.

## Stream name and description

What each row says comes from two templates in AIOStreams' [custom formatter
syntax](https://docs.aiostreams.viren070.me/reference/custom-formatter), the
language PenguPlay uses too, so a template made for either works here. Pick a
preset on the configure page (Playback → Stream name and description) or
write your own; the page previews it live, for a film and an episode, one row
per way of watching you turned on.

| Preset | Name | Description |
|---|---|---|
| **YouStream** (default) | `▶️ YouStream 4K` | what it is, the video's title, its resolution and length (and how far from the listed runtime), the channel with views and upload date, the language, how it plays |
| **Compact** | `YouStream 1080p` | the video's title, then length, views and language |
| **Tamtaro style** | `4K ⁽ʸᵗ⁾` / `〈Web-dl〉` | the look of Tamtaro's AIOStreams formatter, for YouStream rows that sit beside an AIOStreams list using it |
| **Classic (Torrentio)** | `YouStream` / `4K` | the release name, then the numbers, then flags |

The fields are YouTube's own, `{video.title}`, `{video.channel}`,
`{video.official}`, `{video.definition}` (HD or SD), `{video.resolution}`
(the estimate below: 4K, 1440p, 1080p, 720p or 480p), `{video.views}`,
`{video.uploaded}`, `{video.length}`, `{video.offset}`, `{video.language}`,
`{video.ageRestricted}`, `{video.id}`, `{video.url}`, and how the row plays,
`{play.icon}` and `{play.label}`, beside AIOStreams' own: `{stream.*}`,
`{metadata.*}`, `{addon.name}`, `{service.*}` and `{user.*}`. Every field
AIOStreams documents exists, empty where YouTube has nothing for it (sizes,
seeders, codecs), so a template written for AIOStreams renders rather than
erring.

### How sharp a stream is said to be

The YouTube Data API says only whether a video is HD (720p or better) or SD;
the formats YouTube serves are in its private player data, which its
developer policies forbid reading. So for an HD or a live video YouStream
estimates, and the first of these that applies decides:

1. **The title names a resolution** (4K, 8K, UHD or 2160p, 1440p, 1080p or
   FHD, 720p): the highest it names. ("4K subscribers" is a count.)
2. **It is live**: 1080p.
3. **It came out in 2019 or later, on a channel of 300,000 subscribers or
   more**: 4K.
4. **Otherwise** 1080p.

Any other SD video is 480p. "Came out" is the film's or episode's release
when the video was found for one, and the upload date otherwise. A channel's
subscriber count costs 1 unit per fifty channels, only when the estimate
turns on it, and is kept for a day. It is an estimate: a big channel that
uploads in 1080p shows 4K, a small one that uploads in 4K shows 1080p.
Playback is not affected.

### With AIOStreams

Add YouStream to AIOStreams as a custom addon, with its install URL.
AIOStreams reads what a stream is from `behaviorHints` before anything in its
text (its docs: Addon protocol → Streams), so YouStream sends:

| Hint | Example | What AIOStreams uses it for |
|---|---|---|
| `filename` | `Example Film (1968) 1080p WEB-DL English`, `Example Show (2019) S01E03 2160p WEB-DL Hindi` | title, year, season and episode matching; resolution (the estimate below; SD reads as 480p); quality (WEB-DL); language |
| `duration` | `5709` (seconds) | the runtime |
| `publishDate` | `2023-10-16T00:00:09Z` | the age; sent for films and episodes only |
| `indexer` | `YouTube` | the source |

The filename is built from the title the video matched, not from the video's
own title, so AIOStreams' title, year, season and episode matching pass, and
a YouTube title's stray words cannot read as a resolution, a format or a
language. There is no `videoSize`: the API gives no file size or bitrate,
and a made-up one would be taken as fact by AIOStreams' size filters. Text
AIOStreams would misread in a stream's name is kept out: debrid codes are
broken with an invisible joiner, a YouTube title's flags, seeder marks and
sizes are cleared, and a language gets a flag only where AIOStreams reads it
back as that language. The configure page warns about any you type into a
template.

In AIOStreams an in-app row is stream type `youtube`, and a YouTube-app or
SmartTube row `external`. Tamtaro's template drops every `external` stream,
so only in-app rows appear unless you turn on **Result Passthrough** for
YouStream; in-app rows sort by their estimated resolution, as WEB-DL, and
count as instant. **Format Passthrough** shows YouStream's own stream text.
A video opened as a YouTube item carries no `publishDate`, as AIOStreams
cannot know its release date and its age filters would drop it.

## YouTube in your app: search, catalogs and your library

Everything here is YouTube used as YouTube: what you search, ranked the way
YouTube ranks it, and rows of the searches, channels, playlists and charts
you choose.

### The type `youtube` and `yt_id:` ids

Every video YouStream lists is of its own type, **`youtube`**, with the id
**`yt_id:<video id>`**, since a video is not a film or an episode. `yt_id:`
is the prefix Stremio's own YouTube add-on uses, so any add-on can give
metadata or streams for the same video, and YouStream gives streams for the
videos other add-ons list, the channel videos of Stremio's YouTube add-on
included (`yt_id:<channel id>:<video id>`, type `channel`). In Nuvio's
library, "Youtube" in the type list shows the videos you saved. Videos saved
before 0.8.0, type `YouTube` with `youstream:` ids, keep working.

### Search

The app's search gets one row of YouTube results, named **YouStream**. It is
on unless you switch it off in Catalogs, ranked the way YouTube ranks it
unless you choose newest, most viewed or top rated, kept to lengths the way
a row is (below), with **SafeSearch** moderate (YouTube's default), strict or
off. Your country and audio language are ranking hints,
not filters.

A search costs **100 of your 10,000 daily units**, and Nuvio searches as you
type, from the second letter, 350 ms after each keystroke, so typing a title
would spend a search per letter. YouStream skips anything under three
characters (one in Chinese, Japanese or Korean), waits a second for typing to
settle, longer while you are plainly still typing (five seconds at most),
drops a search that a newer one from you replaces or that the app abandoned,
and makes a search sent twice at once only once. Replaying Nuvio's search
letter by letter, at 1 to 4 seconds a letter, typing a title cost 1.2
searches on average. Results are kept two minutes; what you search is not
logged.

### Catalogs

Rows on the home screen, in your order, up to 20. You choose where a row's
videos come from, then type or paste what that source needs:

| Source | You give it | Lists | One page costs |
|---|---|---|---|
| YouTube search | what to search for | YouTube's results, by relevance or newest, most viewed or top rated; length and upload date optional | 101 units |
| YouTube playlist | its link (a watch link with `list=` too, and YouTube Music's), or its ID | the playlist, in its order | 2 units |
| YouTube channel | its link, its `@handle` (the @ is optional) or its `UC…` ID | its videos, its Shorts, its live streams, any two, or everything; newest or most viewed first | 2 units |
| Trending | a chip | YouTube's most popular in your country, all or one category (Music, Gaming, Film & Animation, Sports, News…) | 1 unit |

A new setup starts with **no rows**. Add a search, a playlist, a channel or
a Trending row, choose how its videos are ordered, and arrange the rows with
the arrows. A search orders by relevance, newest, most viewed or top rated,
and a channel by newest or most viewed. A playlist keeps its own order and
Trending is YouTube's ranking, so those two have no choice to make.

**Videos, Shorts and live streams.** Under each row, tick any of Videos,
Shorts and Live. A row lists every kind until told otherwise; a channel's
lists its videos, as it always has. The row's name says what it keeps to
("cricket · Videos & live"), and the kinds are stored with it:
`{ q: "cricket highlights", types: ["videos", "live"] }`.

YouTube's API has no field for a video's kind, so YouStream tells it from
what it fetches anyway, at no extra cost: the details call also gives the
player's shape. A **Short** is upright (taller than wide) and up to 3 minutes
long, or 1 minute if uploaded before 15 October 2024; a square video is left
a video, as square uploads are as often songs. A **live stream** is live now,
or the recording of one. A premiere carries the same live details but is a
video, as YouTube files it, told apart by its showing outlasting the video
by the countdown before it. Measured against YouTube's own answer for 576
videos: 214 of the 217 Shorts were told, the other 3 being square, and no
video was taken for a Short; 52 of 53 streams and premieres were told apart.

A channel row of one kind reads YouTube's own list of it, which is exact:
`UULF`, `UUSH` or `UULV` in place of the channel id's `UC` (`UULP`, `UUPS`,
`UUPV` most viewed). A row of two kinds reads all the channel's uploads
(`UU`, or `PU` most viewed) and tells the third kind apart. These lists are
not in YouTube's documentation; should YouTube stop keeping one, its row
comes back empty rather than failing. A search of Shorts alone asks YouTube
for videos under 4 minutes. The kinds are told on the pages already kept, so
changing them costs nothing, but a row of some kinds has an id of its own.
Leaving a kind out thins a row: without Shorts, a page of one search for
cricket highlights kept 6 of its 50 videos. A page that keeps none moves on
to the next, which for a search costs another 101 units.

**Length.** Under each row, tick any of Under 4, 4–20, 20–60 and Over 60
minutes, or Custom for minutes of your own (30 to 45, say); none ticked is
any length. YouTube's search knows three lengths, under 4 minutes, 4 to 20
and over 20, and takes one per search, so a search row asks for the
narrowest that holds yours and leaves the rest out itself: **one search per
page, never more**. 20–60 is searched as over 20 and trimmed; a choice
across YouTube's lengths, such as Under 4 with Over 60, searches every
length and trims. The page says so under the row, as a page may then hold
fewer videos, how many fewer depending on the subject: in earlier
measurements, over an hour kept 80% of a lofi search's results and 7% of a
stand-up search's. Channel, playlist and Trending rows trim their own, at no
cost. A stream live now has no length yet and is kept, and a row of Shorts
alone has no length to choose. The length is stored as one word:
`length: "20to60"`, `"under4+over60"` or `"30-45"`, and YouTube's own
`short`, `medium` and `long` as before, so older rows keep their ids. The
app's search keeps to a length the same way.

**Your own names.** The pencil beside a row's name renames it: apps show
your name, and the page keeps the one made from what the row lists beneath
it. Clear the name to go back to that one. A renamed row keeps its id, so
apps keep its place; it is stored as `label: "Cricket"`.

**Home or Discover.** Each row has a Show in Home switch, on unless you turn
it off. Off, the row is left off Stremio's and Nuvio's home screens and
listed in Discover alone: it requires a `genre` with the one option `All`,
which both apps' home screens skip and both Discovers choose for you. It
keeps its id and its videos, and is stored as `home: false`.

A pasted playlist or channel is looked up once, at 1 unit, on the configure
page (`POST /api/youtube-source`), as the source you chose. Something else
is explained rather than added: a channel pasted as a playlist or the other
way round, a single video, an old `/c/` link, or a mix YouTube makes per
viewer. A YouTube link added as a search is caught too, so YouTube is never
searched for a link. YouTube Music's own curated playlists (`RDCLAK…`) are
public and can be added.

**Refresh.** A row's results are kept for **two hours** by default and you
can choose any interval from 30 minutes up, in minutes, hours or days, with
no maximum. YouTube's terms let a server keep its data 30 days at most, so
anything longer refreshes then. A row only refreshes when the app shows it
after that long. The configure page works out what your search rows could
cost if shown all day: two of them every 30 minutes come to 96 of your 100
daily searches. Channels, playlists and Trending cost almost nothing.

The cache is **per reader**, filed under a one-way fingerprint of your key,
never the key itself. Past its interval, a row is still answered from it
when YouTube cannot be asked, such as a spent quota or an outage.

**Pages.** A page is 50 videos, one page of YouTube's, and a row goes 5
pages deep (250 videos). The steps are declared (`skip` options 0 to 200),
because the protocol's default page is 100 and a shorter page with no
declared step reads as the end. Nuvio asks for the next page at the count it
already has, and Stremio at the declared steps. `skip` counts the videos
actually offered, which gives both apps the same unbroken list. Each answer
stays within one page of YouTube's, so it costs at most one call.

**Left out:** premieres still to air, videos blocked in your country, videos
this server was asked to block (`BLOCKED_VIDEOS`, `BLOCKED_CHANNELS`), and
non-embeddable videos when you asked for embeddable only.

**Keyword filter.** Any row can keep only, or hide, the videos that mention
some words: under the row, choose "Only videos mentioning" or "Hide videos
mentioning" and type them, separated by commas. Whole words, in any case and
any script, with or without accents; a plural or a possessive counts, and so
does a name run together the way a hashtag writes it. They are looked for in
the title, the channel's name and the whole description, or, with "In the
title or channel only", in the first two, for when descriptions that credit
someone hide too much. Up to 20 words of up to 60 characters, stored with
the row: `exclude: ["Some Name"]` or `include: [...]`, with `filterIn:
"title"` for titles and channels only. The filter works on the pages already
kept, so changing it costs nothing, and the row keeps its id and name.
Measured on 100 results of a stand-up comedy search, hiding one comedian's
name hid 16 videos: 13 naming him in the title or the channel, 3 crediting
him in the description, and none that named him was kept.

### Metadata and streams

A video's page has its title, upload date, length, category, its uploader's
tags (generic words, handles and hashtags dropped, six at most), a link to
the channel, 16:9 artwork, and a description that leads with the channel and
how the video has been received:

```
Example Science
1.2M views · 👍🏻 45K · 👎🏻 ~1.3K
```

Dislikes are an estimate, marked `~`, from
[Return YouTube Dislike](https://returnyoutubedislike.com), since YouTube
stopped publishing them in 2021; it is asked for a video's page only, with
nothing but the video's id. A stream that is live says so, with how many are
watching in place of its views (`🔴 Live · 12.4K watching`), its name starts
with 🔴, and its page is asked for again every two minutes. An
age-restricted video says where it plays.

Every video a row lists is kept by id for everyone for a day, so opening one
costs nothing; one opened from the library later costs a unit. A video
YouTube no longer has answers 404. Its streams are the ways to watch you
chose, written by your stream templates; the configure page previews them on
its **YouTube video** tab.

## Quota

A YouTube Data API key gets **10,000 units a day**. A search costs 100, so a
key can **search 100 times a day**. Enrichment is 1 unit. Browsing YouTube
spends from the same allowance (see
[YouTube in your app](#youtube-in-your-app-search-catalogs-and-your-library)):
a search, typed or as a row, is one of those 100 searches; a channel,
playlist or Trending row is 1 or 2 units. A stream list can cost 1 more, for
the subscriber counts the resolution estimate needs, once a day per channel.
For films and episodes YouStream spends **one search per title looked up**:

- Results are cached and **shared by everyone on the server** (see
  [Caching](#caching)). The same query returns the same videos whoever asks,
  so a second reader opening the same episode costs nobody anything.
- Concurrent identical lookups share one request.
- A key that reports its quota spent is not asked again until the quota
  resets at midnight Pacific time, or for an hour, whichever comes first.
  Meanwhile anything searched before is still answered from the cache, even
  if it is out of date.
- Switching off a content type you do not want (movies, series or anime)
  saves your searches for the others.

Stremio asks every stream addon whenever you open a title's stream list, so
each new title you open costs one search. YouTube's terms forbid working
around the limit with several projects' keys. The supported route is Google's
quota extension form.

## Settings

The configure page is an app, in five tabs:

| Tab | What it holds |
|---|---|
| **Summary** | A new setup's three steps: your YouTube key (checked the moment it is pasted, for 1 unit of quota), your setup at a glance, then your profile or an install link. Signed in: your install link, a warning only when your key needs you, and your setup at a glance |
| **Streams** | How a film, an episode or an anime is found: what to look for (movies, series, anime, and where anime names come from), the results kept, runtime matching, and fine-tuning |
| **Playback** | How each video found is offered in your app, and how its stream reads |
| **Catalogs** | YouTube in your app: the search row (on or off, its order and length, SafeSearch), your catalogs (each with its order, kinds of video, length, name, keyword filter and whether it shows on Home), adding new ones, and how often they refresh |
| **Account** | Signed in: your profile, with its whole ID to sign in with elsewhere, your keys, backups, and your password and link. Otherwise signing in and backups; **More** on a server without profiles |

On a phone the tabs are a bar along the bottom; on a wider screen, a column
down the side. The address says which is open (`/configure#catalogs`), so the
back button and a bookmark work. Every setting belongs to one form whichever
tab shows it, and a problem opens the tab, and the field, to fix. A new setup
is finished on the Summary, which a bar on every other tab leads back to; a
profile saves from a bar that appears with changes, on any tab.

Without a profile, everything you choose is encoded into your personal addon
URL, and nothing is stored on the server; with one, the same settings are kept
in your profile instead (see [Profiles](#profiles)). Either way, only settings
that differ from the defaults are kept:

```js
encodeURIComponent(JSON.stringify({
  youtubeKey: "AIza…",                  // required
  tmdbKey: "…",                         // optional: exact episode runtimes, tmdb: ids
  movieMargin: "10m",                   // "45s", "10m" or "20%"
  partnerMovieMargin: "20%",            // films on official channels
  episodeMargin: "90s",
  typicalMargin: "30%",
  playback: ["app", "youtube"], playbackVersion: 1,
  types: ["movie", "series"],
  anime: true,                          // anime; unless saved, on when films or series are
  animeSource: "auto",                  // anime's names from every source, or "kitsu" alone
  maxResults: 5,                        // videos listed per title, 1–20
  minViews: 1000,                       // fewer views and a video is not offered; 0 = off
  region: "IN",                         // hides videos blocked there, ranks for it
  audioLanguage: "hi",                  // drops other languages (title first, then tag), ranks it first
  embeddableOnly: false,                // on for Stremio Web, which plays in an embed
  officialOnly: false,                  // only uploads from YouTube content partners
  exclude: ["trailer", "reaction", …],  // words that rule out a video's title
  excludeDescription: ["fan movie", …], // phrases that rule out its description
  movieQuery: "{title} {year} full movie {language}",
  episodeQuery: "{title} season {season} episode {episode}",
  format: "youstream",                  // stream text preset: youstream, compact, tamtaro, classic
  nameTemplate: "…",                    // or your own templates, in AIOStreams' formatter syntax
  descriptionTemplate: "…",
  search: true,                         // the app's search searches YouTube too; false switches it off
  searchSort: "relevance",              // YouTube's ranking; or date, viewCount, rating
  searchLength: "any",                  // or a length as a row's
  safeSearch: "moderate",               // YouTube's default; or strict, none
  catalogs: [                           // rows on the home screen and in Discover, in order, up to 20
    { q: "lofi hip hop", sort: "date", length: "20to60", within: "week", types: ["videos", "live"], label: "Lofi" },
                                        // length: any of under4, 4to20, 20to60, over60 joined by +,
                                        // or minutes ("30-45", "90-"), or YouTube's short, medium, long
    { channel: "UC…", name: "A channel", types: ["shorts"], sort: "viewCount" },
                                        // types: any of videos, shorts, live (a channel's default: videos);
                                        // sort: date (default), viewCount
    { playlist: "PL…", name: "Lectures", exclude: ["word"] },  // or include; filterIn: "title"
    { trending: "music", home: false }  // all, music, gaming, film, sports, news, …;
                                        // home: false keeps a row in Discover alone
  ],
  catalogRefresh: "2h"                  // "90m", "6h", "1d": at least 30 minutes
}))
```

`types: []` turns films and shows off, for YouStream as YouTube alone.

**Editing your setup.** The Configure button on an installed addon opens
`/<your config>/configure` with every setting filled in as saved: your
rows in their order, each with its choices. Save without changing anything
and the link is the same, character for character, for links built by
earlier versions of the page too. One thing is rewritten: a channel row
saved before 0.13.0 to list Shorts, live streams or everything (`show`) is
saved with its kinds (`types`), the same row under the same id.

Search templates take `{title} {year} {season} {episode} {s00e00}
{episodeTitle} {absolute} {language}`. `{language}` is your audio language by
name, so with Hindi set a film search becomes "… full movie Hindi". That is
how dubbed uploads are titled. A placeholder with nothing to fill it is
dropped.

**An install URL made without a profile contains your keys. Don't share it
publicly.** A profile's does not, but lets whoever has it use YouStream on
your quota.

The configure page checks both keys before it builds the link or saves the
profile (`POST /api/check-keys`, one quota unit). That catches a mistyped
key, a project without the YouTube Data API enabled, and a key restricted to
websites. It also warns when today's quota is already spent.

## Profiles

On a server whose host has turned them on (`DATABASE_URL` and `SECRET_KEY`,
see [Hosting profiles](#hosting-profiles)), you can keep your settings in a
**profile**, behind a password, instead of in the link:

- **One link, for good.** A profile's install link is
  `https://<host>/<profile id>.<token>/manifest.json`, and it never changes
  when your settings do. It goes into Stremio, Nuvio or AIOStreams once;
  save on the configure page, from any device, and the apps use the new
  settings from their next request. Only what an app keeps in its own copy
  of the manifest, the rows and the content types, takes longer, and the page
  says so when a save changes it: Stremio shows it after a reinstall, Nuvio
  the next time it starts, AIOStreams within six hours.
- **Your keys are not in the link.** The link opens your settings for the
  addon's own use and nothing else: its configure page asks for your
  password. A link that gets out lets someone use YouStream on your YouTube
  quota, never see or change your settings; replace it from the page and the
  old one stops at once.
- **Signed in on your phone.** "Stay signed in" keeps a device signed in for
  30 days from its last use, and 90 at most. The configure page installs as
  an app (Android: Install app; iPhone: Share, then Add to Home Screen) that
  opens straight into your profile.
- **Your password** is at least 8 characters. Changing it signs every other
  device out and keeps the link. It cannot be reset, as it is what unlocks
  your settings: let a password manager keep it.
- **Backups.** Export your settings to a file, with your keys left out unless
  you choose otherwise; import one to fill the form, keeping the keys already
  in it. An import is saved only when you save.
- **Delete** your profile from its page: it and its sign-ins go at once, and
  its link stops working.

**Without a profile** everything works as before: a link that carries its
settings. Links made before profiles keep working, on every server. On a
server with profiles the configure page still offers one ("without a
profile"); on a server without, it is the only way. Opening such a link's
configure page while signed in offers to save its settings to your profile.

### How a profile is kept

Each profile has a random key of its own, and its settings and its link's
token are sealed with that key (AES-256-GCM). The key is stored only sealed:
once with your password, stretched with scrypt (2^15, 32 MiB); once with the
install link's token; and once per remembered sign-in, with the token in that
browser's cookie. Each of those is also bound, with HKDF, to the server's
`SECRET_KEY`, to the profile and to its purpose. So:

- a copy of the database opens nothing without the server's secret, and
  with it, still nothing without a password, a link or a cookie;
- a link opens the settings for the addon only; everything that shows or
  changes them refuses it;
- your password is never stored: a wrong one is one that does not open the
  key;
- the database keeps the hash of a sign-in cookie's token, never the token.

As in AIOStreams, changing the password, replacing the link and deleting the
profile take the password itself, not just a sign-in, so a cookie copied off
a device cannot lock you out. And as there, attempts are limited: 10 wrong
passwords from one client, or 20 for one profile, then a 15-minute wait; 10
new profiles an hour from one client; 120 requests a minute. Requests from
another site are refused, the sign-in cookie is `HttpOnly` and `SameSite=Lax`,
and the configure page is never cached or framed, and runs no script but its
own: its Content-Security-Policy allows only this server's, so markup that
ever slipped into it could run nothing. At most two passwords are
checked at once, so a flood of attempts cannot take the server's memory.

The configure page talks to it through `/api/profile`:

| Route | Purpose |
|---|---|
| `POST /api/profile` | Create a profile: `{ config, password, remember }`; signs this browser in |
| `GET /api/profile` | The signed-in profile: its settings and install link |
| `PUT /api/profile` | Save: `{ config }`; answers `{ saved, manifestChanged }` |
| `DELETE /api/profile` | Delete: `{ password }`, and `{ id }` when not signed in to it |
| `POST /api/profile/session` | Sign in: `{ id, password, remember }` |
| `DELETE /api/profile/session` | Sign this browser out |
| `DELETE /api/profile/sessions` | Sign every browser out of the signed-in profile |
| `POST /api/profile/password` | `{ currentPassword, newPassword }` |
| `POST /api/profile/link` | Replace the install link: `{ password }` |

## Explain endpoint

```
GET /<your config>/explain/<type>/<id>.json
```

This shows the working behind one lookup: what the id resolved to, the
length window and which YouTube length bucket was searched, the exact query,
every match with its score and offset, and **every rejected video with the
reason**. It uses your own key, and costs nothing if the lookup is already
cached. Use it to tune margins, templates and excluded words on evidence:

```
https://<host>/<your config>/explain/series/<imdb id>:<season>:<episode>.json
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /configure` | Setup page; a signed-in profile's page |
| `POST /configure` | The page pre-filled from an imported settings file (nothing saved) |
| `GET /:config/configure` | Re-configuration, pre-filled; for a profile's link, its sign-in |
| `GET /manifest.json` | Unconfigured manifest (configuration required) |
| `GET /:config/manifest.json` | Your manifest |
| `GET /:config/catalog/youtube/:id/:extra?.json` | Your catalogs and the search row (`search=…`, `skip=…`) |
| `GET /:config/meta/youtube/yt_id:<video id>.json` | A YouTube video's details; 404 when it is gone |
| `GET /:config/stream/:type/:id.json` | Streams for films, episodes and YouTube videos |
| `GET /:config/explain/:type/:id.json` | The working behind one lookup |
| `POST /api/check-keys` | Key check for the configure page |
| `POST /api/youtube-source` | Looks up a pasted playlist or channel, as the `kind` chosen, for the configure page (1 unit) |
| `/api/profile…` | Profiles (see [Profiles](#how-a-profile-is-kept)) |
| `GET /configure.js?v=…` | The configure page's script, at an address that carries its version, so browsers keep it a year |
| `GET /app.webmanifest`, `GET /sw.js` | The configure page as an installable app |
| `GET /terms` | Terms of use and privacy policy |
| `GET /health` | Health check used by Railway; also names the cache store, whether IMDb's data and the anime database are loaded (or `off`), and whether profiles are `off`, `starting`, `ready` or `unavailable` |
| `GET /admin/cache` | What the cache holds (only with `CACHE_ADMIN_TOKEN`) |
| `DELETE /admin/cache/:namespace` | Empty `search`, `metadata`, `cooldown`, `browse`, `video`, `dislikes`, `channel` or `all` (only with `CACHE_ADMIN_TOKEN`) |

Catalogs, metadata and streams go through the official `stremio-addon-sdk`
router. The manifest claims, per resource:

- streams for `movie` and `series` with the id prefixes `tt` and, only when
  a TMDB key is available to read them, `tmdb:`, and with anime on, for
  `anime` too (anime addons file anime under all three) with `kitsu:`,
  `mal:`, `anilist:` and `anidb:`. Each switch the reader turns off takes
  its ids out;
- metadata and streams for `youtube`, with `yt_id:` (and, for videos saved before 0.8.0, `YouTube` with `youstream:`);
- streams for `channel`, with `yt_id:`, the videos of Stremio's own YouTube add-on.

Its catalogs are yours, then the search row. A catalog id must be in your
own config to answer, so the addon is no open proxy for YouTube searches.

Every answer on the addon protocol, the manifest and errors included, says
any site may read it (`Access-Control-Allow-Origin: *`), as Stremio's web
app and AIOStreams' page need: they read a manifest from the browser, and a
browser hides an answer that does not say so. The configure page and the
profile API say no such thing.

The unconfigured manifest (`/manifest.json`, or any without a YouTube key)
cannot be used by accident: Stremio offers Configure instead of Install, and
since Nuvio ignores that flag, it also claims a single id prefix no title
has, so an app that installs it anyway never asks it about anything.

## Running locally

```bash
npm install
npm start                 # http://localhost:3000/configure
npm test                  # about 1,800 tests
npm run test:coverage     # pinned at 100% statements, branches, functions, lines
```

Tests mock every upstream (no keys or network needed). The configure page's
script (`src/web/configure.js`) runs in a real DOM (jsdom) and the service
worker (`src/web/sw.js`) in a stand-in for a worker's scope; both are loaded
through Jest, so coverage measures them like the server, and the browser gets
the very same files, each wrapped to start at once. Starting the server is
measured too: `start.js` only calls `start()` in `server.js`, which the tests
run in-process. Nothing is left out of the 100%. With `REDIS_TEST_URL` set (CI
starts a Redis for it), the cache is also tested against a real Redis:

```bash
redis-server --port 6390 --daemonize yes
REDIS_TEST_URL=redis://127.0.0.1:6390 npm test
```

Profiles are tested on SQLite in memory always, and with `POSTGRES_TEST_URL`
set (CI starts a PostgreSQL for it), on a real PostgreSQL as well:

```bash
POSTGRES_TEST_URL=postgres://postgres@127.0.0.1:5432/youstream_test npm test
```

### End to end

`e2e/run.js` tests a running server against the real YouTube, Kitsu,
AniList and the rest, and its pages in a real browser on a phone and a
desktop: about 50 checks, from the manifest, every kind of row and stream
lookups for a film, an episode and an anime, to a profile made, saved,
signed out of and deleted (when the server has profiles on; a failed check
or Ctrl-C never leaves one behind). It spends about 620 units of the key's
quota. The browser checks need Playwright, and are
skipped without it.

```bash
YOUTUBE_KEY=AIza… node e2e/run.js http://localhost:3000
E2E_ONLY=server,addon node e2e/run.js https://youstream-beta.up.railway.app
```

### Real-data tests

The precision figures above come from replaying real YouTube search results
and IMDb runtimes. Their owners' terms do not allow publishing that data, so
it lives in a private repository, `youstream-fixtures`, and the three suites
that use it (`corpus`, `realWorld`, `liveApi`) are skipped without it.
Everything else, at 100% coverage, runs without it. With access:

```bash
git clone https://github.com/deejay189393/youstream-fixtures.git test/fixtures/private
npm test                  # the real-data suites now run too
```

CI checks the fixtures out when the repository has a `FIXTURES_TOKEN` secret
(a token with read access to `youstream-fixtures`). Without it, CI skips those
suites and marks the run with a warning that says so.

## Caching

Only what upstream services said is cached, never a verdict: each YouTube
search with its enrichment, and each metadata service's answer. Matching runs
afresh on every request, so a reader's settings, and any change to the
matching rules, apply at once with nothing to flush. Every setting here is
the host's, through environment variables (see below); readers never see
them.

**Where.** In memory by default: nothing to set up, but lost on every restart
and redeploy. Set `REDIS_URL` and it is Redis: kept across redeploys, shared
by every instance (prod and beta too, if they share a Redis and a prefix).
Or `CACHE_STORE=file` with `CACHE_DIR` on a Railway volume: kept across
redeploys, one instance. Or `CACHE_STORE=database`: a table in the database
`DATABASE_URL` names, the one profiles are kept in, so a host with profiles
needs nothing more; kept across redeploys, and shared like Redis. Measured
on SQLite: a catalog that took YouTube 0.8 s came back after a restart, with
YouTube cut off, in 8 ms.

The database store keeps to `CACHE_DATABASE_MB` for its prefix, deleting
what expires soonest, and deletes expired rows every hour. On PostgreSQL
its table is unlogged: Postgres writes no log for what is only a copy, and
empties the table after a crash, which is how a database restored from a
backup starts, so a backup never brings old YouTube data back.

**For how long, and how it is invalidated.**

| | Default | |
|---|---|---|
| A search | 1 day | then searched again, so new uploads appear and taken-down ones go |
| A search for a recent release | 3 hours | anything released in the last 30 days, or not yet: an upload that follows a premiere is found the same day |
| Metadata | 3 days | titles, runtimes and credits rarely change |
| A YouTube catalog's page | your refresh interval, 2 hours by default | per reader, under a fingerprint of the key |
| A YouTube search's page | 2 minutes, then 10 more for outages only | per reader |
| A YouTube video's details | 1 day (the search lifetime); 2 minutes for a stream that is live | shared: every video a row lists, and any opened by id |
| A video's dislike estimate | 1 day (the search lifetime) | shared; after a refusal or an error, none is asked for a minute |
| A channel's subscriber count | 1 day (the search lifetime) | shared; for the resolution estimate |
| Kept past that, for outages | 7 days | answered with **only** when the service it came from fails (a spent quota, an outage): yesterday's results beat none |
| A key with its quota spent | until the quota resets, an hour at most | |

YouTube data is never kept more than 30 days in all, as YouTube's API
policies require, whatever the settings. Each kind of entry carries a version
in its key, so when the code changes what it stores, old entries are never
read again and expire on their own. To empty the cache by hand, use
`DELETE /admin/cache/<namespace>` or change `CACHE_PREFIX`.

**When the store fails** (Redis or the database unreachable, a disk full),
the addon answers without its cache rather than not at all, says so in the
log once a minute at most, and picks the store up again when it is back,
without a restart. The database store waits two seconds at most for its
first connection, and after a failed statement stops asking for ten, so a
database that is down costs one short wait, not one per lookup.

**In the app.** Stream lists tell Stremio and Nuvio how long to reuse them: 6
hours with videos in them, 1 hour when empty (no longer than the server's own
search for a recent release), 1 minute after a failure. A failure is YouTube
not answering, or the title not found while a service that might know it did
not answer (Cinemeta timing out, TMDB down): that is not an unknown title, so
it is asked about again in a minute rather than an hour. A YouTube video's
page is reused for 6 hours, a live stream's for 2 minutes.

## Deploying

The repo ships a `Dockerfile` and a `railway.json` (Docker builder, `/health`
healthcheck), the same as Newsio. It is laid out like Newsio on Railway: one
project, `youstream`, with a service per release channel.

| Service | Branch | Domain | Region | Variables |
|---|---|---|---|---|
| `youstream` | `main` | [youstream.up.railway.app](https://youstream.up.railway.app/configure) | Singapore | `PORT=3000`, `TVDB_API_KEY`, optionally `TMDB_API_KEY`, `REDIS_URL` |
| `youstream-beta` | `beta` | [youstream-beta.up.railway.app](https://youstream-beta.up.railway.app/configure) | Singapore | the same, plus `RELEASE_CHANNEL=beta`, for profiles `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `SECRET_KEY=${{shared.SECRET_KEY}}`, and `CACHE_STORE=database` |
| `Postgres` | | private network only | Singapore | Railway's PostgreSQL template: the profiles, and beta's cache. Its volume is backed up daily (kept 6 days) and weekly (kept 27 days) |

`SECRET_KEY` is a shared variable of the project's environment, generated
by Railway (`${{ secret(64, "abcdef0123456789") }}`), so its value is in no
file and no log. Prod can take the same two references to share beta's
profiles: one database, one key, and a profile's install link then works on
either address. Migrations only ever add, so prod's older code keeps
working on a database beta has moved ahead.

Work happens on `beta`, which beta deploys on every push; `main` moves only
when a release goes to prod. CI runs on both: the tests, on Node 24 like the
image, against a real Redis and PostgreSQL, and a build of the production
image, started and asked for `/health` and its manifest, and started again
with profiles on SQLite.

Beta's cache survives redeploys in that same database. Prod can do the
same with the same two references and `CACHE_STORE=database`; with the same
`CACHE_PREFIX` (the default), the two then share their searches. Or add
Railway's Redis to the project and set `REDIS_URL=${{Redis.REDIS_URL}}` on
each service; Railway's private network is IPv6, and the Redis client is
already set up for it.

### Hosting profiles

Profiles need a database that outlives the container, and a secret:

- **SQLite on a volume**, the cheapest: add a volume to the service, mounted
  at `/data` for instance, and set `DATABASE_URL=sqlite:///data/youstream.db`.
  Railway stops a service with a volume before starting its new deploy, so
  each deploy has a few seconds without the addon.
- **PostgreSQL**, a service of its own: set
  `DATABASE_URL=${{Postgres.DATABASE_URL}}`. The addon then has no volume and
  deploys without a gap.
- **`SECRET_KEY`**: 64 hexadecimal characters, from `openssl rand -hex 32` or
  Railway's `${{secret(64, "abcdef0123456789")}}`. Keep it only in the
  service's variables, never with the database: the two together are what
  open a profile, with its password or link. **Never change it**: no profile
  would open. YouStream notices a changed one at start and keeps profiles off
  rather than mix two secrets in one database.

The tables are made on start, and kept up to date by numbered migrations.
YouStream never waits for the database: while it cannot be reached, links
that carry their settings work as ever, profile links answer with a row
saying so, and YouStream tries again every few seconds, then minutes.

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Set by Railway; defaults to 3000 |
| `TVDB_API_KEY` | **Recommended.** A TheTVDB v4 key: episodes' own runtimes and air dates. Free for projects earning under $50k a year, with a credit to TheTVDB, which the configure page shows. Get one from the API keys page of a thetvdb.com account |
| `TVDB_PIN` | Only for a subscriber-supported TheTVDB key |
| `IMDB_DATASETS` | `off` matches films on Cinemeta's runtimes alone instead of loading IMDb's own data (about 230 MB downloaded daily, 13 MB kept in memory) |
| `ANIME_DATASET` | `off` looks anime up on Kitsu and AniList alone instead of loading the anime offline database (about 60 MB downloaded weekly, 29 MB kept in memory), which maps MyAnimeList, AniList and AniDB ids to Kitsu's and holds the names uploads use |
| `TMDB_API_KEY` | Optional. A TMDB key (v3 API key or v4 read access token) used for every reader without one of their own: `tmdb:` ids, fuller credits and other names |
| `RELEASE_CHANNEL` | `beta` gives the manifest its own id (`org.deejay189393.youstream.beta`) and name ("YouStream Beta"), so prod and beta can be installed side by side |
| `STREMIO_ADDONS_CONFIG_SIGNATURE` | The stremio-addons.net listing claim, once issued for this addon's manifest URL. Left out of the manifest until set |
| `STREMIO_ADDONS_CONFIG_ISSUER` | Overrides the claim issuer (defaults to `https://stremio-addons.net`) |
| `CACHE_STORE` | `memory`, `redis`, `file` or `database` (a table in `DATABASE_URL`'s database). Default: `redis` when `REDIS_URL` is set, otherwise `memory` |
| `REDIS_URL` | `redis://user:password@host:port` |
| `CACHE_DIR` | Where the file store writes (default `.cache`); a Railway volume's mount path |
| `CACHE_PREFIX` | Namespace for every key (default `youstream`). Prod and beta on one Redis with the same prefix share their searches; different prefixes keep them apart |
| `CACHE_MEMORY_MB`, `CACHE_FILE_MB`, `CACHE_DATABASE_MB` | Size of the memory store (default 64), the file store (default 512) and the database store, for this `CACHE_PREFIX` (default 512) |
| `CACHE_SEARCH_TTL` | How long a search is current (default `24h`) |
| `CACHE_SEARCH_RECENT_TTL` | The same for a recent release (default `3h`) |
| `CACHE_RECENT_DAYS` | What counts as recent (default `30`) |
| `CACHE_METADATA_TTL` | How long metadata is current (default `3d`) |
| `CACHE_STALE_TTL` | How much longer an entry is kept, to answer with when its source fails (default `7d`) |
| `CACHE_ADMIN_TOKEN` | Turns on `/admin/cache`, with this as the bearer token |
| `STREAM_CACHE_MAX_AGE` | How long an app may reuse a stream list with videos (default `6h`) |
| `STREAM_CACHE_MAX_AGE_EMPTY` | ... an empty one (default `1h`) |
| `BLOCKED_VIDEOS` | Videos this server never offers, for a rights holder who asks: ids or YouTube links, separated by commas or spaces |
| `BLOCKED_CHANNELS` | The same for whole channels: `UC…` ids or `youtube.com/channel/` links |
| `CONTACT` | An email address or URL on the terms page, for questions and removal requests (default: this repository's GitHub issues) |
| `DATABASE_URL` | Where profiles are kept: `sqlite:///absolute/path.db`, `sqlite://./relative/path.db` or `postgres://user:password@host:port/db`. With `SECRET_KEY`, turns profiles on |
| `SECRET_KEY` | 64 hexadecimal characters (32 random bytes) every profile's keys are bound to. Never change it |
| `PROFILE_SESSION_TTL` | How long "stay signed in" lasts unused (default `30d`) |
| `PROFILE_SESSION_MAX_TTL` | How long it lasts at most, however much it is used (default `90d`) |
| `PROFILE_PRUNE_AFTER` | Delete a profile no app or sign-in has used for this long, `365d` say (default: never) |
| `TRUST_PROXY` | How many proxies stand in front, whose `X-Forwarded-For` names the client the sign-in limits count (default `1`, Railway's); `false` for none |

Durations are seconds, or a number with `s`, `m`, `h` or `d`; `0` turns that
cache off. A value that cannot be read is reported in the log at startup,
with the default used instead, and the startup log says what cache is in use.

There is no server YouTube key on purpose. One key's 100 daily searches
shared by every reader would run out within hours.

## Data sources and credits

| Source | Used for | Terms |
|---|---|---|
| [Cinemeta](https://v3-cinemeta.strem.io) | names, years, cast, episode lists | Stremio's free metadata service |
| [IMDb](https://www.imdb.com) | films' runtimes | IMDb's [non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/), for personal and non-commercial use, credited as IMDb asks: "Information courtesy of IMDb (https://www.imdb.com). Used with permission." |
| [TheTVDB](https://thetvdb.com) | episodes' runtimes and air dates | free under $50k a year in revenue, credited with a link |
| [TVmaze](https://www.tvmaze.com) | episodes' runtimes without a TheTVDB or TMDB key | free, no key; data under CC BY-SA 4.0, credited |
| [TMDB](https://www.themoviedb.org) | `tmdb:` ids, cast, other names | free API key; credited with its logo and "This product uses the TMDB API but is not endorsed or certified by TMDB." |
| [Kitsu](https://kitsu.io) | anime's names, episode titles and lengths | free, no key |
| [AniList](https://anilist.co) | an anime's English name when Kitsu has none, by AniList or MyAnimeList id | free for non-commercial use, no key |
| [anime offline database](https://github.com/manami-project/anime-offline-database) | every anime's ids on each site, and the names each site knows it by; a weekly copy kept current by [a fork](https://github.com/cedya77/anime-offline-database) | Open Database License (ODbL 1.0), credited |
| [Return YouTube Dislike](https://returnyoutubedislike.com) | a YouTube video's dislike estimate, on its page | free, no key; at most 100 requests a minute and 10,000 a day; credited with a link |

The configure page and the terms page show the credits these terms ask for.

## Known limits

- **Only what is on YouTube.** Most studio films are not. YouStream finds
  what is there, and returns nothing rather than something wrong.
- **Unofficial re-uploads match too**, if they are older than five years,
  the right length, named right, and show evidence they are the title.
  YouTube is the authority on what it hosts. **Only official channels** keeps
  them out.
- **Correct uploads are sometimes missed, by design.** An upload with no
  year, cast or episode title anywhere in its title or description is not
  offered, however likely it is to be right.
- **Paid YouTube Movies** (rentals) are not marked as such by the API. They
  may appear as matches the app cannot play.
- **Films split into parts** ("Part 1/2") are not stitched together. Each
  part is too short to match.
- **Resolution is an estimate.** YouTube's API says only HD or SD, so an HD
  video's resolution comes from its title, whether it is live, when it came
  out and its channel's size (see
  [How sharp a stream is said to be](#how-sharp-a-stream-is-said-to-be)).
  In-app playback picks the best quality YouTube has either way.
- **YouTube search here is not your YouTube.** With an API key, search is
  YouTube's ranking for anyone, not personalised. It has no subscriptions,
  history or recommendations, which need you to sign in with Google.
  Channel catalogs are the way to follow channels.
- **Outside a channel row, Shorts and streams are told, not looked up.**
  The API has no field for them, so a search, playlist or Trending row
  tells a Short by its shape and length, and a past stream from a premiere
  by its timing (see [Catalogs](#catalogs)). About 1 Short in 70 slips
  through, the square ones. A channel row of one kind is exact.

## Legal

**What YouStream does.** It searches YouTube, with each reader's own YouTube
Data API key, and returns links to the YouTube videos it finds: their ids and
youtube.com addresses. It does not host, store, download, copy, proxy or
modify any video. Every video it lists is hosted by YouTube and subject to
YouTube's rules and takedowns.

**Terms and privacy.** YouStream uses YouTube API Services. Its
[terms of use and privacy policy](https://youstream.up.railway.app/terms)
(served at `/terms`) bind users to the
[YouTube Terms of Service](https://www.youtube.com/t/terms) and link the
[Google Privacy Policy](https://policies.google.com/privacy), and the
configure page asks readers to agree to both before it builds an install
link, as YouTube's API Services policies require. On a server that keeps
profiles, it also says what a profile keeps, for how long, and the one
cookie a sign-in sets.

**Rights holders.** To have a video or channel no longer offered by a
YouStream server, contact its host (the `CONTACT` on its terms page; for
youstream.up.railway.app, this repository's issues), who adds it to
`BLOCKED_VIDEOS` or `BLOCKED_CHANNELS`. To have it removed from YouTube, and
so from everywhere, use
[YouTube's copyright removal process](https://support.google.com/youtube/answer/2807622).

**Trademarks.** YouTube is a trademark of Google LLC. YouStream is an
independent project, not affiliated with or endorsed by YouTube, Google,
Stremio or Nuvio. Other names are trademarks of their owners.

## License

MIT, see [LICENSE](LICENSE).
