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

It only ever returns YouTube video ids and YouTube links. Nothing is
downloaded, proxied or re-hosted.

---

## How it works

```
tt…:1:3                                         the id the app asks about
  -> the show, S1 E3, the episode's name,      metadata: Cinemeta, IMDb, TheTVDB, TMDB, Kitsu
     runs ~43 min, cast, IMDb id
  -> "<show> season 1 episode 3"               one YouTube search, long videos only
  -> 50 results, each judged                   length, name, episode, exclusions
  -> the official S01 E03 upload               ranked matches -> stream rows
```

1. **Read the id.** `tt…` (IMDb), `tmdb:…` (Nuvio uses these for some titles)
   and `kitsu:…` (anime), for films and for `:season:episode` episodes.
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
Redis or files (see [Caching](#caching)).

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

In-app playback works the way Newsio's does. Nuvio resolves a bare `ytId` on
the device through the extractor its trailers use
(`YouTubeStreamResolver` → `InAppYouTubeExtractor.extractSingleUrl`, which
prefers YouTube's HLS playlist, so every quality is available). It does this
only when the stream has no `url` or `externalUrl`, which is why this row
carries neither. That needs a Nuvio release newer than 1.1.0-beta.2. Stremio
plays `ytId` in its built-in YouTube player. Nothing passes through this
server, so YouTube blocking datacenter addresses never matters.

Age-restricted videos play only for a signed-in viewer, so they get no in-app
row, only the external ones. Each row's `bingeGroup` names the way of
watching and the channel, so next-episode autoplay stays on the same choice.

## Quota

A YouTube Data API key gets **10,000 units a day**. A search costs 100, so a
key can **search 100 times a day**. Enrichment is 1 unit. YouStream spends
**one search per title looked up**:

- Results are cached and **shared by everyone on the server** (see
  [Caching](#caching)). The same query returns the same videos whoever asks,
  so a second reader opening the same episode costs nobody anything.
- Concurrent identical lookups share one request.
- A key that reports its quota spent is not asked again until the quota
  resets at midnight Pacific time, or for an hour, whichever comes first.
  Meanwhile anything searched before is still answered from the cache, even
  if it is out of date.
- Switching off a content type you do not want saves your searches for the
  other.

Stremio asks every stream addon whenever you open a title's stream list, so
each new title you open costs one search. YouTube's terms forbid working
around the limit with several projects' keys. The supported route is Google's
quota extension form.

## Settings

Everything you choose is encoded into your personal addon URL. Nothing is
stored on the server. Only settings that differ from the defaults go into the
URL:

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
  maxResults: 5,                        // videos listed per title, 1–20
  minViews: 1000,                       // fewer views and a video is not offered; 0 = off
  region: "IN",                         // hides videos blocked there, ranks for it
  audioLanguage: "hi",                  // drops other languages (title first, then tag), ranks it first
  embeddableOnly: false,                // on for Stremio Web, which plays in an embed
  officialOnly: false,                  // only uploads from YouTube content partners
  exclude: ["trailer", "reaction", …],  // words that rule out a video's title
  excludeDescription: ["fan movie", …], // phrases that rule out its description
  movieQuery: "{title} {year} full movie {language}",
  episodeQuery: "{title} season {season} episode {episode}"
}))
```

Search templates take `{title} {year} {season} {episode} {s00e00}
{episodeTitle} {absolute} {language}`. `{language}` is your audio language by
name, so with Hindi set a film search becomes "… full movie Hindi". That is
how dubbed uploads are titled. A placeholder with nothing to fill it is
dropped.

**Your install URL contains your keys. Don't share it publicly.**

The configure page checks both keys before it builds the link
(`POST /api/check-keys`, one quota unit). That catches a mistyped key, a
project without the YouTube Data API enabled, and a key restricted to
websites. It also warns when today's quota is already spent.

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
| `GET /configure` | Setup page |
| `GET /:config/configure` | Re-configuration, pre-filled |
| `GET /manifest.json` | Unconfigured manifest (configuration required) |
| `GET /:config/manifest.json` | Your manifest |
| `GET /:config/stream/:type/:id.json` | Streams, through the official `stremio-addon-sdk` router |
| `GET /:config/explain/:type/:id.json` | The working behind one lookup |
| `POST /api/check-keys` | Key check for the configure page |
| `GET /terms` | Terms of use and privacy policy |
| `GET /health` | Health check used by Railway; also names the cache store |
| `GET /admin/cache` | What the cache holds (only with `CACHE_ADMIN_TOKEN`) |
| `DELETE /admin/cache/:namespace` | Empty `search`, `metadata`, `cooldown` or `all` (only with `CACHE_ADMIN_TOKEN`) |

The manifest is stream-only (`resources: ["stream"]`, no catalogs). It
claims `movie`, `series` and `anime` with the id prefixes `tt`, `kitsu:`
and, only when a TMDB key is available to read them, `tmdb:`.

The unconfigured manifest (`/manifest.json`, or any without a YouTube key)
cannot be used by accident: Stremio offers Configure instead of Install, and
since Nuvio ignores that flag, it also claims a single id prefix no title
has, so an app that installs it anyway never asks it about anything.

## Running locally

```bash
npm install
npm start                 # http://localhost:3000/configure
npm test                  # about 700 tests
npm run test:coverage     # pinned at 100% statements, branches, functions, lines
```

Tests mock every upstream (no keys or network needed) and run the configure
page's script in a real DOM (jsdom). With `REDIS_TEST_URL` set (CI starts a
Redis for it), the cache is also tested against a real Redis:

```bash
redis-server --port 6390 --daemonize yes
REDIS_TEST_URL=redis://127.0.0.1:6390 npm test
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
(a token with read access to `youstream-fixtures`), and skips those suites
otherwise.

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
redeploys, one instance.

**For how long, and how it is invalidated.**

| | Default | |
|---|---|---|
| A search | 1 day | then searched again, so new uploads appear and taken-down ones go |
| A search for a recent release | 3 hours | anything released in the last 30 days, or not yet: an upload that follows a premiere is found the same day |
| Metadata | 3 days | titles, runtimes and credits rarely change |
| Kept past that, for outages | 7 days | answered with **only** when the service it came from fails (a spent quota, an outage): yesterday's results beat none |
| A key with its quota spent | until the quota resets, an hour at most | |

YouTube data is never kept more than 30 days in all, as YouTube's API
policies require, whatever the settings. Each kind of entry carries a version
in its key, so when the code changes what it stores, old entries are never
read again and expire on their own. To empty the cache by hand, use
`DELETE /admin/cache/<namespace>` or change `CACHE_PREFIX`.

**When the store fails** (Redis unreachable, a disk full), the addon answers
without its cache rather than not at all, and says so in the log once a
minute at most. Measured with Redis down: lookups answered in 0.05 s; when
Redis came back, caching resumed without a restart.

**In the app.** Stream lists tell Stremio and Nuvio how long to reuse them: 6
hours with videos in them, 1 hour when empty (no longer than the server's own
search for a recent release), 1 minute after a failure.

## Deploying

The repo ships a `Dockerfile` and a `railway.json` (Docker builder, `/health`
healthcheck), the same as Newsio. It is laid out like Newsio on Railway: one
project, `youstream`, with a service per release channel.

| Service | Branch | Domain | Region | Variables |
|---|---|---|---|---|
| `youstream` | `main` | [youstream.up.railway.app](https://youstream.up.railway.app/configure) | Singapore | `PORT=3000`, `TVDB_API_KEY`, optionally `TMDB_API_KEY`, `REDIS_URL` |
| `youstream-beta` | `beta` | `youstream-beta.up.railway.app` | US East | the same, plus `RELEASE_CHANNEL=beta` |

For a cache that survives redeploys, add Railway's Redis to the project and
set `REDIS_URL=${{Redis.REDIS_URL}}` on each service. Railway's private
network is IPv6; the Redis client is already set up for it.

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Set by Railway; defaults to 3000 |
| `TVDB_API_KEY` | **Recommended.** A TheTVDB v4 key: episodes' own runtimes and air dates. Free for projects earning under $50k a year, with a credit to TheTVDB, which the configure page shows. Get one from the API keys page of a thetvdb.com account |
| `TVDB_PIN` | Only for a subscriber-supported TheTVDB key |
| `IMDB_DATASETS` | `off` matches films on Cinemeta's runtimes alone instead of loading IMDb's own data (about 230 MB downloaded daily, 13 MB kept in memory) |
| `TMDB_API_KEY` | Optional. A TMDB key (v3 API key or v4 read access token) used for every reader without one of their own: `tmdb:` ids, fuller credits and other names |
| `RELEASE_CHANNEL` | `beta` gives the manifest its own id (`org.deejay189393.youstream.beta`) and name ("YouStream Beta"), so prod and beta can be installed side by side |
| `STREMIO_ADDONS_CONFIG_SIGNATURE` | The stremio-addons.net listing claim, once issued for this addon's manifest URL. Left out of the manifest until set |
| `STREMIO_ADDONS_CONFIG_ISSUER` | Overrides the claim issuer (defaults to `https://stremio-addons.net`) |
| `CACHE_STORE` | `memory`, `redis` or `file`. Default: `redis` when `REDIS_URL` is set, otherwise `memory` |
| `REDIS_URL` | `redis://user:password@host:port` |
| `CACHE_DIR` | Where the file store writes (default `.cache`); a Railway volume's mount path |
| `CACHE_PREFIX` | Namespace for every key (default `youstream`). Prod and beta on one Redis with the same prefix share their searches; different prefixes keep them apart |
| `CACHE_MEMORY_MB`, `CACHE_FILE_MB` | Size of the memory store (default 64) and the file store (default 512) |
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
| [Kitsu](https://kitsu.io) | anime | free, no key |

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
- **MAL ids** (`mal:`) are not read yet. Kitsu ids are.

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
link, as YouTube's API Services policies require.

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
