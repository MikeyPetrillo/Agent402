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
import {
  bazaarItemToTool,
  mergeOpenapiIntoBazaar,
  normaliseOpenapiTools,
  openapiHasPaymentSignal,
  routeQuery,
  sellerDetail,
  allIndexedTools,
  _cacheForTests,
  _resetFlatCacheForTest,
} from "../src/x402-index.js";
import { requestContractProjection } from "../src/request-contract.js";
import { responseContractProjection } from "../src/response-contract.js";

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

// ---- 1b. annotated documents list free siblings, flagged, and drop deprecated ----
// Revised 2026-07-27 (seller escalation): unannotated operations in an
// annotated document are part of the curated surface the seller publishes —
// they LIST with paid:false (never a buy candidate; routeQuery filters them)
// instead of vanishing. Deprecated stays excluded.
{
  const tools = normaliseOpenapiTools({
    paths: {
      "/paid": {
        post: {
          operationId: "paid",
          "x-payment-info": { price: { amount: "0.01" } },
        },
      },
      "/sample": {
        get: { operationId: "sample" },
      },
      "/legacy": {
        get: {
          operationId: "legacy",
          deprecated: true,
          "x-price": "$0.01",
        },
      },
    },
  }, "https://seller.example");
  ok(tools.length === 2, `paid + flagged-free are indexed, deprecated is not (got ${tools.length})`);
  ok(tools.find((t) => t.slug === "paid")?.paid === true, "the paid operation carries paid:true");
  ok(tools.find((t) => t.slug === "sample")?.paid === false, "the unannotated sibling lists with paid:false");
  ok(!tools.some((t) => t.slug === "legacy"), "deprecated operations stay excluded");
}

// ---- 1c. zero-annotation documents stay inclusive but drop obvious junk ----
{
  const tools = normaliseOpenapiTools({
    servers: [{ url: "/api" }],
    paths: {
      "/verify": {
        get: { operationId: "verify", summary: "Verify an artifact" },
        parameters: [{ name: "trace", in: "header" }],
      },
      "/report": {
        post: { operationId: "report", summary: "Create a report" },
      },
      "/legacy": {
        get: { operationId: "legacy", deprecated: true },
      },
      "/logo.png": {
        get: { operationId: "logo" },
      },
      "/assets/mark.SVG": {
        get: { operationId: "mark" },
      },
      "/robots.txt": {
        get: { operationId: "robots" },
      },
      "/healthz": {
        get: { operationId: "health" },
      },
    },
  }, "https://seller.example");
  ok(tools.length === 2, `two live API operations remain indexed (got ${tools.length})`);
  ok(
    tools.map((tool) => tool.slug).sort().join(",") === "report,verify",
    "zero-annotation documents retain real operations and exclude metadata, deprecated routes, and static assets",
  );
  ok(tools.every((tool) => tool.route.startsWith("/api/")), "base path remains applied");
}

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
{
  const guessed = [{ ...bazaarTools[0], method: "POST", methodInferred: true }];
  const real = [{ ...openapiTools[0], method: "GET" }];
  const merged = mergeOpenapiIntoBazaar(real, guessed);
  ok(merged.length === 1, "method mismatch still merges by route (no duplicate listing)");
  ok(merged[0].slug === "url-to-markdown", "route-only match still overlays metadata");
}

// ---- 3b. OpenAPI keeps the real method and declared price on a weak Bazaar row ----
// Live regression: Anicca publishes GET /research at $0.003 through
// x-payment-info. A Bazaar row with no method/accept amount is normalised as
// POST + null; merging used to keep those guesses and /api/route rendered
// POST + priceUsd:0 even though the OpenAPI document was authoritative.
{
  const openapi = {
    paths: {
      "/research": {
        get: {
          operationId: "research",
          summary: "web research digest",
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.003" },
          },
        },
      },
    },
  };
  const [documented] = normaliseOpenapiTools(openapi, "https://seller.example");
  const guessed = [bazaarItemToTool(
    { resource: "https://seller.example/research", accepts: [] },
    "https://seller.example",
  )];
  const [merged] = mergeOpenapiIntoBazaar([documented], guessed);
  ok(guessed[0].methodInferred === true, "a missing Bazaar method is marked as inferred");
  ok(documented.method === "GET", "OpenAPI normalisation keeps the declared GET method");
  ok(documented.price === "0.003", "x-payment-info amount is normalised as the tool price");
  ok(merged.method === "GET", `OpenAPI method replaces Bazaar's guessed POST (got ${merged.method})`);
  ok(merged.price === "0.003", `OpenAPI price fills an unknown Bazaar amount (got ${merged.price})`);
}

