#!/usr/bin/env node
// Two crawler gaps on a seller whose manifest is a `paths` object and whose
// POST route validates its body before the paywall:
//   * the `paths` shape (path -> { methods, resource, payment: { networks,
//     asset, payTo } }) was not read, so the row carried no chains;
//   * the unpaid quote probe sent placeholders and `{}`, both refused with a
//     422, so the live 402 that names the chain was never read.
// The probe now sends the seller's own published example request first. That
// example is PRIVATE: it is the probe body and nothing else. This suite pins
// the shape reader, the probe order, every bound on the example, and that the
// example reaches no row, cache entry, persisted file, seller detail or log.
// Offline: documents through the crawl seam, probes through the probe seam,
// against loopback listeners on port 0.
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_PAYWALL_PROBES_PER_CYCLE = "25";
const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const TMP = mkdtempSync(join(tmpdir(), "probe-example-"));
process.env.REMOVED_ORIGINS_FILE = join(TMP, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(TMP, "x402-index-cache.json");
const { createServer } = await import("node:http");
const idx = await import("../src/x402-index.js");
const { normaliseManifestTools, openapiProbeExamples, sellerDetail, persistIndexCache, persistIndexCacheAsync,
  __setCrawlFetchForTest, __setProbeFetchForTest, __crawlSellerForTest, __resetRobotsCacheForTest, _cacheForTests } = idx;
const { probeAttemptsFor } = await import("../src/x402-live-quote.js");
const { boundedProbeExample, manifestEntryExample, openapiOperationExample, probeExampleFor, MAX_EXAMPLE_BYTES } = await import("../src/probe-example.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

const ARC = "eip155:5042";
const ARC_TEST = "eip155:5042002";
const PAY_TO = "0x" + "b2".repeat(20);
const ASSET = "0x3600000000000000000000000000000000000000";
const MARK = "probe-example-marker-7f3a";
const pathsManifest = (origin, extra = {}) => ({
  x402Version: 2,
  paths: {
    "/v1/task/build": {
      methods: ["POST"],
      resource: `${origin}/v1/task/build`,
      payment: {
        endpoint: `${origin}/v1/task/build`, method: "POST", paymentProtocol: "x402 v2",
        networks: [ARC_TEST, ARC], asset: ASSET, payTo: PAY_TO, preparationPriceMicroUsdc: "10000",
        exampleRequest: { intent: MARK, chainId: 5042, sender: "0x000000000000000000000000000000000000dEaD" },
        ...extra,
      },
    },
  },
});

// ------------------------------------------------------------ 1. paths shape
{
  const origin = "https://seller.example";
  const rows = normaliseManifestTools(pathsManifest(origin), origin);
  ok(rows.length === 1 && rows[0].method === "POST" && rows[0].route === "/v1/task/build" && !rows[0].methodInferred, "a `paths` entry reads as one POST row at its route");
  eq(rows[0].networks, [ARC_TEST, ARC], "the payment block's declared networks land on the row");
  eq(rows[0].payToByNetwork, { [ARC_TEST]: PAY_TO, [ARC]: PAY_TO }, "its payTo is keyed under each declared network");
  ok(rows[0].price == null, "no price is invented from a field we cannot read as the route's price");
  ok(!JSON.stringify(rows).includes(MARK), "the example is not on the row");
  const syms = rows.flatMap((r) => Reflect.ownKeys(r).filter((k) => typeof k !== "string" || !Object.prototype.propertyIsEnumerable.call(r, k)).map((k) => r[k]));
  ok(!JSON.stringify(syms).includes(MARK), "nor under a symbol or non-enumerable key");

  // Bare path key, no resource: the key is the route.
  const bare = normaliseManifestTools({ x402Version: 2, paths: { "/v1/q": { methods: ["GET"], payment: { networks: ["base"], payTo: PAY_TO } } } }, origin);
  ok(bare.length === 1 && bare[0].route === "/v1/q" && bare[0].networks[0] === "eip155:8453", "a path key without a resource is the route; shorthand networks are normalised");
  // A per-entry payment block that carries its own accepts.
  const acc = normaliseManifestTools({ paths: { "/v1/a": { methods: ["POST"], payment: { accepts: [{ scheme: "exact", network: ARC, payTo: PAY_TO }] } } } }, origin);
  eq(acc[0]?.networks, [ARC], "a payment block's own accepts are read");
  // A payTo that does not fit the network family is not attached.
  const mis = normaliseManifestTools({ paths: { "/v1/s": { methods: ["POST"], payment: { networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], payTo: PAY_TO } } } }, origin);
  ok(mis[0]?.networks?.length === 1 && !Object.keys(mis[0].payToByNetwork || {}).length, "an EVM payTo beside a Solana network is not attached");

  // An OpenAPI document served as the manifest is not read as a `paths` catalogue.
  const oaDoc = { openapi: "3.1.0", paths: { "/v1/x": { post: { requestBody: {} } } } };
  eq(normaliseManifestTools(oaDoc, origin), [], "a document naming itself openapi is not a paths manifest");
  eq(normaliseManifestTools({ paths: { "/v1/x": { post: { summary: "x" } } } }, origin), [], "an OpenAPI path item (verb keys) is not a paths entry");
  eq(normaliseManifestTools({ paths: { "/v1/x": { summary: "nothing about payment" } } }, origin), [], "an entry with none of the x402 entry fields is not read");
  ok(normaliseManifestTools({ paths: { "https://elsewhere.example/v1/x": { methods: ["POST"], payment: { networks: [ARC] } } } }, origin).length === 0, "another origin's path is not attributed to this seller");

  // Existing shapes unaffected, and the collector changes no row.
  const res = { x402Version: 2, resources: [{ resource: `${origin}/v1/r`, method: "POST", price: "$0.01", accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO }], exampleRequest: { q: MARK } }] };
  const plain = normaliseManifestTools(res, origin);
  const collected = new Map();
  const withEx = normaliseManifestTools(res, origin, { examples: collected });
  ok(JSON.stringify(plain) === JSON.stringify(withEx), "collecting examples leaves every row byte-identical");
  ok(collected.get("POST /v1/r") === JSON.stringify({ q: MARK }), "a resources entry's exampleRequest is collected under its verb and route");
  ok(!JSON.stringify(withEx).includes(MARK), "and is not on its row");
  const mixed = normaliseManifestTools({ ...res, paths: pathsManifest(origin).paths }, origin);
  ok(mixed.length === 2 && mixed.some((r) => r.route === "/v1/r") && mixed.some((r) => r.route === "/v1/task/build"), "a `paths` object merges beside the array catalogues");
  // Path seller: the example is keyed by the scoped route.
  const ps = "https://host.example/fn/seller";
  const psEx = new Map();
  const psRows = normaliseManifestTools({ paths: { "/fn/seller/v1/b": { methods: ["POST"], payment: { networks: [ARC], exampleRequest: { a: 1 } } } } }, ps, { examples: psEx });
  ok(psRows[0]?.route === "/v1/b" && psEx.get("POST /v1/b") === '{"a":1}', "a path seller's example is keyed by its prefix-relative route");
  const inferred = new Map();
  normaliseManifestTools({ resources: [{ resource: `${origin}/v1/i`, example: { b: 2 } }] }, origin, { examples: inferred });
  ok(probeExampleFor(inferred, "POST", "/v1/i") === '{"b":2}', "an entry that names no verb lends its example to the POST probe");
}

