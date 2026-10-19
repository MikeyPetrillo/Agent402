// A change made outside a crawl reaches the other container (two module
// instances on one real Postgres, as in test-index-replicas-pg.js):
//   - a re-price through registerOrigin on A is served by B after one pull,
//     though the crawl stamp (fetchedAt) did not move;
//   - B's boot-time save never writes its older copy over that row;
//   - a boot holds the rows it read as unchanged, so its first save rewrites
//     nothing it did not change.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-reprice-replicas-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-index-reprice-replicas-pg" });

process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "index-reprice-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const COLLECTION = "x402-index";
// example.com: the SSRF guard's DNS check resolves it; every request is stubbed.
const X = "https://example.com";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A";
const row = (route) => ({ seller: X, route, method: "GET", slug: route.slice(1), price: null, paid: true });
const entry = { manifest: { x402Version: 1, name: "x" }, tools: [row("/a"), row("/b")], fetchedAt: 1_000, error: null, source: "crawl", history: [1], paywall: null, discoveryPath: null };

// The seller's live 402: $0.02 in Base USDC.
const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, amount: "20000", asset: BASE_USDC, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] })).toString("base64");
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== "example.com") return origFetch(url);
  return new Response("{}", { status: 402, headers: { "payment-required": header, "content-type": "application/json" } });
};
const priceOn = (m, route) => m.sellerDetail(X)?.tools?.find((t) => t.route === route)?.price ?? null;
const usd = (p) => (p == null ? null : Number(String(p).replace(/[^0-9.]/g, "")));

try {
  await sdb.records.put(COLLECTION, X, entry);
  const A = await import("../src/x402-index.js?container=a");
  const B = await import("../src/x402-index.js?container=b");
  await A.warmStartIndexFromStateDb(); await B.warmStartIndexFromStateDb();
  ok(priceOn(A, "/a") == null && priceOn(B, "/a") == null, "both containers start with the route unpriced");

  // The boot's first save writes nothing it read and did not change.
  const before = (await sdb.stateQuery(`SELECT updated_at::text AS t FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, [COLLECTION, X])).rows[0].t;
  await B.persistIndexCacheAsync();
  const after = (await sdb.stateQuery(`SELECT updated_at::text AS t FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, [COLLECTION, X])).rows[0].t;
  ok(before === after, `a boot's first save leaves an unchanged row alone (updated_at ${before} -> ${after})`);

  // A seller re-registers on A: the real re-price path (no document re-read).
  A.loadRemovedOrigins();
  for (let i = 0; i < 100 && !A.removalsKnown(); i++) await new Promise((res) => setTimeout(res, 20));
  const r = await A.registerOrigin(X, { crawl: async () => null });
  ok(r.listed === true && r.reverify?.routesRechecked === true, "A re-prices the origin through registerOrigin");
  ok(usd(priceOn(A, "/a")) === 0.02, `A serves the learned price (${priceOn(A, "/a")})`);
  const stored = await sdb.records.get(COLLECTION, X);
  ok(usd(stored?.tools?.find((t) => t.route === "/a")?.price) === 0.02, "the re-price is in the table");
  ok(stored?.fetchedAt === 1_000, "the crawl stamp did not move (nothing was crawled)");

  // B pulls once and serves it.
  await B.pullIndexChanges();
  ok(usd(priceOn(B, "/a")) === 0.02, `B serves A's re-price after one pull (${priceOn(B, "/a")})`);

  // A third container that booted before the re-price and saves its older
  // copy never writes it over the row.
  const C = await import("../src/x402-index.js?container=c");
  C.__testSeedCache([[X, { ...entry, tools: [row("/a"), row("/b")] }]]);
  // The single-origin write does not pull first, so only the upsert's own
  // revision guard stands between C's older copy and the row.
  await C.persistOriginToStateDb(X);
  const kept = await sdb.records.get(COLLECTION, X);
  ok(usd(kept?.tools?.find((t) => t.route === "/a")?.price) === 0.02, "an older copy with the same crawl stamp never replaces the re-priced row");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  globalThis.fetch = origFetch;
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-index-reprice-replicas-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
