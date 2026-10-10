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
const { createJsonDocument, unloadedDocuments, unsavedDocuments, flushJsonDocuments } = await import("../src/json-document.js");

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
  const doc = createJsonDocument({ name: "loading-doc", log: () => {}, failLog: () => {}, loadRetryDelaysMs: [1500] });
  const p = doc.load(null);
  await wait(100);
  ok(doc.loadState === "loading", `a document whose first load is retrying reads loading (${doc.loadState})`);
  ok(sdb.unloadedStateStores().includes("document loading-doc"), "a loading document is named among the unloaded stores");
  relay.heal(); // the database answers again before the load's next try
  const saved = await doc.save({ kept: false });
  ok(saved === false, "a save while the first load is retrying is held");
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
  xi.removeOrigin("https://bad-two.example"); // stored before the boot, removed again and restored in the window
  ok(xi.restoreOrigin("https://bad-two.example").restored === true, "a stored removal repeated and restored in the window answers restored");
  await wait(5000);                 // past the in-load retries: the load has given up
  ok(sdb.stateDbStatus() === "degraded", `the status word is degraded while the removal list is unread (${sdb.stateDbStatus()})`);
  relay.heal();
  ok(await until(() => xi.isRemovedOrigin("https://bad-one.example")), "an origin the operator removed before the boot is removed once the late load lands");
  const stored = await until(async () => {
    const row = await sdb.documents.get("removed-origins.json");
    const o = new Set((row?.body || []).map((x) => x.origin));
    return o.has("https://bad-one.example") && o.has("https://bad-three.example");
  });
  const row = await sdb.documents.get("removed-origins.json");
  const origins = (row?.body || []).map((x) => x.origin).sort();
  const storedSet = new Set(origins);
  ok(stored, `the merged list is saved: stored removals kept, the boot-window removal added (${JSON.stringify(origins)})`);
  ok(!storedSet.has("https://bad-four.example") && !xi.isRemovedOrigin("https://bad-four.example"), "an origin restored during the window stays restored");
  ok(!storedSet.has("https://bad-two.example") && !xi.isRemovedOrigin("https://bad-two.example"), "a stored removal restored during the window is not brought back by the merge");
  xi.removeOrigin("https://bad-five.example");
  ok(await until(async () => JSON.stringify((await sdb.documents.get("removed-origins.json")).body).includes("bad-five")), "a removal after the recovery is saved");
  ok(await until(() => sdb.stateDbStatus() === "on"), `the status word reads on again (${sdb.stateDbStatus()}, unloaded ${JSON.stringify(sdb.unloadedStateStores())})`);
}

// ---- a boot reconcile that fails is not reported loaded ----------------------
{
  const { writeFileSync } = await import("node:fs");
  process.env.OUTBOUND_LEDGER_FILE = join(DIR, "outbound-spend.ndjson");
  writeFileSync(process.env.OUTBOUND_LEDGER_FILE, JSON.stringify({ at: "2026-10-01T00:00:00.000Z", chain: "base", result: "delivered" }) + "\n");
  relay.cut();
  const ob = await import("../src/outbound-ledger.js");
  const word = await sdb.stateStoresReady({ timeoutMs: 1500 });
  const named = sdb.unloadedStateStores().filter((n) => /outbound/.test(n));
  ok(word !== "ready" && named.length > 0, `the outbound ledger whose boot reconcile failed is not reported loaded (${word}; ${JSON.stringify(named)})`);
  ok(sdb.stateDbStatus() === "degraded", `and the status word reads degraded (${sdb.stateDbStatus()})`);
  relay.heal();
  ok(await until(() => !sdb.unloadedStateStores().some((n) => /outbound/.test(n))), `the reconcile is retried and the ledger reads loaded once the database answers (${JSON.stringify(sdb.unloadedStateStores())})`);
  ok(await until(async () => (await sdb.logLines.count(ob.OUTBOUND_STREAM)) === 1), "the retried reconcile restores the file's line to the stream");
}

// ---- a store that reads its document at boot takes the late body ----------
// The offsite backup's status (src/backup.js) is read once at boot; when that
// read outlasts its retries, the background re-read must still hand the row
// to the store, or the alarm word reads "stale" (no success on record) for
// the container's life while the stored status says ok.
{
  Object.assign(process.env, { BACKUP_S3_ENDPOINT: "http://127.0.0.1:9", BACKUP_S3_BUCKET: "b", BACKUP_S3_KEY_ID: "k", BACKUP_S3_SECRET: "s", BACKUP_DATA_DIR: join(DIR, "bk") });
  const recent = new Date(Date.now() - 3600_000).toISOString();
  await sdb.documents.put("backup-status.json", { lastAttempt: recent, lastSuccess: recent, lastResult: "ok", lastError: null });
  relay.cut();
  const { backupAlarmStatus, backupStatusLoaded } = await import("../src/backup.js");
  const first = backupAlarmStatus();
  await backupStatusLoaded();
  ok(first === "stale" && backupAlarmStatus() === "stale", `while the boot read cannot land, the word is stale (${first}, ${backupAlarmStatus()})`);
  relay.heal();
  ok(await until(() => backupAlarmStatus() === "ok", 10_000), `once the database is back the stored status reaches the store and the word is ok (${backupAlarmStatus()})`);
}

