// A clock for timing bounds that a loaded host does not inflate.
//
// Wall time measures the machine, not the code: on a host running other
// suites the thread sits runnable on the scheduler's queue in the middle of a
// turn, so a query that does 40 ms of work reads 400 ms and a "never holds the
// loop" bound fails with none of our work in the gap. A bound here reads the
// time that was ours: wall time less the run-queue wait, from the thread's
// schedstat (Linux, where CI runs), or this thread's CPU time where that file
// is missing (a blocking wait then reads as 0, so under CI the file is
// required). The same reading as scripts/test-stall-routes.js.
//
// A fixed bound still assumes a machine; `bound(floor, k)` is the larger of a
// floor (what a laptop reads, with room) and k times a same-machine baseline
// job timed on this clock, so a runner several times slower gets a bound
// several times wider while a hold that is a multiple of the work still fails.
import { readFileSync } from "node:fs";

export const threadCpuMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
const SCHEDSTAT = (() => { const p = `/proc/self/task/${process.pid}/schedstat`; try { return /^\d+ \d+ \d+/.test(readFileSync(p, "utf8")) ? p : null; } catch { return null; } })();
const queuedMs = () => Number(readFileSync(SCHEDSTAT, "utf8").split(" ")[1]) / 1e6;
export const oursMs = SCHEDSTAT ? () => performance.now() - queuedMs() : threadCpuMs;
export const OURS_READING = SCHEDSTAT ? "wall time less run-queue wait" : "thread CPU";
if (process.env.CI && !SCHEDSTAT) throw new Error("ours-clock: under CI the main thread's schedstat must be readable, so a blocking wait is measured");

// Objects built, serialized, parsed, sorted: the fastest of three runs, so one
// collector pause does not decide it. About 16 ms on a laptop.
let baseline = null;
export function baselineMs() {
  if (baseline != null) return baseline;
  const once = () => {
    const t0 = oursMs();
    const rows = []; for (let i = 0; i < 36_000; i++) rows.push({ i, s: "k" + (i % 977), v: i * 1.5, t: [i, i + 1] });
    JSON.parse(JSON.stringify(rows)).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.i - b.i));
    return oursMs() - t0;
  };
  baseline = Math.min(once(), once(), once());
  return baseline;
}

export function bound(floor, k) {
  const b = baselineMs();
  const ms = Math.max(floor, Math.round(k * b));
  return { ms, note: `bound ${ms} ms: ${floor} ms or ${k}x the ${b.toFixed(1)} ms baseline, read as ${OURS_READING}` };
}

// The time fn() held this thread, on the ours clock.
export function timeOurs(fn) {
  const t0 = oursMs();
  const value = fn();
  return { value, ms: oursMs() - t0 };
}

// The longest event-loop gap while it runs, each gap read as the smaller of its
// wall length and the ours-clock advance inside it: a gap stretched by the
// scheduler is not a hold, a gap our code filled is.
export function gapMeter(everyMs = 2) {
  let worst = 0, worstWall = 0, last = performance.now(), lastOurs = oursMs();
  const iv = setInterval(() => {
    const now = performance.now(), c = oursMs();
    worstWall = Math.max(worstWall, now - last);
    worst = Math.max(worst, Math.min(now - last, c - lastOurs));
    last = now; lastOurs = c;
  }, everyMs);
  return { stop() { clearInterval(iv); return { worst, worstWall }; } };
}
