// Unit tests for health-aware routing in the x402 Index.
//
// The router must not recommend tools from sellers whose last crawl errored —
// a buyer routed to a dead seller wastes money. We also tiebreak on health so
// a flaky-but-cheap seller loses to a reliable one when match scores are equal.
//
// Offline, no server, no network: seeds the in-memory cache directly via the
// _cacheForTests() escape hatch.
import { routeQuery, indexSnapshot, _cacheForTests } from "../src/x402-index.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

const cache = _cacheForTests();
cache.clear();

// Minimal local catalog so the router has a baseline to merge against.
const LOCAL = {
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "sha256" },
};
const PRICES = { hash: 0.001 };
const ctx = {
  baseUrl: "https://agent402.tools",
  catalog: LOCAL,
  prices: PRICES,
  network: "base",
  toolCount: 1,
  walletName: "agent402.base.eth",
};

// Helper: synthesise a remote seller's cache entry shaped like crawlSeller writes.
function seed(origin, { history, toolSlug, price = 0, error = null }) {
  cache.set(origin, {
    manifest: { name: origin.replace(/^https?:\/\//, ""), homepage: origin },
    openapiSummary: null,
    tools: [
      {
        seller: origin,
        method: "POST",
        route: `/api/${toolSlug}`,
        slug: toolSlug,
        name: toolSlug,
        description: "ocr a thing",
        category: "vision",
        tags: ["ocr"],
        price,
      },
    ],
    fetchedAt: Date.now(),
    error,
    history,
  });
}

// ---- 1. Unhealthy sellers are excluded from the router ----
seed("https://healthy.example", { history: [1, 1, 1, 1, 1], toolSlug: "ocr" });
seed("https://broken.example", { history: [1, 1, 0, 0, 0], toolSlug: "ocr", error: "ECONNREFUSED" });
{
  const r = routeQuery({ query: "ocr", top: 10, ...ctx });
  const sellers = r.results.map((x) => x.seller);
  ok(sellers.includes("https://healthy.example"), "healthy seller routed");
  ok(!sellers.includes("https://broken.example"), "broken seller excluded from router");
  ok(r.sellers === 1, `only 1 seller in results (got ${r.sellers})`);
}

// ---- 2. Brand-new sellers (no history yet) are routable — benefit of doubt ----
seed("https://newcomer.example", { history: [], toolSlug: "ocr" });
{
  const r = routeQuery({ query: "ocr", top: 10, ...ctx });
  const sellers = r.results.map((x) => x.seller);
  ok(sellers.includes("https://newcomer.example"), "never-crawled seller still routable");
}

// ---- 3. On score ties, healthier seller ranks first ----
cache.clear();
seed("https://flaky.example", { history: [1, 0, 1, 0, 1], toolSlug: "ocr", price: 0 }); // health 0.6
seed("https://solid.example", { history: [1, 1, 1, 1, 1], toolSlug: "ocr", price: 0 }); // health 1.0
{
  const r = routeQuery({ query: "ocr", top: 5, ...ctx });
  const remote = r.results.filter((x) => x.seller !== "self");
  ok(remote.length === 2, `both remote sellers ranked (got ${remote.length})`);
  ok(remote[0].seller === "https://solid.example", `healthier seller first (got ${remote[0].seller})`);
  ok(remote[0].health === 1, "solid seller health = 1");
  ok(remote[1].health < 1, "flaky seller health < 1");
}

// ---- 4. Cheapest still wins when both sellers are equally healthy ----
cache.clear();
seed("https://pricey.example", { history: [1, 1, 1], toolSlug: "ocr", price: "$0.05" });
seed("https://cheap.example", { history: [1, 1, 1], toolSlug: "ocr", price: 0 });
{
  const r = routeQuery({ query: "ocr", top: 5, ...ctx });
  const remote = r.results.filter((x) => x.seller !== "self");
  ok(remote[0].seller === "https://cheap.example", `cheapest wins on equal health (got ${remote[0].seller})`);
}

// ---- 5. indexSnapshot exposes health, routable, history per seller ----
cache.clear();
seed("https://healthy.example", { history: [1, 1, 1], toolSlug: "ocr" });
seed("https://dead.example", { history: [1, 0, 0], toolSlug: "ocr", error: "boom" });
{
  const snap = indexSnapshot(ctx);
  const healthy = snap.sellers.find((s) => s.origin === "https://healthy.example");
  const dead = snap.sellers.find((s) => s.origin === "https://dead.example");
  ok(healthy && healthy.health === 1 && healthy.routable === true, "healthy seller snapshot");
  ok(dead && dead.routable === false, "dead seller marked non-routable");
  ok(dead.health < 1, `dead seller health < 1 (got ${dead.health})`);
  ok(Array.isArray(healthy.history) && healthy.history.length === 3, "history surfaced");
  ok(snap.totals.routable === 2, `routable count = self + 1 healthy (got ${snap.totals.routable})`);
  ok(snap.totals.unhealthy === 1, `unhealthy count = 1 (got ${snap.totals.unhealthy})`);
}

// ---- 6. Empty query short-circuits without consulting the cache ----
{
  const r = routeQuery({ query: "", top: 5, ...ctx });
  ok(r.count === 0 && r.results.length === 0, "empty query returns nothing");
}

cache.clear();
console.log("test-router-health: 6 scenarios, all passed");
