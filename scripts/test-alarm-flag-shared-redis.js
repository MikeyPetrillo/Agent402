// A burst alarm raised on one replica reads burst on another, over a REAL
// Redis: the settle-failure breaker (src/gateway-settle-breaker.js) and the
// report spend guard (src/composite-spend-guard.js) each write a shared flag
// when a trip is counted, and the status word on every replica reads it.
//
// Two module instances (imported with distinct query strings, so each has its
// own per-process latch) stand in for two containers on one Redis. Container
// A counts the failures that trip the alarm; container B, which recorded
// nothing, reads burst through the module's own status reader. The test
// writes no flag itself.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-alarm-flag-shared-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import { randomBytes } from "node:crypto";

if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-alarm-flag-shared-redis: no REDIS_URL; start a local redis and export REDIS_URL=redis://127.0.0.1:6379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
// A prefix of its own per run, so reruns and parallel lanes never share a flag.
process.env.SHARED_LIMITS_PREFIX = `alarm-flag-test-${randomBytes(5).toString("hex")}`;
const TRIP = 4;
process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX = String(TRIP);
process.env.COMPOSITE_GUARD_GLOBAL_MAX_FAILS = String(TRIP);

const { sharedLimitsMode } = await import("../src/shared-limits.js");
const gwA = await import("../src/gateway-settle-breaker.js?container=a");
const gwB = await import("../src/gateway-settle-breaker.js?container=b");
const cgA = await import("../src/composite-spend-guard.js?container=a");
const cgB = await import("../src/composite-spend-guard.js?container=b");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll a status reader until it reads `want` (the writes are fire and forget). */
async function reads(fn, want, tries = 150) {
  let last = null;
  for (let i = 0; i < tries; i++) { last = (await fn()).status; if (last === want) break; await sleep(20); }
  return last;
}
const wallet = (n) => `0x${String(n).padStart(40, "a")}`;

ok(sharedLimitsMode() === "redis", `the shared store is Redis (${sharedLimitsMode()})`);

// ---- the settle-failure breaker's alarm flag ----
{
  ok(gwA !== gwB && gwA._gatewaySettleBreakerShared === true && gwB._gatewaySettleBreakerShared === true, "two separate breaker instances, both on the shared store");
  // The live control: nothing recorded yet, so burst below can only come from A's trip.
  ok((await gwB.gatewaySettleFailuresStatus()).status === "ok" && (await gwA.gatewaySettleFailuresStatus()).status === "ok", "before any failure both containers read ok");
  for (let i = 0; i < TRIP - 1; i++) gwA.recordGatewaySettleFailure(wallet(i));
  await sleep(150);
  ok((await gwB.gatewaySettleFailuresStatus()).status === "ok", "one buyer short of the trip, container B still reads ok");
  gwA.recordGatewaySettleFailure(wallet(TRIP - 1));
  ok(gwA.gatewaySettleBreakerGlobalAlarm().alarm === true, "container A's own alarm is raised by the trip");
  const word = await reads(() => gwB.gatewaySettleFailuresStatus(), "burst");
  ok(gwB.gatewaySettleBreakerGlobalAlarm().alarm === false, "container B's own latch stays clear (it recorded nothing)");
  ok(word === "burst", `container B reads burst from the flag container A's trip wrote (${word})`);
  const full = await gwB.gatewaySettleFailuresStatus({ full: true });
  ok(full.status === "burst" && Date.parse(full.until) > Date.now() && full.trips === 0, "container B's operator read carries the flag's lift time and none of its own trips");
}

// ---- the report spend guard's alarm flag ----
{
  ok(cgA !== cgB && cgA._compositeGuardShared === true && cgB._compositeGuardShared === true, "two separate guard instances, both on the shared store");
  ok((await cgB.compositeGuardAlarmStatus()).status === "ok" && (await cgA.compositeGuardAlarmStatus()).status === "ok", "before any failure both containers read ok");
  for (let i = 0; i < TRIP - 1; i++) cgA.recordCompositeSpendFailure(wallet(100 + i));
  await cgA.__compositeGuardSharedSettled();
  ok((await cgB.compositeGuardAlarmStatus()).status === "ok", "one run short of the trip, container B still reads ok");
  cgA.recordCompositeSpendFailure(wallet(100 + TRIP - 1));
  await cgA.__compositeGuardSharedSettled();
  ok((await cgA.compositeGuardAlarmStatus()).status === "burst", "container A's own alarm is raised by the trip");
  const word = await reads(() => cgB.compositeGuardAlarmStatus(), "burst");
  ok(cgB._compositeGuardState().globalAlarmUntil === 0 || !(cgB._compositeGuardState().globalAlarmUntil > Date.now()), "container B's own latch stays clear (it recorded nothing)");
  ok(word === "burst", `container B reads burst from the flag container A's trip wrote (${word})`);
}

await gwA._gatewaySettleBreakerReset();
cgA._compositeGuardReset();
await sleep(100);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
