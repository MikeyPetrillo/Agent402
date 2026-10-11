// The wish board on a REAL Postgres (src/wish.js with STATE_DATABASE_URL):
//   1. the file import is one transaction with its mark: a process killed
//      (SIGKILL) at any point of its first boot leaves either nothing or the
//      whole file, so the next boot holds exactly the file's line count;
//   2. a wish carrying NUL (or a lone surrogate) is stored, cleaned, and the
//      board keeps it;
//   3. one bad line never empties the board: a file line the stream cannot
//      take, and stored rows that are not wish records, are skipped while
//      the rest of the board is rebuilt.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-wish-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = new URL("..", import.meta.url).pathname;
const DIR = mkdtempSync(join(tmpdir(), "wish-pg-"));
const pg = (await import("pg")).default;
const sql = async (text, params = []) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await c.query(text, params); } finally { await c.end(); } };

// ---- 1. import once, all or nothing, across SIGKILL ----------------------------
const N = 30_000;
const FILE = join(DIR, "wishes-import.jsonl");
writeFileSync(FILE, Array.from({ length: N }, (_, i) => JSON.stringify({ need: `need number ${i % 900}`, source: "api", ts: 1_700_000_000_000 + i })).join("\n") + "\n");
const bootCode = `
  const w = await import("./src/wish.js");
  console.log("READY " + (await w.wishStoreReady()));
  const { logLines } = await import("./src/state-db.js");
  console.log("COUNT " + (await logLines.count("wishes")));
  process.exit(0);
`;
function boot(sch, { killAfterMs = null } = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", bootCode], { cwd: ROOT, env: { ...process.env, STATE_DATABASE_URL: url, STATE_DB_SCHEMA: sch, WISH_FILE: FILE } });
    let out = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t0 = Date.now();
    const k = killAfterMs === null ? null : setTimeout(() => c.kill("SIGKILL"), killAfterMs);
    const hard = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.on("exit", (code, sig) => { if (k) clearTimeout(k); clearTimeout(hard); res({ out, sig, ms: Date.now() - t0 }); });
  });
}
const lines = async (sch) => Number((await sql(`SELECT count(*)::bigint AS n FROM ${sch}.log_lines WHERE stream = 'wishes'`)).rows[0].n);
{
  // How long an uninterrupted first boot takes, so the kill points span it.
  const sch = `t_w_${randomBytes(4).toString("hex")}`;
  const full = await boot(sch);
  ok(/COUNT 30000/.test(full.out), `an uninterrupted first boot imports every line (${(full.out.match(/COUNT \d+/) || ["?"])[0]}, ${full.ms} ms)`);
  await sql(`DROP SCHEMA IF EXISTS ${sch} CASCADE`);
  const span = Math.max(400, full.ms);
  const points = [0.35, 0.5, 0.65, 0.8, 0.95].map((f) => Math.round(span * f));
  for (const at of points) {
    const s2 = `t_w_${randomBytes(4).toString("hex")}`;
    const killed = await boot(s2, { killAfterMs: at });
    const mid = await lines(s2).catch(() => 0);
    const again = await boot(s2);
    const after = await lines(s2);
    ok(after === N && (mid === 0 || mid === N), `SIGKILL ${at} ms into the first boot (${killed.sig || "exited"}): ${mid} line(s) then, ${after} after the next boot (want 0 or ${N}, then ${N})`);
    await sql(`DROP SCHEMA IF EXISTS ${s2} CASCADE`);
  }
}

