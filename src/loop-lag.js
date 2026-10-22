// Event-loop lag monitor, always on.
//
// Built 2026-08-30 to answer one question with evidence instead of a hypothesis:
// seven Solana verifies failed with `fetch failed [UND_ERR_CONNECT_TIMEOUT]`
// while CDP answered from outside in 15-37 ms. A CONNECT timeout means undici's
// timer fired before a TCP connection was established - and that timer is a
// TIMER, so a blocked event loop produces exactly this error with a perfectly
// healthy network. Everything else was ruled out: rate limits return 429 (an
// answer, and their ceiling is 500 writes / 10 s), IPv6 is already forced off
// process-wide, the client uses plain fetch and so inherits that, and CDP was
// reachable throughout.
//
// We only ever instrumented BOOT (boot-profile.js, written after a 15.5 s hold),
// so a stall four hours into a container's life was invisible. This closes that:
// the next CDP timeout either coincides with a logged stall or it does not, and
// one occurrence settles which side the fault is on.
//
// Deliberately cheap: one timer, no sampling profiler, no allocation per tick.
// The measurement is the only honest one available in-process - schedule a timer
// for N ms and see how late it actually fires. Lateness IS the lag.

import { monitorEventLoopDelay, PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import { jobsDuring } from "./active-jobs.js";

const TICK_MS = Number(process.env.LOOP_LAG_TICK_MS) || 500;
const WARN_MS = Number(process.env.LOOP_LAG_WARN_MS) || 1000;
// Blocks from this size up are COUNTED (per minute, in the [loop-stats] line)
// even though only blocks over WARN_MS get a line of their own.
const COUNT_MS = Number(process.env.LOOP_LAG_COUNT_MS) || 200;
const STATS_MS = 60_000;
// Optional context for a stall line (the oldest in-flight requests), set by
// the server once its request tracker exists. Must be cheap and never throw.
let stallContext = null;
export function setStallContext(fn) { stallContext = typeof fn === "function" ? fn : null; }
let minute = { blocks200: 0, blockedMs: 0 };
// Smoothed recent lag (EWMA over ticks), read by the load-shedding gate. It
// decays back toward zero as soon as ticks run on time again.
let lagEwma = 0;
let lastLate = 0;
// The last few ticks' lateness, newest last. One stall is one late tick; a
// loop that is saturated runs every tick late.
const RECENT_TICKS = 4;
const recentLate = [];
// Stalls over WARN_MS in the last hour (bounded), for the heartbeat's alarm.
const stallTimes = []; // [at, ms]
export function stallsInWindow(windowMs = 3600_000, now = Date.now()) {
  while (stallTimes.length && now - stallTimes[0][0] > 3600_000) stallTimes.shift();
  const rows = stallTimes.filter(([at]) => now - at <= windowMs);
  return { count: rows.length, maxMs: rows.reduce((m, [, ms]) => Math.max(m, ms), 0) };
}
// The last STALL_RING stalls in full (time, ms, gc ms, in-flight routes with
// their ages, background jobs), newest last, for the operator reads and the
// serving-health culprit names. Route keys are already value-free.
const STALL_RING = 50;
const stallRing = [];
/** Record one stall (the monitor calls this; tests feed it directly). */
export function recordStall({ at = Date.now(), ms, gcMs = 0, inFlight = [], jobs = [] } = {}) {
  const row = { at: new Date(at).toISOString(), atMs: at, ms: Math.round(Number(ms) || 0), gcMs: Math.round(Number(gcMs) || 0), inFlight: [...inFlight].slice(0, 5).map(String), jobs: [...jobs].slice(0, 5).map(String) };
  row.mostlyGc = gcDominated(row);
  stallTimes.push([at, row.ms]); if (stallTimes.length > 1000) stallTimes.shift();
  stallRing.push(row); if (stallRing.length > STALL_RING) stallRing.shift();
  return row;
}
/** A stall that was mostly garbage collection: GC time at least half of it. */
export function gcDominated({ ms, gcMs } = {}) {
  const m = Number(ms) || 0, g = Number(gcMs) || 0;
  return m > 0 && g * 2 >= m;
}
/** Whether any recorded stall's block overlaps [fromMs, toMs] (epoch ms). */
export function stallOverlapping(fromMs, toMs) {
  for (const r of stallRing) if (r.atMs - r.ms <= toMs && r.atMs >= fromMs) return true;
  return false;
}
/** The last stalls, newest first (copies, without the internal epoch field). */
export function recentStalls() {
  return stallRing.slice().reverse().map(({ atMs, ...r }) => ({ ...r, inFlight: [...r.inFlight], jobs: [...r.jobs] }));
}
/**
 * ALERT_STALL_MS: one stall at least this long in the last hour degrades
 * serving health. Default 5000; "off" (or 0) disables the single-stall alarm.
 */
export function stallAlarmMsFromEnv(raw = process.env.ALERT_STALL_MS) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "0") return 0;
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : 5000;
}
/**
 * The single-long-stall verdict over the last `windowMs`: whether any stall
 * reached `thresholdMs`, and the routes and jobs named by those stalls (route
 * keys without their ages), so an alarm says what to look at.
 */
