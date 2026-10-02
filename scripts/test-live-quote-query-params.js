#!/usr/bin/env node
// A route that REQUIRES a query parameter answered our unpaid probe of the bare
// path with an input error, so its live 402 was never read: 2026-09-23, a
// seller's three `?url=` routes stayed Base-only while their 402s offered Base
// AND Solana, and the same origin's parameter-free routes were read fine.
// The probe now tries the route with placeholder values for the declared
// required query names first, then bare. Offline: fetch is stubbed;
// example.com resolves publicly so the SSRF guard is happy.
import assert from "node:assert/strict";

process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes } = await import("../src/x402-index.js");
const { probeTargetsFor, queryPlaceholderFor } = await import("../src/x402-live-quote.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.equal(a, b, m); };

const ORIGIN = "https://example.com";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const accepts = { x402Version: 2, accepts: [
  { scheme: "exact", network: "eip155:8453", payTo: "0xd01f18a13e8d84da238e2e0f18b4f81de5670dca", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
  { scheme: "exact", network: SOL, payTo: "DVepGE5Ft6Rznhmqg8GLsusVHSpruLwSnJnXiAT8y3Lu", amount: "1000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", maxTimeoutSeconds: 300, extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" } },
] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");

// The seller validates `url` before its paywall: bare -> 400, with url -> 402.
const seen = [];
const orig = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  seen.push(`${m} ${u.pathname}${u.search}`);
  const needsUrl = u.pathname === "/http-health";
  const status = m !== "GET" ? 405 : needsUrl && !u.searchParams.get("url") ? 400 : 402;
  return new Response(status === 402 ? "{}" : "missing url", { status, headers: status === 402 ? { "payment-required": header } : {} });
};

const row = (route, contract) => ({
  seller: "example.com", route, method: "GET", slug: route.slice(1), price: 0.001,
  networks: ["eip155:8453"],             // manifest says Base; never verified live
  ...(contract ? { requestContract: ["declared", contract] } : {}),
});

try {
  // --- 1. pure: targets
  const t1 = probeTargetsFor(ORIGIN, row("/http-health", { query: ["url"] }));
  eq(t1.length, 2, "a required query param gives two targets");
  eq(t1[0], "https://example.com/http-health?url=https%3A%2F%2Fexample.com", "placeholder first");
  eq(t1[1], "https://example.com/http-health", "bare fallback second");
  eq(probeTargetsFor(ORIGIN, row("/report")).length, 1, "no contract: bare only, as before");
  eq(probeTargetsFor(ORIGIN, row("/h", { header: ["X-Key"] })).length, 1, "a header-only contract adds nothing");
  eq(probeTargetsFor(ORIGIN, row("/q?url=https://a.test", { query: ["url"] })).length, 1, "a param the route already carries is left alone");
  eq(queryPlaceholderFor("domain"), "example.com", "domain placeholder");
  eq(queryPlaceholderFor("wat"), "test", "generic placeholder");

  // --- 2. the reported case: the live read now lands and unions Solana in
  const rows = [row("/http-health", { query: ["url"] }), row("/report")];
  await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
  ok(rows[0].networks.includes(SOL), "query route picks up the Solana accept");
  ok(rows[0].networks.includes("eip155:8453"), "manifest chain kept");
  ok(rows[0].networksVerifiedAt > 0, "row verified");
  ok(seen.includes("GET /http-health?url=https%3A%2F%2Fexample.com"), "probed with the placeholder");
  ok(!seen.includes("GET /http-health"), "no bare request once the placeholder answered");
  ok(rows[1].networks.includes(SOL) && seen.includes("GET /report"), "parameter-free route unchanged: bare, verified");
  ok(!seen.some((s) => s.startsWith("GET /report?")), "no invented query on a route that declares none");

  // --- 3. fallback: a seller that paywalls the bare path still gets read
  seen.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); seen.push(`${init.method || "GET"} ${u.pathname}${u.search}`);
    const status = u.search ? 400 : 402;   // refuses our placeholder, 402s bare
    return new Response("{}", { status, headers: status === 402 ? { "payment-required": header } : {} });
  };
  const fb = [row("/odd", { query: ["url"] })];
  await enrichLiveQuotes(fb, ORIGIN, { ignoreBudget: true });
  ok(fb[0].networks.includes(SOL), "bare fallback still learns the chains");
  ok(seen.includes("GET /odd"), "bare path tried after the placeholder failed");
} finally {
  globalThis.fetch = orig;
}
console.log(`test-live-quote-query-params: ${n} assertions ok`);
