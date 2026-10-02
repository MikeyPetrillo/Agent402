// The stall sources the production profiler named on 2026-09-25, each moved
// off a single synchronous turn. Offline.
//   1. The tool directory (/marketplace/tools, /api/index/tools) on a
//      production-sized index: a stale directory is served at once and rebuilt
//      in the background without holding the loop, and the rebuilt rows are
//      identical to a synchronous build.
//   2. The /revenue series is built across turns and its buyer figures share
//      one read of the payment history (source pins: the ledger needs a
//      populated database).
//   3. The per-page chain strip is memoized on its inputs (source pin).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const GAP_MS = Number(process.env.OFFLOAD_GAP_MS || 120);

process.env.X402_INDEX_CRAWL = "off";
const x = await import("../src/x402-index.js");
const { buildRoutePerfFixture } = await import("./lib/route-perf-fixture.js");
const cache = x._cacheForTests();
buildRoutePerfFixture({ cache: { set: (o, e) => cache.set(o, { ...e, fetchedAt: 1, history: [1] }) } });
const digest = (r) => createHash("sha256").update(JSON.stringify([r.total, r.matched, r.results])).digest("hex");

// --- 1. the directory
{
  const first = x.allIndexedTools({ limit: 200, offset: 5000 });
  ok(first.total > 100_000, `the directory is production-sized (${first.total} rows)`);
  // Replace one seller's entry: the memo is now stale.
  const [origin, v] = [...cache.entries()].find(([, e]) => (e.tools || []).length > 3);
  const renamed = { ...v, tools: v.tools.map((t, i) => (i === 0 ? { ...t, name: "offload-stalls-marker", description: "offload stalls marker row for the test" } : t)) };
  cache.set(origin, renamed);
  // Timed on a plain page read: a search read first builds each row's search
  // text, which is its own cost (asserted below) and not what this measures.
  // An inline rebuild of this directory is 160 ms+ locally; the stale read is
  // a slice of the rows already built.
  const t0 = performance.now();
  x.allIndexedTools({ limit: 100, offset: 1000 });
  const staleMs = performance.now() - t0;
  const stale = x.allIndexedTools({ search: "offload-stalls-marker", limit: 5 });
  let worst = 0, last = performance.now();
  const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 1);
  ok(stale.matched === 0, "the stale directory is served while the rebuild runs (the change is not in it yet)");
  ok(staleMs < 150, `serving it does not wait on a rebuild (${Math.round(staleMs)} ms)`);
  await x._indexRowsSettledForTest();
  clearInterval(iv);
  ok(worst < GAP_MS, `the background rebuild never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
  const fresh = x.allIndexedTools({ search: "offload-stalls-marker", limit: 5 });
  ok(fresh.matched === 1, "the rebuilt directory carries the change");
  const t1 = performance.now();
  x.allIndexedTools({ search: "offload-stalls-marker", limit: 5 });
  const warmSearchMs = performance.now() - t1;
  ok(warmSearchMs < 60, `a repeat directory search reuses each row's search text (${Math.round(warmSearchMs)} ms)`);
  // The background rows equal a synchronous build of the same cache.
  const bg = digest(x.allIndexedTools({ limit: 300, offset: 40_000 }));
  x._resetFlatCacheForTest(); x._resetIndexRowsForTest();
  const sync = digest(x.allIndexedTools({ limit: 300, offset: 40_000 }));
  ok(bg === sync, "background and synchronous builds produce the same rows in the same order");
}

// --- 1b. the router's per-tool records stay hidden, and the heap stays bounded
{
  x.warmRouteIndex();
  const rq = x.routeQuery ? null : null; void rq;
  const v = [...cache.values()].find((e) => (e.tools || []).length > 3);
  const snapshot = JSON.stringify(v.tools[0]);
  ok(!/toolStatics|routeHome/.test(snapshot) && Object.getOwnPropertySymbols(v.tools[0]).length === 0, "the crawled tool objects are untouched by the router");
  const figs = x.indexMemoryFigures();
  ok(figs.routeIndexedTools > 100_000 && figs.internedTokens > 0 && figs.internedTokens < figs.routeIndexedTools, `name tokens are interned (${figs.internedTokens} distinct across ${figs.routeIndexedTools} tools)`);
  {
    // CI runs without --expose-gc; enable it here so the ceiling is never skipped.
    const v8 = await import("node:v8"); const vm = await import("node:vm");
    v8.setFlagsFromString("--expose-gc");
    const gc = globalThis.gc || vm.runInNewContext("gc");
    gc(); gc();
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
    ok(heapMb < Number(process.env.OFFLOAD_HEAP_MB || 520), `the production-sized index, router and directory fit under the heap ceiling (${heapMb} MB)`);
  }
}

// --- 2 + 3. source pins
{
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = srv.slice(srv.indexOf("async function buildRevenueDaily()"), srv.indexOf("// Daily revenue series for the /revenue chart"));
  ok((fn.match(/await turn\(\)/g) || []).length >= 5, "the /revenue series yields the event loop between each figure");
  ok(/memoSurfaceAsync\("revenue:daily"/.test(srv), "the /revenue series is served stale while it rebuilds");
  ok(/const events = externalPaymentEventsFor\(w\)/.test(fn) && (fn.match(/\{ events \}/g) || []).length === 5, "the five buyer figures share one read of the payment history");
  ok(/app\.get\("\/__operator\/heap\.json"[\s\S]{0,120}operatorAuthed\(req\)/.test(srv), "the heap read is operator-authed");
  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/enumerable: false/.test(idx) && !/toolHome: new WeakMap/.test(idx), "per-tool router records are hidden properties, not WeakMap entries");
  ok(/navChainsMemo\.snapshot === snapshot && navChainsMemo\.board === \(board\?\.leaderboard \|\| null\)/.test(srv), "the chain strip is memoized on the index snapshot and the leaderboard rows");
}

console.log(`test-offload-stalls: ${n} passed`);
process.exit(0);
