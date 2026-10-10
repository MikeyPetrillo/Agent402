#!/usr/bin/env node
// The cutover gate for the money ledgers: the same production SQLite files
// summarized by the modules in FILE mode and, after the import-on-boot, in
// STATE DATABASE mode, side by side. Every figure must match exactly before
// STATE_DATABASE_URL is set on production.
//
//   STATE_DATABASE_URL=postgres://... node scripts/state-cutover-check.js --sales <agent402-sales.db> --refunds <agent402-refunds.db> [--decide <agent402-decide.db>] [--json]
//
// Each mode runs in its own child process (the modules choose their backend at
// import) on its OWN copy of the files in a temp directory, so whatever a
// boot writes (migrations, a cut-off run marked abandoned, write-through)
// never reaches the files given here. The database half uses a throwaway
// schema that is dropped at the end.
//
// Counts and sums can agree while a row is wrong, so the gate also compares
// every row: scripts/state-ledger-checksum.js, the file-mode copy (after its
// boot) against the database half's tables (after theirs). Any differing
// figure or ledger row is a MISMATCH.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ledgerChecksums } from "./state-ledger-checksum.js";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const files = { sales: opt("--sales"), refunds: opt("--refunds"), decide: opt("--decide") };
if (!files.sales || !files.refunds) { console.error("usage: --sales <db> --refunds <db> [--decide <db>]"); process.exit(2); }
for (const [k, f] of Object.entries(files)) if (f && !existsSync(f)) { console.error(`${k}: ${f} does not exist`); process.exit(2); }
const url = String(process.env.STATE_DATABASE_URL || "").trim();
if (!url) { console.error("STATE_DATABASE_URL is required (a scratch database; a throwaway schema is used and dropped)"); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const child = resolve(here, "lib", "cutover-summary.mjs");
const schema = `cutover_${randomBytes(4).toString("hex")}`;
const work = mkdtempSync(join(tmpdir(), "a402-cutover-"));
// A copy of the files per mode: the refund ledger is found by directory, the
// others by path. A SQLite sidecar (-wal) is copied with its file.
function copyFor(mode) {
  const d = join(work, mode);
  mkdirSync(d, { recursive: true });
  const out = {};
  for (const [k, f] of Object.entries(files)) {
    if (!f) continue;
    const name = k === "refunds" ? "agent402-refunds.db" : basename(f);
    for (const sfx of ["", "-wal"]) if (existsSync(resolve(f) + sfx)) copyFileSync(resolve(f) + sfx, join(d, name + sfx));
    out[k] = join(d, name);
  }
  return out;
}
function run(mode, copy) {
  const env = {
    ...process.env,
    CUTOVER_MODE: mode,
    SALES_LEDGER_DB: copy.sales,
    REFUND_DB_DIR: dirname(copy.refunds),
    ...(copy.decide ? { DECIDE_LEDGER_DB: copy.decide } : {}),
    FREE_MODE: "true",
  };
  if (mode === "file") { delete env.STATE_DATABASE_URL; delete env.STATE_DB_SCHEMA; }
  else { env.STATE_DATABASE_URL = url; env.STATE_DB_SCHEMA = schema; env.CUTOVER_KEEP_SCHEMA = "1"; }
  const r = spawnSync(process.execPath, [child, copy.decide ? "with-decide" : "no-decide"], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${mode} mode failed:\n${(r.stderr || "").slice(-2000)}`);
  const line = r.stdout.split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}
async function cleanup() {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (e) { console.error(`could not drop ${schema}: ${e.message}`); }
  finally { await c.end().catch(() => {}); }
  rmSync(work, { recursive: true, force: true });
}
let fileSide, dbSide, checksums = [];
try {
  const fileCopy = copyFor("file");
  fileSide = run("file", fileCopy);
  dbSide = run("pg", copyFor("pg"));
  // Row for row: the file-mode copy (booted) against the database half's tables.
  try { checksums = await ledgerChecksums({ files: fileCopy, url, schema }); }
  catch (e) { checksums = [{ name: "checksum", equal: false, note: String(e?.message || e).slice(0, 200) }]; }
} catch (e) {
  console.error(String(e?.message || e));
  await cleanup();
  process.exit(1);
}
await cleanup();

// Compare every leaf; report each path once.
const diffs = [];
function walk(a, b, path = "") {
  if (a !== null && typeof a === "object" && b !== null && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ path, file: a, database: b });
}
walk({ ...fileSide, mode: undefined }, { ...dbSide, mode: undefined });
const badRows = checksums.filter((x) => !x.equal);
if (args.includes("--json")) console.log(JSON.stringify({ schema, file: fileSide, database: dbSide, diffs, checksums }, null, 2));
else {
  const show = (label, o) => { console.log(`\n== ${label}`); for (const [k, v] of Object.entries(o)) console.log(`${k}: ${JSON.stringify(v)}`); };
  show("file mode", fileSide);
  show("state database mode (after import-on-boot)", dbSide);
  console.log("\n== ledger rows (file against table)");
  const { printChecksums } = await import("./state-ledger-checksum.js");
  printChecksums(checksums);
  const ok = diffs.length === 0 && badRows.length === 0;
  console.log(`\n${ok ? "MATCH: every figure and every ledger row equal on both copies" : `MISMATCH: ${diffs.length} figure(s) and ${badRows.length} ledger table(s) differ`}`);
  for (const d of diffs) console.log(`  ${d.path}: file=${JSON.stringify(d.file)} database=${JSON.stringify(d.database)}`);
}
process.exit(diffs.length || badRows.length ? 1 : 0);
