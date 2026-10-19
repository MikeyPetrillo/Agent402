#!/usr/bin/env node
// Registry discovery folds each page as it arrives instead of holding the
// whole registry.
//
// A paginated registry walk used to collect every page of every listing into
// one array and only then build the per-origin tool and quality maps, so the
// raw listings of the largest registry were all alive at once. The walk now
// folds each page into the pass's accumulators and drops it. What a pass
// publishes must not change, so this test:
//   1. replays the previous implementation (copied below, verbatim apart from
//      writing into local maps) on the same stub registries and requires the
//      published maps, seeds, cache entries and status to be identical;
//   2. fails a walk part-way through and requires the published state to be
//      exactly what the last good pass left (no origin replaced, no new seed);
//   3. measures peak live heap for both paths over a large registry in fresh
//      processes and requires the streaming path to hold materially less.
// Offline: the discovery fetcher is replaced through its test seam.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.X402_INDEX_CRAWL = "off";
const dir = mkdtempSync(join(tmpdir(), "discovery-streaming-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");

const idx = await import("../src/x402-index.js");
const {
  __setDiscoveryFetchForTest, __discoverSourceForTest, __discoveryStateForTest, __discoveryHelpersForTest,
  __testSeedCache, _cacheForTests, bazaarItemToTool, foldBazaarQuality, itemHasMainnetAccept, isJunkOrigin,
  synthManifestFromBazaar,
} = idx;
const { isBazaarDiscoveryUrl } = await import("../src/bazaar-pager.js");

// ---------------------------------------------------------------- stub registry
// Items are generated from their index, so the stub holds no corpus of its own
// and both implementations read byte-identical pages.
const SHARED = "https://shared.stubreg.xyz";
const PATH_SELLER = `${SHARED}/app1`;
const SELF = "https://self.stubreg.xyz";
const hex = (n, len = 40) => n.toString(16).padStart(len, "0").slice(-len);
function makeItem(i, { version = 1, origins = 3000 } = {}) {
  const o = i % origins;
  let resource = `https://s${o}.stubreg.xyz/api/tool${i % 37}/${i}`;
  if (o === 7) resource = `${PATH_SELLER}/op${i}`; // under the path seller's prefix
  if (o === 8) resource = `${SHARED}/other/op${i}`; // same host, outside the prefix
  if (o === 9) resource = `${SELF}/api/x${i}`; // our own origin: skipped
  if (o === 10) resource = "not a url";
  if (o === 11) resource = `https://junk${i % 3}.example.com/r${i}`; // placeholder host (strict drops)
  const testnetOnly = o === 12;
  const net = testnetOnly ? "eip155:84532" : (i % 5 === 0 ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" : "eip155:8453");
  const item = {
    resource,
    type: "http",
    x402Version: 2,
    lastUpdated: `2026-10-0${1 + (i % 9)}T00:00:00Z`,
    description: `v${version} stub tool ${i} returns a structured answer for the request it is given`,
    tags: ["data", `t${i % 13}`],
    accepts: [{
      scheme: "exact",
      network: net,
      amount: String(1000 + (i % 50) * 100),
      payTo: `0x${hex(o * 7919 + (i % 3))}`,
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
      outputSchema: {
        input: { type: "http", method: "POST", bodyType: "json", bodyFields: { q: { type: "string", description: "the query to answer" }, limit: { type: "number", description: "how many results" } } },
        output: { type: "object", properties: { answer: { type: "string" }, sources: { type: "array", items: { type: "string" } }, id: { type: "string", description: `id-${i}` } } },
      },
    }],
    metadata: { provider: `provider-${o}`, notes: `generated row ${i} of the stub registry, padded to resemble a real listing's size` },
  };
  if (i % 4 !== 0) item.quality = { l30DaysTotalCalls: (i * 31) % 997, l30DaysUniquePayers: (i * 17) % 89, lastCalledAt: `2026-10-${String(1 + (i % 18)).padStart(2, "0")}T12:00:00Z` };
  if (i % 211 === 0) item.curated = true;
  return item;
}
// A Bazaar-shaped page endpoint over `total` generated items. `failAtOffset`
// makes the page at that offset fail the way a broken registry does.
function stubRegistry({ total, version = 1, failAtOffset = -1, origins = 3000, onFetch = null, extra = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit")), offset = Number(u.searchParams.get("offset"));
    if (onFetch) onFetch(offset);
    if (offset === failAtOffset) throw Object.assign(new Error("Upstream returned HTTP 502"), { statusCode: 502 });
    const items = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) items.push(makeItem(i, { version, origins }));
    if (extra && offset === 0) items.push(...extra);
    // Parsed from text, as the real fetcher does.
    return JSON.parse(JSON.stringify({ x402Version: 2, items, pagination: { limit, offset, total } }));
  };
}

// --------------------------------------------- the previous implementation
// Verbatim copy of the pre-streaming pager loop and discoverOneSource body,
// writing into `st` instead of the module's maps. The two optional hooks only
// let the heap child sample at the points where the old path held the most.
async function oldFetchAllBazaarItems(baseUrl, opts = {}, fetcher) {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 200;
  const items = [];
  let offset = 0;
  let total = null;
  for (let p = 0; p < maxPages; p++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}limit=${pageSize}&offset=${offset}`;
    const page = await fetcher(url);
    const pageItems = page?.items || page?.resources || (Array.isArray(page) ? page : []);
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    for (const it of pageItems) items.push(it);
    total = page?.pagination?.total ?? total;
    offset += pageItems.length;
    if (total != null && offset >= total) break;
    if (pageItems.length < pageSize) break;
  }
  return { items, total };
}
const { extractOrigin, pathSellersByHost, pathSellerOwning, rollHistory, MAX_DISCOVERED_SELLERS } = __discoveryHelpersForTest;
async function oldDiscoverOneSource(source, selfOrigin, fetcher, st, { onWalked = null, onFolded = null } = {}) {
  const status = { url: source.url, fetchedAt: Date.now(), resources: 0, origins: 0, error: null };
  try {
    let list;
    if (isBazaarDiscoveryUrl(source.url) || source.paginate) {
      const { items } = await oldFetchAllBazaarItems(source.url, { pageSize: 1000, maxPages: 200 }, fetcher);
      list = items;
    } else {
      const data = await fetcher(source.url);
      list = data.resources || data.items || data.data || (Array.isArray(data) ? data : []);
    }
    if (onWalked) onWalked();
    status.resources = list.length;
    const found = new Set();
    const synthesize = isBazaarDiscoveryUrl(source.url) || source.synthesizeTools === true;
    const toolsByOrigin = synthesize ? new Map() : null;
    const qualityByOrigin = toolsByOrigin ? new Map() : null;
    let droppedTestnet = 0, droppedJunk = 0;
    const pathSellers = pathSellersByHost();
    for (const item of list) {
      const url = item.resource || item.resourceUrl || item.url || item.endpoint || item.homepage;
      const hostOrigin = extractOrigin(url);
      if (!hostOrigin || hostOrigin === selfOrigin) continue;
      const origin = pathSellerOwning(url, hostOrigin, pathSellers) || hostOrigin;
      if (source.strict) {
        if (!itemHasMainnetAccept(item)) { droppedTestnet++; continue; }
        if (isJunkOrigin(origin)) { droppedJunk++; continue; }
      }
      found.add(origin);
      if (toolsByOrigin) {
        const t = bazaarItemToTool(item, origin);
        if (t) {
          const arr = toolsByOrigin.get(origin) || [];
          arr.push(t);
          toolsByOrigin.set(origin, arr);
        }
        if (qualityByOrigin && item.quality) foldBazaarQuality(qualityByOrigin, origin, item.quality, t?.payToByNetwork?.["eip155:8453"] || null, { curated: item.curated === true && isBazaarDiscoveryUrl(source.url) });
      }
    }
    if (onFolded) onFolded();
    if (toolsByOrigin) {
      for (const [o, arr] of toolsByOrigin) st.bazaarTools.set(o, arr);
      if (qualityByOrigin) for (const [o, q] of qualityByOrigin) st.bazaarQuality.set(o, q);
    }
    if (source.seedImmediately && toolsByOrigin) {
      for (const [o, arr] of toolsByOrigin) {
        const existing = st.cache.has(o) ? st.cache.get(o) : _cacheForTests().get(o);
        if (!existing || existing.error || existing.source === "bazaar-fallback") {
          st.cache.set(o, {
            ...(existing || {}),
            manifest: existing?.manifest || synthManifestFromBazaar(o, arr),
            tools: arr,
            fetchedAt: Date.now(),
            error: null,
            source: "bazaar-fallback",
            history: rollHistory(existing, true),
          });
        }
      }
    }
    status.origins = found.size;
    if (source.strict) { status.droppedTestnet = droppedTestnet; status.droppedJunk = droppedJunk; }
    for (const o of found) {
      if (st.discoveredSeeds.size >= MAX_DISCOVERED_SELLERS) break;
      st.discoveredSeeds.add(o);
    }
  } catch (e) {
    status.error = String(e.message || e);
  }
  st.status.set(source.name, status);
}

// Canonical form: every own key (symbols and non-enumerable ones included,
// since the quality object hides its per-wallet split that way), sorted.
function canon(v, seen = new WeakSet()) {
  if (v === null || typeof v !== "object") return typeof v === "symbol" ? v.toString() : v;
  if (seen.has(v)) return "[cycle]";
  seen.add(v);
  if (v instanceof Map) return ["Map", [...v.entries()].map(([k, x]) => [canon(k, seen), canon(x, seen)])];
  if (v instanceof Set) return ["Set", [...v].map((x) => canon(x, seen))];
  if (Array.isArray(v)) return v.map((x) => canon(x, seen));
  const out = {};
  for (const k of Reflect.ownKeys(v).map((k) => [typeof k === "symbol" ? k.toString() : k, k]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (k[1] === "fetchedAt") continue;
    out[k[0]] = canon(v[k[1]], seen);
  }
  return out;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ------------------------------------------------------------------ heap child
// A fresh process per path, so neither run inherits the other's garbage.
const mode = process.argv[2];
if (mode === "heap-old" || mode === "heap-new") {
  const total = Number(process.argv[3]);
  let peak = 0;
  const sample = () => { globalThis.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed); };
  globalThis.gc();
  const base = process.memoryUsage().heapUsed;
  const source = { name: "heap", url: "https://heap.stubreg.xyz/x402/discovery/resources" };
  const fetcher = stubRegistry({ total, onFetch: sample });
  if (mode === "heap-old") {
    const st = { bazaarTools: new Map(), bazaarQuality: new Map(), discoveredSeeds: new Set(), status: new Map(), cache: new Map() };
    await oldDiscoverOneSource(source, null, fetcher, st, { onWalked: sample, onFolded: sample });
    sample();
    process.stdout.write(JSON.stringify({ peak: peak - base, tools: [...st.bazaarTools.values()].reduce((n, a) => n + a.length, 0) }));
  } else {
    __setDiscoveryFetchForTest(fetcher);
    await __discoverSourceForTest(source, null);
    sample();
    const s = __discoveryStateForTest();
    process.stdout.write(JSON.stringify({ peak: peak - base, tools: [...s.bazaarTools.values()].reduce((n, a) => n + a.length, 0) }));
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ------------------------------------------------- 1. identical to the old fold
// Existing state the fold reads: a path seller on a shared host, an errored
// entry and a good manifest entry for origins a seeding registry lists.
__testSeedCache([
  [PATH_SELLER, { manifest: { name: "App one" }, tools: [], fetchedAt: 1, error: null, history: [1] }],
  ["https://s13.stubreg.xyz", { manifest: { name: "old" }, tools: [], fetchedAt: 1, error: "HTTP 500", history: [0] }],
  ["https://s14.stubreg.xyz", { manifest: { name: "Real manifest" }, tools: [{ route: "/x" }], fetchedAt: 1, error: null, history: [1] }],
]);
const SOURCES = [
  [{ name: "stub bazaar", url: "https://cdp.stubreg.xyz/x402/discovery/resources" }, { total: 70_000 }],
  [{ name: "stub open registry", url: "https://open.stubreg.xyz/discovery/resources", paginate: true, synthesizeTools: true, strict: true, seedImmediately: true }, { total: 9_500, version: 2, origins: 400 }],
  [{ name: "stub single page", url: "https://single.stubreg.xyz/resources" }, { total: 300, origins: 120 }],
];
const old = { bazaarTools: new Map(), bazaarQuality: new Map(), discoveredSeeds: new Set(), status: new Map(), cache: new Map() };
const before = __discoveryStateForTest();
ok(before.bazaarTools.size === 0 && before.discoveredSeeds.length === 0, "the module starts with no discovery state");
for (const [source, opts] of SOURCES) {
  const fetcher = source.paginate || isBazaarDiscoveryUrl(source.url)
    ? stubRegistry(opts)
    : (() => { const f = stubRegistry(opts); return async () => ({ resources: (await f(`${source.url}?limit=${opts.total}&offset=0`)).items }); })();
  await oldDiscoverOneSource(source, SELF, fetcher, old);
  __setDiscoveryFetchForTest(fetcher);
  await __discoverSourceForTest(source, SELF);
}
const now = __discoveryStateForTest();
const toolCount = [...now.bazaarTools.values()].reduce((n, a) => n + a.length, 0);
ok(toolCount > 60_000, `the stub registries produce a large tool map (${toolCount} tools over ${now.bazaarTools.size} origins)`);
ok(now.bazaarTools.has(PATH_SELLER) && now.bazaarTools.has(SHARED), "rows under the path seller's prefix are filed under it, the rest under the host");
ok(!now.bazaarTools.has(SELF), "our own origin is skipped");
ok(same(now.bazaarTools, old.bazaarTools), "published tool map is identical to the previous implementation's");
ok(same(now.bazaarQuality, old.bazaarQuality), "published quality map is identical, including the per-wallet split");
ok([...now.bazaarQuality.values()].some((q) => q.curated === true), "curated flags are folded from the Bazaar-shaped source");
ok(JSON.stringify(now.discoveredSeeds) === JSON.stringify([...old.discoveredSeeds]), `discovered seeds are identical and in the same order (${now.discoveredSeeds.length})`);
ok(same(now.status, old.status), `per-source status is identical (${JSON.stringify(now.status.get("stub open registry"))})`);
ok(now.status.get("stub open registry")?.droppedTestnet > 0 && now.status.get("stub open registry")?.droppedJunk > 0, "the strict source drops testnet-only and placeholder listings");
const seeded = [...old.cache.keys()];
ok(seeded.length > 0 && seeded.every((o) => same(_cacheForTests().get(o), old.cache.get(o))), `seeded cache entries are identical (${seeded.length} origins)`);
ok(_cacheForTests().get("https://s14.stubreg.xyz")?.manifest?.name === "Real manifest", "a good manifest entry is not clobbered by the registry seed");
ok(_cacheForTests().get("https://s13.stubreg.xyz")?.source === "bazaar-fallback", "an errored entry is replaced by the registry seed");

// --------------------------------------------- 2. a failed walk publishes nothing
{
  const source = SOURCES[1][0];
  const snapTools = __discoveryStateForTest();
  const snapCache = new Map([..._cacheForTests()].map(([k, v]) => [k, v]));
  const pagesFetched = [];
  // A new pass where every listing changed and new origins appear on the early
  // pages, failing on the sixth page.
  __setDiscoveryFetchForTest(stubRegistry({ total: 9_500, version: 3, origins: 600, failAtOffset: 5_000, onFetch: (o) => pagesFetched.push(o) }));
  await __discoverSourceForTest(source, SELF);
  const after = __discoveryStateForTest();
  ok(pagesFetched.length === 6, `the walk stops at the failing page (${pagesFetched.length} pages asked for)`);
  ok(/502/.test(after.status.get(source.name)?.error || ""), `the source records the failure (${after.status.get(source.name)?.error})`);
  ok(same(after.bazaarTools, snapTools.bazaarTools), "no origin's tools are replaced by the pages read before the failure");
  ok(same(after.bazaarQuality, snapTools.bazaarQuality), "no origin's quality is replaced either");
  ok(JSON.stringify(after.discoveredSeeds) === JSON.stringify(snapTools.discoveredSeeds), "origins first seen on the pages before the failure are not seeded");
  ok(![..._cacheForTests().keys()].some((k) => !snapCache.has(k)) && [...snapCache].every(([k, v]) => _cacheForTests().get(k) === v), "no cache entry is seeded or replaced");
  ok([...after.bazaarTools.get("https://s20.stubreg.xyz") || []].every((t) => t.description.startsWith("v2 ")), "an origin listed on the early pages still holds the last good pass's rows");
}

// ------------------------------------------------------- 3. peak live heap
{
  const TOTAL = 70_000;
  const run = (m) => {
    const r = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), m, String(TOTAL)], { encoding: "utf8", maxBuffer: 1 << 20, env: process.env });
    try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { console.log(r.stdout, r.stderr); return null; }
  };
  const o = run("heap-old"), n = run("heap-new");
  const mb = (x) => (x / 1048576).toFixed(1);
  ok(o && n && o.tools === n.tools && n.tools > 60_000, `both paths build the same number of tools (${o?.tools} / ${n?.tools})`);
  ok(o && n && n.peak < o.peak * 0.6, `peak live heap over ${TOTAL} listings: previous ${o ? mb(o.peak) : "?"} MB, streaming ${n ? mb(n.peak) : "?"} MB`);
}

__setDiscoveryFetchForTest(null);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
