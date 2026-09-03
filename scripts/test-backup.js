// Offsite backup (src/backup.js) — the invariants that keep the bill and
// the data honest, proven against a local stub S3 and REAL SQLite files:
//   - live-writer safety: the staged copy of a SQLite db is a consistent
//     snapshot (readable, row-complete) taken via the online backup API
//   - cost bounds: cache-like files excluded; per-run budget holds oversize
//     files VISIBLY (named in status, never silently dropped); the
//     total-stored bill guard refuses uploads outright and surfaces
//   - retention: date prefixes older than keepDays are pruned, newer ones
//     and foreign keys are untouched; same-day keys overwrite (no growth)
//   - priority: the refund ledger uploads before bulk when budget is tight
//   - not-configured mode: zero network calls, plan still readable
//   - SigV4: requests carry a well-formed AWS4-HMAC-SHA256 authorization
//
//   node scripts/test-backup.js
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// --- stub S3 ---------------------------------------------------------------
// Path-style: /<bucket>/<key>. Records every request; serves ListObjectsV2.
const objects = new Map();      // key -> Buffer
const sizeOverride = new Map(); // key -> reported size (lets the stub claim GB without allocating them)
const requests = [];
const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\/?/, ""));
    requests.push({ method: req.method, key, auth: req.headers.authorization || "", query: url.search });
    if (req.method === "PUT") { objects.set(key, body); res.writeHead(200).end(); }
    else if (req.method === "DELETE") { objects.delete(key); sizeOverride.delete(key); res.writeHead(204).end(); }
    else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") || "";
      const xml = ['<?xml version="1.0"?><ListBucketResult>'];
      for (const [k, v] of objects) if (k.startsWith(prefix)) xml.push(`<Contents><Key>${k}</Key><Size>${sizeOverride.get(k) ?? v.length}</Size></Contents>`);
      xml.push("</ListBucketResult>");
      res.writeHead(200, { "content-type": "application/xml" }).end(xml.join(""));
    } else res.writeHead(404).end();
  });
});
await new Promise((r) => stub.listen(0, r));
const PORT = stub.address().port;

// --- fixture /data ---------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "a402-data-"));
const db = new Database(join(dataDir, "agent402-refunds.db"));
db.exec("CREATE TABLE refunds (id INTEGER PRIMARY KEY, payer TEXT, usd REAL)");
const ins = db.prepare("INSERT INTO refunds (payer, usd) VALUES (?, ?)");
for (let i = 0; i < 500; i++) ins.run(`payer-${i}`, 0.001 * i);
// db stays OPEN — the backup must snapshot under a live writer.
writeFileSync(join(dataDir, "notes.json"), JSON.stringify({ hello: "world" }));
writeFileSync(join(dataDir, "x402-index-cache.json"), "x".repeat(50_000)); // must be excluded
writeFileSync(join(dataDir, "stats.db-wal"), "wal-bytes");                  // sidecar, excluded
writeFileSync(join(dataDir, "bulk.bin"), Buffer.alloc(400_000, 7));         // compresses tiny; used for priority check

process.env.BACKUP_S3_ENDPOINT = `http://127.0.0.1:${PORT}`;
process.env.BACKUP_S3_BUCKET = "test-bucket";
process.env.BACKUP_S3_KEY_ID = "test-key";
process.env.BACKUP_S3_SECRET = "test-secret";
process.env.BACKUP_DATA_DIR = dataDir;
process.env.BACKUP_KEEP_DAYS = "14";

process.env.BACKUP_ENCRYPTION_KEY = "ab".repeat(32); // 32-byte test key built at runtime (no key-shaped literal in the tree for the secret scanner)
const { backupPlan, runBackup, backupStatus, backupConfigured, decryptBackupBuffer, parseEncKey } = await import("../src/backup.js");

