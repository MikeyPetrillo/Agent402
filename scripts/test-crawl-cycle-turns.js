#!/usr/bin/env node
// A crawl cycle on a production-sized index holds no long turn. Long turns
// while the x402 crawl, its discovery and the MPP crawl run, with little
// garbage collection in them and no named turn to account for them, came not
// from one slow function but from many in one loop iteration:
//   - the manifest crawl's merge passes, its quote carry-forward and its store
//     ran as each crawl's continuation, so the 25 crawls whose reads landed in
//     one poll ran their derivations back to back in that iteration (measured
//     here: 25 stores in one iteration);
//   - a crawl's zlib starts (packing the manifest, unpacking it on a 304) and
//     its JSON parse of the unpacked body did the same.
// Each now takes a crawl-lane turn (one crawl's step per loop iteration), and
// the crawl's synchronous steps are spans named for the [loop-lag] line
// (src/active-jobs.js). Pinned here: no loop iteration stores more than two
// crawls' entries (counted per iteration, so the machine's speed does not
// decide it), and no turn of the runs passes a bound on the ours clock.
//
// Driven through the real code: a Bazaar-shaped discovery pass, two crawl
// cycles (src/x402-index.js runCrawl: every origin read, then every origin
// read again with changed documents), and an MPP crawl over dual-stack
// origins (src/mpp-index.js runMppCrawl), all over stub reads that answer in
// batches. The longest turn is read on the ours clock
// (scripts/lib/ours-clock.js gapMeter), so a busy host does not fail it.
// Mutation-checked: the passes or the store off the lane fails it. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import "./lib/guard-dns-offline.js"; // the MPP probe's name checks answer from this process
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStoreEnv } from "./lib/own-stores.js";
import { bound, gapMeter, OURS_READING } from "./lib/ours-clock.js";
import { buildRoutePerfFixture } from "./lib/route-perf-fixture.js";

Object.assign(process.env, ownStoreEnv("crawl-cycle-turns"));
process.env.X402_INDEX_CRAWL = "off";
process.env.MPP_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "0";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
const SELLERS = Number(process.env.CRAWL_TURNS_SELLERS || 3000);
const origins = Array.from({ length: SELLERS }, (_, i) => `https://seller${i}.example`);
process.env.X402_INDEX_SEEDS = origins.join(",");
const dir = mkdtempSync(join(tmpdir(), "crawl-cycle-turns-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(dir, "x402-index-cache.json");
process.env.MPP_INDEX_CACHE_FILE = join(dir, "mpp-index-cache.json");

// One line per learned quote is the crawl's own log; thousands of them here.
const log = console.log;
console.log = (...a) => { if (!/^\[(x402-index|mpp-index)\] (live-402 quote|cycle|persisted)/.test(String(a[0]))) log(...a); };
const idx = await import("../src/x402-index.js");
const mpp = await import("../src/mpp-index.js");
const { turnsDuring, _resetTurnsForTest } = await import("../src/active-jobs.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const LIMIT = bound(Number(process.env.CRAWL_TURN_MS || 150), 6);
console.log(`# ${SELLERS} sellers; ${LIMIT.note}`);

// ---- the index: the router perf pin's prod-sized fixture, with production's
// heavier rows: one seller in five writes long descriptions (2 KB, as OpenAPI
// summaries with parameter prose do), and a few list thousands of tools.
const toolsOf = new Map();
buildRoutePerfFixture({ sellers: SELLERS, toolsTarget: SELLERS * 33, cache: { set: (o, e) => toolsOf.set(o, e.tools) } });
const LONG_EVERY = Number(process.env.CRAWL_TURNS_LONG_EVERY || 2), LONG_BYTES = Number(process.env.CRAWL_TURNS_LONG_BYTES || 4096);
let k = 0;
for (const ts of toolsOf.values()) {
  if (k++ % LONG_EVERY) continue;
  for (const t of ts) { let d = t.description; while (d.length < LONG_BYTES) d += ` ${t.description} param${d.length} returns json`; t.description = d; }
}
for (let b = 0; b < 4; b++) {
  const o = origins[b * 7 + 1], t = toolsOf.get(o), big = [];
  for (let j = 0; j < 4500; j++) big.push({ ...t[j % t.length], route: `/api/big-${j}`, slug: `big-${j}` });
  toolsOf.set(o, big);
}
const cache = idx._cacheForTests();
const now = Date.now();
for (const o of origins) cache.set(o, { manifest: { name: o, homepage: o }, tools: toolsOf.get(o), fetchedAt: now - 3_600_000, error: null, history: [1, 1, 1], source: "manifest" });
// The warm start's indexing is done before anything is measured.
while (idx._routeIndexStatsForTest().pending || idx._routeIndexStatsForTest().partial) await new Promise((r) => setImmediate(r));
await idx._routeIndexSettledForTest();
const total = [...toolsOf.values()].reduce((a, t) => a + t.length, 0);
ok(cache.size === SELLERS && total > 100_000, `control: a production-sized index (${cache.size} sellers, ${total} tools)`);

// ---- stub reads: each origin's manifest lists its tools, a changed version
// each cycle (so every origin is read and derived again), answered later.
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
let ver = 0;
// Reads answer together, a batch every 15 ms, as a busy network hands one
// poll phase every crawl whose response arrived meanwhile: the condition that
// stacked 25 crawls' synchronous work into one loop iteration.
let landing = [];
const lander = setInterval(() => { const go = landing; landing = []; for (const r of go) r(); }, 15);
const landTogether = () => new Promise((r) => landing.push(r));
idx.__setCrawlFetchForTest(async (url, opts) => {
  const u = new URL(url);
  await landTogether();
  // Every crawl also asks for /openapi.json, and the 404s land together too.
  if (u.pathname !== "/.well-known/x402") throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  const etag = `"m-${u.host}-${ver}"`;
  if (opts?.allowNotModified && opts?.validators?.etag === etag) return { notModified: true, finalUrl: url, validators: { etag } };
  const body = JSON.stringify({ x402Version: 2, name: u.host, resources: toolsOf.get(u.origin).map((t) => ({ resource: `${u.origin}${t.route}`, method: t.method, description: `${t.description} v${ver}`, price: "$0.005", accepts })) });
  return { html: body, finalUrl: url, validators: { etag } };
});
// The unpaid quote and paywall probes answer in the same batches.
idx.__setProbeFetchForTest(async () => { await landTogether(); return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } }); });
const ITEMS = 60_000;
idx.__setDiscoveryFetchForTest(async (url) => {
  await new Promise((r) => setTimeout(r, 2));
  const q = new URL(url).searchParams, limit = Number(q.get("limit") || 1000), offset = Number(q.get("offset") || 0);
  const items = [];
  for (let i = offset; i < Math.min(ITEMS, offset + limit); i++) {
    const o = origins[i % SELLERS];
    items.push({ resource: `${o}/api/r${i}`, type: "http", x402Version: 2, accepts: [{ ...accepts[0], resource: `${o}/api/r${i}`, description: `resource ${i} weather json` }], quality: { calls30d: i % 50, payers30d: i % 7 } });
  }
  return { items, pagination: { total: ITEMS, limit, offset } };
});

