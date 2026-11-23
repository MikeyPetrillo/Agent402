// FIRST IMPORT of src/server.js: what has to start before any other module
// evaluates (ES imports hoist, so this module body runs first).
import { Session } from "node:inspector";

// The event-loop lag monitor starts HERE, unconditionally: started from
// server.js it began only AFTER every module had evaluated, so it reported
// worstMs 0 through a boot it could not see. It is one unref'd interval and
// stays on for the life of the process, because stalls also happen hours in.
import { startLoopLagMonitor } from "./loop-lag.js";
startLoopLagMonitor();

// Heap attribution (HEAP_SAMPLING=on, off by default): V8's sampling heap
// profiler, started here so the boot's allocations are sampled too. It keeps
// one sample per ~128 KB allocated and never pauses the process (unlike a heap
// snapshot); /__operator/heap-sampling.json reads which code allocated the
// memory that is still live, by function and by file. Turn it off once read.
let heapSession = null;
if (process.env.HEAP_SAMPLING === "on") {
  try {
    heapSession = new Session();
    heapSession.connect();
    heapSession.post("HeapProfiler.enable");
    heapSession.post("HeapProfiler.startSampling", { samplingInterval: 131072 });
  } catch (e) { heapSession = null; console.warn("[boot] heap sampling unavailable:", String(e?.message || e).slice(0, 120)); }
}

/** Live sampled allocations by function and by file, largest first. A read
 *  walks the whole sampled tree (it held the loop 0.4-1.3 s on a 400 MB heap),
 *  so concurrent reads share one walk. */
let heapReportInFlight = null;
export function heapSamplingReport({ top = 40 } = {}) {
  if (!heapSession) return Promise.resolve({ enabled: false, note: "set HEAP_SAMPLING=on and restart to sample" });
  if (!heapReportInFlight) heapReportInFlight = heapSamplingWalk(top).finally(() => { heapReportInFlight = null; });
  return heapReportInFlight;
}
async function heapSamplingWalk(top) {
  const { profile } = await new Promise((res, rej) => heapSession.post("HeapProfiler.getSamplingProfile", (e, r) => (e ? rej(e) : res(r))));
  const byFrame = new Map(), byFile = new Map();
  let total = 0;
  const walk = (n) => {
    const cf = n.callFrame || {};
    const file = String(cf.url || "(native)").split("/").slice(-2).join("/");
    if (n.selfSize) {
      const key = `${cf.functionName || "(anon)"} ${file}:${(cf.lineNumber ?? -1) + 1}`;
      byFrame.set(key, (byFrame.get(key) || 0) + n.selfSize);
      byFile.set(file, (byFile.get(file) || 0) + n.selfSize);
      total += n.selfSize;
    }
    for (const c of n.children || []) walk(c);
  };
  walk(profile.head);
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;
  const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => ({ at: k, mb: mb(v) }));
  return { enabled: true, sampledLiveMb: mb(total), byFunction: rank(byFrame), byFile: rank(byFile) };
}

// Stall attribution (src/stall-profiler.js) is OFF by default. Running it
// continuously cost a 1.1-1.6 s event-loop block every minute on production
// (2026-09-25): stopping a 60 s CPU profile and scanning it is synchronous.
// STALL_PROFILER=on restores the rolling windows; otherwise an operator takes
// one short window on demand (POST /__operator/stall-profile).
if (process.env.STALL_PROFILER === "on") {
  const t = setTimeout(() => { import("./stall-profiler.js").then((m) => m.startStallProfiler()).catch(() => {}); }, 90_000);
  t.unref();
}
