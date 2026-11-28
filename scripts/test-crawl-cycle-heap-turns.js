#!/usr/bin/env node
// A whole crawl cycle on a large heap holds no long turn, and names what it
// cannot split.
//
// The other crawl-turn suites run on a heap of a few hundred megabytes, where
// a collection is short and a copy of a whole listing is cheap. On a server
// whose heap holds gigabytes of live rows the same stretches cost several
// times more, and the ones that are not spans name nothing in the [loop-lag]
// line. This suite grows the heap first (live row-shaped objects, 1.5 GB by
// default) and then drives every scheduled piece of a cycle through the real
// code, over stub sellers at a production-like size mix:
//   - a registry walked page by page and a second registry read in one fetch;
//   - three x402 crawl cycles (every origin read; every origin answering 304;
//     every origin changed), among them documents of several megabytes, long
//     operation lists, sellers with no manifest and registry-only sellers
//     listed past the tool cap;
//   - the MPP crawl, the reputation pass, the index save, and the readers a
//     cycle's stores invalidate (the snapshot, the row lists, the route index).
// Every main-thread turn of TURN_NOTE_MS or more is recorded with the phase,
// the named spans inside it (src/active-jobs.js: what the [loop-lag] line
// prints), the collector's reported pause (perf_hooks gc entries) and whether
// a full collection was marking at the time.
//
// WHAT THE LIST SHOWS. On this heap the long turns are the collector's: a
// full collection marks for about half a second, and while it does, V8 runs
// marking steps on this thread inside whichever turn allocates, a few
// milliseconds each, one after another, reported by no gc entry. Those turns
// are listed apart ("while marking") and not bounded here: nothing in the
// crawl's code ends them, only fewer or cheaper full collections would.
// Outside them the crawl's own work is what the pins hold:
//   - no turn of our own work passes a bound on the ours clock
//     (scripts/lib/ours-clock.js), and one past the naming threshold names a
//     span (a crawl turn) or its job (the save, the reputation pass);
//   - the probe-example walk, the payment-signal walk and the packing of an
//     OpenAPI seller's rows run over several lane slices (counted with every
//     step cut into its own slice, so the machine's speed does not decide it);
//   - what a long document stores, and the rows kept packed for a 304, are
//     the same whether its walks ran in slices or whole;
//   - a reader that runs between the turns of a cycle is handed whole entries
//     only (each row list one a store handed over), and between the turns of
//     a registry pass a seller's rows as they were or as the pass left them.
// CRAWL_HEAP_PROFILE=1 adds a sampling CPU profile and prints, for each
// recorded turn, the functions that filled it; CRAWL_HEAP_NODE_FLAGS passes
// flags to the run (--trace-gc prints each collection's marking time).
// The run is a child process, so the heap flags are this suite's alone.
// Mutation-checked: each of the three slices taken out, a pass that writes
// its part-built list to the entry, and a registry fold that publishes per
// page each fail it. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import "./lib/guard-dns-offline.js"; // the MPP probe's name checks answer from this process
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { PerformanceObserver } from "node:perf_hooks";
import { ownStoreEnv } from "./lib/own-stores.js";
import { bound, oursMs, OURS_READING } from "./lib/ours-clock.js";
import { buildRoutePerfFixture } from "./lib/route-perf-fixture.js";

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.CRAWL_HEAP_MB || 1536);
const DEADLINE_MS = Number(process.env.CRAWL_HEAP_DEADLINE_MS || 900_000);
const PROFILE = process.env.CRAWL_HEAP_PROFILE === "1";

// ---- the parent: one child with the heap this suite needs -------------------
if (process.env.CRAWL_HEAP_CHILD !== "1") {
  // The young generation is the size the server runs with (Dockerfile); the
  // old-space limit only has to hold the grown heap and the index.
  const flags = ["--expose-gc", "--max-semi-space-size=64", `--max-old-space-size=${Math.max(4096, HEAP_MB * 3)}`];
  for (const f of String(process.env.CRAWL_HEAP_NODE_FLAGS || "").split(" ").filter(Boolean)) flags.push(f); // a measurement's own flags (--trace-gc)
  const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url)], { stdio: "inherit", env: { ...process.env, CRAWL_HEAP_CHILD: "1", NODE_OPTIONS: "" } });
  const late = setTimeout(() => { console.error(`not ok - no outcome in ${DEADLINE_MS} ms`); child.kill("SIGKILL"); }, DEADLINE_MS);
  const code = await new Promise((r) => child.on("exit", (c, sig) => r(sig ? 1 : c)));
  clearTimeout(late);
  process.exit(code ?? 1);
}

