#!/usr/bin/env node
// Restore state-database objects produced by src/backup.js (backups/<day>/
// state/<table>.ndjson.gz[.enc] and backups/<day>/state/_schema.json.gz[.enc])
// into the state database.
//
//   STATE_DATABASE_URL=... node scripts/state-restore.js --dir <dir with the day's state/ objects> [--replace]
//   STATE_DATABASE_URL=... node scripts/state-restore.js <object-file> [--table <name>] [--replace]
//
// --dir restores a whole day: the schema object first (it creates every
// table, its constraints and indexes, so an EMPTY database needs no app boot
// first), then every table object. A single object restores one table; the
// table must exist (from a schema object or a boot).
//
// Each object is decrypted (BACKUP_ENCRYPTION_KEY) and gunzipped like
// scripts/backup-restore.js; every line is one row_to_json object and goes in
// with INSERT ... SELECT FROM json_populate_recordset ... ON CONFLICT DO
// NOTHING, so Postgres itself parses every value: a bigint above 2^53, a
// numeric or a jsonb body comes back exactly. A restore over an existing
// table adds only the rows it lacks; --replace truncates the table first.
// After each table every serial or identity column's sequence is advanced
// past the largest restored value, so the next insert never collides with a
// restored row. The table name comes from the object name (state-<table>.ndjson
// or <table>.ndjson) unless --table says otherwise. Restore order does not
// matter: the tables have no foreign keys. Run with the app stopped, or
// accept that rows written since the backup stay (DO NOTHING never
// overwrites them).
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { decryptBackupBuffer, parseEncKey } from "../src/backup.js";
import { stateDb, stateDbSchema, stateDbEnabled, stateQuery, closeStateDb } from "../src/state-db.js";

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const BATCH = 1000;

/** Decrypt (when .enc) and gunzip (when .gz) one object file. */
export function readStateObject(file, key = parseEncKey(process.env.BACKUP_ENCRYPTION_KEY)) {
  let buf = readFileSync(file);
  let name = basename(file);
  if (name.endsWith(".enc")) {
    if (!key) throw new Error(`BACKUP_ENCRYPTION_KEY is required for ${name}`);
    buf = decryptBackupBuffer(buf, key);
    name = name.slice(0, -4);
  }
  if (name.endsWith(".gz")) { buf = gunzipSync(buf); name = name.slice(0, -3); }
  return { name, buf };
}
/** "state-refunds.ndjson" or "refunds.ndjson" -> "refunds"; the schema object -> "_schema". */
export const tableOfObject = (name) => name.replace(/\.(ndjson|json)$/, "").replace(/^state-/, "");

const schemaOf = (schema) => {
  const s = schema || stateDbSchema();
  if (!SCHEMA_RE.test(s)) throw new Error(`bad schema name "${s}"`);
  return s;
};

/** Create the schema, every table, constraint and index the schema object
 *  describes (CREATE ... IF NOT EXISTS: a table already there is kept). */
export async function restoreStateSchema(doc, { schema } = {}) {
  if (!(await stateDb())) throw new Error("state database not configured");
  const S = schemaOf(schema);
  if (doc?.format !== "a402-state-schema-v1" || !Array.isArray(doc.tables)) throw new Error("not an a402 state schema object");
  await stateQuery(`CREATE SCHEMA IF NOT EXISTS ${S}`);
  const fill = (sql) => sql.split("{{schema}}").join(S);
  let created = 0;
  for (const t of doc.tables) {
    if (!TABLE_RE.test(String(t.name))) throw new Error(`bad table name "${t.name}" in the schema object`);
    await stateQuery(fill(t.create));
    for (const ix of t.indexes || []) await stateQuery(fill(ix));
    created++;
  }
  return { tables: created };
}

/** Advance every serial or identity column's sequence past the table's
 *  largest value (never backwards), so the next default insert is new. */
export async function advanceSequences(tableName, { schema } = {}) {
  const S = schemaOf(schema);
  const rel = `${S}.${tableName}`;
  const cols = (await stateQuery(
    "SELECT column_name, pg_get_serial_sequence($1, column_name) AS seq FROM information_schema.columns WHERE table_schema = $2 AND table_name = $3",
    [rel, S, tableName],
  )).rows.filter((r) => r.seq);
  const out = [];
  for (const { column_name: col, seq } of cols) {
    const q = `"${col.replace(/"/g, '""')}"`;
    const r = await stateQuery(
      `SELECT setval($1::regclass, GREATEST(COALESCE((SELECT max(${q}) FROM ${rel}), 0), s.last_value - CASE WHEN s.is_called THEN 0 ELSE 1 END, 1),
                     COALESCE((SELECT max(${q}) FROM ${rel}), 0) >= 1 OR s.is_called) AS v
         FROM ${seq} s`,
      [seq],
    );
    out.push({ column: col, sequence: seq, value: String(r.rows[0].v) });
  }
  return out;
}

