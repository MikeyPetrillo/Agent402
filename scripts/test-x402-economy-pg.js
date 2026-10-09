// The economy's daily history against a REAL Postgres (STATE_DATABASE_URL set):
//   1. the SQLite file is imported once at the first boot with the database
//      on, marked, and not imported again by a second boot;
//   2. a recorded snapshot reaches the table and a fresh instance reads it;
//   3. the invariant: one row per day, upserted (a replay changes nothing, a
//      refreshed day updates in place) and two records of the same day land
//      in the order they were made (the last one wins).
// Requires STATE_DATABASE_URL (CI fails without it; locally it skips).
//
//   node scripts/test-x402-economy-pg.js
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-x402-economy-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const dir = mkdtempSync(join(tmpdir(), "a402-econ-pg-"));
const FILE = join(dir, "test-economy.db");
process.env.X402_ECONOMY_DB = FILE;
process.env.X402_SYNC_ON_START = "false";
const S = () => `${process.env.STATE_DB_SCHEMA}.economy_daily`;
const day = (offset) => new Date(Date.UTC(2026, 6, 3) - offset * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
const seedFile = (rows) => {
  const g = new Database(FILE);
  g.exec("CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, settlements INTEGER NOT NULL, payers INTEGER NOT NULL, updated_ts INTEGER)");
  const ins = g.prepare("INSERT OR REPLACE INTO daily (day, settlements, payers, updated_ts) VALUES (?, ?, ?, ?)");
  for (const r of rows) ins.run(r.day, r.settlements, r.payers, 1);
  g.close();
};
const dbRow = async (d) => (await sdb.stateQuery(`SELECT settlements::int AS s, payers::int AS p FROM ${S()} WHERE day = $1`, [d])).rows[0] || null;
const dbCount = async () => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${S()}`)).rows[0].n);

try {
  // ---- 1. import once ---------------------------------------------------------
  const seed = [];
  for (let i = 1; i <= 7; i++) seed.push({ day: day(i), settlements: 100, payers: 10 + i });
  for (let i = 8; i <= 14; i++) seed.push({ day: day(i), settlements: 50, payers: 5 });
  seedFile(seed);
  const a = await import("../src/x402-economy.js");
  ok(await a.economyHistoryReady(), "first boot: the history loads");
  const mark = await sdb.imports.done("test-economy.db");
  ok(mark && mark.source === FILE, "first boot: the import is marked under the file's basename");
  ok((await dbCount()) === 14, "first boot: every day of the file is in the table");
  let w = a.weeklyFromHistory(TODAY);
  ok(w.historyDays === 14 && w.thisWeek.settlements === 700 && w.lastWeek.settlements === 350 && w.growthPct === 100 && w.thisWeek.payersPeak === 17, `the weekly read comes from the mirror (${JSON.stringify(w)})`);

  seedFile([{ day: day(15), settlements: 1, payers: 1 }]); // written to the file after the import
  const b = await import("../src/x402-economy.js?second");
  ok(await b.economyHistoryReady(), "second boot: the history loads");
  ok((await dbCount()) === 14 && b.weeklyFromHistory(TODAY).historyDays === 14, "second boot: the file is not imported again (the mark holds)");

  // ---- 2. writes reach the table; a fresh instance reads them -----------------
  const p = a.recordDailyHistory([{ day: TODAY, settlements: 40, payers: 3 }, { day: day(1), settlements: 120, payers: 30 }]);
  ok(p && typeof p.then === "function", "recordDailyHistory returns a promise with the database on");
  w = a.weeklyFromHistory(TODAY);
  ok(w.thisWeek.settlements === 720 && w.historyDays === 15, "the mirror is updated at once (today excluded from the week, day 1 refreshed)");
  ok((await p) === true, "the write resolves true once it landed");
  ok((await dbRow(day(1)))?.s === 120 && (await dbRow(TODAY))?.s === 40 && (await dbCount()) === 15, "the rows are in the table");
  const c = await import("../src/x402-economy.js?third");
  ok(await c.economyHistoryReady(), "a fresh instance loads");
  ok(JSON.stringify(c.weeklyFromHistory(TODAY)) === JSON.stringify(a.weeklyFromHistory(TODAY)), "a fresh instance reads the same history from the table");

  // ---- 3. upsert per day, in order --------------------------------------------
  await a.recordDailyHistory(seed);
  ok((await dbCount()) === 15 && (await dbRow(day(2)))?.s === 100, "replaying the same rows changes nothing");
  // Two records of one day back to back: the queue keeps their order.
  a.recordDailyHistory([{ day: day(3), settlements: 1, payers: 1 }]);
  a.recordDailyHistory([{ day: day(3), settlements: 2, payers: 2 }]);
  await a.economyHistoryFlush();
  ok(a.weeklyFromHistory(TODAY).thisWeek.settlements === 6 * 100 + 2, "the mirror holds the later value (day 1 went back to the seed's value on the replay)");
  ok((await dbRow(day(3)))?.s === 2, `the table holds the later value: the last record of a day wins, queued in order (${JSON.stringify(await dbRow(day(3)))})`);
  ok((await dbCount()) === 15, "still one row per day");
  // Rows without a day or a finite count are skipped, as the SQLite path skips them.
  ok((await a.recordDailyHistory([{ day: "", settlements: 5 }, { day: day(4), settlements: NaN }, null])) === true && (await dbCount()) === 15, "malformed rows are skipped");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-x402-economy-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