Object.assign(process.env, ownStoreEnv("crawl-cycle-heap-turns"));
process.env.X402_INDEX_CRAWL = "off";
process.env.MPP_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "0";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
delete process.env.CRAWL_PARSE_WORKER;
const SELLERS = Number(process.env.CRAWL_HEAP_SELLERS || 3000);
const origins = Array.from({ length: SELLERS }, (_, i) => `https://seller${i}.example`);
// Sellers with no manifest: an OpenAPI alone, or only the registry's rows.
const OPENAPI_ONLY = ["https://openapi-only-a.example", "https://openapi-only-b.example"];
const REGISTRY_ONLY = ["https://registry-only-a.example", "https://registry-only-b.example"];
process.env.X402_INDEX_SEEDS = [...origins, ...OPENAPI_ONLY, ...REGISTRY_ONLY].join(",");
const dir = mkdtempSync(join(tmpdir(), "crawl-cycle-heap-turns-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(dir, "x402-index-cache.json");
process.env.MPP_INDEX_CACHE_FILE = join(dir, "mpp-index-cache.json");

const log = console.log;
const quiet = /^\[(x402-index|mpp-index)\] (live-402 quote|live-402 price|live-402 probe outcomes|cycle|persisted|unrecognized payment-ish|crawl (parse|walk) |fallback passes)/;
const lines = [];
console.log = (...a) => { lines.push(String(a[0])); if (!quiet.test(String(a[0]))) log(...a); };
const warn = console.warn;
console.warn = (...a) => { lines.push(String(a[0])); if (!quiet.test(String(a[0]))) warn(...a); };

// ---- the profile (the ranked list's "what ran"), started before the modules --
let profiler = null;
if (PROFILE) {
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 500 });
  const at = performance.now();
  await session.post("Profiler.start");
  profiler = { session, at };
}

const idx = await import("../src/x402-index.js");
const mpp = await import("../src/mpp-index.js");
const rep = await import("../src/seller-reputation.js");
const { turnsDuring, jobsDuring, runAsJob, TURN_NOTE_MS } = await import("../src/active-jobs.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); log(`ok - ${m}`); };
const within = (p, label) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no outcome in ${DEADLINE_MS} ms`)), DEADLINE_MS); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
const nextTurn = () => new Promise((r) => setImmediate(r));

// ---- the heap: live row-shaped objects, as an index and its derived maps are --
// Held on the global object: a module binding nothing reads again is not kept.
const ballast = globalThis.__crawlHeapBallast = [];
{
  const t0 = Date.now();
  let i = 0;
  const grown = () => v8.getHeapStatistics().used_heap_size / MB;
  while (grown() < HEAP_MB) {
    const block = new Array(50_000);
    for (let j = 0; j < block.length; j++, i++) {
      block[j] = { route: `/api/ballast/${i}`, method: i % 2 ? "POST" : "GET", description: `row ${i} `.repeat(12), price: `$0.0${i % 9}`, tags: [`t${i % 97}`, `u${i % 89}`], accepts: { network: "eip155:8453", amount: String(1000 + (i % 9000)) } };
    }
    ballast.push(block);
  }
  globalThis.gc(); globalThis.gc();
  log(`# heap grown to ${grown().toFixed(0)} MB of live objects (${i} rows) in ${Date.now() - t0} ms`);
  ok(grown() >= HEAP_MB * 0.95, `control: the heap holds ${grown().toFixed(0)} MB of live objects before anything is measured`);
}

// The bounds. A turn on this heap carries the collector's work for it, so the
// bound is wider than the small-heap suites' and scales with the same baseline.
const LIMIT = bound(Number(process.env.CRAWL_HEAP_TURN_MS || 150), 8);
// A turn this long must say what it was: a named span inside it.
const NAMED = bound(Number(process.env.CRAWL_HEAP_NAMED_MS || 60), 3);
log(`# ${SELLERS} sellers on a ${HEAP_MB} MB heap; ${LIMIT.note}; named from ${NAMED.ms} ms`);

// ---- documents ---------------------------------------------------------------
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
/** An OpenAPI document of about `bytes`, dense in small objects and distinct keys. */
function denseOpenapi(bytes) {
  const parts = ['{"openapi":"3.1.0","info":{"title":"Stub","version":"1"},"paths":{'];
  let len = parts[0].length, i = 0;
  while (len < bytes - 2048) {
    const u = i.toString(36);
    let props = "";
    for (let j = 0; j < 24; j++) props += `${j ? "," : ""}"f${u}_${j}":{"type":"string","x${u}${j}":${j}}`;
    const op = `${i ? "," : ""}"/api/tool-${i}":{"post":{"operationId":"tool${i}","summary":"Tool ${i}","description":"Rows for query ${i}.","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"},"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{${props}}},"example":{"q":"alpha ${i}"}}}},"responses":{"200":{"description":"ok"},"402":{"description":"Payment Required"}}}}`;
    parts.push(op); len += op.length; i++;
  }
  parts.push("}}");
  return parts.join("");
}
/** An OpenAPI document holding many small priced operations (a long row list). */
function manyOperations(count) {
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(`"/p/${i}":{"${i % 2 ? "post" : "get"}":{"summary":"P ${i}","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"}}}`);
  return `{"openapi":"3.1.0","info":{"title":"Stub","version":"1"},"paths":{${parts.join(",")}}}`;
}

