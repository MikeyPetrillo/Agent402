// Two containers, one seller index (2026-10-15). Each holds the index in
// memory; the table is how they agree:
//   - an origin one container adds is pulled into the other;
//   - a save never writes an older copy of an origin over a newer row;
//   - an origin the operator removed on one container is purged from the
//     other before it saves, so the removal is never undone.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-replicas-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-index-replicas-pg" });

process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "index-replicas-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const X = "https://seller-x.example", Y = "https://seller-y.example";
const entry = (route, fetchedAt, extra = {}) => ({ manifest: { x402Version: 1, name: route }, tools: [{ route, price: "$0.001" }], fetchedAt, error: null, source: "crawl", history: [], paywall: null, discoveryPath: null, ...extra });
const snapArgs = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "test" };
const COLLECTION = "x402-index";
const served = (m) => new Set(m.indexSnapshot(snapArgs).sellers.map((s) => s.origin));

try {
  await sdb.records.put(COLLECTION, X, entry("/x", 1_000));
  const A = await import("../src/x402-index.js?container=a");
  const B = await import("../src/x402-index.js?container=b");
  await A.warmStartIndexFromStateDb(); await B.warmStartIndexFromStateDb();
  ok(served(A).has(X) && served(B).has(X), "both containers warm-start the same origin");

  // ---- an origin added on A reaches B ---------------------------------------
  A.__testSeedCache([[Y, entry("/y", 2_000)]]);
  await A.persistIndexCacheAsync();
  ok((await sdb.records.get(COLLECTION, Y))?.manifest?.name === "/y", "A's new origin is in the table");
  ok(!served(B).has(Y), "B does not have it before it pulls (the old behavior, forever)");
  const pulled = await B.pullIndexChanges();
  ok(pulled >= 1 && served(B).has(Y), `B pulls it (${pulled} change(s))`);

  // ---- newer wins -----------------------------------------------------------
  // A crawls X again (fetched later); B still holds the boot copy.
  A.__testSeedCache([[X, entry("/x-fresh", 3_000)]]);
  await A.persistIndexCacheAsync();
  ok((await sdb.records.get(COLLECTION, X))?.fetchedAt === 3_000, "A's fresher copy of X is in the table");
  B.__testSeedCache([[X, entry("/x-stale", 1_500)]]);
  await B.persistIndexCacheAsync();
  const x = await sdb.records.get(COLLECTION, X);
  ok(x?.fetchedAt === 3_000 && x?.manifest?.name === "/x-fresh", `B's save does not write its older copy over the newer row (row fetchedAt ${x?.fetchedAt}, ${x?.manifest?.name})`);
  // A direct older write is refused by the table itself, not only by the pull.
  // Let B pull everything first, then change the row behind its back with an
  // OLD stamp, so no pull can see it: only the upsert's guard stands between
  // B's older copy and the row.
  await B.pullIndexChanges();
  await sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.records SET body = jsonb_set(body, '{fetchedAt}', '5000'), updated_at = now() - interval '1 day' WHERE collection = $1 AND id = $2`, [COLLECTION, X]);
  B.__testSeedCache([[X, entry("/x-older", 4_000)]]);
  await B.persistIndexCacheAsync();
  ok((await sdb.records.get(COLLECTION, X))?.fetchedAt === 5_000, "a row fetched later than the copy being saved keeps its body (the upsert's own guard)");

  // ---- a seller-requested re-read on A reaches B without a full save ------------
  await B.pullIndexChanges();
  A.__testSeedCache([[X, entry("/x-reread", 9_000)]]);
  const wrote = await A.persistOriginToStateDb(X);
  ok(wrote === true && (await sdb.records.get(COLLECTION, X))?.fetchedAt === 9_000, "a single-origin write puts the re-read in the table at once");
  ok(!!(await sdb.records.get(COLLECTION, Y)), "and deletes nothing else");
  await B.pullIndexChanges();
  const bx = B.indexSnapshot(snapArgs).sellers.find((s) => s.origin === X);
  ok(bx && (bx.fetchedAt === 9_000 || bx.lastCrawled === 9_000 || JSON.stringify(bx).includes("9000")), `B serves the re-read after one pull (${bx?.fetchedAt})`);
  B.__testSeedCache([[X, entry("/x-older2", 8_000)]]);
  await B.persistOriginToStateDb(X);
  ok((await sdb.records.get(COLLECTION, X))?.fetchedAt === 9_000, "a single-origin write never replaces a newer row");

  // ---- a removal on A sticks on B --------------------------------------------
  const rm = A.removeOrigin(Y, { note: "test removal" });
  ok(rm.removed === true, "the operator removes Y on A");
  await new Promise((r) => setTimeout(r, 300));
  await A.persistIndexCacheAsync();
  ok((await sdb.records.get(COLLECTION, Y)) == null, "A's save deletes Y's row");
  ok(served(B).has(Y), "B still holds Y until it hears of the removal");
  await B.persistIndexCacheAsync();
  ok((await sdb.records.get(COLLECTION, Y)) == null, "B's save does not bring Y's row back");
  ok(!served(B).has(Y), "B no longer serves Y");
  ok(B.isRemovedOrigin(Y), "B knows Y is removed");
  A.stopCrawler?.(); B.stopCrawler?.();
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-index-replicas-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
