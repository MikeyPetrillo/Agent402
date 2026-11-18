// Seller-index behavior with no network: which OpenAPI operations are listed,
// when a document counts as selling, the unfiltered operation list used for
// template collapse, how the registry merge copies and joins rows, and when a
// generated deployment hostname is folded into a durable domain as an alias.
import "./lib/offline-stores.js"; // pins per-process stores before any src/ import (see the file)
import {
  normaliseOpenapiTools,
  mergeOpenapiIntoBazaar,
  openapiAllOperationRoutes,
  openapiHasPaymentSignal,
  computeAliasOrigins,
  _cacheForTests,
} from "../src/x402-index.js";

const SITE = "https://seller.example";
const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };
const asText = (v) => JSON.stringify(v);
const verbRoutes = (rows) => rows.map((r) => `${r.method} ${r.route}`).sort();
const sameList = (a, b) => asText(a) === asText([...b].sort());

// ---- part A: operations that are listed ----
{
  // [path, path item, listed as]; listed as null means no row.
  const table = [
    ["/admin/users", { get: {} }, null],
    ["/Internal/jobs", { get: {} }, null],
    ["/.well-known/thing", { get: {} }, null],
    ["/sitemap", { get: {} }, null],
    ["/favicon", { get: {} }, null],
    ["/llms-full", { get: {} }, null],
    ["/openapi-v2", { get: {} }, null],
    ["/healthz", { get: {} }, null],
    ["/robotsx", { get: {} }, null],
    ["/feed.XML", { get: {} }, null],
    ["/icon.ico", { get: {} }, null],
    ["/assets/mark.SVG", { get: {} }, null],
    ["/v1/admin", { get: {} }, ["GET /v1/admin"]],
    ["/convert", { HEAD: {}, Options: {}, trace: {}, connect: {}, post: null, summary: "text" }, ["HEAD /convert", "OPTIONS /convert"]],
    ["/kept", { get: { deprecated: "true" } }, ["GET /kept"]],
    ["/gone", { get: { deprecated: true } }, null],
  ];
  const doc = { paths: Object.fromEntries(table.map(([p, item]) => [p, item])) };
  const listed = verbRoutes(normaliseOpenapiTools(doc, SITE));
  const expected = table.flatMap(([, , as]) => as || []);
  want(sameList(listed, expected), `listed operations ${asText(listed)} should be ${asText(expected.sort())}`);

  const under = (server, path) => normaliseOpenapiTools({ servers: [{ url: server }], paths: { [path]: { get: {} } } }, SITE);
  want(under("/internal", "/report").length === 0, "a server prefix of /internal hides /report");
  const api = under("/api", "/report");
  want(api.length === 1 && api[0].route === "/api/report", "a server prefix of /api lists /api/report");
}
{
  const annotated = normaliseOpenapiTools({ paths: {
    "/priced": { post: { "x-price": "$0.02" } },
    "/plain": { get: {} },
    "/zero": { get: { "x-price": "$0" } },
    "/declared-free": { get: { "x-payment-required": false } },
  } }, SITE);
  const paid = Object.fromEntries(annotated.map((r) => [r.route, r.paid]));
  want(asText(paid) === asText({ "/priced": true, "/plain": false, "/zero": false, "/declared-free": false }),
    `paid flags in an annotated document: ${asText(paid)}`);
  const bare = normaliseOpenapiTools({ paths: { "/a": { get: {} }, "/b": { post: {} } } }, SITE);
  want(bare.length === 2 && bare.every((r) => !Object.hasOwn(r, "paid")), "rows of an unannotated document carry no paid field");
}

