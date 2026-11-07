const crypto = require("crypto");

/**
 * The cryptography behind profiles, in one place:
 *
 *   - a password is stretched with scrypt (32 MiB, about a tenth of a second
 *     per guess), from a salt of its own;
 *   - every key is then bound, with HKDF, to the server's SECRET_KEY, to the
 *     profile, and to what it is for, so a copy of the database alone opens
 *     nothing, and a key made for one thing opens nothing else;
 *   - whatever is stored sealed is AES-256-GCM, which also tells a wrong key
 *     from a right one: a password that does not open the profile's key is
 *     a wrong password, with no separate hash kept to check it against.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const SEALED_PREFIX = "v1.";

/** scrypt's cost, as log2(N), r and p: N = 2^15 needs 32 MiB, OWASP's floor. */
const DEFAULT_KDF = { logN: 15, r: 8, p: 1 };

/** "scrypt:15:8:1", stored with each profile so the cost can rise later. */
const formatKdf = ({ logN, r, p }) => `scrypt:${logN}:${r}:${p}`;

function parseKdf(text) {
  const match = /^scrypt:(\d+):(\d+):(\d+)$/.exec(String(text));
  if (!match) throw new Error(`unknown password_kdf "${text}"`);
  return { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
}

/** 32 random bytes as 43 URL-safe characters: an install link's or a cookie's token. */
const newToken = () => crypto.randomBytes(KEY_BYTES).toString("base64url");
const newKey = () => crypto.randomBytes(KEY_BYTES);
const newSalt = () => crypto.randomBytes(SALT_BYTES).toString("base64url");

/** A session's id: the hash of its cookie's token, so the database never holds the token. */
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/**
 * Passwords stretched at once, and waiting to be. Each takes 32 MiB and a
 * thread of the pool Node shares with DNS lookups and files, so a flood of
 * sign-in attempts must neither run the server out of memory nor hold up
 * its lookups of YouTube. Past the queue's end, the answer is "busy".
 */
const MAX_STRETCHING = 2;
const MAX_WAITING = 64;
let stretching = 0;
const waiting = [];

/** Thrown when too many passwords are waiting to be checked. */
class BusyError extends Error {
  constructor() {
    super("too many passwords are being checked at once");
    this.code = "PROFILES_BUSY";
  }
}

/**
 * The password, stretched. Unicode is normalized first, so a password typed
 * on a phone and on a computer reads the same.
 */
function stretchPassword(password, salt, kdf = DEFAULT_KDF) {
  const N = 2 ** kdf.logN;
  return new Promise((resolve, reject) => {
    const done = (err, key) => {
      stretching -= 1;
      if (waiting.length) waiting.shift()();
      if (err) reject(err);
      else resolve(key);
    };
    const run = () => {
      stretching += 1;
      try {
        crypto.scrypt(
          String(password).normalize("NFC"),
          Buffer.from(salt, "base64url"),
          KEY_BYTES,
          { N, r: kdf.r, p: kdf.p, maxmem: 256 * N * kdf.r * kdf.p },
          done
        );
      } catch (err) {
        // Parameters scrypt refuses outright: it throws rather than calls back.
        done(err);
      }
    };
    if (stretching < MAX_STRETCHING) run();
    else if (waiting.length < MAX_WAITING) waiting.push(run);
    else reject(new BusyError());
  });
}

/** A fingerprint of the server's secret, which a database keeps to notice it changing. */
const secretFingerprint = (secret) => crypto.createHmac("sha256", secret).update("youstream profiles").digest("hex");

/**
 * A key for one purpose ("password", "link", "session") of one profile,
 * from material that is strong already (a stretched password, a token).
 */
function bindKey(material, secret, purpose, profileId) {
  return Buffer.from(crypto.hkdfSync("sha256", material, secret, `youstream ${purpose} ${profileId}`, KEY_BYTES));
}

/**
 * Seals `plaintext` (a string or bytes) with `key`. `context` -- which
 * profile, which field -- is authenticated but not stored, so a sealed value
 * moved to another row or field no longer opens.
 */
function seal(key, plaintext, context) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The bytes `seal` sealed, or null when the key or the context is not the one it was sealed with. */
function open(key, sealed, context) {
  if (typeof sealed !== "string" || !sealed.startsWith(SEALED_PREFIX)) return null;
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_KDF,
  formatKdf,
  parseKdf,
  newToken,
  newKey,
  newSalt,
  sha256,
  stretchPassword,
  secretFingerprint,
  BusyError,
  MAX_STRETCHING,
  MAX_WAITING,
  bindKey,
  seal,
  open,
  KEY_BYTES
};
