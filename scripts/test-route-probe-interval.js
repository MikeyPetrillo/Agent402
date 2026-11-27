#!/usr/bin/env node
// One seller route is sent an unpaid price read by the scheduled crawl at most
// once per ROUTE_PROBE_MIN_INTERVAL_MS (a week by default), whatever makes it
// due: a route that never yields a price, a price that keeps differing from
// the seller's documents, a 402 we cannot read. Driven through the real crawl on a fake
// clock, a crawl every 30 minutes for a week, counting requests per route:
//   * a route that answers a server error is asked, asked once more on the
//     next crawl (the one retry a read that got no answer of the route's own
//     keeps), then not again inside the week;
//   * a route whose 402 cannot be read, and a route whose live price differs
//     from its documents', are asked once in the week; a first "no such
//     route" answer is confirmed by one read past the confirm window;
//   * a paywall check the route refused for the shape of our request (a 400)
//     is not repeated daily;
//   * controls: a passing paywall check stays on its rotation, a failed one
//     is still re-checked after its own window, a re-registration still asks
//     at once, the stamp is kept across a rebuild and persisted, and with the
//     interval off the old cadence holds.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
Object.assign(process.env, ownStoreEnv("route-probe-interval"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
const { mkdtempSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const TMP = mkdtempSync(join(tmpdir(), "route-probe-interval-"));
process.env.REMOVED_ORIGINS_FILE = join(TMP, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(TMP, "x402-index-cache.json");

// The fake clock: every Date.now() in the crawl reads it.
const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");
// Requests sent so far, by kind: price reads and paywall checks apart.
const sentOf = (kind) => Number(sellerLoad.status().budget.requests[kind] || 0);
const cadence = await import("../src/crawl-cadence.js");
const OFF = process.env.ROUTE_PROBE_MIN_INTERVAL_DAYS === "off";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = (amount) => [{ scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const quote402 = (amount) => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: accepts(amount) })).toString("base64") } });

const docs = new Map();
idx.__setCrawlFetchForTest(async (url) => {
  const d = docs.get(url);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: d, finalUrl: url, validators: {} };
});
// What each route answers an unpaid request: a function of the path.
const answers = new Map();
// One pass is every request a route is sent at one moment of the fake clock
// (a price read may try the route's GET and then its POST): `asked` counts
// passes, `requests` every request.
const hits = new Map(), passes = new Map();
let stage = "crawl";
idx.__setProbeFetchForTest(async (url) => {
  const u = new URL(url);
  const k = `${u.origin}${u.pathname}`;
  hits.set(k, (hits.get(k) || 0) + 1);
  if (!passes.has(k)) passes.set(k, new Set());
  passes.get(k).add(`${ahead} ${stage}`);
  const a = answers.get(k);
  return a ? a() : new Response("{}", { status: 404 });
});
const asked = (O, p) => passes.get(`${O}${p}`)?.size || 0;
const requests = (O, p) => hits.get(`${O}${p}`) || 0;
const rowsOf = (O) => idx._cacheForTests().get(O)?.tools || [];
const rowOf = (O, p) => rowsOf(O).find((t) => t.route === p);

