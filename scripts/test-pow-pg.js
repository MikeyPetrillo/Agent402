// The proof-of-work replay table against a REAL Postgres (STATE_DATABASE_URL
// set). Two module instances with their own local files stand in for two
// containers sharing the table:
//   1. the local SQLite file's unexpired rows are imported once at the first
//      boot with the database on, marked, and not imported again;
//   2. a challenge one container accepts is written to the table;
//   3. the invariant: a solved challenge is accepted once; one the OTHER
//      container accepted is refused here within the challenge TTL once the
//      refresh has run, in both directions, with a fresh solve as the control;
//      and the window the design leaves (both accept before either refreshes)
//      is counted, not hidden.
// verifySolution stays synchronous throughout: the gate in src/server.js
// calls it inline.
// Requires STATE_DATABASE_URL (CI fails without it; locally it skips).
//
//   node scripts/test-pow-pg.js
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-pow-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const dir = mkdtempSync(join(tmpdir(), "a402-pow-pg-"));
const FILE_A = join(dir, "pow-a.db");
const FILE_B = join(dir, "pow-b.db");
process.env.POW_SECRET = "pow-pg-test-secret";
process.env.POW_DIFFICULTY = "8";
process.env.POW_ALLOW_EPHEMERAL = "true";
process.env.POW_PG_REFRESH_MS = "60000"; // the test pulls by hand; the timer must not race it
const S = () => `${process.env.STATE_DB_SCHEMA}.pow_used`;
const dbCount = async () => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${S()}`)).rows[0].n);
const nowSec = () => Math.floor(Date.now() / 1000);
const seedLocal = (file, rows) => {
  const g = new Database(file);
  g.exec("CREATE TABLE IF NOT EXISTS pow_used (challenge TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
  const ins = g.prepare("INSERT OR IGNORE INTO pow_used (challenge, exp) VALUES (?, ?)");
  for (const r of rows) ins.run(r.challenge, r.exp);
  g.close();
};
function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) { if (byte === 0) { bits += 8; continue; } bits += Math.clz32(byte) - 24; break; }
  return bits;
}
function solve(ch) {
  for (let n = 0; n < 5_000_000; n++) {
    if (leadingZeroBits(createHash("sha256").update(`${ch.challenge}:${n}`).digest()) >= ch.difficulty) return `${ch.token}:${n}`;
  }
  throw new Error("solver gave up");
}

try {
  // ---- 1. import once ---------------------------------------------------------
  seedLocal(FILE_A, [{ challenge: "a".repeat(32), exp: nowSec() + 200 }, { challenge: "b".repeat(32), exp: nowSec() - 10 }]);
  process.env.POW_DB_PATH = FILE_A;
  const a = await import("../src/pow.js");
  ok(await a.powReplayReady(), "container A: the shared replay store loads");
  const mark = await sdb.imports.done("pow-a.db");
  ok(mark && mark.source === FILE_A, "container A: the import is marked under the file's basename");
  ok((await dbCount()) === 1, "only the unexpired local row is imported");
  ok(a.powReplayStatus().mode === "shared", "the status word says the table is shared");

  seedLocal(FILE_A, [{ challenge: "c".repeat(32), exp: nowSec() + 200 }]); // written after the import
  const a2 = await import("../src/pow.js?a2");
  ok(await a2.powReplayReady(), "a second boot on the same file loads");
  ok((await dbCount()) === 1, "a second boot does not import the file again (the mark holds)");

  // ---- 2. an accepted challenge reaches the table -------------------------------
  process.env.POW_DB_PATH = FILE_B;
  const b = await import("../src/pow.js?b");
  ok(await b.powReplayReady(), "container B: the shared replay store loads");
  const dbHas = async (ch) => (await sdb.stateQuery(`SELECT exp FROM ${S()} WHERE challenge = $1`, [ch])).rows.length === 1;
  const localHas = (file, ch) => { const g = new Database(file, { readonly: true }); try { return Boolean(g.prepare("SELECT 1 FROM pow_used WHERE challenge = ?").get(ch)); } finally { g.close(); } };
  ok(localHas(FILE_B, "a".repeat(32)) && !localHas(FILE_B, "b".repeat(32)), "B's first load pulled A's unexpired row and not the expired one");

  const c1 = a.issueChallenge("hash");
  const s1 = solve(c1);
  ok(a.verifySolution(s1, "hash").ok === true, "A accepts a fresh solution (synchronously)");
  ok(a.verifySolution(s1, "hash").reason === "challenge already used", "A refuses its replay at once (the local check)");
  await a.powReplayFlush();
  ok(await dbHas(c1.challenge), "the accepted challenge is in the shared table");

  // ---- 3. the other container refuses it after its refresh -----------------------
  const pulled = await b.powReplaySync();
  ok(pulled === 1 && localHas(FILE_B, c1.challenge), `B's refresh pulled it into B's local table (${pulled})`);
  ok(b.verifySolution(s1, "hash").reason === "challenge already used", "B refuses the solution A accepted (within the TTL)");
  const c2 = b.issueChallenge("hash");
  ok(b.verifySolution(solve(c2), "hash").ok === true, "control: B still accepts a fresh solution");
  await b.powReplayFlush();
  ok((await a.powReplaySync()) >= 1 && a.verifySolution(solve(c2), "hash").reason === "challenge already used", "and A refuses the one B accepted, after A's refresh");
  ok((await a.powReplaySync()) === 0, "a refresh with nothing new absorbs nothing (the margin re-read is free)");

  // The window the design leaves: both containers accept the same solution
  // before either has refreshed. The second write finds the row and counts
  // it, so the size of the window is measurable.
  const c3 = a.issueChallenge("hash");
  const s3 = solve(c3);
  const hitsBefore = a.powReplayStatus().windowHits + b.powReplayStatus().windowHits;
  ok(a.verifySolution(s3, "hash").ok === true && b.verifySolution(s3, "hash").ok === true, "window: both containers accept before a refresh (documented in src/pow.js)");
  await Promise.all([a.powReplayFlush(), b.powReplayFlush()]);
  ok(a.powReplayStatus().windowHits + b.powReplayStatus().windowHits === hitsBefore + 1, "window: the second write is counted, one row stays");
  ok((await dbCount()) === 4, `the table holds one row per accepted challenge (${await dbCount()})`);

  // A probe token (the status Worker's) is single-use across containers too.
  const cp = a.issueChallenge(a.PROBE_POW_SLUG, { probe: true });
  const sp = solve(cp);
  ok(a.verifySolution(sp, a.PROBE_POW_SLUG).probe === true, "a probe challenge is accepted by A");
  await a.powReplayFlush(); await b.powReplaySync();
  ok(b.verifySolution(sp, a.PROBE_POW_SLUG).reason === "challenge already used", "and refused by B after its refresh");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-pow-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
