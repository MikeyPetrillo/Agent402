#!/usr/bin/env node
// A seller field that is an object where text was expected must never become
// the text "[object Object]" in a route, name, URL, method or price. The case
// that found it: a manifest whose resources[] entries carry `resource` as an
// x402 v2 object ({ url, mimeType }) beside `path` and `method`. String() on
// the object read "[object Object]", every entry collapsed onto the one route
// "/[object%20Object]", and that row was listed and marked routable beside the
// seller's real rows. Runs offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.X402_INDEX_CRAWL = "off";
const {
  normaliseManifestTools, normaliseOpenapiTools, mergeManifestIntoTools, bazaarItemToTool,
  dropDeclaredFreeEndpoints, itemHasMainnetAccept, _cacheForTests,
} = await import("../src/x402-index.js");
const { parseMppScanList, pickProbeTarget } = await import("../src/mpp-index.js");
const { dispatchEligibility, DISPATCH_REASONS } = await import("../src/dispatch-eligibility.js");
const { sellerText, firstSellerText, resourceUrlText, malformedRoute } = await import("../src/seller-text.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const noObjectText = (v) => !/\[object[\s%]|%5Bobject/i.test(JSON.stringify(v ?? null));

const HOST = "https://seller.example";
const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET = `0x${"b2".repeat(20)}`;
const accepts = (amount) => [{ scheme: "exact", network: BASE, asset: USDC, payTo: WALLET, amount, maxAmountRequired: amount, extra: { name: "USD Coin", version: "2" } }];

// --- 1. The manifest shape from the report ---------------------------------
const entry = (slug, title, path, price, query = "") => ({
  slug, title, method: "POST", path, price, scheme: "exact", network: BASE,
  resource: { url: `${HOST}${path}${query}`, mimeType: "application/json" },
  accepts: accepts(String(Math.round(Number(price.slice(1)) * 1e6))),
});
const manifest = {
  x402Version: 2,
  name: "Seller",
  resources: [
    entry("advertising.pixel-claim", "Pixel advertising claim", "/v1/advertising/pixel-claim", "$1", "?pixel_count=1"),
    entry("data.timezone-convert", "Timezone conversion", "/v1/data/timezone-convert", "$0.002"),
    entry("web.metadata", "Webpage metadata extraction", "/v1/web/metadata", "$0.002"),
  ],
};
{
  const rows = normaliseManifestTools(manifest, HOST);
  const routes = rows.map((r) => `${r.method} ${r.route}`).sort();
  ok(rows.length === 3, `three entries give three rows (${rows.length}: ${routes.join(", ")})`);
  ok(noObjectText(rows), "no row carries the text of a coerced object");
  ok(routes.includes("POST /v1/advertising/pixel-claim"), "the object resource with a query reads as its declared path, exactly");
  ok(routes.includes("POST /v1/data/timezone-convert") && routes.includes("POST /v1/web/metadata"), "the object resources without a query read as their URL's path");
  const pixel = rows.find((r) => r.route === "/v1/advertising/pixel-claim");
  ok(pixel?.name === "Pixel advertising claim", `the row keeps the entry's title (${pixel?.name})`);
  ok(pixel?.price === "$1", `the row keeps the entry's price (${pixel?.price})`);

  // The same seller's OpenAPI document already lists the canonical routes:
  // the manifest rows merge into them, one row per route.
  const openapi = {
    openapi: "3.1.0",
    servers: [{ url: HOST }],
    paths: Object.fromEntries(manifest.resources.map((e) => [e.path, { post: { operationId: e.slug, summary: e.title, "x-price": e.price } }])),
  };
  const existing = normaliseOpenapiTools(openapi, HOST);
  ok(existing.length === 3, `the OpenAPI document gives three rows (${existing.length})`);
  const merged = mergeManifestIntoTools(rows, existing);
  const pixelRows = merged.filter((r) => r.route.split("?")[0] === "/v1/advertising/pixel-claim");
  ok(merged.length === 3, `merged with the OpenAPI rows, the seller holds three rows (${merged.length}: ${merged.map((r) => `${r.method} ${r.route}`).join(", ")})`);
  ok(pixelRows.length === 1 && pixelRows[0].method === "POST" && pixelRows[0].route === "/v1/advertising/pixel-claim", "the pixel claim is one row, POST at its canonical path");
  ok(noObjectText(merged), "the merged list carries no coerced object text");
}

// A resource object whose path differs from the declared path keeps its URL
// (the declared path is preferred only when both name the same path), and a
// resource object with no string url, beside no other text field, names no row.
{
  const rows = normaliseManifestTools({ resources: [
    { method: "GET", path: "/a", resource: { url: `${HOST}/b?x=1` }, price: "$0.01" },
    { method: "GET", resource: { mimeType: "application/json" }, price: "$0.01" },
    { method: "GET", resource: { url: { href: `${HOST}/c` } }, price: "$0.01" },
  ] }, HOST);
  ok(rows.length === 1 && rows[0].route === "/b?x=1", `a different path keeps the resource URL; objects without a string url give no row (${JSON.stringify(rows.map((r) => r.route))})`);
}

// --- 2. Sweep: an object in every coerced field ----------------------------
const OBJ = () => ({ nested: true });
// Manifest catalogue fields, one at a time, each beside a good path.
for (const field of ["endpoint", "resource", "url", "route", "path"]) {
  const e = { method: "POST", path: "/v1/good", price: "$0.01", [field]: OBJ() };
  if (field === "path") e.route = "/v1/good";
  const rows = normaliseManifestTools({ resources: [e] }, HOST);
  ok(rows.length === 1 && rows[0].route === "/v1/good" && noObjectText(rows), `manifest ${field} as an object: the row reads the text field beside it (${JSON.stringify(rows.map((r) => r.route))})`);
}
for (const field of ["name", "title", "operationId", "summary", "description"]) {
  const rows = normaliseManifestTools({ resources: [{ method: "POST", path: "/v1/good", price: "$0.01", [field]: OBJ() }] }, HOST);
  ok(rows.length === 1 && noObjectText(rows), `manifest ${field} as an object is not coerced (${JSON.stringify(rows.map((r) => [r.name, r.slug, r.description]))})`);
}
{
  const rows = normaliseManifestTools({ resources: [{ method: "POST", path: "/v1/good", price: "$0.01", name: OBJ(), title: "Good title" }] }, HOST);
  ok(rows[0]?.name === "Good title", `an object name falls through to the text title (${rows[0]?.name})`);
}
// A `paths` catalogue entry whose resource is an object counts as an x402 entry.
{
  const rows = normaliseManifestTools({ paths: { "/v1/p": { resource: { url: `${HOST}/v1/p` }, price: "$0.01" } } }, HOST);
  ok(rows.length === 1 && rows[0].route === "/v1/p" && noObjectText(rows), `a paths entry with an object resource reads its url (${JSON.stringify(rows.map((r) => r.route))})`);
}
// Registry (Bazaar) items.
{
  const t = bazaarItemToTool({ resource: { url: `${HOST}/v1/bz`, mimeType: "application/json" }, accepts: accepts("10000"), method: "POST" }, HOST);
  ok(t?.route === "/v1/bz" && noObjectText(t), `a registry item whose resource is an object reads its url (${t?.route})`);
  const u = bazaarItemToTool({ resource: OBJ(), accepts: accepts("10000") }, HOST);
  ok(u === null, "a registry item whose resource object has no url gives no row");
  const v = bazaarItemToTool({ resource: `${HOST}/v1/bz`, accepts: accepts("10000"), serviceName: OBJ(), description: OBJ(), tags: [OBJ(), "data"] }, HOST);
  ok(v && v.name === "/v1/bz" && v.description === "" && v.category === "data" && noObjectText(v), `object serviceName, description and tags are not coerced (${JSON.stringify(v && [v.name, v.description, v.category, v.tags])})`);
}
// OpenAPI operations.
{
  const rows = normaliseOpenapiTools({ openapi: "3.1.0", servers: [{ url: HOST }], paths: { "/v1/o": { post: { summary: OBJ(), description: OBJ(), operationId: OBJ(), "x-price": "$0.01" } } } }, HOST);
  ok(rows.length === 1 && rows[0].route === "/v1/o" && rows[0].name === "/v1/o" && rows[0].description === "" && noObjectText(rows), `OpenAPI object summary, description and operationId are not coerced (${JSON.stringify(rows.map((r) => [r.name, r.slug, r.description]))})`);
}
// Declared free endpoints.
{
  const tools = [{ method: "GET", route: "/v1/free" }, { method: "GET", route: "/v1/paid" }];
  const kept = dropDeclaredFreeEndpoints(tools, { free_endpoints: [{ path: OBJ(), route: "/v1/free" }] });
  ok(kept.length === 1 && kept[0].route === "/v1/paid", `a free endpoint whose path is an object reads its text route (${JSON.stringify(kept.map((t) => t.route))})`);
}
ok(itemHasMainnetAccept({ accepts: [{ network: OBJ() }] }) === false, "an accept whose network is an object names no mainnet");
// MPP index readers.
{
  const r = parseMppScanList({ result: { data: { json: { origins: [{ url: OBJ() }, { url: "https://mpp.example" }] } } } });
  ok(r.rows.length === 1 && r.rows[0].origin === "https://mpp.example", `an MPP origin whose url is an object is skipped (${JSON.stringify(r.rows.map((x) => x.origin))})`);
  const t = pickProbeTarget("https://mpp.example", { endpoints: [{ path: "/v1/m", method: OBJ() }] }, null);
  ok(t.method === "GET" && t.url === "https://mpp.example/v1/m", `an MPP endpoint whose method is an object probes GET (${JSON.stringify(t)})`);
}

// --- 3. The store and the router refuse a malformed route ------------------
{
  const cache = _cacheForTests(); cache.clear();
  const row = (route) => ({ seller: HOST, method: "POST", route, slug: "s", name: "n", description: "d", category: "other", tags: [], price: "$0.01", networks: [BASE] });
  const bad = ["/[object%20Object]", "/[object Object]", "/%5Bobject%20Object%5D", "no-slash", "//other.example/x", "", 12, { u: 1 }, null];
  cache.set(HOST, { manifest: { name: "s", homepage: HOST }, tools: [row("/v1/good"), ...bad.map(row)], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const stored = cache.get(HOST).tools;
  ok(stored.length === 1 && stored[0].route === "/v1/good", `only the well-formed route is stored (${JSON.stringify(stored.map((t) => t.route))})`);
  for (const r of bad) ok(malformedRoute(typeof r === "number" ? String(r) : r), `malformedRoute(${JSON.stringify(r)}) is true`);
  for (const r of ["/v1/good", "/v1/x?product=a&b=c", "/", "/items/{id}"]) ok(!malformedRoute(r), `malformedRoute(${JSON.stringify(r)}) is false`);
}
{
  const args = { routable: true, networks: [BASE], settled: 500, payers: 50, priceUsd: 0.01, spendChains: ["base"], minSettled: 50, minPayers: 3 };
  const bad = dispatchEligibility({ ...args, routeText: { route: "/[object%20Object]", name: "n" } });
  ok(bad.eligible === false && bad.reason === "route_malformed" && bad.chains.base?.reason === "route_malformed", `a malformed route is never router-eligible (${bad.reason})`);
  ok(typeof DISPATCH_REASONS.route_malformed === "string", "route_malformed is documented in DISPATCH_REASONS");
  const good = dispatchEligibility({ ...args, routeText: { route: "/v1/good", name: "n" } });
  ok(good.reason !== "route_malformed", `a well-formed route is judged on its evidence (${good.reason})`);
}

// --- 4. The helpers --------------------------------------------------------
ok(sellerText(OBJ()) === "" && sellerText([1]) === "" && sellerText(null) === "" && sellerText(3) === "3" && sellerText(true) === "true" && sellerText("a") === "a", "sellerText keeps text, numbers and booleans and drops the rest");
ok(firstSellerText(OBJ(), "  ", null, " x ") === "x", "firstSellerText skips non-text and blank values");
ok(resourceUrlText({ url: "https://h/x" }) === "https://h/x" && resourceUrlText({ url: OBJ() }) === "" && resourceUrlText([]) === "" && resourceUrlText("s") === "s", "resourceUrlText reads a string or an object's string url");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
