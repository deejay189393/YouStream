/**
 * The profile store against a real PostgreSQL, when POSTGRES_TEST_URL names
 * one (CI runs a service for it). Without it, skipped: the Postgres driver's
 * own code is covered in storage.test.js either way.
 */
const { openDatabase } = require("../src/storage");
const { storeSuite } = require("./profileStore.suite");

const url = process.env.POSTGRES_TEST_URL;

if (url) {
  storeSuite("PostgreSQL", async () => (await openDatabase(url)).db);
} else {
  test.skip("the profile store on PostgreSQL (set POSTGRES_TEST_URL to run it)", () => {});
}
