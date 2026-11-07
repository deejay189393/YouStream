const { isHttps } = require("../baseUrl");

/**
 * The sign-in cookie. It holds a random token and nothing else; the server
 * keeps only the token's hash (store.js). HttpOnly, so no script on a page
 * can read it; SameSite=Lax, so no other site's form or script carries it
 * along; Secure over HTTPS. A remembered sign-in's cookie lasts as long as
 * the sign-in does; one that is not remembered goes when the browser closes.
 */
const COOKIE = "youstream_session";

function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

const cookieOptions = (req) => ({ httpOnly: true, sameSite: "lax", path: "/", secure: isHttps(req) });

/**
 * @param session  { token, remembered, expiresAt }
 * @param now      the clock the sign-in's expiry was set by
 */
function setSessionCookie(req, res, session, now) {
  res.cookie(COOKIE, session.token, {
    ...cookieOptions(req),
    ...(session.remembered ? { maxAge: Math.max(0, session.expiresAt - now) } : {})
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, cookieOptions(req));
}

/**
 * The sign-in this request's cookie stands for, or null. A cookie that no
 * longer stands for one is cleared; a remembered sign-in pushed out is set
 * again with its new expiry.
 */
async function currentSession(req, res, store, now = Date.now()) {
  const token = readSessionCookie(req);
  if (!token) return null;
  const session = await store.resolveSession(token);
  if (!session) {
    clearSessionCookie(req, res);
    return null;
  }
  if (session.renewed) setSessionCookie(req, res, { token, remembered: true, expiresAt: session.expiresAt }, now);
  return { ...session, token };
}

module.exports = { COOKIE, readSessionCookie, setSessionCookie, clearSessionCookie, currentSession };
