// A document whose file is there and whose one-time import cannot reach the
// database (the import's statement times out: a congested pool, a held lock)
// must not load EMPTY. A failed import is a failed load: the document stays
// unloaded, whole-body saves are held, the status word reads degraded, and
// the background re-read imports the file once the database answers. A
// document with no file still loads its fallback at once ("no file" is not a
// failure).
//
// The import is made to time out by holding an uncommitted insert of the same
// document name in another session: the import's INSERT ... ON CONFLICT waits
// on it until the statement limit, while the plain read sees no row.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";

const { url, schema } = requireTestPg({ label: "test-json-document-import-fail-pg" });
const DIR = mkdtempSync(join(tmpdir(), "json-doc-import-fail-"));
process.env.STATE_DB_STATEMENT_TIMEOUT_MS = "600";
process.env.STATE_STORE_RETRY_MS = "200";
process.env.STATE_STORE_RETRY_MAX_MS = "400";
const sdb = await import("../src/state-db.js");
const { createJsonDocument, unloadedDocuments } = await import("../src/json-document.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(50); } return false; };

await sdb.stateQuery("SELECT 1"); // the schema is in place
const blocker = new pg.Client({ connectionString: url });
await blocker.connect();
/** Hold an uncommitted row for `name`: an import's insert of it waits until released. */
async function holdName(name) {
  await blocker.query("BEGIN");
  await blocker.query(`INSERT INTO ${schema}.documents (name, body) VALUES ($1, '{"held":true}'::jsonb)`, [name]);
}
const release = () => blocker.query("ROLLBACK");

try {
  // ---- the import times out: the document is not loaded empty ----------------
  {
    const file = join(DIR, "followups.json");
    writeFileSync(file, JSON.stringify({ items: [{ id: "a" }, { id: "b" }] }));
    await holdName("followups.json");
    const lines = [];
    const late = [];
    const doc = createJsonDocument({ file, log: () => {}, failLog: (m) => lines.push(m), loadRetryDelaysMs: [50] });
    const body = await doc.load({ items: [] }, { onLoad: (b) => late.push(b) });
    ok(doc.loadState !== "ok", `a document whose import timed out is not marked loaded (${doc.loadState})`);
    ok(Array.isArray(body?.items) && body.items.length === 0 && late.length === 0, "load returns the fallback and onLoad is not called with it");
    ok(unloadedDocuments().includes("document followups.json"), "the document is named among the unloaded stores");
    await sdb.stateStoresReady({ timeoutMs: 10 });
    ok(sdb.stateDbStatus() === "degraded", `the status word reads degraded (${sdb.stateDbStatus()})`);
    ok((await doc.save({ items: [] })) === false, "a whole-body save is held while the import has not landed");
    ok(lines.some((l) => /import .*failed|load failed/.test(l)), `the failure reaches failLog (${JSON.stringify(lines[0] || "")})`);
    ok((await sdb.imports.done("followups.json")) === null, "no import mark is written for a failed import");
    await release();
    ok(await until(() => doc.loadState === "ok" && late.length === 1), `the background re-read imports the file once the database answers (state ${doc.loadState})`);
    ok(late[0]?.items?.length === 2, `onLoad gets the imported body (${JSON.stringify(late[0])})`);
    const row = await sdb.documents.get("followups.json");
    ok(row?.body?.items?.length === 2, "the row holds the file's body");
    ok((await sdb.imports.done("followups.json"))?.bytes > 0, "the import is marked once it landed");
    ok((await doc.save({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] })) === true, "saves resume after the import");
  }

  // ---- mergeKeys and update never write over a file whose import failed -------
  {
    const file = join(DIR, "merge.json");
    writeFileSync(file, JSON.stringify({ kept: 1 }));
    await holdName("merge.json");
    const doc = createJsonDocument({ file, log: () => {}, failLog: () => {} });
    const merged = await doc.mergeKeys({ added: 2 });
    ok(merged === null, "mergeKeys reports a failure while the import cannot land");
    const up = await doc.update((b) => { b.added = 3; }, { fallback: {} });
    ok(up.ok === false, "update reports a failure while the import cannot land");
    await release();
    const again = await doc.mergeKeys({ added: 2 });
    ok(again?.kept === 1 && again?.added === 2, `after the database answers the merge lands on the imported body (${JSON.stringify(again)})`);
  }

  // ---- no file is not a failure ------------------------------------------------
  {
    const doc = createJsonDocument({ file: join(DIR, "absent.json"), log: () => {}, failLog: () => {} });
    const body = await doc.load({ fresh: true });
    ok(body?.fresh === true && doc.loadState === "ok", "a document with no file loads its fallback and is loaded");
  }

  // ---- an unreadable file is named, and not retried forever ----------------------
  {
    const file = join(DIR, "torn.json");
    writeFileSync(file, "{\"half\":");
    const lines = [];
    const doc = createJsonDocument({ file, log: () => {}, failLog: (m) => lines.push(m) });
    const body = await doc.load({ empty: true });
    ok(body?.empty === true && doc.loadState === "ok", "a file that does not parse is not a database failure: the fallback loads");
    ok(lines.some((l) => /unreadable|not imported/.test(l)), `the unreadable file reaches failLog (${JSON.stringify(lines[0] || "")})`);
  }

  // ---- a file that cannot be read (an I/O error) is a failed load, not "no file" ----
  {
    const file = join(DIR, "ioerr.json");
    mkdirSync(file); // existsSync is true, readFileSync throws EISDIR
    const doc = createJsonDocument({ file, log: () => {}, failLog: () => {}, loadRetryDelaysMs: [20] });
    const late = [];
    await doc.load({ empty: true }, { onLoad: (b) => late.push(b) });
    ok(doc.loadState !== "ok", `an import whose file read hits an I/O error is not loaded empty (${doc.loadState})`);
    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, JSON.stringify({ carried: 1 }));
    ok(await until(() => doc.loadState === "ok" && late.length === 1), "the background re-read imports the file once it reads");
    ok(late[0]?.carried === 1, `onLoad gets the file's body (${JSON.stringify(late[0])})`);
  }
} finally {
  try { await blocker.query("ROLLBACK"); } catch { /* not in a transaction */ }
  await blocker.end().catch(() => {});
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
