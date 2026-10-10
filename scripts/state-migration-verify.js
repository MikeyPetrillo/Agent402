#!/usr/bin/env node
// Verify a state-database import against the files it came from: for every
// store, the row count in the file (SQLite table, record directory, JSON
// document, NDJSON lines) beside the row count in the state tables, so a
// migration is proven complete store by store, not by one happy log line.
//
//   STATE_DATABASE_URL=... STATE_DB_SCHEMA=<the schema the boot imported into> \
//     node scripts/state-migration-verify.js --data <dir the files live in> [--allow-lazy]
//
// Exit 1 on any store whose counts differ (an unexpired-only table, such as
// the proof-of-work replay set, compares against the file's unexpired rows),
// on a known store whose file is missing from --data while its table holds
// rows, and on a document that is read lazily and has no row yet ("NOT
// IMPORTED": the boot never ran the feature that imports it; --allow-lazy
// accepts those and still prints them). Counts only: the money ledgers are
// compared row for row by scripts/state-ledger-checksum.js.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { stateDb, stateDbSchema, stateQuery, documents, records, logLines, imports, closeStateDb } from "../src/state-db.js";
import { SQLITE_STORES, RECORD_DIRS, LOG_FILES, INDEX_CACHE } from "./lib/state-stores.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dataDir = opt("--data");
const allowLazy = args.includes("--allow-lazy");
if (!dataDir || !existsSync(dataDir)) { console.error("usage: --data <dir>"); process.exit(2); }
if (!(await stateDb())) { console.error("STATE_DATABASE_URL is required"); process.exit(2); }
const S = stateDbSchema();
const count = async (table, where = "") => Number((await stateQuery(`SELECT count(*)::bigint AS n FROM ${S}.${table} ${where}`)).rows[0].n);
const sqliteCount = (file, table, where = "") => { const db = new Database(file, { readonly: true }); try { return db.prepare(`select count(*) c from "${table}" ${where}`).get().c; } finally { db.close(); } };
const sqliteTables = (file) => { const db = new Database(file, { readonly: true }); try { return db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((r) => r.name); } finally { db.close(); } };

const rows = [];
const check = (store, file, fileCount, tableCount, note = "") => rows.push({ store, file, fileCount, tableCount, ok: fileCount === tableCount || fileCount == null, note });
const f = (name) => join(dataDir, name);
const has = (name) => existsSync(f(name));

