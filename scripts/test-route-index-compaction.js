// The route index on the main thread clears the rows of replaced cache
// entries without a route query: with a router worker loaded, this thread
// answers no queries, and stale rows (each holding its old entry) used to pile
// up one full copy of the seller pool per crawl cycle until the heap ran out.
process.env.X402_INDEX_CRAWL = "off";
const xi = await import("../src/x402-index.js");
const { buildRoutePerfFixture } = await import("./lib/route-perf-fixture.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const cache = xi._cacheForTests();
buildRoutePerfFixture({ cache, setBazaarQuality: xi._setBazaarQualityForTest });
xi.warmRouteIndex();
const settle = async () => {
  for (let i = 0; i < 5000; i++) {
    await new Promise((r) => setImmediate(r));
    const s = xi._routeIndexStatsForTest();
    if (!s.pending && !s.partial && !s.rebuilding) return;
  }
};
const base = xi._routeIndexStatsForTest().indexedTools;
let worst = 0;
for (let cycle = 0; cycle < 4; cycle++) {
  // A crawl cycle: every entry replaced by a new object, and no route query.
  for (const [o, v] of [...cache]) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })), fetchedAt: Date.now() });
  await settle();
  const s = xi._routeIndexStatsForTest();
  worst = Math.max(worst, s.staleTools);
  ok(s.staleTools === 0, `cycle ${cycle + 1}: no stale rows remain without a query (stale ${s.staleTools}, indexed ${s.indexedTools})`);
}
const end = xi._routeIndexStatsForTest();
ok(end.indexedTools <= base * 1.01, `the index stays one copy of the pool (${end.indexedTools} rows vs ${base} at boot)`);
console.log(`\ntest-route-index-compaction: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