// ---- part B: does the document sell anything ----
for (const [doc, expected, why] of [
  [{ paths: { "/a": { get: { "x-payment-required": "TRUE" } } } }, true, "payment-required written as TRUE"],
  [{ paths: { "/health": { get: { "x-price": "$0.01", deprecated: true } } } }, true, "a priced operation the listing would drop"],
  [{ paths: { "/a": [{ "x-price": "$0.01" }] } }, true, "a path item given as an array"],
  [{ paths: { "/a": { get: { "x-price": "$0" } } } }, false, "a zero price alone"],
  [{ paths: { "/a": { get: { "x-payment-required": false } } } }, false, "payment-required false"],
  [{ paths: "nope" }, false, "paths as text"],
  [{ paths: { "/a": null, "/b": { get: null, post: "x" } } }, false, "null and text operations"],
  ["x", false, "a document that is text"],
  [null, false, "null"],
  [{}, false, "no paths"],
]) {
  want(openapiHasPaymentSignal(doc) === expected, `payment signal for ${why} should be ${expected}`);
}

// ---- part C: every declared operation, unfiltered ----
{
  const doc = { servers: [{ url: "/api" }], paths: {
    "/logo.png": { get: {} },
    "/old": { post: { deprecated: true } },
    "/api/already": { put: {} },
    "/x": { trace: {}, Delete: {} },
    "/null": { get: null },
  } };
  const all = verbRoutes(openapiAllOperationRoutes(doc, SITE));
  want(sameList(all, ["GET /api/logo.png", "POST /api/old", "PUT /api/already", "DELETE /api/x"]), `unfiltered operations: ${asText(all)}`);
  const shapes = openapiAllOperationRoutes(doc, SITE).map((r) => Object.keys(r).sort().join(","));
  want(shapes.every((s) => s === "method,route"), "each listed operation is just { method, route }");
  for (const [doc2, why] of [[null, "null"], [{}, "no paths"], [{ servers: [{ url: "https://elsewhere.example" }], paths: { "/a": { get: {} } } }, "another public host only"]]) {
    want(openapiAllOperationRoutes(doc2, SITE).length === 0, `no operations for ${why}`);
  }
}

// ---- part D: the registry merge copies rows and joins carefully ----
{
  const tag = Symbol("tag");
  const registryRow = { seller: SITE, method: "POST", route: "/r", slug: "r", price: 0.01, [tag]: true };
  const [passed] = mergeOpenapiIntoBazaar([], [registryRow]);
  want(passed !== registryRow, "a passthrough is a new object");
  want(passed[tag] === undefined, "a symbol key is not carried through");
  want(passed.route === "/r" && passed.slug === "r" && passed.price === 0.01, "a passthrough keeps the string-keyed fields");
  const ordered = { seller: SITE, method: "GET", route: "/p", slug: "p" };
  const [copy] = mergeOpenapiIntoBazaar([], [ordered]);
  want(copy !== ordered && asText(Object.keys(copy)) === asText(Object.keys(ordered)), "a plain copy keeps the field order");
  const [joined] = mergeOpenapiIntoBazaar([{ method: "POST", route: "/r", slug: "doc-slug" }], [registryRow]);
  want(joined !== registryRow && joined[tag] === undefined && joined.slug === "doc-slug", "a joined row is new, enriched and symbol-free");
  want(registryRow.slug === "r" && registryRow[tag] === true, "the registry row itself is unchanged");
}
{
  const guessed = { method: "POST", route: "/x", methodInferred: true, slug: "registry" };
  const threeVerbs = ["GET", "POST", "PUT"].map((method, i) => ({ method, route: "/x", slug: `op${i}` }));
  const out = mergeOpenapiIntoBazaar(threeVerbs, [guessed]);
  want(out.length === 4, `three operations on one path leave a guessed verb unjoined (rows: ${out.length})`);
  want(out.some((r) => r.slug === "registry" && r.method === "POST"), "the unjoined registry row keeps its slug and verb");
  const [single] = mergeOpenapiIntoBazaar([{ route: "/y", slug: "nomethod" }], [{ ...guessed, route: "/y" }]);
  want(single?.slug === "nomethod" && single.method === "POST", "a single verbless operation enriches a guessed row and keeps its verb");
  const [byVerb] = mergeOpenapiIntoBazaar([{ method: "GET", route: "/z", slug: "reader" }], [{ ...guessed, route: "/z" }]);
  want(byVerb?.method === "GET" && byVerb.slug === "reader", "a single operation sets the verb of a guessed row");
}

