#!/usr/bin/env node
// Path-scoped sellers (2026-10-01): an app served under a path prefix on a
// shared host is its own seller. Offline: the crawl's document reads go through
// the __setCrawlFetchForTest seam, so the REAL registration and crawl pipeline
// runs (validate -> registerOrigin -> crawlSeller -> normalisers -> cache) with
// no network.
//
// What is pinned:
//   * registration accepts a clean path prefix and refuses traversal, encoding,
//     a query, empty segments and an over-long prefix; without opt-in the
//     validator still requires a bare origin (the MPP index relies on that);
//   * two apps on one host register and list as two sellers with their own
//     tools, read from under their own prefixes, and the host root (which 404s)
//     is never asked for a manifest;
//   * a manifest row naming another app's route on the same host, or another
//     host, is never attributed; a document redirected outside the prefix is
//     not the seller's;
//   * robots.txt is read once at the host root and matched on the full path;
//   * ?seller= lookup finds each by its prefixed URL; route URLs are
//     seller + route; the two apps are not folded together as aliases;
//   * a bare origin's rows and lookups are exactly as before.
process.env.X402_INDEX_CRAWL = "off";
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "path-sellers-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const {
  validateOriginInput, normalizeSellerKey, sellerKeyParts, scopeRouteToSeller, isUnderSeller,
  registerOrigin, sellerDetail, findSellerKey, robotsForbids, bazaarItemToTool, normaliseManifestTools,
  normaliseOpenapiTools, computeAliasOrigins, removeOrigin, isRemovedOrigin, routeQuery,
  __setCrawlFetchForTest, __testResetSubmitted, __resetRobotsCacheForTest, _cacheForTests,
} = idx;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const H = "https://apps.example.invalid";
const A = `${H}/app/alpha-1`;
const B = `${H}/app/beta-2`;
const C = `${H}/app/gamma-3`;
const accepts = (payTo, amount = "5000") => [{ scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const PAY_A = "0x" + "a1".repeat(20);
const PAY_B = "0x" + "b2".repeat(20);

// ---------------------------------------------------------------- validation
{
  const v = (raw, o = {}) => validateOriginInput(raw, { selfOrigin: "https://agent402.tools", ...o });
  ok(v(A, { allowPath: true }).origin === A, "a clean path prefix is accepted as the seller key");
  ok(v(`${A}/`, { allowPath: true }).origin === A, "a trailing slash is dropped");
  ok(v("https://Apps.Example.INVALID/App/Alpha", { allowPath: true }).origin === "https://apps.example.invalid/App/Alpha", "host lowercased, path case preserved");
  for (const bad of [`${H}/app/../alpha`, `${H}/app/./alpha`, `${H}/app/%61lpha`, `${H}/app//alpha`, `${A}?x=1`, `${A}#f`, `${H}/${"a".repeat(201)}`, `${H}/1/2/3/4/5/6/7/8/9`, `${H}/app/a b`, `http://apps.example.invalid/app/alpha`]) {
    ok(v(bad, { allowPath: true }).error, `refused: ${bad.slice(0, 70)}`);
  }
  ok(v(A).error, "without allowPath a path is still refused (the MPP index's bare-origin rule)");
  ok(v("https://agent402.tools/app/x", { allowPath: true }).error, "a path on our own host is the local catalog, refused");
  ok(v("https://example.com").origin === "https://example.com", "a bare origin is unchanged");
  const n = normalizeSellerKey(A);
  ok(n.key === A && n.origin === H && n.prefix === "/app/alpha-1", "normalizeSellerKey splits origin and prefix");
  const p = sellerKeyParts(A);
  ok(p.origin === H && p.prefix === "/app/alpha-1" && sellerKeyParts(H).prefix === "", "sellerKeyParts: a bare key has no prefix");
  ok(scopeRouteToSeller(A, "/app/alpha-1/api/x?q=1") === "/api/x?q=1", "a host path under the prefix becomes prefix-relative");
  ok(scopeRouteToSeller(A, "/app/alpha-10/api/x") === null && scopeRouteToSeller(A, "/api/x") === null, "a path outside the prefix (incl. a longer sibling) is not the seller's");
  ok(scopeRouteToSeller(H, "/api/x") === "/api/x", "a bare origin's routes are untouched");
  ok(isUnderSeller(`${A}/api/x`, A) && !isUnderSeller(`${H}/app/alpha-10/api`, A) && !isUnderSeller("https://apps.example.invalid.evil.test/app/alpha-1", A), "isUnderSeller is segment- and host-exact");
}

// ---------------------------------------------------------------- crawl (real pipeline, stubbed fetch)
const served = new Map();
const fetched = [];
const notFound = (url) => Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
__setCrawlFetchForTest(async (url) => {
  fetched.push(url);
  const hit = served.get(url);
  if (!hit) throw notFound(url);
  return { html: typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body), finalUrl: hit.finalUrl || url, validators: null };
});
served.set(`${H}/robots.txt`, { body: "User-agent: *\nAllow: /\n" });
served.set(`${A}/.well-known/x402`, { body: {
  x402Version: 2, name: "Alpha screen",
  resources: [
    { resource: `${A}/api/screen`, method: "GET", description: "Screen a name.", price: "$0.005", accepts: accepts(PAY_A) },
    // Another app's route on the same host: must never become Alpha's.
    { resource: `${B}/api/geo`, method: "GET", description: "claimed", price: "$0.001", accepts: accepts(PAY_A, "1000") },
    // A longer sibling prefix (alpha-10) is another app too.
    { resource: `${H}/app/alpha-10/api/x`, method: "GET", price: "$0.001", accepts: accepts(PAY_A, "1000") },
    // Another host entirely.
    { resource: "https://other.example.invalid/api/z", method: "GET", price: "$0.001", accepts: accepts(PAY_A, "1000") },
  ],
} });
served.set(`${A}/openapi.json`, { body: {
  openapi: "3.1.0", info: { title: "Alpha" }, servers: [{ url: A }],
  paths: { "/api/screen": { get: { operationId: "screen", summary: "Screen one name against a list", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.005" } }, parameters: [{ name: "name", in: "query", required: true, schema: { type: "string" } }] } } },
} });
// Beta: no manifest (falls back), an OpenAPI with NO servers and a payment
// annotation - its paths are relative to the prefix it is served under.
served.set(`${B}/openapi.json`, { body: {
  openapi: "3.1.0", info: { title: "Beta" },
  paths: { "/api/geo": { get: { operationId: "geo", summary: "Geocode an address", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001" } } } } },
} });
// Gamma's manifest is answered by a redirect into ALPHA's prefix: Alpha's
// document, which must not be read as Gamma's.
served.set(`${C}/.well-known/x402`, { body: served.get(`${A}/.well-known/x402`).body, finalUrl: `${A}/.well-known/x402` });

__testResetSubmitted();
__resetRobotsCacheForTest();
const submit = async (raw) => {
  const v = validateOriginInput(raw, { selfOrigin: "https://agent402.tools", allowPath: true });
  if (v.error) return { error: v.error };
  return registerOrigin(v.origin);
};
const rA = await submit(A);
const rB = await submit(`${B}/`);
const rC = await submit(C);
const cache = _cacheForTests();
ok(rA.listed === true && rA.origin === A, `app A listed under its prefixed key (${JSON.stringify({ listed: rA.listed, origin: rA.origin, error: rA.error })})`);
ok(rB.listed === true && rB.origin === B, `app B listed under its own key (${JSON.stringify({ listed: rB.listed, origin: rB.origin, error: rB.error })})`);
ok(cache.has(A) && cache.has(B) && !cache.has(H), "two sellers on one host, and no host-level seller invented");
ok(!fetched.includes(`${H}/.well-known/x402`) && !fetched.includes(`${H}/openapi.json`), "the host root (which 404s) is never asked for the seller's documents");
ok(fetched.includes(`${A}/.well-known/x402`) && fetched.includes(`${B}/openapi.json`), "documents are read from under each prefix");
ok(fetched.filter((u) => u.endsWith("/robots.txt")).every((u) => u === `${H}/robots.txt`) && fetched.filter((u) => u.endsWith("/robots.txt")).length === 1, "robots.txt is read once, at the host root, for both apps");

const toolsA = cache.get(A)?.tools || [];
const toolsB = cache.get(B)?.tools || [];
ok(toolsA.length === 1 && toolsA[0].route === "/api/screen", `app A has exactly its own route, prefix-relative (${JSON.stringify(toolsA.map((t) => t.route))})`);
ok(!toolsA.some((t) => /geo|alpha-10|\/api\/z/.test(t.route)), "routes naming another app on the host, a sibling prefix or another host are not attributed");
ok(toolsA[0]?.name === "screen" || /Screen/.test(toolsA[0]?.description || toolsA[0]?.name || ""), "the OpenAPI (servers = the prefix) enriched app A's row");
ok(toolsB.length === 1 && toolsB[0].route === "/api/geo", `app B's OpenAPI with no servers is read relative to its prefix (${JSON.stringify(toolsB.map((t) => t.route))})`);
ok(toolsA.every((t) => t.seller === A) && toolsB.every((t) => t.seller === B), "every row names its own seller key");
ok(!(rC.listed === true && (cache.get(C)?.tools || []).some((t) => t.route === "/api/screen")), `a manifest redirected into another app's prefix is not the seller's (${JSON.stringify({ listed: rC.listed, error: rC.error })})`);
// The routes would be scoped away anyway; the redirect guard is what keeps the
// other app's NAME and description off this seller.
ok(rC.listed !== true && cache.get(C)?.manifest?.name !== "Alpha screen", `the redirected document is refused outright, so app C carries none of app A's identity (${cache.get(C)?.manifest?.name ?? "no manifest"})`);

// ---------------------------------------------------------------- lookups
{
  const dA = sellerDetail(A), dB = sellerDetail(`${B}/`);
  ok(dA?.origin === A && dA.pathPrefix === "/app/alpha-1", "?seller= finds app A by its prefixed URL, with pathPrefix");
  ok(dB?.origin === B, "and app B by its own (trailing slash ignored)");
  ok(sellerDetail("apps.example.invalid/app/alpha-1")?.origin === A, "the scheme is optional on a prefixed lookup");
  ok(sellerDetail(`${H}/app/nope`) === null, "a path that names no seller finds nothing (never the host's first app)");
  ok([A, B].includes(findSellerKey("apps.example.invalid")), "a bare host lookup still finds a seller on it");
  ok(dA && !("pathPrefix" in (sellerDetail("https://example.com") || {})), "a bare origin's detail carries no pathPrefix");
  const aliases = computeAliasOrigins(cache);
  ok(!aliases.has(A) && !aliases.has(B), "two apps on one host are not folded together as aliases");
}

// ---------------------------------------------------------------- routing
{
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const rows = routeQuery({ query: "screen name", top: 5, include: "external", ...ctx }).results || [];
  const row = rows.find((r) => r.seller === A);
  ok(row?.url === `${A}/api/screen`, `a route row's URL is seller + route under the prefix (${row?.url})`);
  const geo = (routeQuery({ query: "geocode address", top: 5, include: "external", ...ctx }).results || []).find((r) => r.seller === B);
  ok(geo?.url === `${B}/api/geo`, `app B routes to its own URL (${geo?.url})`);
}

// ---------------------------------------------------------------- robots per host, full path
{
  __resetRobotsCacheForTest();
  const asked = [];
  const fetchText = async (url) => { asked.push(url); return "User-agent: *\nDisallow: /app/alpha-1/openapi.json\n"; };
  const f = await robotsForbids(A, "/openapi.json", { fetchText });
  ok(f && asked[0] === `${H}/robots.txt`, "robots.txt is fetched at the host root and its rule matched on the full path");
  ok((await robotsForbids(B, "/openapi.json", { fetchText })) === null, "a rule for one app's path does not forbid another app");
  ok(asked.length === 1, "one cached robots read serves every seller on the host");
}

// ---------------------------------------------------------------- converters: boundaries, bare origins unchanged
{
  const item = (resource) => ({ resource, method: "GET", accepts: accepts(PAY_A) });
  ok(bazaarItemToTool(item(`${A}/api/screen`), A)?.route === "/api/screen", "a registry row under the prefix converts to a prefix-relative route");
  ok(bazaarItemToTool(item(`${H}/app/alpha-10/api/x`), A) === null, "a sibling prefix that merely starts with the key is not the seller's");
  ok(bazaarItemToTool(item("https://seller.example.hostile.test/api"), "https://seller.example") === null, "a bare key no longer owns a host it is merely a string prefix of");
  ok(bazaarItemToTool(item("https://seller.example/api/q"), "https://seller.example")?.route === "/api/q", "a bare origin's registry row is unchanged");
  const bare = normaliseManifestTools({ resources: [{ resource: "https://seller.example/app/x/api", method: "GET", price: "$0.01" }] }, "https://seller.example");
  ok(bare.length === 1 && bare[0].route === "/app/x/api", "a bare origin's manifest rows keep their host paths");
  const bareOa = normaliseOpenapiTools({ servers: [{ url: "https://seller.example/v1" }], paths: { "/q": { get: { "x-payment-info": { price: { amount: "0.01" } } } } } }, "https://seller.example");
  ok(bareOa.length === 1 && bareOa[0].route === "/v1/q", "a bare origin's OpenAPI base path is applied as before");
}

// ---------------------------------------------------------------- removal is exact
{
  const r = removeOrigin(B);
  ok(r.removed === true && r.origin === B, "an operator can remove one path seller by its key");
  ok(isRemovedOrigin(B) && !isRemovedOrigin(A) && !cache.has(B) && cache.has(A), "removing one app leaves the other app on the host");
  removeOrigin(H);
  ok(isRemovedOrigin(A) && !cache.has(A), "removing the bare host covers every path seller on it");
}

__setCrawlFetchForTest(null);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
