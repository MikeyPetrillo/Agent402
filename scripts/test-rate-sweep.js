// F21: unit tests for the bounded rate-limit primitives (offline, no server).
//   node scripts/test-rate-sweep.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { sweepStaleTsMap, makeWindowCounter } from "../src/rate-sweep.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- sweepStaleTsMap: one-time IPs are evicted, live keys pruned in place -----
{
  const now = 1_000_000;
  const W = 60_000;
  const m = new Map([
    ["stale-a", [now - 90_000, now - 70_000]],     // all older than window -> drop
    ["stale-b", [now - 60_001]],                    // exactly past the window -> drop
    ["live",    [now - 90_000, now - 10_000]],      // one live ts -> keep only the live one
    ["fresh",   [now - 1000, now - 2000]],          // all live -> unchanged
  ]);
  sweepStaleTsMap(m, W, now);
  ok(!m.has("stale-a"), "all-stale key is deleted");
  ok(!m.has("stale-b"), "boundary-stale key (== window) is deleted");
  ok(m.has("live") && m.get("live").length === 1 && m.get("live")[0] === now - 10_000, "partially-stale key keeps only its live timestamps");
  ok(m.has("fresh") && m.get("fresh").length === 2, "all-live key is retained intact");
  ok(m.size === 2, "map shrank to only the keys with live hits");
}

// --- makeWindowCounter: global ceiling trips at the limit, recovers after window
{
  const W = 60_000;
  const c = makeWindowCounter(W, 3);
  let t = 500_000;
  ok(c.allow(t) && c.allow(t) && c.allow(t), "first 3 hits in the window are allowed");
  ok(c.allow(t) === false, "the 4th hit in the window is refused (global ceiling)");
  ok(c.size() === 3, "counter holds exactly the window's hits");
  // slide past the window: the earlier hits expire, capacity returns
  ok(c.allow(t + 60_001) === true, "after the window passes, a new hit is allowed again");
  ok(c.size() === 1, "expired hits are dropped from the window");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
