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
  BusyError,
  MAX_STRETCHING,
  MAX_WAITING,
  bindKey,
  seal,
  open
} = require("../src/profiles/crypto");
const { createLimiter, SWEEP_AT } = require("../src/profiles/rateLimit");

/** Cheap scrypt, for tests that are not about its cost. */
const FAST = { logN: 4, r: 8, p: 1 };

describe("password stretching", () => {
  test("scrypt at 2^15, 8, 1 by default, written down so it can rise later", () => {
    expect(DEFAULT_KDF).toEqual({ logN: 15, r: 8, p: 1 });
    expect(formatKdf(DEFAULT_KDF)).toBe("scrypt:15:8:1");
    expect(parseKdf("scrypt:16:8:2")).toEqual({ logN: 16, r: 8, p: 2 });
    expect(() => parseKdf("bcrypt:10")).toThrow('unknown password_kdf "bcrypt:10"');
  });

  test("the same password and salt give the same key; a different salt or password does not", async () => {
    const salt = newSalt();
    const a = await stretchPassword("correct horse", salt, FAST);
    expect(a).toHaveLength(32);
    expect((await stretchPassword("correct horse", salt, FAST)).equals(a)).toBe(true);
    expect((await stretchPassword("correct horse", newSalt(), FAST)).equals(a)).toBe(false);
    expect((await stretchPassword("correct horsf", salt, FAST)).equals(a)).toBe(false);
  });

  test("the default cost runs (it is what a real profile uses)", async () => {
    expect(await stretchPassword("correct horse", newSalt())).toHaveLength(32);
  });

  test("a password typed with a composed or a decomposed accent is the same password", async () => {
    const salt = newSalt();
    const composed = await stretchPassword("café-password", salt, FAST);
    const decomposed = await stretchPassword("café-password", salt, FAST);
    expect(composed.equals(decomposed)).toBe(true);
  });

  test("an impossible cost is an error, not a hang", async () => {
    await expect(stretchPassword("x", newSalt(), { logN: 0, r: 8, p: 1 })).rejects.toThrow();
  });

  test(`at most ${MAX_STRETCHING} at once, ${MAX_WAITING} more waiting, and then: busy`, async () => {
    const spy = jest.spyOn(crypto, "scrypt");
    const all = [];
    for (let i = 0; i < MAX_STRETCHING + MAX_WAITING + 1; i++) all.push(stretchPassword(`pw${i}`, newSalt(), FAST));
    // Started at once: only the first few; the rest wait their turn.
    expect(spy).toHaveBeenCalledTimes(MAX_STRETCHING);
    const settled = await Promise.allSettled(all);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(MAX_STRETCHING + MAX_WAITING);
    const busy = settled.find((s) => s.status === "rejected").reason;
    expect(busy).toBeInstanceOf(BusyError);
    expect(busy.code).toBe("PROFILES_BUSY");
    expect(spy).toHaveBeenCalledTimes(MAX_STRETCHING + MAX_WAITING);
    spy.mockRestore();
  });
});

describe("keys, tokens and sealing", () => {
  test("tokens are 43 URL-safe characters; keys 32 bytes; salts 16", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
    expect(newKey()).toHaveLength(32);
    expect(Buffer.from(newSalt(), "base64url")).toHaveLength(16);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("a bound key depends on the material, the secret, the purpose and the profile", () => {
    const secret = newKey();
    const material = newKey();
    const key = bindKey(material, secret, "link", "p1");
    expect(key).toHaveLength(32);
    expect(bindKey(material, secret, "link", "p1").equals(key)).toBe(true);
    expect(bindKey(material, newKey(), "link", "p1").equals(key)).toBe(false);
    expect(bindKey(material, secret, "session", "p1").equals(key)).toBe(false);
    expect(bindKey(material, secret, "link", "p2").equals(key)).toBe(false);
    expect(bindKey(newKey(), secret, "link", "p1").equals(key)).toBe(false);
  });

  test("the secret's fingerprint is stable and says nothing of the secret", () => {
    const secret = Buffer.alloc(32, 7);
    expect(secretFingerprint(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(secretFingerprint(secret)).toBe(secretFingerprint(Buffer.alloc(32, 7)));
    expect(secretFingerprint(Buffer.alloc(32, 8))).not.toBe(secretFingerprint(secret));
  });

  test("sealed values open with the same key and context only", () => {
    const key = newKey();
    const sealed = seal(key, "the settings", "p1/config");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("settings");
    expect(seal(key, "the settings", "p1/config")).not.toBe(sealed);
    expect(open(key, sealed, "p1/config").toString()).toBe("the settings");
    expect(open(newKey(), sealed, "p1/config")).toBeNull();
    expect(open(key, sealed, "p2/config")).toBeNull();
    expect(open(key, seal(key, Buffer.from([1, 2, 3]), "bytes"), "bytes")).toEqual(Buffer.from([1, 2, 3]));
  });

  test("anything not sealed, cut short or tampered with opens to nothing", () => {
    const key = newKey();
    const sealed = seal(key, "the settings", "ctx");
    expect(open(key, null, "ctx")).toBeNull();
    expect(open(key, "plain text", "ctx")).toBeNull();
    expect(open(key, "v1.AAAA", "ctx")).toBeNull();
    const raw = Buffer.from(sealed.slice(3), "base64url");
    raw[raw.length - 20] ^= 1;
    expect(open(key, `v1.${raw.toString("base64url")}`, "ctx")).toBeNull();
  });
});

describe("rate limits", () => {
  test("counts per key in a fixed window, then says how long to wait", () => {
    let t = 1000;
    const limit = createLimiter({ windowMs: 60000, max: 2, now: () => t });
    expect(limit.blocked("a")).toBe(0);
    expect(limit.take("a")).toBe(0);
    limit.hit("a");
    expect(limit.blocked("a")).toBe(60);
    expect(limit.take("a")).toBe(60);
    expect(limit.take("b")).toBe(0);
    t += 59001;
    expect(limit.blocked("a")).toBe(1);
    t += 1000;
    expect(limit.blocked("a")).toBe(0);
    expect(limit.take("a")).toBe(0);
  });

  test("ended windows are swept out once there are many keys", () => {
    let t = 0;
    const limit = createLimiter({ windowMs: 1000, max: 1, now: () => t });
    for (let i = 0; i < SWEEP_AT - 1; i++) limit.hit(`k${i}`);
    t = 500;
    limit.hit("late");
    expect(limit.size()).toBe(SWEEP_AT);
    limit.hit("k0");
    expect(limit.size()).toBe(SWEEP_AT);
    t = 1000;
    limit.hit("fresh");
    // The windows that ended went; "late" has 500 ms to go.
    expect(limit.size()).toBe(2);
    expect(limit.blocked("late")).toBe(1);
  });

  test("uses the clock by default", () => {
    const limit = createLimiter({ windowMs: 60000, max: 1 });
    expect(limit.take("x")).toBe(0);
    expect(limit.take("x")).toBeGreaterThan(0);
  });
});
