#!/usr/bin/env node
// An unpaid quote probe never runs a seller's free endpoint, and never runs
// state-changing work. The probe exists to read a 402 offer: a paid route
// answers 402 before its handler, a free route answers by running. Pinned
// against loopback sellers on port 0 that count every request by verb and
// route, across real crawls (documents through the crawl seam, probes through
// the probe seam):
//   1. a POST the seller's OpenAPI marks free receives ZERO requests across
//      two crawls, also when its x402 manifest lists it;
//   2. a paid POST is still read and quoted from its 402, and a paid GET is
//      quoted exactly as before (one GET);
//   3. a POST that answers 200 to its first probe body receives no second
//      body, and an unmarked POST (no price, no paid annotation, no listing)
//      receives none at all;
//   4. a route that answered 400 or 429 is held: the next crawl inside the
//      hold sends it nothing, the hold is on the row (persisted), and once it
//      lapses the route is asked again;
//   5. a route that answered 502, or a redirect, is NOT held: the next crawl
//      asks it again, and a 402 it then answers is quoted.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.X402_INDEX_CRAWL = "off";
const { mkdtempSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const TMP = mkdtempSync(join(tmpdir(), "quote-probe-free-"));
process.env.REMOVED_ORIGINS_FILE = join(TMP, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(TMP, "x402-index-cache.json");
const { createServer } = await import("node:http");
const idx = await import("../src/x402-index.js");
const { __setCrawlFetchForTest, __setProbeFetchForTest, __crawlSellerForTest, __resetRobotsCacheForTest, _cacheForTests,
  persistIndexCache, sellerDeclaresFree, sellerMarksPaid, quoteProbeVerbsFor, routeAnsweredItself, QUOTE_REFUSED_BACKOFF_MS } = idx;

let pass = 0, fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const ok = (c, m) => { if (c) { pass++; say(`ok - ${m}`); } else { fail++; say(`FAIL - ${m}`); } };

const PAY_TO = "0x" + "c3".repeat(20);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const header402 = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] })).toString("base64");

// ------------------------------------------------------------ pure rules
if (typeof sellerDeclaresFree !== "function" || typeof sellerMarksPaid !== "function" || typeof quoteProbeVerbsFor !== "function") ok(false, "the probe's rule helpers are exported");
else {
  ok(sellerDeclaresFree({ route: "/a", method: "POST", paid: false }), "paid:false from the seller's document is declared free");
  ok(sellerDeclaresFree({ route: "/a", method: "POST", price: 0 }), "a price of exactly zero is declared free");
  ok(!sellerDeclaresFree({ route: "/a", method: "POST", paid: false, quoteSource: "live-200" }), "a free reading we made ourselves is not the seller's declaration");
  ok(!sellerDeclaresFree({ route: "/a", method: "POST", paid: false, networks: ["eip155:8453"] }), "chains beside paid:false are a payment signal");
  ok(!sellerDeclaresFree({ route: "/a", method: "POST", price: null }), "no price at all is not a declaration");
  ok(!sellerMarksPaid({ route: "/a", method: "POST", price: null, networks: [] }), "an unpriced, unannotated, unlisted row is not marked paid");
  ok(sellerMarksPaid({ route: "/a", method: "POST", paid: true }) && sellerMarksPaid({ route: "/a", method: "POST", price: "$0.01" }) && sellerMarksPaid({ route: "/a?x=1", method: "POST" }, new Set(["/a"])), "a paid annotation, a price, or an x402 manifest listing marks it paid");
  ok(quoteProbeVerbsFor({ route: "/a", methodInferred: true, method: "GET" }).join() === "GET", "an unmarked row of unknown verb is read with GET only");
  ok(quoteProbeVerbsFor({ route: "/a", method: "POST" }).length === 0, "an unmarked POST row is not probed");
  ok(quoteProbeVerbsFor({ route: "/a", method: "GET", paid: true }, null, { paid: new Set(), free: new Set(["/a"]) }).join() === "GET", "a POST the seller marks free on the route is never asked from a sibling GET row");
  ok(quoteProbeVerbsFor({ route: "/a", method: "GET" }, null, { paid: new Set(["/a"]), free: new Set() }).join() === "GET,POST", "a GET row may ask the POST its declared sibling sells");
}

if (typeof routeAnsweredItself !== "function") ok(false, "the hold's status rule is exported");
else {
  ok([200, 204, 400, 401, 403, 404, 422, 429].every((st) => routeAnsweredItself(st)), "a success, and a refusal of the route's own (a 429 included), is the route's own answer");
  ok([402, 301, 302, 307, 500, 502, 503, 504, 0, undefined, NaN].every((st) => !routeAnsweredItself(st)), "a 402, a redirect, a server error and no answer at all are not");
}

