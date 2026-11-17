// Unit tests for the openapi-fallback crawl path in the x402 Index.
//
// Motivating case: a seller with no /.well-known/x402 manifest but a rich
// openapi.json used to land on the Bazaar fallback, whose path-derived slugs
// ("md") score near zero in the router for queries like "html to markdown" —
// while the seller's own openapi carried a term-bearing operationId and
// summary the router never saw. The crawler now reads openapi.json as a
// fallback surface and merges its descriptive fields over the Bazaar's
// payment-proven ones.
//
// Offline, no server, no network: pure helpers + the in-memory cache via the
// _cacheForTests() escape hatch.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  // CLEANROOM 36: implement per spec 36
  mergeOpenapiIntoBazaar,
  // CLEANROOM 36: implement per spec 36
  openapiHasPaymentSignal,
  routeQuery,
  sellerDetail,
  allIndexedTools,
  _cacheForTests,
  _resetFlatCacheForTest,
} from "../src/x402-index.js";
// CLEANROOM 36: implement per spec 36

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

// ---- 1. openapiHasPaymentSignal gates what counts as an x402 surface ----
ok(
  openapiHasPaymentSignal({
    paths: { "/md": { post: { operationId: "md", "x-payment-info": { price: { amount: "0.005" } } } } },
  }),
  "x-payment-info counts as a payment signal",
);
ok(
  openapiHasPaymentSignal({ paths: { "/a": { get: { "x-price": "$0.01" } } } }),
  "x-price counts as a payment signal",
);
ok(
  !openapiHasPaymentSignal({ paths: { "/pets": { get: { operationId: "listPets" } } } }),
  "a plain Swagger site is NOT a payment signal",
);
ok(!openapiHasPaymentSignal(null) && !openapiHasPaymentSignal({}), "null/empty openapi is not a signal");

// CLEANROOM 37: implement per spec 37
// ---- 1b. annotated documents list free siblings, flagged, and drop deprecated ----
// Revised 2026-07-27 (seller escalation): unannotated operations in an
// annotated document are part of the curated surface the seller publishes —
// they LIST with paid:false (never a buy candidate; routeQuery filters them)
// instead of vanishing. Deprecated stays excluded.
// CLEANROOM 38: implement per spec 38
// ---- 2. merge: openapi descriptive fields over Bazaar payment truth ----
const bazaarTools = [
  {
    seller: "https://md.example",
    method: "POST",
    route: "/md",
    slug: "md",
    name: "/md",
    description: "Scrape any web page: URL to Markdown / HTML to Markdown for LLM context.",
    category: "other",
    tags: [],
    price: 0.005,
    networks: ["eip155:8453"],
    payToByNetwork: { "eip155:8453": "0x072F3a2bD93bB75b1Eb84a9E45D17a4F90a6D801" },
    provenance: "bazaar",
  },
];
const openapiTools = [
  {
    seller: "https://md.example",
    method: "POST",
    route: "/md",
    slug: "url-to-markdown",
    name: "Scrape any web page: URL to Markdown / HTML to Markdown for LLM context",
    description: "Give it a URL, get back LLM-ready Markdown.",
    category: "markdown",
    tags: ["markdown", "scraping"],
    price: "0.005",
  },
  {
    seller: "https://md.example",
    method: "POST",
    route: "/extract",
    slug: "extract-structured-data",
    name: "Extract structured JSON from a web page",
    description: "Schema-guided extraction.",
    category: "extraction",
    tags: ["extraction"],
    price: "0.01",
  },
];
{
  const merged = mergeOpenapiIntoBazaar(openapiTools, bazaarTools);
  ok(merged.length === 2, `merge yields both routes (got ${merged.length})`);
  const md = merged.find((t) => t.route === "/md");
  ok(md.slug === "url-to-markdown", "openapi operationId wins the slug");
  ok(md.name.includes("HTML to Markdown"), "openapi summary wins the name");
  ok(md.price === 0.005, "Bazaar's settlement-proven price is kept");
  ok(md.payToByNetwork["eip155:8453"], "Bazaar payTo survives the merge");
  ok(md.networks.length === 1, "Bazaar networks survive the merge");
  ok(md.tags.includes("markdown"), "openapi tags win when present");
  const extract = merged.find((t) => t.route === "/extract");
  ok(extract && extract.slug === "extract-structured-data", "openapi-only route is appended");
}

