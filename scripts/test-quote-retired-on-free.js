// A route that went FREE retires the price we learned for it (issue #1365,
// 2026-09-15). SIDERA Memory made GET /v1/sidera/discovery free on 09-13, re-
// registered on 09-15, and the index still said price 0.001 / paid:true: a
// priced row was never a probe candidate until its 7-day clock ran out, and
// even when probed a GET 200 was "noted, nothing learned", so the old quote
// stood. Three rules now, each pinned here offline against a stubbed fetch:
//   1. an explicit re-registration re-asks every priced row whose price is not
//      the origin's own declaration;
//   2. a GET 200 with no paywall on a GET row RETIRES a learned/snapshot price
//      (stamped live-200), never an origin-declared one, never a POST row;
//   3. the retirement is carried across the next crawl over a Bazaar-priced
//      rebuild, inside the quote window and for the exact verb only.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes, carryForwardLearnedQuotes } = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const ORIGIN = "https://example.com"; // resolves: the SSRF guard checks the host before the (stubbed) fetch
const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
const seen = [];
const stub = (rules) => async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  seen.push(`${m} ${u.pathname}`);
  const status = rules[`${m} ${u.pathname}`] ?? 404;
  const headers = new Headers(status === 402 ? { "payment-required": header, "content-type": "application/json" } : { "content-type": "application/json" });
  return new Response(status === 402 ? "{}" : JSON.stringify({ discovery_price_usdc: "0" }), { status, headers });
};
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
const orig = globalThis.fetch;
const learnedRow = (extra = {}) => ({ seller: "example.com", route: "/v1/discovery", method: "GET", slug: "discovery", price: 0.001, paid: true, networks: ["eip155:8453"], quoteSource: "live-402", quoteObservedAt: Date.now() - 60_000, networksVerifiedAt: Date.now() - 60_000, ...extra });

try {
  // --- 1 + 2. re-register: the priced learned row is re-asked; the GET 200 retires it
  globalThis.fetch = stub({ "GET /v1/discovery": 200 });
  const tools = [learnedRow()];
  await enrichLiveQuotes(tools, ORIGIN, { ignoreBudget: true });
  ok(seen.includes("GET /v1/discovery"), "an explicit re-registration re-asks a priced row whose price was learned (rule 1)");
  ok(tools[0].price === null && tools[0].paid === false, `a GET 200 with no paywall retires the learned price (got price ${tools[0].price}, paid ${tools[0].paid}) (rule 2)`);
  ok(tools[0].quoteSource === "live-200" && tools[0].quoteRetiredAt > 0, "the retirement is stamped live-200 with a time");
  ok(logs.some((l) => /live-200: .*\/v1\/discovery answered GET 200 with no paywall; retired the learned price 0.001/.test(l)), "and logged with the price it retired");

  // --- control: without the re-registration flag a fresh priced row is NOT a candidate (the 7-day clock still governs the automatic crawl)
  seen.length = 0;
  const auto = [learnedRow()];
  await enrichLiveQuotes(auto, ORIGIN);
  ok(!seen.includes("GET /v1/discovery") && auto[0].price === 0.001, "the automatic crawl leaves a fresh learned quote alone (budgeted, 7-day clock)");

  // --- an ORIGIN-DECLARED price is never retired by a 200
  seen.length = 0; logs.length = 0;
  const declared = [learnedRow({ originDeclaredPrice: 0.001, quoteSource: undefined })];
  await enrichLiveQuotes(declared, ORIGIN, { ignoreBudget: true });
  ok(declared[0].price === 0.001 && declared[0].paid === true, "a price the origin declares this crawl is the seller's own statement and stands");

  // --- a POST row's GET 200 says nothing about the POST
  seen.length = 0;
  globalThis.fetch = stub({ "GET /v1/orders": 200, "POST /v1/orders": 402 });
  const post = [learnedRow({ route: "/v1/orders", method: "POST", slug: "orders", price: 0.002 })];
  await enrichLiveQuotes(post, ORIGIN, { ignoreBudget: true });
  // Priced from the POST's own 402 ($0.001 in this stub; since #1460 a live
  // quote replaces a differing held price), never retired by the GET 200.
  ok(post[0].price === 0.001 && post[0].quoteSource !== "live-200", "a POST-declared row is not retired by a GET answering 200 (the POST still quotes 402)");

  // --- 3. carry-forward keeps the retirement over a Bazaar-priced rebuild, exact verb only, inside the window
  const prev = { tools: [{ route: "/v1/discovery", method: "GET", price: null, paid: false, quoteSource: "live-200", quoteRetiredAt: Date.now() - 3_600_000, quoteObservedAt: Date.now() - 3_600_000 }] };
  const rebuilt = [
    { route: "/v1/discovery", method: "GET", price: 0.001, paid: true, networks: ["eip155:8453"], provenance: "bazaar" },
    { route: "/v1/discovery", method: "POST", price: 0.001, paid: true, networks: ["eip155:8453"], provenance: "bazaar" },
  ];
  carryForwardLearnedQuotes(rebuilt, prev);
  ok(rebuilt[0].price === null && rebuilt[0].paid === false && rebuilt[0].quoteSource === "live-200", "the Bazaar snapshot's 0.001 does not resurrect a route retired an hour ago (rule 3)");
  ok(rebuilt[1].price === 0.001, "a retired GET says nothing about the POST on the same path");
  const declaredNow = [{ route: "/v1/discovery", method: "GET", price: 0.005, originDeclaredPrice: 0.005 }];
  carryForwardLearnedQuotes(declaredNow, prev);
  ok(declaredNow[0].price === 0.005, "an origin that declares a price again beats the retirement");
  const old = { tools: [{ ...prev.tools[0], quoteRetiredAt: Date.now() - 8 * 24 * 3_600_000 }] };
  const aged = [{ route: "/v1/discovery", method: "GET", price: 0.001, paid: true, provenance: "bazaar" }];
  carryForwardLearnedQuotes(aged, old);
  ok(aged[0].price === 0.001, "a retirement older than the quote window no longer overrides: the row is a probe candidate and the live route decides again");

  console.log = origLog;
  console.log(`test-quote-retired-on-free: ${n} assertions OK`);
} finally { console.log = origLog; globalThis.fetch = orig; }
