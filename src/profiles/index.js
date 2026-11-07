const { openDatabase, describeDatabase } = require("../storage");
const { getBaseUrl } = require("../baseUrl");
const { createProfileStore } = require("./store");
const { createProfileApi } = require("./api");
const { linkMiddleware, installUrl, parseLinkSegment } = require("./links");
const { currentSession, clearSessionCookie } = require("./session");

/**
 * Profiles while the server runs: whether they are on, the database and the
 * store over it, and the chores -- opening the database (again and again,
 * should it be down when YouStream starts), and pruning.
 *
 * The server never waits for the database: links that carry their own
 * settings work from the first second, and while the database cannot be
 * reached, profile links and the profile API say so instead (links.js,
 * api.js).
 */

const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_FIRST_MS = 5 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const state = { status: "off", db: null, store: null, timers: new Set() };

/** "off", "starting", "ready", or "unavailable" while the database cannot be opened. */
const status = () => state.status;
const getStore = () => (state.status === "ready" ? state.store : null);

function later(fn, ms, repeat = false) {
  const timer = (repeat ? setInterval : setTimeout)(fn, ms);
  timer.unref();
  state.timers.add(timer);
  return timer;
}

async function prune(settings, log) {
  try {
    const done = await state.store.prune(settings.pruneAfterMs);
    if (done.profiles || done.sessions) {
      log.log(`[profiles] pruned ${done.profiles} unused profiles and ${done.sessions} expired sign-ins`);
    }
  } catch (err) {
    log.warn(`[profiles] pruning failed: ${err.message}`);
  }
}

/**
 * Turns profiles on, if the host configured them (hostConfig.profiles).
 * Resolves after the first attempt to open the database; a failed attempt
 * is retried in the background, 5 seconds later, then 10, 20... up to every
 * 5 minutes.
 */
async function start(settings, { open = openDatabase, log = console } = {}) {
  if (!settings.enabled) return;
  state.status = "starting";
  const where = describeDatabase(settings.databaseUrl);
  let wait = RETRY_FIRST_MS;
  const attempt = async () => {
    let opened = null;
    try {
      const { db, applied } = await open(settings.databaseUrl);
      opened = db;
      // settings.kdf: scrypt's cost; tests lower it, the host never sets it.
      const store = createProfileStore({ db, secret: settings.secret, sessions: settings.sessions, kdf: settings.kdf });
      if (!(await store.checkSecret())) {
        // Not retried: waiting will not bring the old secret back.
        state.status = "unavailable";
        await db.close();
        log.error(
          `[profiles] SECRET_KEY is not the one the profiles in ${where} were made with, so none of them would open. ` +
            "Profiles stay off until the old SECRET_KEY is restored, or the database is emptied to start over."
        );
        return;
      }
      Object.assign(state, { db, store, status: "ready" });
      log.log(`[profiles] on, kept in ${where}${applied.length ? `; tables set up: ${applied.join(", ")}` : ""}`);
      await prune(settings, log);
      later(() => prune(settings, log), PRUNE_EVERY_MS, true);
    } catch (err) {
      // A database opened but then failing is closed, not left open beside the next attempt's.
      if (opened) await Promise.resolve(opened.close()).catch(() => {});
      state.status = "unavailable";
      log.warn(`[profiles] ${where} could not be opened: ${err.message}; trying again in ${wait / 1000}s`);
      later(attempt, wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  };
  await attempt();
}

/** Stops the chores and closes the database (tests, shutdown). */
async function stop() {
  state.timers.forEach((timer) => clearTimeout(timer));
  state.timers.clear();
  const { db } = state;
  Object.assign(state, { status: "off", db: null, store: null });
  if (db) await db.close();
}

/**
 * What the configure page needs to know about profiles for this request:
 *
 *   enabled      whether this server has profiles at all
 *   unavailable  they are on, but the database cannot be reached now
 *   signedIn     { id, installUrl, remembered, config }, or null
 *   link         for a page opened from an install link: { id, works }
 */
async function pageState(req, res, linkSegment = null) {
  if (state.status === "off") return { enabled: false, unavailable: false, signedIn: null, link: null };
  const store = getStore();
  if (!store) return { enabled: true, unavailable: true, signedIn: null, link: null };
  try {
    let signedIn = null;
    const session = await currentSession(req, res, store);
    if (session) {
      const profile = await store.read(session.id, session.access);
      if (profile) {
        signedIn = {
          id: session.id,
          installUrl: installUrl(getBaseUrl(req), session.id, profile.linkToken),
          remembered: session.remembered,
          config: profile.config
        };
      } else {
        await store.endSession(session.token);
        clearSessionCookie(req, res);
      }
    }
    const parsed = linkSegment && parseLinkSegment(linkSegment);
    const link = parsed ? { id: parsed.id, works: Boolean(await store.resolveLink(parsed.id, parsed.token)) } : null;
    return { enabled: true, unavailable: false, signedIn, link };
  } catch (err) {
    console.warn(`[profiles] the configure page could not read profiles: ${err.message}`);
    return { enabled: true, unavailable: true, signedIn: null, link: null };
  }
}

const api = createProfileApi({ getStore, getStatus: status });

module.exports = {
  start,
  stop,
  status,
  getStore,
  pageState,
  apiRouter: api.router,
  limits: api.limits,
  links: linkMiddleware({ getStore, isOff: () => state.status === "off" }),
  parseLinkSegment,
  PRUNE_EVERY_MS,
  RETRY_FIRST_MS,
  RETRY_MAX_MS
};
