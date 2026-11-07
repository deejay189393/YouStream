const crypto = require("crypto");
const {
  DEFAULT_KDF,
  formatKdf,
  parseKdf,
  newToken,
  newKey,
  newSalt,
  sha256,
  stretchPassword,
  secretFingerprint,
  bindKey,
  seal,
  open
} = require("./crypto");

/**
 * Profiles: a reader's settings kept on the server behind a password, so
 * their install link stays the same however often the settings change.
 *
 * Each profile has a random key of its own, and everything about it is
 * sealed with that key: the settings, and the install link's token. The key
 * itself is stored only sealed, twice:
 *
 *   key_by_password  opened by the password -- to edit the settings
 *   key_by_link      opened by the install link's token -- to serve the
 *                    app, which reads the settings and never shows them
 *
 * and once per remembered sign-in, opened by the cookie's token. Every one
 * of those is also bound to the server's SECRET_KEY. So the database alone
 * opens nothing; the install link opens the settings for the addon's use
 * but is refused by everything that shows or changes them; and only the
 * password, or a sign-in made with it, can do that.
 *
 * `access` below is the opened key and the version it belongs to. The key
 * is replaced when the password changes, which also ends every sign-in, and
 * a write made with an older version than the row's is refused: it raced a
 * password change and lost.
 */

/** A remembered sign-in's last use, and its expiry, move at most hourly. */
const SESSION_TOUCH_MS = 60 * 60 * 1000;
/** A profile's last use, which pruning goes by, moves at most hourly. */
const LINK_TOUCH_MS = 60 * 60 * 1000;
/** Sign-ins a profile keeps; a new one past this ends the longest unused. */
const MAX_SESSIONS = 20;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** What a password is checked against for a profile that does not exist, so the answer takes as long. */
const ABSENT_SALT = newSalt();

const FIELDS = {
  keyByPassword: (id) => `${id}/key-by-password`,
  keyByLink: (id) => `${id}/key-by-link`,
  linkToken: (id) => `${id}/link-token`,
  config: (id) => `${id}/config`,
  sessionKey: (sessionId) => `${sessionId}/profile-key`
};

/**
 * @param {object} p
 * @param {object} p.db           a storage driver (storage/index.js)
 * @param {Buffer} p.secret       the server's SECRET_KEY
 * @param {object} p.sessions     { rememberedMs, maxMs, browserMs }: how long
 *                                a remembered sign-in lasts unused, at most in
 *                                all, and how long one that is not remembered
 * @param {object} [p.kdf]        scrypt's cost for new passwords
 * @param {function} [p.now]
 */
