// Stall attribution + the sliced index-cache writer (2026-09-25), offline.
//   1. longestBusyRun() finds the longest unbroken non-idle run in a V8 CPU
//      profile and names its heaviest first-party frames;
//   2. the live profiler reports a real synchronous block in this process;
//   3. persistIndexCacheAsync writes the legacy JSON byte-identical to
//      JSON.stringify({savedAt, entries}), an NDJSON twin, and never holds the
//      event loop for the whole stringify.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

process.env.X402_INDEX_CRAWL = "off";
const { longestBusyRun, startStallProfiler } = await import("../src/stall-profiler.js");

// --- 1. pure analysis on a hand-built profile
{
  const node = (id, fn, url, children = []) => ({ id, callFrame: { functionName: fn, url, lineNumber: 9 }, children });
  const profile = {
    nodes: [
      node(1, "(root)", "", [2, 3, 4]),
      node(2, "(idle)", ""),
      node(3, "crawlSeller", "file:///app/src/x402-index.js", [5]),
      node(4, "handler", "file:///app/src/tools/kit.js"),
      node(5, "stringify", ""),
    ],
    startTime: 0,
    // idle, 3 x crawl stack (via stringify), idle, 1 x handler
    samples: [2, 5, 5, 3, 2, 4],
    timeDeltas: [0, 100_000, 100_000, 100_000, 100_000, 100_000],
  };
  const r = longestBusyRun(profile);
  ok(r && r.ms === 200, `the longest busy run spans 200 ms (${r?.ms})`);
  ok(r.top[0].frames === "crawlSeller@src/x402-index.js:10" && r.top[0].share === 100, `attributed to the first-party frame under the builtin (${JSON.stringify(r.top)})`);
  ok(longestBusyRun({ nodes: [], samples: [], timeDeltas: [] }) === null, "an empty profile yields no run");
}

// --- 2. the live profiler names a real block (short window via a tiny helper)
{
  const lines = [];
  process.env.STALL_PROFILER_MIN_MS = "300";
  // The real window is 60 s; drive the same inspector path directly instead.
  const inspector = await import("node:inspector");
  const s = new inspector.Session(); s.connect();
  const post = (m, p = {}) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 1000 }); await post("Profiler.start");
  function burnTheLoop() { const until = Date.now() + 450; let x = 0; while (Date.now() < until) x += Math.sqrt(x + 1); return x; }
  burnTheLoop();
  const { profile } = await post("Profiler.stop");
  s.disconnect();
  const run = longestBusyRun(profile, { firstParty: /test-stall-profiler/ });
  ok(run && run.ms >= 350, `a 450 ms synchronous block is found in a live profile (${run?.ms} ms)`);
  ok(run.top.some((x) => /burnTheLoop@/.test(x.frames)), `...and attributed to the function that did it (${run.top.map((x) => x.frames).join(" | ")})`);
  const stop = startStallProfiler({ log: (l) => lines.push(l) });
  await stop();
  ok(typeof stop === "function", "startStallProfiler returns a stop function and stops cleanly");
  process.env.STALL_PROFILER = "off";
  ok(typeof startStallProfiler() === "function", "STALL_PROFILER=off returns a no-op stop");
  delete process.env.STALL_PROFILER;
  // profileOnce: one short window, one at a time.
  const { profileOnce } = await import("../src/stall-profiler.js");
  const logs = [];
  const keepAlive = setInterval(() => {}, 1000); // the window's own timer is unref'd, as in the server
  const first = profileOnce({ seconds: 2, log: (l) => logs.push(l) });
  const second = await profileOnce({ seconds: 2 });
  ok(second.busy === true, "a second on-demand window is refused while one runs");
  const one = await first;
  ok(one.windowMs === 2000 && "run" in one, `profileOnce returns its window and the longest busy run (${one.windowMs} ms)`);
  ok((await profileOnce({ seconds: 999, log: () => {} })).windowMs === 20000, "the on-demand window is clamped to 20 s");
  clearInterval(keepAlive);
}

// --- 2b. continuous profiling is opt-in (it cost a stall a minute on production)
{
  const { readFileSync: rf } = await import("node:fs");
  const boot = rf(new URL("../src/boot-profile.js", import.meta.url), "utf8");
  ok(/if \(process\.env\.STALL_PROFILER === "on"\) \{[\s\S]*startStallProfiler/.test(boot) && !/RAILWAY_DEPLOYMENT_ID \|\| process\.env\.STALL_PROFILER === "on"\)\) \{\s*const t = setTimeout\(\(\) => \{ import\("\.\/stall-profiler/.test(boot), "rolling stall profiling starts only with STALL_PROFILER=on, never merely because we run on Railway");
  const srv = rf(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/app\.post\("\/__operator\/stall-profile"[\s\S]{0,200}operatorAuthed\(req\)/.test(srv), "the on-demand window is operator-authed");
}

// --- 3. the sliced cache writer
{
  const x = await import("../src/x402-index.js");
  const cache = x._cacheForTests();
  cache.clear();
  for (let i = 0; i < 400; i++) {
    const origin = `https://seller${i}.example`;
    cache.set(origin, { manifest: { name: `s${i}` }, tools: Array.from({ length: 40 }, (_, k) => ({ seller: origin, route: `/t${k}`, slug: `t${k}`, name: `Tool ${k}`, description: "x".repeat(200), price: 0.01 })), fetchedAt: 1, error: null, history: [1] });
  }
  const dir = mkdtempSync(join(tmpdir(), "a402-persist-"));
  const file = join(dir, "x402-index-cache.json");
  let worst = 0, last = performance.now();
  const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 1);
  const done = await x.persistIndexCacheAsync(file);
  clearInterval(iv);
  ok(done === true, "persist wrote");
  const legacy = readFileSync(file, "utf8");
  const parsed = JSON.parse(legacy);
  ok(parsed.entries.length === 400 && typeof parsed.savedAt === "number", "the legacy file parses with every origin");
  ok(legacy === JSON.stringify({ savedAt: parsed.savedAt, entries: parsed.entries }), "the legacy file is byte-identical to JSON.stringify({savedAt, entries})");
  const nd = readFileSync(join(dir, "x402-index-cache.ndjson"), "utf8").trim().split("\n");
  ok(nd.length === 401 && JSON.parse(nd[0]).origins === 400 && JSON.stringify(JSON.parse(nd[1])) === JSON.stringify(parsed.entries[0]), "the NDJSON twin has a header and one line per origin matching the legacy entries");
  ok(worst < 100, `the writer yields between batches (worst event-loop gap ${worst.toFixed(0)} ms)`);
  cache.clear();
}

console.log(`test-stall-profiler: ${n} passed`);
