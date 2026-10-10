// The nightly backup with the state database on, against a stub S3 on port 0:
//   - no volume (BACKUP_DATA_DIR names a directory that does not exist, which
//     is what /data is once the volume is removed): every state table still
//     goes up and the run is a success
//   - the state tables are staged and uploaded BEFORE the volume files, so a
//     large volume file never spends the run budget the database needed
//   - a state table the run could not upload (held) is not a clean success:
//     lastError names it, lastHeldState lists it, lastSuccess does not move
// Requires STATE_DATABASE_URL (CI fails without it).
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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
const { runBackup, backupStatus } = await import("../src/backup.js");
const sdb = await import("../src/state-db.js");
const S = sdb.stateDbSchema();
const stateKeys = () => [...objects.keys()].filter((k) => k.includes("/state/"));
try {
  await sdb.documents.put("followups.json", { seqs: { a: 1 } });
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
  const r3 = await runBackup({ log: () => {} });
  const st3 = backupStatus();
  ok((r3.held || []).some((h) => h.name === "state/bulk_blob.ndjson"), "the oversize state table is held and named");
  ok(r3.ok === false, "a run with a held state table does not report ok");
  ok(/state/.test(String(st3.lastError || "")) && /bulk_blob/.test(String(st3.lastError || "")), `lastError names the held state table (${st3.lastError})`);
  ok(Array.isArray(st3.lastHeldState) && st3.lastHeldState.includes("state/bulk_blob.ndjson"), "lastHeldState lists it on the operator status");
  ok(st3.lastSuccess === before, "lastSuccess does not move on a run that held a state table");
  ok(stateKeys().some((k) => k.endsWith("/state/documents.ndjson.gz")), "the other state tables still went up");
} finally {
  try { await sdb.__dropStateSchema(); } catch { /* dropped */ }
  await sdb.closeStateDb();
  stub.close();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