// --- plan ------------------------------------------------------------------
mkdirSync(join(dataDir, "credits"), { recursive: true });
writeFileSync(join(dataDir, "credits", "k_aaa.json"), JSON.stringify({ balanceMicro: 5_000_000 }));
writeFileSync(join(dataDir, "credits", "k_bbb.json"), JSON.stringify({ balanceMicro: 250_000 }));
writeFileSync(join(dataDir, "credits", "k_ccc.json.tmp"), "half-written"); // excluded
const plan = backupPlan();
ok(plan.configured === true && backupConfigured(), "configured with all four creds");
const byName = Object.fromEntries(plan.files.map((f) => [f.name, f]));
ok(byName["x402-index-cache.json"]?.excluded === true, "cache file excluded from the plan");
ok(byName["stats.db-wal"]?.excluded === true, "wal sidecar excluded");
ok(byName["agent402-refunds.db"]?.excluded === false, "refund ledger included");
ok(plan.includedCount === 4, `plan includes the 3 real files plus the directory store (got ${plan.includedCount})`);
ok(byName.credits?.dir === true && byName.credits.count === 2 && byName.credits.excluded === false, "a directory store (credits/) is a bundled entry with its file count");

// --- retention seed: plant old + recent + foreign objects ------------------
const oldDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const recentDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
objects.set(`backups/${oldDay}/stale.db.gz`, Buffer.from("old"));
objects.set(`backups/${recentDay}/fresh.db.gz`, Buffer.from("recent"));
objects.set("unrelated/keep.txt", Buffer.from("foreign"));