// The index: the router perf pin's prod-sized fixture; one seller in three
// writes long descriptions, a few list thousands of tools.
const toolsOf = new Map();
buildRoutePerfFixture({ sellers: SELLERS, toolsTarget: SELLERS * 33, cache: { set: (o, e) => toolsOf.set(o, e.tools) } });
{
  let k = 0;
  for (const ts of toolsOf.values()) {
    if (k++ % 3) continue;
    for (const t of ts) { let d = t.description; while (d.length < 1024) d += ` ${t.description} param${d.length} returns json`; t.description = d; }
  }
  for (let b = 0; b < 4; b++) {
    const o = origins[b * 7 + 1], t = toolsOf.get(o), big = [];
    for (let j = 0; j < 4500; j++) big.push({ ...t[j % t.length], route: `/api/big-${j}`, slug: `big-${j}` });
    toolsOf.set(o, big);
  }
}
// What each origin serves, built before anything is measured so the stub's
// own work is not in a measured turn. `rev` changes a document cheaply.
const manifestBody = new Map(); // origin -> [text v0, text v1]
for (const o of origins) {
  const host = new URL(o).host;
  const doc = (ver) => JSON.stringify({ x402Version: 2, name: host, resources: toolsOf.get(o).map((t) => ({ resource: `${o}${t.route}`, method: t.method, description: ver ? `${t.description} v${ver}` : t.description, price: "$0.005", accepts })) });
  manifestBody.set(o, [doc(0), doc(1)]);
}
const openapiBody = new Map(); // origin -> text
const HEAVY = [[origins[5], denseOpenapi(3 * MB)], [origins[12], denseOpenapi(6 * MB)], [origins[19], denseOpenapi(12 * MB - 4096)], [origins[26], manyOperations(90_000)], [origins[33], manyOperations(20_000)]];
for (const [o, text] of HEAVY) openapiBody.set(o, text);
openapiBody.set(OPENAPI_ONLY[0], denseOpenapi(4 * MB));
openapiBody.set(OPENAPI_ONLY[1], manyOperations(40_000));
for (let i = 40; i < SELLERS; i += 37) openapiBody.set(origins[i], manyOperations(40 + (i % 400)));
const revised = (text, ver) => (ver ? `{"x-rev":${ver},${text.slice(1)}` : text);
log(`# documents: ${[...openapiBody.values()].filter((t) => t.length >= MB).map((t) => `${(t.length / MB).toFixed(1)} MB`).join(", ")} OpenAPI; ${openapiBody.size} OpenAPI sellers in all`);

const cache = idx._cacheForTests();
const seededAt = Date.now() - 3_600_000;
for (const o of origins) cache.set(o, { manifest: { name: o, homepage: o }, tools: toolsOf.get(o), fetchedAt: seededAt, error: null, history: [1, 1, 1], source: "manifest" });
while (idx._routeIndexStatsForTest().pending || idx._routeIndexStatsForTest().partial) await nextTurn();
await idx._routeIndexSettledForTest();
const total = [...toolsOf.values()].reduce((a, t) => a + t.length, 0);
ok(cache.size === SELLERS && total > SELLERS * 30, `control: a production-sized index (${cache.size} sellers, ${total} tools)`);

