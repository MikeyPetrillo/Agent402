// What the route index and the row store hold across crawl cycles in which no
// document changed. A kept row moves its postings to the entry that replaced
// its own, and the index counts each entry's rows (`rowsOf`). An entry whose
// every row moved was still counted, and a cycle with nothing stale runs no
// compaction, so the record kept every replaced entry (its documents and
// bodies included) reachable: one more copy of the crawled pool each cycle.
// Pinned:
//   - after unchanged cycles over many sellers with large bodies (rows that
//     move, sellers with no paid row, a seller with a row whose statics throw),
//     the replaced entries are collected, the index counts one entry per live
//     entry and the heap does not grow per cycle; a route query and a
//     directory rebuild run between the cycles;
//   - a row whose statics threw once is decorated again, so it is found on the
//     next crawl after the throw clears though its rows stay equal;
//   - a row list kept in part never carries the entry's service key over;
//   - a re-store of a seller at the tool cap with heavy rows compares a
//     bounded number of values in its turn, keeps no row it did not compare,
//     and holds the loop under the index's slice length (or the machine's
//     baseline, where that is longer).
// Mutation-checked: the record of a bare replaced entry left in place, a row
// with broken statics kept, the service key carried for a partly kept list,
// and the compare bound removed each fail it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.ROUTE_RETENTION_CHILD !== "1") {
  const child = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { stdio: "inherit", env: { ...process.env, ROUTE_RETENTION_CHILD: "1", NODE_OPTIONS: "" } });
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
} else {
  process.env.X402_INDEX_CRAWL = "off";
  const xi = await import("../src/x402-index.js");
  const { oursMs, bound } = await import("./lib/ours-clock.js");
  const { randomBytes } = await import("node:crypto");
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
  const cache = xi._cacheForTests();
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 20000; i++) {
      await new Promise((r) => setImmediate(r));
      const s = xi._routeIndexStatsForTest();
      if (!s.pending && !s.partial && !s.rebuilding) return s;
    }
    return xi._routeIndexStatsForTest();
  };
  const collect = async () => { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); globalThis.gc(); };
  const found = (q, o) => xi.routeQuery({ query: q, top: 10, include: "external", ...ctx }).results.some((r) => r.seller === o);
  const pay = { "eip155:8453": "0x" + "a".repeat(40) };

  // ---- 1. replaced entries are collected after unchanged cycles -------------
  {
    const N = 240, ROWS = 20, CYCLES = 5;
    const row = (o, j) => ({ seller: o, method: "GET", route: `/api/r${j}`, slug: `r-${j}`, name: `Route ${j} json`, description: `route ${j} converts json to csv`, category: "data", tags: ["json"], price: 0.001, networks: ["eip155:8453"], payToByNetwork: pay });
    const origins = [];
    for (let i = 0; i < N; i++) {
      const o = `https://keep${i}.example`; origins.push(o);
      // Every 20th seller lists only free rows (nothing paid is posted).
      const tools = Array.from({ length: ROWS }, (_, j) => (i % 20 === 7 ? { ...row(o, j), paid: false } : row(o, j)));
      cache.set(o, { manifest: { name: `Keep ${i}`, homepage: o }, tools, fetchedAt: 1, error: null, history: [1, 1, 1] });
    }
    const bad = origins[3];
    xi._setToolStaticsFaultForTest(new RangeError("Maximum call stack size exceeded"), (t) => t.seller === bad && t.route === "/api/r0");
    xi.warmRouteIndex(); await settle();
    const refs = [];
    const heap = [];
    for (let c = 0; c < CYCLES; c++) {
      for (const o of origins) {
        const v = cache.get(o);
        refs.push(new WeakRef(v));
        cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })), fetchedAt: Date.now(), manifestBody: randomBytes(40_000).toString("hex") });
      }
      const s = await settle();
      xi.routeQuery({ query: "json csv", top: 10, include: "external", ...ctx });
      xi._resetFlatCacheForTest?.(); await xi.allIndexedToolsAsync({ limit: 1 }); await xi._indexRowsSettledForTest(); await xi.allIndexedToolsAsync({ limit: 50 });
      await collect();
      const alive = refs.filter((r) => r.deref()).length;
      heap.push(process.memoryUsage().heapUsed);
      ok(alive <= 2, `unchanged cycle ${c + 1}: the replaced entries are collected (${alive} of ${refs.length} still reachable)`);
      ok(s.entriesCounted === cache.size && s.staleTools === 0, `unchanged cycle ${c + 1}: the index counts one entry per live entry (${s.entriesCounted} for ${cache.size}), nothing stale (${s.staleTools})`);
    }
    const grewMb = (heap[heap.length - 1] - heap[0]) / 1048576;
    // One cycle's bodies are about 19 MB; a cycle that kept them grows by that.
    ok(grewMb < 6, `the heap does not grow per unchanged cycle (${grewMb.toFixed(1)} MB over ${CYCLES - 1} cycles)`);
    xi._setToolStaticsFaultForTest(null);
    for (const o of origins) cache.delete(o);
    await settle();
  }

  // ---- 2. a row whose statics threw is found again once the throw clears ----
  {
    for (let i = 0; i < 30; i++) { const p = `https://pad${i}.example`; cache.set(p, { manifest: { name: "p", homepage: p }, tools: [{ seller: p, method: "GET", route: "/api/pad", slug: "pad", name: "Pad", description: "pads the pool json", category: "data", tags: ["pad"], price: 0.002, networks: ["eip155:8453"], payToByNetwork: pay }], fetchedAt: 1, error: null, history: [1, 1, 1] }); }
    const o = "https://okapi.example";
    const row = (d) => ({ seller: o, method: "GET", route: "/api/okapi", slug: "okapi-count", name: "Okapi count", description: d, category: "data", tags: ["okapi"], price: 0.002, networks: ["eip155:8453"], payToByNetwork: pay });
    const entry = (d) => ({ manifest: { name: "Okapi", homepage: o }, tools: [row(d)], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
    cache.set(o, entry("counts okapis in the forest")); await settle();
    ok(found("okapis forest", o), "control: the seller's row is found");
    xi._setToolStaticsFaultForTest(new RangeError("Maximum call stack size exceeded"), (t) => t.seller === o);
    cache.set(o, entry("counts okapis in the forest today")); await settle();
    ok(!found("okapis forest", o), "while its statics throw, the changed row is not served");
    xi._setToolStaticsFaultForTest(null);
    cache.set(o, entry("counts okapis in the forest today")); await settle();
    ok(found("okapis forest", o), "the next crawl after the throw clears finds the row, though its rows are equal");
    cache.set(o, entry("counts okapis in the forest today")); await settle();
    ok(found("okapis forest", o), "...and the crawl after that");
  }

  // ---- 3. a partly kept row list never carries the service key ---------------
  {
    const o = "https://tapir.example";
    const row = (j, price) => ({ seller: o, method: "GET", route: `/api/tapir${j}`, slug: `tapir-${j}`, name: `Tapir ${j}`, description: `tapir lookup number ${j}`, category: "data", tags: ["tapir"], price, networks: ["eip155:8453"], payToByNetwork: pay });
    const entry = (p1) => ({ manifest: { name: "Tapir", homepage: o }, tools: [row(0, 0.003), row(1, p1)], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
    cache.set(o, entry(0.003)); await settle();
    const k0 = xi._exactServiceKeyForTest(cache.get(o)) || "";
    ok(/0\.003/.test(k0) && !/0\.007/.test(k0), "control: the entry's service key reads its prices");
    const prev = cache.get(o).tools;
    const r0 = xi._rowReuseStatsForTest();
    cache.set(o, entry(0.007)); await settle();
    const now = cache.get(o).tools, r1 = xi._rowReuseStatsForTest();
    ok(now[0] === prev[0] && now[1] !== prev[1] && now !== prev, "control: the equal row is kept and the changed one stored new (a partly kept list)");
    ok(r1.serviceKeysKept === r0.serviceKeysKept && /0\.007/.test(xi._exactServiceKeyForTest(cache.get(o)) || ""), "the partly kept list's service key is built from its own rows, not carried over");
  }

  // ---- 4. a re-store at the tool cap compares a bounded number of values ----
  {
    const o = "https://big.example";
    const schema = () => ({ type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`field${k}`, { type: k % 2 ? "string" : "number", description: `the field number ${k} of the request body`, ...(k % 5 === 0 ? { enum: ["a", "b", "c"] } : {}) }])), required: ["field0", "field1"] });
    const row = (j) => ({ seller: o, method: "POST", route: `/api/r${j}`, slug: `r-${j}`, name: `Route ${j}`, description: `does thing ${j} with json and csv`.repeat(4), category: "data", tags: ["a", "b", "c"], price: 0.002, networks: ["eip155:8453"], payToByNetwork: pay, inputSchema: schema(), accepts: [{ scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "b".repeat(40), extra: { name: "USD Coin", version: "2" } }] });
    const ROWS = 5000;
    const entry = (tools) => ({ manifest: { name: "Big", homepage: o }, tools, fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
    cache.set(o, entry(Array.from({ length: ROWS }, (_, j) => row(j))));
    ok(cache.get(o).tools.length === ROWS, `control: the seller holds ${ROWS} rows`);
    const times = [];
    let prev = null, now = null, cut0 = 0, cut1 = 0;
    for (let k = 0; k < 5; k++) {
      const fresh = Array.from({ length: ROWS }, (_, j) => row(j));
      prev = cache.get(o).tools;
      cut0 = xi._rowReuseStatsForTest().rowsCompareCut ?? 0;
      globalThis.gc();
      const t0 = oursMs();
      cache.set(o, entry(fresh));
      times.push(oursMs() - t0);
      now = cache.get(o).tools;
      cut1 = xi._rowReuseStatsForTest().rowsCompareCut ?? 0;
    }
    times.sort((a, b) => a - b);
    const lim = bound(12, 1);
    ok(times[2] <= lim.ms, `an equal re-store of ${ROWS} heavy rows holds the loop ${times[2].toFixed(1)} ms (median of 5; max ${times[4].toFixed(1)}), ${lim.note}`);
    const keptN = now.findIndex((t, i) => t !== prev[i]);
    ok(cut1 > cut0 && keptN > 0 && keptN < ROWS, `the compare stops at its bound: ${keptN} rows kept, ${cut1 - cut0} stored uncompared`);
    ok(now.slice(keptN).every((t, i) => t !== prev[keptN + i]), "no row past the bound is kept: each is stored as the new row");
    await settle();
    ok(xi.routeQuery({ query: "route 4999", top: 10, include: "external", ...ctx }).results.some((r) => r.seller === o && r.slug === "r-4999"), "...and the seller's last row, past the bound, is served");
    cache.delete(o); await settle();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
