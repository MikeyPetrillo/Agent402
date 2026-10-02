#!/usr/bin/env node
// A re-probed PRICED row kept its old price (issue #1460, 2026-09-23): the live
// 402 filled an empty price only, so a seller who re-registered at $0.005 still
// showed $0.003 on seven routes. Two rules pinned here offline:
//   1. a live 402 price replaces a held price that differs (logged, both figures);
//   2. an explicit re-registration re-asks every route whose held price differs
//      from the origin's declaration at all; the automatic crawl still waits for
//      a 2x drift.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes, adoptLivePrice, quoteProbeStatsSnapshot, probeFailureCode } = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const ORIGIN = "https://example.com"; // resolves: the SSRF guard checks the host before the stubbed fetch
const header = (amount) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] })).toString("base64");
const seen = [];
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
const orig = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); seen.push(`${init.method || "GET"} ${u.pathname}`);
  return new Response("{}", { status: 402, headers: { "payment-required": header("5000") } }); // $0.005 live
};
const row = (extra = {}) => ({ seller: "example.com", route: "/api/base/wallet-balance", method: "POST", slug: "wb", price: 0.003, networks: ["eip155:8453"], networksVerifiedAt: Date.now(), quoteSource: "live-402", quoteObservedAt: Date.now() - 60_000, ...extra });

try {
  // --- 1. pure
  const r = { route: "/x", price: 0.003 };
  adoptLivePrice(r, 0.005, ORIGIN);
  ok(r.price === 0.005, "a differing live price replaces the held one");
  ok(logs.some((l) => /live-402 price: .*\/x 0\.003 -> 0\.005/.test(l)), "and the correction is logged with both figures");
  logs.length = 0;
  const same = { route: "/y", price: "$0.005" };
  adoptLivePrice(same, 0.005, ORIGIN);
  ok(same.price === "$0.005" && !logs.length, "an equal price (even as a display string) is left alone, nothing logged");
  const gap = { route: "/z", price: null };
  adoptLivePrice(gap, 0.002, ORIGIN);
  ok(gap.price === 0.002, "an empty price is still filled");
  const keep = { route: "/w", price: 0.003 };
  adoptLivePrice(keep, null, ORIGIN);
  ok(keep.price === 0.003, "a live read with no usable price changes nothing");

  // --- 2. the reported case: declared $0.005, held $0.003 (1.67x), re-registered
  seen.length = 0;
  const rows = [row({ originDeclaredPrice: 0.005 })];
  await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
  ok(seen.length > 0, "an explicit re-registration re-asks a route under the 2x drift");
  ok(rows[0].price === 0.005, `and the live price lands (got ${rows[0].price})`);

  // --- control: the automatic crawl leaves a sub-2x gap alone (polite cadence)
  seen.length = 0;
  const auto = [row({ originDeclaredPrice: 0.005 })];
  await enrichLiveQuotes(auto, ORIGIN);
  ok(seen.length === 0 && auto[0].price === 0.003, "the automatic crawl does not re-ask a fresh quote under 2x");

  // --- 3. a STALE learned quote re-asked by the automatic crawl now takes the live price
  seen.length = 0;
  const stale = [row({ quoteObservedAt: Date.now() - 8 * 24 * 3600_000 })];
  await enrichLiveQuotes(stale, ORIGIN);
  ok(seen.length > 0 && stale[0].price === 0.005, `a stale quote is re-read AND corrected (got ${stale[0].price})`);

  // --- 4. probe outcomes are counted: a miss is filed under its first attempt
  const before = quoteProbeStatsSnapshot();
  globalThis.fetch = async () => new Response("bad input", { status: 422 });
  const miss = [row({ route: "/needs-body", price: null, quoteSource: undefined })];
  await enrichLiveQuotes(miss, ORIGIN, { ignoreBudget: true });
  const after = quoteProbeStatsSnapshot();
  ok(after.missed === before.missed + 1, "the miss is counted");
  ok((after.missByFirst["POST 422"] || 0) === (before.missByFirst["POST 422"] || 0) + 1, `filed under its first attempt (got ${JSON.stringify(after.missByFirst)})`);
  ok(after.learned >= 2, "learned reads are counted too");
  const te = new Error("x"); te.name = "TimeoutError";
  ok(probeFailureCode(te) === "timeout", "timeout classified");
  const re = new Error("fetch failed"); re.cause = { code: "ECONNRESET" };
  ok(probeFailureCode(re) === "reset", "connection reset classified");

  // --- 5. an UNPRICED GET route answering 200 is recorded free, and left alone
  const s0 = quoteProbeStatsSnapshot();
  seen.length = 0;
  globalThis.fetch = async (url, init = {}) => { seen.push(`${init.method || "GET"} ${new URL(String(url)).pathname}`); return new Response("{\"status\":\"ok\"}", { status: 200 }); };
  const free = [{ seller: "example.com", route: "/health", method: "GET", slug: "health", price: null, networks: [] }];
  await enrichLiveQuotes(free, ORIGIN, { ignoreBudget: true });
  ok(free[0].quoteSource === "live-200" && free[0].freeObservedAt > 0 && free[0].paid === false && free[0].price === null, "an unpriced GET 200 is stamped observed-free (price stays null, not 0)");
  const s1 = quoteProbeStatsSnapshot();
  ok(s1.free === s0.free + 1 && s1.missed === s0.missed, "counted as free, not as a miss");
  ok(!seen.includes("POST /health"), "no POST after a GET 200");
  seen.length = 0;
  await enrichLiveQuotes(free, ORIGIN);
  ok(seen.length === 0, "the automatic crawl leaves an observed-free route alone");
  await enrichLiveQuotes(free, ORIGIN, { ignoreBudget: true });
  ok(seen.length > 0, "a re-registration re-asks it");
  const { carryForwardLearnedQuotes } = await import("../src/x402-index.js");
  const carried = carryForwardLearnedQuotes([{ route: "/health", method: "GET", slug: "health", price: null }], { tools: free })[0];
  ok(carried.quoteSource === "live-200" && carried.freeObservedAt === free[0].freeObservedAt, "the observation survives the next crawl's rebuild");

  // --- 6. a 200 that is an ERROR page is not stamped free
  globalThis.fetch = async () => new Response(JSON.stringify({ state: "missing_x_agent_id", message: "x-agent-id header is required" }), { status: 200, headers: { "content-type": "application/json" } });
  const errRow = [{ seller: "example.com", route: "/flips/history", method: "GET", slug: "fh", price: null, networks: [] }];
  await enrichLiveQuotes(errRow, ORIGIN, { ignoreBudget: true });
  ok(errRow[0].quoteSource !== "live-200" && !errRow[0].freeObservedAt, "a 200 error body leaves the route price-unknown, not free");
} finally {
  globalThis.fetch = orig; console.log = origLog;
}
console.log(`test-live-price-adopt: ${n} assertions ok`);
