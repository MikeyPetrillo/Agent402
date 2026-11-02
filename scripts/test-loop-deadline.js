#!/usr/bin/env node
// A store deadline counts loop time (src/loop-deadline.js), offline.
//
// Under load, a server's boot work held the loop past the shared store's 1 s
// command deadline while the answer sat unread; the timers phase ran before
// the poll phase, so the deadline fired first, a healthy Redis read "degraded"
// for a minute and the control decided on local counters. Here the answer is
// a single threadpool read issued before the loop is held, which completes
// during the hold exactly like a socket answer would:
//   - an answer that arrived while the loop was held is taken (the shared
//     store's command deadline, and the connect wait);
//   - a store that never answers still times out, promptly when the loop is
//     free and boundedly when it is held;
//   - a rejection still propagates.
//   node scripts/test-loop-deadline.js
import { writeFileSync, mkdtempSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopDeadline, withLoopTimeout, withLoopDeadline } from "../src/loop-deadline.js";
import { createRedisLimits } from "../src/shared-limits.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
// The deadline timers are unref'd, as in production: hold the process open.
const keepAlive = setInterval(() => {}, 1000);
// Each held case starts in the check phase (right after setImmediate), so the
// next phase to run after the hold is the timers phase: the order a held boot
// meets, where a plain timer fires before the poll phase reads the answer.
const checkPhase = () => new Promise((r) => setImmediate(r));
// The limits resolve their client before sending: let those microtasks run
// (no loop turn, so no I/O is read) so the command is in flight before the hold.
const inFlight = async () => { for (let i = 0; i < 20; i++) await null; };
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* the loop is held */ } };

const file = join(mkdtempSync(join(tmpdir(), "loop-deadline-")), "answer");
writeFileSync(file, "x".repeat(64));
const fh = await open(file, "r");
// One threadpool request, issued now: its completion is read in a poll phase.
const answerSoon = (value) => fh.read(Buffer.alloc(8), 0, 8, 0).then(() => value);

// 1. The shared store's command deadline, through the real Redis-backed limits.
{
  const fakeClient = { eval: () => answerSoon([1, 1, []]) };
  const limits = createRedisLimits(async () => fakeClient, { opTimeoutMs: 200 });
  await checkPhase();
  const p = limits.windowRead("t", "k", { windowMs: 60_000 });
  await inFlight();
  spin(500); // the loop held past the 200 ms deadline while the answer landed
  const r = await p;
  ok(r.ok === true, `an answer that arrived while the loop was held is read, not a timeout (${JSON.stringify(r)})`);
}
{
  const hung = { eval: () => new Promise(() => {}) };
  const limits = createRedisLimits(async () => hung, { opTimeoutMs: 150 });
  const t0 = performance.now();
  const r = await limits.windowRead("t", "k", { windowMs: 60_000 });
  const took = performance.now() - t0;
  ok(r.ok === false && /timed out/.test(r.error) && took >= 140 && took < 600, `a store that never answers still times out on a free loop (${Math.round(took)} ms, ${r.error})`);
}
{
  const hung = { eval: () => new Promise(() => {}) };
  const limits = createRedisLimits(async () => hung, { opTimeoutMs: 150 });
  const t0 = performance.now();
  await checkPhase();
  const p = limits.windowRead("t", "k", { windowMs: 60_000 });
  await inFlight();
  spin(400);
  const r = await p;
  const took = performance.now() - t0;
  ok(r.ok === false && took < 400 + 2 * 150 + 300, `with the loop held it still ends, within twice the deadline past the hold (${Math.round(took)} ms)`);
}
// 2. The connect wait (src/shared-limit.js): a connect that completed during a hold is taken.
{
  await checkPhase();
  const p = withLoopDeadline(answerSoon("client"), 200, null);
  spin(500);
  ok((await p) === "client", "a connect that completed while the loop was held is taken, not reported unreachable");
  ok((await withLoopDeadline(new Promise(() => {}), 50, null)) === null, "a connect that never completes gives the fallback");
  let threw = null;
  try { await withLoopDeadline(Promise.reject(new Error("boom")), 50, null); } catch (e) { threw = e; }
  ok(threw?.message === "boom", "a rejected wait still rejects");
  threw = null;
  try { await withLoopTimeout(new Promise(() => {}), 50, () => new Error("late")); } catch (e) { threw = e; }
  ok(threw?.message === "late", "withLoopTimeout rejects with the given error");
}
// 3. Each correction on its own. The expiry waits one poll phase: a hold that
//    ends just past the deadline (not late enough to re-arm) still reads the
//    answer that landed in it. The re-arm gives back the held time: an answer
//    that needs a second round trip after the hold still lands.
{
  await checkPhase();
  const p = withLoopDeadline(answerSoon("one"), 200, null);
  spin(205);
  ok((await p) === "one", "an answer that landed during a hold ending at the deadline is read before the expiry");
}
{
  await checkPhase();
  const p = withLoopDeadline(answerSoon(null).then(() => answerSoon("two")), 200, null);
  spin(500);
  ok((await p) === "two", "an answer needing a second round trip after a long hold gets the held time back");
}
// 4. The re-arm is bounded to once, whatever the clock says.
{
  let t = 0, fired = 0;
  const now = () => t;
  await new Promise((resolve) => {
    loopDeadline(10, () => { fired++; resolve(); }, { now: () => { t += 1000; return now(); } });
  });
  ok(fired === 1, "a clock that always reads late re-arms once and then expires");
}
await fh.close();
clearInterval(keepAlive);
console.log(`\ntest-loop-deadline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