// ---- 3. merge matches by route when Bazaar guessed the method wrong ----
// CLEANROOM 39: implement per spec 39

// CLEANROOM 39: implement per spec 39
// ---- 3d. Same-route price disagreement stays observable ----
// The ORIGIN'S OWN CURRENT DECLARATION wins, both directions (changed
// 2026-08-29, issue #1043). This supersedes the earlier max() rule, and
// deliberately: max() could only ever ratchet a price UP, so a seller's cut
// was invisible forever (measured: a 10x overquote standing nine days, and a
// second seller with 21 routes overquoted 2x-10x). Preferring the origin
// STRICTLY DOMINATES max() - in the raised-price case below the origin is
// also the higher figure, so that protection is unchanged. Neither direction
// risks money: this price ranks and displays, and the router re-quotes from
// the seller's LIVE 402 before it spends. Where the two disagree by >=2x the
// crawler now re-probes that 402, so ground truth arrives within a crawl
// instead of never.
// CLEANROOM 39: implement per spec 39
{
  // SameDayDesk shape: stale Bazaar $0.02 vs origin $0.05 — never underquote.
  const documented = [{ ...openapiTools[0], method: "GET", price: "0.05" }];
  const observed = [{ ...bazaarTools[0], method: "GET", price: 0.02 }];
  const [merged] = mergeOpenapiIntoBazaar(documented, observed);
  ok(merged.price === 0.05, "higher origin observation wins the routing price (got " + merged.price + ")");
  ok(merged.priceConflict === true, "raised origin vs stale bazaar is flagged");
  ok(merged.priceObservations?.bazaar === 0.02 && merged.priceObservations?.origin === 0.05,
    "both observations survive normalized");
}

// ---- 3e. Route-only fallback refuses ambiguous OpenAPI paths ----
// CLEANROOM 39: implement per spec 39
// CLEANROOM 40: implement per spec 40
// ---- 4. degenerate inputs pass through ----
ok(mergeOpenapiIntoBazaar([], bazaarTools).length === 1, "no openapi → Bazaar tools pass through");
ok(mergeOpenapiIntoBazaar(openapiTools, []).length === 2, "no Bazaar → openapi tools pass through");
ok(mergeOpenapiIntoBazaar([], []).length === 0, "nothing in, nothing out");

