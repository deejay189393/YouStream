const crypto = require("crypto");
const { openDatabase } = require("../src/storage");
const { createProfileStore } = require("../src/profiles/store");
const { storeSuite, SESSIONS, CONFIG } = require("./profileStore.suite");

storeSuite("SQLite", async () => (await openDatabase("sqlite::memory:")).db);

test("by default, the store uses scrypt's full cost and the real clock", async () => {
  const { db } = await openDatabase("sqlite::memory:");
  const store = createProfileStore({ db, secret: crypto.randomBytes(32), sessions: SESSIONS });
  const before = Date.now();
  const { id } = await store.create(CONFIG, "correct horse battery");
  const row = await db.get("SELECT password_kdf, created_at FROM profiles WHERE id = ?", [id]);
  expect(row.password_kdf).toBe("scrypt:15:8:1");
  expect(row.created_at).toBeGreaterThanOrEqual(before);
  expect((await store.verify(id, "correct horse battery")).version).toBe(1);
  await db.close();
});
