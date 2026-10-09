#!/usr/bin/env node
// The cutover gate for the money ledgers: the same production SQLite files
// summarized by the modules in FILE mode and, after the import-on-boot, in
// STATE DATABASE mode, side by side. Every figure must match exactly before
// STATE_DATABASE_URL is set on production.
//
//   STATE_DATABASE_URL=postgres://... node scripts/state-cutover-check.js --sales <agent402-sales.db> --refunds <agent402-refunds.db> [--decide <agent402-decide.db>] [--json]
//
// Each mode runs in its own child process (the modules choose their backend at
// import), with a throwaway schema for the database half that is dropped at
// the end. Nothing is written to the files: the import opens them read-only,
// and write-through is off (STATE_WRITE_THROUGH=off) so the restored copies
// stay pristine for a second run.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
function run(mode) {
  const env = {
    ...process.env,
    CUTOVER_MODE: mode,
    SALES_LEDGER_DB: resolve(files.sales),
    REFUND_DB_DIR: dirname(resolve(files.refunds)),
    ...(files.decide ? { DECIDE_LEDGER_DB: resolve(files.decide) } : {}),
    STATE_WRITE_THROUGH: "off",
    FREE_MODE: "true",
  };
  if (mode === "file") { delete env.STATE_DATABASE_URL; delete env.STATE_DB_SCHEMA; }
  else { env.STATE_DATABASE_URL = url; env.STATE_DB_SCHEMA = schema; }
  const r = spawnSync(process.execPath, [child, files.decide ? "with-decide" : "no-decide"], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { console.error(`${mode} mode failed:\n${(r.stderr || "").slice(-2000)}`); process.exit(1); }
  const line = r.stdout.split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}
const fileSide = run("file");
const dbSide = run("pg");

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
if (args.includes("--json")) console.log(JSON.stringify({ schema, file: fileSide, database: dbSide, diffs }, null, 2));
else {
  const show = (label, o) => { console.log(`\n== ${label}`); for (const [k, v] of Object.entries(o)) console.log(`${k}: ${JSON.stringify(v)}`); };
  show("file mode", fileSide);
  show("state database mode (after import-on-boot)", dbSide);
  console.log(`\n${diffs.length === 0 ? "MATCH: every figure equal on both copies" : `MISMATCH: ${diffs.length} figure(s) differ`}`);
  for (const d of diffs) console.log(`  ${d.path}: file=${JSON.stringify(d.file)} database=${JSON.stringify(d.database)}`);
}
process.exit(diffs.length ? 1 : 0);
