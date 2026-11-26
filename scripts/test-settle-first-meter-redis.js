// The settle-first budget meter (src/settle-first-meter.js) over a REAL Redis:
// one figure for every replica, read back after a restart, and a store that
// does not answer reads the mode ON (that answer refuses nobody).
//
// Two module instances (imported with distinct query strings, so each has its
// own per-process figures) stand in for two containers on one Redis; a third
// imported later stands in for a container started after both (a restart).
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-settle-first-meter-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { childJson } from "./lib/child-json.js";

if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-settle-first-meter-redis: no REDIS_URL; start a local redis and export REDIS_URL=redis://127.0.0.1:6379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
// A prefix of its own per run, so reruns and parallel lanes never share a figure.
process.env.SHARED_LIMITS_PREFIX = `sfm-test-${randomBytes(5).toString("hex")}`;
delete process.env.GATEWAY_SETTLE_FIRST;
process.env.GATEWAY_SETTLE_FIRST_BUDGET_USD = "5";

const { sharedLimitsMode } = await import("../src/shared-limits.js");
const A = await import("../src/settle-first-meter.js?container=a");
const B = await import("../src/settle-first-meter.js?container=b");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quietly = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const T0 = Date.now();

ok(sharedLimitsMode() === "redis", `the shared store is Redis (${sharedLimitsMode()})`);
ok(A !== B, "two separate module instances (two containers)");

// Right after boot, before any request decided: the operator view never reads
// "on" for a meter it has not read. Asking starts the bounded read, and once
// it answers the view holds the reading.
{
  const G = await import("../src/settle-first-meter.js?container=g");
  const first = G.settleFirstMeterStatus({ now: Date.now() });
  ok(first.budgetMode === "not-read" && first.why === "not-read-yet" && first.lastReadAgoMs === null, `a meter not read yet reads not-read in the operator view, never on (${first.budgetMode}, ${first.why})`);
  let later = first;
  for (let i = 0; i < 50 && later.lastReadAgoMs === null; i++) { await sleep(20); later = G.settleFirstMeterStatus({ now: Date.now() }); }
  ok(later.budgetMode === "off" && later.why === "under-budget" && later.lastReadAgoMs !== null, `asking for the view started the read: it now holds a reading (${later.budgetMode}, ${later.why})`);
  const H = await import("../src/settle-first-meter.js?container=h");
  const read = await H.settleFirstMeterRead({ now: Date.now() });
  const h = H.settleFirstMeterStatus({ now: Date.now() });
  ok(read === true && h.budgetMode === "off" && h.lastReadAgoMs !== null, `the status view's own read (settleFirstMeterRead) leaves a reading behind (${h.budgetMode}, ${h.why})`);
  // The operator path: /api/gateway-status's full settle-failures view reads the meter first.
  const BR = await import("../src/gateway-settle-breaker.js");
  const full = await quietly(() => BR.gatewaySettleFailuresStatus({ full: true }));
  ok(full?.settleFirst?.meter?.budgetMode === "off" && full.settleFirst.meter.lastReadAgoMs !== null, `the operator view of the settle failures reads the meter before it answers (${JSON.stringify(full?.settleFirst?.meter && { budgetMode: full.settleFirst.meter.budgetMode, why: full.settleFirst.meter.why })})`);
}

// Both start: each reads the shared figures before deciding.
const a0 = await quietly(() => A.settleFirstBudgetMode({ now: T0 }));
const b0 = await quietly(() => B.settleFirstBudgetMode({ now: T0 }));
ok(!a0.on && !b0.on && a0.why === "under-budget", `both containers read the meter and the mode is off (${a0.why}, ${b0.why})`);

// At risk in flight, across containers: A serves a new wallet's runs first.
const D = await import("../src/settle-first-meter.js?container=d");
await quietly(() => D.settleFirstBudgetMode({ now: Date.now() }));
const releases = [];
for (let i = 0; i < 5; i++) releases.push(D.reserveAtRisk(1, Date.now()));
await sleep(300);
const E = await import("../src/settle-first-meter.js?container=e");
const eOn = await quietly(() => E.settleFirstBudgetMode({ now: Date.now() }));
for (const r of releases) r();
await sleep(300);
const F = await import("../src/settle-first-meter.js?container=f");
const fOff = await quietly(() => F.settleFirstBudgetMode({ now: Date.now() }));
ok(eOn.on && eOn.why === "budget" && !fOff.on, `$5 at risk in flight on one container turns the mode on for another (${eOn.why}); once those runs end it is off again (${fOff.why})`);

// Container A meters $6 of unsettled runs; B made no call of its own.
A.noteUnsettledRunCost(3, T0);
A.noteUnsettledRunCost(3, T0 + 1000);
await sleep(300);
const aOn = await quietly(() => A.settleFirstBudgetMode({ now: T0 + 2000 }));
// B's view is fresh for REFRESH_MS; a read after that sees A's figure.
const bOn = await quietly(() => B.settleFirstBudgetMode({ now: T0 + 2000 + B.REFRESH_MS + 1 }));
ok(aOn.on && aOn.why === "budget", `container A: $6 of unsettled runs crosses the $5 budget (${aOn.why})`);
ok(bOn.on && bOn.why === "budget" && B.settleFirstMeterStatus({ now: T0 + 2000 + B.REFRESH_MS + 1 }).unsettledUsd24h >= 6, `container B, which metered nothing, reads the same figure from the shared store and the mode is on (${bOn.why})`);

// A restart: a container started now reads the figure back.
const C = await import("../src/settle-first-meter.js?container=c");
const cOn = await quietly(() => C.settleFirstBudgetMode({ now: T0 + 3000 }));
ok(cOn.on && C.settleFirstMeterStatus({ now: T0 + 3000 }).unsettledUsd24h >= 6, `a container started afterwards (a restart) reads the figure back from the store: the mode is on (${cOn.why})`);

// The window rolls: 24 hours on, the figure is gone everywhere.
const later = T0 + 24 * 3600_000 + 120_000;
const aLater = await quietly(() => A.settleFirstBudgetMode({ now: later }));
const cLater = await quietly(() => C.settleFirstBudgetMode({ now: later + C.REFRESH_MS + 1 }));
ok(!aLater.on && !cLater.on, `24 hours on, the cost has rolled out of the window and the mode is off on every container (${aLater.why}, ${cLater.why})`);

// A store that does not answer: the mode reads ON (refuses nobody).
{
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const m = await import(${JSON.stringify(new URL("../src/settle-first-meter.js", import.meta.url).href)});
    console.log = () => {};
    const v = await m.settleFirstBudgetMode({ now: Date.now() });
    const st = m.settleFirstMeterStatus({ now: Date.now() });
    process.stdout.write(JSON.stringify({ ...v, status: { budgetMode: st.budgetMode, why: st.why } }));
    process.exit(0);
  `], { env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1", SHARED_LIMITS_PREFIX: `${process.env.SHARED_LIMITS_PREFIX}-dead` }, encoding: "utf8", timeout: 30_000 });
  let v = null;
  try { v = childJson(child.stdout || ""); } catch { v = null; }
  ok(v?.on === true && v.why === "meter-unread", `a Redis that does not answer: the meter cannot be read and the mode reads on (${JSON.stringify(v)})`);
  ok(v?.status?.budgetMode === "on" && v.status.why === "meter-unread", `after a read that did not answer, the operator view says so: on, meter-unread (${JSON.stringify(v?.status)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
