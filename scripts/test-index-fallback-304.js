#!/usr/bin/env node
// A seller with no /.well-known/x402 keeps its catalog when its fallback
// documents answer 304 Not Modified.
//
// The crawler sends the ETag it holds, and a seller that has not changed
// answers 304 with no body. The manifest branch keeps what its last fetch
// derived; the fallback branch (/openapi.json, /agents.json, /llms.txt) kept
// nothing and parsed the empty body, so from its second crawl on the seller
// had no tools and read crawl_failed ("\"undefined\" is not valid JSON").
// The fix reads fallback documents unconditionally, so each crawl fetches
// them once and never pairs a 304 with nothing.
// Offline: the real crawl pipeline through the
// __setCrawlFetchForTest seam, with a stub that honors If-None-Match.
process.env.X402_INDEX_CRAWL = "off";
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "fallback-304-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
const { sellerDetail, __setCrawlFetchForTest, __resetRobotsCacheForTest, __crawlSellerForTest, __testSetBazaarTools } = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const OA = "https://openapi-only.example.invalid";
const LL = "https://llms-only.example.invalid";
const paid = { "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.020000" }, protocols: [{ x402: {} }] } };
const served = new Map([
  [`${OA}/robots.txt`, "User-agent: *\nAllow: /\n"],
  [`${OA}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "Flights", version: "1" }, paths: {
    "/api/flights/search": { get: { operationId: "flightsSearch", summary: "Search flights", ...paid } },
    "/api/flights/status": { get: { operationId: "flightsStatus", summary: "Flight status", ...paid } },
  } })],
  [`${LL}/robots.txt`, "User-agent: *\nAllow: /\n"],
  [`${LL}/llms.txt`, `# Weather\n\n- [Current weather](${LL}/api/weather): weather for a city, $0.01\n`],
]);
const etag = (url) => `"${Buffer.from(url).toString("base64").slice(-12)}"`;
let notModifiedAnswers = 0;
const fetches = new Map();
__setCrawlFetchForTest(async (url, opts = {}) => {
  fetches.set(url, (fetches.get(url) || 0) + 1);
  const body = served.get(url);
  if (body === undefined) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  const sent = opts.validators?.etag || opts.validators?.ETag;
  if (opts.allowNotModified && sent && sent === etag(url)) { notModifiedAnswers++; return { notModified: true, finalUrl: url, validators: null }; }
  return { html: body, finalUrl: url, validators: { etag: etag(url) } };
});

// The production shape: the seller also has a facilitator-registry listing for one
// route, so an empty fallback read falls back to that one row as a
// "bazaar-fallback" listing that never responded.
__testSetBazaarTools(OA, [{ route: "/api/flights/search", method: "GET", price: "$0.02", paid: true, seller: OA, networks: ["eip155:8453"] }]);

for (const [origin, label, min] of [[OA, "openapi", 2], [LL, "llms.txt", 1]]) {
  __resetRobotsCacheForTest();
  await __crawlSellerForTest(origin);
  const first = sellerDetail(origin);
  ok(first?.toolCount >= min, `${label}: the first crawl reads the catalog (${first?.toolCount} tools)`);
  const before = notModifiedAnswers;
  fetches.clear();
  await __crawlSellerForTest(origin);
  const second = sellerDetail(origin);
  const doc = `${origin}${label === "openapi" ? "/openapi.json" : "/llms.txt"}`;
  ok(notModifiedAnswers === before, `${label}: the fallback read is unconditional, so no 304 is asked for`);
  ok(fetches.get(doc) === 1, `${label}: the second crawl fetches the document once, not twice (${fetches.get(doc)})`);
  ok(second?.toolCount === first?.toolCount, `${label}: the catalog survives the 304 (${second?.toolCount} tools)`);
  ok(!JSON.stringify(second?.fallbackErrors || []).includes("is not valid JSON"), `${label}: no "not valid JSON" fallback error after a 304`);
  ok(second?.originResponded !== false, `${label}: the origin still reads as responding`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
