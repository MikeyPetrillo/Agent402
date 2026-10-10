// The nightly backup with the state database on, against a stub S3 on port 0:
//   - no volume (BACKUP_DATA_DIR names a directory that does not exist, which
//     is what /data is once the volume is removed): every state table still
//     goes up and the run is a success
//   - the state tables are staged and uploaded BEFORE the volume files, so a
//     large volume file never spends the run budget the database needed
//   - a state table the run could not upload (held) is not a clean success:
//     lastError names it, lastHeldState lists it, lastSuccess does not move
//   - a run that held a state table, or could not snapshot the database at
//     all, prunes no older day: those days may hold the only good copy
//   - backupAlarmStatus() is the one word the gateway status publishes
//   - the documents table is read one row per FETCH (a row is a whole store)
// Requires STATE_DATABASE_URL (CI fails without it).
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-backup-no-volume-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const objects = new Map();
const stub = createServer((req, res) => {
  const ch = [];
  req.on("data", (c) => ch.push(c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const key = decodeURIComponent(u.pathname.replace(/^\/b\/?/, ""));
    if (req.method === "PUT") { objects.set(key, Buffer.concat(ch)); res.writeHead(200).end(); }
    else if (req.method === "GET") {
      const prefix = u.searchParams.get("prefix") || "";
      const xml = ['<?xml version="1.0"?><ListBucketResult>'];
      for (const [k, v] of objects) if (k.startsWith(prefix)) xml.push(`<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`);
      xml.push("</ListBucketResult>");
      res.writeHead(200).end(xml.join(""));
    } else { objects.delete(key); res.writeHead(204).end(); }
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const SCRATCH = mkdtempSync(join(tmpdir(), "backup-novol-"));
Object.assign(process.env, {
  BACKUP_S3_ENDPOINT: `http://127.0.0.1:${stub.address().port}`, BACKUP_S3_BUCKET: "b", BACKUP_S3_KEY_ID: "k", BACKUP_S3_SECRET: "s",
  BACKUP_DATA_DIR: join(SCRATCH, "no-such-volume"),
});
delete process.env.BACKUP_ENCRYPTION_KEY;
const { runBackup, backupStatus, backupAlarmStatus } = await import("../src/backup.js");
// Every FETCH page size, by the table its cursor reads.
const fetches = [];
{
  const q = pg.Client.prototype.query;
  let cursorTable = null;
  pg.Client.prototype.query = function (text, ...rest) {
    const t = typeof text === "string" ? text : text?.text;
    if (typeof t === "string") {
      const d = /DECLARE a402_backup_cur .* FROM \S+\.(\w+) t$/.exec(t);
      if (d) cursorTable = d[1];
      const f = /^FETCH (\d+) FROM a402_backup_cur/.exec(t);
      if (f) fetches.push({ table: cursorTable, n: Number(f[1]) });
    }
    return q.call(this, text, ...rest);
  };
}
const oldDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const plantOld = () => { objects.set(`backups/${oldDay}/state/sales.ndjson.gz`, Buffer.from("older good copy")); objects.set(`backups/${oldDay}/state/refunds.ndjson.gz`, Buffer.from("older good copy")); };
const oldLeft = () => [...objects.keys()].filter((k) => k.startsWith(`backups/${oldDay}/`)).length;
const sdb = await import("../src/state-db.js");
const S = sdb.stateDbSchema();
const stateKeys = () => [...objects.keys()].filter((k) => k.includes("/state/"));
try {
  await sdb.documents.put("followups.json", { seqs: { a: 1 } });
  await sdb.documents.put("second.json", { b: 2 });
  await sdb.documents.put("third.json", { c: 3 });
  await sdb.records.put("credits", "k_1", { balanceMicro: 5 });
  await sdb.logLines.append("outbound-spend", { usd: 0.01 });

  // 1. No volume: the state tables still go up, and the run succeeds.
  const r1 = await runBackup({ log: () => {} });
  ok(r1.ok === true, `no data dir is an empty file plan, not a failure (${JSON.stringify(r1).slice(0, 160)})`);
  for (const t of ["documents", "records", "log_lines", "imports"]) ok(stateKeys().some((k) => k.endsWith(`/state/${t}.ndjson.gz`)), `state/${t} uploaded with no volume`);
  const docObj = objects.get(stateKeys().find((k) => k.endsWith("/state/documents.ndjson.gz")));
  ok(docObj && gunzipSync(docObj).toString().includes("followups.json"), "the documents object carries the row");
  ok(stateKeys().some((k) => k.endsWith("/state/_schema.json.gz")), "the schema object goes up beside the tables (a restore needs no boot)");
  const st1 = backupStatus();
  ok(st1.lastError === null && Boolean(st1.lastSuccess) && Array.isArray(st1.lastHeldState) && st1.lastHeldState.length === 0, "status: success, no error, nothing held");
  ok(backupAlarmStatus() === "ok", `the alarm word after a clean run is ok (${backupAlarmStatus()})`);
  const docFetches = fetches.filter((f) => f.table === "documents");
  ok(docFetches.length >= 4 && docFetches.every((f) => f.n === 1), `the documents table is read one row per FETCH (${JSON.stringify(docFetches.slice(0, 3))})`);
  ok(fetches.some((f) => f.table === "log_lines" && f.n === 5000), "a table of small rows keeps the full page");

  // 2. State first: a volume file that alone nearly fills the run budget must
  // not push the state tables out of it.
  objects.clear();
  const data = join(SCRATCH, "data");
  (await import("node:fs")).mkdirSync(data);
  // The volume file fits the 16 MB cap on its own with ~100 KB to spare; the
  // documents table carries ~150 KB compressed, so whichever goes first wins.
  writeFileSync(join(data, "bulk.bin"), randomBytes(16 * 1024 * 1024 - 100 * 1024));
  await sdb.documents.put("big.json", { blob: randomBytes(150 * 1024).toString("base64") });
  process.env.BACKUP_DATA_DIR = data; process.env.BACKUP_MAX_RUN_MB = "16";
  const r2 = await runBackup({ log: () => {} });
  ok(!(r2.held || []).some((h) => h.name.startsWith("state/")), `no state table held when a volume file competes for the budget (${JSON.stringify(r2.held)})`);
  ok((r2.held || []).some((h) => h.name === "bulk.bin"), "the volume file is the one held");
  ok(stateKeys().some((k) => k.endsWith("/state/documents.ndjson.gz")), "state tables uploaded under the tight budget");

  // 3. A state table held over budget: not a clean success.
  objects.clear();
  rmSync(join(data, "bulk.bin"));
  await sdb.stateQuery(`DELETE FROM ${S}.documents WHERE name = $1`, ["big.json"]);
  const before = backupStatus().lastSuccess;
  await sdb.stateQuery(`CREATE TABLE ${S}.bulk_blob (id INT PRIMARY KEY, v TEXT NOT NULL)`);
  // ~40 MB of hex: gzip leaves it well over the 16 MB run cap.
  await sdb.stateQuery(`INSERT INTO ${S}.bulk_blob SELECT g, (SELECT string_agg(md5(random()::text || g || i), '') FROM generate_series(1, 40) i) FROM generate_series(1, 32000) g`);
  await new Promise((r) => setTimeout(r, 5));
  plantOld();
  const r3 = await runBackup({ log: () => {} });
  const st3 = backupStatus();
  ok((r3.held || []).some((h) => h.name === "state/bulk_blob.ndjson"), "the oversize state table is held and named");
  ok(r3.ok === false, "a run with a held state table does not report ok");
  ok(/state/.test(String(st3.lastError || "")) && /bulk_blob/.test(String(st3.lastError || "")), `lastError names the held state table (${st3.lastError})`);
  ok(Array.isArray(st3.lastHeldState) && st3.lastHeldState.includes("state/bulk_blob.ndjson"), "lastHeldState lists it on the operator status");
  ok(st3.lastSuccess === before, "lastSuccess does not move on a run that held a state table");
  ok(stateKeys().some((k) => k.endsWith("/state/documents.ndjson.gz")), "the other state tables still went up");
  ok(r3.pruned === 0 && oldLeft() === 2, `a run that held a state table prunes no older day (pruned ${r3.pruned}, ${oldLeft()} old objects left)`);
  ok(backupAlarmStatus() === "held", `the alarm word after a held state table is held (${backupAlarmStatus()})`);
  await sdb.stateQuery(`DROP TABLE ${S}.bulk_blob`);
  const r3b = await runBackup({ log: () => {} });
  ok(r3b.ok === true && r3b.pruned === 2 && oldLeft() === 0, `the next complete run prunes the older day (pruned ${r3b.pruned})`);
  ok(backupAlarmStatus() === "ok", "...and the alarm word is ok again");

  // 4. The database cannot be snapshotted at all (nothing listens): the run
  // fails and the older days stay. A child process, so its unreachable URL
  // does not touch this process's pool.
  objects.clear();
  plantOld();
  // Async: the stub S3 the child talks to runs on this process's event loop.
  const child = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", `
    const { runBackup, backupAlarmStatus } = await import(${JSON.stringify(new URL("../src/backup.js", import.meta.url).href)});
    const r = await runBackup({ log: () => {} });
    console.log(JSON.stringify({ ok: r.ok, pruned: r.pruned ?? null, heldState: r.heldState ?? null, alarm: backupAlarmStatus() }));
    process.exit(0);`], {
    env: { ...process.env, STATE_DATABASE_URL: "postgres://postgres@127.0.0.1:1/a402?sslmode=disable", STATE_DB_CONNECT_TIMEOUT_MS: "1000", BACKUP_DATA_DIR: join(SCRATCH, "no-such-volume") },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", (d) => { stderr += d; });
    const kill = setTimeout(() => p.kill(), 60_000);
    p.on("close", () => { clearTimeout(kill); resolve({ stdout, stderr }); });
  });
  let r4 = null; try { r4 = JSON.parse(String(child.stdout).trim().split("\n").pop()); } catch { /* reported below */ }
  ok(r4 && r4.ok === false && (r4.heldState || []).includes("state/*"), `a run whose snapshot failed is not ok and names state/* (${String(child.stdout).slice(-200)}${String(child.stderr).slice(-200)})`);
  ok(r4 && !r4.pruned && oldLeft() === 2, `a run whose snapshot failed prunes no older day (${oldLeft()} old objects left)`);
  ok(r4 && r4.alarm === "held", `the alarm word after a failed snapshot is held (${r4?.alarm})`);
} finally {
  try { await sdb.__dropStateSchema(); } catch { /* dropped */ }
  await sdb.closeStateDb();
  stub.close();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