// ---- 3c. Explicit Bazaar observations remain payment truth ----
{
  const documented = [{ ...openapiTools[0], method: "GET", price: "0.003" }];
  const explicit = bazaarItemToTool({
    resource: "https://md.example/md",
    method: "POST",
    accepts: [{ network: "eip155:8453", amount: "9000", extra: { name: "USDC" } }],
  }, "https://md.example");
  const [merged] = mergeOpenapiIntoBazaar(documented, [explicit]);
  ok(explicit.methodInferred === false, "an explicit Bazaar method is not marked as inferred");
  ok(merged.method === "POST", `explicit Bazaar method survives (got ${merged.method})`);
  ok(merged.price === 0.009, `settlement-observed Bazaar price survives (got ${merged.price})`);

  const [free] = mergeOpenapiIntoBazaar(documented, [{ ...explicit, price: 0 }]);
  ok(free.price === 0, `explicit free Bazaar price survives (got ${free.price})`);
}

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
{
  const documented = [{ ...openapiTools[0], method: "GET", price: "0.003" }];
  const observed = [{ ...bazaarTools[0], method: "GET", price: 0.009 }];
  const [merged] = mergeOpenapiIntoBazaar(documented, observed);
  ok(merged.price === 0.003, `a price CUT propagates: the origin's own 0.003 beats a stale settled 0.009 (got ${merged.price})`);
  ok(merged.originDeclaredPrice === 0.003 && merged.priceResolvedFrom === "origin", "the row says which side won and what the origin declared");
  ok(merged.priceConflict === true, "a differing current origin price is visible as a conflict");
  ok(merged.priceObservations?.bazaar === 0.009, "price conflict preserves the Bazaar observation as a number");
  ok(merged.priceObservations?.origin === 0.003, "price conflict preserves the origin observation as a number");
}
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
{
  const documented = [
    { ...openapiTools[0], method: "GET", slug: "read-md" },
    { ...openapiTools[0], method: "POST", slug: "write-md" },
  ];
  const inferred = { ...bazaarTools[0], method: "POST", methodInferred: true };
  const merged = mergeOpenapiIntoBazaar(documented, [inferred]);
  const bazaar = merged.find((t) => t.provenance === "bazaar");
  ok(bazaar.slug === "md", `ambiguous route does not pick an arbitrary operation (got ${bazaar.slug})`);
  ok(bazaar.method === "POST", "ambiguous route keeps the Bazaar hint unchanged");
}

// ---- 3e. An explicit Bazaar verb requires an exact OpenAPI verb match ----
// GET and POST on the same path can be different tools. A route-only merge is
// permitted only for an inferred Bazaar verb; otherwise GET metadata/price can
// silently contaminate an explicitly observed POST listing.
{
  const documented = [{
    ...openapiTools[0],
    method: "GET",
    slug: "read-md",
    description: "GET-only metadata",
    price: "0.003",
  }];
  const explicit = bazaarItemToTool({
    resource: "https://md.example/md",
    method: "POST",
    accepts: [],
  }, "https://md.example");
  const merged = mergeOpenapiIntoBazaar(documented, [explicit]);
  const bazaar = merged.find((t) => t.provenance === "bazaar");
  ok(merged.length === 2, `method mismatch stays as two distinct listings (got ${merged.length})`);
  ok(bazaar.method === "POST", "explicit POST remains POST");
  ok(bazaar.slug === "md", `GET slug does not contaminate POST (got ${bazaar.slug})`);
  ok(bazaar.description !== "GET-only metadata", "GET description does not contaminate POST");
  ok(bazaar.price === null, `GET price does not contaminate POST (got ${bazaar.price})`);
}