// ---- the measured runs ------------------------------------------------------
const results = [];
async function measured(label, fn) {
  _resetTurnsForTest();
  const meter = gapMeter(2);
  const t0 = Date.now();
  const value = await fn();
  const { worst, worstWall } = meter.stop();
  // The turns the [loop-lag] line would name for this run's window.
  const named = turnsDuring(t0, Date.now(), 3);
  results.push({ label, worst });
  console.log(`# ${label}: longest turn ${worst.toFixed(0)} ms (${OURS_READING}; wall ${worstWall.toFixed(0)} ms); longest named: ${named.join(", ") || "none over 20 ms"}`);
  return value;
}
// One crawl's store per loop iteration: an iteration counter (a setImmediate
// chain runs once per check phase) beside the cache's own store, so the
// count does not depend on the machine's speed.
let iteration = 0, counting = true;
const nextIteration = () => { iteration++; if (counting) setImmediate(nextIteration); };
setImmediate(nextIteration);
const storesIn = new Map();
const realSet = cache.set;
cache.set = function set(origin, v) { storesIn.set(iteration, (storesIn.get(iteration) || 0) + 1); return realSet.call(this, origin, v); };
await measured("discovery pass", () => idx.__discoverSourceForTest({ name: "Coinbase CDP Bazaar", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" }));
const c1 = await measured("crawl cycle 1", () => idx.__runCrawlCycleForTest());
ok(c1.crawled >= SELLERS, `control: the first cycle read every origin (${c1.crawled})`);
ver++;
// Past every revisit wait, so the second cycle reads (and derives) every origin again.
const realNow = Date.now;
Date.now = () => realNow() + 25 * 3_600_000;
const c2 = await measured("crawl cycle 2", () => idx.__runCrawlCycleForTest());
Date.now = realNow;
counting = false;
cache.set = realSet;
const mostStores = Math.max(...storesIn.values());
ok([...storesIn.values()].reduce((a, b) => a + b, 0) >= 2 * SELLERS, `control: both cycles stored their origins (${[...storesIn.values()].reduce((a, b) => a + b, 0)} stores over ${storesIn.size} loop iterations)`);
ok(mostStores <= 2, `no loop iteration stored more than two crawls' entries (most ${mostStores}): each crawl's derivation and store take a crawl-lane turn`);
ok(c2.crawled >= SELLERS, `control: the second cycle read every origin again (${c2.crawled})`);
ok(idx._cacheForTests().get(origins[3]).tools.some((t) => / v1$/.test(t.description)), "control: the second cycle stored the changed documents");
mpp.seedFromOrigins(origins.slice(0, 300), "x402-crawl");
const mppSeeds = mpp.mppIndexSnapshot().discoveredTotal;
await measured("MPP crawl", () => mpp.runMppCrawl());
ok(mppSeeds >= 300, `control: the MPP crawl had the dual-stack origins to probe (${mppSeeds})`);
// The save is reported, not bounded here: its slicing has its own suites
// (test-index-persist-slices-pg.js), and its turns are mostly the collector's.
await measured("index save", () => idx.persistIndexCacheAsync());
clearInterval(lander);

for (const r of results.filter((x) => x.label !== "index save")) ok(r.worst <= LIMIT.ms, `${r.label}: no turn held the loop past ${LIMIT.ms} ms (longest ${r.worst.toFixed(0)} ms)`);

// The crawl's steps are named spans: a stall inside one says which.
const src = await (await import("node:fs/promises")).readFile(new URL("../src/x402-index.js", import.meta.url), "utf8");
ok(/const manifestPass = async \(fn\) => \{ await crawlLaneTurn\(\); return laneSpan\(passSpan, fn\); \};/.test(src), "each manifest pass takes a crawl-lane turn and is a named span");
ok(/return laneSpan\("crawl-parse", \(\) => JSON\.parse\(text\)\);/.test(src), "a crawl's parse is a named span in its lane turn");

idx.stopCrawler?.();
mpp.stopMppCrawler?.();
console.log(`test-crawl-cycle-turns: ${n} passed`);
process.exit(0);
