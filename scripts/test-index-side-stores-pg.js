// The index's side stores on two containers (two module instances on one real
// Postgres): successions, gone-route marks, submitted seeds and removed
// origins. A save from one container merges its own changes into the row and
// never replaces the other's; the pull folds the other container's changes,
// including a deletion (a cleared mark, a lifted removal).
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-side-stores-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-index-side-stores-pg" });

process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "index-side-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const X = "https://side-x.example";

try {
  const A = await import("../src/x402-index.js?container=a");
  const B = await import("../src/x402-index.js?container=b");
  for (const m of [A, B]) {
    await Promise.all([m.loadSuccessions(), m.loadGoneRoutes(), m.loadSubmittedSeeds()]);
    m.loadRemovedOrigins();
    for (let i = 0; i < 200 && !m.removalsKnown(); i++) await new Promise((r) => setTimeout(r, 20));
  }
  ok(A.removalsKnown() && B.removalsKnown(), "both containers loaded every side store");
  const settle = async () => { await A.__sideStoresSettledForTest(); await B.__sideStoresSettledForTest(); };

  // ---- gone-route marks --------------------------------------------------------
  A.markRouteGone(X, "GET", "/a", { kind: "410" });
  B.markRouteGone(X, "GET", "/b", { kind: "410" });
  await settle();
  await A.pullIndexChanges(); await B.pullIndexChanges();
  ok(A.isRouteGone(X, "GET", "/a") && A.isRouteGone(X, "GET", "/b"), "A holds its own mark and B's after a pull");
  ok(B.isRouteGone(X, "GET", "/a") && B.isRouteGone(X, "GET", "/b"), "B holds its own mark and A's after a pull (neither save replaced the other)");
  A.clearGoneMarks(X);
  await settle();
  await B.pullIndexChanges();
  ok(!B.isRouteGone(X, "GET", "/a") && !B.isRouteGone(X, "GET", "/b"), "marks A cleared (a re-registration) are cleared on B after its pull");
  B.markRouteGone(X, "GET", "/c", { kind: "410" });
  await settle();
  await A.pullIndexChanges();
  ok(A.isRouteGone(X, "GET", "/c") && !A.isRouteGone(X, "GET", "/a"), "a later mark on B reaches A, and A's clear stays cleared");

  // ---- successions -------------------------------------------------------------
  ok(A.recordSuccession("https://old-1.example", "https://new-1.example"), "A records a succession");
  ok(B.recordSuccession("https://old-2.example", "https://new-2.example"), "B records another");
  await settle();
  await A.pullIndexChanges(); await B.pullIndexChanges();
  ok(A.succeededBy("https://old-2.example") === "https://new-2.example" && B.succeededBy("https://old-1.example") === "https://new-1.example", "each container serves the other's succession after a pull");
  ok(A.succeededBy("https://old-1.example") === "https://new-1.example" && B.succeededBy("https://old-2.example") === "https://new-2.example", "and still its own");
  A.revokeSuccession("https://old-1.example");
  await settle();
  await B.pullIndexChanges();
  ok(B.succeededBy("https://old-1.example") === null, "a succession A revoked is revoked on B after its pull");

  // ---- submitted seeds (through registerOrigin) ----------------------------------
  const crawl = async (o) => ({ manifest: { name: o }, tools: [{ route: "/t", method: "GET" }], error: null });
  const ra = await A.registerOrigin("https://sub-a.example", { crawl });
  const rb = await B.registerOrigin("https://sub-b.example", { crawl });
  ok(ra.listed && rb.listed, "each container takes one new submission");
  await settle();
  const before = A.submissionSlotStatus().submitted;
  await A.pullIndexChanges();
  ok(A.submissionSlotStatus().submitted === before + 1, `A counts B's submission after a pull (${before} -> ${A.submissionSlotStatus().submitted})`);
  await B.pullIndexChanges();
  ok(B.submissionSlotStatus().submitted === A.submissionSlotStatus().submitted, "both containers hold the same submitted set");

  // ---- removals and their restore ---------------------------------------------------
  const Y = "https://side-y.example";
  ok(A.removeOrigin(Y, { note: "test" }).removed === true, "A removes an origin");
  await settle();
  await B.pullIndexChanges();
  ok(B.isRemovedOrigin(Y), "B knows the removal after a pull");
  ok(A.restoreOrigin(Y).restored === true, "A lifts the removal");
  await settle();
  await B.pullIndexChanges();
  ok(!B.isRemovedOrigin(Y), "the restore reaches B after its pull");
  await A.pullIndexChanges();
  ok(!A.isRemovedOrigin(Y), "and A's own pull does not bring the removal back");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-index-side-stores-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
