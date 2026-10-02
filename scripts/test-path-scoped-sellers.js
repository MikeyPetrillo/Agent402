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

// ---------------------------------------------------------------- a paid route AT the prefix root
// A function host (Supabase edge function, Vercel/Cloudflare function) often
// serves ONE paid endpoint at its own path: GET <prefix>?package=react answers
// 402. The manifest below is the live shape such a seller published
// (2026-10-02); before the fix every row scoped to "/?package=react" was
// dropped, so the seller listed with health 1, toolCount 1, no route and no
// chains, and nothing was ever probed.
{
  const H2 = "https://fn.example.invalid";
  const D = `${H2}/functions/v1/npm-health`;
  const E = `${H2}/functions/v1/landing-app`;
  const PAY_D = "0xf200174de10c26ce7670aaf41d69a8979fe5629d";
  served.set(`${H2}/robots.txt`, { body: "User-agent: *\nAllow: /\n" });
  served.set(`${D}/.well-known/x402`, { body: {
    name: "npm health", description: "npm package health snapshot",
    resources: [`${D}?package=react`],
    endpoints: [{ path: "/?package=react", methods: ["GET"], name: "npm Health Snapshot", description: "Package health", price: "$0.01" }],
    capabilities: { tools: 1 },
    payment: { scheme: "exact", network: "base", asset: "USDC", asset_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", pay_to: PAY_D },
    tools: [{ name: "npm Health Snapshot", method: "GET", url: `${D}?package=react`, price: "$0.01", network: "eip155:8453" }],
  } });
  // E: an UNPRICED row at its prefix root (its landing page) beside one priced
  // route, and a priced row on another app's path. No service-wide payment.
  served.set(`${E}/.well-known/x402`, { body: {
    name: "landing app", capabilities: { tools: 3 },
    resources: [
      { resource: E, method: "GET", description: "Landing page" },
      { resource: `${E}/?tab=docs`, method: "GET", description: "Docs tab" },
      { resource: `${E}/api/x`, method: "GET", description: "Paid x", price: "$0.01", accepts: accepts(PAY_A, "10000") },
      { resource: `${H2}/functions/v1/other/api/y`, method: "GET", price: "$0.01", accepts: accepts(PAY_A, "10000") },
    ],
  } });
  const rD = await submit(D);
  const rE = await submit(E);
  const toolsD = cache.get(D)?.tools || [];
  const toolsE = cache.get(E)?.tools || [];
  ok(rD.listed === true && toolsD.length === 1 && toolsD[0].route === "/?package=react",
    `a priced resource at the prefix root (with a query) is kept as the seller's route (${JSON.stringify(toolsD.map((t) => t.route))})`);
  ok((toolsD[0]?.networks || []).includes("eip155:8453") && String(toolsD[0]?.payToByNetwork?.["eip155:8453"] || "").toLowerCase() === PAY_D,
    `the root route carries its chain and payTo from the manifest (${JSON.stringify(toolsD[0]?.networks)})`);
  const dD = sellerDetail(D);
  ok(dD?.toolCount === 1 && dD.toolsReturned === 1 && dD.tools?.[0]?.route === "/?package=react", `?seller= toolCount and toolsReturned agree (${dD?.toolCount}/${dD?.toolsReturned})`);
  ok((dD?.networks || []).includes("eip155:8453"), `?seller= reports the root route's network (${JSON.stringify(dD?.networks)})`);
  ok(!("declaredToolCount" in (dD || {})), "a manifest count that matches the rows held adds no second figure");
  ok(rE.listed === true && toolsE.length === 1 && toolsE[0].route === "/api/x",
    `an unpriced prefix root (landing page, with or without a query) is not a tool, and another app's path is dropped (${JSON.stringify(toolsE.map((t) => t.route))})`);
  const dE = sellerDetail(E);
  ok(dE?.toolCount === 1 && dE.toolsReturned === 1 && dE.declaredToolCount === 3,
    `toolCount is the rows held; the manifest's own figure rides as declaredToolCount (${JSON.stringify({ c: dE?.toolCount, r: dE?.toolsReturned, d: dE?.declaredToolCount })})`);
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const row = (routeQuery({ query: "npm package health snapshot", top: 5, include: "external", ...ctx }).results || []).find((r) => r.seller === D);
  ok(row?.url === `${D}?package=react`, `a root route's URL is the prefix itself plus the query, not prefix + "/" (${row?.url})`);

  // URL joins: every caller builds seller + route through sellerRouteUrl.
  const { sellerRouteUrl, scopeRowsToSeller, enrichLiveQuotes } = idx;
  ok(sellerRouteUrl(D, "/?package=react") === `${D}?package=react` && sellerRouteUrl(D, "/") === D, "sellerRouteUrl joins a prefix-root route to the prefix itself");
  ok(sellerRouteUrl("https://h.example", "/") === "https://h.example/" && sellerRouteUrl("https://h.example", "/?a=1") === "https://h.example/?a=1", "a bare origin's root route joins as before");

  // scopeRowsToSeller directly: the rule, both directions.
  const scoped = scopeRowsToSeller([
    { route: "/functions/v1/npm-health", method: "GET" },
    { route: "/functions/v1/npm-health?x=1", method: "GET", paid: false },
    { route: "/functions/v1/npm-health", method: "POST", price: "$0.02" },
    { route: "/functions/v1/npm-health?package=a", method: "GET", networks: ["eip155:8453"] },
    { route: "/functions/v1/other", method: "GET", price: "$0.01" },
  ], D);
  ok(JSON.stringify(scoped.map((r) => `${r.method} ${r.route}`)) === JSON.stringify(["POST /", "GET /?package=a"]),
    `scopeRowsToSeller keeps a priced or chained root row only (${JSON.stringify(scoped.map((r) => `${r.method} ${r.route}`))})`);
  const bareRows = [{ route: "/", method: "GET" }];
  ok(scopeRowsToSeller(bareRows, "https://h.example") === bareRows, "a bare origin's rows are untouched");

  // A registry row (minted by a settled payment) at the root is a paid route.
  ok(bazaarItemToTool({ resource: D, method: "GET", accepts: accepts(PAY_D) }, D)?.route === "/", "a registry row with accepts at the prefix root is kept");
  ok(bazaarItemToTool({ resource: D, method: "GET" }, D) === null, "a registry row with no payment terms at the prefix root is not a tool");

  // The live-402 probe asks the prefix itself and learns the route's chains.
  // An IP-literal key keeps the SSRF guard off DNS, so this stays offline.
  const K = "https://1.1.1.1/functions/v1/npm-health";
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: accepts(PAY_D, "10000") })).toString("base64");
  const asked = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    asked.push(`${String(init.method || "GET").toUpperCase()} ${String(url)}`);
    return new Response("{}", { status: 402, headers: { "payment-required": header, "content-type": "application/json" } });
  };
  const origLog = console.log; console.log = () => {};
  const probeRows = [{ seller: K, route: "/?package=react", method: "GET", slug: "npm-health", price: null, networks: [] }];
  try { await enrichLiveQuotes(probeRows, K, { ignoreBudget: true }); } finally { globalThis.fetch = origFetch; console.log = origLog; }
  ok(asked.length > 0 && asked.every((a) => a === `GET ${K}?package=react`), `the probe asks the prefix itself, never prefix + "/" (${JSON.stringify(asked)})`);
  ok((probeRows[0].networks || []).includes("eip155:8453") && Number(probeRows[0].price) > 0, `the probe learns the root route's network and price (${JSON.stringify({ n: probeRows[0].networks, p: probeRows[0].price })})`);
}

