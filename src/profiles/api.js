const express = require("express");
const { normalizeConfig, compactConfig } = require("../config");
const { buildManifest } = require("../manifest");
const { getBaseUrl } = require("../baseUrl");
const { createLimiter } = require("./rateLimit");
const { installUrl, forget, PROFILE_ID_PATTERN } = require("./links");
const { readSessionCookie, setSessionCookie, clearSessionCookie, currentSession } = require("./session");

/**
 * The profile API, under /api/profile, for the configure page:
 *
 *   POST   /            create a profile: { config, password, remember }
 *   GET    /            the signed-in profile: its settings and install link
 *   PUT    /            save the signed-in profile's settings: { config }
 *   DELETE /            delete a profile: { password } (and { id } when not
 *                       signed in to it)
 *   POST   /session     sign in: { id, password, remember }
 *   DELETE /session     sign this browser out
 *   DELETE /sessions    sign every browser out of the signed-in profile
 *   POST   /password    change the password: { currentPassword, newPassword }
 *   POST   /link        replace the install link: { password }
 *
 * Reading and saving take the sign-in cookie. Changing the password,
 * replacing the link and deleting the profile take the password itself, as
 * AIOStreams does, so a cookie copied off a device cannot lock the owner out
 * or break their installs.
 *
 * Refused: requests from another site (their Origin or Sec-Fetch-Site says
 * so), and too many of them -- 120 a minute from one client, 10 new
 * profiles an hour, and after 10 wrong passwords from one client, or 20 for
 * one profile, a 15-minute wait.
 */

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
const MINUTE_MS = 60 * 1000;

