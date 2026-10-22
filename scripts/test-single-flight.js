// singleFlight (src/ledger-mirror.js): one mirror pull in flight per process.
// A fresh lookup that misses while a pull is running must not take that
// running pull's answer, which may have read the table before the caller's
// row landed: it waits for it, then shares one follow-up pull with every
// other waiter. The timer's run() still skips while a pull is running.
//   node scripts/test-single-flight.js
import { singleFlight } from "../src/ledger-mirror.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

// A pull that reads the "table" when it starts and finishes when released.
function harness() {
  const table = new Set();
  const gates = [];
  let calls = 0, running = 0, maxRunning = 0;
  const pull = async () => {
    calls++; running++; maxRunning = Math.max(maxRunning, running);
    const seen = new Set(table);
    const g = deferred(); gates.push(g);
    try { await g.p; return seen; } finally { running--; }
  };
  return { table, gates, pull, get calls() { return calls; }, get maxRunning() { return maxRunning; } };
}
const tick = () => new Promise((r) => setImmediate(r));

{
  const h = harness();
  const sf = singleFlight(h.pull);
  const first = sf.run();
  await tick();
  ok(first && h.calls === 1 && sf.busy(), "run() starts a pull");
  ok(sf.run() === null, "run() skips while a pull is running");
  h.table.add("0xsale"); // the row lands after the running pull read the table
  const a = sf.fresh(), b = sf.fresh(), c = sf.fresh();
  ok(a === b && b === c, "concurrent fresh() callers share one follow-up");
  await tick();
  ok(h.calls === 1, "the follow-up waits for the running pull");
  h.gates[0].resolve();
  ok(!(await first).has("0xsale"), "the running pull's answer predates the row");
  await tick(); await tick();
  ok(h.calls === 2, "exactly one follow-up pull runs after it");
  h.gates[1].resolve();
  const seen = await a;
  ok(seen.has("0xsale"), "fresh() answers with a pull that read the table after the caller asked");
  ok(h.maxRunning === 1, "never more than one pull in flight");
  ok(!sf.busy(), "idle afterwards");
}

{
  const h = harness();
  const sf = singleFlight(h.pull);
  const p = sf.fresh();
  await tick();
  ok(h.calls === 1, "fresh() with nothing running starts one pull");
  h.gates[0].resolve();
  await p;
  ok(h.calls === 1, "and no follow-up");
}

{
  // A failed running pull still lets the waiters' follow-up run; a failed
  // follow-up rejects to the waiters (the caller answers from the mirror).
  const h = harness();
  const sf = singleFlight(h.pull);
  const first = sf.run();
  await tick();
  const w = sf.fresh();
  h.gates[0].reject(new Error("db blip"));
  await first.catch(() => {});
  await tick(); await tick();
  ok(h.calls === 2, "a failed running pull is followed by the waiters' pull");
  h.gates[1].reject(new Error("still down"));
  let err = null;
  try { await w; } catch (e) { err = e; }
  ok(err?.message === "still down", "a failed follow-up rejects to the waiters");
  ok(!sf.busy(), "a failure leaves the flight free");
  const again = sf.run();
  await tick();
  ok(again !== null && h.calls === 3, "run() starts again after a failure");
  h.gates[2].resolve();
  await again;
}

console.log(`\ntest-single-flight: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
