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
  const { createJsonDocument } = await import("../src/json-document.js?pg");
  const sdb = await import("../src/state-db.js");
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
    // Roll-forward: a file written well after the row (the old build ran on the file alone) replaces the row.
    const { utimesSync } = await import("node:fs");
    const rb = createJsonDocument({ file: join(DIR, "rb.json"), log: () => {} });
    await rb.save({ gen: "row" });
    writeFileSync(join(DIR, "rb.json"), JSON.stringify({ gen: "rollback" }));
    const later = new Date(Date.now() + 5 * 60_000);
    utimesSync(join(DIR, "rb.json"), later, later);
    const rb2 = createJsonDocument({ file: join(DIR, "rb.json"), log: () => {} });
    ok((await rb2.load()).gen === "rollback" && (await sdb.documents.get("rb.json")).body.gen === "rollback", "a file newer than its row by more than the grace re-imports and replaces the row");
    const sameAge = createJsonDocument({ file: join(DIR, "sa.json"), log: () => {} });
    await sameAge.save({ gen: "row" });
    writeFileSync(join(DIR, "sa.json"), JSON.stringify({ gen: "stale-write-through" }));
    ok((await createJsonDocument({ file: join(DIR, "sa.json"), log: () => {} }).load()).gen === "row", "a file written within the grace (write-through) does not replace the row");
    const mergedFirst = createJsonDocument({ file: join(DIR, "mf.json"), log: () => {} });
    writeFileSync(join(DIR, "mf.json"), JSON.stringify({ old: 1 }));
    const mm = await mergedFirst.mergeKeys({ new: 2 });
    ok(mm.old === 1 && mm.new === 2, "a first mergeKeys imports the file before merging");
  } finally {
    await sdb.__dropStateSchema();
    await sdb.closeStateDb();
  }
} else {
  console.log("SKIP - Postgres half: no STATE_DATABASE_URL_FOR_TEST");
}

rmSync(DIR, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
