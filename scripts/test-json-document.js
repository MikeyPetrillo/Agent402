// src/json-document.js: one API, three backends. The file backend keeps the
// tmp+rename and merge-on-save behaviour the stores had; the memory backend
// stands in when there is no file and no database; the Postgres backend
// imports the file once when its row is missing and records the import, so
// turning the database on carries every store across. The Postgres half runs
// only when STATE_DATABASE_URL points at a database (required under CI).
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "json-doc-"));

// ---- file and memory backends: no database in the environment ---------------
delete process.env.STATE_DATABASE_URL;
process.env.DATABASE_URL = "postgres://ignored.example/analytics"; // DATABASE_URL alone never switches the stores
{
  const { createJsonDocument, documentNameOf } = await import("../src/json-document.js?file");
  const { stateDbEnabled } = await import("../src/state-db.js");
  ok(stateDbEnabled() === false, "DATABASE_URL alone leaves the state database off: the switch is STATE_DATABASE_URL");
  ok(documentNameOf("/data/free-alerts.json") === "free-alerts.json", "the document name is the file's basename");
  const file = join(DIR, "a.json");
  const doc = createJsonDocument({ file, log: () => {} });
  ok(doc.backend === "file" && doc.name === "a.json", "a file and no database: file backend");
  ok((await doc.load({ empty: true })).empty === true, "load of a missing file returns the fallback");
  ok(await doc.save({ k: 1 }) === true && JSON.parse(readFileSync(file, "utf8")).k === 1, "save writes the file");
  ok(!existsSync(`${file}.${process.pid}.tmp`), "no tmp file is left behind");
  writeFileSync(file, "{not json");
  ok((await doc.load("fb")) === "fb" && /JSON/.test(doc.lastError || ""), "an unreadable file loads the fallback and records the error");
  await doc.save({ a: 1, b: 2 });
  const merged = await doc.mergeKeys({ c: 3 }, ["a"]);
  ok(merged.b === 2 && merged.c === 3 && merged.a === undefined && JSON.parse(readFileSync(file, "utf8")).c === 3, "mergeKeys on a file keeps other keys");
  const other = createJsonDocument({ file: join(DIR, "sub", "deep.json"), log: () => {} });
  ok(await other.save([1, 2]) === true && (await other.load())[1] === 2, "save creates missing directories");
  const mem = createJsonDocument({ name: "mem-only", log: () => {} });
  ok(mem.backend === "memory" && (await mem.load("x")) === "x", "no file and no database: memory backend");
  await mem.save({ m: 1 });
  ok((await mem.load()).m === 1 && (await mem.mergeKeys({ n: 2 })).n === 2, "memory save and merge");
  let threw = false; try { createJsonDocument({ name: "Bad Name!" }); } catch { threw = true; }
  ok(threw, "a name outside the allowed shape is refused");
}

