/**
 * Countries and spoken languages the configure page offers.
 *
 * Countries are the regions YouTube itself lists (i18nRegions), since those
 * are the ones `regionCode` is meaningful for. Names come from the runtime's
 * own locale data rather than a hand-kept table.
 */
const COUNTRY_CODES = [
  "AE", "AR", "AT", "AU", "AZ", "BA", "BD", "BE", "BG", "BH", "BO", "BR", "BY", "CA", "CH", "CL", "CO", "CR",
  "CY", "CZ", "DE", "DK", "DO", "DZ", "EC", "EE", "EG", "ES", "FI", "FR", "GB", "GE", "GH", "GR", "GT", "HK",
  "HN", "HR", "HU", "ID", "IE", "IL", "IN", "IQ", "IS", "IT", "JM", "JO", "JP", "KE", "KH", "KR", "KW", "KZ",
  "LA", "LB", "LI", "LK", "LT", "LU", "LV", "LY", "MA", "ME", "MK", "MT", "MX", "MY", "NG", "NI", "NL", "NO",
  "NP", "NZ", "OM", "PA", "PE", "PG", "PH", "PK", "PL", "PR", "PT", "PY", "QA", "RO", "RS", "RU", "SA", "SE",
  "SG", "SI", "SK", "SN", "SV", "TH", "TN", "TR", "TW", "TZ", "UA", "UG", "US", "UY", "VE", "VN", "YE", "ZA",
  "ZW"
];

/**
 * Languages people commonly watch dubbed or original uploads in. ISO 639-1,
 * which is what YouTube's `relevanceLanguage` and `defaultAudioLanguage` use.
 */
const LANGUAGE_CODES = [
  "en", "hi", "bn", "ta", "te", "ml", "kn", "mr", "gu", "pa", "ur", "ja", "ko", "zh", "es", "pt", "fr", "de",
  "it", "ru", "ar", "tr", "id", "th", "vi", "fil", "nl", "pl"
];

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

const COUNTRIES = COUNTRY_CODES.map((code) => ({ code, label: regionNames.of(code) })).sort((a, b) =>
  a.label.localeCompare(b.label)
);
const LANGUAGES = LANGUAGE_CODES.map((code) => ({ code, label: languageNames.of(code) })).sort((a, b) =>
  a.label.localeCompare(b.label)
);

const COUNTRY_SET = new Set(COUNTRY_CODES);
const LANGUAGE_SET = new Set(LANGUAGE_CODES);

function languageName(code) {
  return LANGUAGE_SET.has(code) ? languageNames.of(code) : "";
}

module.exports = { COUNTRIES, LANGUAGES, COUNTRY_SET, LANGUAGE_SET, languageName };
