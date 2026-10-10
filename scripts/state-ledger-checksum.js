#!/usr/bin/env node
// Row-level checksum of the money ledgers: every row of each SQLite file (or
// record directory, or NDJSON log) beside every row of its state table,
// canonicalised, sorted and hashed. Counts and sums can agree while a column
// is truncated, re-typed, rounded or swapped between rows; this cannot.
//
//   STATE_DATABASE_URL=... STATE_DB_SCHEMA=<schema> node scripts/state-ledger-checksum.js --data <dir>
//   ... [--sales f] [--refunds f] [--decide f] [--revenue f] [--shadow f] [--credits dir] [--checkout dir] [--outbound f] [--wishes f] [--json]
//
// --data picks every ledger it finds in a volume-shaped directory; a flag
// names one file and wins over --data. Exit 1 when any ledger differs.
//
// Canonical values: SQL NULL -> null; every integer (a bigint from either
// side) -> its decimal text; a REAL / double -> its shortest round-trip text
// prefixed "f:" unless integral; a boolean -> 1 / 0; a JSON value (a jsonb
// column, or JSON text in a SQLite column a jsonb column mirrors) -> keys
// sorted at every level. A SQLite column is compared with the state column
// of the same name, or its snake_case form (createdAt -> created_at); a
// SQLite column with no state column is itself a difference (it would be lost).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { SQLITE_STORES, RECORD_DIRS, LOG_FILES } from "./lib/state-stores.mjs";

// The ledgers that carry money or a buyer's balance.
export const MONEY_SQLITE = { sales: "agent402-sales.db", refunds: "agent402-refunds.db", decide: "agent402-decide.db", revenue: "agent402-revenue.db", shadow: "agent402-stripe-shadow.db" };
export const MONEY_DIRS = { credits: "credits", checkout: "human-checkout" };
export const MONEY_LOGS = { outbound: "outbound-spend.ndjson", wishes: "wishes.jsonl" };

