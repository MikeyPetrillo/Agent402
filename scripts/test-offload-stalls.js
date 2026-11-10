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
// And the holds a production-sized crawl cycle showed locally (2026-11-04),
// each now taken in steps with the one-pass answer: the payTo scans the
// boards refresh (1d), one large seller's listing row, routable summary,
// service key and template matching (1e), the Base board's registry walk
// (1f), and the cache files written without a state database (1g).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { oursMs, leastOurs } from "./lib/ours-clock.js";
import "./lib/uncapped-sellers.js"; // seeds a 30,000-tool seller past the per-seller cap
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
// Loop gaps below are read on the ours clock (scripts/lib/ours-clock.js): the
// smaller of a gap's wall length and the time the thread had a core inside
// it. A host busy with other suites deschedules the thread mid-turn, and that
// wait is not a hold by this code.
const GAP_MS = Number(process.env.OFFLOAD_GAP_MS || 120);
// How many event-loop turns a piece of work advanced in: `counter` is the
// work's own step count, sampled once a turn until `work` settles. A pass
// taken in one turn advances in one, however many steps it counts.
async function turnsAdvancing(counter, start) {
  let done = false, turns = 0, seen = counter();
  const p = Promise.resolve(start()).finally(() => { done = true; });
  // The turn that started the work counts as one if it advanced it.
  if (counter() !== seen) { turns++; seen = counter(); }
  while (!done) {
    await new Promise((r) => setImmediate(r));
    const now = counter();
    if (now !== seen) { turns++; seen = now; }
  }
  return { turns, value: await p };
}

