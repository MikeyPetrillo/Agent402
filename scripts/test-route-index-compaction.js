// The route index on the main thread clears the rows of replaced cache
// entries without a route query: with a router worker loaded, this thread
// answers no queries, and stale rows (each holding its old entry) used to pile
// up one full copy of the seller pool per crawl cycle until the heap ran out.
//
// And a crawl cycle in which no document changed builds nothing again. Each
// crawl stores new row objects, and every reader keyed on row identity built
// its part again: the decorated copy, the row's statics (its lowercased search
// text and screen verdict), its postings, and the stale share that followed
// started a full rebuild several times a cycle. On a production-sized heap
// that churn is what ran the full collections that stalled the loop. Pinned:
//   - an unchanged cycle keeps every row object, computes no statics, makes no
//     decorated copy, posts no row, leaves nothing stale and compacts nothing;
//   - a changed field always builds the row again (scalar, nested, key order,
//     an added key, a row written in place as a re-price writes);
//   - every cycle, changed, unchanged, mixed or shifted, leaves posting lists
//     that hold no row twice and every live row in every list of its tokens
//     (the audit reads the lists whole);
//   - a row whose postings a compaction is removing is posted again as a copy
//     of its own, never moved and never posted twice;
//   - a query that read the cache before a re-crawl moved its rows ranks as
//     one that ran with nothing moving;
//   - the directory rebuilt after an unchanged cycle holds the rows it held,
//     and after a changed one holds new rows and searches their text.
// Mutation-checked: postings moved without the compaction check, the copy
// posted as the same object, the query's moved-row read removed, rows kept
// without comparing them, the decorated copy kept without comparing it, and
// statics carried for a changed description each fail it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.X402_INDEX_CRAWL = "off";
const xi = await import("../src/x402-index.js");
const { buildRoutePerfFixture } = await import("./lib/route-perf-fixture.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const cache = xi._cacheForTests();
const { ctx } = buildRoutePerfFixture({ cache, setBazaarQuality: xi._setBazaarQualityForTest });
xi.warmRouteIndex();
const settle = async () => {
  await new Promise((r) => setTimeout(r, 5)); // the drain's last turn, which may start a compaction
  for (let i = 0; i < 20000; i++) {
    await new Promise((r) => setImmediate(r));
    const s = xi._routeIndexStatsForTest();
    if (!s.pending && !s.partial && !s.rebuilding) return s;
  }
  return xi._routeIndexStatsForTest();
};
await settle();
const reuse = () => (typeof xi._rowReuseStatsForTest === "function" ? xi._rowReuseStatsForTest() : null);
const audit = () => (typeof xi._routeIndexAuditForTest === "function" ? xi._routeIndexAuditForTest() : null);
const clean = (a) => !!a && a.duplicates === 0 && a.missing === 0 && a.staleRefs === 0 && a.homeless === 0 && a.liveRows > 100000;
const show = (a) => (a ? `${a.refs} refs, ${a.liveRows} live rows, ${a.duplicates} twice, ${a.missing} missing, ${a.staleRefs} stale` : "no audit hook");
const ranked = (q) => xi.routeQuery({ query: q, top: 10, include: "external", ...ctx }).results.map((r) => `${r.seller}|${r.slug}|${r.score}|${r.price}`);
const QUERIES = ["json to csv", "weather forecast", "wallet balance"];
const rankAll = () => QUERIES.map(ranked);
const delta = (a, b) => (a && b ? Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]])) : null);
const totalRows = () => [...cache.values()].reduce((n, v) => n + (v.tools || []).length, 0);
const base = xi._routeIndexStatsForTest().indexedTools;
ok(clean(audit()), `control: the warmed index holds every live row once (${show(audit())})`);

// The directory rebuilt from the cache (its one-minute flatten memo dropped).
// A read after the cache changed answers from the rows it holds and starts the
// rebuild; the read after the rebuild answers from the new rows.
const directory = async (args = {}) => { xi._resetFlatCacheForTest?.(); await xi.allIndexedToolsAsync({ limit: 1 }); await xi._indexRowsSettledForTest(); return xi.allIndexedToolsAsync({ limit: 500, ...args }); };
const dir0 = await directory();

// ---- unchanged cycles: every entry and row a new object, equal to the last -----------
for (let cycle = 0; cycle < 2; cycle++) {
  const was = rankAll(), b0 = xi._routeIndexStatsForTest().builds, r0 = reuse(), rows = totalRows();
  for (const [o, v] of [...cache]) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })), fetchedAt: Date.now() });
  const s = await settle();
  const d = delta(r0, reuse());
  ok(s.staleTools === 0 && s.builds === b0, `unchanged cycle ${cycle + 1}: nothing stale and no compaction (stale ${s.staleTools}, builds ${b0} -> ${s.builds})`);
  ok(!!d && d.rowsKept === rows && d.staticsBuilt === 0 && d.rowsDecorated === 0 && d.rowsPosted === 0 && d.rowsCopied === 0 && d.rowsMoved > 100000,
    `unchanged cycle ${cycle + 1}: every row kept (${d?.rowsKept} of ${rows}), no search text built (${d?.staticsBuilt}), no row decorated again (${d?.rowsDecorated}), none posted again (${d?.rowsPosted}); ${d?.rowsMoved} moved`);
  ok(clean(audit()), `unchanged cycle ${cycle + 1}: the lists hold every live row once (${show(audit())})`);
  ok(JSON.stringify(rankAll()) === JSON.stringify(was), `unchanged cycle ${cycle + 1}: the rankings are the same`);
  const f0 = reuse();
  const dir = await directory();
  const kept = delta(f0, reuse())?.flatRowsKept;
  ok(kept === dir.thirdParty && dir.thirdParty > 100000 && JSON.stringify(dir) === JSON.stringify(dir0), `unchanged cycle ${cycle + 1}: the directory rebuild keeps every row it held (${kept} of ${dir.thirdParty}) and answers the same`);
}

