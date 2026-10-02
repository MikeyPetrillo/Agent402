#!/usr/bin/env node
// /api/route on a prod-sized pool: the perf pin and the ranking pin for the
// candidate index (2026-09-18), plus the index-maintenance semantics.
//
// Why: routeQuery scored EVERY row of the pool on every query. The 2026-08-25
// memo measured 53 ms on a synthetic 2,900-seller cache with a few tools each;
// prod's pool had grown to 108k rows (4,224 sellers) and /api/route measured
// 0.5-1.8 s per query on 2026-09-18, with 1-3 s event-loop stalls while a
// scanner ran one query a second. The fix is a token-postings candidate index
// (exact with respect to the scoring rules - see the comment above `routeIdx`
// in src/x402-index.js). What this file pins:
//   1. PERF: on the prod-sized fixture (scripts/lib/route-perf-fixture.js,
//      3,000 sellers / ~113k rows) a query's median-of-5 stays under
//      ROUTE_PERF_BOUND_MS (250). Measured on a laptop, same fixture, same
//      ten queries: the pre-change full scan 101-284 ms (222-284 ms for the
//      four queries carrying a two-letter term or a stopword), the index
//      15-64 ms. The bound is sized for a CI runner two to three times slower
//      than the laptop and still fails the full scan ("json to csv" 284 ms
//      locally, every short-term query on a runner).
//   2. RANKING: the top-10 for ten queries equals the golden captured from the
//      full-scan code on the same deterministic fixture
//      (scripts/fixtures/route-perf-golden.json) - seller, slug AND score, so
//      the index may not drop, add or re-weight a single row.
//   3. MAINTENANCE: a replaced entry's new rows are found and its old rows are
//      not; a deleted entry vanishes; cache.clear() empties the pool; the
//      stale-share rebuild fires and stays correct; a candidate reached only
//      through its description, its alias, its name-in-slug-form or a short
//      whole-token term is still found (the completeness the exactness proof
//      relies on); the local pool memo tracks a catalog rebuilt by identity.
// Mutation-checked (each fails this file): drop hay tokens from the postings
// (a description-only match vanishes), skip the stale check (a replaced
// entry's old rows come back), stop enqueueing on cache.set (new sellers never
// appear), restore the full scan (perf bound), reorder the sort keys (golden).
process.env.X402_INDEX_CRAWL = "off";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const { routeQuery, _cacheForTests, _setBazaarQualityForTest, _routeIndexStatsForTest, warmRouteIndex, _routeIndexSettledForTest, computeAliasOrigins } = await import("../src/x402-index.js");
const { buildRoutePerfFixture, GOLDEN_QUERIES } = await import("./lib/route-perf-fixture.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const ROUTE_PERF_BOUND_MS = Number(process.env.ROUTE_PERF_BOUND_MS || 250);
const cache = _cacheForTests();

// ---------------------------------------------------------------- 3. maintenance (small pool)
{
  cache.clear();
  const entry = (origin, tools, extra = {}) => ({ manifest: { name: origin, homepage: origin }, tools: tools.map((t) => ({ seller: origin, method: "POST", route: `/api/${t.slug}`, category: "data", tags: [], price: 0.002, networks: ["eip155:8453"], description: "", ...t })), fetchedAt: Date.now(), error: null, history: [1, 1, 1], ...extra });
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const slugs = (q, o = {}) => routeQuery({ query: q, top: 10, include: "external", ...ctx, ...o }).results.map((r) => `${r.seller}|${r.slug}`);

  cache.set("https://a.example", entry("https://a.example", [
    { slug: "alpha-tool", name: "Alpha tool", description: "Turns pumpkins into carriages overnight." },
    { slug: "beta", name: "Beta thing", description: "Nothing to see.", aliases: ["zebra-lookup"] },
    { slug: "gamma_delta_epsilon", name: "Gamma delta epsilon", description: "Three greek letters." },
    { slug: "ipsum", name: "IP inspector", description: "Reads an ip address." },
    { slug: "gzip", name: "Gzip", description: "Compress text with gzip." },
  ]));
  ok(slugs("pumpkins").includes("https://a.example|alpha-tool"), "a row reached ONLY through a description token is a candidate (hay tokens are indexed)");
  ok(slugs("zebra").includes("https://a.example|beta"), "a row reached ONLY through a curated alias token is a candidate");
  ok(slugs("gamma delta epsilon")[0] === "https://a.example|gamma_delta_epsilon", "a row reached through its name in slug form is a candidate and covered");
  const ip = slugs("ip");
  ok(ip.includes("https://a.example|ipsum") && !ip.includes("https://a.example|gzip"), `a two-letter term is whole-token on the index path too (ip -> ${ip.join(",")})`);

  // Replace the entry: new rows appear, old-only rows disappear (stale postings skipped).
  cache.set("https://a.example", entry("https://a.example", [
    { slug: "alpha-tool", name: "Alpha tool", description: "Now turns pumpkins into pies." },
    { slug: "omega", name: "Omega", description: "A brand new row about kumquats." },
  ]));
  ok(slugs("kumquats").includes("https://a.example|omega"), "after a re-crawl (cache.set, new object) the entry's NEW rows are found");
  ok(!slugs("zebra").length && !slugs("greek").length, "after a re-crawl the entry's OLD rows are gone (stale postings are skipped)");
  ok(slugs("pumpkins").includes("https://a.example|alpha-tool"), "a row kept across the re-crawl is still found");
  // On a pool this small the replaced entry's five stale rows are already past
  // the rebuild share, so the sync rebuilt from the live cache: two live rows,
  // nothing stale, one build. (The incremental path is exercised by the
  // prod-sized fixture below, where one replacement is far under the share.)
  const st1 = _routeIndexStatsForTest();
  ok(st1.indexedTools === 2 && st1.staleTools === 0 && st1.builds >= 1, `after one replacement on a tiny pool the index rebuilt: ${st1.indexedTools} live, ${st1.staleTools} stale, ${st1.builds} build(s)`);

  // A never-indexed pending entry replaced before any query never lands.
  cache.set("https://b.example", entry("https://b.example", [{ slug: "first", name: "First", description: "ephemeral" }]));
  cache.set("https://b.example", entry("https://b.example", [{ slug: "second", name: "Second", description: "durable" }]));
  ok(!slugs("ephemeral").length && slugs("durable").includes("https://b.example|second"), "an entry replaced while still pending indexes only its final version");

  // Delete: gone.
  cache.delete("https://b.example");
  ok(!slugs("durable").length, "a deleted entry's rows are not candidates");

  // Rebuild trigger: enough stale rows relative to live ones forces a full rebuild that stays correct.
  const before = _routeIndexStatsForTest().builds;
  for (let i = 0; i < 3; i++) cache.set("https://a.example", entry("https://a.example", [{ slug: `gen${i}`, name: `Gen ${i}`, description: `generation ${i} marker${i}` }]));
  ok(slugs("marker2").includes("https://a.example|gen2") && !slugs("marker1").length && !slugs("kumquats").length, "after several replacements only the live generation answers");
  const st2 = _routeIndexStatsForTest();
  ok(st2.builds > before && st2.staleTools === 0, `the stale-share rebuild fired (builds ${before} -> ${st2.builds}) and reset the stale count (${st2.staleTools})`);

  // Filters still apply on the index path: an errored seller and a self origin are not candidates.
  cache.set("https://dead.example", entry("https://dead.example", [{ slug: "dead-tool", name: "Dead", description: "unreachable marker" }], { history: [1, 0], originResponded: false }));
  cache.set("https://agent402.tools", entry("https://agent402.tools", [{ slug: "self-tool", name: "Self", description: "our own crawled entry marker" }]));
  const filt = slugs("marker");
  ok(!filt.some((s) => String(s).split("|")[0] === "https://dead.example"), "a seller whose last crawl failed is not a candidate on the index path");
  ok(!filt.some((s) => String(s).split("|")[0] === "https://agent402.tools"), "the crawled self origin is not a candidate on the index path");

  // clear() empties the pool and the index; re-seeding works.
  cache.clear();
  ok(!slugs("marker").length && _routeIndexStatsForTest().indexedTools === 0, "cache.clear() empties the pool and the index");
  cache.set("https://c.example", entry("https://c.example", [{ slug: "phoenix", name: "Phoenix", description: "rises again" }]));
  ok(slugs("phoenix").includes("https://c.example|phoenix"), "a seller added after clear() is indexed on the next query");

  // Local pool memo: same catalog object, a rebuilt catalog by identity.
  const cat1 = { "POST /api/one": { route: "POST /api/one", slug: "one", name: "One", description: "first local", price: "$0.001", category: "x", tags: [] } };
  // toolCount is held CONSTANT here on purpose: the server passes the live
  // count, which would also miss the memo, so pinning the key-count belt needs
  // a caller that does not (the one class of caller that can be served stale).
  const prices = {}; // one identity across calls, like the server's TOOL_PRICES
  const l = (catalog, q) => routeQuery({ query: q, top: 5, include: "local", baseUrl: "https://agent402.tools", catalog, prices, network: "base", toolCount: 1, walletName: "w" }).results.map((r) => r.slug);
  ok(l(cat1, "first")[0] === "one", "local pool serves the catalog");
  const cat2 = { ...cat1, "POST /api/two": { route: "POST /api/two", slug: "two", name: "Two", description: "second local", price: "$0.001", category: "x", tags: [] } };
  ok(l(cat2, "second")[0] === "two", "a catalog rebuilt as a new object is served, not the memoized pool of the old one");
  cat2["POST /api/three"] = { route: "POST /api/three", slug: "three", name: "Three", description: "third local", price: "$0.001", category: "x", tags: [] };
  ok(l(cat2, "third")[0] === "three", "a catalog mutated in place (key count changed) is re-read, not served stale");
  cache.clear();
}

// ---------------------------------------------------------------- 2 + 1. golden ranking and perf on the prod-sized fixture
{
  cache.clear();
  const t0 = performance.now();
  const { ctx, totalRemoteTools } = buildRoutePerfFixture({ cache, setBazaarQuality: _setBazaarQualityForTest });
  console.log(`# fixture: ${cache.size} sellers, ${totalRemoteTools} remote tools, built in ${(performance.now() - t0).toFixed(0)} ms`);
  ok(totalRemoteTools > 100000, `fixture is prod-sized (${totalRemoteTools} rows; prod 2026-09-18 had 108,095)`);
  const tw = performance.now();
  // warmRouteIndex() builds the candidate index ahead of the first query (startCrawler
  // schedules it 30 s after the warm start), so the first buyer after a deploy does
  // not pay the ~1 s build; idempotent, and the query afterwards is the fast path.
  const warmed = warmRouteIndex();
  ok(warmed > 1000, `warmRouteIndex builds the index off the query path (indexed ${warmed} tools)`);
  ok(warmRouteIndex() === warmed, "a second warm is a no-op (nothing pending, nothing stale)");
  routeQuery({ query: "warm up", top: 3, include: "all", ...ctx });
  console.log(`# first query (index build + decoration of every entry): ${(performance.now() - tw).toFixed(0)} ms`);
  const stats = _routeIndexStatsForTest();
  ok(stats.indexedTools === totalRemoteTools && stats.vocabulary > 3000, `index covers every remote row (${stats.indexedTools}) over a ${stats.vocabulary}-token vocabulary`);

  const golden = JSON.parse(readFileSync(path.join(here, "fixtures", "route-perf-golden.json"), "utf8")).golden;
  ok(Object.keys(golden).length === GOLDEN_QUERIES.length, `golden covers the ${GOLDEN_QUERIES.length} pinned queries`);
  const worst = [];
  for (const q of GOLDEN_QUERIES) {
    const times = [];
    let res;
    for (let i = 0; i < 5; i++) { const s = performance.now(); res = routeQuery({ query: q, top: 10, include: "all", ...ctx }); times.push(performance.now() - s); }
    times.sort((a, b) => a - b);
    const med = times[2];
    worst.push(med);
    const got = res.results.map((r) => `${r.seller}|${r.slug}|${r.score}`);
    const same = JSON.stringify(got) === JSON.stringify(golden[q]);
    ok(same, `ranking unchanged vs the full-scan golden: "${q}"${same ? "" : ` (got ${got.slice(0, 3).join(" ; ")} ...)`}`);
    ok(med < ROUTE_PERF_BOUND_MS, `"${q}" median of 5 = ${med.toFixed(1)} ms < ${ROUTE_PERF_BOUND_MS} ms`);
  }
  console.log(`# medians: min ${Math.min(...worst).toFixed(1)} ms, max ${Math.max(...worst).toFixed(1)} ms`);
  // Incremental maintenance on the big pool: ONE re-crawled seller is far
  // under the rebuild share, so its old rows go stale (skipped, still counted)
  // and its new rows are indexed on the next query with no rebuild.
  {
    const origin = "https://seller7.example";
    const old = cache.get(origin);
    const oldRows = old.tools.length;
    const b0 = _routeIndexStatsForTest().builds;
    cache.set(origin, { ...old, tools: [{ seller: origin, method: "POST", route: "/api/quokka", slug: "quokka-census", name: "Quokka census", description: "counts quokkas on rottnest", category: "data", tags: [], price: 0.001, networks: ["eip155:8453"] }] });
    const r = routeQuery({ query: "quokkas", top: 5, include: "external", ...ctx }).results;
    const s = _routeIndexStatsForTest();
    ok(r[0]?.slug === "quokka-census" && r[0]?.seller === origin, "a re-crawled seller's new row is found on the next query (incremental drain)");
    ok(s.builds === b0 && s.staleTools === oldRows, `no rebuild for one re-crawl (${s.builds} builds), its ${oldRows} old rows counted stale (${s.staleTools})`);
    const oldSlug = old.tools[0].slug;
    ok(!routeQuery({ query: oldSlug.split("-").join(" "), top: 25, include: "external", ...ctx }).results.some((x) => x.seller === origin && x.slug === oldSlug), "the re-crawled seller's old row is no longer served");
  }
  // include=external and a network filter ride the same index path.
  const ext = routeQuery({ query: "json to csv", top: 10, include: "external", ...ctx }).results;
  ok(ext.length === 10 && ext.every((r) => r.seller !== "self"), "include=external answers ten remote rows from the index");
  const strict = routeQuery({ query: "json to csv", top: 10, include: "all", networkFilter: "solana", strictNetwork: true, ...ctx }).results;
  ok(strict.every((r) => r.seller === "self"), "strictNetwork keeps the network filter on the index path (no Base-only remote row survives a Solana filter)");

  // Words that name no capability do not select candidates (they still score).
  {
    const withStop = routeQuery({ query: "get the weather forecast for a city", top: 10, include: "all", ...ctx }).results.map((r) => `${r.seller}|${r.slug}`);
    const bare = routeQuery({ query: "weather forecast city", top: 10, include: "all", ...ctx }).results.map((r) => `${r.seller}|${r.slug}`);
    ok(withStop.length === 10 && withStop.some((x) => bare.includes(x)), `a query padded with common words still answers the task's rows (${withStop.slice(0, 2).join(" ; ")})`);
    const t0 = performance.now(); routeQuery({ query: "get the data for a thing from the api", top: 10, include: "all", ...ctx }); const tStop = performance.now() - t0;
    ok(tStop < ROUTE_PERF_BOUND_MS, `a query of common words plus one term stays under the bound (${tStop.toFixed(1)} ms)`);
    ok(routeQuery({ query: "the", top: 5, include: "all", ...ctx }).results.length > 0, "a query of only common words still selects on them");
  }

  // One request's calls share a scored ranking; separate calls do not.
  {
    const memo = {};
    const a = routeQuery({ query: "wallet balance", top: 5, include: "all", scoredMemo: memo, ...ctx });
    const t0 = performance.now();
    const b = routeQuery({ query: "wallet balance", top: 25, include: "all", scoredMemo: memo, ...ctx });
    const tMemo = performance.now() - t0;
    const plain = routeQuery({ query: "wallet balance", top: 25, include: "all", ...ctx });
    ok(JSON.stringify(b.results.map((r) => r.slug)) === JSON.stringify(plain.results.map((r) => r.slug)) && a.results[0].slug === plain.results[0].slug, "a shared scoredMemo returns the same ranking as a fresh score");
    ok(tMemo < 10, `the second call of one request reuses the scored ranking (${tMemo.toFixed(1)} ms)`);
    const origin = "https://seller9.example";
    cache.set(origin, { ...cache.get(origin), tools: [{ seller: origin, method: "POST", route: "/w", slug: "wallet-balance-now", name: "Wallet balance", description: "wallet balance", category: "data", tags: [], price: 0.0001, networks: ["eip155:8453"] }] });
    const c = routeQuery({ query: "wallet balance", top: 25, include: "all", scoredMemo: memo, ...ctx });
    ok(c.results.some((r) => r.seller === origin), "a cache change between calls invalidates the shared ranking");
  }

  // The alias set is memoized on the cache version and follows a change.
  {
    const a1 = computeAliasOrigins(cache);
    const dup = "https://seller11-mirror.example";
    const primary = "https://seller11.example";
    const pv = cache.get(primary);
    cache.set(primary, { ...pv, manifest: { ...(pv.manifest || {}), homepage: primary } });
    cache.set(dup, { ...pv, tools: pv.tools.map((t) => ({ ...t, seller: dup })), manifest: { ...(pv.manifest || {}), homepage: primary } });
    const a2 = computeAliasOrigins(cache);
    ok(!a1.has(dup) && a2.has(dup), "an origin added as a mirror of another is in the alias set on the next call (the memo follows cache changes)");
    cache.delete(dup);
    ok(!computeAliasOrigins(cache).has(dup), "a deleted origin leaves the memoized alias set");
  }

  // One seller with a very large catalog re-crawled: indexed in background
  // slices INSIDE the entry (a 4,000-tool seller held production 1.3 s), and a
  // query arriving mid-index still sees every one of its rows.
  {
    const bigEntry = (origin, n) => ({ manifest: { name: "huge", homepage: origin }, tools: Array.from({ length: n }, (_, k) => ({ seller: origin, method: "POST", route: `/r${k}`, slug: `zanzibar-${k}`, name: `Zanzibar ${k}`, description: `zanzibar tool number ${k} quux${k}`, category: "data", tags: [], price: 0.001, networks: ["eip155:8453"] })), fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
    const big = "https://huge-seller.example";
    // Build the 80,000 rows BEFORE the gap meter starts, so the meter times the
    // indexer and not the fixture.
    const bigValue = bigEntry(big, 80000);
    let worst = 0, last = performance.now();
    const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 2);
    cache.set(big, bigValue);
    for (let i = 0; i < 400 && (_routeIndexStatsForTest().pending || _routeIndexStatsForTest().partial); i++) await new Promise((r) => setTimeout(r, 5));
    clearInterval(iv);
    ok(!_routeIndexStatsForTest().partial && worst < 100, `an 80,000-tool seller indexes in the background without a long event-loop gap (worst ${worst.toFixed(0)} ms)`);
    ok(routeQuery({ query: "quux79999", top: 5, include: "external", ...ctx }).results.some((x) => x.slug === "zanzibar-79999"), "...and all of its rows are served once indexed");
    const big2 = "https://huge-seller-2.example";
    cache.set(big2, bigEntry(big2, 40000));
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); // a slice or two, not the whole entry
    const midway = routeQuery({ query: "quux39999", top: 5, include: "external", ...ctx }).results;
    ok(midway.some((x) => x.seller === big2 && x.slug === "zanzibar-39999"), "a query mid-index sees the entry's LAST row (the query finishes a partly indexed seller)");
    cache.delete(big); cache.delete(big2);
  }

  // A full re-crawl (every entry replaced) rebuilds the index in the background:
  // no single event-loop turn blocks for the rebuild, answers stay right during
  // it, and the rebuilt index carries no stale rows.
  {
    for (const [o, v] of [...cache]) cache.set(o, { ...v, tools: (v.tools || []).map((t) => ({ ...t })) });
    const during = routeQuery({ query: "json to csv", top: 10, include: "all", ...ctx }).results.map((r) => `${r.seller}|${r.slug}|${r.score}`);
    ok(_routeIndexStatsForTest().rebuilding, "past the stale share on a prod-sized pool the rebuild runs in the background");
    let worst = 0, last = performance.now();
    const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 2);
    await _routeIndexSettledForTest();
    await new Promise((r) => setTimeout(r, 10));
    clearInterval(iv);
    const st = _routeIndexStatsForTest();
    ok(!st.rebuilding && st.staleTools === 0 && st.indexedTools > 100000, `the background rebuild completed with no stale rows (${st.indexedTools} live, ${st.staleTools} stale)`);
    ok(worst < 150, `no event-loop turn blocked for the rebuild (worst gap ${worst.toFixed(0)} ms; a synchronous rebuild is ~1 s here)`);
    const after = routeQuery({ query: "json to csv", top: 10, include: "all", ...ctx }).results.map((r) => `${r.seller}|${r.slug}|${r.score}`);
    ok(JSON.stringify(during) === JSON.stringify(after), "the ranking during the rebuild equals the ranking after it");
  }
  cache.clear();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