// ------------------------------------------------------------ sellers
const listen = (handler) => new Promise((resolve) => {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1", () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const hits = new Map(); // "origin METHOD /path" -> count
const bodies = new Map(); // "origin METHOD /path" -> [body]
const count = (origin, method, path) => hits.get(`${origin} ${method} ${path}`) || 0;
const countAll = (origin, path) => count(origin, "GET", path) + count(origin, "POST", path) + count(origin, "PUT", path) + count(origin, "DELETE", path);
// What each route answers, by verb: a status (402 carries the offer).
const ROUTES = {
  "/v1/trial-key": { POST: 200, GET: 405 },        // free, state-changing: mints a key
  "/v1/free-zero": { POST: 200, GET: 405 },        // free by a zero price
  "/v1/paid-post": { POST: 402, GET: 405 },        // paid POST
  "/v1/free-get": { GET: 200, POST: 405 },         // free read
  "/v1/listed-only": { POST: 402, GET: 405 },      // only the x402 manifest names it
  "/v1/paid-get": { GET: 402, POST: 405 },         // paid GET
  "/v1/runs-on-body": { POST: 200, GET: 405 },     // marked paid, but serves the first body
  "/v1/unmarked": { POST: 402, GET: 405 },         // no marker anywhere
  "/v1/needs-input": { GET: 400, POST: 400 },      // validates before anything
  "/v1/capped": { POST: 429, GET: 405 },           // the seller's daily cap
  "/v1/flaky": { GET: 502 },                       // a gateway error now, a 402 later (set below)
  "/v1/moved": { GET: 302 },                       // a redirect now, a 402 later
};
const seller = (req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const path = new URL(req.url, "http://x").pathname;
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const k = `${origin} ${req.method} ${path}`;
    hits.set(k, (hits.get(k) || 0) + 1);
    (bodies.get(k) || bodies.set(k, []).get(k)).push(raw);
    const status = ROUTES[path]?.[req.method] ?? 404;
    if (status === 402) { res.writeHead(402, { "content-type": "application/json", "payment-required": header402 }); return res.end("{}"); }
    if (status === 302) { res.writeHead(302, { location: "/elsewhere" }); return res.end(); }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { key: "minted" } : { error: "no" }));
  });
};
const a = await listen(seller); // the main seller
const b = await listen(seller); // the 429 seller (a 429 holds a host's probes on its own)
const c = await listen(seller); // the seller whose routes answer a 502 and a redirect first
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
const body = (fields) => ({ required: true, content: { "application/json": { schema: { type: "object", required: fields, properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])) }, example: Object.fromEntries(fields.map((f) => [f, "example"])) } } });
const op = (extra = {}) => ({ summary: "Op.", responses: { 200: { description: "ok" } }, ...extra });
const openapiFor = (paths) => ({ openapi: "3.1.0", info: { title: "s", version: "1" }, paths });
// Seller a: the x402 manifest lists the paid routes AND the free trial-key
// route (a listing never outranks the seller's own free marking); the OpenAPI
// distinguishes paid operations, so its unannotated operations read free.
served.set(`${a.origin}/.well-known/x402`, { x402Version: 2, resources: [
  `${a.origin}/v1/paid-post`, `${a.origin}/v1/trial-key`, `${a.origin}/v1/runs-on-body`, `${a.origin}/v1/listed-only`,
  { resource: `${a.origin}/v1/paid-get`, method: "GET", description: "Paid read." },
] });
served.set(`${a.origin}/openapi.json`, openapiFor({
  "/v1/trial-key": { post: op({ requestBody: body(["email"]) }) },
  "/v1/free-zero": { post: op({ "x-price-usd": 0, requestBody: body(["q"]) }) },
  "/v1/paid-post": { post: op({ "x-payment-required": true, requestBody: body(["url"]) }) },
  "/v1/runs-on-body": { post: op({ "x-payment-required": true, requestBody: body(["text", "lang"]) }) },
  "/v1/needs-input": { get: op({ "x-payment-required": true }) },
  "/v1/paid-get": { get: op({ "x-payment-required": true }) },
  "/v1/free-get": { get: op() },
}));
// Seller b: no document marks /v1/unmarked; /v1/capped is paid-annotated.
served.set(`${b.origin}/openapi.json`, { openapi: "3.1.0", info: { title: "b", version: "1" }, paths: {
  "/v1/unmarked": { post: op({ requestBody: body(["x"]) }) },
  "/v1/capped": { post: op({ requestBody: body(["x"]), "x-payment": { network: "base", payTo: PAY_TO } }) },
} });