// ---- a save that fails after the document loaded is kept and re-sent ----------
// The document loaded fine; the database goes away; a whole-body save fails.
// The newest body is kept, re-sent until it lands (never an older one after a
// newer one), the document is named among the unsaved stores meanwhile, and
// the failure reaches failLog even when the store's own log is quiet.
{
  await sdb.documents.put("steady-doc", { v: 0 });
  const lines = [];
  const doc = createJsonDocument({ name: "steady-doc", log: () => {}, failLog: (m) => lines.push(m) });
  await doc.load(null);
  relay.cut();
  ok((await doc.save({ v: 1 })) === false, "a save during a steady outage reports it did not land");
  ok(lines.some((l) => /save failed/.test(l)), `the failed save reaches failLog (${JSON.stringify(lines[0] || "")})`);
  ok(unsavedDocuments().includes("document steady-doc (save pending)") && sdb.unsavedStateStores().includes("document steady-doc (save pending)"), "the document is named among the unsaved stores");
  ok(sdb.stateDbStatus() === "degraded", `the status word reads degraded (${sdb.stateDbStatus()})`);
  void doc.save({ v: 2 }); // a newer body while the first waits
  relay.heal();
  ok(await until(async () => (await sdb.documents.get("steady-doc")).body.v === 2), "the newest body lands once the database is back");
  await wait(1500); // past the retry backoff: nothing older follows it
  ok((await sdb.documents.get("steady-doc")).body.v === 2, "no older body is sent after the newer one landed");
  ok(!sdb.unsavedStateStores().includes("document steady-doc (save pending)"), "the document leaves the unsaved list once the body lands");
  ok(lines.some((l) => /held save landed/.test(l)), "the landing is logged");
}

// ---- recovery wakes a long backoff; the shutdown flush sends what waits ----
{
  const prevMs = process.env.STATE_STORE_RETRY_MS, prevMax = process.env.STATE_STORE_RETRY_MAX_MS;
  process.env.STATE_STORE_RETRY_MS = "60000"; process.env.STATE_STORE_RETRY_MAX_MS = "60000";
  await sdb.documents.put("wake-doc", { v: 0 });
  await sdb.documents.put("flush-doc", { v: 0 });
  const doc = createJsonDocument({ name: "wake-doc", log: () => {}, failLog: () => {} });
  const fdoc = createJsonDocument({ name: "flush-doc", log: () => {}, failLog: () => {} });
  await doc.load(null); await fdoc.load(null);
  relay.cut();
  await doc.save({ v: 1 });
  relay.heal();
  await sdb.stateQuery("SELECT 1"); // any good statement after the failure
  ok(await until(async () => (await sdb.documents.get("wake-doc")).body.v === 1, 3000), "a statement that succeeds after the outage wakes the held save (no 60 s backoff)");
  // A save whose retry waits (no statement has succeeded since) is sent by the shutdown flush.
  relay.cut();
  await fdoc.save({ v: 7 });
  relay.heal();
  const left = await flushJsonDocuments({ timeoutMs: 5000 });
  ok((await sdb.documents.get("flush-doc")).body.v === 7 && !left.includes("document flush-doc (save pending)"), `the shutdown flush sends the waiting save (${JSON.stringify(left)})`);
  process.env.STATE_STORE_RETRY_MS = prevMs; process.env.STATE_STORE_RETRY_MAX_MS = prevMax;
}

// ---- the load is done only once the store has the body (roll-forward) -------
// A rolled-back build wrote the file alone; the next load re-imports it (an
// UPDATE and a second read). A save in that window would put empty memory
// over the row: it is refused until the body is handed over.
{
  const { writeFileSync } = await import("node:fs");
  const file = join(DIR, "rollfwd.json");
  const d1 = createJsonDocument({ file, log: () => {}, failLog: () => {} });
  await d1.load({});
  await d1.save({ keep: ["a", "b", "c"] });
  await d1.flush();
  writeFileSync(file, JSON.stringify({ keep: ["a", "b", "c", "d"] }));
  const d2 = createJsonDocument({ file, log: () => {}, failLog: () => {} });
  let memory = {}, delivered = false, early = 0, stop = false;
  const loading = d2.load({}, { onLoad: (b) => { memory = b; delivered = true; } });
  const persister = (async () => { while (!stop) { if ((await d2.save(memory)) === true && !delivered) early++; await new Promise((r) => setImmediate(r)); } })();
  await loading;
  stop = true; await persister; await d2.flush();
  const row = await sdb.documents.get("rollfwd.json");
  ok(early === 0, `no save is accepted before the store has the body (${early})`);
  ok(row?.body?.keep?.length === 4, `the row keeps the re-imported body (${JSON.stringify(row?.body)})`);
}

await sdb.__dropStateSchema().catch(() => {});
await sdb.closeStateDb();
await relay.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\ntest-json-document-outage-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
