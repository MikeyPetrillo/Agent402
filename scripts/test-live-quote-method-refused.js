#!/usr/bin/env node
// A seller that declares GET and POST on one path where only POST answers
// (minia2a.uk declares both on ~1,700 paths; the case worth a test is the
// seller whose POST route REJECTS GET). Before this, the live-402 probe
// corrected the declared GET row to POST and left two identical POST rows on
// the path; before 2026-09-02 it published the GET and buyers got 405. Now the
// refused declared row is dropped and its sibling carries the quote. Offline:
// fetch is stubbed; example.com resolves publicly so the SSRF guard is happy.
import assert from "node:assert/strict";

process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes } = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.equal(a, b, m); };

const ORIGIN = "https://example.com";
const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "500000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", decimals: 6 } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
const orig = globalThis.fetch;
const seen = [];
const stub = (rules) => async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  seen.push(`${m} ${u.pathname}`);
  const status = rules[`${m} ${u.pathname}`] ?? 404;
  const headers = new Headers(status === 402 ? { "payment-required": header, "content-type": "application/json" } : { "content-type": "text/plain" });
  return new Response(status === 402 ? "{}" : "nope", { status, headers });
};
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };

try {
  // --- 1. declared GET refused (405), declared POST answers: the GET row is dropped, the POST row carries the quote
  globalThis.fetch = stub({ "GET /x402/gas": 405, "POST /x402/gas": 402 });
  const tools = [
    { seller: "example.com", route: "/x402/gas", method: "GET", slug: "x402_gas_get", networks: [] },
    { seller: "example.com", route: "/x402/gas", method: "POST", slug: "x402_gas_post", networks: [] },
  ];
  await enrichLiveQuotes(tools, ORIGIN, { ignoreBudget: true });
  eq(tools.length, 1, "one row remains on the path");
  eq(tools[0].method, "POST", "the answering verb's own row remains");
  eq(tools[0].slug, "x402_gas_post", "the sibling row, not a relabelled GET");
  eq(tools[0].price, 0.5, "the quote landed on the sibling");
  ok(tools[0].networks.includes("eip155:8453") && tools[0].networksVerifiedAt > 0, "sibling networks verified");
  eq(tools[0].networksVerifiedMethod, "POST", "the sibling's stamp names the verb whose 402 was read");
  ok(logs.some((l) => /refuses GET and answers POST.*dropping the GET row/.test(l)), "the drop is logged with both verbs");

  // --- 1b. declared GET answers 400 (it validates its input before the
  // paywall), declared POST answers 402: a 400 is not a refusal, so the GET row
  // stays exactly as it was and only the POST row takes the read. Until
  // 2026-09-28 any non-402 on the stated verb dropped it.
  seen.length = 0; logs.length = 0;
  globalThis.fetch = stub({ "GET /x402/check": 400, "POST /x402/check": 402 });
  const validates = [
    { seller: "example.com", route: "/x402/check", method: "GET", slug: "x402_check_get", price: 0.01, originDeclaredPrice: 0.01, networks: ["eip155:10"] },
    { seller: "example.com", route: "/x402/check", method: "POST", slug: "x402_check_post", networks: [] },
  ];
  await enrichLiveQuotes(validates, ORIGIN, { ignoreBudget: true });
  eq(validates.length, 2, "a 400 on the stated verb keeps its row");
  const vGet = validates.find((t) => t.method === "GET"), vPost = validates.find((t) => t.method === "POST");
  ok(vGet.networks.length === 1 && vGet.networks[0] === "eip155:10" && vGet.price === 0.01, "the GET row keeps its own chain and price");
  ok(!vGet.networksVerifiedAt && !vGet.payToByNetwork && !vGet.liveProvenAt, "the GET row takes no stamp, payTo or proof from the POST's read");
  ok(vPost.price === 0.5 && vPost.networks.includes("eip155:8453") && vPost.networksVerifiedAt > 0 && vPost.liveProvenAt > 0, "the POST row takes the read");
  ok(vPost.networksVerifiedMethod === "POST" && vGet.networksVerifiedMethod === undefined, "only the POST row's stamp, naming POST");
  ok(logs.some((l) => /answers POST, not GET \(400\).*GET row was left as it was/.test(l)), "the kept row is logged with the answer");

  // --- 2. control: the seller honours both verbs -> both rows stay, both priced
  seen.length = 0; logs.length = 0;
  globalThis.fetch = stub({ "GET /x402/time": 402, "POST /x402/time": 402 });
  const both = [
    { seller: "example.com", route: "/x402/time", method: "GET", slug: "x402_time_get", networks: [] },
    { seller: "example.com", route: "/x402/time", method: "POST", slug: "x402_time_post", networks: [] },
  ];
  await enrichLiveQuotes(both, ORIGIN, { ignoreBudget: true });
  eq(both.length, 2, "both rows stay when both verbs answer");
  ok(both.every((t) => t.method === (t.slug.endsWith("_get") ? "GET" : "POST")), "verbs untouched");
  ok(both.every((t) => t.networksVerifiedMethod === t.method), "each row's stamp names its own verb");

  // --- 3. a lone declared GET that 405s with no sibling is CORRECTED (today's behaviour), never dropped
  seen.length = 0; logs.length = 0;
  globalThis.fetch = stub({ "GET /only-post": 405, "POST /only-post": 402 });
  const lone = [{ seller: "example.com", route: "/only-post", method: "GET", slug: "only_post", networks: [] }];
  await enrichLiveQuotes(lone, ORIGIN, { ignoreBudget: true });
  eq(lone.length, 1, "lone row kept");
  eq(lone[0].method, "POST", "corrected to the answering verb");
  eq(lone[0].methodCorrectedFrom, "GET", "correction recorded for the carry-forward");
  eq(lone[0].price, 0.5, "priced");
  eq(lone[0].networksVerifiedMethod, "POST", "the corrected row's stamp names the verb that answered, which is now its own");

  // --- 4. the drop is IN PLACE: a caller that ignores the return value sees it too
  globalThis.fetch = stub({ "GET /x402/recall": 405, "POST /x402/recall": 402 });
  const arr = [
    { seller: "example.com", route: "/x402/recall", method: "GET", slug: "x402_recall_get", networks: [] },
    { seller: "example.com", route: "/x402/recall", method: "POST", slug: "x402_recall_post", networks: [] },
  ];
  const ret = await enrichLiveQuotes(arr, ORIGIN, { ignoreBudget: true });
  ok(ret === arr && arr.length === 1, "the array passed in is the array trimmed (two call sites read it, not the return)");
} finally {
  globalThis.fetch = orig; console.log = origLog;
}
console.log(`test-live-quote-method-refused: ${n} assertions ok`);
