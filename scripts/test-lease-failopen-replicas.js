// Fail-open leases with more than one replica (src/state-db.js
// leaseMayFailOpen). With the database unreachable, an old container used to
// run a fail-open tick "as the only container"; with two replicas both are
// old, so both ran it. Now a named singleton (the nightly backup, the
// reconcile run) fails closed whenever more than one replica is configured,
// while an idempotent loop (a crawl) still fails open. Needs no database: the
// URL points at a port nothing listens on.
//   node scripts/test-lease-failopen-replicas.js
import { readFileSync } from "node:fs";

process.env.STATE_DATABASE_URL = "postgres://postgres@127.0.0.1:1/none?sslmode=disable&connect_timeout=1";
process.env.STATE_DB_SCHEMA = "t_failopen_unit";
delete process.env.RATE_LIMIT_REPLICAS;
delete process.env.STATE_DB_REPLICAS;
delete process.env.STATE_DB_LEASE_SINGLETONS;

const sdb = await import("../src/state-db.js");
const { withLease, leased, leaseReplicas, leaseMayFailOpen, FAIL_CLOSED_SINGLETONS, closeStateDb } = sdb;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const OLD = 11 * 60_000;
const run = async (name, opts = {}) => {
  let ran = 0;
  const r = await withLease(name, { ttlMs: 1000, uptimeMs: OLD, failOpen: true, log: () => {}, acquireTimeoutMs: 3000, ...opts }, async () => { ran++; return "ok"; });
  return { ...r, count: ran };
};

try {
  // ---- the replica count ------------------------------------------------------
  ok(leaseReplicas({}) === 1, "no setting: one replica");
  ok(leaseReplicas({ RATE_LIMIT_REPLICAS: "2" }) === 2, "RATE_LIMIT_REPLICAS names the count");
  ok(leaseReplicas({ RATE_LIMIT_REPLICAS: "2", STATE_DB_REPLICAS: "1" }) === 1, "STATE_DB_REPLICAS overrides it");
  ok(leaseMayFailOpen("x", { failOpen: false }, { RATE_LIMIT_REPLICAS: "1" }) === false, "a loop that does not opt in never fails open");

  // ---- one replica: as before -----------------------------------------------------
  const one = await run("backup-nightly");
  ok(one.ran === true && one.reason === "db-failopen" && one.count === 1, `one replica: an old container still runs the backup as the only container (${one.reason})`);

  // ---- two replicas ----------------------------------------------------------------
  process.env.RATE_LIMIT_REPLICAS = "2";
  for (const name of ["backup-nightly", "mpp-reconcile-run"]) {
    const r = await run(name);
    ok(r.ran === false && r.reason === "db" && r.count === 0, `two replicas: ${name} fails closed on a database error (${r.reason})`);
  }
  const crawl = await run("x402-index-crawl");
  ok(crawl.ran === true && crawl.reason === "db-failopen", "two replicas: an idempotent crawl still fails open");
  const flagged = await run("some-singleton", { singleton: true });
  ok(flagged.ran === false && flagged.reason === "db", "two replicas: a loop marked singleton fails closed");
  const wrapped = await leased("another-singleton", { ttlMs: 1000, uptimeMs: OLD, failOpen: true, singleton: true, log: () => {} }, async () => "ran")();
  ok(wrapped?.skipped === "leased", "leased() passes singleton through");
  process.env.STATE_DB_LEASE_SINGLETONS = "custom-once, other";
  const listed = await run("custom-once");
  ok(listed.ran === false && listed.reason === "db", "two replicas: a loop listed in STATE_DB_LEASE_SINGLETONS fails closed");
  delete process.env.STATE_DB_LEASE_SINGLETONS;
  process.env.STATE_DB_REPLICAS = "1";
  const back = await run("backup-nightly");
  ok(back.ran === true && back.reason === "db-failopen", "STATE_DB_REPLICAS=1 restores the one-replica rule");
  delete process.env.STATE_DB_REPLICAS;

  // ---- the names match the loops that use them -----------------------------------------
  const backupSrc = readFileSync(new URL("../src/backup.js", import.meta.url), "utf8");
  const reconcileSrc = readFileSync(new URL("../src/mpp-reconcile.js", import.meta.url), "utf8");
  ok(FAIL_CLOSED_SINGLETONS.every((n) => backupSrc.includes(`leased("${n}"`) || reconcileSrc.includes(`leased("${n}"`)), "every named singleton is a lease a loop actually takes");
} catch (e) {
  fail++; console.error(`FAIL - threw: ${e?.stack || e}`);
} finally {
  try { await closeStateDb(); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
