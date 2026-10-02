// Stall attribution: which code held the event loop when [loop-lag] fired.
//
// loop-lag.js says THAT the loop blocked and for how long; it deliberately
// carries no profiler, so a stall has no culprit. On 2026-09-25 production
// logged a 1-8 s stall every few minutes, and a local run of the same crawler
// on a faster machine never passed 250 ms, so the cause lives in work only
// production has (live traffic, background jobs that need keys, a larger
// index). This names it from production itself.
//
// How: V8's sampling profiler (node:inspector, in process - no port is opened)
// runs in rolling windows. At the end of each window the profile is scanned for
// the longest unbroken run of non-idle samples; a run of at least MIN_RUN_MS is
// logged as ONE line (runs of 300 ms and up by default): its length, and the first-party frames that carried most
// of its samples (function name, file, line). Function names and file paths
// only - no arguments, no values, nothing a request carried.
//
// Bounded: on for STALL_PROFILER_HOURS after boot (default 6), at most
// MAX_REPORTS (400) lines, then it stops itself and the profiler with it.
// Rolling windows run ONLY with STALL_PROFILER=on: each window's stop-and-scan
// is itself synchronous (measured 1.1-1.6 s per 60 s window on production), so
// continuous profiling added a stall a minute. profileOnce() takes one short
// window on demand instead (the operator endpoint).

import inspector from "node:inspector";

const WINDOW_MS = 60_000;
const SAMPLE_US = 10_000;
const MIN_RUN_MS = Number(process.env.STALL_PROFILER_MIN_MS) || 300;
const HOURS = Number(process.env.STALL_PROFILER_HOURS) || 6;
const MAX_REPORTS = 400;
// Only "(idle)" is idle. "(program)" (engine work outside JS) and "(garbage
// collector)" hold the loop exactly as JS does; counting them as idle splits
// one long block into short runs that never pass the threshold.
const IDLE = new Set(["(idle)", "(root)"]);

/** Longest busy run in a V8 CPU profile, with its heaviest first-party frames.
 *  Pure, exported for the offline test. */
export function longestBusyRun(profile, { firstParty = /\/src\//, topN = 4 } = {}) {
  const nodes = new Map((profile?.nodes || []).map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of nodes.values()) for (const c of n.children || []) parent.set(c, n.id);
  const frameOf = (n) => `${n.callFrame.functionName || "(anonymous)"}@${String(n.callFrame.url || "").replace(/^.*\/src\//, "src/")}:${n.callFrame.lineNumber + 1}`;
  // The deepest first-party frames of a sample's stack, innermost first.
  const ownFrames = (id) => {
    const out = [];
    for (let c = id; c != null && out.length < 3; c = parent.get(c)) {
      const n = nodes.get(c);
      if (n && firstParty.test(n.callFrame.url || "")) out.push(frameOf(n));
    }
    return out;
  };
  let best = null, cur = null;
  let t = profile?.startTime || 0;
  const samples = profile?.samples || [];
  const deltas = profile?.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] || 0;
    const n = nodes.get(samples[i]);
    const busy = n && !IDLE.has(n.callFrame.functionName);
    if (busy) {
      if (!cur) cur = { start: t, end: t, weights: new Map() };
      cur.end = t;
      const key = ownFrames(samples[i]).join(" < ") || frameOf(n);
      cur.weights.set(key, (cur.weights.get(key) || 0) + 1);
    } else if (cur) {
      if (!best || cur.end - cur.start > best.end - best.start) best = cur;
      cur = null;
    }
  }
  if (cur && (!best || cur.end - cur.start > best.end - best.start)) best = cur;
  if (!best) return null;
  const total = [...best.weights.values()].reduce((a, b) => a + b, 0) || 1;
  return {
    ms: Math.round((best.end - best.start) / 1000),
    at: best.start,
    top: [...best.weights].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([frames, n]) => ({ frames, share: Math.round((n / total) * 100) })),
  };
}

let oneShotBusy = false;
/** One profiling window of `seconds` (clamped 2-20), scanned once. Resolves to
 *  the longest busy run (or null), and logs it when it passes MIN_RUN_MS. One
 *  window at a time; refuses (resolves {busy:true}) while one is running. */
export async function profileOnce({ seconds = 10, log = console.warn } = {}) {
  if (oneShotBusy) return { busy: true };
  oneShotBusy = true;
  const session = new inspector.Session();
  try {
    session.connect();
    const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));
    const ms = Math.max(2, Math.min(20, Number(seconds) || 10)) * 1000;
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
    await post("Profiler.start");
    await new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === "function") t.unref(); });
    const { profile } = await post("Profiler.stop");
    const run = longestBusyRun(profile);
    if (run && run.ms >= MIN_RUN_MS) log(`[stall-profile] ${run.ms}ms busy run: ${run.top.map((x) => `${x.share}% ${x.frames}`).join(" | ")}`);
    return { windowMs: ms, run };
  } finally {
    try { session.disconnect(); } catch { /* ignore */ }
    oneShotBusy = false;
  }
}

export function startStallProfiler({ log = console.warn } = {}) {
  if (String(process.env.STALL_PROFILER || "").toLowerCase() === "off") return () => {};
  const session = new inspector.Session();
  try { session.connect(); } catch { return () => {}; }
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));
  const deadline = Date.now() + HOURS * 3600_000;
  let reports = 0, stopped = false, timer = null;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { await post("Profiler.stop"); } catch { /* already stopped */ }
    try { session.disconnect(); } catch { /* ignore */ }
  };
  (async () => {
    try {
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
      await post("Profiler.start");
    } catch { await stop(); return; }
    timer = setInterval(async () => {
      if (stopped) return;
      try {
        const { profile } = await post("Profiler.stop");
        if (Date.now() < deadline && reports < MAX_REPORTS) await post("Profiler.start");
        const run = longestBusyRun(profile);
        if (run && run.ms >= MIN_RUN_MS) {
          reports++;
          log(`[stall-profile] ${run.ms}ms busy run: ${run.top.map((x) => `${x.share}% ${x.frames}`).join(" | ")}`);
        }
        if (Date.now() >= deadline || reports >= MAX_REPORTS) {
          log(`[stall-profile] stopped (${reports} runs reported)`);
          await stop();
        }
      } catch { await stop(); }
    }, WINDOW_MS);
    if (typeof timer.unref === "function") timer.unref();
  })();
  return stop;
}
