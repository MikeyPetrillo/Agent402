// Behavior checks for the OpenAPI operation filter, the registry-row copy in
// the OpenAPI/registry merge, the full-route listing used for template
// collapse, and the deployment-hostname alias rule of the seller index.
// Written from the behavior specification, not from any implementation.
//
// Offline, no server, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  normaliseOpenapiTools,
  mergeOpenapiIntoBazaar,
  openapiAllOperationRoutes,
  openapiHasPaymentSignal,
  computeAliasOrigins,
  _cacheForTests,
} from "../src/x402-index.js";

let failures = 0;
const check = (cond, label) => {
  if (cond) return;
  failures++;
  console.error("FAIL:", label);
};
const routesOf = (rows) => rows.map((r) => `${r.method} ${r.route}`).sort();
const SELLER = "https://seller.example";

// ---- A. which operations of a document become rows ----
{
  const doc = { paths: {} };
  const add = (p, ops) => { doc.paths[p] = ops; };
  add("/admin/users", { get: {} });
  add("/Internal/jobs", { get: {} });
  add("/.well-known/thing", { get: {} });
  add("/sitemap", { get: {} });
  add("/favicon", { get: {} });
  add("/llms-full", { get: {} });
  add("/openapi-v2", { get: {} });
  add("/feed.XML", { get: {} });
  add("/icon.ico", { get: {} });
  add("/v1/admin", { get: {} });
  add("/convert", { HEAD: {}, Options: {}, trace: {}, connect: {}, post: null, summary: "not an operation" });
  add("/kept", { get: { deprecated: "true" } });
  add("/gone", { get: { deprecated: true } });
  const got = routesOf(normaliseOpenapiTools(doc, SELLER));
  check(JSON.stringify(got) === JSON.stringify(["GET /kept", "GET /v1/admin", "HEAD /convert", "OPTIONS /convert"].sort()),
    `operation filter keeps real operations only (got ${JSON.stringify(got)})`);
}
{
  // The exclusion also reads the path after the server prefix is applied.
  const rows = normaliseOpenapiTools({ servers: [{ url: "/internal" }], paths: { "/report": { get: {} } } }, SELLER);
  check(rows.length === 0, "a path that becomes a non-tool path under its server prefix is excluded");
  const kept = normaliseOpenapiTools({ servers: [{ url: "/api" }], paths: { "/report": { get: {} } } }, SELLER);
  check(kept.length === 1 && kept[0].route === "/api/report", "an ordinary prefixed path is kept with the prefix applied");
}
{
  // Annotated document: unannotated sibling is listed free; zero-priced op is free.
  const rows = normaliseOpenapiTools({ paths: {
    "/priced": { post: { "x-price": "$0.02" } },
    "/plain": { get: {} },
    "/zero": { get: { "x-price": "$0" } },
    "/declared-free": { get: { "x-payment-required": false } },
  } }, SELLER);
  const paidOf = (route) => rows.find((r) => r.route === route)?.paid;
  check(paidOf("/priced") === true, "a priced operation in an annotated document is paid");
  check(paidOf("/plain") === false, "an unannotated sibling in an annotated document is listed with paid false");
  check(paidOf("/zero") === false, "a zero price alone reads free");
  check(paidOf("/declared-free") === false, "an explicit payment-not-required reads free");
  // Unannotated document: no paid field at all.
  const plain = normaliseOpenapiTools({ paths: { "/a": { get: {} }, "/b": { post: {} } } }, SELLER);
  check(plain.length === 2 && plain.every((r) => !("paid" in r)), "a document with no payment annotation lists rows without a paid field");
}

// ---- B. document-level payment signal ----
check(openapiHasPaymentSignal({ paths: { "/a": { get: { "x-payment-required": "TRUE" } } } }) === true, "a textual true payment-required is a signal");
check(openapiHasPaymentSignal({ paths: { "/a": { get: { "x-price": "$0" } } } }) === false, "a zero price alone is not a signal");
check(openapiHasPaymentSignal({ paths: { "/a": { get: { "x-payment-required": false } } } }) === false, "payment declared not required is not a signal");
check(openapiHasPaymentSignal({ paths: { "/health": { get: { "x-price": "$0.01", deprecated: true } } } }) === true,
  "the signal counts a priced operation even where the row filter would drop it");
check(openapiHasPaymentSignal({ paths: "nope" }) === false && openapiHasPaymentSignal({ paths: { "/a": null } }) === false && openapiHasPaymentSignal("x") === false,
  "malformed documents are not a signal and do not throw");

// ---- C. every declared operation, with no payment or asset filtering ----
{
  const all = routesOf(openapiAllOperationRoutes({ servers: [{ url: "/api" }], paths: {
    "/logo.png": { get: {} },
    "/old": { post: { deprecated: true } },
    "/api/already": { put: {} },
    "/x": { trace: {}, Delete: {} },
  } }, SELLER));
  check(JSON.stringify(all) === JSON.stringify(["DELETE /api/x", "GET /api/logo.png", "POST /api/old", "PUT /api/already"].sort()),
    `full route list keeps deprecated and static operations, applies the prefix once (got ${JSON.stringify(all)})`);
  check(openapiAllOperationRoutes(null, SELLER).length === 0 && openapiAllOperationRoutes({}, SELLER).length === 0, "no paths, no routes");
  check(openapiAllOperationRoutes({ servers: [{ url: "https://elsewhere.example" }], paths: { "/a": { get: {} } } }, SELLER).length === 0,
    "a document that only names another public host contributes no routes");
}