// ------------------------------------------------------------ 2. probe order
{
  const origin = "https://seller.example";
  const row = { route: "/v1/b", method: "POST", requestContract: ["declared", { body: ["url"] }] };
  const ex = JSON.stringify({ intent: MARK });
  eq(probeAttemptsFor(origin, row, { example: ex }).map((a) => a.body), [ex, '{"url":"https://example.com"}', "{}"], "example first, then the placeholder body, then {}");
  eq(probeAttemptsFor(origin, row).map((a) => a.body), ['{"url":"https://example.com"}', "{}"], "no example: the order is what it was");
  const get = probeAttemptsFor(origin, { route: "/v1/g", method: "GET", methodInferred: true }, { example: ex });
  eq(get.map((a) => `${a.method} ${a.body}`), ["GET null", `POST ${ex}`, "POST {}"], "a GET never carries a body; the POST fallback leads with the example");
  ok(probeAttemptsFor(origin, row, { example: ex }).every((a) => a.target === `${origin}/v1/b`), "every attempt goes to the route's own target");
  eq(probeAttemptsFor(origin, row, { example: "{}" }).map((a) => a.body), ['{"url":"https://example.com"}', "{}"], "an example equal to {} is not sent twice");
  for (const [bad, why] of [["[1,2]", "an array"], ['"str"', "a scalar"], ["{not json", "non-JSON text"], ['{"__proto__":{"x":1}}', "a reserved key"], [`{"a":"${"x".repeat(MAX_EXAMPLE_BYTES)}"}`, "an oversize text"], [{ a: 1 }, "a non-string"]]) {
    eq(probeAttemptsFor(origin, row, { example: bad }).map((a) => a.body), ['{"url":"https://example.com"}', "{}"], `the probe re-checks its example: ${why} is not sent`);
  }
}