// Seller c: two paid GET routes.
served.set(`${c.origin}/openapi.json`, openapiFor({
  "/v1/flaky": { get: op({ "x-payment-required": true }) },
  "/v1/moved": { get: op({ "x-payment-required": true }) },
}));

const silence = { log: console.log, warn: console.warn, info: console.info };
const crawl = async (origin) => {
  for (const k of Object.keys(silence)) console[k] = () => {};
  try { __resetRobotsCacheForTest(); await __crawlSellerForTest(origin); } finally { for (const k of Object.keys(silence)) console[k] = silence[k]; }
  return _cacheForTests().get(origin);
};
const row = (entry, route, method) => entry?.tools?.find((t) => t.route === route && (!method || String(t.method).toUpperCase() === method));

try {
  // ---------------------------------------------------------- crawl 1
  const a1 = await crawl(a.origin);
  const b1 = await crawl(b.origin);
  ok(Boolean(row(a1, "/v1/trial-key")), "the free route is listed");
  ok(row(a1, "/v1/trial-key")?.paid === false, "and listed as declared free");
  ok(countAll(a.origin, "/v1/trial-key") === 0, `crawl 1: the free-marked POST received no request (${countAll(a.origin, "/v1/trial-key")})`);
  ok(countAll(a.origin, "/v1/free-zero") === 0, `crawl 1: the zero-priced POST received no request (${countAll(a.origin, "/v1/free-zero")})`);
  ok(row(a1, "/v1/free-get")?.paid === false && countAll(a.origin, "/v1/free-get") === 0, `crawl 1: a free-marked GET is not probed either (${countAll(a.origin, "/v1/free-get")})`);
  const listed = row(a1, "/v1/listed-only");
  ok(listed?.price === 0.003 && count(a.origin, "POST", "/v1/listed-only") === 1, `a route only the x402 manifest lists (verb unknown) is still quoted by one POST (price ${listed?.price}, POST ${count(a.origin, "POST", "/v1/listed-only")})`);
  const paidPost = row(a1, "/v1/paid-post", "POST");
  ok(paidPost?.price === 0.003 && paidPost?.networks?.includes("eip155:8453"), `the paid POST is quoted from its 402 (price ${paidPost?.price})`);
  ok(count(a.origin, "POST", "/v1/paid-post") === 1, `with one POST (${count(a.origin, "POST", "/v1/paid-post")})`);
  const paidGet = row(a1, "/v1/paid-get", "GET");
  // Two GETs: the quote read, and the paywall probe (which asks the cheapest paid GET route).
  ok(paidGet?.price === 0.003 && count(a.origin, "GET", "/v1/paid-get") === 2 && count(a.origin, "POST", "/v1/paid-get") === 0, `the paid GET is quoted by GET with no POST, as before (price ${paidGet?.price}, GET ${count(a.origin, "GET", "/v1/paid-get")}, POST ${count(a.origin, "POST", "/v1/paid-get")})`);
  ok(count(a.origin, "POST", "/v1/runs-on-body") === 1, `a POST that answered 200 to its first body got no second body (${count(a.origin, "POST", "/v1/runs-on-body")} POSTs)`);
  ok(countAll(b.origin, "/v1/unmarked") === 0, `an unmarked POST received no request (${countAll(b.origin, "/v1/unmarked")})`);
  ok(count(b.origin, "POST", "/v1/capped") === 1, `the capped POST was asked once (${count(b.origin, "POST", "/v1/capped")})`);
  ok(count(a.origin, "GET", "/v1/needs-input") >= 1 && count(a.origin, "POST", "/v1/needs-input") <= 1, `the 400 route was asked (GET ${count(a.origin, "GET", "/v1/needs-input")}, POST ${count(a.origin, "POST", "/v1/needs-input")})`);
  const held = row(a1, "/v1/needs-input"), heldB = row(b1, "/v1/capped");
  ok(Number(held?.quoteRefusedUntil) > Date.now() + QUOTE_REFUSED_BACKOFF_MS / 2 && Number(heldB?.quoteRefusedUntil) > Date.now(), `a route answering 400 or 429 is held for days (${held?.quoteRefusedUntil}, ${heldB?.quoteRefusedUntil})`);
  ok(persistIndexCache(process.env.INDEX_CACHE_FILE) && readFileSync(process.env.INDEX_CACHE_FILE, "utf8").includes("quoteRefusedUntil"), "the hold is persisted with the row");

  // ---------------------------------------------------------- crawl 2
  const before = new Map(hits);
  const delta = (origin, method, path) => count(origin, method, path) - (before.get(`${origin} ${method} ${path}`) || 0);
  const a2 = await crawl(a.origin);
  const b2 = await crawl(b.origin);
  ok(countAll(a.origin, "/v1/trial-key") === 0 && countAll(a.origin, "/v1/free-zero") === 0 && countAll(a.origin, "/v1/free-get") === 0, "crawl 2: the free-marked routes still received ZERO requests");
  ok(countAll(b.origin, "/v1/unmarked") === 0, "crawl 2: the unmarked POST still received none");
  ok(delta(a.origin, "GET", "/v1/needs-input") + delta(a.origin, "POST", "/v1/needs-input") === 0, `crawl 2: the 400 route inside its hold was not asked (${delta(a.origin, "GET", "/v1/needs-input")} GET, ${delta(a.origin, "POST", "/v1/needs-input")} POST)`);
  ok(delta(b.origin, "POST", "/v1/capped") === 0, `crawl 2: the 429 route inside its hold was not asked (${delta(b.origin, "POST", "/v1/capped")})`);
  ok(delta(a.origin, "POST", "/v1/runs-on-body") === 0, `crawl 2: the route that served its first body is held too (${delta(a.origin, "POST", "/v1/runs-on-body")})`);
  ok(Number(row(a2, "/v1/needs-input")?.quoteRefusedUntil) === Number(held.quoteRefusedUntil), "the hold is carried onto the rebuilt row");
  ok(row(a2, "/v1/paid-post", "POST")?.price === 0.003 && row(a2, "/v1/paid-get", "GET")?.price === 0.003, "both paid routes keep their quotes");
  ok(Number(row(b2, "/v1/capped")?.quoteRefusedUntil) > Date.now(), "the 429 seller's hold is carried too");

  // ---------------------------------------------------------- the hold lapses
  for (const t of _cacheForTests().get(a.origin).tools) if (t.route === "/v1/needs-input") t.quoteRefusedUntil = Date.now() - 1;
  const mid = new Map(hits);
  await crawl(a.origin);
  const asked = count(a.origin, "GET", "/v1/needs-input") - (mid.get(`${a.origin} GET /v1/needs-input`) || 0);
  ok(asked >= 1, `past its hold the route is asked again (${asked} GET)`);
  const again = row(_cacheForTests().get(a.origin), "/v1/needs-input");
  ok(Number(again?.quoteRefusals) === 2 && Number(again?.quoteRefusedUntil) - Date.now() > QUOTE_REFUSED_BACKOFF_MS * 1.5, `a second refusal holds it longer (${again?.quoteRefusals}, ${Math.round((Number(again?.quoteRefusedUntil) - Date.now()) / 3600000)} h)`);
  ok(countAll(a.origin, "/v1/trial-key") === 0, "after three crawls the free-marked POST has still received nothing");

  // ---------------------------------------------------------- a 502 or a redirect starts no hold
  {
    const c1 = await crawl(c.origin);
    const flaky = row(c1, "/v1/flaky"), moved = row(c1, "/v1/moved");
    ok(count(c.origin, "GET", "/v1/flaky") >= 1 && count(c.origin, "GET", "/v1/moved") >= 1, `the 502 route and the redirecting route were asked (${count(c.origin, "GET", "/v1/flaky")}, ${count(c.origin, "GET", "/v1/moved")})`);
    ok(flaky && !("quoteRefusedUntil" in flaky) && !flaky.quoteRefusals, `a route that answered 502 is not held (${flaky?.quoteRefusedUntil})`);
    ok(moved && !("quoteRefusedUntil" in moved) && !moved.quoteRefusals, `a route that answered a redirect is not held (${moved?.quoteRefusedUntil})`);
    ROUTES["/v1/flaky"] = { GET: 402 }; ROUTES["/v1/moved"] = { GET: 402 };
    const f0 = count(c.origin, "GET", "/v1/flaky"), m0 = count(c.origin, "GET", "/v1/moved");
    const c2 = await crawl(c.origin);
    ok(count(c.origin, "GET", "/v1/flaky") > f0 && row(c2, "/v1/flaky")?.price === 0.003, `the next crawl asks the 502 route again and quotes its 402 (asked ${count(c.origin, "GET", "/v1/flaky") - f0}, price ${row(c2, "/v1/flaky")?.price})`);
    ok(count(c.origin, "GET", "/v1/moved") > m0 && row(c2, "/v1/moved")?.price === 0.003, `and the redirecting route the same (asked ${count(c.origin, "GET", "/v1/moved") - m0}, price ${row(c2, "/v1/moved")?.price})`);
  }
  ok([...hits.keys()].every((k) => !/ (PUT|PATCH|DELETE) /.test(k)), "no probe ever used PUT, PATCH or DELETE");
} finally {
  a.server.close(); b.server.close(); c.server.close();
}
say(`test-quote-probe-free-routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