/** A seller whose OpenAPI lists `routes` ([path, declared USD or null]). */
function serve(O, routes) {
  const priced = routes.filter(([, usd]) => usd != null);
  if (priced.length) docs.set(`${O}/.well-known/x402`, JSON.stringify({ x402Version: 2, name: "Seller", resources: priced.map(([p, usd]) => ({ resource: `${O}${p}`, method: "GET", description: `Route ${p}`, price: `$${usd}`, accepts: accepts(String(Math.round(Number(usd) * 1e6))) })) }));
  docs.set(`${O}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "Seller" }, servers: [{ url: O }], paths: Object.fromEntries(routes.map(([p, usd]) => [p, { get: { operationId: p.replace(/\W+/g, "_"), summary: `Route ${p}`, ...(usd == null ? { "x-payment-info": { protocols: ["x402"] } } : {}) } }])) }));
}
/** A crawl every 30 minutes for `days`, each one the seller's paywall
 *  rotation turn (as every crawl is in an index this small). */
async function crawlFor(O, days, opts) {
  for (let m = 0; m < days * 24 * 60; m += 30) {
    idx.__resetPaywallProbeForTest({ cursor: 0 });
    await idx.__crawlSellerForTest(O, opts);
    ahead += 30 * MIN;
  }
}

ok(OFF ? cadence.ROUTE_PROBE_MIN_INTERVAL_MS === 0 : cadence.ROUTE_PROBE_MIN_INTERVAL_MS === 7 * DAY, `the interval is a week by default, 0 when switched off (${cadence.ROUTE_PROBE_MIN_INTERVAL_MS})`);

// ---- a route that answers a server error: one ask, one retry, then the week ----
const A = "https://flaky.example";
serve(A, [["/v1/down", null]]);
answers.set(`${A}/v1/down`, () => new Response("oops", { status: 503 }));
await crawlFor(A, 6.5);
const downAsks = asked(A, "/v1/down");
if (OFF) ok(downAsks > 10, `control (interval off): the old cadence asks a failing route many times a week (${downAsks})`);
else ok(downAsks === 2, `a route answering 503 is asked once and retried once in a week of crawls (${downAsks})`);
if (!OFF) {
  ok(Number(rowOf(A, "/v1/down")?.unpaidAskedAt) > 0, "the ask is stamped on the row, and the stamp survives each rebuild");
  ok(idx.persistIndexCache(process.env.INDEX_CACHE_FILE) && readFileSync(process.env.INDEX_CACHE_FILE, "utf8").includes("unpaidAskedAt"), "the stamp is persisted with the row");
  // The route recovers: it is quoted on the first ask after the week.
  answers.set(`${A}/v1/down`, () => quote402("3000"));
  const reads = sentOf("quote");
  await crawlFor(A, 1);
  ok(sentOf("quote") === reads + 1 && rowOf(A, "/v1/down")?.price === 0.003, `a week after the last ask it is asked again and quoted (${sentOf("quote") - reads} price read, price ${rowOf(A, "/v1/down")?.price})`);
}

// ---- the retry reads a route that recovered by the next crawl -----------------
if (!OFF) {
  const R = "https://recovers.example";
  serve(R, [["/v1/blip", null]]);
  answers.set(`${R}/v1/blip`, () => new Response("oops", { status: 502 }));
  await crawlFor(R, 1 / 48);
  answers.set(`${R}/v1/blip`, () => quote402("3000"));
  await crawlFor(R, 1 / 48);
  ok(asked(R, "/v1/blip") === 2 && rowOf(R, "/v1/blip")?.price === 0.003, `the next crawl asks a route that answered 502 again and quotes its 402 (${asked(R, "/v1/blip")} asks, price ${rowOf(R, "/v1/blip")?.price})`);
}

// ---- a first "no such route": the read that confirms it, no sooner -------------
if (!OFF) {
  const M = "https://missing.example";
  const rows = [{ seller: M, route: "/v1/old", method: "GET", declared: false, provenance: "bazaar", paid: true }];
  const pass = async () => { await idx.enrichLiveQuotes(rows, M); return asked(M, "/v1/old"); };
  ok(await pass() === 1 && rows.length === 1 && idx.goneMark(M, "GET", "/v1/old")?.kind === "pending", "an undeclared route answering 404 is kept after one reading");
  ahead += 30 * MIN;
  ok(await pass() === 1, "the crawl half an hour on does not ask it (the confirming read waits out the confirm window)");
  ahead += idx.MISS_CONFIRM_MS;
  ok(await pass() === 2 && rows.length === 0, `past the window the one retry confirms the miss and the row leaves (${rows.length} left)`);
}

// ---- a 402 we cannot read, and a price that keeps differing ---------------------
const B = "https://unreadable.example";
serve(B, [["/v1/odd", null]]);
answers.set(`${B}/v1/odd`, () => new Response(JSON.stringify({ error: "pay" }), { status: 402 }));
await crawlFor(B, 6.5);
if (OFF) ok(asked(B, "/v1/odd") > 10, `control (interval off): an unreadable 402 is asked many times a week (${asked(B, "/v1/odd")})`);
else ok(asked(B, "/v1/odd") === 1, `a route whose 402 we cannot read is asked once in a week of crawls (${asked(B, "/v1/odd")})`);

// A price the seller's documents CHANGED since the pass, and that now differs
// from the one held, is read once; one that only keeps differing is not.
if (!OFF) {
  const row = (declared) => ({ route: "/v1/drift", method: "GET", price: 0.03, quoteSource: "live-402", originDeclaredPrice: declared, networks: ["eip155:8453"], unpaidAskedAt: Date.now() - DAY, unpaidAskedDeclared: 10_000 });
  ok(idx.priceDisagreesWithOrigin(row(0.01)) && idx.routeHeldToInterval(row(0.01)) === true, "a live price that keeps differing from the same documents' price is held to the interval");
  ok(idx.routeHeldToInterval(row(0.2)) === false, "a price the seller's documents changed since the last pass is read inside it");
  ok(idx.routeHeldToInterval({ ...row(0.01), unpaidAskedAt: Date.now() - 8 * DAY }) === false && idx.routeHeldToInterval({ route: "/v1/new" }) === false, "a route asked over a week ago, or never, is not held");
}

// ---- healthy priced routes: one price read each in the week --------------------
// The paywall check (one request to the cheapest paid route, on a rotation
// across the index) keeps its own cadence, so price reads are counted apart.
const C = "https://healthy.example";
serve(C, [["/v1/cheap", "0.01"], ["/v1/mid", "0.5"]]);
answers.set(`${C}/v1/cheap`, () => quote402("10000"));
answers.set(`${C}/v1/mid`, () => quote402("500000"));
{
  let reads = sentOf("quote"), checks = sentOf("paywall");
  await crawlFor(C, 6.5);
  ok(sentOf("quote") - reads === 2 && requests(C, "/v1/mid") === 1, `a healthy priced route gets one price read in a week of crawls, on and off (${sentOf("quote") - reads} reads of two routes)`);
  // A passing paywall check stays on the rotation (the reputation record's
  // paywall metric needs its samples): the seller's turn still asks.
  ok(sentOf("paywall") - checks > 100 && idx._cacheForTests().get(C)?.paywall?.ok === true, `control: a passing paywall check is still made on each rotation turn (${sentOf("paywall") - checks} in the week)`);
  if (!OFF) {
    reads = sentOf("quote");
    await crawlFor(C, 1);
    ok(sentOf("quote") - reads === 2 && requests(C, "/v1/mid") === 2, `a week on, each is read again once (${sentOf("quote") - reads})`);
    // A re-registration asks at once: every route's price.
    reads = sentOf("quote");
    stage = "registration";
    await idx.enrichLiveQuotes(rowsOf(C), C, { ignoreBudget: true });
    ok(sentOf("quote") - reads === 2, `a re-registration reads every route's price again inside the week (${sentOf("quote") - reads})`);
    stage = "crawl";
  }
}

