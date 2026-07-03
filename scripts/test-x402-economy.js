// x402 Economy history — offline unit tests. Throwaway DB via X402_ECONOMY_DB
// (set BEFORE import), no network: exercises the daily upsert (idempotent,
// update-in-place for partial-day refreshes) and the week-over-week math
// (trailing 7 COMPLETE days vs the 7 before, today excluded).
//
//   node scripts/test-x402-economy.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-econ-"));
process.env.X402_ECONOMY_DB = join(dir, "test-economy.db");
const { recordDailyHistory, weeklyFromHistory } = await import("../src/x402-economy.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const day = (offset) => new Date(Date.UTC(2026, 6, 3) - offset * 86400000).toISOString().slice(0, 10);
const TODAY = day(0); // 2026-07-03 — excluded from weekly windows

// --- empty history -------------------------------------------------------------
let w = weeklyFromHistory(TODAY);
ok(w.historyDays === 0 && w.growthPct === null, "empty history → no growth, 0 days");

// --- seed 15 days: last week 100/day, week before 50/day ------------------------
const rows = [];
for (let i = 1; i <= 7; i++) rows.push({ day: day(i), settlements: 100, payers: 10 + i });
for (let i = 8; i <= 14; i++) rows.push({ day: day(i), settlements: 50, payers: 5 });
rows.push({ day: TODAY, settlements: 40, payers: 3 }); // partial today — must be ignored
recordDailyHistory(rows);

w = weeklyFromHistory(TODAY);
ok(w.historyDays === 15, `15 days recorded (got ${w.historyDays})`);
ok(w.thisWeek.settlements === 700 && w.thisWeek.days === 7, `this week sums complete days only (got ${w.thisWeek.settlements})`);
ok(w.lastWeek.settlements === 350 && w.lastWeek.days === 7, `last week correct (got ${w.lastWeek.settlements})`);
ok(w.growthPct === 100, `growth = +100% (got ${w.growthPct})`);
ok(w.thisWeek.payersPeak === 17, `payers peak tracked (got ${w.thisWeek.payersPeak})`);

// --- upsert idempotency + partial-day refresh ------------------------------------
recordDailyHistory(rows); // exact replay
w = weeklyFromHistory(TODAY);
ok(w.historyDays === 15 && w.thisWeek.settlements === 700, "replaying the same rows is a no-op");
recordDailyHistory([{ day: day(1), settlements: 120, payers: 30 }]); // day refreshed upward
w = weeklyFromHistory(TODAY);
ok(w.thisWeek.settlements === 720, `refreshed day updates in place (got ${w.thisWeek.settlements})`);

// --- growth sign ---------------------------------------------------------------
recordDailyHistory(Array.from({ length: 7 }, (_, i) => ({ day: day(i + 1), settlements: 10, payers: 1 })));
w = weeklyFromHistory(TODAY);
ok(w.growthPct === -80, `negative growth computes (got ${w.growthPct})`);

// --- malformed rows ignored ------------------------------------------------------
recordDailyHistory([{ day: null, settlements: 5 }, { settlements: 5 }, { day: day(2), settlements: NaN }]);
w = weeklyFromHistory(TODAY);
ok(w.historyDays === 15, "malformed rows are skipped, not inserted");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
