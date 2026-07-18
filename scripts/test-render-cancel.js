// Render execution-deadline cancellation (audit R-09). Before the fix, when the
// exec deadline won the Promise.race the timed-out `run` kept its browser
// context OPEN while the slot was released — so a new render was admitted while
// the old context was still live, and a timeout storm could hold far more live
// contexts than MAX_CONCURRENT (CPU/RAM exhaustion). The fix force-closes the
// context and awaits the run's teardown BEFORE releasing the slot.
//
// This test injects a fake browser that COUNTS live contexts, drives a storm of
// renders that all hang past a tiny exec deadline, and asserts live contexts
// never exceed MAX_CONCURRENT and drain back to zero. No Chromium launch.
//
//   node scripts/test-render-cancel.js
import { __test } from "../src/tools/render.js";

const {
  reset, injectBrowser, withPage,
  setExecDeadline, setCleanupDeadline, setQueueDeadline,
  state, MAX_CONCURRENT,
} = __test;

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`${cond ? "ok" : "FAIL"} - ${msg}`); };

// Fake browser: each context bumps a live counter on create and drops it on
// close. A page's goto() hangs until the context is closed, then rejects — the
// realistic Playwright behavior (context.close aborts in-flight navigation).
function makeFakeBrowser(counter) {
  return {
    on: () => {},
    newContext: async () => {
      counter.live++;
      counter.peak = Math.max(counter.peak, counter.live);
      let closed = false;
      const rejectors = [];
      const fireClose = () => { rejectors.splice(0).forEach((r) => r(new Error("context closed"))); };
      return {
        route: async () => {},
        on: () => {},
        newPage: async () => ({
          url: () => "about:blank",
          goto: () => closed
            ? Promise.reject(new Error("context closed"))
            : new Promise((_, reject) => { rejectors.push(reject); }),
        }),
        close: async () => { if (!closed) { closed = true; counter.live--; fireClose(); } },
      };
    },
  };
}

const counter = { live: 0, peak: 0 };
reset();
injectBrowser(makeFakeBrowser(counter));
setExecDeadline(50);        // renders hang forever → always hit the deadline
setCleanupDeadline(500);
setQueueDeadline(5000);     // generous: waiters should be served as slots free

// A public IP literal passes assertPublicUrl without any DNS lookup (offline).
const URL_OK = "https://93.184.216.34/";

// Storm: 9 concurrent renders (3 active + 6 queued) that all hang past the
// deadline. fn never runs (goto hangs first); every call must 504.
const N = 9;
const calls = Array.from({ length: N }, () =>
  withPage(URL_OK, async () => "unreachable").then(
    () => ({ ok: false }),
    (e) => ({ ok: true, status: e.statusCode }),
  ),
);
const results = await Promise.all(calls);

ok(results.every((r) => r.ok && r.status === 504), `all ${N} renders time out with 504 (got ${results.map((r) => r.status).join(",")})`);
ok(counter.peak <= MAX_CONCURRENT, `live contexts never exceeded MAX_CONCURRENT=${MAX_CONCURRENT} under the storm (peak=${counter.peak})`);
ok(counter.peak > 0, `the storm actually created contexts (peak=${counter.peak}) — test validity`);
ok(counter.live === 0, `every context was closed on timeout — no leak (live=${counter.live})`);
ok(state().active === 0 && state().queued === 0, `pool drained back to empty (active=${state().active}, queued=${state().queued})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