__setCrawlFetchForTest(null);

// The registration record's "settled" flag: a path seller is one app on a
// shared host, so another app on that host settling must not mark it settled.
{
  const { __originHasSettledForTest } = await import("../src/x402-index.js");
  const { _setLeaderboardSnapshotForTests } = await import("../src/leaderboard.js");
  _setLeaderboardSnapshotForTests({ leaderboard: [{ callsSettled: 12, origins: ["https://shared.example/app/one"] }] });
  ok(__originHasSettledForTest("https://shared.example/app/one") === true, "a path seller whose own listing settled reads settled");
  ok(__originHasSettledForTest("https://shared.example/app/two") === false, "another app on the same host does not inherit that settlement");
  ok(__originHasSettledForTest("https://shared.example/app/o") === false, "a prefix that is a substring of the settled one does not match (segment boundary)");
  _setLeaderboardSnapshotForTests({ leaderboard: [{ callsSettled: 3, origins: ["https://bare.example"] }] });
  ok(__originHasSettledForTest("https://bare.example") === true, "a bare origin keeps the host match");
  _setLeaderboardSnapshotForTests(null);
}

// sellerRouteUrl: joining seller + route text can never leave the seller.
{
  const { sellerRouteUrl } = await import("../src/x402-index.js");
  ok(sellerRouteUrl("https://h.example/app/one", "/api/x") === "https://h.example/app/one/api/x", "a route under a path seller joins to its own URL");
  ok(sellerRouteUrl("https://h.example", "/api/x?y=1") === "https://h.example/api/x?y=1", "a bare origin route (with a query) joins as before");
  ok(sellerRouteUrl("https://h.example", "@evil.example/x") === null, "a route that would read as credentials + another host is refused");
  ok(sellerRouteUrl("https://h.example", "//evil.example/x") === null, "a protocol-relative route is refused");
  ok(sellerRouteUrl("https://h.example", "https://evil.example/x") === null, "an absolute URL as a route is refused");
  ok(sellerRouteUrl("https://h.example/app/one", "/../two/x") === null, "dot segments that climb out of the prefix are refused");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
