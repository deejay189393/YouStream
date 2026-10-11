/**
 * Text normalisation shared by everything that compares a video's title with
 * a film's or a show's name.
 *
 * Both sides go through `fold` before they are compared, so the comparison
 * never depends on case, accents, punctuation or the way a title happens to
 * be typeset: "SPY×FAMILY", "Spy x Family" and "spy-family" all become
 * "spy x family" or "spy family", and the token checks below absorb the
 * difference.
 */

/** Apostrophes are dropped rather than spaced, so "Ocean's" stays one word. */
const APOSTROPHES = /['\u2018\u2019`\u00b4]/g;

/**
 * Lower case, accents off, punctuation to spaces, whitespace collapsed.
 *
 * Only the Latin combining accents (U+0300 to U+036F) are removed. The other
 * combining marks are kept on purpose: Devanagari, Tamil and the other Indic
 * scripts write their vowels as combining marks, and stripping every mark
 * would turn a Hindi title into a row of bare consonants.
 */
function fold(text) {
  return String(text == null ? "" : text)
    // Before normalising: NFKD splits the acute-accent apostrophe into a
    // space and an accent, which would then split the word in two.
    .replace(APOSTROPHES, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

function tokens(text) {
  const folded = fold(text);
  return folded ? folded.split(" ") : [];
}

/** Whether `needle` occurs in `haystack` as whole words, both already folded. */
function hasPhrase(haystack, needle) {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Words too common to say anything about which film a title names. They are
 * left out when counting how much of a name a video's title covers, so "The
 * Shawshank Redemption" is judged on "shawshank" and "redemption".
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "in", "on", "to", "for", "with", "at", "by", "from",
  "de", "la", "le", "el", "der", "die", "das"
]);

/** The words of a name that identify it, or all of them if every one is common. */
function significantTokens(name) {
  const all = tokens(name);
  const significant = all.filter((t) => !STOPWORDS.has(t));
  return significant.length ? significant : all;
}

/** "1h 2m 3s", "23m 05s", "45s". */
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** A signed difference, for showing how far a video is from the listed runtime. */
function formatOffset(seconds) {
  const rounded = Math.round(seconds);
  if (rounded === 0) return "exact";
  return `${rounded > 0 ? "+" : "−"}${formatDuration(Math.abs(rounded))}`;
}

/** 1234 -> "1.2K", 3400000 -> "3.4M". */
function formatCount(n) {
  if (!Number.isFinite(n)) return null;
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"]
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const value = n / size;
      return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))}${suffix}`;
    }
  }
  return String(n);
}

module.exports = {
  fold,
  tokens,
  hasPhrase,
  significantTokens,
  formatDuration,
  formatOffset,
  formatCount,
  STOPWORDS
};
