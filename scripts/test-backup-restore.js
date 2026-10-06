#!/usr/bin/env node
// scripts/backup-restore.js must give back what the nightly backup stored, for
// every object shape it writes. Found by a restore drill (2026-10-06): a plain
// FILE store whose name ends in .ndjson (outbound-spend.ndjson) was read as a
// directory bundle and restored as "0 records", with exit code 0.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptBackupBuffer, parseEncKey } from "../src/backup.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const dir = mkdtempSync(join(tmpdir(), "restore-test-"));
const keyHex = randomBytes(32).toString("hex");
const key = parseEncKey(keyHex);
const restore = (file, extra = []) => execFileSync("node", ["scripts/backup-restore.js", file, ...extra], { env: { ...process.env, BACKUP_ENCRYPTION_KEY: keyHex }, encoding: "utf8" });

try {
  // 1. A plain .ndjson FILE store (not a bundle), encrypted like production.
  const ledger = Array.from({ length: 5 }, (_, i) => JSON.stringify({ at: `2026-10-0${i + 1}`, chain: "base", usd: 0.01 * i, tx: `0x${i}` })).join("\n") + "\n";
  const encFile = join(dir, "outbound-spend.ndjson.gz.enc");
  writeFileSync(encFile, encryptBackupBuffer(gzipSync(Buffer.from(ledger)), key));
  const out1 = join(dir, "outbound-spend.ndjson");
  restore(encFile, ["--out", out1]);
  ok(readFileSync(out1, "utf8") === ledger, "an .ndjson file store restores byte-for-byte with --out");
  rmSync(out1, { recursive: true, force: true });
  const msg = execFileSync("node", [join(process.cwd(), "scripts/backup-restore.js"), encFile], { cwd: dir, env: { ...process.env, BACKUP_ENCRYPTION_KEY: keyHex }, encoding: "utf8" });
  ok(readFileSync(join(dir, "outbound-spend.ndjson"), "utf8") === ledger && /bytes/.test(msg), "...and without --out it is recognised as a file by its content, not unbundled");

  // 2. A real directory bundle still unbundles.
  const bundle = [{ path: "credits/a.json", body: '{"k":1}' }, { path: "credits/b.json", body: '{"k":2}' }].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const encBundle = join(dir, "credits.ndjson.gz.enc");
  writeFileSync(encBundle, encryptBackupBuffer(gzipSync(Buffer.from(bundle)), key));
  const into = join(dir, "credits-out");
  restore(encBundle, ["--unbundle", into]);
  ok(readdirSync(into).sort().join(",") === "a.json,b.json" && readFileSync(join(into, "b.json"), "utf8") === '{"k":2}', "a directory bundle still unbundles every record");

  // 3. A plain database-style object round-trips.
  const blob = randomBytes(4096);
  const encDb = join(dir, "agent402-sales.db.gz.enc");
  writeFileSync(encDb, encryptBackupBuffer(gzipSync(blob), key));
  const out3 = join(dir, "sales.db");
  restore(encDb, ["--out", out3]);
  ok(Buffer.compare(readFileSync(out3), blob) === 0, "a binary object restores byte-for-byte");
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
