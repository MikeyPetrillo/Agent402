// Browser-pool admission control (security audit A402-08). The wait queue was
// unbounded; now it is bounded with a deadline and disconnect-abort. Exercises
// the admission logic directly via the __test hook — no Chromium launch.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { __test } from "../src/tools/render.js";

const { acquireSlot, releaseSlot, state, reset, setQueueDeadline, MAX_CONCURRENT, MAX_QUEUE } = __test;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const rejectsWith = async (p, code, m) => {
  try { await p; ok(false, `${m} (expected reject ${code}, resolved)`); }
  catch (e) { ok(e?.statusCode === code, `${m} (got ${e?.statusCode})`); }
};

(async () => {
  reset();

  // 1. The first MAX_CONCURRENT acquisitions take a slot immediately.
  for (let i = 0; i < MAX_CONCURRENT; i++) await acquireSlot();
  ok(state().active === MAX_CONCURRENT && state().queued === 0, `first ${MAX_CONCURRENT} acquire slots immediately (active=${state().active})`);

  // 2. The next MAX_QUEUE acquisitions queue (pending, not resolved).
  const queued = [];
  for (let i = 0; i < MAX_QUEUE; i++) queued.push(acquireSlot());
  ok(state().queued === MAX_QUEUE, `next ${MAX_QUEUE} acquisitions queue (queued=${state().queued})`);

  // 3. Beyond the queue cap, acquire rejects 503 instead of growing unbounded.
  await rejectsWith(acquireSlot(), 503, "queue full → 503 (bounded, not unbounded)");
  ok(state().queued === MAX_QUEUE, "a rejected over-cap request does not grow the queue");

  // 4. Releasing a slot hands it to the FIFO-next waiter (queue shrinks, active steady).
  releaseSlot();
  await queued[0]; // the head waiter now holds a slot
  ok(state().active === MAX_CONCURRENT && state().queued === MAX_QUEUE - 1, `release hands the slot to the next waiter (queued=${state().queued})`);

  // Drain the rest so state is clean, then verify it returns to empty.
  for (let i = 1; i < MAX_QUEUE; i++) { releaseSlot(); await queued[i]; }
  // Now MAX_CONCURRENT are "held" (each was resolved); release them all.
  for (let i = 0; i < MAX_CONCURRENT; i++) releaseSlot();
  ok(state().active === 0 && state().queued === 0, `pool drains back to empty (active=${state().active}, queued=${state().queued})`);

  // 5. Disconnect abort: a queued waiter whose signal fires is removed + rejects 499.
  reset();
  for (let i = 0; i < MAX_CONCURRENT; i++) await acquireSlot();
  const ac = new AbortController();
  const abortable = acquireSlot(ac.signal);
  ok(state().queued === 1, "abortable request is queued");
  ac.abort();
  await rejectsWith(abortable, 499, "client disconnect → 499 and dropped from queue");
  ok(state().queued === 0, "aborted waiter is removed from the queue (no slot leak)");

  // 6. A pre-aborted signal is rejected immediately, without taking a slot.
  reset();
  const pre = new AbortController(); pre.abort();
  await rejectsWith(acquireSlot(pre.signal), 499, "pre-aborted signal → immediate 499");
  ok(state().active === 0, "pre-aborted request never took a slot");

  // 7. Queue deadline: a waiter that waits past the deadline rejects 503 and is removed.
  reset();
  setQueueDeadline(60);
  for (let i = 0; i < MAX_CONCURRENT; i++) await acquireSlot();
  const slow = acquireSlot();
  await rejectsWith(slow, 503, "queued request past the deadline → 503");
  ok(state().queued === 0, "timed-out waiter is removed from the queue");
  setQueueDeadline(20_000);
  reset();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
