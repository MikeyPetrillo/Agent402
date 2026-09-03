// FIRST IMPORT of src/server.js (diagnostic, 2026-08-25): a sampling CPU
// profile of the whole boot - module evaluation, warm-starts, the post-listen
// continuations - started here, synchronously, before any other module runs.
// The earlier in-file profiler only began after its own async setup and so
// missed the very stall it was meant to catch (a 15.5 s event-loop hold that
// ends as the listener's callback first runs). Reports the top self-time
// frames INCLUDING garbage collection, which the first version filtered out.
// Railway only (RAILWAY_DEPLOYMENT_ID) or BOOT_CPU_PROFILE=on; =off disables.
// Remove once the stall is fixed.
import { Session } from "node:inspector";

// The event-loop lag monitor starts HERE, unconditionally, for the same reason
// the CPU profile does: this module body is the first thing that runs, and ES
// imports hoist. Started from server.js it began only AFTER every module had
// evaluated, so it reported worstMs 0 through a boot it could not see. It is
// one unref'd interval; unlike the profile above it stays on for the life of
// the process, because the stall we are chasing happens hours in.
import { startLoopLagMonitor } from "./loop-lag.js";
startLoopLagMonitor();

const on = process.env.BOOT_CPU_PROFILE !== "off" && (process.env.RAILWAY_DEPLOYMENT_ID || process.env.BOOT_CPU_PROFILE === "on");
if (on) {
  try {
    const session = new Session();
    session.connect();
    const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
    // In-process inspector commands complete synchronously enough that the
    // profile is running before the next module evaluates.
    session.post("Profiler.enable");
    session.post("Profiler.setSamplingInterval", { interval: 2000 });
    session.post("Profiler.start");
    const t0 = Date.now();
    const stop = setTimeout(async () => {
      try {
        const { profile } = await post("Profiler.stop");
        const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        const self = new Map();
        const dt = profile.timeDeltas || [];
        let total = 0;
        for (let i = 0; i < profile.samples.length; i++) {
          const n = byId.get(profile.samples[i]);
          if (!n) continue;
          const cf = n.callFrame;
          const key = `${cf.functionName || "(anon)"} ${String(cf.url || "").split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`;
          self.set(key, (self.get(key) || 0) + (dt[i] || 0));
          total += dt[i] || 0;
        }
        const top = [...self.entries()].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12);
        console.warn(`[boot] cpu profile from first import, ${Math.round((Date.now() - t0) / 1000)}s window, ${Math.round(total / 1e6)}s sampled; top self-time frames (GC included):\n` +
          top.map(([k, us]) => `  ${String(Math.round(us / 1000)).padStart(6)}ms  ${k}`).join("\n"));
      } catch (e) { console.warn("[boot] cpu profile failed:", String(e?.message || e).slice(0, 120)); }
      finally { try { session.disconnect(); } catch { /* done */ } }
    }, 75_000);
    stop.unref();
  } catch (e) { console.warn("[boot] cpu profile unavailable:", String(e?.message || e).slice(0, 120)); }
}
