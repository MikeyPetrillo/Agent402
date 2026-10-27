// Slow origins (their operator asked for less probing) are due every
// SLOW_ORIGIN_EVERY_CYCLES cycles; every other origin keeps the normal cadence.
//   node scripts/test-slow-origins.js
import { readFileSync } from "node:fs";
import { originsDueThisCycle } from "../src/x402-index.js";
import { isSlowOrigin, SLOW_ORIGINS, SLOW_ORIGIN_EVERY_CYCLES } from "../src/crawl-cadence.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL - ${m}`); } };

const slow = [...SLOW_ORIGINS][0];
const normal = "https://example-normal-seller.test";
const all = [slow, normal];

ok(SLOW_ORIGIN_EVERY_CYCLES === 12, "the slow cadence is 12 cycles (6 hours at 30-minute cycles)");
ok(isSlowOrigin(slow), "the configured slow origin matches itself");
ok(isSlowOrigin(slow + "/"), "a trailing slash still matches");
ok(!isSlowOrigin("https://api.agentpaywire.com.evil.test"), "a look-alike host does not match");
ok(!isSlowOrigin(normal), "an ordinary origin is not slow");

let slowDue = 0, normalDue = 0;
for (let c = 0; c < 36; c++) {
  const due = new Set(originsDueThisCycle(all, c));
  if (due.has(slow)) { slowDue++; ok(c % SLOW_ORIGIN_EVERY_CYCLES === 0, `slow origin due only on a 12-cycle boundary (cycle ${c})`); }
  if (due.has(normal)) normalDue++;
}
ok(slowDue === 3, `slow origin due 3 times in 36 cycles, got ${slowDue}`);
ok(normalDue === 36, `ordinary origin due every cycle, got ${normalDue}`);

// The probe guard lives in probePaywall (not exported). Assert the guard is present
// on the line that filters the probed routes, so a removal fails here.
const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
ok(/isSlowOrigin\(t\.seller\) && String\(t\.method \|\| "GET"\)\.toUpperCase\(\) !== "GET"/.test(src),
  "probePaywall skips non-GET probes for slow origins");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
