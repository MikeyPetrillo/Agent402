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
  __setCrawlFetchForTest, __setProbeFetchForTest, __crawlSellerForTest, __resetRobotsCacheForTest, _cacheForTests,
  __probeExampleMemoStatsForTest, __testSetBazaarTools, registerOrigin, __resetForcedCrawlForTest, validatorFor, removeOrigin } = idx;
const { probeAttemptsFor } = await import("../src/x402-live-quote.js");
const { boundedProbeExample, manifestEntryExample, openapiOperationExample, probeExampleFor, noteProbeExample, probeExamplePath, mergeProbeExamples, ProbeExampleMemo, MAX_EXAMPLE_BYTES, MAX_EXAMPLES } = await import("../src/probe-example.js");

let pass = 0, fail = 0;
// Straight to stdout, so an assertion made while console is captured is shown.
const say = (line) => process.stdout.write(`${line}\n`);
const ok = (c, m) => { if (c) { pass++; say(`ok - ${m}`); } else { fail++; say(`FAIL - ${m}`); } };
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
  ok(oaMap.get("POST /api/q") === '{"q":1}' && probeExampleFor(oaMap, "POST", "/api/q") === '{"q":1}' && probeExampleFor(oaMap, "GET", "/api/q") === null, "an OpenAPI POST example is keyed by the route the OpenAPI reader gives it");
}