export function longStallVerdict(thresholdMs, windowMs = 3600_000, now = Date.now()) {
  const { maxMs } = stallsInWindow(windowMs, now);
  const on = thresholdMs > 0;
  const routes = [], jobs = [];
  let long = 0, gcLong = 0;
  if (on) {
    for (const r of stallRing) {
      if (now - r.atMs > windowMs || r.ms < thresholdMs) continue;
      long++;
      if (r.mostlyGc) gcLong++;
      for (const f of r.inFlight) { const k = f.replace(/\s+\d+ms( done)?$/, ""); if (!routes.includes(k)) routes.push(k); }
      for (const j of r.jobs) if (!jobs.includes(j)) jobs.push(j);
    }
  }
  // What the long stalls were: "gc" when every one was mostly garbage
  // collection, "code" when none was, "mixed" otherwise (null with none). A
  // GC-dominated stall still degrades: it froze buyers all the same.
  const cause = long === 0 ? null : gcLong === long ? "gc" : gcLong === 0 ? "code" : "mixed";
  return { degraded: on && maxMs >= thresholdMs, thresholdMs, worstMs: maxMs, longStalls: long, gcStalls: gcLong, cause, culprits: { routes: routes.slice(0, 10), jobs: jobs.slice(0, 10) } };
}
export function recentLagMs() { return Math.round(lagEwma); }
/** How many of the last RECENT_TICKS ticks ran at least `ms` late. */
export function lateTicksRecent(ms) { return recentLate.filter((x) => x >= ms).length; }
// Garbage-collection pauses, from the runtime's own gc performance entries, so
// a stall line can say whether the time went to collection or to our code.
// Before this a [loop-lag] line could not tell the two apart: an 18.5 s stall
// on 2026-09-30 at no CPU-limit pressure left nothing to read. Kept as a small
// ring of [startEpochMs, durationMs, kind]; summed over a stall's window.
const GC_RING = 256;
const gcEntries = [];
let gcMinute = { ms: 0, majorMs: 0, count: 0 };
const GC_MAJOR = perfConstants?.NODE_PERFORMANCE_GC_MAJOR ?? 4;
export function noteGcEntry(startEpochMs, durationMs, kind) {
  gcEntries.push([startEpochMs, durationMs, kind]);
  if (gcEntries.length > GC_RING) gcEntries.shift();
  gcMinute.ms += durationMs; gcMinute.count++;
  if (kind === GC_MAJOR) gcMinute.majorMs += durationMs;
}
/** GC time whose pause overlaps [fromMs, toMs] (epoch ms): total, major-only, count. */
export function gcDuring(fromMs, toMs) {
  let ms = 0, majorMs = 0, count = 0;
  for (const [at, dur, kind] of gcEntries) {
    const end = at + dur;
    if (end < fromMs || at > toMs) continue;
    const overlap = Math.min(end, toMs) - Math.max(at, fromMs);
    if (overlap <= 0) continue;
    ms += overlap; count++;
    if (kind === GC_MAJOR) majorMs += overlap;
  }
  return { ms: Math.round(ms), majorMs: Math.round(majorMs), count };
}
/** The stall line's attribution phrase: how much of a `late` ms block was GC. */
export function gcPhrase(late, now = Date.now()) {
  const g = gcDuring(now - late - 50, now);
  if (!g.count) return " gc: none";
  return ` gc: ${g.ms}ms over ${g.count} pause${g.count === 1 ? "" : "s"}${g.majorMs ? ` (major ${g.majorMs}ms)` : ""}`;
}
const state = { worstMs: 0, worstAt: null, stalls: 0, lastStallMs: 0, lastStallAt: null, startedAt: null };

/** @returns {{worstMs:number, worstAt:string|null, stalls:number, lastStallMs:number, lastStallAt:string|null, watching:boolean}} */
export function loopLagStatus() {
  return {
    watching: state.startedAt !== null,
    worstMs: Math.round(state.worstMs),
    worstAt: state.worstAt,
    stalls: state.stalls,
    lastStallMs: Math.round(state.lastStallMs),
    lastStallAt: state.lastStallAt,
    lastMinute: state.lastMinute || null,
  };
}