// ---- stub reads ----------------------------------------------------------------
let ver = 0, sameAsLast = false;
// Reads land in batches, as one poll phase hands over every response that
// arrived meanwhile: at most a crawl pool's worth (25) per loop iteration.
let landing = [];
const lander = setInterval(() => { for (const r of landing.splice(0, 25)) r(); }, 2);
const landTogether = () => new Promise((r) => landing.push(r));
const notFound = (url) => Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
idx.__setCrawlFetchForTest(async (url, opts) => {
  const u = new URL(url);
  await landTogether();
  const etag = `"d-${u.host}${u.pathname}-${ver}"`;
  let body;
  if (u.pathname === "/.well-known/x402") body = manifestBody.get(u.origin)?.[ver % 2];
  else if (u.pathname === "/openapi.json") { const t = openapiBody.get(u.origin); body = t ? revised(t, ver) : undefined; }
  if (body === undefined) throw notFound(url);
  if (sameAsLast && opts?.allowNotModified && opts?.validators?.etag === etag) return { notModified: true, finalUrl: url, validators: { etag } };
  return { html: body, finalUrl: url, validators: { etag } };
});
idx.__setProbeFetchForTest(async () => { await landTogether(); return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } }); });
// The registries: one walked a page at a time, one read whole. The pages are
// text, parsed by the module's own reader (a page of this size goes to the thread).
const ITEMS = Number(process.env.CRAWL_HEAP_REGISTRY_ITEMS || 60_000);
const registryItem = (i, o) => `{"resource":"${o}/api/r${i}","type":"http","x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"5000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0x000000000000000000000000000000000000dEaD","maxTimeoutSeconds":60,"resource":"${o}/api/r${i}","description":"resource ${i} weather json"}],"quality":{"calls30d":${i % 50},"payers30d":${i % 7}}}`;
const pages = new Map();
const WHOLE_LIST = (() => { const parts = []; for (let i = 0; i < ITEMS; i++) parts.push(registryItem(i + ITEMS, `https://listed${i % 800}.example`)); return `{"x402Version":2,"resources":[${parts.join(",")}]}`; })();
// A registry-only seller listed past the tool cap: its rows come from a second paged source.
const LONG_ROWS = 9000;
idx.__setDiscoveryBodyFetchForTest(async (url) => {
  await new Promise((r) => setTimeout(r, 2));
  const u = new URL(url);
  if (u.host === "whole-list.example") return { html: WHOLE_LIST };
  const limit = Number(u.searchParams.get("limit") || 1000), offset = Number(u.searchParams.get("offset") || 0);
  const count = u.host === "long-rows.example" ? LONG_ROWS * 2 : ITEMS;
  const key = `${u.host} ${offset} ${limit}`;
  if (!pages.has(key)) {
    const parts = [];
    for (let i = offset; i < Math.min(count, offset + limit); i++) parts.push(registryItem(i, u.host === "long-rows.example" ? REGISTRY_ONLY[i % 2] : origins[i % SELLERS]));
    pages.set(key, `{"items":[${parts.join(",")}],"pagination":{"total":${count},"limit":${limit},"offset":${offset}}}`);
  }
  return { html: pages.get(key) };
});
// ---- the recorder ---------------------------------------------------------------
// The clock the spans and jobs are stamped on (src/active-jobs.js reads
// Date.now, which the cycles below move a day ahead): a window read on the
// unmoved clock finds no span of a later cycle, so every turn of it read as
// naming nothing.
let shift = 0;
const epochOf = (t) => performance.timeOrigin + t + shift;
const gcs = []; // { at, ms, kind }
const gcObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push({ at: e.startTime, ms: e.duration, kind: e.detail?.kind }); });
gcObserver.observe({ entryTypes: ["gc"] });
const turns = []; // { phase, from, to, ms, wall, named, jobs }
let phase = "setup", recording = false;
{
  let last = performance.now(), lastOurs = oursMs();
  const iv = setInterval(() => {
    const now = performance.now(), c = oursMs();
    const wall = now - last, ms = Math.min(wall, c - lastOurs);
    if (recording && ms >= TURN_NOTE_MS) turns.push({ phase, from: last, to: now, ms, wall, named: turnsDuring(epochOf(last), epochOf(now), 4), jobs: jobsDuring(epochOf(last), epochOf(now)) });
    last = now; lastOurs = c;
  }, 1);
  iv.unref();
}
const phaseHeap = [];
async function measured(label, fn) {
  await new Promise((r) => setTimeout(r, 5));
  phase = label; recording = true;
  const t0 = Date.now();
  const value = await within(fn(), label);
  await new Promise((r) => setTimeout(r, 5)); // the last stretch ends in the microtasks that resolved it
  recording = false;
  const mine = turns.filter((t) => t.phase === label);
  const worst = mine.reduce((a, t) => Math.max(a, t.ms), 0);
  phaseHeap.push({ label, heapMb: v8.getHeapStatistics().used_heap_size / MB, rssMb: process.memoryUsage().rss / MB });
  log(`# ${label}: ${Date.now() - t0} ms; longest turn ${worst.toFixed(0)} ms (${OURS_READING}); turns of ${TURN_NOTE_MS} ms or more: ${mine.length}`);
  return value;
}

// ---- a reader beside the passes -------------------------------------------------
// Between any two turns of a pass a request may read the index. This reader
// runs every loop iteration while a cycle runs and checks each entry it is
// handed: an entry is whole (its tools a list whose rows all carry a route,
// its total matching), and a seller's row list is one of the lists a store
// handed the cache, never a mix of two.
const storedLists = new WeakSet();
const realSet = cache.set;
let stores = 0;
cache.set = function set(origin, v) { stores++; const r = realSet.call(this, origin, v); const kept = cache.get(origin); if (kept && Array.isArray(kept.tools)) storedLists.add(kept.tools); return r; };
for (const o of origins) { const e = cache.get(o); if (e) storedLists.add(e.tools); }
let reads = 0, halfStates = 0, firstHalf = null;
let reading = false, at = 0;
const watch = [origins[5], origins[12], origins[19], origins[26], origins[33], origins[1], origins[8], ...OPENAPI_ONLY, ...REGISTRY_ONLY];
function readOnce() {
  const o = at++ % 3 ? watch[at % watch.length] : origins[at % SELLERS];
  const e = cache.get(o);
  if (!e) return;
  reads++;
  const bad = (why) => { halfStates++; firstHalf ||= `${why} (${new URL(o).host.split(".")[0]})`; };
  if (e.error) return;
  if (!Array.isArray(e.tools)) return bad("tools is not a list");
  if (!storedLists.has(e.tools)) return bad("the row list is not one a store handed over");
  const step = Math.max(1, Math.floor(e.tools.length / 64));
  for (let i = 0; i < e.tools.length; i += step) { const t = e.tools[i]; if (!t || typeof t.route !== "string") return bad("a row without a route"); }
  if (e.toolsCapped && !(e.toolsTotal >= e.tools.length)) return bad("a cut list without its total");
  // The seller detail a request reads agrees with the entry it was built from.
  if (at % 1024 === 0) {
    const d = idx.sellerDetail(o);
    if (d && Number.isFinite(d.toolCount) && d.toolCount !== cache.get(o).tools.length && d.toolCount !== (cache.get(o).toolsTotal ?? -1)) return bad("the seller detail counts rows the entry does not hold");
  }
}
const reader = () => { if (!reading) return; try { readOnce(); } catch (e) { halfStates++; firstHalf ||= `reader threw: ${String(e?.message || e).slice(0, 120)}`; } setImmediate(reader); };
// The registry's rows for a seller are published once a pass has read every
// page: between the turns of a pass a reader holds the rows as they were.
const registryCounts = new Set();
let registryReads = 0;
const registryReader = () => { if (!reading) return; if (registryReads++ % 8 === 0) registryCounts.add(idx.__discoveryStateForTest().bazaarTools.get(REGISTRY_ONLY[0])?.length || 0); setImmediate(registryReader); };
const withRegistryReader = async (fn) => { reading = true; setImmediate(registryReader); try { return await fn(); } finally { reading = false; } };
const withReader = async (fn) => { reading = true; setImmediate(reader); try { return await fn(); } finally { reading = false; } };

