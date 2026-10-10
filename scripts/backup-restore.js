#!/usr/bin/env node
// Restore one backup object produced by src/backup.js.
//
//   node scripts/backup-restore.js <object-file> [--out <path>] [--unbundle <dir>]
//
// Handles every object shape the nightly run writes:
//   <name>.gz            plain gzip (runs before BACKUP_ENCRYPTION_KEY was set)
//   <name>.gz.enc        AES-256-GCM (A402ENC1) around the gzip; needs BACKUP_ENCRYPTION_KEY
//   <dir>.ndjson.gz[.enc] a directory store bundle: {"path","body"} per line; --unbundle writes
//                         every record back under <dir>/ (credits/, human-checkout/)
//
//   state/<table>.ndjson.gz[.enc] and state/_schema.json.gz[.enc]
//                         the state database (STATE_DATABASE_URL): handed to
//                         scripts/state-restore.js, which puts the rows back
//                         into the database (it needs npm install: it uses pg)
//
// Download the object first (any S3 client), then run this on the file. A
// state object is recognised by its path (a .../state/ directory, as the
// bucket lays it out, or a state- prefix) or by --state; --state-dir <dir>
// restores a whole day's state/ directory (schema first, then every table).
//
// A full rebuild has two halves, in this order, with the app stopped:
//   1. the state database: node scripts/backup-restore.js --state-dir <day>/state
//      (or STATE_DATABASE_URL=... node scripts/state-restore.js --dir <day>/state)
//   2. the volume files, only for a build that still runs on them: write
//      agent402-refunds.db and agent402-sales.db, unbundle credits/ and
//      human-checkout/, write the JSON stores
// then start the app. The volume half is dependency-free on purpose: a file
// restore must not need npm install to succeed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { decryptBackupBuffer, parseEncKey } from "../src/backup.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith("--") && !["--out", "--unbundle", "--state-dir"].includes(args[i - 1]));
const usage = "usage: node scripts/backup-restore.js <object-file> [--out <path>] [--unbundle <dir>] [--state] | --state-dir <dir>";

// The state database half: delegated to scripts/state-restore.js.
const isStateObject = (f) => args.includes("--state") || /(^|\/)state\/[^/]+$/.test(resolve(f)) || /^state-/.test(basename(f)) || /^_schema\.json/.test(basename(f));
if (opt("--state-dir") || (file && existsSync(file) && isStateObject(file))) {
  const sr = await import("./state-restore.js");
  const sdb = await import("../src/state-db.js");
  if (!sdb.stateDbEnabled()) { console.error("STATE_DATABASE_URL is required to restore a state/ object"); process.exit(2); }
  try {
    if (opt("--state-dir")) {
      const r = await sr.restoreStateDir(opt("--state-dir"), { replace: args.includes("--replace"), log: (m) => console.log(m) });
      console.log(`restored ${r.tables.length} state table(s) into ${sdb.stateDbSchema()}`);
    } else {
      const { name, buf } = sr.readStateObject(file);
      const table = sr.tableOfObject(name);
      if (table === "_schema") { const r = await sr.restoreStateSchema(JSON.parse(buf.toString("utf8"))); console.log(`schema: ${r.tables} table(s) in place`); }
      else { const r = await sr.restoreStateTable(table, buf.toString("utf8"), { replace: args.includes("--replace") }); console.log(`restored ${r.restored} row(s) into ${sdb.stateDbSchema()}.${table}${r.skipped ? ` (${r.skipped} already present)` : ""}`); }
    }
  } catch (e) { console.error(String(e?.message || e)); process.exitCode = 1; }
  await sdb.closeStateDb();
  process.exit();
}
if (!file || !existsSync(file)) { console.error(usage); process.exit(2); }

let buf = readFileSync(file);
let name = basename(file);
if (name.endsWith(".enc")) {
  const key = parseEncKey(process.env.BACKUP_ENCRYPTION_KEY);
  if (!key) { console.error("BACKUP_ENCRYPTION_KEY (64 hex or base64, 32 bytes) is required for a .enc object"); process.exit(2); }
  buf = decryptBackupBuffer(buf, key);
  name = name.slice(0, -4);
}
if (name.endsWith(".gz")) { buf = gunzipSync(buf); name = name.slice(0, -3); }

const unbundle = opt("--unbundle");
// A directory bundle and a plain .ndjson FILE store (outbound-spend.ndjson)
// share the suffix, so the name cannot decide. The content does: a bundle is
// one {"path","body"} record per line. Deciding by name alone restored a
// 176-line ledger as "0 records" (restore drill, 2026-10-06).
const isBundle = (b) => {
  const lines = b.toString("utf8").split("\n").filter((l) => l.trim());
  if (!lines.length) return true; // an empty directory bundles to nothing
  try { return lines.every((l) => { const r = JSON.parse(l); return r && typeof r === "object" && "path" in r && "body" in r; }); }
  catch { return false; }
};
if (name.endsWith(".ndjson") && !opt("--out") && (unbundle || isBundle(buf))) {
  const target = unbundle || name.slice(0, -7);
  mkdirSync(target, { recursive: true });
  let n = 0;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const rel = String(rec.path || "").replace(/^[^/]+\//, "");
    if (!rel || rel.includes("..") || rel.includes("/")) continue; // one level, no traversal
    writeFileSync(join(target, rel), String(rec.body ?? ""));
    n++;
  }
  console.log(`restored ${n} record(s) into ${target}/`);
} else {
  const out = opt("--out") || name;
  mkdirSync(dirname(out) || ".", { recursive: true });
  // A SQLite file restored beside a stale -wal or -shm sidecar from an earlier
  // process reads as a corrupt or empty database (the sidecars belong to the
  // old file, not this one); remove them before the write.
  for (const sfx of ["-wal", "-shm", "-journal"]) {
    if (existsSync(out + sfx)) { unlinkSync(out + sfx); console.log(`removed stale ${basename(out + sfx)}`); }
  }
  writeFileSync(out, buf);
  console.log(`restored ${buf.length} bytes to ${out}`);
}