process.env.X402_INDEX_CRAWL = "off";
const x = await import("../src/x402-index.js");
const { buildRoutePerfFixture } = await import("./lib/route-perf-fixture.js");
const cache = x._cacheForTests();
const { ctx: routeCtx } = buildRoutePerfFixture({ cache: { set: (o, e) => cache.set(o, { ...e, fetchedAt: 1, history: [1] }) } });
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
  // Synchronous, so read as the time the thread had a core, least of three
  // reads (each is the stale slice again; the rebuild runs on later turns).
  const staleMs = leastOurs(() => x.allIndexedTools({ limit: 100, offset: 1000 })).ms;
  const stale = x.allIndexedTools({ search: "offload-stalls-marker", limit: 5 });
  let worst = 0, last = performance.now(), lastOurs = oursMs();
  const iv = setInterval(() => { const now = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(now - last, c - lastOurs)); last = now; lastOurs = c; }, 1);
  ok(stale.matched === 0, "the stale directory is served while the rebuild runs (the change is not in it yet)");
  ok(staleMs < 150, `serving it does not wait on a rebuild (${Math.round(staleMs)} ms)`);
  await x._indexRowsSettledForTest();
  clearInterval(iv);
  ok(worst < GAP_MS, `the background rebuild never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
  const fresh = x.allIndexedTools({ search: "offload-stalls-marker", limit: 5 });
  ok(fresh.matched === 1, "the rebuilt directory carries the change");
  // Judged by work, not wall time: a shared runner's clock is not a measure.
  const builds0 = x._directoryHayBuildsForTest();
  x.allIndexedTools({ search: "offload-stalls-marker", limit: 5 });
  const rebuilt = x._directoryHayBuildsForTest() - builds0;
  ok(rebuilt === 0, `a repeat directory search reuses each row's search text (${rebuilt} rebuilt)`);
  // The background rows equal a synchronous build of the same cache.
  const bg = digest(x.allIndexedTools({ limit: 300, offset: 40_000 }));
  x._resetFlatCacheForTest(); x._resetIndexRowsForTest();
  const sync = digest(x.allIndexedTools({ limit: 300, offset: 40_000 }));
  ok(bg === sync, "background and synchronous builds produce the same rows in the same order");
  // A search is one pass over every row: the routes run it in slices, with
  // the same answer as the whole pass.
  for (const args of [{ search: "json", limit: 50, offset: 20 }, { category: "data", limit: 100 }, { source: "third-party", search: "price", limit: 10, offset: 300 }]) {
    const whole = x.allIndexedTools(args);
    const sliced = await x.allIndexedToolsAsync(args);
    ok(isDeepStrictEqual(sliced, whole) && whole.matched > 0, `the sliced search answers as the whole pass (${JSON.stringify(args)}: ${whole.matched} matched)`);
  }
  {
    // Counted from the rows themselves, not from the pass under test.
    const narrow = await x.allIndexedToolsAsync({ search: "offload-stalls-marker", limit: 500 });
    ok(narrow.matched === narrow.results.length && narrow.results.every((t) => /offload-stalls-marker/i.test(`${t.name} ${t.description}`)), `a search keeps only matching rows (${narrow.matched})`);
    ok(narrow.described === narrow.results.filter((t) => t.described).length, `described counts the matched rows that carry a description (${narrow.described})`);
  }
  {
    // The caller path: both directory routes await the sliced search.
    const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
    const route = (p) => srv.slice(srv.indexOf(`app.get("${p}"`), srv.indexOf(`app.get("${p}"`) + 900);
    ok(["/marketplace/tools", "/api/index/tools"].every((p) => /await allIndexedToolsAsync\(\{/.test(route(p))) && !/[^.\w]allIndexedTools\(/.test(srv), "the directory routes run the search in slices, never the whole pass");
  }
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
    // The operator heap read's byte estimate: sampled, so it stays cheap at
    // production scale, and close to the whole cache serialized.
    // The fastest of three reads: one collector pause does not decide the bound.
    let sampled = null, readMs = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const r = x.indexMemoryFigures({ sampleBytes: true });
      const ms = performance.now() - t0;
      if (ms < readMs) { readMs = ms; sampled = r; }
    }
    // Timed against serializing every entry's tools on the same machine, so a
    // slow runner slows both: the sampled read must stay a small fraction of
    // the whole (the median of three serializes, so one pause on either side
    // does not decide it), under a generous absolute cap. A read that walked
    // every entry would take about all of it.
    let whole = 0;
    const wholeRuns = [];
    for (let k = 0; k < 3; k++) {
      const t1 = performance.now();
      whole = 0;
      for (const e of cache.values()) whole += JSON.stringify(e.tools || []).length;
      wholeRuns.push(performance.now() - t1);
    }
    const wholeMs = wholeRuns.sort((a, b) => a - b)[1];
    const readBound = Math.min(500, Math.max(20, wholeMs * 0.4));
    const wholeMb = whole / 1048576, est = sampled.jsonMbEstimate;
    ok(est && est.sampledEntries > 50 && est.sampledEntries <= 2 * 120 && readMs < readBound, `the sampled heap read reads ${est?.sampledEntries} entries in ${readMs.toFixed(1)} ms (whole serialize ${wholeMs.toFixed(1)} ms; bound ${Math.round(readBound)} ms: 40% of it, under 500 ms)`);
    ok(Math.abs(est.tools - wholeMb) <= Math.max(2, wholeMb * 0.25), `...and its tool-row estimate (${est.tools} MB) is within 25% of the whole serialized (${wholeMb.toFixed(1)} MB)`);
    ok(sampled.routeIndex?.tokens > 0 && sampled.routeIndex.postingRefs >= sampled.routeIndex.tokens, `...and it counts the route index (${sampled.routeIndex?.tokens} tokens, ${sampled.routeIndex?.postingRefs} postings)`);
    ok(!("jsonMbEstimate" in figs), "the plain read stays counts only");
  }
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

// --- 1c. a route query meets an index backlog (a peer pull or a crawl burst
// replaced half the entries) and answers in slices: it never indexes the
// backlog inline (that held the loop 5.4 s on prod, 2026-10-23), it scans the
// pending entries whole, and its answer equals the one once they are indexed.
{
  const { PerformanceObserver } = await import("node:perf_hooks");
  const gcs = [];
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gcs.push([e.startTime, e.startTime + e.duration]); });
  obs.observe({ entryTypes: ["gc"] });
  const Q = "pdf extract text";
  let i = 0;
  for (const [o, v] of [...cache]) if (i++ % 2 === 0) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })) });
  const pendingBefore = x._routeIndexStatsForTest().pending;
  await new Promise((r) => setTimeout(r, 20));
  const gaps = [];
  let last = performance.now(), lastOurs = oursMs();
  const timer = setInterval(() => { const t = performance.now(), c = oursMs(); gaps.push([last, t, c - lastOurs]); last = t; lastOurs = c; }, 1);
  gcs.length = 0;
  // Rows the query scans whole: the entries still pending as it starts, at
  // the index's mean catalogue size.
  const pendingTools = Math.round(x._routeIndexStatsForTest().pending * [...cache.values()].reduce((s, v) => s + (v.tools || []).length, 0) / cache.size);
  const y0 = x._routeCandidateYieldsForTest();
  const sliced = await x.routeQueryAsyncInThread({ query: Q, top: 25, ...routeCtx });
  const candidateYields = x._routeCandidateYieldsForTest() - y0;
  await new Promise((r) => setTimeout(r, 50));
  clearInterval(timer);
  obs.disconnect();
  let worst = 0;
  for (const [a, b, ours] of gaps) {
    let inGc = 0;
    for (const [s0, e0] of gcs) inGc += Math.max(0, Math.min(b, e0) - Math.max(a, s0));
    worst = Math.max(worst, Math.min(b - a, ours) - inGc);
  }
  while (x._routeIndexStatsForTest().pending || x._routeIndexStatsForTest().partial) await new Promise((r) => setImmediate(r));
  const drained = x.routeQuery({ query: Q, top: 25, ...routeCtx });
  // Same-machine baseline: the synchronous query (the worker-thread path)
  // indexes a backlog of the same size inline, the cost the sliced query
  // avoids. A slow runner slows both, so the bound is a share of it (a query
  // that drained inline again would hold about all of it), under a ceiling
  // that only a runner several times slower than usual reaches.
  i = 0;
  for (const [o, v] of [...cache]) if (i++ % 2 === 0) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })) });
  const t0 = performance.now();
  x.routeQuery({ query: Q, top: 25, ...routeCtx });
  const inlineMs = performance.now() - t0;
  const bound = Math.min(1000, Math.max(GAP_MS, inlineMs * 0.4));
  ok(pendingBefore > 1000 && worst < bound, `a route query over a ${pendingBefore}-entry index backlog never holds the loop long (worst ${Math.round(worst)} ms, collector subtracted; bound ${Math.round(bound)} ms: ${GAP_MS} ms or 40% of the ${Math.round(inlineMs)} ms inline drain, under 1000 ms)`);
  // A row's first statics run the listing screen: the scan of a pending
  // entry offers a yield every 16 rows (every 256 held a slice past 100 ms).
  ok(candidateYields >= pendingTools / 16 / 2, `the scan of pending rows offers a yield every 16 rows (${candidateYields} for about ${pendingTools} rows)`);
  // A mismatch names its first differing row, so a failure says what moved.
  const firstDiff = () => {
    if (sliced.count !== drained.count || sliced.sellersMatched !== drained.sellersMatched) return `; count ${sliced.count} vs ${drained.count}, sellers ${sliced.sellersMatched} vs ${drained.sellersMatched}`;
    const k = sliced.results.findIndex((r, j) => JSON.stringify(r) !== JSON.stringify(drained.results[j]));
    return k < 0 ? "" : `; row ${k}: ${JSON.stringify(sliced.results[k]).slice(0, 300)} vs ${JSON.stringify(drained.results[k]).slice(0, 300)}`;
  };
  ok(sliced.count > 0 && JSON.stringify([sliced.count, sliced.sellersMatched, sliced.results]) === JSON.stringify([drained.count, drained.sellersMatched, drained.results]), `...and its answer equals the answer once the backlog is indexed (${sliced.count} rows${firstDiff()})`);
  // A pending row is a candidate by the index's own rule: a row that shares
  // only a non-selecting word ("to", "the") with the query is not one, so a
  // query whose one real word matches nothing answers nothing, backlog or not.
  i = 0;
  for (const [o, v] of [...cache]) if (i++ % 2 === 0) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })) });
  // Read before the query: the background drain keeps indexing while the
  // query yields, so the backlog can be gone by the time it answers.
  const pendingAtQuery = x._routeIndexStatsForTest().pending > 0 || !!x._routeIndexStatsForTest().partial;
  const none = await x.routeQueryAsyncInThread({ query: "to the zzqqnomatch", top: 25, include: "external", ...routeCtx });
  ok(pendingAtQuery, "the backlog is pending when that query starts");
  ok(none.count === 0, `a pending row sharing only "to"/"the" with the query is not a candidate (${none.count} rows)`);
}

