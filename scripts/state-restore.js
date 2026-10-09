#!/usr/bin/env node
// Restore one state-table object produced by src/backup.js (backups/<day>/
// state/<table>.ndjson.gz[.enc]) into the state database.
//
//   STATE_DATABASE_URL=... node scripts/state-restore.js <object-file> [--table <name>] [--replace]
//
// Decrypts and gunzips like scripts/backup-restore.js, then inserts every
// line (one row_to_json object per line) into state.<table> with
// INSERT ... ON CONFLICT DO NOTHING, so a restore over an existing table adds
// only the rows it lacks; --replace truncates the table first. The table name
// comes from the object name (state-<table>.ndjson or <table>.ndjson) unless
// --table says otherwise. Restore order does not matter: the tables have no
// foreign keys. Run with the app stopped, or accept that rows written since
// the backup stay (DO NOTHING never overwrites them).
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { decryptBackupBuffer, parseEncKey } from "../src/backup.js";
import { stateDb, stateDbSchema, stateDbEnabled, stateQuery, closeStateDb } from "../src/state-db.js";

const isMain = process.argv[1] && new URL(import.meta.url).pathname === (await import("node:path")).resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (!file || !existsSync(file)) { console.error("usage: STATE_DATABASE_URL=... node scripts/state-restore.js <object-file> [--table <name>] [--replace]"); process.exit(2); }
  if (!stateDbEnabled()) { console.error("STATE_DATABASE_URL is not set"); process.exit(2); }
  let buf = readFileSync(file);
  let name = basename(file);
  if (name.endsWith(".enc")) {
    const key = parseEncKey(process.env.BACKUP_ENCRYPTION_KEY);
    if (!key) { console.error("BACKUP_ENCRYPTION_KEY is required for a .enc object"); process.exit(2); }
    buf = decryptBackupBuffer(buf, key);
    name = name.slice(0, -4);
  }
  if (name.endsWith(".gz")) { buf = gunzipSync(buf); name = name.slice(0, -3); }
  const table = opt("--table") || name.replace(/\.ndjson$/, "").replace(/^state-/, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) { console.error(`bad table name "${table}"`); process.exit(2); }
  const { restored, skipped } = await restoreStateTable(table, buf.toString("utf8"), { replace: args.includes("--replace") });
  console.log(`restored ${restored} row(s) into ${stateDbSchema()}.${table}${skipped ? ` (${skipped} already present)` : ""}`);
  await closeStateDb();
}

/** Insert every NDJSON row into the table; exported for the test. */
export async function restoreStateTable(tableName, text, { replace = false } = {}) {
  if (!(await stateDb())) throw new Error("state database not configured");
  const T = `${stateDbSchema()}.${tableName}`;
  const colRows = (await stateQuery("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [stateDbSchema(), tableName])).rows;
  const cols = colRows.map((c) => c.column_name);
  const jsonCols = new Set(colRows.filter((c) => /^jsonb?$/.test(c.data_type)).map((c) => c.column_name));
  if (!cols.length) throw new Error(`table ${T} does not exist; boot the app once so the schema exists, then restore`);
  if (replace) await stateQuery(`TRUNCATE ${T}`);
  let restored = 0, skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const keys = cols.filter((c) => c in row);
    // A json column takes its value re-encoded whatever the JSON type (a bare
    // string body is JSON too); every other column takes the value as is.
    const vals = keys.map((k) => (jsonCols.has(k) ? JSON.stringify(row[k]) : row[k]));
    const r = await stateQuery(`INSERT INTO ${T} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`, vals);
    if (r.rowCount > 0) restored++; else skipped++;
  }
  return { restored, skipped };
}