// ---- 5. end-to-end ranking: the merged listing is actually findable ----
const cache = _cacheForTests();
cache.clear();
const ctx = {
  baseUrl: "https://agent402.tools",
  catalog: {},
  prices: {},
  network: "base",
  toolCount: 0,
  walletName: "agent402.base.eth",
};
function seed(origin, tools) {
  cache.set(origin, {
    manifest: { name: origin.replace(/^https?:\/\//, ""), homepage: origin, synthesized: true },
    tools,
    fetchedAt: Date.now(),
    error: null,
    history: [1, 1, 1, 1, 1],
  });
}
// A competitor shaped like today's 21-scorers, and the merged seller both ways.
seed("https://competitor.example", [
  {
    seller: "https://competitor.example",
    method: "POST",
    route: "/html-to-markdown",
    slug: "html_to_markdown",
    name: "Convert HTML to Markdown.",
    description: "Convert HTML to Markdown. Strips boilerplate.",
    category: "other",
    tags: [],
    price: 0.001,
  },
]);
seed("https://md.example", mergeOpenapiIntoBazaar(openapiTools, bazaarTools));
{
  const conflictTools = mergeOpenapiIntoBazaar(
    [{ ...openapiTools[0], method: "GET", price: "0.003", seller: "https://price-conflict.example" }],
    [{ ...bazaarTools[0], method: "GET", price: 0.009, seller: "https://price-conflict.example" }],
  ).map((t) => ({ ...t, seller: "https://price-conflict.example" }));
  seed("https://price-conflict.example", conflictTools);
  const detail = sellerDetail("price-conflict.example");
  const tool = detail?.tools?.find((item) => item.route === "/md");
  ok(tool?.priceConflict === true, "seller detail exposes a price conflict");
  ok(tool?.priceObservations?.bazaar === 0.009, "seller detail exposes the registry observation");
  ok(tool?.priceObservations?.origin === 0.003, "seller detail exposes the origin observation as a number");
  ok(tool?.price === 0.003, `seller detail routing price is the ORIGIN's own declaration, so a cut propagates (got ${tool?.price})`);

  const routed = routeQuery({ query: "url to markdown", top: 5, include: "external", ...ctx });
  const row = routed.results.find((x) => x.seller === "https://price-conflict.example" && x.route === "/md");
  ok(!!row, "routeQuery surfaces the conflict seller");
  ok(row?.priceConflict === true, "routeQuery exposes a price conflict");
  ok(row?.priceObservations?.bazaar === 0.009 && row?.priceObservations?.origin === 0.003,
    "routeQuery exposes both normalized observations");
  ok(row?.priceUsd === 0.003, "routeQuery priceUsd is the origin\'s own declaration, so a cut reaches the router");

  _resetFlatCacheForTest();
  const listed = allIndexedTools({ excludeOrigin: "https://agent402.tools", limit: 500 });
  const flatRow = listed.results.find((x) => x.seller === "https://price-conflict.example" && x.route === "/md");
  ok(flatRow?.priceConflict === true, "index/tools exposes a price conflict");
  ok(flatRow?.priceObservations?.origin === 0.003, "index/tools exposes origin observation");
}
{
  // "url to markdown" is the seller's own operationId phrasing — the merged
  // slug carries every term and must now WIN outright.
  const r = routeQuery({ query: "url to markdown", top: 5, include: "external", ...ctx });
  const md = r.results.find((x) => x.seller === "https://md.example" && x.route === "/md");
  const comp = r.results.find((x) => x.seller === "https://competitor.example");
  ok(md && comp, "both sellers listed for 'url to markdown'");
  ok(md.score > comp.score, `merged listing wins its own phrasing (md ${md.score} vs competitor ${comp.score})`);
}
{
  // "html to markdown" only appears in name/description, not the slug — the
  // merged listing scores lower than a slug-exact competitor but must still
  // surface in the shortlist (pre-merge it scored 3 and was cut).
  const r = routeQuery({ query: "html to markdown", top: 5, include: "external", ...ctx });
  const md = r.results.find((x) => x.seller === "https://md.example" && x.route === "/md");
  ok(md, "merged listing surfaces for 'html to markdown'");
  ok(md.score >= 15, `name/description terms lift the score well above the Bazaar-only 3 (got ${md.score})`);
}
// Control: the old Bazaar-only shape stays buried — proves the merge is what fixed it.
seed("https://md.example", bazaarTools);
{
  const r = routeQuery({ query: "html to markdown", top: 5, include: "external", ...ctx });
  const md = r.results.find((x) => x.seller === "https://md.example");
  const comp = r.results.find((x) => x.seller === "https://competitor.example");
  ok(comp && (!md || md.score < comp.score), "Bazaar-only shape scores below the competitor (the pre-fix bug)");
}

cache.clear();
console.log("openapi-fallback tests passed");

// ── servers[] basePath (regression, 2026-07-26) ──────────────────────────────
// OpenAPI paths are relative to servers[].url. Ignoring that prefix meant a
// seller declaring server ".../api" and path "/foo" was indexed as route "/foo"
// while Bazaar/PayAI discovery reported the real "/api/foo" — so the merge
// never matched and the seller's summary/description/tags were dropped. Their
// tools sat in the index with an empty description and the raw path as a name,
// which the Smart Order Router can only rank on path tokens. Found via Cloud
// World Model: 106 endpoints, invisible to every semantic query.
{
  const { openapiBasePath } = await import("../src/x402-index.js");

  const spec = {
    openapi: "3.1.0",
    servers: [
      { url: "https://www.example.ai/api", description: "Production" },
      { url: "http://127.0.0.1:5000/api", description: "Local development" },
    ],
    paths: {
      "/multi-cloud/explore": {
        post: {
          summary: "Explore multi-cloud deployment strategies",
          description: "Analyze a workload profile and generate optimized strategies.",
          tags: ["Optimize & Predict"],
        },
      },
      "/health": { get: { summary: "health" } },
    },
  };

  const base = openapiBasePath(spec, "https://www.example.ai");
  ok(base === "/api", `basePath should be /api, got ${base}`);

  const tools = normaliseOpenapiTools(spec, "https://www.example.ai");
  const explore = tools.find((t) => /multi-cloud/.test(t.route));
  ok(explore, "explore route should be present");
  ok(explore.route === "/api/multi-cloud/explore", `route should carry the basePath, got ${explore.route}`);
  ok(explore.name === "Explore multi-cloud deployment strategies", "summary should become the name");
  ok(/Analyze a workload profile/.test(explore.description), "description should survive");
  ok(!tools.some((t) => /health/.test(t.route)), "health check must still be skipped under a basePath");

  // The whole point: the merge must now match what discovery actually reports.
  const fromDiscovery = [{
    seller: "https://www.example.ai", method: "POST", route: "/api/multi-cloud/explore",
    slug: "api-multi-cloud-explore", name: "/api/multi-cloud/explore", description: "", category: "other", tags: [],
  }];
  const merged = mergeOpenapiIntoBazaar(tools, fromDiscovery);
  const m = merged.find((t) => t.route === "/api/multi-cloud/explore");
  ok(m && /Analyze a workload profile/.test(m.description), "merged tool must inherit the OpenAPI description");
  ok(m.name === "Explore multi-cloud deployment strategies", "merged tool must inherit the summary as its name");
  ok(m.category === "Optimize & Predict", "merged tool must inherit the tag as its category");

  // A spec that already repeats the prefix must not be double-prefixed.
  const repeated = normaliseOpenapiTools(
    { servers: [{ url: "https://www.example.ai/api" }], paths: { "/api/thing": { get: { summary: "t" } } } },
    "https://www.example.ai",
  );
  ok(repeated[0].route === "/api/thing", `must not double-prefix, got ${repeated[0].route}`);

  // No servers block = unchanged behaviour.
  const noServers = normaliseOpenapiTools({ paths: { "/thing": { get: { summary: "t" } } } }, "https://www.example.ai");
  ok(noServers[0].route === "/thing", "no servers => route unchanged");

  console.log("ok - openapi servers[] basePath is applied, merged, and never double-prefixed");
}

// ---- 8. per-instance registry rows collapse into templated operations ----
// Found live 2026-07-27 (bigworldmodel.example): the PayAI registry records every
// settled URL verbatim, so one templated operation appeared as 58 concrete
// UUID rows and a 42-operation seller listed as "72 tools".
{
  const { openapiAllOperationRoutes } = await import("../src/x402-index.js");
  const origin = "https://sim.example";
  const doc = {
    paths: {
      "/sims/{simId}/step": { post: { operationId: "stepSim", summary: "Step a simulation", "x-payment-info": { price: { amount: "0.001" } } } },
      "/sims/{simId}/batch": { post: { operationId: "batchSim", summary: "Batch step" } }, // unannotated in an annotated doc -> not indexed
      "/chaos/run": { post: { operationId: "chaosRun", summary: "Run chaos", "x-payment-info": { price: { amount: "0.002" } } } },
    },
  };
  const openapiTools = normaliseOpenapiTools(doc, origin);
  ok(openapiTools.length === 3, `annotated doc lists paid + flagged-free ops (got ${openapiTools.length})`);
  ok(openapiTools.find((t) => t.route === "/sims/{simId}/batch")?.paid === false, "the unannotated op carries paid:false");
  const inst = (route) => ({ seller: origin, method: "POST", route, slug: route, name: route, description: "", category: "other", tags: [], price: 0.001 });
  const registry = [
    inst("/sims/aaaa-1111/step"),
    inst("/sims/bbbb-2222/step"),
    inst("/sims/cccc-3333/step"),
    inst("/sims/aaaa-1111/batch"),
    inst("/sims/bbbb-2222/batch"),
    inst("/unrelated/route"),
  ];
  const merged = mergeOpenapiIntoBazaar(openapiTools, registry, { allRoutes: openapiAllOperationRoutes(doc, origin) });
  const steps = merged.filter((t) => t.route === "/sims/{simId}/step");
  ok(steps.length === 1, `3 instances of an indexed templated op collapse to ONE row (got ${steps.length})`);
  ok(steps[0].name === "Step a simulation", "collapsed row carries the operation's metadata");
  ok(!merged.some((t) => /aaaa|bbbb|cccc/.test(t.route)), "no concrete UUID route survives the collapse");
  const batches = merged.filter((t) => t.route === "/sims/{simId}/batch");
  ok(batches.length === 1, `instances of a flagged-free op collapse to one row (got ${batches.length})`);
  ok(batches[0].paid === true, "a settled registry instance flips the doc's paid:false — observed truth wins");
  ok(merged.some((t) => t.route === "/unrelated/route"), "a row matching no template passes through untouched");
  ok(merged.some((t) => t.route === "/chaos/run"), "unmatched openapi ops still appended");
  ok(merged.length === 4, `expected 4 rows: step + batch + unrelated + chaos (got ${merged.length})`);

  // Back-compat: the two-argument call keeps working (indexed templates still
  // collapse; unindexed doc ops have no template list, instances pass through).
  const legacy = mergeOpenapiIntoBazaar(openapiTools, registry);
  ok(legacy.filter((t) => t.route === "/sims/{simId}/step").length === 1, "two-arg call still collapses indexed templates");
  console.log("ok - per-instance registry rows collapse into templated operations");
}

// ---- 9. x-x402-price-usdc counts as a payment annotation ----
// 3 of bigworldmodel's 17 paid operations carried ONLY this key and were
// silently dropped from an annotated document.
{
  const doc = {
    paths: {
      "/a": { post: { operationId: "a", "x-payment-info": { price: { amount: "0.001" } } } },
      "/b": { post: { operationId: "b", "x-x402-price-usdc": "$0.0010" } },
      "/c": { post: { operationId: "c" } },
    },
  };
  ok(openapiHasPaymentSignal({ paths: { "/b": doc.paths["/b"] } }), "x-x402-price-usdc alone is a payment signal");
  const tools = normaliseOpenapiTools(doc, "https://sim.example");
  ok(tools.length === 3, `usdc-annotated + payment-info + flagged-free are all listed (got ${tools.length})`);
  ok(tools.find((t) => t.route === "/b")?.paid === true, "usdc-annotated op is paid");
  ok(tools.find((t) => t.route === "/c")?.paid === false, "unannotated sibling lists as free");
  ok(tools.find((t) => t.route === "/b")?.price === "$0.0010", "usdc price flows into the tool price");
  console.log("ok - x-x402-price-usdc recognized as a paid-operation annotation");
}

// ---- 10. paid:false tools list but never route, and sellerDetail exposes them ----
{
  const { sellerDetail } = await import("../src/x402-index.js");
  const cache10 = _cacheForTests();
  cache10.clear();
  const mk = (route, paid, extra = {}) => ({
    seller: "https://freemium.example", method: "POST", route,
    slug: route.replace(/^\//, "").replace(/\//g, "-"),
    name: `frobnicate ${route}`, description: "frobnicate the widget", category: "other", tags: ["frobnicate"],
    price: paid === false ? null : 0.005, ...(paid !== undefined ? { paid } : {}), ...extra,
  });
  cache10.set("https://freemium.example", {
    manifest: { name: "freemium.example", homepage: "https://freemium.example" },
    tools: [mk("/frob-paid", true), mk("/frob-free", false)],
    fetchedAt: Date.now(),
    error: null,
    history: [1, 1, 1, 1, 1],
  });
  const ctx10 = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const { results } = routeQuery({ query: "frobnicate widget", top: 10, include: "external", ...ctx10 });
  ok(results.some((r) => r.route === "/frob-paid"), "the paid tool routes");
  ok(!results.some((r) => r.route === "/frob-free"), "the free-flagged tool is never a buy candidate");
  const detail = sellerDetail("freemium.example");
  ok(detail && detail.toolCount === 2, `sellerDetail counts the full listed surface (got ${detail?.toolCount})`);
  ok(detail.tools.some((t) => t.route === "/frob-free" && t.paid === false), "sellerDetail shows the free tool with its flag");
  ok(detail.tools.some((t) => t.route === "/frob-paid" && t.paid === true), "sellerDetail shows the paid tool with its flag");
  ok(sellerDetail("https://freemium.example")?.origin === "https://freemium.example", "full-origin lookup works");
  ok(sellerDetail("nope.example") === null, "unknown seller is null");
  cache10.clear();
  console.log("ok - free-flagged tools list on the seller but never route; sellerDetail drill-down works");
}

// ---- 11. the paid split is visible: paidToolCount on snapshot + sellerDetail ----
{
  const { indexSnapshot, sellerDetail } = await import("../src/x402-index.js");
  const cache11 = _cacheForTests();
  cache11.clear();
  const tool = (route, paid) => ({ seller: "https://split.example", method: "POST", route, slug: route.slice(1), name: route, description: "", category: "other", tags: [], price: paid ? 0.005 : null, ...(paid !== undefined ? { paid } : {}) });
  cache11.set("https://split.example", {
    manifest: { name: "split.example", homepage: "https://split.example" },
    tools: [tool("/a", true), tool("/b", false), tool("/c", false)],
    fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1],
  });
  cache11.set("https://noflags.example", {
    manifest: { name: "noflags.example", homepage: "https://noflags.example" },
    tools: [tool("/x", undefined), tool("/y", undefined)],
    fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1],
  });
  const ctx11 = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 10, walletName: "w" };
  const snap = indexSnapshot(ctx11);
  const split = snap.sellers.find((x) => x.origin === "https://split.example");
  ok(split.toolCount === 3 && split.paidToolCount === 1, `split seller: 3 tools, 1 paid (got ${split.toolCount}/${split.paidToolCount})`);
  const noflags = snap.sellers.find((x) => x.origin === "https://noflags.example");
  ok(noflags.paidToolCount === undefined, "a seller without paid flags reports no split (unknown, not zero)");
  ok(snap.totals.tools === 15, `totals.tools counts the full surface (got ${snap.totals.tools})`);
  // paidTools: local 10 + split 1 + noflags 2 (unknown split presumed buyable — those rows route today)
  ok(snap.totals.paidTools === 13, `totals.paidTools counts the buyable subset (got ${snap.totals.paidTools})`);
  ok(sellerDetail("split.example")?.paidToolCount === 1, "sellerDetail carries the split too");
  cache11.clear();
  console.log("ok - paid split visible on snapshot totals, seller rows, and sellerDetail");
}

