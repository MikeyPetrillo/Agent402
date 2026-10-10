// The state backup is one consistent snapshot. Rows are UPDATEd while the
// stage runs (records.put, documents.put and every ON CONFLICT DO UPDATE give
// a row a new physical position), and pairs of rows are written across two
// tables in one transaction. The staged objects must hold every row exactly
// once, and both halves of every pair or neither. Requires STATE_DATABASE_URL
// (CI fails without it).
import pg from "pg";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { requireTestPg } from "./lib/test-pg.js";
const { url } = requireTestPg({ label: "test-backup-stage-concurrent-pg" });
const sdb = await import("../src/state-db.js");
const { stageStateTable, stageStateTables } = await import("../src/backup.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "backup-concurrent-"));
const S = sdb.stateDbSchema();
const N = 12_000;
const c = new pg.Client({ connectionString: url });
const linesOf = (file) => gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
try {
  await sdb.stateDb();
  await c.connect();
  await c.query(`INSERT INTO ${S}.records (collection, id, body) SELECT 'c', 'r' || g, jsonb_build_object('n', g) FROM generate_series(1, ${N}) g`);
  const ids = (await c.query(`SELECT id FROM ${S}.records`)).rows.map((r) => r.id);

  // 1. One table under concurrent updates.
  let stop = false, updates = 0;
  const writer = (async () => {
    while (!stop) {
      const id = ids[Math.floor(Math.random() * ids.length)];
      await c.query(`UPDATE ${S}.records SET body = body, updated_at = now() WHERE collection = 'c' AND id = $1`, [id]);
      updates++;
    }
  })();
  const gz = join(DIR, "records.ndjson.gz");
  const n = await stageStateTable("records", gz, { pageRows: 500 });
  stop = true; await writer;
  const seen = new Map();
  for (const r of linesOf(gz)) seen.set(r.id, (seen.get(r.id) || 0) + 1);
  const dup = [...seen.values()].filter((v) => v > 1).length, missing = ids.filter((k) => !seen.has(k)).length;
  ok(updates > 0, `rows were updated while the table staged (${updates})`);
  ok(n === N && dup === 0 && missing === 0, `every row staged exactly once (lines=${n} distinct=${seen.size} duplicated=${dup} missing=${missing})`);

  // 2. Every table in one snapshot: a pair written across documents and
  // log_lines in one transaction is staged whole or not at all.
  let pairs = 0; stop = false;
  const pairWriter = (async () => {
    while (!stop) {
      const k = ++pairs;
      await c.query("BEGIN");
      await c.query(`INSERT INTO ${S}.documents (name, body) VALUES ($1, '{}'::jsonb)`, [`pair-${k}.json`]);
      await c.query(`INSERT INTO ${S}.log_lines (stream, body) VALUES ('pairs', jsonb_build_object('k', $1::int))`, [k]);
      await c.query("COMMIT");
      // and churn the records table so its stage takes a while
      await c.query(`UPDATE ${S}.records SET updated_at = now() WHERE collection = 'c' AND id = $1`, [ids[k % ids.length]]);
    }
  })();
  const staged = await stageStateTables(DIR, { pageRows: 200, tables: ["documents", "records", "log_lines"] });
  stop = true; await pairWriter;
  const fileOf = (t) => staged.tables.find((x) => x.table === t)?.file;
  const docPairs = new Set(linesOf(fileOf("documents")).map((r) => r.name).filter((x) => x.startsWith("pair-")).map((x) => Number(x.slice(5, -5))));
  const logPairs = new Set(linesOf(fileOf("log_lines")).filter((r) => r.stream === "pairs").map((r) => r.body.k));
  const onlyDoc = [...docPairs].filter((k) => !logPairs.has(k)).length, onlyLog = [...logPairs].filter((k) => !docPairs.has(k)).length;
  ok(pairs > 1, `pairs were written while the tables staged (${pairs})`);
  ok(onlyDoc === 0 && onlyLog === 0, `each pair is in both tables' objects or neither (documents ${docPairs.size}, log ${logPairs.size}, half-pairs ${onlyDoc + onlyLog})`);
  const recSeen = new Set(linesOf(fileOf("records")).map((r) => r.id));
  ok(recSeen.size === N && linesOf(fileOf("records")).length === N, "the records object in the snapshot is complete and has no duplicates");
} finally {
  await c.end().catch(() => {});
  try { await sdb.__dropStateSchema(); } catch { /* dropped */ }
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
