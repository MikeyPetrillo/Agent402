// src/leads-db.js against a real Postgres: the boot step drops the retired
// tollbooth_leads table, logs only its row count, and is a no-op once the
// table is gone (it never creates it again). Two containers booting together
// drop it once between them. Runs in a schema this test creates and drops,
// reached through DATABASE_URL's search_path, so no other table is touched.
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-leads-purge-pg" });
import pg from "pg";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const admin = new pg.Client({ connectionString: url, ssl: /sslmode=disable/.test(url) ? false : undefined });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
const { initLeadsDb, pingLeadsDb, closeLeadsDb } = await import("../src/leads-db.js");
const { initWithRetry } = await import("../src/db-init-retry.js");

// Synthetic rows only. Each field carries a marker no log line may contain.
const MARK = "fixture-mark-7f3a";
async function seed(n) {
  await admin.query(`CREATE TABLE ${schema}.tollbooth_leads (
    id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL,
    plan TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, org TEXT, sites TEXT, message TEXT, ip TEXT, ua TEXT)`);
  await admin.query(`CREATE INDEX tollbooth_leads_created_at_idx ON ${schema}.tollbooth_leads (created_at DESC)`);
  for (let i = 0; i < n; i++) {
    await admin.query(`INSERT INTO ${schema}.tollbooth_leads (kind, plan, name, email, org, sites, message, ip, ua) VALUES ('waitlist','team',$1,$2,$3,$4,$5,$6,$7)`,
      [`${MARK} name ${i}`, `${MARK}-${i}@example.invalid`, `${MARK} org`, `${MARK}.example`, `${MARK} message`, `${MARK}-ip`, `${MARK}-ua`]);
  }
}
const tablePresent = async () => (await admin.query("SELECT to_regclass($1) IS NOT NULL AS p", [`${schema}.tollbooth_leads`])).rows[0].p;

// Capture everything the module prints, not only what it passes to `log`.
const lines = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
const capture = () => { for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.join(" ")); }; };
const release = () => Object.assign(console, orig);

try {
  await seed(2);
  ok(await tablePresent(), "control: the seeded table exists with rows");
  ok((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.tollbooth_leads`)).rows[0].n === 2, "control: two synthetic rows");

  // The boot path: server.js calls initWithRetry("leads-db", initLeadsDb).
  lines.length = 0;
  capture();
  let first;
  try { first = await initWithRetry("leads-db", initLeadsDb, { schedule: () => null }); } finally { release(); }
  ok(first?.ok === true && first.removed === 2, `first boot: ok and removed 2 (${JSON.stringify(first)})`);
  ok(!(await tablePresent()), "first boot: the table is gone");
  ok(lines.includes("[leads-db] removed tollbooth_leads (2 rows)"), `first boot: the log carries the count line (${JSON.stringify(lines)})`);
  ok(!lines.some((l) => l.includes(MARK) || l.includes("example.invalid")), "first boot: no log line carries any row content");
  ok(lines.every((l) => /^\[leads-db\] (?:removed tollbooth_leads \(\d+ rows\)|ready)$/.test(l)), `first boot: only the count and ready lines are printed (${JSON.stringify(lines)})`);

  // A second boot is a no-op and never recreates the table.
  lines.length = 0;
  capture();
  let second;
  try { second = await initWithRetry("leads-db", initLeadsDb, { schedule: () => null }); } finally { release(); }
  ok(second?.ok === true && second.removed === null, `second boot: ok, nothing removed (${JSON.stringify(second)})`);
  ok(!(await tablePresent()), "second boot: the table is not recreated");
  ok(!lines.some((l) => /removed/.test(l)), `second boot: no removal line (${JSON.stringify(lines)})`);
  const tables = (await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [schema])).rows[0].n;
  ok(tables === 0, `second boot: the schema holds no table at all (${tables})`);

  // Two containers booting together: one drops it, the other reads it as gone.
  await seed(3);
  const logs = [];
  const [a, b] = await Promise.all([initLeadsDb({ log: (l) => logs.push(l) }), initLeadsDb({ log: (l) => logs.push(l) })]);
  const removed = [a.removed, b.removed].sort();
  ok(a.ok && b.ok && removed[0] === 3 && removed[1] === null, `concurrent boots: both ok, one removed 3, the other none (${JSON.stringify([a, b])})`);
  ok(logs.length === 1 && logs[0] === "[leads-db] removed tollbooth_leads (3 rows)", `concurrent boots: one count line (${JSON.stringify(logs)})`);
  ok(!(await tablePresent()), "concurrent boots: the table is gone");

  // The reachability ping /api/gateway-status reads keeps working.
  ok((await pingLeadsDb()) === true, "pingLeadsDb still answers on this database");
} catch (e) {
  release();
  ok(false, `threw: ${e?.stack || e}`);
} finally {
  await closeLeadsDb().catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`\ntest-leads-purge-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
