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
  ok(names.includes("index_listings_order_idx") && names.includes("index_listings_category_idx"), `the order and category indexes exist (${names.join(", ")})`);
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
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb?.();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`test-index-listings-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
