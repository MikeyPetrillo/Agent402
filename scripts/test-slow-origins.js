// Slow origins (their operator asked for less probing) are read every
// SLOW_ORIGIN_EVERY_CYCLES cycles' time, by the clock; every other origin keeps
// the normal cadence.
//   node scripts/test-slow-origins.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
process.env.CRAWL_SLOW_ORIGINS = "https://slow-seller.test/";
const { originsDueThisCycle } = await import("../src/x402-index.js");
const { isSlowOrigin, SLOW_ORIGINS, SLOW_ORIGIN_EVERY_CYCLES } = await import("../src/crawl-cadence.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL - ${m}`); } };

const slow = "https://slow-seller.test";
const normal = "https://example-normal-seller.test";
const all = [slow, normal];

ok(SLOW_ORIGIN_EVERY_CYCLES === 12, "the slow cadence is 12 cycles (6 hours at 30-minute cycles)");
ok(isSlowOrigin(slow), "the configured slow origin matches itself");
ok([...SLOW_ORIGINS].length === 1, "the slow list is read from the environment");
ok(isSlowOrigin(slow + "/"), "a trailing slash still matches");
ok(!isSlowOrigin("https://slow-seller.test.evil.test"), "a look-alike host does not match");
ok(!isSlowOrigin(normal), "an ordinary origin is not slow");

// The slow cycle is by the clock (src/seller-load.js slowWaiting): 18 hours of
// 30-minute cycles, plus a boot's extra cycle 30 s after every third hour (six
// deploys a day), read the slow origin every 6 hours and no more often; the
// cycle count never decides it.
const { sellerLoad, SLOW_READ_INTERVAL_MS } = await import("../src/seller-load.js");
const start = Date.parse("2026-11-23T00:00:00Z");
let clock = start;
sellerLoad.setClock(() => clock);
let slowDue = 0, normalDue = 0, cycle = 0;
const slowAt = [];
for (let m = 0; m < 18 * 60; m += 30) {
  for (const at of m % 180 === 0 ? [m, m + 0.5] : [m]) {
    clock = start + at * 60_000;
    const due = new Set(originsDueThisCycle(all, cycle++));
    if (due.has(slow)) { slowDue++; slowAt.push(clock); sellerLoad.noteSlowRead(slow, "x402"); }
    if (due.has(normal)) normalDue++;
  }
}
ok(slowDue === 3, `slow origin due 3 times in 18 hours with six boots, got ${slowDue}`);
ok(slowAt.every((t, i) => i === 0 || t - slowAt[i - 1] >= SLOW_READ_INTERVAL_MS), "never twice inside the slow interval");
ok(SLOW_READ_INTERVAL_MS > 5.9 * 3_600_000 && SLOW_READ_INTERVAL_MS <= 6 * 3_600_000, "the interval is six hours less a little");
ok(normalDue === cycle, `ordinary origin due every cycle, got ${normalDue} of ${cycle}`);
// A new process (a deploy) reads the last slow read from the shared store at
// the cycle's prefetch and waits it out; without it the origin is due at once.
{
  const { createSellerLoad } = await import("../src/seller-load.js");
  const { createMemoryLimits } = await import("../src/shared-limits.js");
  const store = createMemoryLimits();
  const a = createSellerLoad({ store, now: () => clock });
  a.noteSlowRead(slow, "x402");
  await a.flush();
  const b = createSellerLoad({ store, now: () => clock });
  ok(!b.slowWaiting(slow) && originsDueThisCycle(all, 1, 4, { slowWaiting: (o) => b.slowWaiting(o) }).includes(slow), "control: a new process knows no read before it reads the store");
  await b.prefetch([slow]);
  ok(b.slowWaiting(slow) && (await b.crawlPlan(slow)).skip === "slow", "after the cycle's prefetch it waits out the read another process made");
  ok(!b.slowWaiting(normal) && (await b.crawlPlan(normal)).skip === null, "an ordinary origin never waits on it");
  clock += SLOW_READ_INTERVAL_MS;
  ok((await b.crawlPlan(slow)).skip === null, "and the slow origin is read once the interval has passed");
}

// The probe guard lives in probePaywall (not exported). Assert the guard is present
// on the line that filters the probed routes, so a removal fails here.
const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
ok(/isSlowOrigin\(t\.seller\) && String\(t\.method \|\| "GET"\)\.toUpperCase\(\) !== "GET"/.test(src),
  "probePaywall skips non-GET probes for slow origins");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
