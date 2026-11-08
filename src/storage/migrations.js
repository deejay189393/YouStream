/**
 * The tables, built up one numbered migration at a time and recorded in
 * schema_migrations, so a database is brought up to date on start and never
 * migrated twice. A migration is never edited once released: a change is a
 * new migration.
 *
 * Times are epoch milliseconds in BIGINT columns, which both databases read
 * the same way. Each migration lists its statements per database; only the
 * cache's differ.
 */

const PROFILES = [
  // A profile: the reader's settings, sealed with a key of its own (see
  // profiles/store.js). The key is kept twice, sealed once with the
  // password and once with the install link's token, so either opens the
  // settings and neither is stored.
  `CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    password_salt TEXT NOT NULL,
    password_kdf TEXT NOT NULL,
    key_by_password TEXT NOT NULL,
    key_by_link TEXT NOT NULL,
    link_token TEXT NOT NULL,
    config TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS profiles_last_used ON profiles (last_used_at)",
  // A remembered sign-in, one per browser. The id is a hash of the cookie's
  // token, never the token; the profile's key is sealed with the token, so a
  // copy of the database opens no session.
  `CREATE TABLE IF NOT EXISTS profile_sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    profile_key TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    remembered INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS profile_sessions_profile ON profile_sessions (profile_id)",
  "CREATE INDEX IF NOT EXISTS profile_sessions_expires ON profile_sessions (expires_at)",
  // Facts about the store itself: a fingerprint of the SECRET_KEY every
  // profile in it was sealed with, so a changed one is noticed at start.
  "CREATE TABLE IF NOT EXISTS profile_store (name TEXT PRIMARY KEY, value TEXT NOT NULL)"
];

/**
 * The cache's entries, when CACHE_STORE=database (cache/database.js): a key,
 * the stored text, its size for the size limit, and when it expires. Only a
 * copy of what YouTube and the metadata services said, so on PostgreSQL the
 * table is UNLOGGED: written without the write-ahead log, and emptied by
 * Postgres after a crash -- which is how a database restored from a backup
 * starts, so a backup never brings old YouTube data back.
 */
const cache = (unlogged) => [
  `CREATE ${unlogged ? "UNLOGGED " : ""}TABLE IF NOT EXISTS cache_entries (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    size INTEGER NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS cache_entries_expires ON cache_entries (expires_at)"
];

const MIGRATIONS = [
  { id: 1, name: "profiles", up: { sqlite: PROFILES, postgres: PROFILES } },
  { id: 2, name: "cache", up: { sqlite: cache(false), postgres: cache(true) } }
];

/** Any number: it only has to be the same for every YouStream process. */
const POSTGRES_LOCK = 59780312;

/**
 * Applies whatever has not been applied yet, all in one transaction, so a
 * failure leaves the database as it was. On Postgres an advisory lock holds
 * off a second process starting at the same moment.
 *
 * @returns {Promise<string[]>} the names of the migrations applied now
 */
async function migrate(db, migrations = MIGRATIONS) {
  return db.transaction(async (tx) => {
    if (db.dialect === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(${POSTGRES_LOCK})`);
    await tx.run(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)"
    );
    const applied = new Map((await tx.all("SELECT id, name FROM schema_migrations")).map((row) => [Number(row.id), row.name]));
    const done = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        if (applied.get(migration.id) !== migration.name) {
          throw new Error(
            `migration ${migration.id} in this database is "${applied.get(migration.id)}", not "${migration.name}": it was made by another program`
          );
        }
        continue;
      }
      for (const statement of migration.up[db.dialect]) await tx.run(statement);
      await tx.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [migration.id, migration.name, Date.now()]);
      done.push(migration.name);
    }
    return done;
  });
}

module.exports = { migrate, MIGRATIONS };
