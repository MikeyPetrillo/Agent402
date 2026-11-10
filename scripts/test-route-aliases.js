#!/usr/bin/env node
// Router ranking rules added 2026-08-28 (offline, synthetic catalog):
//   1. a tool's curated `aliases` score exactly like its slug (max, never additive),
//   2. a query term under three characters matches whole tokens only - "ip" used
//      to substring-match gzip / gunzip / html-strip and outrank every IP tool.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
// Full-slug coverage (2026-09-10): a slug every token of which appears in the
// query is an exact match for those tokens. Before, "json diff" scored json-diff
// 4+4 while a one-token slug "diff" took 10, so any compound slug lost to a
// single-word slug sharing one of its words (79 of our 585 tool names).
{
  const cat2 = Object.fromEntries([
    tool("json-diff", "JSON diff", "Structural diff of two JSON documents."),
    tool("diff", "Diff", "Diff two texts."),
    tool("text-diff", "Text diff", "Line diff of two texts."),
    tool("csv-to-json", "CSV to JSON", "Convert CSV rows to JSON."),
  ]);
  const run2 = (q) => routeQuery({ query: q, top: 5, include: "local", baseUrl: "http://agent402.test", catalog: cat2, toolCount: 4 }).results;
  ok(run2("json diff")[0]?.slug === "json-diff", `a query covering every slug token outranks a one-word slug sharing one word (json diff -> ${run2("json diff").map((r) => r.slug).join(",")})`);
  ok(run2("json diff")[0]?.why?.matchedOn?.slug === 20, "both covered tokens score as exact (10 each), not as substrings");
  ok(run2("diff")[0]?.slug === "diff", `a bare one-word query still prefers the exact one-word slug (diff -> ${run2("diff").map((r) => r.slug).join(",")})`);
  ok(run2("text diff")[0]?.slug === "text-diff" && run2("text diff").find((r) => r.slug === "json-diff")?.why?.matchedOn?.slug === 4, "coverage is per slug: json-diff is NOT covered by \"text diff\" and keeps the substring score for its shared word");
  ok(run2("csv to json")[0]?.slug === "csv-to-json" && run2("csv to json")[0]?.why?.matchedOn?.slug === 30, "the rule is neutral: it applies to any row, including a three-token slug fully covered by its query");
}
// A row's own name is an implicit alias (2026-09-10, second pass): an outside
// slug that is our tool's full name in snake_case must not out-score the tool
// on its own name. Neutral: the outside row's name gets the same treatment.
{
  const { _cacheForTests: cacheFor } = await import("../src/x402-index.js");
  const cache3 = cacheFor(); cache3.clear();
  cache3.set("https://fm.example", { manifest: { name: "fm", homepage: "https://fm.example" }, openapiSummary: null, tools: [{ seller: "https://fm.example", method: "POST", route: "/cron_next_runs", slug: "cron_next_runs", name: "cron_next_runs", description: "Next runs of a cron expression.", category: "time", tags: [], price: 0.002, networks: ["eip155:8453"] }], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const ctx3 = { baseUrl: "https://agent402.tools", catalog: { "POST /api/cron-next": { name: "Cron next runs", slug: "cron-next", category: "time", price: "$0.001", description: "Next run times for a cron expression.", tags: [], discovery: { input: {} } } }, prices: { "cron-next": 0.001 }, network: "base", toolCount: 1, walletName: "w" };
  const r3 = routeQuery({ query: "cron next runs", top: 3, include: "all", ...ctx3 }).results;
  const ours = r3.find((r) => r.slug === "cron-next"), theirs = r3.find((r) => r.slug === "cron_next_runs");
  ok(ours && theirs && ours.why.matchedOn.slug === theirs.why.matchedOn.slug && ours.why.matchedOn.slug === 30, `our name in slug form scores like their full-name slug (ours ${ours?.why.matchedOn.slug}, theirs ${theirs?.why.matchedOn.slug})`);
  ok(r3[0]?.slug === "cron-next", `on a tie the cheaper row leads (first: ${r3[0]?.slug})`);
  cache3.clear();
}
// A SENTENCE in the name field is not a slug alias (2026-11-09): an outside
// row whose "name" is a long description used to earn slug points for every
// common query word inside it, and "which stocks are set up to buy today"
// ranked a marketplace-crowding tool above stock tools on that sentence.
{
  const { _cacheForTests: cacheFor, NAME_SLUG_MAX_TOKENS } = await import("../src/x402-index.js");
  const cache4 = cacheFor(); cache4.clear();
  // The shape of the two live rows that showed it (text paraphrased): a
  // sentence-named row and a stock seller whose own slug and name are terse. Without the cap the two
  // tie at 14 and the sentence row is listed first; with it the stock row leads.
  const sentence = "Call this when an agent has to pick which job board is worth its time: how busy it is (offers per task, counted), and are";
  cache4.set("https://mkt.example", { manifest: { name: "mkt", homepage: "https://mkt.example" }, openapiSummary: null, tools: [{ seller: "https://mkt.example", method: "POST", route: "/v1/payability", slug: "v1_payability", name: sentence, description: sentence, category: "x", tags: [], price: 0.005, networks: ["eip155:8453"] }], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const buy = "Today's ranked buy ideas per portfolio, with entry timing and trend markers";
  cache4.set("https://stk.example", { manifest: { name: "stk", homepage: "https://stk.example" }, openapiSummary: null, tools: [{ seller: "https://stk.example", method: "GET", route: "/api/board/buylist", slug: "getBoardBuylist", name: buy, description: buy, category: "x", tags: [], price: 0.05, networks: ["eip155:8453"] }], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const ctx4 = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const r4 = routeQuery({ query: "which stocks are set up to buy today", top: 5, include: "external", ...ctx4 }).results;
  const mkt = r4.find((r) => r.slug === "v1_payability"), stk = r4.find((r) => r.slug === "getBoardBuylist");
  ok(r4[0]?.slug === "getBoardBuylist" && stk && mkt && stk.score > mkt.score, `the stock row outranks the sentence-named row on a stock question (${r4.map((r) => `${r.slug}:${r.score}`).join(", ")})`);
  ok(mkt?.why.matchedOn.slug === 0, `a sentence-long name earns no slug points (got ${mkt?.why.matchedOn.slug})`);
  ok(NAME_SLUG_MAX_TOKENS >= 9, "the cap covers every name length in our own catalog (9 words at most)");
  cache4.clear();
}
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
  // A placeholder kept in a manifest endpoint's QUERY is just as uncallable:
  // the router appends the caller's params after it, so the seller reads the
  // placeholder first. Flagged like a path template; a real query value is not.
  cache2.clear();
  cache2.set("https://qtpl.example", { manifest: { name: "qtpl", homepage: "https://qtpl.example" }, openapiSummary: null, tools: [
    { seller: "https://qtpl.example", method: "GET", route: "/v1/premium/mainnet/batch-validate?payloads=%3Curl-encoded-json-array%3E", slug: "batch-validate", name: "Batch validate", description: "batch validate envelopes", category: "other", tags: [], price: 0.01 },
    { seller: "https://qtpl.example", method: "GET", route: "/v1/validate?product=basic", slug: "validate-basic", name: "Validate basic", description: "batch validate envelopes", category: "other", tags: [], price: 0.01 },
  ], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
  const qrows = routeQuery({ query: "batch validate envelopes", top: 5, include: "external", baseUrl: "https://agent402.tools", catalog: {}, toolCount: 0 }).results;
  const qtpl = qrows.find((r) => r.slug === "batch-validate");
  const qplain = qrows.find((r) => r.slug === "validate-basic");
  ok(qtpl && qtpl.urlTemplate === true && qtpl.pathParams?.[0] === "url-encoded-json-array", `a query placeholder is returned but flagged (${JSON.stringify({ flag: qtpl?.urlTemplate, params: qtpl?.pathParams })})`);
  ok(qplain && qplain.urlTemplate === undefined, "a real query value carries no flag");
  cache2.clear();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