class ApiError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const tooMany = (seconds) =>
  new ApiError(429, `Too many tries. Wait ${seconds < 120 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`} and try again.`, seconds);
const wrongPassword = () => new ApiError(401, "That profile ID and password don't match.");
const short = (id) => id.slice(0, 8);

/** The pieces of a manifest an app keeps until it reads it again: its rows and what it answers for. */
function manifestShape(config) {
  const { types, catalogs, resources, idPrefixes } = buildManifest(config, "");
  return JSON.stringify({ types, catalogs, resources, idPrefixes });
}

/** A password to set: checked for length, never for anything else. */
function newPasswordFrom(value) {
  if (typeof value !== "string" || value.length < PASSWORD_MIN) {
    throw new ApiError(400, `Use a password of at least ${PASSWORD_MIN} characters.`);
  }
  if (value.length > PASSWORD_MAX) throw new ApiError(400, `Use a password of at most ${PASSWORD_MAX} characters.`);
  return value;
}

/** Settings as the install link would carry them: normalized, defaults left out. */
function configFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "No settings were sent.");
  const settings = normalizeConfig(value);
  if (!settings.youtubeKey) throw new ApiError(400, "Enter your YouTube API key.");
  return compactConfig(settings);
}

function idFrom(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new ApiError(400, "A profile ID looks like 1b4e28ba-2fa1-41d2-883f-0016d3cca427: it is in your install link, before the dot.");
  }
  return id;
}

/**
 * @param {function} getStore   the profile store, or null while there is none
 * @param {function} getStatus  "off", "starting", "ready" or "unavailable"
 */
function createProfileApi({ getStore, getStatus, now = Date.now, log = console }) {
  const limits = {
    requests: createLimiter({ windowMs: MINUTE_MS, max: 120, now }),
    creates: createLimiter({ windowMs: 60 * MINUTE_MS, max: 10, now }),
    clientFailures: createLimiter({ windowMs: 15 * MINUTE_MS, max: 10, now }),
    profileFailures: createLimiter({ windowMs: 15 * MINUTE_MS, max: 20, now })
  };
  const router = express.Router();
  const handle = (fn) => (req, res, next) => fn(req, res).catch(next);
  let forwardingNoted = false;

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Once: how many addresses the proxies in front pass on, never which,
    // so a host can tell whether TRUST_PROXY names the client right.
    if (!forwardingNoted) {
      forwardingNoted = true;
      const listed = String(req.get("x-forwarded-for") || "").split(",").filter((part) => part.trim()).length;
      log.log(`[profiles] requests arrive with ${listed} address(es) in X-Forwarded-For; the limits count the one TRUST_PROXY points to`);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const site = req.get("sec-fetch-site");
      const origin = req.get("origin");
      if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== getBaseUrl(req))) {
        return next(new ApiError(403, "Requests from other sites are refused."));
      }
    }
    const wait = limits.requests.take(req.ip);
    if (wait) return next(tooMany(wait));
    const status = getStatus();
    if (status === "off") return next(new ApiError(404, "Profiles are not available on this server."));
    if (status !== "ready") {
      return next(new ApiError(503, "Profiles are unavailable right now: YouStream cannot reach its database. Try again in a minute."));
    }
    req.store = getStore();
    next();
  });
  router.use(express.json({ limit: "64kb" }));

  /** The signed-in profile, or a 401 that also clears a dead cookie. */
  async function signedIn(req, res) {
    const session = await currentSession(req, res, req.store, now());
    if (!session) throw new ApiError(401, "You're signed out. Sign in again.");
    return session;
  }

  /** The signed-in profile's settings; a sign-in they no longer open is ended. */
  async function readSignedIn(req, res, session) {
    const profile = await req.store.read(session.id, session.access);
    if (profile) return profile;
    await req.store.endSession(session.token);
    clearSessionCookie(req, res);
    throw new ApiError(401, "You're signed out. Sign in again.");
  }

  /** The profile a password-confirmed request is about: the one named, else the one signed in. */
  async function subjectOf(req, res) {
    const session = await currentSession(req, res, req.store, now());
    if (req.body.id !== undefined) return { id: idFrom(req.body.id), session };
    if (!session) throw new ApiError(401, "Sign in first, or give your profile ID.");
    return { id: session.id, session };
  }

  /** The profile's access, if the password is right; wrong passwords are counted per client and per profile. */
  async function checkPassword(req, id, password) {
    if (typeof password !== "string" || !password) throw new ApiError(400, "Enter your password.");
    const wait = Math.max(limits.clientFailures.blocked(req.ip), limits.profileFailures.blocked(id));
    if (wait) throw tooMany(wait);
    const access = password.length <= PASSWORD_MAX ? await req.store.verify(id, password) : null;
    if (!access) {
      limits.clientFailures.hit(req.ip);
      limits.profileFailures.hit(id);
      throw wrongPassword();
    }
    return access;
  }

  async function startSession(req, res, id, access, remembered) {
    const session = await req.store.openSession(id, access, remembered);
    setSessionCookie(req, res, session, now());
    return session;
  }

  router.post(
    "/",
    handle(async (req, res) => {
      const wait = limits.creates.blocked(req.ip);
      if (wait) throw tooMany(wait);
      const password = newPasswordFrom(req.body.password);
      const config = configFrom(req.body.config);
      limits.creates.hit(req.ip);
      const { id, linkToken, access } = await req.store.create(config, password);
      const previous = readSessionCookie(req);
      if (previous) await req.store.endSession(previous);
      const session = await startSession(req, res, id, access, req.body.remember !== false);
      log.log(`[profiles] created ${short(id)}`);
      res.status(201).json({ id, installUrl: installUrl(getBaseUrl(req), id, linkToken), remembered: session.remembered, expiresAt: session.expiresAt });
    })
  );

  router.get(
    "/",
    handle(async (req, res) => {
      const session = await signedIn(req, res);
      const profile = await readSignedIn(req, res, session);
      res.json({
        id: session.id,
        installUrl: installUrl(getBaseUrl(req), session.id, profile.linkToken),
        config: profile.config,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        remembered: session.remembered,
        expiresAt: session.expiresAt
      });
    })
  );

  router.put(
    "/",
    handle(async (req, res) => {
      const session = await signedIn(req, res);
      const config = configFrom(req.body.config);
      const before = await readSignedIn(req, res, session);
      if (!(await req.store.save(session.id, session.access, config))) {
        throw new ApiError(409, "Your profile changed on another device. Reload the page and try again.");
      }
      forget(session.id);
      res.json({ saved: true, manifestChanged: manifestShape(before.config) !== manifestShape(config) });
    })
  );

  router.delete(
    "/",
    handle(async (req, res) => {
      const { id, session } = await subjectOf(req, res);
      await checkPassword(req, id, req.body.password);
      await req.store.remove(id);
      forget(id);
      if (session && session.id === id) clearSessionCookie(req, res);
      log.log(`[profiles] deleted ${short(id)}`);
      res.status(204).end();
    })
  );

  router.post(
    "/session",
    handle(async (req, res) => {
      const id = idFrom(req.body.id);
      const access = await checkPassword(req, id, req.body.password);
      const previous = readSessionCookie(req);
      if (previous) await req.store.endSession(previous);
      const session = await startSession(req, res, id, access, req.body.remember !== false);
      res.json({ id, remembered: session.remembered, expiresAt: session.expiresAt });
    })
  );

  router.delete(
    "/session",
    handle(async (req, res) => {
      const token = readSessionCookie(req);
      if (token) await req.store.endSession(token);
      clearSessionCookie(req, res);
      res.status(204).end();
    })
  );

  router.delete(
    "/sessions",
    handle(async (req, res) => {
      const session = await signedIn(req, res);
      const count = await req.store.endAllSessions(session.id);
      clearSessionCookie(req, res);
      res.json({ signedOut: count });
    })
  );

  router.post(
    "/password",
    handle(async (req, res) => {
      const { id, session } = await subjectOf(req, res);
      const newPassword = newPasswordFrom(req.body.newPassword);
      const access = await checkPassword(req, id, req.body.currentPassword);
      if (newPassword === req.body.currentPassword) throw new ApiError(400, "That's the password you have now. Choose another.");
      const renewed = await req.store.changePassword(id, access, newPassword);
      if (!renewed) throw new ApiError(409, "Your profile changed on another device. Reload the page and try again.");
      // Every sign-in ended with the old key; this browser signs in again.
      if (session && session.id === id) await startSession(req, res, id, renewed, session.remembered);
      log.log(`[profiles] password changed for ${short(id)}`);
      res.json({ changed: true });
    })
  );

  router.post(
    "/link",
    handle(async (req, res) => {
      const { id } = await subjectOf(req, res);
      const access = await checkPassword(req, id, req.body.password);
      const linkToken = await req.store.replaceLink(id, access);
      if (!linkToken) throw new ApiError(409, "Your profile changed on another device. Reload the page and try again.");
      forget(id);
      log.log(`[profiles] install link replaced for ${short(id)}`);
      res.json({ installUrl: installUrl(getBaseUrl(req), id, linkToken) });
    })
  );

  // eslint-disable-next-line no-unused-vars -- Express tells error handlers by their four parameters
  router.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === "PROFILES_BUSY") {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: "YouStream is busy checking passwords. Try again in a few seconds." });
    }
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "That request was not valid JSON." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Those settings are larger than YouStream keeps." });
    log.warn(`[profiles] ${req.method} /api/profile${req.path} failed: ${err.message}`);
    res.status(500).json({ error: "Something went wrong on YouStream's side. Try again in a minute." });
  });

  return { router, limits };
}

module.exports = { createProfileApi, PASSWORD_MIN, PASSWORD_MAX };