// ---- 3f. seller contracts survive only an exact OpenAPI/Bazaar join ----
{
  const operation = (method = "post", operationId = "summarize") => ({
    openapi: "3.0.0",
    paths: {
      "/contracted": {
        [method]: {
          operationId,
          summary: operationId,
          "x-price": "$0.001",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["input"],
              properties: { input: { type: "string" } },
            } } },
          },
          responses: { 200: { content: { "application/json": { schema: {
            type: "object",
            required: ["result"],
            properties: { result: { type: "string" } },
          } } } } },
        },
      },
    },
  });
  const [documented] = normaliseOpenapiTools(operation(), "https://contracts.example");
  const bazaar = {
    seller: "https://contracts.example",
    method: "POST",
    route: "/contracted",
    price: 0.002,
    provenance: "bazaar",
  };

  const [exact] = mergeOpenapiIntoBazaar([documented], [bazaar]);
  ok(requestContractProjection(exact).requestContract?.required?.body?.[0] === "input",
    "an exact Bazaar merge preserves the seller's request contract");
  ok(responseContractProjection(exact).responseContract?.guaranteedPaths?.[0] === "result",
    "an exact Bazaar merge preserves the seller's response contract");

  const [inferred] = mergeOpenapiIntoBazaar(
    [documented],
    [{ ...bazaar, method: "GET", methodInferred: true }],
  );
  ok(inferred.method === "POST" && requestContractProjection(inferred).requestContract?.required?.body?.[0] === "input",
    "a unique inferred-method match preserves the matching operation's contracts");

  const explicitMismatch = mergeOpenapiIntoBazaar(
    [documented],
    [{ ...bazaar, method: "GET", methodInferred: false }],
  );
  const unmatchedBazaar = explicitMismatch.find((t) => t.provenance === "bazaar");
  ok(explicitMismatch.length === 2 && requestContractProjection(unmatchedBazaar).requestContract === undefined &&
    responseContractProjection(unmatchedBazaar).responseContract === undefined,
  "an explicit method mismatch never copies contracts onto the Bazaar row");

  const [documentedGet] = normaliseOpenapiTools(operation("get", "readContracted"), "https://contracts.example");
  const ambiguous = mergeOpenapiIntoBazaar(
    [documented, documentedGet],
    [{ ...bazaar, method: "POST", methodInferred: true }],
  );
  const ambiguousBazaar = ambiguous.find((t) => t.provenance === "bazaar");
  ok(ambiguous.length === 3 && requestContractProjection(ambiguousBazaar).requestContract === undefined &&
    responseContractProjection(ambiguousBazaar).responseContract === undefined,
  "an ambiguous route-only match never copies either operation's contracts");

  const [malformed] = mergeOpenapiIntoBazaar(
    [{ ...documented, requestContract: ["foreign"], responseContract: ["foreign"] }],
    [bazaar],
  );
  ok(requestContractProjection(malformed).requestContract === undefined &&
    responseContractProjection(malformed).responseContract === undefined,
  "malformed packed tuples remain untrusted after the merge and project nothing");

  const { requestContract: _request, responseContract: _response, ...withoutContracts } = documented;
  const [missing] = mergeOpenapiIntoBazaar([withoutContracts], [bazaar]);
  ok(!("requestContract" in missing) && !("responseContract" in missing),
    "an operation with no declared contracts gains no contract fields during the merge");

  const [untrustedBazaar] = mergeOpenapiIntoBazaar(
    [withoutContracts],
    [{
      ...bazaar,
      requestContract: documented.requestContract,
      responseContract: documented.responseContract,
    }],
  );
  ok(!("requestContract" in untrustedBazaar) && !("responseContract" in untrustedBazaar),
    "contract-shaped Bazaar fields are stripped because settlement evidence is not contract authority");

  const [sellerWins] = mergeOpenapiIntoBazaar(
    [documented],
    [{ ...bazaar, requestContract: ["foreign"], responseContract: ["foreign"] }],
  );
  ok(requestContractProjection(sellerWins).requestContract?.required?.body?.[0] === "input" &&
    responseContractProjection(sellerWins).responseContract?.guaranteedPaths?.[0] === "result",
  "the exact matched seller operation replaces hostile Bazaar-shaped contract fields");

  const [unmatchedPoison] = mergeOpenapiIntoBazaar(
    [documented],
    [{
      ...bazaar,
      method: "GET",
      methodInferred: false,
      requestContract: documented.requestContract,
      responseContract: documented.responseContract,
    }],
  );
  ok(!("requestContract" in unmatchedPoison) && !("responseContract" in unmatchedPoison),
    "an unmatched Bazaar row cannot publish well-formed contract-shaped fields");

  const [bazaarOnly] = mergeOpenapiIntoBazaar([], [{
    ...bazaar,
    requestContract: documented.requestContract,
    responseContract: documented.responseContract,
  }]);
  ok(!("requestContract" in bazaarOnly) && !("responseContract" in bazaarOnly),
    "the no-OpenAPI passthrough strips registry contract-shaped fields");

  const [collapsed] = mergeOpenapiIntoBazaar(
    [],
    [{
      ...bazaar,
      route: "/ghosts/abc123",
      requestContract: documented.requestContract,
      responseContract: documented.responseContract,
    }],
    { allRoutes: [{ method: "POST", route: "/ghosts/{id}" }] },
  );
  ok(collapsed.route === "/ghosts/{id}" &&
    !("requestContract" in collapsed) && !("responseContract" in collapsed),
  "a document-template representative cannot publish registry contract-shaped fields");

  let accessorRead = false;
  const accessorBazaar = { ...bazaar };
  Object.defineProperty(accessorBazaar, "requestContract", {
    enumerable: true,
    get() { accessorRead = true; throw new Error("registry contract getter must not run"); },
  });
  const [accessorClean] = mergeOpenapiIntoBazaar([withoutContracts], [accessorBazaar]);
  ok(!accessorRead && !("requestContract" in accessorClean),
    "stripping a registry contract accessor does not execute it");

  const inheritedBazaar = Object.assign(Object.create({
    requestContract: documented.requestContract,
    responseContract: documented.responseContract,
  }), bazaar);
  const [inheritedClean] = mergeOpenapiIntoBazaar([withoutContracts], [inheritedBazaar]);
  ok(!("requestContract" in inheritedClean) && !("responseContract" in inheritedClean),
    "prototype-carried registry contract tuples do not become published evidence");

  const inheritedSeller = { ...withoutContracts };
  Object.setPrototypeOf(inheritedSeller, {
    requestContract: documented.requestContract,
    responseContract: documented.responseContract,
  });
  const [ownOnly] = mergeOpenapiIntoBazaar([inheritedSeller], [bazaar]);
  ok(!("requestContract" in ownOnly) && !("responseContract" in ownOnly),
    "only own seller-operation contract tuples can cross the merge");

  let sellerAccessorRead = false;
  const accessorSeller = { ...withoutContracts };
  Object.defineProperty(accessorSeller, "responseContract", {
    enumerable: true,
    get() { sellerAccessorRead = true; throw new Error("seller contract getter must not run"); },
  });
  const [sellerAccessorClean] = mergeOpenapiIntoBazaar([accessorSeller], [bazaar]);
  ok(!sellerAccessorRead && !("responseContract" in sellerAccessorClean),
    "an accessor-backed seller tuple is refused without executing it");
}

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
// Found live 2026-07-27 (cloudworldmodel.ai): the PayAI registry records every
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
// 3 of cloudworldmodel's 17 paid operations carried ONLY this key and were
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