// ---- Postgres backend ------------------------------------------------------
const { requireTestPg } = await import("./lib/test-pg.js");
const url = String(process.env.STATE_DATABASE_URL_FOR_TEST || "").trim();
if (url) process.env.STATE_DATABASE_URL = url;
if (!String(process.env.STATE_DATABASE_URL || "").trim() && process.env.CI) { console.error("FAIL - CI needs STATE_DATABASE_URL_FOR_TEST for the Postgres half"); process.exit(1); }
if (String(process.env.STATE_DATABASE_URL || "").trim()) {
  requireTestPg({ label: "test-json-document" });
  // Every query of this half goes through a relay the test can cut (an outage).
  const { startPgRelay } = await import("./lib/pg-relay.js");
  const relay = await startPgRelay(process.env.STATE_DATABASE_URL);
  process.env.STATE_DATABASE_URL = relay.url;
  const { createJsonDocument, SKIP_UPDATE, rowMarkOf } = await import("../src/json-document.js?pg");
  const sdb = await import("../src/state-db.js");
  // After a heal the pool may still hand out a connection the cut killed; one
  // good query clears them before the next assertion.
  const heal = async () => { relay.heal(); for (let i = 0; i < 6; i++) { try { await sdb.stateQuery("SELECT 1"); return; } catch { /* a dead pooled connection */ } } };
  try {
    const file = join(DIR, "imp.json");
    writeFileSync(file, JSON.stringify({ from: "file", n: 7 }));
    const doc = createJsonDocument({ file, log: () => {} });
    ok(doc.backend === "pg", "with a database: pg backend");
    const first = await doc.load();
    ok(first.from === "file" && first.n === 7, "first load imports the file");
    const im = await sdb.imports.done("imp.json");
    ok(im && im.source === file && im.bytes > 0, "the import is recorded with its source and size");
    writeFileSync(file, JSON.stringify({ from: "file-later" }));
    ok((await doc.load()).from === "file", "a later file change is not re-imported: the row wins");
    ok(await doc.save({ from: "pg" }) === true && (await doc.load()).from === "pg", "save writes the row");
    ok(JSON.parse(readFileSync(file, "utf8")).from === "pg", "write-through: the file now carries the saved body (the backup stays complete)");
    const nowt = createJsonDocument({ file: join(DIR, "nowt.json"), writeThroughFiles: false, log: () => {} });
    await nowt.save({ x: 1 });
    ok(!existsSync(join(DIR, "nowt.json")), "writeThroughFiles:false writes no file");
    await sdb.documents.put("imp2.json", { row: "first" });
    writeFileSync(join(DIR, "imp2.json"), JSON.stringify({ row: "file" }));
    const imp2 = createJsonDocument({ file: join(DIR, "imp2.json"), log: () => {} });
    ok((await imp2.load()).row === "first", "an existing row is never overwritten by a file import");
    const m = await doc.mergeKeys({ extra: 1 }, ["from"]);
    ok(m.extra === 1 && m.from === undefined, "mergeKeys works on the row");
    const fresh = createJsonDocument({ name: "fresh-doc", log: () => {} });
    ok((await fresh.load("fb")) === "fb" && (await sdb.imports.done("fresh-doc")) === null, "no file, no row: fallback and no import record");
    const noimp = createJsonDocument({ file, name: "noimport", importFromFile: false, log: () => {} });
    ok((await noimp.load("fb")) === "fb", "importFromFile:false never reads the file");
    // Roll-forward: the old build (file only) rewrote the file after this
    // store's write-through of the row's current version: the file wins.
    const rb = createJsonDocument({ file: join(DIR, "rb.json"), log: () => {} });
    await rb.save({ gen: "row" });
    ok(existsSync(rowMarkOf(join(DIR, "rb.json"))), "write-through records the row version it wrote in a sidecar");
    writeFileSync(join(DIR, "rb.json"), JSON.stringify({ gen: "rollback" }));
    const rb2 = createJsonDocument({ file: join(DIR, "rb.json"), log: () => {} });
    ok((await rb2.load()).gen === "rollback" && (await sdb.documents.get("rb.json")).body.gen === "rollback", "a file changed after the write-through of the row's current version re-imports and replaces the row");
    ok((await createJsonDocument({ file: join(DIR, "rb.json"), log: () => {} }).load()).gen === "rollback", "...once: the re-import's own write-through is not taken for another rollback");
    // The untouched write-through file never replaces the row.
    const sameAge = createJsonDocument({ file: join(DIR, "sa.json"), log: () => {} });
    await sameAge.save({ gen: "row" });
    await sdb.documents.put("sa.json", { gen: "row-moved-on" }); // another writer advanced the row after the write-through
    writeFileSync(join(DIR, "sa.json"), JSON.stringify({ gen: "stale" }));
    ok((await createJsonDocument({ file: join(DIR, "sa.json"), log: () => {} }).load()).gen === "row-moved-on", "a file whose sidecar names an older row version does not replace the row");
    // An empty file, however new, never replaces a populated row.
    const { utimesSync } = await import("node:fs");
    const al = createJsonDocument({ file: join(DIR, "alerts.json"), log: () => {} });
    await al.save({ alerts: { a1: { id: "a1" }, a2: { id: "a2" } } });
    writeFileSync(join(DIR, "alerts.json"), JSON.stringify({ alerts: {} }));
    const later = new Date(Date.now() + 10 * 60_000);
    utimesSync(join(DIR, "alerts.json"), later, later);
    ok(Object.keys((await createJsonDocument({ file: join(DIR, "alerts.json"), log: () => {} }).load()).alerts).length === 2 && Object.keys((await sdb.documents.get("alerts.json")).body.alerts).length === 2, "an empty {alerts:{}} file newer than a populated row never replaces it");
    // A foreign or freshly created file (no sidecar from this store) never replaces a row.
    await sdb.documents.put("foreign.json", { keep: 1 });
    writeFileSync(join(DIR, "foreign.json"), JSON.stringify({ other: 2 }));
    utimesSync(join(DIR, "foreign.json"), later, later);
    ok((await createJsonDocument({ file: join(DIR, "foreign.json"), log: () => {} }).load()).keep === 1, "a file this store never wrote through (no sidecar) does not replace the row, whatever its mtime");

    // ---- a failed load never leads to an overwrite (H2) ----------------------
    await sdb.documents.put("h2.json", { seqs: { a: 1, b: 2, c: 3 } });
    const h2 = createJsonDocument({ name: "h2.json", log: () => {}, loadRetryDelaysMs: [20] });
    relay.cut();
    const during = await h2.load({ seqs: {} });
    const rd = await h2.read();
    await heal();
    ok(Object.keys(during.seqs).length === 0 && h2.loaded === false && h2.loadState === "failed", "a load during an outage returns the fallback and leaves the document unloaded");
    ok(rd.ok === false, "read() reports the outage as an error, not as a missing row");
    const refused = await h2.save({ seqs: { d: 4 } });
    const kept = (await sdb.documents.get("h2.json")).body.seqs;
    ok(refused === false && kept.a === 1 && kept.b === 2 && kept.c === 3 && kept.d === undefined, "a save after a failed load is refused: the row keeps a, b and c");
    const relo = await h2.load({ seqs: {} });
    ok(relo.seqs.a === 1 && h2.loaded === true, "a later load reads the row and the document is loaded");
    ok(await h2.save({ ...relo, seqs: { ...relo.seqs, d: 4 } }) === true && (await sdb.documents.get("h2.json")).body.seqs.d === 4, "...and saves go through again");
    const retried = createJsonDocument({ name: "h2.json", log: () => {}, loadRetryDelaysMs: [300] });
    relay.cut(); setTimeout(() => relay.heal(), 100);
    ok((await retried.load({ seqs: {} })).seqs.c === 3 && retried.loaded, "a load that fails once is retried after a backoff and reads the row");
    await heal();
    const saveOnly = createJsonDocument({ name: "save-only.json", log: () => {} });
    ok(await saveOnly.save({ s: 1 }) === true, "a store that never loads (a computed snapshot) may still save");

    // ---- a failed save is reported, never dropped silently (e1) --------------
    const bad = createJsonDocument({ name: "e1.json", log: () => {} });
    await bad.save({ ok: 1 });
    const badSave = await bad.save({ s: "nul\u0000inside" });
    ok(badSave === false && /unsupported|0x00|null character/i.test(String(bad.lastError || "")), `a save the database rejects resolves false and records the error (${String(bad.lastError || "").slice(0, 60)})`);
    ok((await sdb.documents.get("e1.json")).body.ok === 1, "...and the row is the last good body");
    relay.cut();
    const cutSave = await bad.save({ ok: 2 });
    await heal();
    ok(cutSave === false && bad.lastError, "a save during an outage resolves false and records the error");

    // ---- update(): two writers never drop each other (H8) --------------------
    const u1 = createJsonDocument({ name: "upd.json", log: () => {} });
    const u2 = createJsonDocument({ name: "upd.json", log: () => {} });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? u1 : u2).update((b) => { b.items[`k${i}`] = i; }, { fallback: { items: {} } })));
    const ub = (await sdb.documents.get("upd.json")).body;
    ok(Object.keys(ub.items).length === 20, `20 concurrent updates from two instances all land (${Object.keys(ub.items).length})`);
    const sk = await u1.update(() => SKIP_UPDATE);
    ok(sk.ok && sk.changed === false && (await sdb.documents.get("upd.json")).version === sk.version, "SKIP_UPDATE writes nothing");
    let ran = 0;
    const claim = (b) => { ran++; if (b.claimed) return SKIP_UPDATE; b.claimed = "x"; };
    const [c1, c2] = await Promise.all([u1.update(claim), u2.update(claim)]);
    ok([c1, c2].filter((r) => r.changed).length === 1, `a conditional claim is won by exactly one writer (mutator ran ${ran} times)`);
    relay.cut();
    const uo = await u1.update((b) => { b.x = 1; });
    await heal();
    ok(uo.ok === false && uo.error, "an update during an outage resolves ok:false");
    const mergedFirst = createJsonDocument({ file: join(DIR, "mf.json"), log: () => {} });
    writeFileSync(join(DIR, "mf.json"), JSON.stringify({ old: 1 }));
    const mm = await mergedFirst.mergeKeys({ new: 2 });
    ok(mm.old === 1 && mm.new === 2, "a first mergeKeys imports the file before merging");
  } finally {
    relay.heal();
    for (let i = 0; i < 3; i++) { try { await sdb.__dropStateSchema(); break; } catch { /* a connection the cut killed; the pool opens a new one */ } }
    await sdb.closeStateDb();
    await relay.close();
  }
} else {
  console.log("SKIP - Postgres half: no STATE_DATABASE_URL_FOR_TEST");
}

rmSync(DIR, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
