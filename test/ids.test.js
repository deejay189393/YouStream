const { parseStreamId, contentKind, ANIME_SOURCES } = require("../src/ids");

describe("parseStreamId", () => {
  test("an IMDb film", () => {
    expect(parseStreamId("tt0111161")).toEqual({ source: "imdb", id: "tt0111161", season: null, episode: null, isEpisode: false });
  });

  test("an IMDb episode", () => {
    expect(parseStreamId("tt4742876:1:3")).toEqual({ source: "imdb", id: "tt4742876", season: 1, episode: 3, isEpisode: true });
  });

  test("a special in season 0", () => {
    expect(parseStreamId("tt4742876:0:2")).toMatchObject({ season: 0, episode: 2 });
  });

  test("TMDB films and episodes, as Nuvio sends them", () => {
    expect(parseStreamId("tmdb:278")).toEqual({ source: "tmdb", id: "278", season: null, episode: null, isEpisode: false });
    expect(parseStreamId("tmdb:63180:2:5")).toEqual({ source: "tmdb", id: "63180", season: 2, episode: 5, isEpisode: true });
  });

  test("Kitsu numbers episodes without a season", () => {
    expect(parseStreamId("kitsu:45398")).toEqual({ source: "kitsu", id: "45398", season: null, episode: null, isEpisode: false });
    expect(parseStreamId("kitsu:45398:3")).toEqual({ source: "kitsu", id: "45398", season: 1, episode: 3, isEpisode: true });
  });

  test("a season-shaped Kitsu id takes the episode from the end", () => {
    expect(parseStreamId("kitsu:45398:1:3")).toMatchObject({ season: 1, episode: 3 });
  });

  test("MyAnimeList, AniList and AniDB ids read as Kitsu's do", () => {
    expect(parseStreamId("mal:16498:3")).toEqual({ source: "mal", id: "16498", season: 1, episode: 3, isEpisode: true });
    expect(parseStreamId("anilist:16498")).toEqual({ source: "anilist", id: "16498", season: null, episode: null, isEpisode: false });
    expect(parseStreamId("anidb:9541:1:3")).toMatchObject({ source: "anidb", season: 1, episode: 3 });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseStreamId(" tt0111161 ")).toMatchObject({ id: "tt0111161" });
  });

  test.each([
    [undefined],
    [42],
    [""],
    ["nd_123"],
    ["tt12"],
    ["tmdb:"],
    ["tmdb:abc"],
    ["mal:"],
    ["anilist:x:1"],
    ["anidb:1:2:3:4"],
    ["simkl:123:1"],
    ["tt0111161:1"],
    ["tt0111161:1:2:3"],
    ["tt0111161:a:b"],
    ["kitsu:1:2:3:4"]
  ])("refuses %p", (id) => {
    expect(parseStreamId(id)).toBeNull();
  });
});

describe("contentKind", () => {
  test("episodes are series, everything else is a movie", () => {
    expect(contentKind(parseStreamId("tt4742876:1:3"))).toBe("series");
    expect(contentKind(parseStreamId("tt0111161"))).toBe("movie");
    expect(contentKind(parseStreamId("tmdb:63180:2:5"))).toBe("series");
  });

  test("any anime database's id is anime, an episode or a film", () => {
    for (const id of ["kitsu:45398:3", "kitsu:45398", "mal:16498:3", "anilist:16498", "anidb:9541:3"]) {
      expect(contentKind(parseStreamId(id))).toBe("anime");
    }
    expect(ANIME_SOURCES).toEqual(["kitsu", "mal", "anilist", "anidb"]);
  });
});