// --- 1d. the payTo scans the board refreshes read (every tool row the index
// holds, once per chain per refresh) run in steps of a bounded number of rows,
// and the sliced Map equals the one-pass Map exactly.
{
  const SOL = "solana:5eykT4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const bazaar = [];
  for (let i = 0; i < 400; i++) {
    const origin = `https://bazaar${i % 120}.example`;
    bazaar.push([origin, Array.from({ length: 5 }, (_, j) => ({ route: `${origin}/r${i}-${j}`, price: (j + 1) / 1000, payToByNetwork: { "eip155:8453": `0x${String(9000 + i).padStart(40, "a")}`, [SOL]: `So1${String(i).padStart(40, "1")}`.slice(0, 43) } }))]);
  }
  const byOrigin = new Map();
  for (const [o, rows] of bazaar) byOrigin.set(o, [...(byOrigin.get(o) || []), ...rows]);
  for (const [o, rows] of byOrigin) x.__testSetBazaarTools(o, rows);
  // A few crawled rows carry a Solana payTo and a free or unpriced route.
  let k = 0;
  for (const [o, v] of [...cache]) {
    if (k++ % 40 !== 0) continue;
    cache.set(o, { ...v, tools: v.tools.map((t, j) => (j % 3 === 0 ? { ...t, payToByNetwork: { ...t.payToByNetwork, solana: `Sol${String(j).padStart(40, "2")}`.slice(0, 44) } } : j % 3 === 1 ? { ...t, paid: false } : { ...t, price: null })) });
  }
  // The one-pass reference, written out here: the loops the scans ran before
  // they were sliced, over the same cache and registry rows.
  const add = (out, k2, origin) => { let s = out.get(k2); if (!s) { s = new Set(); out.set(k2, s); } s.add(origin); };
  const crawled = [...cache.entries()];
  const regs = [...byOrigin.entries()];
  const refOrigins = (net) => {
    const out = new Map();
    for (const [o, v] of crawled) for (const t of v?.tools || []) { const a = t?.payToByNetwork?.[net]; if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) add(out, a.toLowerCase(), o); }
    for (const [o, arr] of regs) for (const t of arr) { const a = t?.payToByNetwork?.[net]; if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) add(out, a.toLowerCase(), o); }
    return out;
  };
  const { priceToMicroUsd } = x;
  const refPrices = (net) => {
    const out = new Map();
    for (const [, v] of crawled) for (const t of v?.tools || []) {
      const a = t?.payToByNetwork?.[net];
      if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a) || t.paid === false) continue;
      const micro = priceToMicroUsd(t.price);
      if (micro > 0) add(out, a.toLowerCase(), micro);
    }
    return out;
  };
  const refSolana = () => {
    const out = new Map();
    const from = (t, o) => { for (const [net, a] of Object.entries(t?.payToByNetwork || {})) if (x.SOLANA_MAINNET_LABELS.has(String(net).toLowerCase()) && typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) add(out, a, o); };
    for (const [o, v] of crawled) for (const t of v?.tools || []) from(t, o);
    for (const [o, arr] of regs) for (const t of arr) from(t, o);
    return out;
  };
  const rows = crawled.reduce((n, [, v]) => n + (v.tools || []).length, 0);
  for (const [kind, net, ref, sync, sliced] of [
    ["origins", "eip155:8453", refOrigins, () => x.allPayToOrigins("eip155:8453"), () => x.allPayToOriginsAsync("eip155:8453")],
    ["prices", "eip155:8453", refPrices, () => x.allPayToPrices("eip155:8453"), () => x.allPayToPricesAsync("eip155:8453")],
    ["solana", null, refSolana, () => x.allSolanaPayToOrigins(), () => x.allSolanaPayToOriginsAsync()],
  ]) {
    // Rows read per step, counted by the scan itself: one step per pass is
    // the one-turn walk this replaced.
    const gen = x._payToScanStepsForTest(kind, net);
    let steps = 0, maxRows = 0, before = x._payToScanRowsForTest(), r;
    do { r = gen.next(); const now = x._payToScanRowsForTest(); maxRows = Math.max(maxRows, now - before); before = now; steps++; } while (!r.done);
    ok(steps > 20 && maxRows <= 2000, `the ${kind} payTo scan reads at most ${maxRows} of ${rows}+ rows per step (${steps} steps)`);
    let worst = 0, last = performance.now(), lastOurs = oursMs();
    const iv = setInterval(() => { const t = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(t - last, c - lastOurs)); last = t; lastOurs = c; }, 1);
    const { turns, value: got } = await turnsAdvancing(() => x._payToScanRowsForTest(), sliced);
    clearInterval(iv);
    const want = ref(net);
    // On a clock that moves 50 ms per read, every slice ends after one step,
    // so the turn count no longer depends on the machine: a pass taken in one
    // turn still advances in one.
    const real = performance.now;
    let fake = real.call(performance);
    performance.now = () => (fake += 50);
    let stepped;
    try { stepped = await turnsAdvancing(() => x._payToScanRowsForTest(), sliced); } finally { performance.now = real; }
    ok(turns >= 1 && stepped.turns >= 20 && isDeepStrictEqual(stepped.value, ref(net)), `...and the sliced scan yields after each step (${stepped.turns} turns on a stepping clock, ${turns} on the real one)`);
    ok(want.size > 50 && isDeepStrictEqual(got, want) && isDeepStrictEqual(sync(), want), `...and its sliced and one-turn Maps equal the one-pass Map (${want.size} wallets)`);
    ok(worst < GAP_MS, `...and the sliced scan never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
  }
  for (const [o] of byOrigin) x.__testSetBazaarTools(o, null);
  // The caller path: the board refreshes take the sliced forms.
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/crawledWallets: \(chain\) => allPayToOriginsAsync\(/.test(srv) && /crawledPrices: \(chain\) => allPayToPricesAsync\(/.test(srv) && /\.allSolanaPayToOriginsAsync\(\)/.test(srv) && /knownPayToOrigins: await allPayToOriginsAsync\(/.test(srv), "the Base and Solana boards and the discovery-gap read take the sliced scans");
  const lb = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  ok(/await opts\.crawledWallets\(chain\)/.test(lb) && /await opts\.crawledPrices\(chain\)/.test(lb), "and the Base board awaits them");
}

// --- 1e. one seller listing tens of thousands of tools: the per-seller work
// the crawl and the readers do on it runs in steps (its listing row, its
// routable summary, its service key) or reads only the templates of a row's
// own length (the crawl's template matching), and each answer is the one the
// one-pass code gives.
{
  const BIG = "https://big-catalog.example";
  const N = 30_000;
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const tools = Array.from({ length: N }, (_, i) => ({
    seller: BIG, method: i % 3 ? "GET" : "POST", route: `/v1/item/${i % 5 ? i : `{id}`}/${i % 7}`, slug: `item-${i}`, name: `item ${i}`,
    description: "catalog row", price: (i % 9) / 1000, networks: i % 4 ? ["eip155:8453"] : ["eip155:8453", SOL],
    payToByNetwork: { "eip155:8453": `0x${String(i % 300).padStart(40, "b")}`, ...(i % 4 ? {} : { [SOL]: `Big${String(i % 50).padStart(40, "3")}` }) },
    ...(i % 11 === 0 ? { payToSourceByNetwork: { "eip155:8453": "registry" } } : {}),
    ...(i % 13 === 0 ? { evmDomainByNetwork: { "eip155:8453": { asset: `0x${"c".repeat(40)}`, name: `USD Coin ${i % 2}` } } } : {}),
    ...(i === 777 ? { stellarPayTo: `G${"A".repeat(55)}` } : {}),
    ...(i === 999 ? { algorandPayTo: "B".repeat(58) } : {}),
    ...(i % 17 === 0 ? { paid: false } : i % 19 === 0 ? { paid: true } : {}),
  }));
  const bazaarRows = Array.from({ length: 3000 }, (_, i) => ({ route: `${BIG}/v1/reg/${i}`, networks: ["eip155:137"], payToByNetwork: { "eip155:137": `0x${String(i % 40).padStart(40, "d")}`, "eip155:8453": `0x${String(i % 30).padStart(40, "e")}` }, ...(i === 5 ? { stellarPayTo: `G${"B".repeat(55)}` } : {}) }));
  x.__testSetBazaarTools(BIG, bazaarRows);
  // Nothing else pending, so what the drain does next is this entry alone.
  const drained = async () => { while (x._routeIndexStatsForTest().pending || x._routeIndexStatsForTest().partial) await new Promise((r) => setImmediate(r)); };
  await drained();
  const steppingClock = async (fn) => {
    const real = performance.now;
    let fake = real.call(performance);
    performance.now = () => (fake += 3);
    try { return await fn(); } finally { performance.now = real; }
  };
  cache.set(BIG, { manifest: { name: "big", homepage: BIG }, tools, fetchedAt: 1_700_000_100_000, error: null, history: [1, 1, 1] });
  const v = cache.get(BIG);

  // The service key: the one-pass build, written out here as it ran.
  const refKey = (() => {
    const payees = Object.entries(x.allPayTosByNetwork(v.tools)).sort(([a], [b]) => a.localeCompare(b)).map(([net, vals]) => [net, [...vals].map((s) => String(s).toLowerCase()).sort()]);
    const contracts = v.tools.map((t) => [String(t.method || "GET").toUpperCase(), String(t.route || ""), String(t.slug || ""), String(t.price ?? ""), t.paid === false ? "free" : "paid-or-unknown", [...(t.networks || [])].map(String).sort()])
      .map((c) => [JSON.stringify(c), c]).sort((a, b) => a[0].localeCompare(b[0])).map((p) => p[1]);
    return JSON.stringify({ payees, contracts });
  })();
  {
    // Primed by the route index drain, inside its slices. On a clock that
    // moves 3 ms per read every 12 ms slice ends after a few reads, so the
    // turn count is the build's own: one turn is a key built in one call.
    const steps0 = x._serviceKeyStepsForTest();
    const { turns } = await steppingClock(() => turnsAdvancing(() => x._serviceKeyStepsForTest(), drained));
    const steps = x._serviceKeyStepsForTest() - steps0;
    ok(steps >= N / 1024 && turns >= 50, `the ${N}-tool entry's service key is built in ${steps} steps of at most 1024 tools or comparisons, across ${turns} turns of the drain`);
    ok(x._memoizedServiceKeyForTest(v) === refKey, "...and the key the drain primed is the one-pass key, character for character");
    // On the real clock, a copy of the entry (a re-crawl) is primed the same way.
    const again = { ...v };
    let worst = 0, last = performance.now(), lastOurs = oursMs();
    const iv = setInterval(() => { const t = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(t - last, c - lastOurs)); last = t; lastOurs = c; }, 1);
    cache.set(BIG, again);
    await drained();
    clearInterval(iv);
    ok(x._memoizedServiceKeyForTest(again) === refKey, "...and so is a re-crawled copy's, on the real clock");
    ok(worst < GAP_MS, `...and the drain that built it never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
    cache.set(BIG, v);
    await drained();
    // A key on a copy of the entry, built in one call, reads the same.
    const copy = { ...v };
    ok(x._exactServiceKeyForTest(copy) === refKey, "the one-call build gives the same key");
  }

  // The listing row and the routable summary: the one-pass fields, written out.
  const refRow = (origin, e) => {
    const reg = origin === BIG ? bazaarRows : [];
    const both = [...reg, ...(e.tools || [])];
    return {
      networks: [...new Set([...(e.tools || []).flatMap((t) => t.networks || []), ...reg.flatMap((t) => t.networks || [])])],
      stellarWallet: [...(e.tools || []), ...reg].map((t) => t.stellarPayTo).find((w) => typeof w === "string" && /^G[A-Z2-7]{55}$/.test(w)) || null,
      algorandWallet: [...(e.tools || []), ...reg].map((t) => t.algorandPayTo).find((w) => typeof w === "string" && /^[A-Z2-7]{58}$/.test(w)) || null,
      payToByNetwork: x.sellerPayToByNetwork(both),
      payTosByNetwork: x.allPayTosByNetwork(both),
      ...(e.tools?.some((t) => t.paid !== undefined) ? { paidToolCount: e.tools.filter((t) => t.paid !== false).length } : {}),
    };
  };
  {
    let worst = 0, last = performance.now(), lastOurs = oursMs();
    const iv = setInterval(() => { const t = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(t - last, c - lastOurs)); last = t; lastOurs = c; }, 1);
    const steps0 = x._sellerFieldStepsForTest();
    const { turns, value: snap } = await turnsAdvancing(() => x._sellerFieldStepsForTest(), () => x.indexSnapshotAsync(routeCtx));
    clearInterval(iv);
    const steps = x._sellerFieldStepsForTest() - steps0;
    ok(steps >= (2 * N) / 2000 && turns >= 2, `the listing build walks the ${N}-tool seller in ${steps} steps of at most 2000 rows, across ${turns} turns`);
    ok(worst < GAP_MS, `...and the sliced listing build never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
    const pick = (s) => ({ networks: s.networks, stellarWallet: s.stellarWallet, algorandWallet: s.algorandWallet, payToByNetwork: s.payToByNetwork, payTosByNetwork: s.payTosByNetwork, ...(s.paidToolCount !== undefined ? { paidToolCount: s.paidToolCount } : {}) });
    const remote = snap.sellers.filter((s) => !s.local);
    const bad = remote.filter((s) => !isDeepStrictEqual(pick(s), refRow(s.origin, cache.get(s.origin))));
    const big = remote.find((s) => s.origin === BIG);
    ok(big && big.stellarWallet && big.algorandWallet && big.paidToolCount < N && Object.keys(big.payToByNetwork).length === 3 && bad.length === 0, `...and every seller's tool-derived fields equal the one-pass fields (${remote.length} sellers, ${bad.length} differ${bad[0] ? `: ${bad[0].origin}` : ""})`);
    ok(isDeepStrictEqual(big.evmDomainByNetwork, { "eip155:8453": { asset: `0x${"c".repeat(40)}`, name: "USD Coin 0" } }), "...and the EIP-712 domain is the first one listed");
    // The clock fields aside (asOf, and our own entry's fetchedAt, stamped now).
    const unclocked = (sn) => ({ ...sn, asOf: 0, sellers: sn.sellers.map((s) => (s.local ? { ...s, fetchedAt: 0 } : s)) });
    ok(isDeepStrictEqual(unclocked(snap), unclocked(x.indexSnapshot(routeCtx))), "the sliced and one-turn listings are the same");
  }
  // Rows read per step of a builder, counted by the walks themselves: the big
  // seller's 66k rows in one step is the one-turn row build this replaced.
  const maxRowsPerStep = (gen) => {
    let most = 0, before = x._sellerFieldRowsForTest(), r;
    do { r = gen.next(); const now = x._sellerFieldRowsForTest(); most = Math.max(most, now - before); before = now; } while (!r.done);
    return most;
  };
  {
    const most = maxRowsPerStep(x._indexSnapshotStepsForTest(routeCtx));
    ok(most > 0 && most <= 10_000, `no step of the listing build reads more than ${most} tool rows (the big seller alone has ${2 * (N + 3000)})`);
  }
  {
    const steps0 = x._sellerFieldStepsForTest();
    const { turns } = await turnsAdvancing(() => x._sellerFieldStepsForTest(), () => x.warmRoutableSellerSummaries());
    ok(turns >= 2, `the routable summary's walk of it advances across ${turns} turns`);
    const rows = x.routableSellerSummaries();
    const row = rows.find((r) => r.origin === BIG);
    const want = { payToByNetwork: x.sellerPayToByNetwork(v.tools), payTosByNetwork: x.allPayTosByNetwork(v.tools) };
    ok(row && x._sellerFieldStepsForTest() - steps0 >= N / 2000 && isDeepStrictEqual({ payToByNetwork: row.payToByNetwork, payTosByNetwork: row.payTosByNetwork }, want), `the routable summary walks it in steps too, with the one-pass payTo fields`);
    // A fresh copy of the entry, so its summary row is built again.
    cache.set(BIG, { ...v });
    const most = maxRowsPerStep(x._routableSummaryStepsForTest());
    ok(most > 0 && most <= 10_000, `no step of the routable summary build reads more than ${most} tool rows (the big seller alone has ${N})`);
    cache.set(BIG, v);
  }
  {
    // The crawl's template matching: each row compared only with the
    // templates of its own length, with the answer of a filter over all.
    const naive = (tpl, concrete) => {
      if (typeof tpl !== "string" || !tpl.includes("{")) return false;
      const t = tpl.split("/"), c = String(concrete || "").split("/");
      if (t.length !== c.length) return false;
      for (let i = 0; i < t.length; i++) { if (/^\{.+\}$/.test(t[i])) { if (!c[i]) return false; } else if (t[i] !== c[i]) return false; }
      return true;
    };
    const cands = [];
    for (let i = 0; i < 400; i++) cands.push({ method: i % 2 ? "GET" : "POST", route: ["/a/{id}", `/a/{id}/s${i % 20}`, `/b/${i % 9}/{x}/c`, `/c/{p}/{q}/{r}/${i % 3}`, "/plain/route", "/{all}"][i % 6] });
    const rowsIn = [];
    for (let i = 0; i < 3000; i++) rowsIn.push({ method: i % 2 ? "GET" : "POST", methodInferred: i % 5 === 0, route: [`/a/${i}`, `/a/${i}/s${i % 25}`, `/b/${i % 9}/${i}/c`, `/c/${i}/x/y/${i % 3}`, "/a//s1", `/z${i}`, "", null][i % 8] });
    const c0 = x._templateComparesForTest();
    let same = 0;
    for (const b of rowsIn) {
      const fits = cands.filter((o) => naive(o.route, b.route) && (b.methodInferred || o.method === b.method));
      const want = fits.length === 1 ? fits[0] : null;
      if (x._templateMatchForTest(b, cands) === want) same++;
    }
    const compares = x._templateComparesForTest() - c0;
    ok(same === rowsIn.length, `the indexed template match answers as the filter over every template (${same} of ${rowsIn.length} rows)`);
    ok(compares > 0 && compares < (rowsIn.length * cands.length) / 2, `...comparing ${compares} templates, under half of the ${rowsIn.length * cands.length} a filter over all of them reads`);
    // stampDeclared on the big catalog, against its templates.
    const declared = [{ route: "/v1/item/{id}/3" }, { route: "/v1/item/{id}/{n}" }, { route: "/v1/item/5/5" }, { route: "/v1/other/{id}/1" }];
    const rowsCopy = tools.slice(0, 5000).map((t) => ({ route: t.route }));
    x.stampDeclared(rowsCopy, declared);
    const exact = new Set(declared.map((d) => d.route.split("?")[0]));
    const tpls = [...exact].filter((r) => r.includes("{"));
    ok(rowsCopy.every((t) => t.declared === (exact.has(t.route) || tpls.some((tpl) => naive(tpl, t.route)))), "stampDeclared marks each row as the template filter does");
  }
  cache.delete(BIG);
  x.__testSetBazaarTools(BIG, null);
}

