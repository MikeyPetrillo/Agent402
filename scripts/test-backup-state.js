// The nightly backup covers the state database (src/backup.js stateTables /
// stageStateTable) and scripts/state-restore.js brings a table back: rows in,
// NDJSON out, rows back into a fresh schema, equal. Requires STATE_DATABASE_URL
// (CI fails without it).
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-backup-state" });
const sdb = await import("../src/state-db.js");
const { stateTables, stageStateTable } = await import("../src/backup.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "backup-state-"));
try {
  await sdb.documents.put("a.json", { x: 1, nested: { y: [1, 2] } });
  await sdb.documents.put("b.json", "plain string body");
  await sdb.records.put("c", "r1", { n: 1 }); await sdb.records.put("c", "r2", { n: 2 });
  await sdb.logLines.append("s", { k: 1 }); await sdb.logLines.append("s", { k: 2 });
  await sdb.leases.acquire("L", { owner: "x", ttlMs: 60_000 });
  await sdb.imports.mark("a.json", { source: "/data/a.json", bytes: 10 });
  const tables = await stateTables();
  ok(["documents", "imports", "leases", "log_lines", "records"].every((t) => tables.includes(t)), `stateTables lists the schema's tables (${tables.join(",")})`);

  const gz = join(DIR, "documents.ndjson.gz");
  const n = await stageStateTable("documents", gz, { pageRows: 1 });
  const text = gunzipSync(readFileSync(gz)).toString("utf8");
  const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok(n === 2 && rows.length === 2, "stageStateTable writes one JSON object per row, paging through the table");
  ok(rows.some((r) => r.name === "a.json" && r.body.nested.y[1] === 2 && r.version === 1) && rows.some((r) => r.name === "b.json" && r.body === "plain string body"), "rows carry every column, bodies intact");
  let threw = false; try { await stageStateTable("bad;name", join(DIR, "x.gz")); } catch { threw = true; }
  ok(threw, "a table name outside the allowed shape is refused");

  const recGz = join(DIR, "records.ndjson.gz"); const recN = await stageStateTable("records", recGz);
  const logGz = join(DIR, "log_lines.ndjson.gz"); const logN = await stageStateTable("log_lines", logGz);
  ok(recN === 2 && logN === 2, "records and log lines stage too");

  // Restore after a wipe: same rows come back; a second restore adds nothing.
  const { restoreStateTable } = await import("./state-restore.js");
  const docText = text, recText = gunzipSync(readFileSync(recGz)).toString("utf8"), logText = gunzipSync(readFileSync(logGz)).toString("utf8");
  for (const tb of ["documents", "records", "log_lines"]) await sdb.stateQuery(`TRUNCATE ${sdb.stateDbSchema()}.${tb}`);
  ok((await sdb.documents.list()).length === 0, "the tables are empty before the restore");
  const r1 = await restoreStateTable("documents", docText);
  ok(r1.restored === 2 && r1.skipped === 0, "restore inserts every document row");
  const a = await sdb.documents.get("a.json");
  ok(a && a.body.nested.y[1] === 2 && a.version === 1, "a restored document reads back whole, version kept");
  const r2 = await restoreStateTable("documents", docText);
  ok(r2.restored === 0 && r2.skipped === 2, "a second restore adds nothing (ON CONFLICT DO NOTHING)");
  const r3 = await restoreStateTable("records", recText); const r4 = await restoreStateTable("log_lines", logText);
  ok(r3.restored === 2 && r4.restored === 2 && (await sdb.records.get("c", "r2")).n === 2 && (await sdb.logLines.count("s")) === 2, "records and log lines restore");
  const r5 = await restoreStateTable("documents", docText, { replace: true });
  ok(r5.restored === 2 && (await sdb.documents.list()).length === 2, "--replace truncates then restores");
  let bad = false; try { await restoreStateTable("no_such_table", "{}"); } catch { bad = true; }
  ok(bad, "a missing table is an error, not a silent no-op");
} finally {
  try { await sdb.__dropStateSchema(); } catch { /* already dropped */ }
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