// ---- 12. unrecognized payment-ish annotation keys surface, known ones stay quiet ----
// In an annotated document an unrecognized price key silently DELETES paid ops
// (they read as unannotated); the dialect watch makes the next one announce
// itself in the crawl logs instead of waiting for a seller escalation.
{
  const { unknownPaymentishKeys } = await import("../src/x402-index.js");
  const doc = {
    paths: {
      "/a": { post: { "x-payment-info": { price: { amount: "0.01" } }, "x-x402-call-type": "sync" } },
      "/b": { post: { "x-402-fee-usd": "0.002", "x-codeSamples": [] } },
      "/c": { get: { "x-pricing-tier": "pro", "x-rate-limit": 10 } },
    },
  };
  const keys = unknownPaymentishKeys(doc);
  ok(keys.includes("x-402-fee-usd"), "an unknown fee key is flagged");
  ok(keys.includes("x-pricing-tier"), "an unknown pricing key is flagged");
  ok(!keys.includes("x-payment-info"), "recognized keys are not flagged");
  ok(!keys.includes("x-x402-call-type"), "known payment-ish lookalikes stay quiet");
  ok(!keys.includes("x-codesamples") && !keys.includes("x-rate-limit"), "non-payment x- keys stay quiet");
  ok(unknownPaymentishKeys({ paths: { "/a": { post: { "x-payment-info": {} } } } }).length === 0, "a fully recognized doc flags nothing");
  ok(unknownPaymentishKeys(null).length === 0, "null doc is empty, not a crash");
  console.log("ok - unknown payment-annotation dialects surface, known ones stay quiet");
}

