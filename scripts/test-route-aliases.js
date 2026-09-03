#!/usr/bin/env node
// Router ranking rules added 2026-08-28 (offline, synthetic catalog):
//   1. a tool's curated `aliases` score exactly like its slug (max, never additive),
//   2. a query term under three characters matches whole tokens only - "ip" used
//      to substring-match gzip / gunzip / html-strip and outrank every IP tool.
process.env.X402_INDEX_CRAWL = "off";
const { routeQuery } = await import("../src/x402-index.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const tool = (slug, name, description, extra = {}) => [`POST /api/${slug}`, { route: `POST /api/${slug}`, slug, name, description, price: "$0.002", tags: [], category: "x", discovery: { input: {} }, handler: async () => ({}), ...extra }];
const catalog = Object.fromEntries([
  tool("asn-info", "ASN + IP geolocation", "Autonomous system and geolocation for an address.", { aliases: ["ip-geolocation", "geoip"], price: "$0.003" }),
  tool("ip-info", "IP info", "Classify an IP address."),
  tool("gzip", "Gzip", "Compress text with gzip."),
  tool("html-strip", "HTML strip", "Strip tags from HTML."),
  tool("qr", "QR code", "Render a QR code."),
]);
const run = (q) => routeQuery({ query: q, top: 5, include: "local", baseUrl: "http://agent402.test", catalog, toolCount: 5 }).results.map((r) => r.slug);
ok(run("geoip")[0] === "asn-info", `an alias matches exactly like a slug (geoip -> ${run("geoip")[0]})`);
ok(run("ip geolocation")[0] === "asn-info", `alias substring + name beat a plain name match (ip geolocation -> ${run("ip geolocation").join(",")})`);
const ipq = run("ip geolocation");
ok(!ipq.includes("gzip") && !ipq.includes("html-strip"), "a two-letter term never substring-matches gzip or html-strip");
ok(run("ip")[0] === "ip-info" && !run("ip").includes("gzip"), `a bare short term matches the slug token (ip -> ${run("ip").join(",")})`);
ok(run("qr code")[0] === "qr", "unrelated ranking unchanged");
const scored = routeQuery({ query: "geoip ip-geolocation", top: 5, include: "local", baseUrl: "http://agent402.test", catalog, toolCount: 5 }).results[0];
ok(scored.slug === "asn-info" && (scored.matched?.slug ?? 0) <= 20, "two alias hits are the max per term, never summed across aliases");
// Bazaar-quality tie-break vs local rows (2026-08-28): an outside seller with
// measured payers must not outrank our identical tool when OUR measurement is
// missing; when ours is present the same metric applies to both sides.
const { _setBazaarQualityForTest, _cacheForTests } = await import("../src/x402-index.js");
const cache = _cacheForTests(); cache.clear();
cache.set("https://ext.example", { manifest: { name: "ext", homepage: "https://ext.example" }, openapiSummary: null, tools: [{ seller: "https://ext.example", method: "POST", route: "/api/json-to-csv", slug: "json-to-csv", name: "JSON to CSV", description: "Convert JSON to CSV.", category: "data", tags: [], price: 0.002 }], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
const ctx = { baseUrl: "https://agent402.tools", catalog: { "POST /api/json-to-csv": { name: "JSON to CSV", slug: "json-to-csv", category: "data", price: "$0.002", description: "Convert JSON to CSV." } }, prices: { "json-to-csv": 0.002 }, network: "base", toolCount: 1, walletName: "agent402.base.eth" };
_setBazaarQualityForTest("https://ext.example", { calls30d: 100, payers30d: 9, lastCalledAt: null });
_setBazaarQualityForTest("https://agent402.tools", null);
const r1 = routeQuery({ query: "json to csv", top: 3, include: "all", ...ctx }).results;
ok(r1[0]?.seller === "agent402.tools" || r1[0]?.seller === "self" || !String(r1[0]?.seller || "").startsWith("https://"), `an outside seller's Bazaar payers never outrank our identical tool when ours is unmeasured (first: ${r1[0]?.seller})`);
_setBazaarQualityForTest("https://agent402.tools", { calls30d: 10, payers30d: 1, lastCalledAt: null });
const r2 = routeQuery({ query: "json to csv", top: 3, include: "all", ...ctx }).results;
ok(r2[0]?.seller === "https://ext.example", `with our own measurement present the same metric ranks both sides (first: ${r2[0]?.seller})`);
_setBazaarQualityForTest("https://agent402.tools", null); _setBazaarQualityForTest("https://ext.example", null); cache.clear();
// Unsubstituted OpenAPI path templates (2026-08-28): three of eight external
// rows for "get a stock quote" were "/stock/{symbol}" style URLs an agent
// cannot call. The row is still shown (a caller who knows the parameter can
// use it) but it is FLAGGED, and the paying router refuses to spend on one.
{
  const cache2 = _cacheForTests(); cache2.clear();
  cache2.set("https://tpl.example", { manifest: { name: "tpl", homepage: "https://tpl.example" }, openapiSummary: null, tools: [
    { seller: "https://tpl.example", method: "GET", route: "/stock/{symbol}", slug: "stock-quote", name: "Stock quote", description: "stock quote", category: "finance", tags: [], price: 0.002 },
    { seller: "https://tpl.example", method: "GET", route: "/stock/quote", slug: "stock-quote-plain", name: "Stock quote plain", description: "stock quote", category: "finance", tags: [], price: 0.002 },
  ], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
  const rows = routeQuery({ query: "stock quote", top: 5, include: "external", baseUrl: "https://agent402.tools", catalog: {}, toolCount: 0 }).results;
  const tpl = rows.find((r) => String(r.url).includes("{symbol}"));
  const plain = rows.find((r) => r.slug === "stock-quote-plain");
  ok(tpl && tpl.urlTemplate === true && Array.isArray(tpl.pathParams) && tpl.pathParams[0] === "symbol", `a template URL is returned but flagged (${JSON.stringify(tpl?.pathParams)})`);
  ok(plain && plain.urlTemplate === undefined, "a substituted URL carries no flag");
  const twice = [1, 2, 3].map(() => routeQuery({ query: "stock quote", top: 5, include: "external", baseUrl: "https://agent402.tools", catalog: {}, toolCount: 0 }).results.find((r) => String(r.url).includes("{symbol}"))?.urlTemplate);
  ok(twice.every((v) => v === true), `the flag is stable across calls, not a stateful-regex alternation (${JSON.stringify(twice)})`);
  cache2.clear();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