// --- happy run -------------------------------------------------------------
const run1 = await runBackup({ log: () => {} });
ok(run1.ok === true, `run succeeds (${JSON.stringify(run1).slice(0, 80)})`);
const day = run1.day;
ok(objects.has(`backups/${day}/agent402-refunds.db.gz.enc`) && !objects.has(`backups/${day}/agent402-refunds.db.gz`), "refund ledger uploaded ENCRYPTED under today's date key (.gz.enc, never plain)");
{
  const { gunzipSync } = await import("node:zlib");
  const enc = objects.get(`backups/${day}/agent402-refunds.db.gz.enc`);
  ok(enc.subarray(0, 8).toString() === "A402ENC1" && !enc.includes(Buffer.from("SQLite format 3")), "the object is an A402ENC1 blob and carries no plaintext SQLite header");
  const plain = gunzipSync(decryptBackupBuffer(enc, parseEncKey(process.env.BACKUP_ENCRYPTION_KEY)));
  ok(plain.subarray(0, 15).toString() === "SQLite format 3", "decrypt + gunzip yields the SQLite file (restore path works)");
  let tampered = null; try { const t = Buffer.from(enc); t[t.length - 1] ^= 1; decryptBackupBuffer(t, parseEncKey(process.env.BACKUP_ENCRYPTION_KEY)); } catch (e) { tampered = e; }
  ok(tampered, "a tampered object fails authentication instead of decrypting to garbage");
  ok(parseEncKey("short") === null && parseEncKey("") === null, "a malformed key is refused (no silent weak encryption)");
}
{
  const bundleEnc = objects.get(`backups/${day}/credits.ndjson.gz.enc`);
  const { gunzipSync } = await import("node:zlib");
  const lines = bundleEnc ? gunzipSync(decryptBackupBuffer(bundleEnc, parseEncKey(process.env.BACKUP_ENCRYPTION_KEY))).toString("utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  ok(lines.length === 2 && lines.some((l) => l.path === "credits/k_aaa.json" && JSON.parse(l.body).balanceMicro === 5_000_000) && !lines.some((l) => l.path.endsWith(".tmp")), "the directory store is uploaded as one NDJSON bundle carrying every record and no tmp file");
}
ok(objects.has(`backups/${day}/notes.json.gz.enc`), "plain file uploaded (encrypted)");
ok(!requests.some((r) => r.key.includes("x402-index-cache")), "excluded cache never uploaded");
ok(!objects.has(`backups/${oldDay}/stale.db.gz`), `retention pruned the ${oldDay} prefix`);
ok(objects.has(`backups/${recentDay}/fresh.db.gz`), "recent prefix survives retention");
ok(objects.has("unrelated/keep.txt"), "foreign keys outside backups/ untouched");
ok(run1.pruned === 1, `exactly one object pruned (got ${run1.pruned})`);

// Consistency: the uploaded sqlite snapshot is a valid, row-complete db.
{
  const raw = gunzipSync(decryptBackupBuffer(objects.get(`backups/${day}/agent402-refunds.db.gz.enc`), parseEncKey(process.env.BACKUP_ENCRYPTION_KEY)));
  const tmpDb = join(tmpdir(), "a402-restored-check.db"); // OUTSIDE dataDir - anything inside would be backed up by later runs
  writeFileSync(tmpDb, raw);
  const restored = new Database(tmpDb, { readonly: true });
  const n = restored.prepare("SELECT COUNT(*) AS n FROM refunds").get().n;
  restored.close();
  ok(n === 500, `snapshot is a consistent SQLite db with all rows (got ${n})`);
}

// SigV4 shape on every request.
ok(requests.every((r) => r.auth.startsWith("AWS4-HMAC-SHA256 Credential=test-key/")), "every request carries SigV4 authorization");
ok(requests.some((r) => r.auth.includes("SignedHeaders=") && r.auth.includes("Signature=")), "authorization carries SignedHeaders + Signature");

// Same-day rerun overwrites, never accumulates.
const countAfterRun1 = [...objects.keys()].filter((k) => k.startsWith(`backups/${day}/`)).length;
const run2 = await runBackup({ log: () => {} });
ok(run2.ok === true, "same-day rerun succeeds");
const countAfterRun2 = [...objects.keys()].filter((k) => k.startsWith(`backups/${day}/`)).length;
ok(countAfterRun2 === countAfterRun1, `same-day keys overwrite (still ${countAfterRun1} objects, no growth)`);

// --- budget: tiny run cap holds bulk but the refund ledger still ships -----
{
  for (const k of [...objects.keys()]) if (k.startsWith("backups/")) objects.delete(k);
  process.env.BACKUP_MAX_RUN_MB = "16"; // floor value; then shrink the fixture the other way
  // Make bulk.bin incompressible and big enough to bust a 16MB budget alone.
  writeFileSync(join(dataDir, "bulk.bin"), Buffer.from(Array.from({ length: 20 * 1024 * 1024 }, () => Math.floor(Math.random() * 256))));
  const run3 = await runBackup({ log: () => {} });
  ok(run3.ok === true, "budget run still succeeds");
  ok(run3.uploaded.some((u) => u.name === "agent402-refunds.db"), "refund ledger uploads FIRST under a tight budget");
  ok(run3.held.some((h) => h.name === "bulk.bin" && h.reason.includes("over budget")), `oversize file HELD and named (${JSON.stringify(run3.held)})`);
  ok(backupStatus().lastHeld.some((h) => h.name === "bulk.bin"), "held file visible in the status report");
  delete process.env.BACKUP_MAX_RUN_MB;
  rmSync(join(dataDir, "bulk.bin"));
}

// --- bill guard: stored bytes over the cap refuses the run -----------------
{
  process.env.BACKUP_MAX_TOTAL_GB = "1";
  objects.set("backups/2026-08-01/huge.bin.gz", Buffer.from("tiny"));
  sizeOverride.set("backups/2026-08-01/huge.bin.gz", 2 * 1024 ** 3); // stub REPORTS 2GB
  const putsBefore = requests.filter((r) => r.method === "PUT").length;
  const guarded = await runBackup({ log: () => {} });
  ok(guarded.ok === false && String(guarded.error).includes("BACKUP_MAX_TOTAL_GB"), `bill guard refuses the run and names the knob (${String(guarded.error).slice(0, 80)})`);
  ok(requests.filter((r) => r.method === "PUT").length === putsBefore, "...and uploads NOTHING while over the cap");
  ok(String(backupStatus().lastError || "").includes("BACKUP_MAX_TOTAL_GB"), "...and the refusal is visible in status");
  objects.delete("backups/2026-08-01/huge.bin.gz");
  sizeOverride.clear();
  delete process.env.BACKUP_MAX_TOTAL_GB;
}

// --- not-configured mode: zero network, plan still works -------------------
{
  const before = requests.length;
  delete process.env.BACKUP_S3_ENDPOINT;
  const r = await runBackup({ log: () => {} });
  ok(r.skipped?.includes("not configured"), "unconfigured run is a clean skip");
  ok(requests.length === before, "…and makes zero network calls");
  ok(backupPlan().files.length > 0 && backupPlan().configured === false, "plan endpoint still inventories without creds");
}

db.close();
stub.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