// ---- D. registry rows are copied, never shared, and carry no contract or symbol keys ----
{
  const mark = Symbol("mark");
  const row = { seller: SELLER, method: "POST", route: "/r", slug: "r", price: 0.01, [mark]: true };
  const [copy] = mergeOpenapiIntoBazaar([], [row]);
  check(copy !== row, "a passed-through registry row is a fresh object");
  check(copy.route === "/r" && copy.price === 0.01 && copy.slug === "r", "a passed-through registry row keeps its string-keyed fields");
  check(copy[mark] === undefined, "a symbol-keyed property of a registry row is not carried");
  const plain = { seller: SELLER, method: "GET", route: "/p" };
  const [plainCopy] = mergeOpenapiIntoBazaar([], [plain]);
  check(plainCopy !== plain && JSON.stringify(plainCopy) === JSON.stringify(plain), "a plain registry row is copied with the same fields in the same order");
  const [matched] = mergeOpenapiIntoBazaar([{ method: "POST", route: "/r", slug: "doc-slug" }], [row]);
  check(matched !== row && matched[mark] === undefined && matched.slug === "doc-slug", "a matched registry row is a fresh enriched object without symbol keys");
}
{
  // Inferred verb: a path with two declared operations is ambiguous, a third keeps it ambiguous.
  const ops = [
    { method: "GET", route: "/x", slug: "g" },
    { method: "POST", route: "/x", slug: "p" },
    { method: "PUT", route: "/x", slug: "u" },
  ];
  const out = mergeOpenapiIntoBazaar(ops, [{ method: "POST", route: "/x", methodInferred: true, slug: "registry" }]);
  check(out.length === 4 && out.some((r) => r.slug === "registry" && r.method === "POST"), "an inferred verb on an ambiguous path matches nothing");
  const one = mergeOpenapiIntoBazaar([{ route: "/y", slug: "nomethod" }], [{ method: "POST", route: "/y", methodInferred: true, slug: "registry" }]);
  check(one.length === 1 && one[0].method === "POST" && one[0].slug === "nomethod", "an inferred verb keeps the registry verb when the operation names none");
}

// ---- E. deployment-hostname aliases ----
const cache = _cacheForTests();
const PAYEE = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
function entry(origin, tools, extra = {}) {
  cache.set(origin, { manifest: { name: "s", homepage: origin }, tools, fetchedAt: Date.now(), error: null, history: [1, 1, 1], ...extra });
}
function tools(origin, slugs, payTo, over = {}) {
  return slugs.map((slug) => ({
    seller: origin, method: "POST", route: `/${slug}`, slug, name: slug, price: 0.004,
    networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": payTo }, ...over,
  }));
}
function aliasesWith(build) {
  cache.clear();
  build();
  const set = computeAliasOrigins(cache);
  return [...set].sort();
}
{
  const DUR = "https://shop.example", RW = "https://shop-production.up.railway.app";
  let a = aliasesWith(() => { entry(DUR, tools(DUR, ["one", "two"], PAYEE)); entry(RW, tools(RW, ["two", "one"], PAYEE.toUpperCase().replace("0X", "0x"))); });
  check(JSON.stringify(a) === JSON.stringify([RW]), `identical service and payees (order and address case aside) fold the deployment host (got ${a})`);

  a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE)); entry("https://b.example", tools("https://b.example", ["one"], PAYEE)); entry(RW, tools(RW, ["one"], PAYEE)); });
  check(a.length === 0, "two durable origins with the same service leave the deployment host alone");

  a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE)); entry("https://r1.up.railway.app", tools("https://r1.up.railway.app", ["one"], PAYEE)); entry("https://R2.UP.RAILWAY.APP", tools("https://R2.UP.RAILWAY.APP", ["one"], PAYEE)); });
  check(JSON.stringify(a) === JSON.stringify(["https://R2.UP.RAILWAY.APP", "https://r1.up.railway.app"].sort()), `every matching deployment host folds, hostname case aside (got ${a})`);

  a = aliasesWith(() => { entry("https://r1.up.railway.app", tools("https://r1.up.railway.app", ["one"], PAYEE)); entry("https://r2.up.railway.app", tools("https://r2.up.railway.app", ["one"], PAYEE)); });
  check(a.length === 0, "deployment hosts with no durable origin fold nothing");

  a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE)); entry(RW, tools(RW, ["one"], PAYEE), { error: "fetch failed" }); });
  check(a.length === 0, "an errored deployment host is not folded");
  a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE), { error: "fetch failed" }); entry(RW, tools(RW, ["one"], PAYEE)); });
  check(a.length === 0, "an errored durable origin folds nothing");

  for (const [label, over] of [["price", { price: 0.005 }], ["paid flag", { paid: false }], ["networks", { networks: ["eip155:8453", "eip155:1"] }], ["route", { route: "/elsewhere" }]]) {
    a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE)); entry(RW, tools(RW, ["one"], PAYEE, over)); });
    check(a.length === 0, `a difference in ${label} keeps the deployment host independent`);
  }
  a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE)); entry(RW, tools(RW, ["one"], PAYEE, { paid: true, method: "post", name: "other name", description: "other" })); });
  check(JSON.stringify(a) === JSON.stringify([RW]), "verb case, paid true versus unknown, and descriptive fields do not separate two copies");

  a = aliasesWith(() => { entry(DUR, tools(DUR, ["one"], PAYEE)); entry(RW, tools(RW, ["one"], OTHER)); });
  check(a.length === 0, "a different payee keeps the deployment host independent");

  a = aliasesWith(() => {
    const noPay = (o) => [{ seller: o, method: "POST", route: "/one", slug: "one", price: 0.004, networks: ["eip155:8453"] }];
    entry(DUR, noPay(DUR)); entry(RW, noPay(RW));
  });
  check(a.length === 0, "rows that name no payee never fold");
}
cache.clear();

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("cleanroom openapi/alias behavior tests passed");