// ---- SQLite ledgers: every table ----------------------------------------------
// The replay set (agent402-pow.db) is compared on its unexpired rows below.
const sqliteMap = Object.fromEntries(SQLITE_STORES.filter((x) => x.file !== "agent402-pow.db").map((x) => [x.file, x.tables]));
// A known store with no file in --data: reported, never skipped. A table
// holding rows with no file to have come from is a difference.
const tableRows = async (t) => { try { return await count(t); } catch { return null; } };
async function reportMissing(store, part, rowsInTable) {
  rows.push({ store, file: part, fileCount: null, tableCount: rowsInTable, ok: !rowsInTable, note: rowsInTable ? "file missing from --data, table has rows" : "file missing from --data, table empty" });
}
for (const [file, map] of Object.entries(sqliteMap)) {
  if (!has(file)) {
    const transient = new Set(((SQLITE_STORES.find((x) => x.file === file) || {}).transient || []).map((t) => map[t]));
    let n = 0; for (const t of Object.values(map)) if (!transient.has(t)) n += (await tableRows(t)) || 0;
    await reportMissing(file, "(file)", n);
    continue;
  }
  const tables = sqliteTables(f(file));
  const spec = SQLITE_STORES.find((x) => x.file === file) || {};
  for (const t of tables) {
    const pg = map[t];
    // Retry ids expire on their own and are never imported: not compared.
    if ((spec.transient || []).includes(t)) { rows.push({ store: file, file: t, fileCount: sqliteCount(f(file), t), tableCount: pg ? await tableRows(pg) : null, ok: true, note: "transient (expires), not imported" }); continue; }
    // Rows still queued for the database: the import is complete only when none are.
    if ((spec.queues || []).includes(t)) { const n = sqliteCount(f(file), t); rows.push({ store: file, file: t, fileCount: n, tableCount: null, ok: n === 0, note: n ? "rows still queued for the database" : "queue empty" }); continue; }
    if (!pg && /_meta$|^meta$/.test(t)) continue; // a settings row, not data
    if (!pg) { rows.push({ store: file, file: t, fileCount: sqliteCount(f(file), t), tableCount: null, ok: false, note: "no table mapping" }); continue; }
    let where = "";
    try { check(file, t, sqliteCount(f(file), t), await count(pg)); }
    catch (e) { rows.push({ store: file, file: t, fileCount: sqliteCount(f(file), t), tableCount: null, ok: false, note: String(e.message).slice(0, 80) }); }
  }
}
// The replay set: the file keeps expired rows the import skips.
if (!has("agent402-pow.db")) await reportMissing("agent402-pow.db", "(file)", (await tableRows("pow_used")) || 0);
else {
  const now = Date.now();
  const live = sqliteCount(f("agent402-pow.db"), "pow_used", `where exp > ${now}`);
  const all = sqliteCount(f("agent402-pow.db"), "pow_used");
  try { check("agent402-pow.db", "pow_used (unexpired)", live, await count("pow_used"), `${all} rows in the file, ${all - live} expired`); } catch (e) { rows.push({ store: "agent402-pow.db", file: "pow_used", fileCount: live, tableCount: null, ok: false, note: e.message.slice(0, 80) }); }
}
// ---- record directories ----------------------------------------------------
const TASK_TTL_MS = 60 * 60_000; // task handles expire after an hour; expired files are not imported
for (const { dir, collection } of RECORD_DIRS) {
  if (!has(dir) || !statSync(f(dir)).isDirectory()) { await reportMissing(dir + "/", "(directory)", await records.count(collection)); continue; }
  let files = readdirSync(f(dir)).filter((x) => x.endsWith(".json") && !x.endsWith(".tmp"));
  let note = collection;
  if (collection === "mcp-tasks" || collection === "async-jobs") { const live = files.filter((x) => Date.now() - statSync(join(f(dir), x)).mtimeMs < TASK_TTL_MS); note = `${files.length - live.length} expired handle(s) not imported`; files = live; }
  check(dir + "/", `${files.length} json files`, files.length, await records.count(collection), note);
}
// ---- JSON documents: one row per file ------------------------------------------
// Documents a boot reads only when their feature first runs: no row after a
// boot that never ran it is expected, not a loss (the import happens then).
const LAZY = {
  "leaderboard-funding.json": "read at the first seller scan", "leaderboard-history.json": "read by the trending tool", "tempo-transfers.json": "read at the first MPP leaderboard refresh",
  "tweet-queue-state.json": "a read-only boot never imports its own file", "submitted-seeds.json": "fixed /data path, read by the crawler", "origin-successions.json": "fixed /data path, read by the crawler",
  "removed-origins.json": "fixed /data path, read by the crawler", "x402-gone-routes.json": "fixed /data path, read by the crawler", "mpp-subscriptions.json": "needs the MPP subscriptions engine",
  "stripe-subscriptions.json.webhooks.json": "needs the Stripe engine", "monitor-runs.json": "needs the Stripe engine", "email-status.json": "read at the first send or status read",
};
const docFiles = readdirSync(dataDir).filter((x) => x.endsWith(".json") && statSync(f(x)).isFile());
for (const x of docFiles) {
  const row = await documents.get(x);
  const fileBody = (() => { try { return JSON.parse(readFileSync(f(x), "utf8")); } catch { return undefined; } })();
  const sizeOf = (v) => (v && typeof v === "object" ? (Array.isArray(v) ? v.length : Object.keys(v).length) : (v === undefined ? null : 1));
  if (fileBody === undefined) { rows.push({ store: x, file: "unparseable", fileCount: null, tableCount: row ? 1 : 0, ok: false, note: "file is not JSON" }); continue; }
  const mark = await imports.done(x);
  const lazy = !row && LAZY[x];
  rows.push({ store: x, file: `top-level size ${sizeOf(fileBody)}`, fileCount: sizeOf(fileBody), tableCount: row ? sizeOf(row.body) : null, ok: (!!row && sizeOf(row.body) === sizeOf(fileBody)) || (!!lazy && allowLazy), lazy: !!lazy, note: row ? (mark ? "imported" : "row, no mark") : lazy ? `NOT IMPORTED (lazy: ${lazy})` : "NO ROW" });
}
// ---- append logs --------------------------------------------------------------
for (const { file, stream } of LOG_FILES) {
  if (!has(file)) { await reportMissing(file, "(file)", await logLines.count(stream)); continue; }
  const valid = readFileSync(f(file), "utf8").split("\n").filter(Boolean).filter((l) => { try { const r = JSON.parse(l); return r && typeof r === "object"; } catch { return false; } }).length;
  check(file, "valid lines", valid, await logLines.count(stream));
}
// ---- the crawl cache: one row per origin ----------------------------------------
// The NDJSON file's first line is a header ({savedAt, format, origins}), not
// an origin; every following line is one [origin, entry] pair, counted the way
// the importer accepts it.
const isEntry = (e) => Array.isArray(e) && typeof e[0] === "string" && e[0] && e[1] && typeof e[1] === "object";
if (has(INDEX_CACHE.file) || has("x402-index-cache.json")) {
  let n = 0;
  if (has(INDEX_CACHE.file)) {
    const lines = readFileSync(f(INDEX_CACHE.file), "utf8").split("\n").filter(Boolean);
    n = lines.slice(1).filter((l) => { try { return isEntry(JSON.parse(l)); } catch { return false; } }).length;
  } else { try { const j = JSON.parse(readFileSync(f("x402-index-cache.json"), "utf8")); n = Array.isArray(j?.entries) ? j.entries.filter(isEntry).length : 0; } catch { n = null; } }
  check("x402-index-cache", "origins", n, await records.count(INDEX_CACHE.collection));
} else await reportMissing("x402-index-cache", "(file)", await records.count(INDEX_CACHE.collection));

const bad = rows.filter((r) => !r.ok);
const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(pad("store", 36) + pad("part", 32) + pad("file", 10) + pad("table", 10) + "ok  note");
for (const r of rows) console.log(pad(r.store, 36) + pad(r.file, 32) + pad(r.fileCount, 10) + pad(r.tableCount, 10) + (r.ok ? "ok  " : "NO  ") + r.note);
console.log(`\n${rows.length} parts checked, ${bad.length} differ`);
await closeStateDb();
process.exit(bad.length ? 1 : 0);