// ---- the cycle --------------------------------------------------------------------
const realNow = Date.now;
Date.now = () => realNow() + shift;
const nextDay = () => { shift += 25 * 3_600_000; };

// A failure in a phase is raised after the list is printed: the list is the evidence.
let phaseFailure = null;
try {
await measured("discovery (paged registry)", () => runAsJob("x402-index-discovery", () => idx.__discoverSourceForTest({ name: "Coinbase CDP Bazaar", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" })));
await measured("discovery (paged registry, long sellers)", () => withRegistryReader(() => runAsJob("x402-index-discovery", () => idx.__discoverSourceForTest({ name: "Long rows", url: "https://long-rows.example/resources", paginate: true, synthesizeTools: true }))));
ok(registryReads > 20 && [...registryCounts].every((c) => c === 0 || c === LONG_ROWS), `a reader between the turns of a registry pass saw a seller's rows as they were or as the finished pass left them (${[...registryCounts].join(", ")} rows over ${registryReads} turns)`);
await measured("discovery (whole-list registry)", () => runAsJob("x402-index-discovery", () => idx.__discoverSourceForTest({ name: "Whole list", url: "https://whole-list.example/resources", synthesizeTools: true })));
const disc = idx.__discoveryStateForTest();
ok(disc.bazaarTools.get(REGISTRY_ONLY[0])?.length >= LONG_ROWS && disc.status.get("Whole list")?.resources === ITEMS, `control: the registries were read (${disc.status.get("Coinbase CDP Bazaar")?.resources} paged rows, ${ITEMS} in one list of ${(WHOLE_LIST.length / MB).toFixed(1)} MB, ${disc.bazaarTools.get(REGISTRY_ONLY[0])?.length} rows for one registry-only seller)`);

const cycle = (label) => measured(label, () => withReader(() => runAsJob("x402-index-crawl", () => idx.__runCrawlCycleForTest())));
const c1 = await cycle("crawl cycle 1 (every document read)");
ok(c1.crawled >= SELLERS + 4, `control: the first cycle read every origin (${c1.crawled})`);
ok(cache.get(origins[19])?.tools?.length > 1000 && cache.get(OPENAPI_ONLY[0])?.tools?.length > 1000 && cache.get(REGISTRY_ONLY[0])?.tools?.length >= 5000, `control: the long documents were indexed (${cache.get(origins[19])?.tools?.length}, ${cache.get(origins[26])?.tools?.length}, ${cache.get(OPENAPI_ONLY[0])?.tools?.length} and ${cache.get(REGISTRY_ONLY[0])?.tools?.length} rows kept)`);
const afterFirst = { big: cache.get(origins[19]).tools.length, many: cache.get(origins[26]).tools.length };
nextDay(); sameAsLast = true;
const c2 = await cycle("crawl cycle 2 (every document unchanged)");
ok(c2.crawled >= SELLERS, `control: the second cycle read every origin again (${c2.crawled})`);
ok(cache.get(origins[19]).tools.length === afterFirst.big && cache.get(origins[26]).tools.length === afterFirst.many, "control: an unchanged document keeps its rows");
nextDay(); sameAsLast = false; ver = 1;
const c3 = await cycle("crawl cycle 3 (every document changed)");
ok(c3.crawled >= SELLERS && cache.get(origins[4]).tools.some((t) => / v1$/.test(t.description)), `control: the third cycle stored the changed documents (${c3.crawled})`);
ok(stores >= 3 * SELLERS, `control: the cycles stored their origins (${stores} stores)`);
// The recorder reads spans on the clock they are stamped on: a day ahead, a
// span timed now is found in the window that holds it.
{
  const { timeSpan } = await import("../src/active-jobs.js");
  const from = performance.now();
  timeSpan("recorder-clock-check", () => { const end = performance.now() + TURN_NOTE_MS + 5; while (performance.now() < end) { /* a span long enough to be kept */ } });
  const seen = turnsDuring(epochOf(from), epochOf(performance.now()), 64);
  ok(shift > 0 && seen.some((x) => x.startsWith("recorder-clock-check ")), `with the clock moved ahead the recorder still finds a span inside its window (${seen.join(", ") || "nothing"})`);
}

// ---- sliced and whole: the same entry ------------------------------------------
// The long documents again, on origins of their own: once with every laned
// walk in slices (as the cycles above ran) and once with each run whole in
// one turn. What is stored, and the rows kept packed for a 304, are the same.
{
  const { gunzipSync } = await import("node:zlib");
  const stored = (entry, origin) => JSON.stringify({
    tools: entry?.tools, toolsTotal: entry?.toolsTotal, error: entry?.error, discoveryPath: entry?.discoveryPath, openapiSummary: entry?.openapiSummary, source: entry?.source,
    packed: Buffer.isBuffer(entry?.openapiPacked) ? gunzipSync(entry.openapiPacked).toString("utf8") : null,
  }, (k, v) => (/(At|Until)$/.test(k) && typeof v === "number" ? 0 : v)).replaceAll(origin, "https://ORIGIN").replaceAll(new URL(origin).host, "ORIGIN");
  let same = 0, rows = 0, packedBytes = 0;
  // Counted per walk, in slices: a count does not depend on the machine's speed.
  const slices = new Map(), wholes = new Map();
  let counting = slices;
  // Also per twin: each long document's own walks, not only the sum.
  const twinSlices = new Map(), twinWholes = new Map();
  const twinOf = (from) => { const m = /twin-(?:sliced|whole)-(\d+)\./.exec(String(from?.origin || "")); return m ? m[1] : null; };
  idx.__setCrawlWalkObserverForTest((name, from) => {
    counting.set(name, (counting.get(name) || 0) + 1);
    const k = twinOf(from);
    if (k !== null) { const m = counting === slices ? twinSlices : twinWholes; m.set(`${name} ${k}`, (m.get(`${name} ${k}`) || 0) + 1); }
  });
  // And a long document that prices nothing: the payment-signal walk reads all of it.
  const UNPRICED = "https://unpriced.example";
  openapiBody.set(UNPRICED, manyOperations(250_000).replaceAll(',"x-payment-info":{"price":"0.01","currency":"USDC","network":"base"}', ""));
  for (const [i, from] of [origins[19], origins[26], origins[33], OPENAPI_ONLY[0], OPENAPI_ONLY[1], UNPRICED].entries()) {
    const A = `https://twin-sliced-${i}.example`, B = `https://twin-whole-${i}.example`;
    for (const twin of [A, B]) {
      if (manifestBody.has(from)) manifestBody.set(twin, manifestBody.get(from).map((t) => t.replaceAll(from, twin)));
      openapiBody.set(twin, openapiBody.get(from));
    }
    // Every step of a laned walk its own slice: the count is then the walk's
    // steps, whatever this machine's speed (at the crawl's 10 ms slice it was
    // decided by whether one document's walk ran past 10 ms in this run).
    counting = slices;
    const sliceWas = idx.__setCrawlWalkSliceForTest(0);
    try { await within(idx.__crawlSellerForTest(A, {}), "sliced twin"); } finally { idx.__setCrawlWalkSliceForTest(sliceWas); }
    idx.__setCrawlWalksWholeForTest(true); counting = wholes;
    try { await within(idx.__crawlSellerForTest(B, {}), "whole twin"); } finally { idx.__setCrawlWalksWholeForTest(false); }
    const a = stored(cache.get(A), A), b = stored(cache.get(B), B);
    if (a !== b) { let at = 0; while (at < a.length && a[at] === b[at]) at++; assert.fail(`twin ${i}: the entries differ at character ${at}: ${a.slice(Math.max(0, at - 60), at + 80)} | ${b.slice(Math.max(0, at - 60), at + 80)}`); }
    same++; rows += cache.get(A)?.tools?.length || 0; packedBytes += cache.get(A)?.openapiPacked?.length || 0;
  }
  idx.__setCrawlWalkObserverForTest(null);
  const per = (m) => ["examples", "signal", "pack-rows", "rows", "routes"].map((k) => `${k} ${m.get(k) || 0}`).join(", ");
  ok(["examples", "signal", "pack-rows"].every((k) => (slices.get(k) || 0) > (wholes.get(k) || 0) && wholes.get(k) > 0), `the probe-example walk, the payment-signal walk and the packing of the rows each ran over several lane slices (${per(slices)}; run whole: ${per(wholes)})`);
  const unsliced = [...twinWholes.keys()].filter((k) => /^(examples|signal|pack-rows) /.test(k) && !((twinSlices.get(k) || 0) > twinWholes.get(k)));
  ok(twinWholes.size > 0 && unsliced.length === 0, `...each of those walks over each long document ran in more slices than whole (${unsliced.join(", ") || "all did"})`);
  ok(same === 6 && rows > 10_000 && packedBytes > 0, `the long documents store the same entry and the same packed rows whether their walks ran in slices or whole (${same} sellers, ${rows} rows)`);
}

mpp.seedFromOrigins(origins.slice(0, 300), "x402-crawl");
await measured("MPP crawl", () => mpp.runMppCrawl());
await measured("reputation pass", () => runAsJob("seller-reputation-pass", () => rep.reputationPassUnleased({ entries: () => idx.sellerEntriesForReputation() })));
await measured("reputation pass (second, record read back)", () => runAsJob("seller-reputation-pass", () => rep.reputationPassUnleased({ entries: () => idx.sellerEntriesForReputation() })));
const readerCtx = { baseUrl: "https://self.example", catalog: {}, prices: {}, network: "eip155:8453", toolCount: 0, walletName: "self" };
const readersRan = [];
await measured("readers after the cycle", async () => {
  const each = async (name, fn) => { await fn(); readersRan.push(name); };
  await each("route index", () => idx._routeIndexSettledForTest());
  await each("snapshot", () => idx.indexSnapshotAsync(readerCtx));
  await each("routable summaries", () => idx.warmRoutableSellerSummaries());
  await each("index rows", async () => { await idx.indexRowsReady({}); await idx._indexRowsSettledForTest(); });
  await each("tool list", () => idx.allIndexedToolsAsync({}));
  await each("categories", () => idx.indexedToolCategoriesAsync(""));
  await each("pay-to origins", () => idx.allPayToOriginsAsync());
  await each("pay-to prices", () => idx.allPayToPricesAsync());
  await each("market", () => idx.ecosystemMarket({}));
  await each("route queries", async () => { for (const q of ["weather forecast json", "convert csv to json", "token price quote"]) await idx.routeQueryAsyncInThread({ ...readerCtx, query: q }); });
});
ok(readersRan.length === 10, `control: the readers a cycle invalidates were rebuilt (${readersRan.join(", ")})`);
await measured("index save", () => runAsJob("x402-index-persist", () => idx.persistIndexCacheAsync()));
await measured("index save (second, unchanged)", () => runAsJob("x402-index-persist", () => idx.persistIndexCacheAsync()));
} catch (e) { phaseFailure = e; }
Date.now = realNow;
clearInterval(lander);
cache.set = realSet;
gcObserver.disconnect();

// ---- the ranked list ----------------------------------------------------------------
const gcIn = (t) => gcs.reduce((a, g) => a + Math.max(0, Math.min(t.to, g.at + g.ms) - Math.max(t.from, g.at)), 0);
for (const t of turns) t.gc = Math.min(t.ms, gcIn(t));
// MARKING. The pauses above are the collector's reported ones. While a full
// collection is marking (from its start, a gc entry of the incremental kind,
// to the pause that ends it), V8 also does marking work on this thread inside
// whatever turn allocates, in steps of a few milliseconds one after another;
// no gc entry reports those. A turn inside such a window is the collector's
// as much as ours, and is listed apart.
const { constants: PERF } = await import("node:perf_hooks");
const marking = []; // [from, to]
{
  let open = null;
  for (const g of [...gcs].sort((x, y) => x.at - y.at)) {
    if (g.kind === PERF.NODE_PERFORMANCE_GC_INCREMENTAL) { if (open === null) open = g.at; }
    else if (g.kind === PERF.NODE_PERFORMANCE_GC_MAJOR) { marking.push([open ?? g.at, g.at + g.ms]); open = null; }
  }
  if (open !== null) marking.push([open, Infinity]); // still marking when the last phase ended
}
for (const t of turns) t.marking = marking.some(([from, to]) => t.to >= from && t.from <= to);
let frames = null;
if (profiler) {
  const { profile } = await profiler.session.post("Profiler.stop");
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const parent = new Map();
  for (const nd of profile.nodes) for (const c of nd.children || []) parent.set(c, nd.id);
  const label = (nd) => { const f = nd.callFrame; const file = String(f.url || "").split("/").slice(-1)[0]; return `${f.functionName || "(anonymous)"}${file ? ` ${file}:${f.lineNumber + 1}` : ""}`; };
  const ownerOf = new Map(); // node id -> the deepest frame in src/
  const owner = (id) => {
    if (ownerOf.has(id)) return ownerOf.get(id);
    let cur = id, found = null;
    while (cur != null) { const nd = byId.get(cur); if (/\/src\/[^/]+\.js$|\/src\/tools\//.test(nd.callFrame.url || "")) { found = label(nd); break; } cur = parent.get(cur); }
    ownerOf.set(id, found || "(outside src)");
    return ownerOf.get(id);
  };
  // Sample times on the performance.now() clock: both clocks are monotonic, a fixed offset apart.
  const offset = profile.startTime / 1000 - profiler.at;
  const samples = [];
  let ts = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) { ts += profile.timeDeltas[i]; samples.push({ at: ts / 1000 - offset, id: profile.samples[i] }); }
  frames = (t) => {
    const own = new Map(), leaf = new Map();
    let lo = 0, hi = samples.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].at < t.from) lo = mid + 1; else hi = mid; }
    let count = 0;
    for (let i = lo; i < samples.length && samples[i].at <= t.to; i++) {
      count++;
      const nd = byId.get(samples[i].id);
      own.set(owner(nd.id), (own.get(owner(nd.id)) || 0) + 1);
      leaf.set(label(nd), (leaf.get(label(nd)) || 0) + 1);
    }
    const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, c]) => `${name} ${Math.round((c / Math.max(1, count)) * 100)}%`).join("; ");
    return { own: top(own, 3), leaf: top(leaf, 3) };
  };
}
const ranked = [...turns].sort((a, b) => b.ms - a.ms);
log(`# turns of ${TURN_NOTE_MS} ms or more: ${turns.length}; the longest ${Math.min(ranked.length, Number(process.env.CRAWL_HEAP_RANK || 25))}:`);
for (const t of ranked.slice(0, Number(process.env.CRAWL_HEAP_RANK || 25))) {
  const f = frames ? frames(t) : null;
  log(`#   ${t.ms.toFixed(0)} ms (collector pause ${t.gc.toFixed(0)} ms${t.marking ? ", while marking" : ""}) | ${t.phase} | named: ${t.named.join(", ") || "nothing"}${f ? ` | in: ${f.own} | leaf: ${f.leaf}` : ""}`);
}
// Grouped: which stretch, how often, how long at most.
{
  const groups = new Map();
  for (const t of turns) {
    const f = frames ? frames(t).own.split(";")[0].replace(/ \d+%$/, "") : (t.named[0] || "nothing named").replace(/ \d+ms$/, "").replace(/(crawl-manifest-passes) .*/, "$1");
    const key = `${t.phase} | ${t.marking ? "while marking" : "no collection"} | ${f}`;
    const g = groups.get(key) || { count: 0, worst: 0, sum: 0, gc: 0 };
    g.count++; g.sum += t.ms; g.gc += t.gc; if (t.ms > g.worst) g.worst = t.ms;
    groups.set(key, g);
  }
  log("# by phase and stretch (count, longest, total, collector share):");
  for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].worst - a[1].worst).slice(0, 40)) log(`#   ${g.count}x longest ${g.worst.toFixed(0)} ms total ${g.sum.toFixed(0)} ms collector ${Math.round((g.gc / Math.max(1, g.sum)) * 100)}% | ${key}`);
}
{
  const major = gcs.filter((g) => g.kind === 4 || g.kind === 2), minor = gcs.filter((g) => g.kind === 1);
  const sum = (a) => a.reduce((x, g) => x + g.ms, 0), max = (a) => a.reduce((x, g) => Math.max(x, g.ms), 0);
  log(`# collector: ${minor.length} young collections (longest ${max(minor).toFixed(0)} ms, total ${sum(minor).toFixed(0)} ms), ${major.length} full (longest ${max(major).toFixed(0)} ms, total ${sum(major).toFixed(0)} ms), ${gcs.length - major.length - minor.length} marking steps (longest ${max(gcs.filter((g) => g.kind !== 1 && g.kind !== 4 && g.kind !== 2)).toFixed(0)} ms)`);
  for (const p of phaseHeap) log(`#   after ${p.label}: heap ${p.heapMb.toFixed(0)} MB, rss ${p.rssMb.toFixed(0)} MB`);
}