/** Reset the high-water mark (the operator endpoint offers this; alarms do not). */
export function resetLoopLag() {
  recentLate.length = 0;
  state.worstMs = 0; state.worstAt = null; state.stalls = 0; state.lastStallMs = 0; state.lastStallAt = null;
}

export function startLoopLagMonitor({ tickMs = TICK_MS, warnMs = WARN_MS, statsMs = STATS_MS, log = console.warn, statsLog = console.log } = {}) {
  if (state.startedAt) return () => {};
  state.startedAt = Date.now();
  // One [loop-stats] line a minute, from this same timer (one timer total):
  // event-loop delay percentiles from the runtime's own histogram, how many
  // blocks passed COUNT_MS and their total, and heap/RSS, so a slow drift is
  // visible as well as a spike.
  let gcObs = null;
  try {
    gcObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) noteGcEntry(performance.timeOrigin + e.startTime, e.duration, e.detail?.kind ?? e.kind);
    });
    gcObs.observe({ entryTypes: ["gc"] });
  } catch { gcObs = null; }
  let hist = null;
  try { hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable(); } catch { hist = null; }
  let statsDue = Date.now() + statsMs;
  const emitStats = () => {
    const mem = process.memoryUsage();
    const ms = (ns) => Math.round(ns / 1e6);
    const h = hist ? `p50=${ms(hist.percentile(50))}ms p99=${ms(hist.percentile(99))}ms max=${ms(hist.max)}ms` : "hist=n/a";
    state.lastMinute = { p50: hist ? ms(hist.percentile(50)) : null, p99: hist ? ms(hist.percentile(99)) : null, max: hist ? ms(hist.max) : null, blocks200: minute.blocks200, blockedMs: Math.round(minute.blockedMs), heapMb: Math.round(mem.heapUsed / 1048576), rssMb: Math.round(mem.rss / 1048576), at: new Date().toISOString() };
    statsLog(`[loop-stats] ${h} blocks>=${COUNT_MS}ms=${minute.blocks200} blocked=${Math.round(minute.blockedMs)}ms gc=${Math.round(gcMinute.ms)}ms major=${Math.round(gcMinute.majorMs)}ms heap=${state.lastMinute.heapMb}MB rss=${state.lastMinute.rssMb}MB`);
    minute = { blocks200: 0, blockedMs: 0 };
    gcMinute = { ms: 0, majorMs: 0, count: 0 };
    if (hist) hist.reset();
  };
  let expected = Date.now() + tickMs;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now >= statsDue) { statsDue = now + statsMs; try { emitStats(); } catch { /* stats are best-effort */ } }
    const late = now - expected;          // how much later than scheduled it ran
    expected = now + tickMs;
    lastLate = Math.max(0, late);
    recentLate.push(lastLate); if (recentLate.length > RECENT_TICKS) recentLate.shift();
    lagEwma = lagEwma * 0.6 + lastLate * 0.4;
    if (late <= 0) return;
    if (late > state.worstMs) { state.worstMs = late; state.worstAt = new Date(now).toISOString(); }
    if (late >= COUNT_MS) { minute.blocks200++; minute.blockedMs += late; }
    if (late >= warnMs) {
      state.stalls++; state.lastStallMs = late; state.lastStallAt = new Date(now).toISOString();
      // One line, with the number, so it can be correlated against a payment
      // failure by timestamp. The in-flight list names what was being served,
      // the jobs list the background work running (or ending) inside the
      // stall; the stall profiler (src/stall-profiler.js) names the code.
      let inFlight = [], jobs = [], gcMs = 0;
      try { const c = stallContext ? stallContext({ fromMs: now - late - 50 }) : null; if (Array.isArray(c)) inFlight = c; } catch { /* context is best-effort */ }
      try { jobs = jobsDuring(now - late - 50, now); } catch { /* context is best-effort */ }
      let gc = "";
      try { gc = gcPhrase(late, now); gcMs = gcDuring(now - late - 50, now).ms; } catch { /* attribution is best-effort */ }
      try { recordStall({ at: now, ms: late, gcMs, inFlight, jobs }); } catch { stallTimes.push([now, Math.round(late)]); }
      const ctx = `${inFlight.length ? ` in-flight: ${inFlight.join(", ")}` : ""}${jobs.length ? ` jobs: ${jobs.join(", ")}` : ""}`;
      log(`[loop-lag] event loop blocked ${Math.round(late)}ms (stall #${state.stalls})${gc}${gcDominated({ ms: late, gcMs }) ? " (mostly garbage collection)" : ""} - in-flight sockets can hit connect timeouts while this lasts${ctx}`);
    }
  }, tickMs);
  // Never hold the process open: a diagnostic must not change shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return () => { clearInterval(timer); if (hist) hist.disable(); if (gcObs) gcObs.disconnect(); state.startedAt = null; };
}