// ---- 11. a failed fallback says WHICH file failed and why ----
// A seller whose manifest 403s and whose /openapi.json we could not read saw
// only "probe backed off: /.well-known/x402" (2026-09-30 report). The record
// now carries one reason per fallback surface, and sellerDetail publishes it.
{
  const { sellerDetail } = await import("../src/x402-index.js");
  const c11 = _cacheForTests();
  c11.set("https://failing-fallback.example", {
    manifest: { name: "failing-fallback.example", homepage: "https://failing-fallback.example" },
    tools: [], fetchedAt: Date.now(), error: "probe backed off: /.well-known/x402",
    fallbackErrors: [{ path: "/openapi.json", error: "HTTP 403" }, { path: "/llms.txt", error: "HTTP 404" }],
    history: [0, 0],
  });
  const d = sellerDetail("failing-fallback.example");
  ok(Array.isArray(d?.fallbackErrors) && d.fallbackErrors[0].path === "/openapi.json" && d.fallbackErrors[0].error === "HTTP 403", "sellerDetail names the fallback file and its failure");
  c11.set("https://fine.example", { manifest: { name: "fine.example" }, tools: [], fetchedAt: Date.now(), error: null, history: [1] });
  ok(!("fallbackErrors" in (sellerDetail("fine.example") || {})), "a record with no fallback failure carries no fallbackErrors field");
  // Pinned from source: every fallback surface records its failure, a fallback
  // that served the catalogue clears it, and the failure record writes it.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  for (const p of ["/openapi.json", "/agents.json", "/llms.txt"]) ok(src.includes(`noteFallback("${p}", e)`), `a thrown ${p} read is recorded`);
  ok(src.includes(`noteFallback("/openapi.json", "no payment annotation on any operation")`), "an openapi with no payment signal is recorded, not silent");
  ok(src.includes("fallbackErrors: openapiTools.length ? undefined : fallbackErrors"), "a fallback that served the catalogue clears the reasons");
  ok(/robotsBlocked: Boolean\(e\?\.robotsBlocked\) \|\| undefined,\s*fallbackErrors,/.test(src), "the crawl-failed record carries the reasons");
  ok(/discoveryPath: WELL_KNOWN_PATH,\s*fallbackErrors: undefined,/.test(src), "a manifest that parsed clears stale reasons");
  console.log("ok - fallback failures name the file and the reason");
}