// ---- part E: generated deployment hostnames ----
const cache = _cacheForTests();
const WALLET = `0x${"a".repeat(40)}`;
const OTHER_WALLET = `0x${"b".repeat(40)}`;
const DURABLE = "https://shop.example";
const GENERATED = "https://shop-production.up.railway.app";
const listing = (origin, slugs, payTo, changes = {}) => slugs.map((slug) => ({
  seller: origin, method: "POST", route: `/${slug}`, slug, name: slug, price: 0.004,
  networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": payTo }, ...changes,
}));
// Each origin: [origin, slugs, wallet, tool changes, entry changes].
function aliasesOf(origins) {
  cache.clear();
  for (const [origin, slugs, payTo, changes = {}, entryChanges = {}] of origins) {
    cache.set(origin, { manifest: { name: "s", homepage: origin }, tools: listing(origin, slugs, payTo, changes), fetchedAt: Date.now(), error: null, history: [1, 1, 1], ...entryChanges });
  }
  return [...computeAliasOrigins(cache)].sort();
}
const aliasCases = [
  ["same tools in another order and the wallet in another case fold the generated host",
    [[DURABLE, ["one", "two"], WALLET], [GENERATED, ["two", "one"], WALLET.toUpperCase().replace("0X", "0x")]], [GENERATED]],
  ["two durable origins keep a generated copy separate",
    [[DURABLE, ["one"], WALLET], ["https://b.example", ["one"], WALLET], [GENERATED, ["one"], WALLET]], []],
  ["every generated copy folds into the one durable origin, hostname case aside",
    [[DURABLE, ["one"], WALLET], ["https://r1.up.railway.app", ["one"], WALLET], ["https://R2.UP.RAILWAY.APP", ["one"], WALLET]],
    ["https://R2.UP.RAILWAY.APP", "https://r1.up.railway.app"]],
  ["generated hosts with no durable origin fold nothing",
    [["https://r1.up.railway.app", ["one"], WALLET], ["https://r2.up.railway.app", ["one"], WALLET]], []],
  ["an errored generated host is not folded",
    [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], WALLET, {}, { error: "fetch failed" }]], []],
  ["an errored durable origin folds nothing",
    [[DURABLE, ["one"], WALLET, {}, { error: "fetch failed" }], [GENERATED, ["one"], WALLET]], []],
  ["another price keeps them apart", [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], WALLET, { price: 0.005 }]], []],
  ["paid false keeps them apart", [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], WALLET, { paid: false }]], []],
  ["another network list keeps them apart", [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], WALLET, { networks: ["eip155:8453", "eip155:1"] }]], []],
  ["another route keeps them apart", [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], WALLET, { route: "/elsewhere" }]], []],
  ["verb case, paid true and descriptions do not keep them apart",
    [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], WALLET, { paid: true, method: "post", name: "other", description: "other" }]], [GENERATED]],
  ["another wallet keeps them apart", [[DURABLE, ["one"], WALLET], [GENERATED, ["one"], OTHER_WALLET]], []],
  ["rows that name no payee never fold",
    [[DURABLE, ["one"], WALLET, { payToByNetwork: undefined }], [GENERATED, ["one"], WALLET, { payToByNetwork: undefined }]], []],
];
for (const [what, origins, expected] of aliasCases) {
  const got = aliasesOf(origins);
  want(sameList(got, expected), `${what}: aliases ${asText(got)}`);
}
cache.clear();

for (const p of problems) console.error(`FAIL - ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : "openapi listing, merge and deployment alias checks: all good");
process.exit(problems.length ? 1 : 0);