function createProfileStore({ db, secret, sessions, kdf = DEFAULT_KDF, now = Date.now }) {
  const linkKey = (id, token) => bindKey(Buffer.from(token), secret, "link", id);
  const sessionKey = (id, token) => bindKey(Buffer.from(token), secret, "session", id);
  const passwordKey = (id, stretched) => bindKey(stretched, secret, "password", id);
  const text = (buffer) => buffer.toString("utf8");

  /** Creates a profile. The password has been checked for length already. */
  async function create(config, password) {
    const id = crypto.randomUUID();
    const key = newKey();
    const linkToken = newToken();
    const salt = newSalt();
    const stretched = await stretchPassword(password, salt, kdf);
    const t = now();
    await db.run(
      `INSERT INTO profiles (id, password_salt, password_kdf, key_by_password, key_by_link, link_token, config,
         key_version, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        salt,
        formatKdf(kdf),
        seal(passwordKey(id, stretched), key, FIELDS.keyByPassword(id)),
        seal(linkKey(id, linkToken), key, FIELDS.keyByLink(id)),
        seal(key, linkToken, FIELDS.linkToken(id)),
        seal(key, JSON.stringify(config), FIELDS.config(id)),
        t,
        t,
        t
      ]
    );
    return { id, linkToken, access: { key, version: 1 } };
  }

  /** The profile's access if the password is its password, else null: no such profile looks the same. */
  async function verify(id, password) {
    const row = await db.get("SELECT password_salt, password_kdf, key_by_password, key_version FROM profiles WHERE id = ?", [id]);
    if (!row) {
      await stretchPassword(password, ABSENT_SALT, kdf);
      return null;
    }
    const stretched = await stretchPassword(password, row.password_salt, parseKdf(row.password_kdf));
    const key = open(passwordKey(id, stretched), row.key_by_password, FIELDS.keyByPassword(id));
    return key ? { key, version: row.key_version } : null;
  }

  /** The settings and the install link's token, or null when the access is out of date. */
  async function read(id, access) {
    const row = await db.get("SELECT link_token, config, key_version, created_at, updated_at FROM profiles WHERE id = ?", [id]);
    if (!row || row.key_version !== access.version) return null;
    const config = open(access.key, row.config, FIELDS.config(id));
    const linkToken = open(access.key, row.link_token, FIELDS.linkToken(id));
    if (!config || !linkToken) return null;
    return { config: JSON.parse(text(config)), linkToken: text(linkToken), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  /** Replaces the settings. False when the profile is gone or the access is out of date. */
  async function save(id, access, config) {
    const t = now();
    const { changes } = await db.run(
      "UPDATE profiles SET config = ?, updated_at = ?, last_used_at = ? WHERE id = ? AND key_version = ?",
      [seal(access.key, JSON.stringify(config), FIELDS.config(id)), t, t, id, access.version]
    );
    return changes === 1;
  }

  /**
   * Sets a new password, under a new key, and ends every sign-in. The
   * install link stays the same. The new access, or null when the profile
   * is gone or the access is out of date.
   */
  async function changePassword(id, access, newPassword) {
    const salt = newSalt();
    const stretched = await stretchPassword(newPassword, salt, kdf);
    return db.transaction(async (tx) => {
      const row = await tx.get("SELECT link_token, config, key_version FROM profiles WHERE id = ?", [id]);
      if (!row || row.key_version !== access.version) return null;
      const linkToken = open(access.key, row.link_token, FIELDS.linkToken(id));
      const config = open(access.key, row.config, FIELDS.config(id));
      if (!linkToken || !config) return null;
      const key = newKey();
      const version = row.key_version + 1;
      await tx.run(
        `UPDATE profiles SET password_salt = ?, password_kdf = ?, key_by_password = ?, key_by_link = ?, link_token = ?,
           config = ?, key_version = ?, updated_at = ? WHERE id = ?`,
        [
          salt,
          formatKdf(kdf),
          seal(passwordKey(id, stretched), key, FIELDS.keyByPassword(id)),
          seal(linkKey(id, text(linkToken)), key, FIELDS.keyByLink(id)),
          seal(key, linkToken, FIELDS.linkToken(id)),
          seal(key, config, FIELDS.config(id)),
          version,
          now(),
          id
        ]
      );
      await tx.run("DELETE FROM profile_sessions WHERE profile_id = ?", [id]);
      return { key, version };
    });
  }

  /** A new install link token; the old link stops working at once. Null as for save. */
  async function replaceLink(id, access) {
    const linkToken = newToken();
    const { changes } = await db.run(
      "UPDATE profiles SET key_by_link = ?, link_token = ?, updated_at = ? WHERE id = ? AND key_version = ?",
      [seal(linkKey(id, linkToken), access.key, FIELDS.keyByLink(id)), seal(access.key, linkToken, FIELDS.linkToken(id)), now(), id, access.version]
    );
    return changes === 1 ? linkToken : null;
  }

  /** Deletes the profile and its sign-ins. False when there was none. */
  async function remove(id) {
    return db.transaction(async (tx) => {
      await tx.run("DELETE FROM profile_sessions WHERE profile_id = ?", [id]);
      return (await tx.run("DELETE FROM profiles WHERE id = ?", [id])).changes === 1;
    });
  }

  /**
   * The settings an install link opens, or null. Never shown to anyone:
   * the addon reads them to answer the app.
   */
  async function resolveLink(id, linkToken) {
    if (!TOKEN.test(linkToken)) return null;
    const row = await db.get("SELECT key_by_link, config, last_used_at FROM profiles WHERE id = ?", [id]);
    if (!row) return null;
    const key = open(linkKey(id, linkToken), row.key_by_link, FIELDS.keyByLink(id));
    const config = key && open(key, row.config, FIELDS.config(id));
    if (!config) return null;
    const t = now();
    if (t - row.last_used_at >= LINK_TOUCH_MS) await db.run("UPDATE profiles SET last_used_at = ? WHERE id = ?", [t, id]);
    return JSON.parse(text(config));
  }

  /** Signs a browser in: the token for its cookie, which the database never holds. */
  async function openSession(id, access, remembered) {
    const token = newToken();
    const sessionId = sha256(token);
    const t = now();
    const expiresAt = remembered ? t + Math.min(sessions.rememberedMs, sessions.maxMs) : t + sessions.browserMs;
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO profile_sessions (id, profile_id, profile_key, key_version, remembered, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, id, seal(sessionKey(id, token), access.key, FIELDS.sessionKey(sessionId)), access.version, remembered, t, t, expiresAt]
      );
      await tx.run(
        `DELETE FROM profile_sessions WHERE profile_id = ? AND id NOT IN
           (SELECT id FROM profile_sessions WHERE profile_id = ? ORDER BY last_used_at DESC, created_at DESC LIMIT ?)`,
        [id, id, MAX_SESSIONS]
      );
    });
    return { token, remembered, expiresAt };
  }

  /**
   * The sign-in a cookie's token stands for, or null -- and a sign-in that
   * has expired, or outlived its key, is deleted. A remembered one in use
   * is pushed out again, never past its first day plus maxMs: `renewed`
   * says the cookie should be set again with the new expiry.
   */
  async function resolveSession(token) {
    if (!TOKEN.test(String(token))) return null;
    const sessionId = sha256(token);
    const row = await db.get(
      `SELECT s.profile_id, s.profile_key, s.key_version, s.remembered, s.created_at, s.last_used_at, s.expires_at,
              p.key_version AS current_version
         FROM profile_sessions s JOIN profiles p ON p.id = s.profile_id
        WHERE s.id = ?`,
      [sessionId]
    );
    if (!row) return null;
    const t = now();
    const key =
      row.expires_at > t && row.key_version === row.current_version
        ? open(sessionKey(row.profile_id, token), row.profile_key, FIELDS.sessionKey(sessionId))
        : null;
    if (!key) {
      await db.run("DELETE FROM profile_sessions WHERE id = ?", [sessionId]);
      return null;
    }
    const remembered = row.remembered === 1;
    let expiresAt = row.expires_at;
    let renewed = false;
    if (t - row.last_used_at >= SESSION_TOUCH_MS) {
      if (remembered) {
        expiresAt = Math.min(t + sessions.rememberedMs, row.created_at + sessions.maxMs);
        renewed = true;
      }
      await db.run("UPDATE profile_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?", [t, expiresAt, sessionId]);
    }
    return { id: row.profile_id, access: { key, version: row.key_version }, remembered, expiresAt, renewed };
  }

  /** Signs this browser out. */
  async function endSession(token) {
    if (!TOKEN.test(String(token))) return;
    await db.run("DELETE FROM profile_sessions WHERE id = ?", [sha256(token)]);
  }

  /** Signs every browser out of the profile; how many were signed in. */
  async function endAllSessions(id) {
    return (await db.run("DELETE FROM profile_sessions WHERE profile_id = ?", [id])).changes;
  }

  /**
   * Whether the database's profiles were sealed with this server's secret.
   * A new database takes it on; one sealed with another secret is refused,
   * as every profile in it would fail to open.
   */
  async function checkSecret() {
    const mine = secretFingerprint(secret);
    const row = await db.get("SELECT value FROM profile_store WHERE name = 'secret'");
    if (row) return row.value === mine;
    await db.run("INSERT INTO profile_store (name, value) VALUES ('secret', ?)", [mine]);
    return true;
  }

  /**
   * Deletes expired sign-ins, and profiles unused for `unusedMs` (none when
   * it is 0). Use is an app asking with the install link, a sign-in or a save.
   */
  async function prune(unusedMs) {
    const t = now();
    const expired = (await db.run("DELETE FROM profile_sessions WHERE expires_at <= ?", [t])).changes;
    const unused = unusedMs > 0 ? (await db.run("DELETE FROM profiles WHERE last_used_at < ?", [t - unusedMs])).changes : 0;
    return { sessions: expired, profiles: unused };
  }

  return {
    create,
    verify,
    read,
    save,
    changePassword,
    replaceLink,
    remove,
    resolveLink,
    openSession,
    resolveSession,
    endSession,
    endAllSessions,
    checkSecret,
    prune
  };
}

module.exports = { createProfileStore, MAX_SESSIONS, SESSION_TOUCH_MS, LINK_TOUCH_MS };
