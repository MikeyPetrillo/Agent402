// The lag monitor must MEASURE a real block and stay cheap enough to leave on.
//
// It exists because a CONNECT timeout is a timer firing: a blocked event loop is
// indistinguishable from an unreachable upstream from inside the process, and on
// 2026-08-30 seven CDP verifies failed that way while CDP answered from outside
// in 15-37 ms. We had instrumented BOOT only, so a stall hours into a container
// was invisible. These pin that it actually catches one.
import { strict as assert } from "node:assert";
import { startLoopLagMonitor, loopLagStatus, resetLoopLag } from "../src/loop-lag.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blockFor = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* deliberate */ } };

resetLoopLag();
ok(loopLagStatus().watching === false, "not watching before it is started");

const lines = [];
const stop = startLoopLagMonitor({ tickMs: 50, warnMs: 200, log: (m) => lines.push(m) });
ok(loopLagStatus().watching === true, "watching once started");

await sleep(200);
const quiet = loopLagStatus();
ok(quiet.stalls === 0, `an idle loop records no stall (worst ${quiet.worstMs}ms)`);

blockFor(600);            // the thing a connect timeout would blame on the network
await sleep(150);
const after = loopLagStatus();
ok(after.stalls >= 1, `a 600ms block is recorded as a stall (${after.stalls})`);
ok(after.worstMs >= 400, `and the measured lag is of the right order (${after.worstMs}ms)`);
ok(after.lastStallAt !== null, "the stall carries a timestamp, so it can be matched to a failed payment");
ok(lines.some((l) => /event loop blocked \d+ms/.test(l)), "it logs the number, not just that something happened");
ok(lines.some((l) => /connect timeouts/.test(l)), "and says why that matters, for whoever reads the log next");

resetLoopLag();
ok(loopLagStatus().worstMs === 0 && loopLagStatus().stalls === 0, "reset clears the high-water mark");

stop();
ok(loopLagStatus().watching === false, "stops cleanly");

// Cheap enough to leave on forever: one unref'd interval, no per-tick allocation.
const src = await (await import("node:fs/promises")).readFile(new URL("../src/loop-lag.js", import.meta.url), "utf8");
ok(/unref\(\)/.test(src), "the timer is unref'd, so a diagnostic never holds the process open");
ok((src.match(/setInterval/g) || []).length === 1, "exactly one timer");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
