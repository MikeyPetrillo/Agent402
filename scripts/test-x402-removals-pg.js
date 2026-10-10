// The operator's removed-origins list with the state database:
//   - with the crawler off nothing else loads the list, so the first operator
//     call loads it: a removal is added to the stored list, never saved over
//     it, and a stored removal shows in the listing;
//   - while the list has not been read (a database outage at boot) the
//     index fails closed: registration is refused with a "not loaded yet"
//     answer, the router offers no outside seller, and restoring a stored
//     removal says the list has not loaded rather than "not removed".
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
const { url } = requireTestPg({ label: "test-x402-removals-pg" });
const relay = await startPgRelay(url);
const DIR = mkdtempSync(join(tmpdir(), "x402-removals-pg-"));
process.env.X402_INDEX_CRAWL = "off";
process.env.STATS_DB_DIR = DIR;
process.env.ALLOW_EPHEMERAL_STATS = "true";
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1000";
process.env.STATE_STORE_RETRY_MS = "300";
process.env.STATE_STORE_RETRY_MAX_MS = "600";
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(100); } return false; };
const STORED = "https://stored.example", STORED2 = "https://stored-two.example", NEW = "https://new.example", SELLER = "https://seller.example";
const DOC = "removed-origins.json";
await sdb.documents.put(DOC, [{ origin: STORED, removedAt: 1, note: "stored" }]);

try {
  // ---- crawler off: the first operator call loads the list ------------------
  process.env.REMOVED_ORIGINS_FILE = join(DIR, "none", DOC);
  const xi = await import("../src/x402-index.js");
  const r = xi.removeOrigin(NEW, { note: "crawler off" }); // nothing loaded the list before this call
  ok(r.removed === true, "a removal with the crawler off answers removed");
  ok(await until(async () => {
    const o = ((await sdb.documents.get(DOC))?.body || []).map((x) => x.origin);
    return o.includes(STORED) && o.includes(NEW);
  }), `the stored removal is kept and the new one added in the row (${JSON.stringify(((await sdb.documents.get(DOC))?.body || []).map((x) => x.origin))})`);
  ok(xi.listRemovedOrigins().some((x) => x.origin === STORED), "the listing shows the stored removal");

  // ---- a list not read yet (an outage at boot): fail closed -----------------
  // A second document stands in for the next boot's list.
  const DOC2 = "removed-origins-2.json";
  await sdb.documents.put(DOC2, [{ origin: STORED2, removedAt: 1, note: "stored" }]);
  relay.cut();
  process.env.REMOVED_ORIGINS_FILE = join(DIR, "none", DOC2);
  xi.loadRemovedOrigins(); // the boot load, during the outage
  xi.__testSeedCache([[SELLER, { manifest: { name: "s" }, tools: [{ route: "/a", name: "a" }], fetchedAt: Date.now(), error: null }]]);
  xi.__resetRoutableSummaryMemoForTest();
  const reg = await xi.registerOrigin("https://fresh.example", { crawl: async () => ({ manifest: { name: "f" }, tools: [], fetchedAt: Date.now(), error: null }) });
  ok(reg.listed === false && reg.notLoaded === true && /not loaded yet/.test(reg.error || ""), `registration is refused while the removal list is unread (${JSON.stringify(reg)})`);
  ok(xi.routableSellerSummaries().length === 0, "the router's seller summaries hold no outside seller while the list is unread");
  ok([...xi.routableRemoteEntries({ baseUrl: "https://agent402.tools" })].length === 0, "the router's remote entries are empty while the list is unread");
  const q = { query: "a", include: "external", baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "t" };
  ok(xi.routeQuery(q).results.length === 0, "routeQuery offers no outside seller while the list is unread");
  const rs = xi.restoreOrigin(STORED2);
  ok(rs.notLoaded === true && /not loaded yet/.test(rs.error || "") && rs.restored === undefined, `restoring a stored removal says the list has not loaded (${JSON.stringify(rs)})`);
  relay.heal();
  ok(await until(() => xi.removalsKnown() && xi.isRemovedOrigin(STORED2)), "once the database answers the stored list is read");
  xi.__resetRoutableSummaryMemoForTest();
  ok(xi.routableSellerSummaries().some((s) => s.origin === SELLER), "the router offers the outside seller again once the list is read");
  ok(xi.routeQuery(q).results.length > 0, "routeQuery offers outside sellers again");
} finally {
  relay.heal();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  await relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-x402-removals-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