// ---- 12. allPayToPrices: the listing prices the crawl knows per Base payTo ----
{
  const { allPayToPrices } = await import("../src/x402-index.js");
  const c12 = _cacheForTests();
  const W = "0xcccccccccccccccccccccccccccccccccccccccc";
  c12.set("https://priced.example", { manifest: {}, fetchedAt: Date.now(), error: null, history: [1], tools: [
    { price: 0.01, payToByNetwork: { "eip155:8453": W.toUpperCase().replace("0X", "0x") } },
    { price: "$0.05", payToByNetwork: { "eip155:8453": W } },
    { price: 0.02, paid: false, payToByNetwork: { "eip155:8453": W } },
    { price: null, payToByNetwork: { "eip155:8453": W } },
    { price: 0.003, payToByNetwork: { "eip155:137": W } },
  ] });
  const got = allPayToPrices("eip155:8453").get(W);
  ok(got instanceof Set && got.size === 2 && got.has(10000) && got.has(50000), `Base prices only, free and unreadable rows skipped, wallet lowercased (got ${got && [...got]})`);
  ok(allPayToPrices("eip155:137").get(W)?.has(3000), "the network argument selects that network's payTo");
  console.log("ok - allPayToPrices reads each wallet's listed prices from the crawl");
}

// ---- An OpenAPI document whose servers[] are all other hosts ----------------
// Its paths are the other host's endpoints. Filed under the origin serving the
// document they are routes that do not exist there, so the document gives no
// rows; a same-host, relative or development server still sets the base path.
{
  const { openapiBasePath, openapiAllOperationRoutes } = await import("../src/x402-index.js");
  const doc = { openapi: "3.1.0", servers: [{ url: "https://rail-a.other.example" }, { url: "https://rail-b.other.example" }],
    paths: { "/vendor/v1/lookup": { get: { summary: "Lookup", "x-price": "$0.10" } } } };
  ok(openapiBasePath(doc, "https://api.seller.example") === null, "servers naming only other hosts read as another host's document");
  ok(normaliseOpenapiTools(doc, "https://api.seller.example").length === 0, "no rows are filed under the serving origin for another host's paths");
  ok(openapiAllOperationRoutes(doc, "https://api.seller.example").length === 0, "no declared routes either");
  const mixedCase = { ...doc, servers: [{ url: "https://API.Seller.example/v2" }] };
  ok(openapiBasePath(mixedCase, "https://api.seller.example") === "/v2", "the same host in another case is this seller");
  ok(openapiBasePath({ ...doc, servers: [{ url: "https://www.api.seller.example/v2" }] }, "https://api.seller.example") === "/v2", "a www. server is this seller");
  ok(openapiBasePath({ ...doc, servers: [{ url: "http://localhost:8080/api" }] }, "https://api.seller.example") === "/api", "a development server still gives the base path");
  ok(openapiBasePath({ ...doc, servers: [{ url: "https://rail-a.other.example" }, { url: "/api" }] }, "https://api.seller.example") === "/api", "a relative server wins over another host");
  ok(openapiBasePath({ ...doc, servers: [{ url: "https://{env}.seller.example/api" }] }, "https://api.seller.example") !== null, "an unparseable templated server is not another host");
  console.log("ok - an OpenAPI document naming only other hosts gives this origin no rows");
}

