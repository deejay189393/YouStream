const {
  fold,
  tokens,
  hasPhrase,
  significantTokens,
  formatDuration,
  formatOffset,
  formatCount
} = require("../src/text");

describe("fold", () => {
  test("lower-cases, strips punctuation and collapses whitespace", () => {
    expect(fold("  Kota Factory - S01 E03 -  Optimization ")).toBe("kota factory s01 e03 optimization");
  });

  test("reads the typeset forms of a name the same way", () => {
    expect(fold("SPY×FAMILY")).toBe("spy family");
    expect(fold("Spy-Family")).toBe("spy family");
  });

  test("drops apostrophes rather than splitting the word", () => {
    expect(fold("Ocean's Eleven")).toBe("oceans eleven");
    expect(fold("Ocean’s")).toBe("oceans");
    expect(fold("Ocean´s")).toBe("oceans");
  });

  test("removes Latin accents", () => {
    expect(fold("Amélie Película")).toBe("amelie pelicula");
  });

  test("keeps the vowel signs of Indic scripts", () => {
    // The matras of Devanagari are combining marks; losing them would leave
    // bare consonants that match nothing an uploader typed.
    expect(fold("गुल्लक")).toBe("गुल्लक");
  });

  test("writes & as 'and'", () => {
    expect(fold("Tom & Jerry")).toBe("tom and jerry");
  });

  test("treats null and undefined as empty, and numbers as text", () => {
    expect(fold(null)).toBe("");
    expect(fold(undefined)).toBe("");
    expect(fold(1917)).toBe("1917");
  });
});

describe("tokens", () => {
  test("splits the folded text", () => {
    expect(tokens("The Shawshank Redemption")).toEqual(["the", "shawshank", "redemption"]);
  });

  test("is empty for empty text", () => {
    expect(tokens("  - ")).toEqual([]);
  });
});

describe("hasPhrase", () => {
  test("matches whole words only", () => {
    expect(hasPhrase("kota factory s01", "kota factory")).toBe(true);
    expect(hasPhrase("kota factoryx", "kota factory")).toBe(false);
  });

  test("an empty needle matches nothing", () => {
    expect(hasPhrase("anything", "")).toBe(false);
  });
});

describe("significantTokens", () => {
  test("leaves out common words", () => {
    expect(significantTokens("The Lord of the Rings")).toEqual(["lord", "rings"]);
  });

  test("keeps every word when all of them are common", () => {
    expect(significantTokens("The The")).toEqual(["the", "the"]);
  });
});

describe("formatting", () => {
  test("durations", () => {
    expect(formatDuration(8520)).toBe("2h 22m 00s");
    expect(formatDuration(2211)).toBe("36m 51s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(-3)).toBe("0s");
  });

  test("signed offsets", () => {
    expect(formatOffset(0.2)).toBe("exact");
    expect(formatOffset(65)).toBe("+1m 05s");
    expect(formatOffset(-20)).toBe("−20s");
  });

  test("counts", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1.2K");
    expect(formatCount(241766)).toBe("242K");
    expect(formatCount(3400000)).toBe("3.4M");
    expect(formatCount(2.1e9)).toBe("2.1B");
    expect(formatCount(null)).toBeNull();
    expect(formatCount(NaN)).toBeNull();
  });
});