// ---- a paywall check the route refused for the shape of our request ------------
// Every crawl here is the seller's rotation turn and the re-check budget is full.
{
  const D = "https://needs-input.example";
  serve(D, [["/v1/search", "0.01"]]);
  answers.set(`${D}/v1/search`, () => new Response(JSON.stringify({ error: "q is required" }), { status: 400 }));
  await crawlFor(D, 6.5);
  const pw = idx._cacheForTests().get(D)?.paywall;
  ok(pw?.unknown === true && pw?.status === 400, `control: a 400 to our bare request is no verdict (${JSON.stringify({ ok: pw?.ok, status: pw?.status })})`);
  // One price read (then held for days by the route's own refusal) and one paywall check.
  if (OFF) ok(requests(D, "/v1/search") > 6, `control (interval off): a route that answers our bare request 400 is asked again every day (${requests(D, "/v1/search")} requests in the week)`);
  else {
    ok(requests(D, "/v1/search") <= 3, `a route that answers our bare request 400 is not asked daily (${requests(D, "/v1/search")} requests in a week of crawls)`);
    const checks = sentOf("paywall");
    await idx.__crawlSellerForTest(D, { forcePaywall: true });
    ok(sentOf("paywall") === checks + 1, "a re-registration checks that paywall at once");
    await crawlFor(D, 1 / 48);
    ok(sentOf("paywall") === checks + 1, "the crawl after it is held again");
    ahead += 8 * DAY;
    await crawlFor(D, 1 / 48);
    ok(sentOf("paywall") === checks + 2, `and a week on the check is made again (${sentOf("paywall") - checks - 1})`);
  }
}

// ---- controls: what still asks inside the week ------------------------------
if (!OFF) {
  // A failed paywall verdict keeps its own re-check window (a day by default).
  const E = "https://broken-paywall.example";
  serve(E, [["/v1/open", "0.01"]]);
  answers.set(`${E}/v1/open`, () => quote402("10000"));
  await crawlFor(E, 1 / 48);
  const e = idx._cacheForTests().get(E);
  idx._cacheForTests().set(E, { ...e, paywall: { ...e.paywall, ok: false, status: 500, reason: "server_error", at: Date.now() - 25 * HOUR } });
  const before = sentOf("paywall");
  idx.__resetPaywallProbeForTest({ cursor: 0 });
  await idx.__crawlSellerForTest(E);
  ok(sentOf("paywall") === before + 1 && idx._cacheForTests().get(E)?.paywall?.ok === true, `a failed paywall verdict past its re-check window is asked again inside the week (${sentOf("paywall") - before})`);
}

// ---- the same crawls with the interval switched off --------------------------
if (!OFF) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ROUTE_PROBE_MIN_INTERVAL_DAYS: "off" }, encoding: "utf8", timeout: 240_000 });
  const tail = String(r.stdout || "").trim().split("\n").slice(-1)[0];
  ok(r.status === 0, `ROUTE_PROBE_MIN_INTERVAL_DAYS=off restores the cadence before it (${tail})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