// ---- changed cycles: every row's text changed --------------------------------------
let worst = 0;
for (let cycle = 0; cycle < 3; cycle++) {
  const b0 = xi._routeIndexStatsForTest().builds;
  for (const [o, v] of [...cache]) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t, description: `${String(t.description).replace(/ gen\d+$/, "")} gen${cycle}` })), fetchedAt: Date.now() });
  const s = await settle();
  worst = Math.max(worst, s.staleTools);
  ok(s.staleTools === 0 && s.builds > b0, `changed cycle ${cycle + 1}: no stale rows remain without a query (stale ${s.staleTools}, indexed ${s.indexedTools}, builds ${b0} -> ${s.builds})`);
  ok(clean(audit()), `changed cycle ${cycle + 1}: the compacted lists hold every live row once (${show(audit())})`);
  if (cycle === 0) {
    const f0 = reuse();
    const found = await directory({ search: "gen0" });
    ok(delta(f0, reuse())?.flatRowsKept === 0 && found.matched === found.thirdParty, `changed cycle 1: the directory builds every changed row again (${delta(f0, reuse())?.flatRowsKept} kept) and searches the new text (${found.matched} of ${found.thirdParty} match)`);
  }
}
const end = xi._routeIndexStatsForTest();
ok(end.indexedTools <= base * 1.01, `the index stays one copy of the pool (${end.indexedTools} rows vs ${base} at boot)`);
ok(ranked("gen2").length === 10 && ranked("gen1").length === 0, "the last cycle's text is found and the cycle before's is not");

// ---- a mixed cycle: some sellers changed, some not, some with a row added in front --
{
  const r0 = reuse();
  let i = 0;
  for (const [o, v] of [...cache]) {
    const k = i++ % 3;
    const tools = k === 0 ? v.tools.map((t) => ({ ...t, description: `${t.description} mixed` }))
      : k === 1 ? v.tools.map((t) => ({ ...t }))
      : [{ ...v.tools[0], route: `${v.tools[0].route}-front`, slug: `${v.tools[0].slug}-front` }, ...v.tools.map((t) => ({ ...t }))];
    cache.set(o, { ...v, tools, fetchedAt: Date.now() });
  }
  await settle();
  const d = delta(r0, reuse());
  ok(!!d && d.rowsMoved > 10000 && d.rowsPosted > 10000, `a mixed cycle moves the unchanged sellers' rows (${d?.rowsMoved}) and posts the rest (${d?.rowsPosted})`);
  // Whatever was left stale is compacted; then the lists are whole.
  xi._routeIndexStartShadowForTest();
  await settle();
  ok(clean(audit()), `a mixed cycle leaves every live row once in the lists (${show(audit())})`);
}

