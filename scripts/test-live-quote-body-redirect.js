#!/usr/bin/env node
// Three live-402 probe gaps measured on prod 2026-09-23 (first hour of the
// outcome counters): input errors on POST routes that validate a required body
// before the paywall (~25% of misses), and 402s whose accepts array sat under a
// name we did not read. Offline: fetch is
// stubbed; example.com resolves publicly so the SSRF guard is happy.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes, quoteProbeStatsSnapshot } = await import("../src/x402-index.js");
const { probeBodyFor, probeAttemptsFor, acceptsFromLive402 } = await import("../src/x402-live-quote.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
const ORIGIN = "https://example.com";
const accept = { scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
const quote402 = () => new Response("{}", { status: 402, headers: { "payment-required": header } });
const row = (route, method, contract) => ({ seller: "example.com", route, method, slug: route.slice(1), price: null, networks: [], ...(contract ? { requestContract: ["declared", contract] } : {}) });
const seen = [];
const orig = globalThis.fetch;
const origLog = console.log; console.log = () => {};

try {
  // --- pure helpers
  eq(JSON.parse(probeBodyFor(row("/x", "POST", { body: ["url", "options.depth", "options.format"] }))),
    { url: "https://example.com", options: { depth: "test", format: "test" } }, "dotted body paths become a nested placeholder object");
  ok(probeBodyFor(row("/x", "POST")) === null, "no contract, no body");
  eq(probeAttemptsFor(ORIGIN, row("/plain", "GET")).map((a) => `${a.method} ${a.body}`), ["GET null", "POST {}"], "a route that declares nothing makes exactly the old two requests");
  eq(probeAttemptsFor(ORIGIN, row("/b", "POST", { body: ["url"] })).map((a) => a.body), ['{"url":"https://example.com"}', "{}"], "filled body first, then {}");
  eq(acceptsFromLive402({ body: JSON.stringify({ x402Version: 1, paymentRequirements: [accept] }) }), [accept], "paymentRequirements read as accepts");
  eq(acceptsFromLive402({ body: JSON.stringify({ error: { accepts: [accept] } }) }), [accept], "accepts nested under error read");

  // --- POST route that validates its body before the paywall
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); seen.push(`${init.method} ${u.pathname} ${init.body || ""}`);
    let b = {}; try { b = JSON.parse(init.body || "{}"); } catch { /* */ }
    return b.url ? quote402() : new Response("url required", { status: 422 });
  };
  const post = [row("/extract", "POST", { body: ["url"] })];
  await enrichLiveQuotes(post, ORIGIN, { ignoreBudget: true });
  ok(post[0].price === 0.002, `the body placeholder gets past validation to the 402 (got ${post[0].price})`);
  ok(seen[0] === 'POST /extract {"url":"https://example.com"}', `placeholder body sent first (got ${seen[0]})`);

  // --- MPP-only 402 counted apart from a parser gap
  const before = quoteProbeStatsSnapshot();
  globalThis.fetch = async () => new Response("{}", { status: 402, headers: { "www-authenticate": 'Payment id="x", method="tempo"' } });
  await enrichLiveQuotes([row("/mpp", "POST")], ORIGIN, { ignoreBudget: true });
  const after = quoteProbeStatsSnapshot();
  ok((after.attempts["POST 402-mpp-only"] || 0) > (before.attempts["POST 402-mpp-only"] || 0), "an MPP-only challenge is counted as such");

  // --- a genuinely unreadable 402 is sampled (shape only)
  globalThis.fetch = async () => new Response(JSON.stringify({ pay: "somehow" }), { status: 402 });
  await enrichLiveQuotes([row("/odd402", "POST")], ORIGIN, { ignoreBudget: true });
  const s = quoteProbeStatsSnapshot().unreadable402Samples.at(-1);
  ok(s && s.host === "example.com" && s.route === "/odd402" && s.bodyKeys.includes("pay"), `unreadable 402 sampled with its keys (got ${JSON.stringify(s)})`);
} finally {
  globalThis.fetch = orig; console.log = origLog;
}
origLog(`test-live-quote-body-redirect: ${n} assertions ok`);