const snake = (c) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const num = (n) => (Number.isInteger(n) ? String(n) : `f:${n}`);
const jsonCanon = (v) => JSON.stringify(sortKeys(v));
function canon(v, { json = false } = {}) {
  if (v === null || v === undefined) return null;
  if (json) {
    if (typeof v === "string") { try { return jsonCanon(JSON.parse(v)); } catch { return `s:${v}`; } }
    return jsonCanon(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return num(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `b:${v.toString("hex")}`;
  return String(v);
}
const md5 = (lines) => createHash("md5").update(lines.join("\n")).digest("hex");
function compare(name, a, b, note = "") {
  a.sort(); b.sort();
  const ha = md5(a), hb = md5(b);
  let firstDiff = null;
  if (ha !== hb) {
    const sa = new Set(a), sb = new Set(b);
    const onlyFile = a.find((x) => !sb.has(x)), onlyTable = b.find((x) => !sa.has(x));
    firstDiff = { file: onlyFile?.slice(0, 300) ?? null, table: onlyTable?.slice(0, 300) ?? null };
  }
  return { name, rowsFile: a.length, rowsTable: b.length, md5File: ha, md5Table: hb, equal: ha === hb && !note, firstDiff, note };
}

/** Compare every listed ledger. `files` maps a ledger key to its path. */
export async function ledgerChecksums({ files, url = process.env.STATE_DATABASE_URL, schema = process.env.STATE_DB_SCHEMA || "state" } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error(`bad schema "${schema}"`);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const S = schema;
  const results = [];
  try {
    const pgCols = async (table) => (await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [S, table])).rows;
    async function sqliteVsTable(name, file, sTable, pTable) {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      db.defaultSafeIntegers(true);
      try {
        const sCols = db.prepare(`PRAGMA table_info("${sTable}")`).all().map((c) => c.name);
        if (!sCols.length) return results.push({ name, equal: true, rowsFile: 0, rowsTable: null, note: `no ${sTable} table in the file`, skipped: true });
        const typ = Object.fromEntries((await pgCols(pTable)).map((r) => [r.column_name, r.data_type]));
        if (!Object.keys(typ).length) return results.push(compare(name, [], [], `no ${S}.${pTable} table`));
        const pairs = sCols.map((c) => [c, c in typ ? c : snake(c) in typ ? snake(c) : null]);
        const missing = pairs.filter(([, p]) => !p).map(([c]) => c);
        const used = pairs.filter(([, p]) => p);
        const isJson = (p) => /^jsonb?$/.test(typ[p]);
        const a = db.prepare(`SELECT ${used.map(([c]) => `"${c}"`).join(", ")} FROM "${sTable}"`).all()
          .map((row) => JSON.stringify(used.map(([c, p]) => canon(row[c], { json: isJson(p) }))));
        const r = await pool.query({ text: `SELECT ${used.map(([, p]) => `"${p}"`).join(", ")} FROM ${S}.${pTable}`, rowMode: "array" });
        const b = r.rows.map((row) => JSON.stringify(row.map((v, i) => {
          const p = used[i][1], t = typ[p];
          if (v === null) return null;
          if (/^(bigint|integer|smallint)$/.test(t)) return String(BigInt(v));
          if (t === "double precision" || t === "real") return num(Number(v));
          return canon(v, { json: isJson(p) });
        })));
        results.push(compare(name, a, b, missing.length ? `file columns with no state column: ${missing.join(", ")}` : ""));
      } finally { db.close(); }
    }
    const storeOf = (fileName) => SQLITE_STORES.find((s) => s.file === fileName);
    for (const [key, fileName] of Object.entries(MONEY_SQLITE)) {
      const f = files[key];
      if (!f) continue;
      for (const [sTable, pTable] of Object.entries(storeOf(fileName).tables)) await sqliteVsTable(`${key}.${sTable}`, f, sTable, pTable);
    }
    for (const [key, dirName] of Object.entries(MONEY_DIRS)) {
      const dir = files[key];
      if (!dir) continue;
      const spec = RECORD_DIRS.find((d) => d.dir === dirName);
      const a = [];
      for (const f of readdirSync(dir)) {
        const id = spec.idOf(f);
        if (!id) continue;
        let body; try { body = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { a.push(JSON.stringify([id, "unparseable"])); continue; }
        a.push(JSON.stringify([id, sortKeys(body)]));
      }
      const r = await pool.query(`SELECT id, body FROM ${S}.records WHERE collection = $1`, [spec.collection]);
      results.push(compare(`${dirName} records`, a, r.rows.map((x) => JSON.stringify([x.id, sortKeys(x.body)]))));
    }
    for (const [key, fileName] of Object.entries(MONEY_LOGS)) {
      const file = files[key];
      if (!file) continue;
      const stream = LOG_FILES.find((l) => l.file === fileName).stream;
      // In order: the log's order is part of the record.
      const a = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { const o = JSON.parse(l); return o && typeof o === "object" ? JSON.stringify(sortKeys(o)) : null; } catch { return null; } }).filter(Boolean);
      const r = await pool.query(`SELECT body FROM ${S}.log_lines WHERE stream = $1 ORDER BY id`, [stream]);
      const b = r.rows.map((x) => JSON.stringify(sortKeys(x.body)));
      const at = (x, i) => `${String(i).padStart(9, "0")} ${x}`; // the position is part of the row
      results.push(compare(`${fileName} log`, a.map(at), b.map(at)));
    }
  } finally { await pool.end(); }
  return results;
}

/** The ledger files a volume-shaped directory holds, by key. */
export function ledgerFilesIn(dir) {
  const out = {};
  if (!dir) return out;
  for (const [k, f] of Object.entries({ ...MONEY_SQLITE, ...MONEY_LOGS })) if (existsSync(join(dir, f))) out[k] = join(dir, f);
  for (const [k, d] of Object.entries(MONEY_DIRS)) if (existsSync(join(dir, d)) && statSync(join(dir, d)).isDirectory()) out[k] = join(dir, d);
  return out;
}

export function printChecksums(results, log = console.log) {
  for (const r of results) {
    log(`${r.skipped ? "SKIP  " : r.equal ? "EQUAL " : "DIFFER"}  ${r.name.padEnd(30)} rows ${String(r.rowsFile).padStart(8)} / ${String(r.rowsTable ?? "-").padStart(8)}${r.md5File ? `  md5 ${r.md5File} / ${r.md5Table}` : ""}${r.note ? `  (${r.note})` : ""}${r.firstDiff ? `\n        file only : ${r.firstDiff.file}\n        table only: ${r.firstDiff.table}` : ""}`);
  }
  const bad = results.filter((r) => !r.equal).length;
  log(`\n${results.length} ledger table(s) compared, ${bad} differ`);
  return bad;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  if (!String(process.env.STATE_DATABASE_URL || "").trim()) { console.error("STATE_DATABASE_URL is required"); process.exit(2); }
  const files = ledgerFilesIn(opt("--data"));
  for (const k of [...Object.keys(MONEY_SQLITE), ...Object.keys(MONEY_DIRS), ...Object.keys(MONEY_LOGS)]) if (opt(`--${k}`)) files[k] = opt(`--${k}`);
  for (const [k, f] of Object.entries(files)) if (!existsSync(f)) { console.error(`${k}: ${f} does not exist`); process.exit(2); }
  if (!Object.keys(files).length) { console.error("no ledger named: --data <dir> or --sales/--refunds/..."); process.exit(2); }
  const results = await ledgerChecksums({ files });
  if (args.includes("--json")) { console.log(JSON.stringify(results, null, 2)); process.exit(results.some((r) => !r.equal) ? 1 : 0); }
  process.exit(printChecksums(results) ? 1 : 0);
}