// --- 1f. the Base board's registry walk (tens of thousands of listings) runs
// in steps, with the rows of the one-turn walk.
{
  const lb = await import("../src/leaderboard.js");
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const items = Array.from({ length: 40_000 }, (_, i) => ({
    resource: `https://reg${i % 900}.example/r/${i}`, serviceName: i % 3 ? `svc ${i % 900}` : `svc ${i % 900}.example`,
    accepts: [{ network: "eip155:8453", scheme: "exact", asset: USDC, payTo: `0x${String(i % 1200).padStart(40, "f")}`, maxAmountRequired: String(1000 * (1 + (i % 7))) }],
  }));
  const steps0 = lb._extractStepsForTest();
  let worst = 0, last = performance.now(), lastOurs = oursMs();
  const iv = setInterval(() => { const t = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(t - last, c - lastOurs)); last = t; lastOurs = c; }, 1);
  const { turns, value: sliced } = await turnsAdvancing(() => lb._extractStepsForTest(), () => lb.extractWalletsFromBazaarAsync({ items }));
  clearInterval(iv);
  const steps = lb._extractStepsForTest() - steps0;
  ok(turns >= 2, `the registry walk advances across ${turns} event-loop turns`);
  const whole = lb.extractWalletsFromBazaar({ items });
  ok(steps >= items.length / 500 - 1, `the registry walk reads ${items.length} listings in ${steps} steps of 500`);
  ok(whole.length > 1000 && isDeepStrictEqual(sliced, whole), `...and the sliced walk's rows equal the one-turn rows (${whole.length} wallets)`);
  ok(worst < GAP_MS, `...and it never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
  const src = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  ok(/let sellers = await extractWalletsFromBazaarAsync\(\{ items \}, chain\)/.test(src), "and the board's refresh takes the sliced walk");
}

// --- 1g. the cache files (no state database) are written in pieces, with the
// bytes of the one joined write, a long line and a surrogate pair at a cut too.
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a402-pieces-"));
  const PIECE = 4 * 1048576;
  const first = "[\"https://one.example\",{}]";
  for (const [head, sep, tail] of [["{\"savedAt\":1,\"entries\":[", ",", "]}"], ["{\"savedAt\":1}\n", "\n", "\n"]]) {
    // The long line's first pair sits exactly across the first piece's end
    // (after the head, the first line and a separator), and its second pair
    // across the next one, so a writer that cut there would split both.
    const before = PIECE - head.length - first.length - sep.length - 1;
    const big = "a".repeat(before) + "\u{1F600}" + "b".repeat(PIECE - 2) + "\u{1F601}" + "c".repeat(1000);
    const lines = [first, big, "x".repeat(PIECE - 2), "\u{1F602}tail", ""];
    const file = join(dir, "f");
    const p0 = x._cacheWritePiecesForTest();
    let worst = 0, last = performance.now(), lastOurs = oursMs();
    const iv = setInterval(() => { const t = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(t - last, c - lastOurs)); last = t; lastOurs = c; }, 1);
    const { turns } = await turnsAdvancing(() => x._cacheWritePiecesForTest(), () => x._writeJoinedInPiecesForTest(file, head, lines, sep, tail));
    clearInterval(iv);
    ok(turns >= 2, `a cache write advances across ${turns} event-loop turns`);
    const pieces = x._cacheWritePiecesForTest() - p0;
    ok(pieces >= 4 && readFileSync(file).equals(Buffer.from(head + lines.join(sep) + tail, "utf8")), `a cache file is written in ${pieces} pieces, byte for byte the joined write (${JSON.stringify(sep)} between lines)`);
    ok(worst < GAP_MS, `...and the write never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
  }
  rmSync(dir, { recursive: true, force: true });
  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const fn = idx.slice(idx.indexOf("const writeFiles = async () => {"), idx.indexOf("if (stateDbEnabled()) {", idx.indexOf("const writeFiles = async () => {")));
  ok((fn.match(/await writeJoinedInPieces\(/g) || []).length === 2 && !/lines\.join\(/.test(fn), "both cache files are written through the piece writer");
}

// --- 1h. a row too large for a batch reaches the state database as UTF-8
// bytes built in pieces across turns, the bytes of the cleaned text the one
// text parameter sent (the clean and the driver's encode were each one call
// over the whole body: 0.6-1 s on an 84 MB row); a body cleaning could change
// keeps the text path.
{
  const { cleanPgText } = await import("../src/state-db.js");
  const PIECE = 1_048_576;
  const origin = "https://big.example";
  const from = JSON.stringify(origin).length + 2;
  // An entry whose text puts a surrogate pair across the first piece's end
  // (the entry text opens with the six characters {"k":", and the first piece
  // ends PIECE characters into it) and multi-byte text throughout.
  const pad = "a".repeat(PIECE - 7);
  const entryText = JSON.stringify({ k: pad + "\u{1F600}" + "é漢".repeat(600_000) + "\u{1F601}", tools: [{ d: "ü" }] });
  const line = `[${JSON.stringify(origin)},${entryText}]`;
  const hash = "AbC+/=hash";
  const expected = Buffer.from(cleanPgText(`${entryText.slice(0, -1)},"contentHash":${JSON.stringify(hash)}}`), "utf8");
  const tick = async () => { await new Promise((r) => setImmediate(r)); };
  const p0 = x._rowBytesPiecesForTest();
  let worst = 0, last = performance.now(), lastOurs = oursMs();
  const iv = setInterval(() => { const t = performance.now(), c = oursMs(); worst = Math.max(worst, Math.min(t - last, c - lastOurs)); last = t; lastOurs = c; }, 1);
  const { turns, value: bytes } = await turnsAdvancing(() => x._rowBytesPiecesForTest(), () => x._rowBodyBytesForTest(line, from, hash, tick));
  clearInterval(iv);
  const pieces = x._rowBytesPiecesForTest() - p0;
  ok(Buffer.isBuffer(bytes) && bytes.equals(expected), `a large row's bytes equal the cleaned text's UTF-8 (${expected.length} bytes)`);
  ok(pieces >= Math.ceil((line.length - from) / PIECE) && turns >= pieces, `...encoded in ${pieces} pieces across ${turns} turns`);
  ok(worst < GAP_MS, `...and the encode never held the loop past ${GAP_MS} ms (worst ${Math.round(worst)} ms)`);
  const noHash = await x._rowBodyBytesForTest(line, from, null);
  ok(noHash?.equals(Buffer.from(entryText, "utf8")), "without a hash the bytes are the entry text alone");
  // An escaped NUL or lone surrogate is what cleaning rewrites: that body
  // keeps the text path, even with the escape across a piece's end.
  for (const at of [10, PIECE - 9]) { // the second escape starts three characters before the cut
    const t = JSON.stringify({ k: "a".repeat(at) + "\u0000" + "b".repeat(PIECE) });
    ok(await x._rowBodyBytesForTest(`[${JSON.stringify(origin)},${t}]`, from, hash) === null, `a body holding an escaped NUL (at ${at}) keeps the text path`);
  }
  ok(await x._rowBodyBytesForTest(`[${JSON.stringify(origin)},${JSON.stringify({ k: "\ud800" + "b".repeat(PIECE) })}]`, from, hash) === null, "a body holding an escaped lone surrogate keeps the text path");
  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const fn = idx.slice(idx.indexOf("async function persistIndexCacheToStateDb("), idx.indexOf("async function importIndexCacheFile("));
  ok(/await rowBodyBytes\(lines\[indexOf\.get\(ids\[0\]\)\]/.test(fn) && /convert_from\(\$3::bytea, 'UTF8'\)::jsonb/.test(fn), "the single-row upsert sends the piecewise bytes");
  // The boot's warm start holds each row's hash: taken in pieces (the largest
  // seller's took 0.7 s in one call), the hash the pull takes the same way.
  const warmAt = idx.indexOf("async function warmStartIndexOnce(");
  const warm = idx.slice(warmAt, idx.indexOf("  warmStartLastCount = n;\n", warmAt));
  ok(/pgOriginHashes\.set\(id, (?:noteCapOnFold\(id, body\) \? null : )?await persistedHashSliced\(id, cache\.get\(id\), tick\)\)/.test(warm) && !/persistedHashOf\(/.test(warm), "the warm start hashes each row in pieces");
}

// --- 1i. a chain page (/base lists thousands of sellers) is built in steps:
// the async build yields inside its seller walks, each seller's leaderboard
// stat is joined once rather than per sort comparison, and every byte equals
// the one-pass build.
{
  const mp = await import("../src/market-page.js");
  const snap = x.indexSnapshot(routeCtx);
  const wallets = snap.sellers.map((s) => Object.values(s.payToByNetwork || {})[0]).filter(Boolean);
  const board = { leaderboard: Array.from({ length: 300 }, (_, i) => ({ wallet: wallets[2 * i], wallets: [wallets[2 * i], wallets[2 * i + 1]], callsSettled: 500 - (i % 41), totalUsd: i, uniqueBuyers: 1 })), windowLabel: "30 days" };
  const base = mp.marketSellers("base", snap).length;
  for (const all of [false, true]) {
    const opts = { snapshot: snap, leaderboardSnap: board, all };
    const one = mp.marketPage("base", "https://agent402.tools", opts);
    const sliced = await mp.marketPageAsync("base", "https://agent402.tools", opts);
    let steps = 0, longest = 0;
    const g = mp._marketPageChainStepsForTest("base", "https://agent402.tools", opts);
    let t = performance.now(), r = g.next();
    while (!r.done) { const now = performance.now(); longest = Math.max(longest, now - t); steps++; t = performance.now(); r = g.next(); }
    longest = Math.max(longest, performance.now() - t);
    ok(base > 1000 && one === sliced && r.value === one, `the /base page${all ? " (?all=1)" : ""} built in steps equals the one-pass build (${base} sellers, ${one.length} bytes)`);
    ok(steps >= Math.floor(base / 250) * 3, `...in ${steps} steps (at least three per 250 sellers: the count, the stat join and the roster walk)`);
    ok(longest < GAP_MS, `...none longer than ${GAP_MS} ms (longest ${Math.round(longest)} ms)`);
  }
  // The sort reads a memo: one payTo read per seller, not per comparison.
  let reads = 0;
  const counted = { sellers: snap.sellers.map((s) => (s.local ? s : new Proxy(s, { get(o, k) { if (k === "payToByNetwork") reads++; return o[k]; } }))) };
  mp.marketPage("base", "https://agent402.tools", { snapshot: counted, leaderboardSnap: board });
  const onBase = mp.marketSellers("base", counted).filter((s) => !s.local).length;
  ok(reads > 0 && reads <= onBase * 3, `a chain page reads each seller's payTo a bounded number of times (${reads} reads for ${onBase} sellers)`);
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/return marketPageAsync\(chainKey, BASE_URL, \{ snapshot: labelled, rail,/.test(srv), "the chain page route builds through the sliced builder");
}

// --- 2 + 3. source pins
{
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = srv.slice(srv.indexOf("async function buildRevenueDaily()"), srv.indexOf("// Daily revenue series for the /revenue chart"));
  ok((fn.match(/await turn\(\)/g) || []).length >= 5, "the /revenue series yields the event loop between each figure");
  ok(/memoSurfaceAsync\("revenue:daily"/.test(srv), "the /revenue series is served stale while it rebuilds");
  ok(/const events = await externalPaymentEventsForAsync\(w\)/.test(fn) && (fn.match(/\{ events \}/g) || []).length === 6, "the six buyer figures share one read of the payment history");
  ok(/app\.get\("\/__operator\/heap\.json"[\s\S]{0,120}operatorAuthed\(req\)/.test(srv), "the heap read is operator-authed");
  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/enumerable: false/.test(idx) && !/toolHome: new WeakMap/.test(idx), "per-tool router records are hidden properties, not WeakMap entries");
  ok(/navChainsMemo\.snapshot === snapshot && navChainsMemo\.board === navBoardKey\(board\)/.test(srv), "the chain strip is memoized on the index snapshot and the leaderboard rows");
  // The warming placeholder is a fresh empty list per read: every empty list
  // is one key, or each page rebuilt the strip (6 s of CPU in a crawl cycle,
  // 2026-11-04) until the first scan landed.
  const keySrc = srv.match(/const navBoardKey = (\(board\) => \{[^\n]*\});/);
  const navBoardKey = keySrc ? (0, eval)(keySrc[1]) : null;
  const rows = [{ wallet: "0x1" }];
  ok(navBoardKey && navBoardKey({ leaderboard: [] }) === navBoardKey({ leaderboard: [] }) && navBoardKey({ leaderboard: [] }) === navBoardKey(null) && navBoardKey({ leaderboard: rows }) === rows, "every empty leaderboard is one strip key; a filled one is its own rows");
}

console.log(`test-offload-stalls: ${n} passed`);
process.exit(0);
