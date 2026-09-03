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
// Download the object first (any S3 client), then run this on the file. Restore
// order for a full volume rebuild: stop the app, write agent402-refunds.db and
// agent402-sales.db, unbundle credits/ and human-checkout/, write the JSON
// stores, start the app. Dependency-free on purpose: a restore must not need
// npm install to succeed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { decryptBackupBuffer, parseEncKey } from "../src/backup.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!file || !existsSync(file)) { console.error("usage: node scripts/backup-restore.js <object-file> [--out <path>] [--unbundle <dir>]"); process.exit(2); }

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
if (name.endsWith(".ndjson")) {
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
  writeFileSync(out, buf);
  console.log(`restored ${buf.length} bytes to ${out}`);
}
