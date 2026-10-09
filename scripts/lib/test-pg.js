// A Postgres for a test: STATE_DATABASE_URL (or DATABASE_URL) names it, and
// the test gets its own schema so parallel runs and reruns never share rows.
// Under CI a missing database FAILS the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import { randomBytes } from "node:crypto";

export function requireTestPg({ label = "test" } = {}) {
  const url = String(process.env.STATE_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  if (!url) {
    const msg = `${label}: no STATE_DATABASE_URL; start a local Postgres and export STATE_DATABASE_URL=postgres://postgres@127.0.0.1:54329/a402?sslmode=disable`;
    if (process.env.CI) { console.error(`FAIL - ${msg} (a missing database is a failure under CI)`); process.exit(1); }
    console.log(`SKIP - ${msg}`);
    process.exit(0);
  }
  const schema = `t_${randomBytes(5).toString("hex")}`;
  process.env.STATE_DATABASE_URL = url;
  process.env.STATE_DB_SCHEMA = schema;
  return { url, schema };
}
