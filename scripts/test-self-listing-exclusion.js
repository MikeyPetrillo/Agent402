// The crawler discovers agent402.tools itself via the public Bazaar (we
// legitimately self-register there) and caches it exactly like any other
// third-party seller. Every aggregation function that reads that cache must
// exclude it, or our own tools/routes get listed as a competing "external"
// seller of themselves.
//
// The existing excludeOrigin/baseUrl match only works when the CURRENT
// instance's baseUrl happens to equal the crawled self-origin string
// ("https://agent402.tools") - true in real production, but NOT in CI, local
// dev, or preview deploys, where baseUrl defaults to a localhost/preview
// hostname. Measured live: a fresh boot with X402_SYNC_ON_START=false and an
// empty cache still lets the background crawler reach and cache the real
// agent402.tools within about a minute, so this is a real gap in any
// non-production environment, not a theoretical one.
//
// Offline, no server, no network: seeds the in-memory cache directly via the
// _cacheForTests() escape hatch (same pattern as test-router-health.js).
import { allIndexedTools, indexSnapshot, routableSellerSummaries, routeQuery, _cacheForTests, _resetFlatCacheForTest } from "../src/x402-index.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); else console.log("ok -", m); }

const cache = _cacheForTests();

function seedSelf(extra = {}) {
  cache.set("https://agent402.tools", {
    manifest: { name: "agent402.tools", homepage: "https://agent402.tools" },
    openapiSummary: null,
    tools: [
      { seller: "https://agent402.tools", method: "GET", route: "/api/dns", slug: "dns", name: "dns", description: "dns lookup", category: "network", tags: [], price: 0.001 },
    ],
    fetchedAt: Date.now(),
    error: null,
    originResponded: true,
    history: [1, 1, 1],
    ...extra,
  });
}

const LOCAL = {
  "GET /api/dns": { name: "DNS lookup", slug: "dns", category: "network", price: "$0.001", description: "dns lookup" },
};
const PRICES = { dns: 0.001 };

function baseCtx(baseUrl) {
  return { baseUrl, catalog: LOCAL, prices: PRICES, network: "base", toolCount: 1, walletName: "agent402.base.eth" };
}

// ---- Scenario A: baseUrl MATCHES the crawled self-origin (real production) ----
{
  cache.clear();
  _resetFlatCacheForTest();
  seedSelf();
  const ctx = baseCtx("https://agent402.tools");

  const flat = allIndexedTools({ ourTools: [], excludeOrigin: ctx.baseUrl });
  ok(!flat.results.some((t) => t.seller === "https://agent402.tools"), "allIndexedTools: matching baseUrl excludes self (production shape)");

  const snap = indexSnapshot(ctx);
  ok(!snap.sellers.some((s) => s.origin === "https://agent402.tools"), "indexSnapshot: matching baseUrl excludes self");

  const routable = routableSellerSummaries();
  ok(!routable.some((s) => s.origin === "https://agent402.tools"), "routableSellerSummaries: excludes self regardless of baseUrl");

  const routed = routeQuery({ query: "dns", top: 10, include: "external", ...ctx });
  ok(!routed.results.some((r) => r.seller === "https://agent402.tools"), "routeQuery: matching baseUrl excludes self from external candidates");
}

// ---- Scenario B: baseUrl MISMATCHES the crawled self-origin (CI / local dev / preview) ----
{
  cache.clear();
  _resetFlatCacheForTest();
  seedSelf();
  const ctx = baseCtx("http://127.0.0.1:3000");

  const flat = allIndexedTools({ ourTools: [], excludeOrigin: ctx.baseUrl });
  ok(!flat.results.some((t) => t.seller === "https://agent402.tools"), "allIndexedTools: mismatched baseUrl STILL excludes self (the real bug)");

  const snap = indexSnapshot(ctx);
  ok(!snap.sellers.some((s) => s.origin === "https://agent402.tools"), "indexSnapshot: mismatched baseUrl STILL excludes self");
  // totals.sellers counts local + remote together (local is always present,
  // origin "self") - it must stay at 1 here, not 2, or the crawled self-entry
  // is sneaking back in as a second "seller".
  ok(snap.totals.sellers === 1, `indexSnapshot: only the local entry counted, no duplicate remote self (got ${snap.totals.sellers})`);

  const routable = routableSellerSummaries();
  ok(!routable.some((s) => s.origin === "https://agent402.tools"), "routableSellerSummaries: mismatched baseUrl still excludes self");

  const routed = routeQuery({ query: "dns", top: 10, include: "external", ...ctx });
  ok(!routed.results.some((r) => r.seller === "https://agent402.tools"), "routeQuery: mismatched baseUrl STILL excludes self from external candidates (a buyer must never be routed to pay themselves)");
  ok(routed.sellers === 0, `routeQuery: zero external sellers for a query only the self-entry answers (got ${routed.sellers})`);
}

// ---- Scenario C: a genuine third party is never caught by the self-exclusion ----
{
  cache.clear();
  _resetFlatCacheForTest();
  seedSelf();
  cache.set("https://real-seller.example", {
    manifest: { name: "real-seller.example", homepage: "https://real-seller.example" },
    openapiSummary: null,
    tools: [{ seller: "https://real-seller.example", method: "GET", route: "/api/dns", slug: "dns", name: "dns", description: "dns lookup", category: "network", tags: [], price: 0.002 }],
    fetchedAt: Date.now(),
    error: null,
    originResponded: true,
    history: [1, 1, 1],
  });
  const ctx = baseCtx("http://127.0.0.1:3000");

  const routed = routeQuery({ query: "dns", top: 10, include: "external", ...ctx });
  ok(routed.results.some((r) => r.seller === "https://real-seller.example"), "routeQuery: a genuine third-party seller is still routed (self-exclusion isn't over-broad)");

  const routable = routableSellerSummaries();
  ok(routable.some((s) => s.origin === "https://real-seller.example"), "routableSellerSummaries: genuine third party still listed");
}

cache.clear();
_resetFlatCacheForTest();
// ---- The host's own /api/index answer (2026-08-28): built OUTSIDE the cache, never from it ----
{
  const { hostFigures, hostIndexEntry, isSelfSellerQuery } = await import("../src/host-entry.js");
  const summary = ({ days }) => ({ recordingSince: 1750000000000, totals: { external: { sales: days === 30 ? 109 : 3945 }, internal: { sales: 999 } }, distinctExternalBuyers: days === 30 ? 7 : 250, distinctToolsSoldExternal: 21 });
  const f = hostFigures({ summaryFn: summary, toolCount: 560, baseUrl: "https://agent402.tools" });
  const me = hostIndexEntry(f);
  ok(me.self === true && me.listed === true && me.external.days30.settlements === 109 && me.external.allTime.buyers === 250, "host index entry is self:true with external-only figures (internal 999 never appears)");
  ok(JSON.stringify(me).includes("999") === false, "internal settlements never leak into the host entry");
  ok(isSelfSellerQuery("agent402.tools", "https://agent402.tools") && isSelfSellerQuery("https://agent402.tools/", "https://x.test") && isSelfSellerQuery("x.test", "https://x.test") && !isSelfSellerQuery("a.example", "https://agent402.tools"), "self detection accepts the canonical host/origin and the instance's own base URL only");
  ok(hostFigures({}) === null && hostIndexEntry(null) === null, "no ledger -> no entry, never a fabricated zero row");
}
console.log("\ntest-self-listing-exclusion: all scenarios passed");