// ------------------------------------------------------------ 3. bounds
{
  ok(boundedProbeExample({ a: 1, b: "x", c: [1, { d: null }] }) === '{"a":1,"b":"x","c":[1,{"d":null}]}', "an ordinary object passes as its JSON text");
  ok(boundedProbeExample([{ a: 1 }]) === null, "an array is refused");
  for (const s of ["x", 1, true, null, undefined]) ok(boundedProbeExample(s) === null, `a scalar (${String(s)}) is refused`);
  const nest = (n) => { let v = {}; for (let i = 1; i < n; i++) v = { k: v }; return v; };
  ok(boundedProbeExample(nest(6)) !== null, "depth 6 passes");
  ok(boundedProbeExample(nest(7)) === null, "depth 7 is refused");
  ok(boundedProbeExample({ a: [[[[[1]]]]] }) !== null && boundedProbeExample({ a: [[[[[[1]]]]]] }) === null, "arrays count toward depth");
  const pad = (n) => ({ a: "x".repeat(n) });
  const fits = MAX_EXAMPLE_BYTES - '{"a":""}'.length;
  ok(boundedProbeExample(pad(fits)) !== null, "exactly the byte limit passes");
  ok(boundedProbeExample(pad(fits + 1)) === null, "one byte over is refused");
  ok(boundedProbeExample({ a: "é".repeat(Math.ceil(fits / 2) + 1) }) === null, "the limit is in UTF-8 bytes, not characters");
  for (const k of ["__proto__", "constructor", "prototype"]) {
    ok(boundedProbeExample(JSON.parse(`{"${k}":{"polluted":1}}`)) === null, `a top-level ${k} key is refused`);
    ok(boundedProbeExample(JSON.parse(`{"a":[{"${k}":1}]}`)) === null, `a nested ${k} key is refused`);
  }
  ok(({}).polluted === undefined, "nothing reached Object.prototype");
  ok(boundedProbeExample({ a: NaN }) === null && boundedProbeExample({ a: () => 1 }) === null, "non-JSON values are refused");
  ok(boundedProbeExample(new Date()) === null && boundedProbeExample(new Map()) === null, "a non-plain object is refused");
  ok(manifestEntryExample({ payment: { exampleRequest: [1] }, exampleRequest: { b: 1 } }) === '{"b":1}', "an out-of-bounds payment example falls through to the entry's own");
  ok(manifestEntryExample({ example: "a string" }) === null, "a scalar entry example is refused");

  const doc = {
    paths: {},
    components: {
      requestBodies: { Build: { content: { "application/json": { example: { r: 1 } } } } },
      examples: { One: { value: { e: 1 } } },
    },
  };
  ok(openapiOperationExample({ requestBody: { content: { "application/json": { example: { a: 1 } } } } }, doc) === '{"a":1}', "an OpenAPI media example is read");
  ok(openapiOperationExample({ requestBody: { content: { "application/json": { examples: { first: { value: { x: 1 } }, second: { value: { y: 2 } } } } } } }, doc) === '{"x":1}', "else the first examples[*].value");
  ok(openapiOperationExample({ requestBody: { $ref: "#/components/requestBodies/Build" } }, doc) === '{"r":1}', "a local requestBody $ref is followed");
  ok(openapiOperationExample({ requestBody: { content: { "application/json": { examples: { a: { $ref: "#/components/examples/One" } } } } } }, doc) === '{"e":1}', "a local example $ref is followed");
  ok(openapiOperationExample({ requestBody: { $ref: "https://elsewhere.example/x.json" } }, doc) === null, "an external $ref is not fetched");
  ok(openapiOperationExample({ requestBody: { $ref: "#/__proto__/x" } }, doc) === null, "a ref through a reserved key is refused");
  ok(openapiOperationExample({ requestBody: { content: { "text/plain": { example: { a: 1 } } } } }, doc) === null, "only an application/json body is read");
  const oaMap = openapiProbeExamples({ openapi: "3.1.0", servers: [{ url: "/api" }], paths: { "/q": { post: { requestBody: { content: { "application/json": { example: { q: 1 } } } } }, get: {} } } }, "https://seller.example", new Map());
  ok(oaMap.get("POST /api/q") === '{"q":1}' && oaMap.size === 1, "an OpenAPI POST example is keyed by the route the OpenAPI reader gives it");
}

