// x402 Economy history + rendering — throwaway DB via X402_ECONOMY_DB (set
// BEFORE import), no network for the first part: exercises the daily upsert
// (idempotent, update-in-place for partial-day refreshes) and the
// week-over-week math (trailing 7 COMPLETE days vs the 7 before, today
// excluded). The data-machinery tests below are unchanged.
//
// The old standalone /x402-economy page folded into /index's "The economy,
// over time" section - this file also covers the rendered section (pure
// function, no server) and, at the end, boots a real server once to confirm
// /x402-economy 301s to /index#economy.
//
//   node scripts/test-x402-economy.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// Best-effort cleanup: better-sqlite3 keeps the WAL file handle open for the
// life of the process (module-level `hdb`, never closed), which makes an
// unlink of the containing dir EBUSY on Windows. Pre-existing, unrelated to
// this change — the OS temp dir gets swept eventually either way.
try { rmSync(dir, { recursive: true, force: true }); } catch { /* handle still open on Windows */ }

// --- rendered "The economy, over time" section (moved from the old
// standalone /x402-economy page into /index) --------------------------------
const { economySectionHtml } = await import("../src/x402-index.js");

const sampleDaily = [
  { day: day(1), settlements: 120, payers: 30 },
  { day: day(2), settlements: 10, payers: 1 },
];
const rendered = economySectionHtml({
  daily: sampleDaily,
  totals: { last7d: { settlements: 130, volumeUsd: 4.56, payers: 31 }, last30d: { settlements: 130 } },
  weekly: weeklyFromHistory(TODAY),
  errors: [],
});
ok(rendered.includes('id="economy"'), "rendered section carries the /index#economy anchor");
ok(rendered.includes("The economy, over time"), "rendered section has its heading");
ok(rendered.includes(day(1)) && rendered.includes(day(2)), "rendered section lists daily history rows");
ok(rendered.includes("4.56"), "rendered section shows the 7d volume");
ok(/week[- ]over[- ]week|week-over-week trend unlocks/i.test(rendered), "rendered section shows a weekly-trend line");
ok(!rendered.includes("—"), "no em dashes in the rendered section");

const warming = economySectionHtml({ daily: [], errors: ["daily: boom"] });
ok(warming.includes("unavailable right now"), "warming/error snapshot renders an honest unavailable state, not a crash");
ok(warming.includes('id="economy"'), "warming state still carries the anchor");

const missing = economySectionHtml(null);
ok(missing.includes("unavailable right now"), "a missing snapshot renders the same honest unavailable state");

// --- 24h ecosystem sub-block (moved from the old /economy dashboard) --------
const lbSnap = {
  windowLabel: "24h",
  leaderboard: [
    { name: "A", totalUsd: 8, callsSettled: 100, network: "base" },
    { name: "B", totalUsd: 2, callsSettled: 50, network: "solana" },
  ],
};
const withDay = economySectionHtml({ daily: sampleDaily, totals: {}, errors: [] }, lbSnap);
ok(withDay.includes("Last 24h across the ecosystem"), "24h sub-block renders with a leaderboard snapshot");
ok(withDay.includes("$10.00"), "24h total volume sums the leaderboard rows");
ok(withDay.includes("80.0%"), "top-1 concentration computed from the snapshot");
ok(withDay.includes("base") && withDay.includes("solana"), "network split lists each chain with volume");
ok(!withDay.includes("—"), "no em dashes in the 24h sub-block");

const noDay = economySectionHtml({ daily: sampleDaily, totals: {}, errors: [] }, { warming: true });
ok(!noDay.includes("Last 24h across the ecosystem"), "warming leaderboard snapshot renders no 24h block (no invented zeros)");
const noDay2 = economySectionHtml({ daily: sampleDaily, totals: {}, errors: [] }, null);
ok(!noDay2.includes("Last 24h across the ecosystem"), "missing leaderboard snapshot renders no 24h block");

// --- snapshot cache is stale-while-revalidate (no visitor waits on the
// ~500ms on-chain rebuild) -----------------------------------------------------
// Offline (no CDP key) the on-chain reads throw immediately and are collected
// into errors, so the build returns fast — enough to exercise the caching
// contract without network: concurrent callers dedupe onto one in-flight
// build, and a warm call returns the identical cached object (no rebuild).
{
  const { x402EconomySnapshot } = await import("../src/x402-economy.js");
  const [a, b] = await Promise.all([x402EconomySnapshot(), x402EconomySnapshot()]);
  ok(a === b, "concurrent cold callers dedupe onto one in-flight build (same object)");
  ok(Array.isArray(a.errors), "snapshot never throws — returns an object with errors[]");
  const c = await x402EconomySnapshot();
  ok(a === c, "a warm call returns the cached object, not a rebuild");
}

// --- /x402-economy now 301s to /marketplace#economy (straight to the unified
// surface — never chaining through the /index 301) ---------------------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const PORT = 3103;
  // Capture the server's output: with stdio ignored, a CI-only boot crash is
  // indistinguishable from a slow boot (learned 2026-07-11 — ECONNREFUSED
  // with zero context). Also: cold CI runners boot the full catalog slower
  // than dev machines, so the wait is 90s, and a dead child ends it early.
  const bootLog = [];
  // Fresh env for the child: the unit tests above set X402_ECONOMY_DB into a
  // temp dir they delete afterward — inheriting it made the server open a DB
  // in a removed directory (the CI-only boot crash of 2026-07-11).
  const childEnv = { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" };
  delete childEnv.X402_ECONOMY_DB;
  const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => bootLog.push(String(d)));
  proc.stderr.on("data", (d) => bootLog.push(String(d)));
  let exited = false;
  proc.on("exit", () => { exited = true; });
  try {
    let up = false;
    for (let i = 0; i < 180 && !exited; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break; } } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) {
      ok(false, `server never became healthy on :${PORT} (exited=${exited}) — boot log tail:\n${bootLog.join("").slice(-2000)}`);
    } else {
      for (const path of ["/x402-economy", "/economy"]) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: "manual" });
          ok(res.status === 301, `${path} → 301 (got ${res.status})`);
          ok(res.headers.get("location") === "/marketplace#economy", `${path} Location is /marketplace#economy (got ${res.headers.get("location")})`);
        } catch (e) {
          ok(false, `${path} fetch failed: ${e?.cause?.code || e.message}`);
        }
      }
    }
  } finally {
    proc.kill("SIGKILL");
  }
}

// Boot warm-up (2026-08-28): the snapshot cache is stale-while-revalidate, so
// only a COLD cache blocks - and it is cold exactly once per deploy. An
// outside reviewer measured /marketplace at 5.58 s on that first request
// against 0.25-0.42 s warm. The warm-up must be unref'd (never hold the
// process open), must not run when the offline flag is set, and must never
// throw into boot.
{
  const { warmEconomySnapshot } = await import("../src/x402-economy.js");
  const prev = process.env.X402_SYNC_ON_START;
  process.env.X402_SYNC_ON_START = "false";
  ok(warmEconomySnapshot() === null, "the offline flag skips the warm-up entirely");
  process.env.X402_SYNC_ON_START = prev === undefined ? "" : prev;
  if (prev === undefined) delete process.env.X402_SYNC_ON_START;
  const t = warmEconomySnapshot({ delayMs: 3_600_000 });
  ok(t && typeof t === "object", "the warm-up returns its timer handle");
  ok(t.hasRef ? t.hasRef() === false : true, "the warm-up timer is unref'd and cannot hold the process open");
  clearTimeout(t);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