// ---- a changed field always builds the row again ------------------------------------
{
  const o = "https://kept-rows.example";
  const row = (extra = {}) => ({ seller: o, method: "POST", route: "/api/zebra", slug: "zebra-count", name: "Zebra count", description: "counts zebras on the plain", category: "data", tags: ["zebra"], price: 0.002, networks: ["eip155:8453"], accepts: [{ network: "eip155:8453", amount: "2000" }], ...extra });
  const entry = (tools, history = [1, 1, 1]) => ({ manifest: { name: "Kept rows", homepage: o }, tools, fetchedAt: Date.now(), error: null, history });
  const zebra = () => xi.routeQuery({ query: "zebras", top: 5, include: "external", ...ctx }).results.find((r) => r.seller === o);
  cache.set(o, entry([row()]));
  await settle();
  const first = cache.get(o).tools[0];
  ok(zebra()?.price === 0.002, "control: the seller's row is served");
  cache.set(o, entry([row()]));
  ok(cache.get(o).tools[0] === first, "an equal row is kept as the object it replaces");
  const cases = [
    ["a changed scalar", row({ price: 0.003 }), (r) => r?.price === 0.003],
    ["a changed nested value", row({ accepts: [{ network: "eip155:8453", amount: "3000" }] }), null],
    ["its keys in another order", (() => { const { price, ...rest } = row(); return { price, ...rest }; })(), null],
    ["an added key with no value", row({ quoteSource: undefined }), null],
  ];
  for (const [what, next, served] of cases) {
    const was = cache.get(o).tools[0];
    cache.set(o, entry([next]));
    await settle();
    ok(cache.get(o).tools[0] !== was && cache.get(o).tools[0] === next, `a row with ${what} is stored as the new row`);
    if (served) ok(served(zebra()), `...and served with the change (${zebra()?.price})`);
  }
  // A re-price writes the live row in place and stores a copy of the entry.
  {
    cache.set(o, entry([row()]));
    await settle();
    const live = cache.get(o);
    ok(zebra()?.price === 0.002, "control: the seller's row is served at its price");
    live.tools[0].price = 0.005;
    cache.set(o, { ...live });
    await settle();
    ok(zebra()?.price === 0.005, `a row written in place and stored again is decorated again (${zebra()?.price})`);
  }
  // The seller's context changed (its health), the row did not: a new copy
  // carries the new health, and the row's statics carry over.
  {
    const r0 = reuse();
    cache.set(o, entry(cache.get(o).tools.map((t) => ({ ...t })), [1, 0, 1, 1]));
    await settle();
    const d = delta(r0, reuse());
    ok(zebra()?.why?.health === 0.75 && d?.rowsDecorated === 1 && d?.staticsBuilt === 0, `a seller whose health changed is decorated again with it (${zebra()?.why?.health}, ${d?.rowsDecorated} copy) and its statics carry over (${d?.staticsBuilt} built)`);
    const r1 = reuse();
    cache.set(o, entry(cache.get(o).tools.map((t) => ({ ...t, description: "counts zebras and okapis" })), [1, 0, 1, 1]));
    await settle();
    const d1 = delta(r1, reuse());
    ok(d1?.staticsBuilt === 1 && xi.routeQuery({ query: "okapis", top: 5, include: "external", ...ctx }).results.some((r) => r.seller === o), `a changed description builds the row's statics again (${d1?.staticsBuilt}) and is found by its new word`);
  }
  cache.delete(o);
  await settle();
}

// ---- a row a compaction is removing is copied, never moved or posted twice ------------
{
  const o = "https://copied-rows.example";
  const tools = Array.from({ length: 40 }, (_, j) => ({ seller: o, method: "GET", route: `/api/okapi-${j}`, slug: `okapi-${j}`, name: `Okapi ${j}`, description: `okapi census row ${j} json`, category: "data", tags: ["okapi"], price: 0.001, networks: ["eip155:8453"] }));
  cache.set(o, { manifest: { name: "Copied", homepage: o }, tools, fetchedAt: 1, error: null, history: [1, 1] });
  await settle();
  // The same rows again (kept), decorated by a query while still waiting to be indexed.
  cache.set(o, { manifest: { name: "Copied", homepage: o }, tools: tools.map((t) => ({ ...t })), fetchedAt: 2, error: null, history: [1, 1] });
  const v2 = cache.get(o);
  xi.routeQuery({ query: "okapi census", top: 5, include: "external", ...ctx, drainBacklog: false });
  // Taken out of the cache and a compaction started: the first entry's rows are
  // being removed. Then the decorated entry is stored again and indexed.
  cache.delete(o);
  const r0 = reuse();
  xi._routeIndexStartShadowForTest();
  cache.set(o, v2);
  await settle();
  const d = delta(r0, reuse());
  ok(!!d && d.rowsCopied === 40 && d.rowsMoved === 0, `rows whose postings a compaction was removing are posted as copies (${d?.rowsCopied} copied, ${d?.rowsMoved} moved)`);
  xi._routeIndexStartShadowForTest();
  await settle();
  ok(clean(audit()), `...and every live row is in the lists once (${show(audit())})`);
  const served = new Set();
  for (let j = 0; j < 40; j++) for (const r of xi.routeQuery({ query: `okapi ${j}`, top: 25, include: "external", ...ctx }).results) if (r.seller === o) served.add(r.slug);
  ok(served.size === 40, `...and all 40 are served (${served.size})`);
  cache.delete(o);
  await settle();
}

// ---- a query part way through while a re-crawl moves the rows it reads ----------------
{
  const want = await Promise.all(QUERIES.map((q) => xi.routeQueryAsyncInThread({ query: q, top: 10, include: "external", ...ctx }, { sliceMs: 0.2 })));
  const m0 = reuse();
  const running = QUERIES.map((q) => xi.routeQueryAsyncInThread({ query: q, top: 10, include: "external", ...ctx }, { sliceMs: 0.2 }));
  for (const [o, v] of [...cache]) cache.set(o, { ...v, tools: v.tools.map((t) => ({ ...t })), fetchedAt: Date.now() });
  const got = await Promise.all(running);
  const moved = delta(m0, reuse())?.rowsMoved || 0;
  const sig = (r) => JSON.stringify(r.results.map((x) => `${x.seller}|${x.slug}|${x.score}`));
  ok(moved > 0 && got.every((r, i) => sig(r) === sig(want[i]) && r.results.length === 10), `queries that read the cache before a re-crawl moved ${moved} of their rows rank as before (${got.map((r) => r.results.length).join(", ")} results)`);
  await settle();
}

console.log(`\ntest-route-index-compaction: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