/** Insert every NDJSON row into the table, then advance its sequences. */
export async function restoreStateTable(tableName, text, { replace = false, schema } = {}) {
  if (!(await stateDb())) throw new Error("state database not configured");
  if (!TABLE_RE.test(tableName)) throw new Error(`bad table name "${tableName}"`);
  const S = schemaOf(schema);
  const T = `${S}.${tableName}`;
  const cols = new Set((await stateQuery("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [S, tableName])).rows.map((c) => c.column_name));
  if (!cols.size) throw new Error(`table ${T} does not exist; restore the day's _schema object first (--dir does), or boot the app once`);
  if (replace) await stateQuery(`TRUNCATE ${T}`);
  let restored = 0, skipped = 0;
  // Rows are batched by their column set (row_to_json writes every column, so
  // a whole object is one batch). The line is handed to Postgres as text and
  // only its KEYS are read here.
  let batch = [], sig = null, keys = null;
  const flush = async () => {
    if (!batch.length) return;
    const list = keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(", ");
    const r = await stateQuery(`INSERT INTO ${T} (${list}) OVERRIDING SYSTEM VALUE SELECT ${list} FROM json_populate_recordset(NULL::${T}, $1::json) ON CONFLICT DO NOTHING`, [`[${batch.join(",")}]`]);
    restored += r.rowCount; skipped += batch.length - r.rowCount;
    batch = [];
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`a line in ${tableName} is not a row object`);
    const k = Object.keys(row).filter((c) => cols.has(c));
    const s = k.join("\u0000");
    if (s !== sig || batch.length >= BATCH) { await flush(); sig = s; keys = k; }
    batch.push(line);
  }
  await flush();
  const sequences = await advanceSequences(tableName, { schema: S });
  return { restored, skipped, sequences };
}

/** Restore a day's state objects from one directory: schema first, then every table. */
export async function restoreStateDir(dir, { replace = false, schema, key = parseEncKey(process.env.BACKUP_ENCRYPTION_KEY), log = () => {} } = {}) {
  const files = readdirSync(dir).filter((f) => /\.(ndjson|json)\.gz(\.enc)?$/.test(f) || /\.(ndjson|json)$/.test(f));
  const isSchema = (f) => tableOfObject(readName(f)) === "_schema";
  const schemaFile = files.find(isSchema);
  let created = 0;
  if (schemaFile) {
    const { buf } = readStateObject(join(dir, schemaFile), key);
    created = (await restoreStateSchema(JSON.parse(buf.toString("utf8")), { schema })).tables;
    log(`schema: ${created} table(s) in place`);
  } else log("no _schema object in the directory: every table must already exist");
  const tables = [];
  for (const f of files.filter((x) => !isSchema(x)).sort()) {
    const { name, buf } = readStateObject(join(dir, f), key);
    const table = tableOfObject(name);
    if (!TABLE_RE.test(table) || table === "leases") continue;
    const r = await restoreStateTable(table, buf.toString("utf8"), { replace, schema });
    log(`${table}: restored ${r.restored} row(s)${r.skipped ? ` (${r.skipped} already present)` : ""}${r.sequences.length ? `, sequence ${r.sequences.map((x) => `${x.column}=${x.value}`).join(", ")}` : ""}`);
    tables.push({ table, ...r });
  }
  return { schemaTables: created, tables };
}
const readName = (f) => f.replace(/\.enc$/, "").replace(/\.gz$/, "");

const isMain = process.argv[1] && new URL(import.meta.url).pathname === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const usage = "usage: STATE_DATABASE_URL=... node scripts/state-restore.js --dir <dir> [--replace] | <object-file> [--table <name>] [--replace]";
  if (!stateDbEnabled()) { console.error("STATE_DATABASE_URL is not set"); process.exit(2); }
  try {
    if (opt("--dir")) {
      const dir = opt("--dir");
      if (!existsSync(dir)) { console.error(usage); process.exit(2); }
      const r = await restoreStateDir(dir, { replace: args.includes("--replace"), log: (m) => console.log(m) });
      console.log(`restored ${r.tables.length} table(s) into ${stateDbSchema()}`);
    } else {
      const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--table");
      if (!file || !existsSync(file)) { console.error(usage); process.exit(2); }
      const { name, buf } = readStateObject(file);
      if (tableOfObject(name) === "_schema") {
        const r = await restoreStateSchema(JSON.parse(buf.toString("utf8")));
        console.log(`schema: ${r.tables} table(s) in place in ${stateDbSchema()}`);
      } else {
        const table = opt("--table") || tableOfObject(name);
        if (!TABLE_RE.test(table)) { console.error(`bad table name "${table}"`); process.exit(2); }
        const { restored, skipped, sequences } = await restoreStateTable(table, buf.toString("utf8"), { replace: args.includes("--replace") });
        console.log(`restored ${restored} row(s) into ${stateDbSchema()}.${table}${skipped ? ` (${skipped} already present)` : ""}${sequences.length ? `; sequence ${sequences.map((x) => `${x.column}=${x.value}`).join(", ")}` : ""}`);
      }
    }
  } catch (e) { console.error(String(e?.message || e)); process.exitCode = 1; }
  await closeStateDb();
}