if (phaseFailure) throw phaseFailure;
// ---- the pins ------------------------------------------------------------------------
ok(reads > 1000 && halfStates === 0, `a reader between the turns of the cycles never saw a part-written entry (${reads} reads${firstHalf ? `; first: ${firstHalf}` : ""})`);
{
  const windows = marking.reduce((a, [from, to]) => a + (Number.isFinite(to) ? to - from : 0), 0);
  const inside = turns.filter((t) => t.marking), longest = inside.reduce((a, t) => Math.max(a, t.ms), 0);
  log(`# ${marking.length} full collections marked for ${windows.toFixed(0)} ms in all; ${inside.length} of the ${turns.length} recorded turns fell inside one (longest ${longest.toFixed(0)} ms, ${inside.reduce((a, t) => a + t.ms, 0).toFixed(0)} ms in all)`);
}
// Our own work: the turns no full collection was marking in.
const ours = turns.filter((t) => !t.marking);
for (const label of phaseHeap.map((p) => p.label)) {
  const worst = ours.filter((t) => t.phase === label).reduce((a, t) => (t.ms > (a?.ms || 0) ? t : a), null);
  ok(!worst || worst.ms - worst.gc <= LIMIT.ms, `${label}: outside a marking collection no turn held the loop past ${LIMIT.ms} ms (longest ${(worst?.ms || 0).toFixed(0)} ms${worst ? `, collector pause ${worst.gc.toFixed(0)} ms, named: ${worst.named.join(", ") || "nothing"}` : ""})`);
}
// A turn of our own work says what it was in the [loop-lag] line: a crawl's
// turn names a span (the job covers the whole cycle, so it says nothing about
// one turn); a turn of the save or the reputation pass names its job. The
// readers are requests, which the line names by route.
const unnamed = ours.filter((t) => t.ms - t.gc >= NAMED.ms && !t.named.length && !/^readers/.test(t.phase) && (/^(crawl cycle|discovery)/.test(t.phase) || !t.jobs.length));
ok(unnamed.length === 0, `every turn with ${NAMED.ms} ms or more of our own work names a span or its job (${unnamed.length} did not${unnamed[0] ? `; first: ${unnamed[0].ms.toFixed(0)} ms in ${unnamed[0].phase}` : ""})`);
// The walk and parse spans name no seller: a count or a kind only (the
// manifest passes' span is named with the host, as scripts/test-loop-lag.js pins).
const names = turns.flatMap((t) => t.named).filter((x) => !x.startsWith("crawl-manifest-passes ")).join(" ");
ok(!/\.example|https?:\/\//.test(names), "no walk or parse span name carries a seller's host or a URL");

idx.stopCrawler?.();
mpp.stopMppCrawler?.();
log(`test-crawl-cycle-heap-turns: ${n} passed`);
process.exit(0);
