// The tool directory served from the state database (INDEX_LISTINGS_STORE=pg)
// against a REAL Postgres: the table and its indexes are created, every cached
// origin is backfilled, a page is the in-memory directory's page row for row
// (order, counts, filters, search, paging, our own rows interleaved), a crawl
// change and a removal reach the table, no container builds the flattened
// directory while it is on, and a search answers in under 50 ms at fixture
// scale. Off, nothing is created and the in-memory directory answers.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-index-listings-pg" });
process.env.X402_INDEX_CRAWL = "off";
delete process.env.INDEX_LISTINGS_STORE;
const DIR = mkdtempSync(join(tmpdir(), "listings-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.INDEX_CACHE_NDJSON_FILE = join(DIR, "x402-index-cache.ndjson");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");
const SELLERS = Number(process.env.LISTINGS_TEST_SELLERS || 400);

const sdb = await import("../src/state-db.js");
const x = await import("../src/x402-index.js");
const cache = x._cacheForTests();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ------------------------------------------------------------------ fixture
const SELF = "https://self-host.example";
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const words = ["weather", "stock", "news", "price", "image", "pdf", "search", "token", "swap", "chat", "dns", "email", "geo", "nft", "quote", "translate", "ocr", "hash", "fx", "data"];
const cats = ["data", "finance", "ai", "web", "crypto", "media", "other"];
const nets = ["eip155:8453", "eip155:137", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:4663"];
const pick = (a) => a[Math.floor(rnd() * a.length)];
function entryFor(i) {
  const n = (i % 37 === 0 ? 60 : 3 + (i % 9)) * Number(process.env.LISTINGS_TEST_TOOLS_MULT || 1);
  const tools = [];
  for (let j = 0; j < n; j++) {
    const route = `/api/${pick(words)}-${j % 5}`;
    tools.push({
      route, method: j % 7 === 3 ? "GET" : "POST",
      name: `${pick(words)} ${pick(words)}`,
      description: j % 3 === 0 ? "" : `${pick(words)} ${pick(words)} for ${pick(words)} lookups by agents`,
      category: j % 11 === 0 ? undefined : pick(cats),
      tags: [pick(words), pick(words)],
      price: j % 4 === 0 ? "$0.002" : 0.001 * (1 + (j % 3)),
      networks: [pick(nets), ...(j % 2 ? [pick(nets)] : [])],
    });
  }
  // Same route twice with different methods in one seller (a rank tie).
  if (i % 13 === 0) tools.push({ ...tools[0], method: tools[0].method === "GET" ? "POST" : "GET" });
  // Shared seller names across origins (one interleave group).
  const name = i % 50 === 0 ? "Shared Name Co" : i % 3 === 0 ? "" : `Seller ${String(i).padStart(4, "0")} ${pick(words)}`;
  return {
    manifest: { name, slimmed: true }, tools, fetchedAt: 1_700_000_000_000 + i,
    error: i % 97 === 5 ? "fetch failed" : null,
    history: i % 89 === 7 ? [0, 0, 0] : [1, 1, 1],
  };
}
const origins = [];
for (let i = 0; i < SELLERS; i++) {
  const origin = i % 61 === 0 ? `http://plain-${i}.example` : `https://seller-${i}.example`;
  origins.push(origin);
  cache.set(origin, entryFor(i));
}
cache.set(SELF, entryFor(9999));
const ourTools = Array.from({ length: 40 }, (_, i) => ({
  ours: true, seller: SELF, sellerName: "Agent402", slug: `t${i}`, name: `tool ${i}`, route: `/api/ours-${i % 17}`, method: i % 2 ? "GET" : "POST",
  url: `${SELF}/api/ours-${i}`, description: i % 5 ? `our ${pick(words)} tool for agents` : "", described: i % 5 !== 0,
  category: pick(cats), tags: [pick(words)], priceUsd: 0.001, price: "$0.001", payable: "x402", networks: ["eip155:8453"],
}));

const QUERIES = [
  {}, { offset: 100 }, { offset: 900, limit: 250 }, { limit: 500, offset: 2000 },
  { search: "weather" }, { search: "stock price" }, { search: "agents lookups", offset: 50 }, { search: "nomatchzzz" },
  { category: "finance" }, { category: "other" }, { network: "4663" }, { network: "solana", search: "token" },
  { source: "ours" }, { source: "third-party", offset: 300 }, { source: "third-party", category: "ai", search: "chat" },
  { search: "Shared" }, { search: "100%_" },
];
const run = async (q) => x.allIndexedToolsAsync({ ...q, ourTools, excludeOrigin: SELF });
const stable = (r) => JSON.stringify(r);

try {
  // ---- off: the in-memory directory (the baseline) ---------------------------
  ok(x.configureListingsStore({ excludeOrigin: SELF, ourTools }) === false, "off: configuring the store is a no-op");
  const baseline = [];
  for (const q of QUERIES) baseline.push(stable(await run(q)));
  const baseCats = x.indexedToolCategories(SELF);
  const tables = await sdb.stateQuery("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'index_listing%'", [sdb.stateDbSchema()]);
  ok(tables.rows[0].n === 0, "off: no directory table is created");
  ok(JSON.parse(baseline[0]).total > 1000, `the fixture directory has ${JSON.parse(baseline[0]).total} rows`);

  // ---- on: backfill, then every query answers the same ----------------------
  process.env.INDEX_LISTINGS_STORE = "pg";
  ok(x.configureListingsStore({ excludeOrigin: SELF, ourTools }) === true, "on: the store is configured");
  const store = x._listingsStoreForTest();
  const t0 = performance.now();
  await store.flush();
  const backfillMs = Math.round(performance.now() - t0);
  const st = store.status();
  ok(st.pending === 0 && st.writes >= SELLERS, `backfill wrote every origin (${st.writes} writes, ${backfillMs} ms)`);
  const idx = await sdb.stateQuery("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'index_listings'", [sdb.stateDbSchema()]);
  const names = idx.rows.map((r) => r.indexname);
  ok(names.includes("index_listings_page_idx") && names.includes("index_listings_category_idx"), `the page-order and category indexes exist (${names.join(", ")})`);
  ok(!st.trigram || names.includes("index_listings_hay_trgm"), `search index: ${st.trigram ? "pg_trgm trigram GIN" : "pg_trgm unavailable, table scan"}`);
  const flatBefore = x._flatBuildsForTest();
  let same = 0;
  for (let i = 0; i < QUERIES.length; i++) {
    const got = stable(await run(QUERIES[i]));
    if (got === baseline[i]) same++;
    else {
      const a = JSON.parse(baseline[i]), b = JSON.parse(got);
      const firstDiff = a.results.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(b.results[k]));
      console.error(`  differs: ${JSON.stringify(QUERIES[i])} counts off=${JSON.stringify({ ...a, results: a.results.length })} on=${JSON.stringify({ ...b, results: b.results.length })} first row diff at ${firstDiff}: ${JSON.stringify(a.results[firstDiff])?.slice(0, 160)} vs ${JSON.stringify(b.results[firstDiff])?.slice(0, 160)}`);
    }
  }
  ok(same === QUERIES.length, `every page is the in-memory directory's, row for row (${same}/${QUERIES.length} queries)`);
  ok(x._flatBuildsForTest() === flatBefore, "on: no container builds the flattened directory in memory");
  const cats = await x.indexedToolCategoriesAsync(SELF);
  const asMap = (list) => JSON.stringify(Object.fromEntries(list.map((c) => [c.category, c.count]).sort()));
  ok(asMap(cats) === asMap(baseCats), "the category rollup counts are the in-memory rollup's");
  ok(cats.every((c, i) => i === 0 || cats[i - 1].count >= c.count), "categories are ordered most first");

  // ---- a crawl change and a removal reach the table --------------------------
  const changed = origins[4], removed = origins[8];
  const e = entryFor(4);
  cache.set(changed, { ...e, tools: [...e.tools, { route: "/api/brand-new-route", method: "POST", name: "brand new", description: "a brand new weather route for agents", category: "web", tags: [], price: "$0.003", networks: ["eip155:8453"] }], fetchedAt: e.fetchedAt + 1 });
  cache.delete(removed);
  await store.flush();
  const newRow = await sdb.stateQuery(`SELECT count(*)::int AS n FROM ${sdb.stateDbSchema()}.index_listings WHERE origin = $1 AND route = '/api/brand-new-route'`, [changed]);
  ok(newRow.rows[0].n === 1, "a changed origin's new route is written");
  // A change to a row's text alone (same method and route) reaches the table.
  const textOrigin = origins[10];
  const te = cache.get(textOrigin);
  cache.set(textOrigin, { ...te, tools: te.tools.map((t, k) => (k === 0 ? { ...t, description: "renamed weather lookups for agents zzqx" } : t)), fetchedAt: te.fetchedAt + 1 });
  await store.flush();
  const renamed = await sdb.stateQuery(`SELECT count(*)::int AS n FROM ${sdb.stateDbSchema()}.index_listings WHERE origin = $1 AND hay LIKE '%zzqx%'`, [textOrigin]);
  ok(renamed.rows[0].n === 1, "a changed description on an existing route is written");
  const gone = await sdb.stateQuery(`SELECT count(*)::int AS n FROM ${sdb.stateDbSchema()}.index_listings WHERE origin = $1`, [removed]);
  ok(gone.rows[0].n === 0, "a removed origin's rows are deleted");
  // The answers still match the in-memory directory over the changed cache.
  const onAfter = [];
  for (const q of QUERIES.slice(0, 8)) onAfter.push(stable(await run(q)));
  delete process.env.INDEX_LISTINGS_STORE;
  x._resetFlatCacheForTest(); x._resetIndexRowsForTest();
  const flatOff = x._flatBuildsForTest();
  let same2 = 0;
  for (let i = 0; i < 8; i++) if (stable(await run(QUERIES[i])) === onAfter[i]) same2++;
  ok(same2 === 8, `after the change and the removal the pages still match (${same2}/8)`);
  ok(x._flatBuildsForTest() > flatOff, "switched off, the same process answers from the in-memory directory again (the switch is read per request)");
  process.env.INDEX_LISTINGS_STORE = "pg";

  // ---- a second container's identical write is a hash compare ----------------
  const writes = store.status().writes;
  for (const o of origins.slice(0, 50)) store.markDirty(o);
  await store.flush();
  ok(store.status().writes === writes, "re-marking unchanged origins writes nothing (content hash)");

  // ---- reconcile: stored origins the cache no longer holds are removed -------
  {
    const strayOrigin = "https://stray-not-cached.example";
    await store.writeOrigin(strayOrigin, { sellerKey: "Stray Co", sellerName: "Stray Co", rows: [{ method: "POST", route: "/api/stray", t: { route: "/api/stray", name: "stray" }, flat: { described: true, category: "web", networks: [] } }] });
    const kept = origins[20];
    const before = await sdb.stateQuery(`SELECT origin FROM ${sdb.stateDbSchema()}.index_listing_origins WHERE origin = ANY($1)`, [[strayOrigin, kept]]);
    ok(before.rows.length === 2, "the stray origin is stored beside a cached one");
    const removedN = await x.reconcileListings();
    const after = await sdb.stateQuery(`SELECT origin FROM ${sdb.stateDbSchema()}.index_listing_origins WHERE origin = ANY($1)`, [[strayOrigin, kept]]);
    const strayRows = await sdb.stateQuery(`SELECT count(*)::int AS n FROM ${sdb.stateDbSchema()}.index_listings WHERE origin = $1`, [strayOrigin]);
    ok(removedN >= 1 && after.rows.length === 1 && after.rows[0].origin === kept && strayRows.rows[0].n === 0, `reconcile removes the origin the cache does not hold and keeps the cached one (removed ${removedN})`);
  }

  // ---- the category rollup is kept briefly and cleared by a write ------------
  {
    store._resetCountsForTest();
    const q0 = store._statsForTest().categoryQueries;
    await x.indexedToolCategoriesAsync(SELF); await x.indexedToolCategoriesAsync(SELF); await x.indexedToolCategoriesAsync(SELF);
    const q1 = store._statsForTest().categoryQueries;
    ok(q1 - q0 === 1, `three category reads run one query (${q1 - q0})`);
    const ce = cache.get(origins[12]);
    cache.set(origins[12], { ...ce, fetchedAt: ce.fetchedAt + 1, tools: [...ce.tools, { route: "/api/cat-bump", method: "POST", name: "bump", description: "a bump for agents", category: "media", tags: [], price: "$0.001", networks: ["eip155:8453"] }] });
    await store.writeOrigin(origins[12], x._listingRowsForOriginForTest(origins[12]));
    await x.indexedToolCategoriesAsync(SELF);
    ok(store._statsForTest().categoryQueries - q1 === 1, "a write clears it: the next read queries again");
  }

  // ---- the database cannot answer: last good page, else a 503 ------------------
  {
    const s = sdb.stateDbSchema();
    const seen = await run({ search: "weather" });
    await sdb.stateQuery(`ALTER TABLE ${s}.index_listings RENAME TO index_listings_away`);
    try {
      const stale = await run({ search: "weather" });
      ok(stale.stale === true && JSON.stringify(stale.results) === JSON.stringify(seen.results), "a page already served is answered from its last good copy, marked stale");
      let err = null;
      try { await run({ search: "never-asked-before-zz" }); } catch (e) { err = e; }
      ok(err && err.statusCode === 503, `a page never served answers a 503, not a crash (${err?.statusCode})`);
      store._resetCountsForTest();
      let cerr = null;
      try { await x.indexedToolCategoriesAsync("https://other-self.example"); } catch (e) { cerr = e; }
      ok(cerr && cerr.statusCode === 503, "the category rollup answers a 503 the same way");
    } finally {
      await sdb.stateQuery(`ALTER TABLE ${s}.index_listings_away RENAME TO index_listings`);
    }
  }

  // ---- the search uses the trigram index -----------------------------------------
  if (st.trigram) {
    // A small fixture table is cheaper to scan, so the planner is told to avoid
    // a scan where it can: the check is that the search CAN use the index.
    const text = await sdb.withStateTx(async (c) => {
      await c.query("SET LOCAL enable_seqscan = off");
      const plan = await c.query(`EXPLAIN SELECT count(*) FROM ${sdb.stateDbSchema()}.index_listings WHERE hay LIKE '%weather%'`);
      return plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    ok(/index_listings_hay_trgm/.test(text), `a search reads the trigram index, not the whole table (${/Seq Scan/.test(text) ? "seq scan" : "index"})`);
  }

  // ---- latency -----------------------------------------------------------------
  // Each page timed with the database warm (it has answered the query once)
  // and this process's count cache emptied, so the count runs again: the
  // steady state of a page whose counts have expired.
  const times = [];
  for (const q of [{ search: "weather" }, { search: "stock price", offset: 100 }, { category: "finance", search: "quote" }, { offset: 3000 }, { search: "lookups agents" }]) {
    await run(q);
    store._resetCountsForTest();
    const t = performance.now(); await run(q); times.push(performance.now() - t);
  }
  const worst = Math.round(Math.max(...times));
  // Same-database baseline: a page is a handful of round trips, so a slow
  // runner or database slows a bare round trip too. The bound is 50 ms or
  // twenty round trips, whichever is larger, under 250 ms; a page that
  // scanned the table would still exceed it (the plan check above pins the
  // index use itself).
  const trips = [];
  for (let k = 0; k < 9; k++) { const t = performance.now(); await sdb.stateQuery("SELECT 1"); trips.push(performance.now() - t); }
  const tripMs = trips.sort((p, q) => p - q)[4];
  const bound = Math.round(Math.min(250, Math.max(Number(process.env.LISTINGS_SEARCH_MS || 50), tripMs * 20)));
  ok(worst < bound, `a directory page answers in ${worst} ms at ${JSON.parse(baseline[0]).total} rows, counts included (bound ${bound} ms: 50 ms or twenty ${tripMs.toFixed(1)} ms round trips)`);

  // ---- two containers on one table: one seller order, paging is exact ----------
  // Container B boots while the order table is empty, A places sellers, then a
  // new seller arrives on each (a crawl, then the peer pull). B's empty copy
  // must not renumber over A's placement, and no two sellers share an ord.
  {
    const s = sdb.stateDbSchema();
    for (const t of ["index_listings", "index_listing_bodies", "index_listing_sellers", "index_listing_origins"]) await sdb.stateQuery(`DROP TABLE IF EXISTS ${s}.${t}`);
    const { createListingsStore } = await import("../src/index-listings-pg.js");
    const coll = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const data = {};
    const keys = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "zulu"];
    keys.forEach((k, i) => { data[`https://${k}-1.example`] = { key: k, n: 2 + (i % 4) }; });
    const mk = () => createListingsStore({
      rowsForOrigin: (o) => (data[o] ? { sellerKey: data[o].key, sellerName: data[o].key, rows: Array.from({ length: data[o].n }, (_, j) => ({ method: "POST", route: `/r${j}`, t: { o, j }, flat: { described: j % 2 === 0, category: "x", networks: [] } })) } : null),
      keyForOrigin: (o) => data[o]?.key || null,
      projectRow: (o, t) => ({ o, j: t.j }), collate: coll, terms: (q) => [q], hayOf: () => "h", log: () => {},
    });
    const A = mk(), B = mk();
    await A.ensure(); await B.ensure();
    for (const o of Object.keys(data)) A.markDirty(o);
    await A.flush();
    data["https://golf-1.example"] = { key: "golf", n: 3 }; data["https://golf-2.example"] = { key: "golf", n: 2 };
    A.markDirty("https://golf-1.example"); await A.flush();
    B.markDirty("https://golf-2.example"); await B.flush();
    const sellers = await sdb.stateQuery(`SELECT seller_key, ord FROM ${s}.index_listing_sellers`);
    const ords = sellers.rows.map((r) => Number(r.ord));
    ok(new Set(ords).size === ords.length, `no two sellers share an order position (${ords.length} sellers)`);
    const split = await sdb.stateQuery(`SELECT seller_key, count(DISTINCT seller_ord)::int AS n FROM ${s}.index_listings GROUP BY 1 HAVING count(DISTINCT seller_ord) > 1`);
    ok(split.rows.length === 0, `every seller's rows carry one order position (${split.rows.map((r) => r.seller_key).join(",") || "none split"})`);
    const byKey = new Map(sellers.rows.map((r) => [r.seller_key, Number(r.ord)]));
    const sorted = [...byKey.keys()].sort(coll);
    ok(sorted.every((k, i) => i === 0 || byKey.get(sorted[i - 1]) < byKey.get(k)), "the order positions follow the collated seller names");
    // Paging over the whole directory returns every row exactly once, in the
    // order one big page gives.
    const whole = await A.directory({ limit: 500 });
    const paged = [];
    for (let off = 0; off < whole.matched; off += 3) paged.push(...(await B.directory({ offset: off, limit: 3 })).results);
    const ids = paged.map((r) => `${r.o}#${r.j}`);
    ok(new Set(ids).size === ids.length && ids.length === whole.matched, `paging in 3s returns every row once (${ids.length} of ${whole.matched})`);
    ok(JSON.stringify(paged) === JSON.stringify(whole.results), "...in the order one page of everything gives");

    // A renumber on A while B's copy is stale: B's next write for a seller it
    // already knows must take that seller's position from the table.
    for (let i = 0; i < 60; i++) data[`https://aa${String(i).padStart(3, "0")}-1.example`] = { key: `aa${String(i).padStart(3, "0")}`, n: 1 };
    for (const o of Object.keys(data)) if (o.startsWith("https://aa")) A.markDirty(o);
    await A.flush();
    data["https://alpha-1.example"].n = 5;
    await B.writeOrigin("https://alpha-1.example", (() => { const d = data["https://alpha-1.example"]; return { sellerKey: d.key, sellerName: d.key, rows: Array.from({ length: d.n }, (_, j) => ({ method: "POST", route: `/r${j}`, t: { o: "https://alpha-1.example", j }, flat: { described: j % 2 === 0, category: "x", networks: [] } })) }; })());
    const split2 = await sdb.stateQuery(`SELECT l.seller_key FROM ${s}.index_listings l JOIN ${s}.index_listing_sellers k ON k.seller_key = l.seller_key WHERE l.seller_ord <> k.ord LIMIT 5`);
    ok(split2.rows.length === 0, `after a peer's renumber, a write from a container with a stale copy uses the table's position (${split2.rows.map((r) => r.seller_key).join(",") || "all match"})`);

    // Rows that tie on (described, rank, seller position) still page exactly
    // once each: the page order ends on (origin, pos).
    await sdb.stateQuery(`UPDATE ${s}.index_listings SET seller_ord = 1 WHERE seller_key IN ('bravo', 'charlie', 'delta')`);
    const tied = await A.directory({ limit: 500 });
    const tiedPaged = [];
    for (let off = 0; off < tied.matched; off += 2) tiedPaged.push(...(await B.directory({ offset: off, limit: 2 })).results);
    const tiedIds = tiedPaged.map((r) => `${r.o}#${r.j}`);
    ok(new Set(tiedIds).size === tiedIds.length && tiedIds.length === tied.matched && JSON.stringify(tiedPaged) === JSON.stringify(tied.results), `rows tied on their sort key page exactly once each (${tiedIds.length} of ${tied.matched})`);
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb?.();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`test-index-listings-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
