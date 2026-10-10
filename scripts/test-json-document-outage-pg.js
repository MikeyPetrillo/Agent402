// A json-document whose first load outlasts its in-load retries (a database
// outage at boot longer than the backoff) must not stay unloaded for the
// container's life: it re-reads in the background, hands the body to its
// store, and saves resume. While it is unread the state database's status
// reads degraded and a save is held (a body built from empty memory never
// replaces the stored one), including a save made while the first load is
// still retrying. x402-index's operator lists merge what changed in memory
// meanwhile and save the merge.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
const { url } = requireTestPg({ label: "test-json-document-outage-pg" });
const relay = await startPgRelay(url);
const DIR = mkdtempSync(join(tmpdir(), "json-doc-outage-"));
process.env.X402_INDEX_CRAWL = "off";
process.env.STATS_DB_DIR = DIR;
process.env.REMOVED_ORIGINS_FILE = join(DIR, "none", "removed-origins.json");
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1000";
process.env.STATE_STORE_RETRY_MS = "300";
process.env.STATE_STORE_RETRY_MAX_MS = "600";
const sdb = await import("../src/state-db.js");
const { createJsonDocument, unloadedDocuments } = await import("../src/json-document.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(100); } return false; };

await sdb.documents.put("outage-doc", { a: 1 });
await sdb.documents.put("removed-origins.json", [{ origin: "https://bad-one.example", removedAt: 1, note: "" }, { origin: "https://bad-two.example", removedAt: 2, note: "" }]);
await sdb.documents.put("loading-doc", { kept: true });

// ---- the primitive: a load that gives up re-reads in the background ----------
{
  relay.cut();
  const lines = [];
  const late = [];
  const doc = createJsonDocument({ name: "outage-doc", log: () => {}, failLog: (m) => lines.push(m), loadRetryDelaysMs: [50, 50] });
  const loaded = await doc.load(null, { onLoad: (b) => late.push(b) });
  ok(loaded === null && doc.loadState === "failed" && late.length === 0, "a load during an outage returns the fallback, the document is failed and onLoad is not called with the fallback");
  ok(lines.some((l) => /load failed/.test(l)), `the failure is logged even when the store's own log is quiet (${JSON.stringify(lines[0] || "")})`);
  ok(unloadedDocuments().includes("document outage-doc") && sdb.unloadedStateStores().includes("document outage-doc"), "the unread document is named among the unloaded state stores");
  await sdb.stateStoresReady({ timeoutMs: 10 });
  ok(sdb.stateDbStatus() === "degraded", `the status word reads degraded while the document is unread (${sdb.stateDbStatus()})`);
  ok(sdb.stateStoresLoaded() === false, "stateStoresLoaded counts the unread document");
  ok((await doc.save({ a: 99 })) === false, "a save while the document is unread is held");
  relay.heal();
  ok(await until(() => doc.loadState === "ok" && late.length === 1), `the background re-read lands once the database is back (state ${doc.loadState})`);
  ok(late[0]?.a === 1, `onLoad gets the stored body (${JSON.stringify(late[0])})`);
  ok(lines.some((l) => /landed/.test(l)), "the recovery is logged");
  ok(!sdb.unloadedStateStores().includes("document outage-doc"), "the document is no longer listed as unloaded");
  ok((await doc.save({ a: 2 })) === true && (await sdb.documents.get("outage-doc")).body.a === 2, "a save after the recovery persists");
}

// ---- a save while the first load is still retrying is held -------------------
{
  relay.cut();
  const doc = createJsonDocument({ name: "loading-doc", log: () => {}, failLog: () => {}, loadRetryDelaysMs: [400] });
  const p = doc.load(null);
  await wait(50);
  ok(doc.loadState === "loading", `a document whose first load is retrying reads loading (${doc.loadState})`);
  ok(sdb.unloadedStateStores().includes("document loading-doc"), "a loading document is named among the unloaded stores");
  const saved = await doc.save({ kept: false });
  ok(saved === false, "a save while the first load is retrying is held");
  relay.heal();
  const body = await p;
  ok(body?.kept === true && (await sdb.documents.get("loading-doc")).body.kept === true, `the stored body is unchanged by the held save (${JSON.stringify(body)})`);
}

// ---- x402-index operator removals across a boot outage -----------------------
{
  relay.cut();
  const xi = await import("../src/x402-index.js");
  xi.loadRemovedOrigins();          // first load: 250 + 1000 + 3000 ms of retries, then background
  await wait(400);
  const r = xi.removeOrigin("https://bad-three.example", { note: "during the boot window" });
  ok(r.removed === true, "a removal during the first load answers removed (kept in memory)");
  xi.removeOrigin("https://bad-four.example");
  const restored = xi.restoreOrigin("https://bad-four.example");
  ok(restored.restored === true, "a restore during the load lifts the in-memory removal");
  await wait(5000);                 // past the in-load retries: the load has given up
  ok(sdb.stateDbStatus() === "degraded", `the status word is degraded while the removal list is unread (${sdb.stateDbStatus()})`);
  relay.heal();
  ok(await until(() => xi.isRemovedOrigin("https://bad-one.example")), "an origin the operator removed before the boot is removed once the late load lands");
  const stored = await until(async () => {
    const row = await sdb.documents.get("removed-origins.json");
    const o = (row?.body || []).map((x) => x.origin);
    return o.includes("https://bad-one.example") && o.includes("https://bad-two.example") && o.includes("https://bad-three.example");
  });
  const row = await sdb.documents.get("removed-origins.json");
  const origins = (row?.body || []).map((x) => x.origin).sort();
  ok(stored, `the merged list is saved: stored removals kept, the boot-window removal added (${JSON.stringify(origins)})`);
  ok(!origins.includes("https://bad-four.example") && !xi.isRemovedOrigin("https://bad-four.example"), "an origin restored during the window stays restored");
  xi.removeOrigin("https://bad-five.example");
  ok(await until(async () => JSON.stringify((await sdb.documents.get("removed-origins.json")).body).includes("bad-five")), "a removal after the recovery is saved");
  ok(await until(() => sdb.stateDbStatus() === "on"), `the status word reads on again (${sdb.stateDbStatus()}, unloaded ${JSON.stringify(sdb.unloadedStateStores())})`);
}

await sdb.__dropStateSchema().catch(() => {});
await sdb.closeStateDb();
await relay.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\ntest-json-document-outage-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