// ---- 2 and 3: in this process ------------------------------------------------------
const FILE2 = join(DIR, "wishes.jsonl");
process.env.WISH_FILE = FILE2;
const sdb = await import("../src/state-db.js");
const w = await import("../src/wish.js");
const total = () => w.getWishesAggregate().totalWishes;
try {
  ok(await w.wishStoreReady(), "the board loads on an empty stream");
  w.recordWish({ need: "image to text\u0000please", source: "api", ip: "203.0.113.7" });
  w.recordWish({ need: "lone \ud800 surrogate tool", source: "api", ip: "203.0.113.7" });
  ok(await w.wishFlush(), "a wish carrying NUL and one carrying a lone surrogate are appended");
  const rows = (await sdb.logLines.tail("wishes", 10)).map((r) => r.body.need);
  ok(rows.includes("image to textplease") && rows.some((x) => /^lone .* surrogate tool$/.test(x)), `both are stored, cleaned (${JSON.stringify(rows)})`);
  w.__testReset();
  ok((await w.wishStoreReady()) && total() === 2, `after a rebuild the board holds both (total ${total()})`);

  // A line the stream cannot take, in the file past the stream (an earlier
  // build wrote it through to the file after its append failed): the board
  // is still rebuilt from the stream.
  appendFileSync(FILE2, JSON.stringify({ need: "x", source: "api", ts: 1 }) + "\n" + JSON.stringify({ need: "y", source: "api", ts: 2 }) + "\n");
  appendFileSync(FILE2, '{"need":"bad \\u0000 line","source":"api","ts":3}\n');
  w.__testReset();
  ok((await w.wishStoreReady()) && total() >= 2, `a file line the stream refused does not empty the board (total ${total()})`);

  // Stored rows that are not wish records.
  for (const body of ['"just a string"', '{"need": 5}', "[1, 2]", "null", `{"need": "valid after junk", "source": "mcp", "ts": ${Date.now()}}`]) {
    await sdb.stateQuery(`INSERT INTO ${schema}.log_lines (stream, body) VALUES ('wishes', $1::jsonb)`, [body]);
  }
  w.__testReset();
  const loaded = await w.wishStoreReady();
  const agg = w.getWishesAggregate({ detailed: true });
  ok(loaded && total() >= 3 && agg.clusters.some((c) => c.text === "valid after junk"), `rows that are not wish records are skipped, the rest is the board (total ${total()})`);

  // ---- 4. retention on the stream ----------------------------------------------
  {
    const DAY = 86_400_000, now = Date.now();
    const oldTs = now - (w.WISH_RETENTION_DEFAULT_DAYS + 20) * DAY;
    const oldRows = Array.from({ length: 4 }, (_, i) => ({ need: "Ancient Private Need", context: "ancient context", source: "api", ts: oldTs + i, caller: `a${i}` }));
    for (const body of oldRows) await sdb.stateQuery(`INSERT INTO ${schema}.log_lines (stream, body) VALUES ('wishes', $1::jsonb)`, [JSON.stringify(body)]);
    // The write-through file holds the same old lines (it is rewritten too).
    appendFileSync(FILE2, oldRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    w.__testReset(); await w.wishStoreReady();
    const pubBefore = JSON.stringify(w.getWishesAggregate());
    const detBefore = w.getWishesAggregate({ detailed: true, limit: 500 });
    const r = await w.rotateWishes({ now });
    const bodies = (await sql(`SELECT body FROM ${schema}.log_lines WHERE stream = 'wishes' ORDER BY id`)).rows.map((x) => x.body);
    const flat = JSON.stringify(bodies);
    ok(r.removed >= 4 && !/ancient private need|ancient context/i.test(flat), `rotation deletes the old rows from the stream (${r.removed} removed)`);
    ok(bodies.filter((b) => b?.type === "rollup").length === 1, "one rollup row replaces them");
    ok(!/ancient/i.test(readFileSync(FILE2, "utf8")), "the write-through file is rewritten without them");
    ok(JSON.stringify(w.getWishesAggregate()) === pubBefore, "the public beacon is unchanged");
    const detAfter = w.getWishesAggregate({ detailed: true, limit: 500 });
    ok(detAfter.totalWishes === detBefore.totalWishes && detAfter.distinctClusters === detBefore.distinctClusters, "the operator totals are unchanged");
    // A rebuild (which also runs the file roll-forward) brings nothing back.
    w.__testReset(); await w.wishStoreReady();
    const again = JSON.stringify((await sql(`SELECT body FROM ${schema}.log_lines WHERE stream = 'wishes'`)).rows.map((x) => x.body));
    ok(!/ancient/i.test(again) && JSON.stringify(w.getWishesAggregate()) === pubBefore, "a rebuild with the file roll-forward resurrects no rotated line and keeps the counts");
    w.recordWish({ need: "ancient private need", source: "mcp", ip: "203.0.113.50" });
    await w.wishFlush();
    const back = w.getWishesAggregate({ detailed: true, limit: 500 }).clusters.find((c) => c.text === "ancient private need");
    ok(back && back.count === 5, `a new wish with the same text merges with its rolled-up history (${back?.count})`);
    const r2 = await w.rotateWishes({ now });
    ok(r2.removed === 0, "a second rotation with nothing past the window changes nothing");
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-wish-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