// ------------------------------------------------------------ 3b. route matching and the memo
{
  eq(["/v1/x", "/v1/x/", "/v1/x?a=1", "/v1/x/?a=1", "/v1/x//", "/", "/?q=1", ""].map(probeExamplePath), ["/v1/x", "/v1/x", "/v1/x", "/v1/x", "/v1/x", "/", "/", "/"], "the matched path drops the query and trailing slashes");
  const m = new Map();
  noteProbeExample(m, "POST", "/v1/x", '{"x":1}');
  for (const r of ["/v1/x?mode=fast", "/v1/x/", "/v1/x/?mode=fast"]) ok(probeExampleFor(m, "POST", r) === '{"x":1}', `a row at ${r} finds the example published for /v1/x`);
  ok(probeExampleFor(m, "POST", "/v1/xy") === null && probeExampleFor(m, "POST", "/v1") === null, "another path does not");
  const v = new Map();
  noteProbeExample(v, "POST", "/v1/y?p=a", '{"p":"a"}');
  noteProbeExample(v, "POST", "/v1/y?p=b", '{"p":"b"}');
  ok(probeExampleFor(v, "POST", "/v1/y?p=b") === '{"p":"b"}' && probeExampleFor(v, "POST", "/v1/y?p=a") === '{"p":"a"}', "an exact route still wins over the shared path");
  ok(probeExampleFor(v, "POST", "/v1/y") === '{"p":"a"}', "the bare path takes the first variant's example");

  // An entry naming no verb carries the example while another entry declares
  // POST for the same route: the inferred row is dropped, its example is not.
  {
    const o = "https://seller.example";
    const doc = { x402Version: 2,
      resources: [{ resource: `${o}/v1/inf`, exampleRequest: { intent: MARK } }],
      endpoints: [{ path: "/v1/inf", method: "POST", description: "Declared." }] };
    const got = new Map();
    const rows = normaliseManifestTools(doc, o, { examples: got });
    ok(rows.length === 1 && rows[0].method === "POST", `the declared POST row is the one kept (${JSON.stringify(rows.map((r) => r.method))})`);
    ok(probeExampleFor(got, "POST", "/v1/inf") === JSON.stringify({ intent: MARK }), "the dropped inferred row's example is found for the declared POST");
    const own = { x402Version: 2,
      resources: [{ resource: `${o}/v1/own`, exampleRequest: { intent: "inferred" } }],
      endpoints: [{ path: "/v1/own", method: "POST", exampleRequest: { intent: "declared" } }] };
    const got2 = new Map();
    normaliseManifestTools(own, o, { examples: got2 });
    ok(probeExampleFor(got2, "POST", "/v1/own") === JSON.stringify({ intent: "declared" }), "a declared row's own example wins over the inferred one");
  }

  // The cap counts examples (routes), not keys: each example also holds a
  // path alias, and MAX_EXAMPLES routes all stay findable.
  {
    const cap = new Map();
    for (let i = 0; i < MAX_EXAMPLES + 25; i++) noteProbeExample(cap, "POST", `/r${i}?v=1`, `{"i":${i}}`);
    const routes = [...cap.keys()].filter((k) => !k.includes(" ~")).length;
    ok(routes === MAX_EXAMPLES && cap.size === 2 * MAX_EXAMPLES, `the cap is ${MAX_EXAMPLES} examples, not ${MAX_EXAMPLES} keys (${routes} routes, ${cap.size} keys)`);
    ok(probeExampleFor(cap, "POST", `/r${MAX_EXAMPLES - 1}?v=1`) === `{"i":${MAX_EXAMPLES - 1}}` && probeExampleFor(cap, "POST", `/r${MAX_EXAMPLES - 1}`) === `{"i":${MAX_EXAMPLES - 1}}`, "the last example inside the cap is found by its route and its path");
    ok(probeExampleFor(cap, "POST", `/r${MAX_EXAMPLES}?v=1`) === null && probeExampleFor(cap, "POST", `/r${MAX_EXAMPLES}`) === null, "an example past the cap is not recorded, alias included");
    noteProbeExample(cap, "POST", "/r0?v=1", '{"late":1}');
    ok(probeExampleFor(cap, "POST", "/r0?v=1") === '{"i":0}', "at the cap a known route keeps its first writer");
    const merged = mergeProbeExamples(new Map(), cap);
    ok([...merged.keys()].filter((k) => !k.includes(" ~")).length === MAX_EXAMPLES && merged.size === cap.size, `a merge keeps ${MAX_EXAMPLES} examples with their aliases (${merged.size} keys)`);
    const more = new Map(); for (let i = 0; i < 10; i++) noteProbeExample(more, "POST", `/extra${i}`, "{}");
    ok(mergeProbeExamples(merged, more).size === cap.size, "a merge into a full map adds nothing past the cap");
  }

  // The memo: bounded, by origin and source, with a drop hook.
  const dropped = [];
  const memo = new ProbeExampleMemo({ maxBytes: 200, maxOriginBytes: 120, onDrop: (o, p) => dropped.push(`${o} ${p}`) });
  const ex = (n) => new Map([["POST /a", "x".repeat(n)]]);
  ok(memo.set("o1", "openapi", ex(40)) && memo.get("o1", "openapi")?.get("POST /a").length === 40, "a set is read back by origin and source");
  ok(memo.set("o1", "manifest", new Map([["POST /a", "m"]])) && memo.merged("o1").get("POST /a") === "m", "merged reads the manifest before the OpenAPI");
  ok(memo.set("o2", "openapi", ex(150)) === false && memo.get("o2", "openapi") === null && dropped.includes("o2 openapi"), "an origin over its own bound is not kept, and the drop hook runs");
  memo.set("o3", "openapi", ex(80)); memo.set("o4", "openapi", ex(80));
  ok(memo.get("o1", "openapi") === null && dropped.includes("o1 openapi") && dropped.includes("o1 manifest"), "past the total bound the oldest origin is evicted, with its drop hook");
  ok(memo.stats().bytes <= 200 && memo.get("o4", "openapi") !== null, `the total stays within its bound (${JSON.stringify(memo.stats())})`);
  memo.set("o4", "openapi", null);
  ok(memo.get("o4", "openapi") === null, "a null set clears that source");
  memo.purge((o) => o === "o3");
  ok(memo.get("o3", "openapi") === null && memo.stats().origins === 0, "purge forgets an origin");
  ok(!JSON.stringify(memo).includes("x") && Object.keys(memo).length === 0, "the memo serializes to nothing: its state is in private fields");
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

// ------------------------------------------------------------ 5. later crawls keep the example
// Seller c serves validators, so its second crawl is answered 304 for both
// documents; its example is only in OpenAPI. Seller d's manifest example is for
// /v1/d while the row the index keeps is a registry row at /v1/d?mode=x.
const c = await listen(seller);
const d = await listen(seller);
const ETAG = { etag: '"v1"' };
const conditional = new Set([`${c.origin}/.well-known/x402`, `${c.origin}/openapi.json`]);
const seen304 = [];
__setCrawlFetchForTest(async (url, opts = {}) => {
  if (url.endsWith("/robots.txt")) return { html: "User-agent: *\nAllow: /\n", finalUrl: url, validators: null };
  const hit = served.get(url);
  if (!hit) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  if (conditional.has(url)) {
    if (opts.allowNotModified && opts.validators?.etag === ETAG.etag) { seen304.push(url); return { notModified: true, finalUrl: url, validators: ETAG }; }
    return { html: JSON.stringify(hit), finalUrl: url, validators: ETAG };
  }
  return { html: JSON.stringify(hit), finalUrl: url, validators: null };
});
served.set(`${c.origin}/.well-known/x402`, { x402Version: 2, resources: [{ resource: `${c.origin}/v1/oa`, method: "POST", description: "One." }] });
served.set(`${c.origin}/openapi.json`, served.get(`${b.origin}/openapi.json`));
served.set(`${d.origin}/.well-known/x402`, { x402Version: 2, resources: [{ resource: `${d.origin}/v1/d`, method: "POST", description: "D.", exampleRequest: { intent: MARK } }] });
__testSetBazaarTools(d.origin, [{ route: "/v1/d?mode=x", method: "POST", slug: "d", name: "d", paid: true, seller: d.origin, networks: [] }]);

const logged2 = [];
for (const k of Object.keys(orig)) console[k] = (...args) => { logged2.push(args.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")); if (k === "error") orig.error(...args); };
const oaPosts = (o) => bodies.filter((x) => `http://${x.headers.host}` === o && x.url === "/v1/oa" && x.method === "POST");
let vc, vd;
try {
  bodies.length = 0;
  vc = await crawl(c.origin);
  ok(vc?.tools?.find((t) => t.route === "/v1/oa")?.networks?.includes(ARC), "seller c: the first crawl reached the 402 with the OpenAPI example");
  ok(validatorFor(c.origin, "/openapi.json")?.etag === ETAG.etag, "seller c sent a validator, so the next OpenAPI read is conditional");
  // Between crawls the OpenAPI rows are one packed buffer, not heap rows.
  const entry = _cacheForTests().get(c.origin);
  ok(Buffer.isBuffer(entry.openapiPacked) && !("openapiTools" in entry) && !("openapiRoutes" in entry), `seller c keeps its OpenAPI rows packed (${entry.openapiPacked?.length} bytes), no row arrays`);
  const routesBefore = entry.tools.map((t) => `${t.method} ${t.route}`).sort().join(",");
  // Forget what the first crawl learned, so the second must probe again.
  for (const t of entry.tools) { t.networks = []; t.price = null; delete t.lastProbedAt; delete t.livePrice; delete t.probedAt; }
  idx.clearOriginProbeState(c.origin);
  idx.rememberValidator(c.origin, "/openapi.json", ETAG);
  idx.rememberValidator(c.origin, "/.well-known/x402", ETAG);
  bodies.length = 0; seen304.length = 0;
  vc = await crawl(c.origin);
  ok(seen304.includes(`${c.origin}/openapi.json`), "seller c's second crawl was answered 304 for /openapi.json");
  ok(vc?.tools?.map((t) => `${t.method} ${t.route}`).sort().join(",") === routesBefore && Buffer.isBuffer(_cacheForTests().get(c.origin).openapiPacked), `the 304 crawl unpacked the rows into the same catalogue (${routesBefore}) and packed them again`);
  const posts = oaPosts(c.origin);
  ok(posts.length > 0 && posts[0].body.includes(`${MARK}-oa`), `the 304 crawl's first POST carried the OpenAPI example (${posts.length} POSTs)`);
  ok(vc?.tools?.find((t) => t.route === "/v1/oa")?.networks?.includes(ARC), "and the 304 crawl read the live chain");

  // Fix 3: a registry row with a query string takes the manifest's example.
  bodies.length = 0;
  vd = await crawl(d.origin);
  const drow = vd?.tools?.find((t) => String(t.route).startsWith("/v1/d"));
  ok(drow?.route === "/v1/d?mode=x", `seller d is listed by its registry row (${drow?.route})`);
  const dPost = bodies.find((x) => x.method === "POST" && x.url.startsWith("/v1/d"));
  ok(dPost && dPost.body.includes(MARK), "the registry row's first POST carried the manifest example for its path");
  ok(drow?.networks?.includes(ARC), "and its live chain was recorded");

  // Fix 2: a re-registration re-price, with no packed manifest kept (seller a
  // sends no validator), still leads with the example; and for seller c the
  // OpenAPI example comes from the memo.
  ok(!Buffer.isBuffer(_cacheForTests().get(a.origin)?.manifestBody), "seller a's entry keeps no packed manifest");
  __resetForcedCrawlForTest();
  for (const [o, route, want] of [[a.origin, "/v1/task/build", MARK], [c.origin, "/v1/oa", `${MARK}-oa`]]) {
    const ent = _cacheForTests().get(o);
    for (const t of ent.tools) { t.networks = []; t.price = null; }
    bodies.length = 0;
    const r = await registerOrigin(o, { crawl: async () => {} });
    ok(r?.listed && r?.reverify?.repriced !== false, `re-registration of ${route} listed and re-priced (${JSON.stringify(r?.reverify)})`);
    const first = bodies.find((x) => x.method === "POST" && x.url === route);
    ok(first && first.body.includes(want), `the re-price's first POST to ${route} carried the example`);
  }
} finally {
  for (const k of Object.keys(orig)) console[k] = orig[k];
}
{
  // The memo is the one structure holding examples across crawls: it is
  // populated, and nothing persisted, snapshotted, exported or projected
  // reaches its content.
  const st = __probeExampleMemoStatsForTest();
  ok(st.origins >= 3 && st.bytes > 0, `the memo holds the crawls' examples in memory (${JSON.stringify(st)})`);
  ok(!JSON.stringify(st).includes(MARK), "its stats are counts only");
  const leaks = [];
  const deep = (v, where, seen = new Set()) => {
    if (typeof v === "string") { if (v.includes(MARK)) leaks.push(where); return; }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Buffer.isBuffer(v)) return;
    if (v instanceof Map) { for (const [k, x] of v) { deep(k, `${where}<key>`, seen); deep(x, `${where}<${String(k).slice(0, 40)}>`, seen); } return; }
    if (v instanceof Set) { for (const x of v) deep(x, `${where}<set>`, seen); return; }
    for (const k of Reflect.ownKeys(v)) { try { deep(v[k], `${where}.${String(k)}`, seen); } catch { /* accessor */ } }
  };
  for (const o of [a.origin, b.origin, c.origin, d.origin]) {
    deep(sellerDetail(o), `seller detail ${o}`);
    const { manifestBody, ...rest } = _cacheForTests().get(o) || {};
    deep(rest, `cache entry ${o}`);
  }
  // Every exported value of the index module that is not a function.
  for (const [k, v] of Object.entries(idx)) if (typeof v !== "function") deep(v, `export ${k}`);
  deep([..._cacheForTests().entries()], "whole cache");
  ok(leaks.length === 0, `no seller detail, cache entry or exported value reaches an example (${leaks.slice(0, 5).join(", ")})`);
  ok(persistIndexCache(process.env.INDEX_CACHE_FILE) && !readFileSync(process.env.INDEX_CACHE_FILE, "utf8").includes(MARK), "the persisted index file carries no example after the later crawls");
  const asyncFile = join(TMP, "async-cache-2.json");
  await persistIndexCacheAsync(asyncFile);
  const written = [asyncFile, asyncFile.replace(/\.json$/, "") + ".ndjson"].filter((f) => existsSync(f));
  ok(written.length > 0 && written.every((f) => !readFileSync(f, "utf8").includes(MARK)), `the async snapshot files carry no example after the later crawls (${written.length} read)`);
  ok(!logged2.some((l) => l.includes(MARK)), `no log line of the later crawls or re-prices carries the example (${logged2.length} lines read)`);
  // A removed origin's examples leave the memo.
  const before = __probeExampleMemoStatsForTest().origins;
  const silence = console.log; console.log = () => {};
  try { await removeOrigin(d.origin, { note: "test" }); } finally { console.log = silence; }
  ok(__probeExampleMemoStatsForTest().origins === before - 1, "removing an origin drops its examples from the memo");
}

__testSetBazaarTools(d.origin, null);
__setProbeFetchForTest(null);
__setCrawlFetchForTest(null);
a.server.close(); b.server.close(); c.server.close(); d.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