// ------------------------------------------------------------ 4. end to end, and private
const listen = (handler) => new Promise((resolve) => {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1", () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const arcAccept = { scheme: "exact", network: ARC, amount: "10000", asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
const header402 = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [arcAccept] })).toString("base64");
const bodies = [];
// The seller's route refuses anything but a body naming the marker, as a
// route that validates before its paywall does.
const seller = (req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    bodies.push({ url: req.url, method: req.method, body: raw, headers: req.headers });
    let b = {}; try { b = JSON.parse(raw || "{}"); } catch { /* */ }
    if (req.method === "POST" && (b.intent === MARK || b.q === `${MARK}-oa`)) {
      res.writeHead(402, { "content-type": "application/json", "payment-required": header402 });
      return res.end("{}");
    }
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "intent, chainId and sender are required" }));
  });
};
const a = await listen(seller);
const b = await listen(seller);
__setProbeFetchForTest((url, opts) => {
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1") return Promise.reject(Object.assign(new Error(`left the loopback: ${url}`), { code: "ENOTFOUND" }));
  return fetch(url, { ...opts, redirect: "manual" });
});
const served = new Map();
__setCrawlFetchForTest(async (url) => {
  if (url.endsWith("/robots.txt")) return { html: "User-agent: *\nAllow: /\n", finalUrl: url, validators: null };
  const hit = served.get(url);
  if (!hit) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  return { html: JSON.stringify(hit), finalUrl: url, validators: null };
});
served.set(`${a.origin}/.well-known/x402`, pathsManifest(a.origin));
// Seller b: a resources manifest naming no chain, its example only in OpenAPI.
served.set(`${b.origin}/.well-known/x402`, { x402Version: 2, resources: [{ resource: `${b.origin}/v1/oa`, method: "POST", description: "One." }] });
served.set(`${b.origin}/openapi.json`, { openapi: "3.1.0", info: { title: "b", version: "1" }, paths: { "/v1/oa": { post: { summary: "One.", requestBody: { content: { "application/json": { example: { q: `${MARK}-oa` } } } }, responses: { 200: { description: "ok" } } } } } });