// ---- Display names for a mainnet fold onto its chain id ---------------------
{
  const { openapiOperationPayment } = await import("../src/x402-index.js");
  const p = openapiOperationPayment({ "x-payment-info": { price: "$0.01", network: "Algorand MainNet", payTo: "ALGOADDR" } });
  ok(p.networks.length === 1 && p.networks[0].startsWith("algorand:wGHE2Pwd"), `"Algorand MainNet" reads as the Algorand mainnet id (got ${p.networks})`);
  ok(p.payToByNetwork[p.networks[0]] === "ALGOADDR", "the payTo is keyed by the folded id");
  ok(openapiOperationPayment({ "x-payment-info": { price: "$0.01", network: "Solana Mainnet-Beta" } }).networks[0]?.startsWith("solana:5eykt"), "Solana Mainnet-Beta folds onto Solana mainnet");
  const unk = openapiOperationPayment({ "x-payment-info": { price: "$0.01", network: "Some Private Chain", payTo: "X" } });
  ok(unk.networks.length === 0 && Object.keys(unk.payToByNetwork).length === 0, "an unknown display name is dropped, not kept as a network");
  ok(openapiOperationPayment({ "x-payment-info": { price: "$0.01", network: "Base Sepolia" } }).networks.length === 0, "a testnet display name never folds onto a mainnet");
  console.log("ok - mainnet display names fold, unknown names drop");
}
