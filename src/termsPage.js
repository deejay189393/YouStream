const { escapeHtml, REPO_URL } = require("./configurePage");

/**
 * The terms of use and privacy policy, at /terms.
 *
 * YouTube's API Services policies ask every API client to link YouTube's
 * Terms of Service, to tell users they are bound by them, and to have a
 * privacy policy that links Google's and that users agree to before using
 * it (Developer Policies III.A). The configure page asks for that agreement
 * before it builds an install link.
 */
const YOUTUBE_TERMS_URL = "https://www.youtube.com/t/terms";
const GOOGLE_PRIVACY_URL = "https://policies.google.com/privacy";
const YOUTUBE_COPYRIGHT_URL = "https://support.google.com/youtube/answer/2807622";
const GOOGLE_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const UPDATED = "12 October 2026";

/** A contact as a link: an email address becomes mailto:, anything else is a URL. */
function contactLink(contact) {
  const href = /^[^\s@/:]+@[^\s@/]+$/.test(contact) ? `mailto:${contact}` : contact;
  return `<a href="${escapeHtml(href)}">${escapeHtml(contact)}</a>`;
}

function creditItem(c) {
  const image = c.image ? `<img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.imageAlt || "")}" height="12" /> ` : "";
  return `<li>${image}<a href="${escapeHtml(c.href)}" target="_blank" rel="noopener">${escapeHtml(c.text)}</a></li>`;
}

/**
 * @param {object} p
 * @param {string} p.contact   from CONTACT: an email address or a URL
 * @param {Array<{ text, href, image?, imageAlt? }>} p.credits
 */
function renderTermsPage({ contact, credits }) {
  const a = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>YouStream: terms of use and privacy</title>
<link rel="icon" href="/logo.png" />
<style>
  :root { color-scheme: dark; --bg: #0c0d10; --card: #16171d; --text: #eef0f4; --muted: #9ea3ae; --link: #e29aa7; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 18px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  p, li { color: var(--text); }
  .muted { color: var(--muted); font-size: 13px; }
  a { color: var(--link); }
  ul { padding-left: 20px; }
  .credits li { margin: 4px 0; }
  .credits img { vertical-align: middle; margin-right: 4px; }
  .back { display: inline-block; margin-top: 28px; }
</style>
</head>
<body>
<main>
  <h1>YouStream: terms of use and privacy</h1>
  <p class="muted">Last updated ${UPDATED}.</p>

  <h2>What YouStream is</h2>
  <p>YouStream is an addon for Stremio and Nuvio. When you open a film or an episode, it searches YouTube for a full upload of it, using YouTube API Services with your own YouTube Data API key, and returns links to the YouTube videos it finds: their YouTube ids and youtube.com addresses.</p>
  <p>YouStream does not host, store, download, copy, proxy or modify any video. Every video it lists is hosted by YouTube, played from YouTube, and subject to YouTube's own rules and takedowns.</p>

  <h2>Terms of use</h2>
  <ul>
    <li><strong>By using YouStream you agree to be bound by the ${a(YOUTUBE_TERMS_URL, "YouTube Terms of Service")}.</strong> YouStream uses YouTube API Services.</li>
    <li>Your API keys are yours: their quota, their limits, and keeping them private. Your install link contains them; do not share it. You can delete or restrict a key at any time in the ${a(GOOGLE_CREDENTIALS_URL, "Google Cloud console")}.</li>
    <li>YouStream is free, provided as is, without any warranty. The code is open source under the ${a(`${REPO_URL}/blob/main/LICENSE`, "MIT licence")}.</li>
    <li>YouTube is a trademark of Google LLC. YouStream is an independent project, not affiliated with or endorsed by YouTube, Google, Stremio or Nuvio. Other names are trademarks of their owners.</li>
  </ul>

  <h2>Privacy policy</h2>
  <ul>
    <li>YouStream has no accounts, sets no cookies and does not track you.</li>
    <li>Your settings and keys are encoded into your personal install link. YouStream does not store them, but your app sends that link with every request, so the hosting provider's request logs record it for a limited time.</li>
    <li>Searches and video details are requested from YouTube with your key, so Google receives them under the ${a(GOOGLE_PRIVACY_URL, "Google Privacy Policy")}. Search results are cached on this server for at most 30 days and shared by everyone who uses it, with nothing that identifies who asked.</li>
    <li>Film and episode details are looked up in Cinemeta, IMDb's published data, TheTVDB, TVmaze, TMDB and Kitsu. Those requests carry nothing about you, except your TMDB key if you add one.</li>
    <li>YouStream keeps nothing that identifies you, so there is nothing of yours to delete. Questions: ${contactLink(contact)}.</li>
  </ul>

  <h2>Rights holders</h2>
  <p>YouStream only links to videos hosted on YouTube. To have a video or a channel no longer offered by this server, send its YouTube link to ${contactLink(contact)} and it will be blocked here. To have it removed from YouTube itself, and so from everywhere, use ${a(YOUTUBE_COPYRIGHT_URL, "YouTube's copyright removal process")}.</p>

  <h2>Data sources</h2>
  <ul class="credits">
    ${credits.map(creditItem).join("\n    ")}
    <li><a href="https://www.stremio.com" target="_blank" rel="noopener">Titles and episode lists from Cinemeta</a></li>
    <li><a href="https://kitsu.io" target="_blank" rel="noopener">Anime from Kitsu</a></li>
  </ul>

  <a class="back" href="/configure">&larr; Back to setup</a>
</main>
</body>
</html>`;
}

module.exports = { renderTermsPage, contactLink, YOUTUBE_TERMS_URL, GOOGLE_PRIVACY_URL, YOUTUBE_COPYRIGHT_URL };