const logged = [];
const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
const capture = (k) => (...args) => { logged.push(args.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")); if (k === "error") orig.error(...args); };
for (const k of Object.keys(orig)) console[k] = capture(k);
const crawl = async (origin) => { __resetRobotsCacheForTest(); await __crawlSellerForTest(origin); return _cacheForTests().get(origin); };
let va, vb;
try {
  va = await crawl(a.origin);
  vb = await crawl(b.origin);
} finally {
  for (const k of Object.keys(orig)) console[k] = orig[k];
}
{
  const tool = va?.tools?.find((t) => t.route === "/v1/task/build");
  ok(Boolean(tool), "the paths seller is listed with its route");
  ok(tool?.networks?.includes(ARC) && tool?.networks?.includes(ARC_TEST), `the row carries the declared and the live chain (${JSON.stringify(tool?.networks)})`);
  ok(tool?.price === 0.01, `the live 402 the example reached priced the row (${tool?.price})`);
  const firstPost = bodies.find((x) => x.url === "/v1/task/build" && x.method === "POST");
  ok(firstPost && JSON.parse(firstPost.body).intent === MARK, "the first POST the route saw was the seller's own example");
  ok(bodies.filter((x) => x.body.includes(MARK)).every((x) => x.url === "/v1/task/build" || x.url === "/v1/oa"), "the example went to its own route only");
  ok(bodies.every((x) => !Object.keys(x.headers).some((h) => /^(payment|x-payment|authorization)/i.test(h))), "no seller or payment header was sent with a probe");
  const btool = vb?.tools?.find((t) => t.route === "/v1/oa");
  ok(btool?.networks?.includes(ARC), `an OpenAPI example reached the 402 and its chain was recorded (${JSON.stringify(btool?.networks)})`);
  ok(bodies.some((x) => x.url === "/v1/oa" && x.body.includes(`${MARK}-oa`)), "the OpenAPI example was sent to its own route");

  const da = sellerDetail(a.origin);
  ok(da && JSON.stringify(da).includes(ARC), "the seller detail (/api/index?seller=) shows the chain");
  const leaks = [];
  const deep = (v, where, seen = new Set()) => {
    if (typeof v === "string") { if (v.includes(MARK)) leaks.push(where); return; }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Buffer.isBuffer(v)) return;
    for (const k of Reflect.ownKeys(v)) { try { deep(v[k], `${where}.${String(k)}`, seen); } catch { /* accessor */ } }
  };
  for (const [name, v] of [["seller detail a", da], ["seller detail b", sellerDetail(b.origin)]]) deep(v, name);
  for (const [name, v] of [["cache entry a", va], ["cache entry b", vb]]) {
    const { manifestBody, ...rest } = v || {};
    deep(rest, name);
  }
  ok(leaks.length === 0, `the example is in no seller detail or in-memory cache entry, under any key (${leaks.join(", ")})`);
  ok(persistIndexCache(process.env.INDEX_CACHE_FILE) && !readFileSync(process.env.INDEX_CACHE_FILE, "utf8").includes(MARK), "the persisted index file carries no example");
  const asyncFile = join(TMP, "async-cache.json");
  await persistIndexCacheAsync(asyncFile);
  const ndjson = asyncFile.replace(/\.json$/, "") + ".ndjson";
  const written = [asyncFile, ndjson, process.env.INDEX_CACHE_FILE.replace(/\.json$/, "") + ".ndjson"].filter((f) => existsSync(f));
  ok(written.length > 0 && written.every((f) => !readFileSync(f, "utf8").includes(MARK)), `the async snapshot files carry no example (${written.length} read)`);
  ok(!logged.some((l) => l.includes(MARK)), `no log line carries the example (${logged.length} lines read)`);
}

// A route the seller marks free (paid:false) never gets the example: a body it
// accepts would run it. The same route marked paid does.
{
  const free = { seller: a.origin, route: "/v1/task/build", method: "POST", slug: "free", price: null, networks: [], paid: false };
  const paid = { ...free, slug: "paid", paid: true };
  const ex = new Map([["POST /v1/task/build", JSON.stringify({ intent: MARK })]]);
  const silence = console.log; console.log = () => {};
  try {
    bodies.length = 0;
    await idx.enrichLiveQuotes([free], a.origin, { ignoreBudget: true, probeExamples: ex });
    ok(bodies.length > 0 && !bodies.some((x) => x.body.includes(MARK)), `a paid:false route was probed without the example (${bodies.length} requests)`);
    bodies.length = 0;
    await idx.enrichLiveQuotes([paid], a.origin, { ignoreBudget: true, probeExamples: ex });
    ok(bodies[0] && bodies[0].body.includes(MARK) && paid.networks.includes(ARC), "a paid route leads with the example and records the live chain");
  } finally { console.log = silence; }
}

__setProbeFetchForTest(null);
__setCrawlFetchForTest(null);
a.server.close(); b.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
