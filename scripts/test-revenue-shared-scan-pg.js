// The shared live rail scan against a REAL state database: two module
// instances (two replicas) on one schema scan once and share the saved
// snapshot through the real document store and the real lease
// (src/revenue-live.js). Only the scan itself is injected (no chain reads).
// Needs STATE_DATABASE_URL; under CI a missing database is a failure.

import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-revenue-shared-scan-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sdb = await import("../src/state-db.js");
let scans = 0;
const scan = async () => { scans++; await sleep(50); return { spec: "agent402-revenue/1", asOf: new Date().toISOString(), rails: [{ rail: "Base", balance: scans, recent: [] }] }; };

try {
  await sdb.stateDb(); // connects and creates the schema
  const A = await import("../src/revenue-live.js?pg=a");
  const B = await import("../src/revenue-live.js?pg=b");
  // Only the scan is replaced: the store and the lease are the real ones.
  A._setRevenueSnapshotDepsForTest({ scan });
  B._setRevenueSnapshotDepsForTest({ scan });
  const settle = async (M) => { await M.revenueSnapshot({}); for (let i = 0; i < 50; i++) { await sleep(40); const s = await M.revenueSnapshot({}); if (s && s.rails?.[0]?.rail === "Base" && s.asOf && !s.stale) return s; } return M.revenueSnapshot({}); };

  // Two replicas asking at once: the lease lets one scan; the other waits its
  // pause, then adopts the saved snapshot.
  // A cold replica that finds the lease held has nothing to serve yet: it
  // answers "warming" (the page's existing cold path), and never scans.
  const [a1, bCold] = await Promise.all([settle(A), (async () => { await sleep(5); return B.revenueSnapshot({}).catch((e) => e); })()]);
  ok(scans === 1 && a1.rails[0].balance === 1, `one scan between two replicas asking at once (${scans})`);
  ok(bCold instanceof Error ? bCold.snapshotWarming === true : bCold?.asOf === a1.asOf, "the replica that did not hold the lease waited instead of scanning");
  const b1 = await settle(B);
  ok(scans === 1 && b1.asOf === a1.asOf, "...and then adopts the saved snapshot");
  const row = (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.documents WHERE name = 'revenue-snapshot'`)).rows[0];
  ok(row && row.body?.asOf === a1.asOf, "the snapshot is saved as a state document");
  const C = await import("../src/revenue-live.js?pg=c");
  C._setRevenueSnapshotDepsForTest({ scan });
  const c1 = await settle(C);
  ok(scans === 1 && c1.asOf === a1.asOf, "a third (booting) replica adopts it from the database without scanning");
} catch (e) {
  fail++; console.log("FAIL -", e?.stack || e);
} finally {
  try { await sdb.__dropStateSchema(); } catch {}
  try { await sdb.closeStateDb(); } catch {}
}
console.log(`\ntest-revenue-shared-scan-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
