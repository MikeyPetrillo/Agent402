#!/usr/bin/env node
// Offline proof of scripts/catalog-buy.js: a stub server that answers 402 then
// 200 (or worse) for a handful of routes, a fake payer that signs nothing, and
// assertions over the grade, the cap, the rotation slice math, the funding
// preflight, the exit codes and the summary. No network, no wallet, no money.
//
//   node scripts/test-catalog-buy.js
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import {
  catalogFromSurfaces, quoteCeilingUsd, planRun, weeklySlices, sliceIndexFor, dayOfYear, gradeAnswer, exitCodeFor,
  resultWordFor, headlineFor, summaryTable, markdownSummary, runCatalogBuy, tierOf, micro, DAILY_MAX_USD, ROTATION_DAYS,
  PROD_EMPTY_ARRAY_OK, DEFAULT_CONCURRENCY, DEFAULT_PACE_MS, needsOwnSale, isSaleSource, withOwnSale, SALE_SOURCE_SLUG, NO_OWN_SALE,
} from "./catalog-buy.js";
import { captureRecord, REDACTED } from "./catalog-buy-capture.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// ---- the stub catalog -------------------------------------------------------
const OLD_TX = "0x2f1fecade9bd945e7817c11e5a34cafe6b349dd8c92a7587efed1de476bddfeb";
let hashDown = false;
const settled = new Map(); // tx -> slug of the paid 200 it settled
let txCounter = 0;
const ownSaleOf = (tx) => { const slug = settled.get(String(tx || "")); return slug && !ROUTES_BY_SLUG[slug]?.identityBound ? slug : null; };
let ROUTES_BY_SLUG = {};
// price, documented example input, documented 200 example, and how the stub answers.
const ROUTES = {
  "/api/healthy":     { slug: "healthy",     usd: 0.001, input: { text: "hi" },  output: { hex: "ab", rows: [1] },        answer: () => [200, { hex: "cd", rows: [1, 2] }] },
  "/api/hollow":      { slug: "hollow",      usd: 0.002, input: { q: "a" },      output: { items: [1, 2], count: 2 },     answer: () => [200, { items: [], count: 0 }] },
  "/api/broken":      { slug: "broken",      usd: 0.003, input: { q: "a" },      output: { ok: true },                    answer: () => [500, { error: "boom" }] },
  "/api/flaky":       { slug: "flaky",       usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: (n) => (n === 1 ? [503, { error: "wobble" }] : [200, { ok: true }]) },
  "/api/unsettled":   { slug: "unsettled",   usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [402, { error: "settle failed" }] },
  "/api/error-field": { slug: "error-field", usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: false, error: "nope" }] },
  "/api/four":        { slug: "four",        usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [422, { error: "bad input" }] },
  "/api/missing":     { slug: "missing",     usd: 0.001, input: { q: "a" },      output: { a: 1, b: [1] },                answer: () => [200, { c: 1 }] },
  "/api/memory":      { slug: "memory",      usd: 0.001, input: { q: "a" },      output: { keys: ["k"] },                 answer: () => [200, { keys: [] }], identityBound: true },
  "/api/demand-radar":{ slug: "demand-radar",usd: 0.001, input: { q: "a" },      output: { radar: [1] },                  answer: () => [200, { radar: [] }] },
  "/api/quote-high":  { slug: "quote-high",  usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: true }], quoteMicro: 2000 },
  "/api/binary":      { slug: "binary",      usd: 0.001, input: { q: "a" },      binary: true,                            answer: () => [200, Buffer.from("PNG...bytes")] },
  "/api/no-example":  { slug: "no-example",  usd: 0.001, input: undefined,       output: { ok: true },                    answer: () => [200, { ok: true }] },
  "/api/get-one":     { slug: "get-one",     usd: 0.001, get: [{ name: "q", in: "query", required: true, example: "x" }, { name: "Idempotency-Key", in: "header", required: false }], output: { q: "x", n: 1 }, answer: (n, q) => [200, { q, n: 1 }] },
  "/api/free":        { slug: "free",        usd: 0,     input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: true }] },
  "/api/verb":        { slug: "verb",        usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: true }], pricingMethod: "GET" },
  "/v1/pricey":       { slug: "pricey",      usd: 5,     input: { topic: "t" },  output: { report: "r", sources: [1] },   answer: () => [200, { report: "r", sources: [1] }] },
  "/v1/pricey-two":   { slug: "pricey-two",  usd: 0.5,   input: { topic: "t" },  output: { report: "r" },                 answer: () => [200, { report: "r" }] },
  // Quoted tools: the list price is the floor, the 402 quotes per request under a documented ceiling.
  // The price-list row carries quoted + quoteRange; the spec op carries x-payment-info mode dynamic.
  "/api/quoted-ok":   { slug: "quoted-ok",   usd: 0.001, input: { depth: "plan" }, output: { plan: [1] },                 answer: () => [200, { plan: [1] }], quoteMicro: 20_000, quoted: { minUsd: 0.001, maxUsd: 0.05 } },
  "/api/quoted-high": { slug: "quoted-high", usd: 0.001, input: { depth: "full" }, output: { plan: [1] },                 answer: () => [200, { plan: [1] }], quoteMicro: 60_000, quoted: { minUsd: 0.001, maxUsd: 0.05 } },
  // Ceiling published on the spec only (an older price list without the row fields).
  "/api/quoted-spec": { slug: "quoted-spec", usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: true }], quoteMicro: 15_000, quoted: { minUsd: 0.001, maxUsd: 2 }, rowSaysNothing: true },
  // A priced-by-model flat tier publishes a dynamic range too, but its own example is held to its list price.
  "/api/by-model":    { slug: "by-model",    usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: true }], quoteMicro: 2_000, quoted: { minUsd: 0.001, maxUsd: 0.5 }, rowSaysNothing: true, pricedByModel: true },
  // A slug whose route is not /api/<slug>: the spec's path is requested, never one spelled from the slug.
  "/api/nested/run":  { slug: "nested-run",  usd: 0.001, input: { q: "a" },      output: { ok: true },                    answer: () => [200, { ok: true }] },
  // Payer-keyed receipts list external settlements only; the run's own buys book internal, so the burner's are empty.
  "/api/receipts":    { slug: "receipts",    usd: 0.001, input: { from: "2026-09-01" }, output: { total: 2, rows: [{ item: "hash" }] }, answer: () => [200, { total: 0, rows: [] }], identityBound: true },
  // The paid canary's sale source, and the two identity-bound tools that name the CALLER's own
  // sale by its tx: they answer only for a sale the stub settled to a non-identity-bound route
  // (like production: attest refuses an old sale with no digest, 422), and echo the tx they got.
  "/api/hash":        { slug: "hash",        usd: 0.001, input: { text: "hello world" }, output: { hex: "b94d" },        answer: () => (hashDown ? [500, { error: "down" }] : [200, { hex: "b94d27" }]) },
  "/api/attest":      { slug: "attest",      usd: 0.01,  input: { tx: OLD_TX },  output: { uid: "0xu", settlementTx: OLD_TX, data: { slug: "hash" } }, identityBound: true,
    answer: (n, q, body) => (ownSaleOf(body?.tx) ? [200, { uid: "0xu", settlementTx: body.tx, data: { slug: ownSaleOf(body.tx) } }] : [422, { error: `Your sale in ${body?.tx} has no recorded response digest` }]) },
  "/api/feedback":    { slug: "feedback",    usd: 0.01,  input: { tx: OLD_TX, verdict: "good" }, output: { recorded: true, item: "hash" }, identityBound: true,
    answer: (n, q, body) => (ownSaleOf(body?.tx) ? [200, { recorded: true, item: ownSaleOf(body.tx) }] : [403, { error: "no settled call of yours" }]) },
};
const pricing = { endpoints: Object.entries(ROUTES).map(([path, r]) => ({
  method: r.pricingMethod || (r.get ? "GET" : "POST"), path, slug: r.slug, price: `${r.usd.toFixed(3)}`,
  ...(r.quoted && !r.rowSaysNothing ? { quoted: true, fromUsd: r.usd, quoteRange: r.quoted } : {}),
  ...(r.pricedByModel ? { pricedByModel: true } : {}),
  ...(r.identityBound ? { identityBound: true } : {}),
})) };
ROUTES_BY_SLUG = Object.fromEntries(Object.values(ROUTES).map((r) => [r.slug, r]));
const spec = { paths: {} };
for (const [path, r] of Object.entries(ROUTES)) {
  const op = { tags: ["stub"], responses: { 200: { content: r.binary ? { "image/png": {} } : { "application/json": { example: r.output } } } } };
  op["x-payment-info"] = { price: r.quoted ? { mode: "dynamic", currency: "USD", min: String(r.quoted.minUsd), max: String(r.quoted.maxUsd) } : { mode: "fixed", currency: "USD", amount: String(r.usd) } };
  if (r.get) op.parameters = r.get;
  else if (r.input !== undefined) op.requestBody = { content: { "application/json": { example: r.input } } };
  spec.paths[path] = { [r.get ? "get" : "post"]: op };
}
spec.paths["/api/jobs/{id}"] = { get: { tags: ["jobs"], responses: {} } };

// ---- the stub server ---------------------------------------------------------
const seen = [];          // every request: { path, method, query, paid, heartbeat }
let inflight = 0, maxInflight = 0;
const paidAttempts = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const surface = url.pathname === "/api/pricing" || url.pathname === "/openapi.json";
  // The two surface reads are unpaid and deliberately parallel; the in-flight
  // bound under test is the one on tool requests.
  if (!surface) { inflight++; maxInflight = Math.max(maxInflight, inflight); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const done = () => { if (!surface) inflight--; };
  await new Promise((r) => setTimeout(r, 5));
  if (url.pathname === "/api/pricing") { json(200, pricing); return done(); }
  if (url.pathname === "/openapi.json") { json(200, spec); return done(); }
  const route = ROUTES[url.pathname];
  if (!route) { json(404, { error: "no such route" }); return done(); }
  const paid = req.headers["payment-signature"] === "stub-sig";
  const rawBody = chunks.length ? Buffer.concat(chunks).toString() : "";
  seen.push({ path: url.pathname, method: req.method, query: url.searchParams.get("q"), paid, heartbeat: req.headers["x-heartbeat-token"] || null, body: rawBody });
  if (!paid) {
    json(402, { x402Version: 2, accepts: [
      { scheme: "exact", network: "eip155:137", amount: "1", asset: "0xdecoy", payTo: "0xpay" },
      { scheme: "exact", network: "eip155:8453", amount: String(route.quoteMicro ?? micro(route.usd)), asset: "0xusdc", payTo: "0xpay" },
    ] });
    return done();
  }
  const n = (paidAttempts.get(url.pathname) || 0) + 1; paidAttempts.set(url.pathname, n);
  let parsed = null; try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { parsed = null; }
  const [code, body] = route.answer(n, url.searchParams.get("q"), parsed);
  // Every settled 200 gets its own tx, recorded with the slug it paid for.
  const receipt = () => { const tx = "0x" + (++txCounter).toString(16).padStart(64, "0"); settled.set(tx, route.slug); return Buffer.from(JSON.stringify({ success: true, transaction: tx })).toString("base64"); };
  if (Buffer.isBuffer(body)) { res.writeHead(code, { "content-type": "image/png", "payment-response": receipt() }); res.end(body); return done(); }
  if (code === 200) res.setHeader("payment-response", receipt());
  json(code, body); done();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const target = `http://127.0.0.1:${server.address().port}`;

const paidQuotes = [];
const fakePayer = {
  address: "0x1111111111111111111111111111111111111111",
  parseChallenge: (_get, body) => body,
  pay: async (pr) => { paidQuotes.push(Number(pr.accepts[0].amount)); return { "PAYMENT-SIGNATURE": "stub-sig" }; },
};
const quiet = { log() {}, warn() {}, error() {} };
const SECRET = "test-pow-secret";

// ---- catalog and plan (pure) --------------------------------------------------
const catalog = catalogFromSurfaces(pricing, spec);
eq(catalog.length, Object.values(ROUTES).filter((r) => r.usd > 0).length, "every priced operation is in the catalog, the free one and the jobs link are not");
ok(catalog.find((r) => r.slug === "no-example").example === null, "a tool without a usable published example is kept and marked, not dropped");
eq(catalog.find((r) => r.slug === "get-one").example, { kind: "query", query: { q: "x" } }, "a GET example is its query parameters only (header params are not inputs)");
ok(catalog.find((r) => r.slug === "binary").binary === true, "a non-JSON documented response is marked binary");
eq(catalog.filter((r) => tierOf(r) === "weekly").map((r) => r.slug), ["pricey", "pricey-two"], `products above $${DAILY_MAX_USD} are the weekly tier`);
ok(tierOf({ usd: 0.10 }) === "daily" && tierOf({ usd: 0.101 }) === "weekly", "the daily tier includes exactly $0.10 and excludes $0.101");
ok(DEFAULT_CONCURRENCY === 1 && DEFAULT_PACE_MS === 1000, "defaults: one paid call in flight, a second apart");

// Quoted tools: the ceiling comes from the price list's row, else from the spec's dynamic range.
{
  const by = Object.fromEntries(catalog.map((r) => [r.slug, r]));
  ok(by["quoted-ok"].quoted === true && by["quoted-ok"].maxUsd === 0.05 && by["quoted-ok"].usd === 0.001, "a quoted row keeps the list price as the floor and reads the ceiling from quoteRange.maxUsd");
  ok(by["quoted-spec"].quoted === true && by["quoted-spec"].maxUsd === 2, "a row the price list does not mark reads the ceiling from the spec's x-payment-info dynamic max");
  ok(by["by-model"].quoted === false && by["by-model"].maxUsd === 0.001, "a priced-by-model flat tier is held to its list price despite the spec's dynamic range");
  ok(by.healthy.quoted === false && by.healthy.maxUsd === by.healthy.usd, "a fixed-price tool's ceiling is its list price");
  eq(quoteCeilingUsd({ quoted: true, quoteRange: { minUsd: 0.001, maxUsd: 3 } }, {}), 3, "quoteCeilingUsd: the row's quoteRange wins");
  eq(quoteCeilingUsd({ pricedByModel: true }, { "x-payment-info": { price: { mode: "dynamic", min: "0.02", max: "0.5" } } }), null, "quoteCeilingUsd: pricedByModel is not a quote ceiling");
  eq(quoteCeilingUsd(undefined, { "x-payment-info": { price: { mode: "dynamic", min: "0.001", max: "2" } } }), 2, "quoteCeilingUsd: a dynamic spec range without a row is the ceiling");
  eq(quoteCeilingUsd({ price: "$0.005" }, { "x-payment-info": { price: { mode: "fixed", amount: "0.005" } } }), null, "quoteCeilingUsd: a fixed price has no ceiling beyond the list");
  eq(by["nested-run"].path, "/api/nested/run", "the path is the spec's key, never spelled from the slug");
}

// Rotation slice math.
eq(dayOfYear(new Date(Date.UTC(2026, 0, 1))), 1, "day of year starts at 1 on Jan 1");
eq(dayOfYear(new Date(Date.UTC(2026, 11, 31))), 365, "Dec 31 is day 365 in a common year");
eq(sliceIndexFor(new Date(Date.UTC(2026, 0, 7))), 0, "day 7 selects slice 0");
eq(sliceIndexFor(new Date(Date.UTC(2026, 0, 8))), 1, "day 8 selects slice 1");
ok(sliceIndexFor(new Date(Date.UTC(2026, 5, 15, 23, 59))) === sliceIndexFor(new Date(Date.UTC(2026, 5, 15, 0, 1))), "the slice is the same all UTC day");
{
  const prices = [0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 1.1, 1.1, 1.1, 0.15, 0.12, 0.24, 0.15, 0.2, 2, 0.101, 0.55, 3.3];
  const products = prices.map((usd, i) => ({ slug: `p${String(i).padStart(2, "0")}`, usd }));
  const slices = weeklySlices(products);
  eq(slices.length, ROTATION_DAYS, "seven slices");
  const all = slices.flat().map((p) => p.slug).sort();
  eq(all, products.map((p) => p.slug).sort(), "every product lands in exactly one slice");
  const totals = slices.map((s) => s.reduce((a, p) => a + micro(p.usd), 0));
  ok(Math.max(...totals) - Math.min(...totals) <= micro(Math.max(...prices)), `the slices are balanced by price (spread ${(Math.max(...totals) - Math.min(...totals)) / 1e6} within the dearest product)`);
  eq(JSON.stringify(weeklySlices([...products].reverse())), JSON.stringify(slices), "the slicing is deterministic regardless of input order");
}

// The plan.
const JAN7 = new Date(Date.UTC(2026, 0, 7));
{
  const p = planRun(catalog, { tier: "all", now: JAN7, capUsd: 100 });
  eq(p.noExample.map((r) => r.slug), ["no-example"], "the plan names the tool without an example");
  ok(p.buy.length === catalog.length - 1 && p.deferred.length === 0, "with room under the cap everything else is bought");
  const listSum = catalog.filter((r) => r.example).reduce((a, r) => a + micro(r.usd), 0) / 1e6;
  ok(Math.abs(p.plannedUsd - listSum) < 1e-9 && listSum > 5.5, `planned spend is the sum of list prices ($${p.plannedUsd})`);
  const capped = planRun(catalog, { tier: "all", now: JAN7, capUsd: 0.6 });
  eq(capped.deferred.map((r) => r.slug), ["pricey"], "the cap cuts the dearest product and names it");
  ok(capped.buy.some((r) => r.slug === "pricey-two"), "a product that still fits under the cap is kept");
  const only = planRun(catalog, { tier: "all", now: JAN7, only: "HEAL" });
  eq(only.buy.map((r) => r.slug), ["healthy"], "only= filters by slug substring, case-insensitively");
  const list = planRun(catalog, { tier: "all", now: JAN7, only: "healthy, GET-ONE" });
  eq(list.buy.map((r) => r.slug).sort(), ["get-one", "healthy"], "only= with commas names exact slugs, case-insensitively");
  eq(planRun(catalog, { tier: "all", now: JAN7, only: "heal,nope" }).buy.length, 0, "only= list entries never match as substrings");
  const skip = planRun(catalog, { tier: "all", now: JAN7, skip: ["pricey", " broken "] });
  eq(skip.skipped.map((r) => r.slug).sort(), ["broken", "pricey"], "skip= names the excluded slugs");
  const cheap = planRun(catalog, { tier: "cheap", now: JAN7 });
  ok(cheap.buy.every((r) => tierOf(r) === "daily"), "tier cheap buys the daily set only");
  const weekly = planRun(catalog, { tier: "weekly", now: JAN7 });
  ok(weekly.buy.every((r) => tierOf(r) === "weekly") && weekly.buy.length >= 1, "tier weekly buys today's slice only");
  const daily = planRun(catalog, { tier: "daily", now: JAN7 });
  ok(daily.buy.filter((r) => tierOf(r) === "daily").length === cheap.buy.length && daily.buy.length === cheap.buy.length + weekly.buy.length, "tier daily is the cheap set plus today's slice");
  let threw = null; try { planRun(catalog, { tier: "monthly" }); } catch (e) { threw = e; }
  ok(threw?.exitCode === 2, "an unknown tier is a misconfiguration (exit 2)");
}

// Grading (pure), including the production-only empty-array rule.
const row = catalog.find((r) => r.slug === "hollow");
eq(gradeAnswer(row, { status: 200, body: { items: [], count: 0 } }).grade, "empty:items", "an array the example shows populated must not come back empty");
eq(gradeAnswer(row, { status: 200, body: { items: [1], count: 1 } }).grade, "ok", "a populated answer with the documented keys passes");
eq(gradeAnswer(row, { status: 200, body: { count: 1 } }).grade, "missing-keys:items", "a missing documented key is named");
eq(gradeAnswer(row, { status: 200, body: { items: [1], count: 1, error: "x" } }).grade, "error-field", "a 200 carrying an error field fails");
eq(gradeAnswer(row, { status: 402 }).grade, "unsettled", "a 402 after paying is unsettled");
eq(gradeAnswer(row, { status: 500, body: { error: "x" } }).grade, "http-500", "a 5xx is graded by status");
eq(gradeAnswer(row, { threw: "timeout" }).grade, "timeout", "a client timeout is graded timeout");
eq(gradeAnswer(row, { threw: "fetch failed" }).grade, "unreachable", "a transport failure is graded unreachable");
eq(gradeAnswer(row, { threw: "headers-overflow: the response headers exceed the 16 KB a Node client reads" }).grade, "headers-overflow", "a 402 too large for a Node client is graded headers-overflow, not unreachable");
eq(gradeAnswer(row, { status: 200, bytes: 12 }).grade, "non-json", "bytes where JSON is documented fail");
eq(gradeAnswer(catalog.find((r) => r.slug === "binary"), { status: 200, bytes: 12 }).grade, "ok", "bytes where bytes are documented pass");
eq(gradeAnswer(catalog.find((r) => r.slug === "binary"), { status: 200, bytes: 0 }).grade, "empty-body", "an empty binary body fails");
eq(gradeAnswer(catalog.find((r) => r.slug === "memory"), { status: 200, body: { keys: [] } }).grade, "ok", "the payer-keyed memory reads may be empty on production");
eq(gradeAnswer(catalog.find((r) => r.slug === "demand-radar"), { status: 200, body: { radar: [] } }).grade, "empty:radar", "a board-backed tool is NOT excused on production (the CI cold-boot excuse does not apply)");
eq(gradeAnswer(catalog.find((r) => r.slug === "receipts"), { status: 200, body: { total: 0, rows: [] } }).grade, "ok", "the burner's receipts may be empty: the run's own buys book internal and receipts list external rows");
ok(!PROD_EMPTY_ARRAY_OK.has("/api/demand-radar") && !PROD_EMPTY_ARRAY_OK.has("/api/bestsellers") && !PROD_EMPTY_ARRAY_OK.has("/api/x402-trending"), "control: the production excuse list carries none of the board-backed cold-boot excuses");

// ---- a full run against the stub ----------------------------------------------
const run = (opts) => runCatalogBuy({ target, payer: fakePayer, powSecret: SECRET, tier: "all", now: JAN7, capUsd: 100, paceMs: 0, retryBackoffMs: 0, log: quiet, readBalanceUsd: async () => 50, ...opts });
{
  seen.length = 0; paidAttempts.clear(); paidQuotes.length = 0; maxInflight = 0;
  const s = await run();
  const by = Object.fromEntries(s.results.map((r) => [r.slug, r]));
  eq(s.results.length, catalog.length, "every priced tool has a row in the results, bought or not");
  eq(by.healthy.grade, "ok", "healthy: 402 then a documented 200 passes");
  ok(by.healthy.status === 200 && settled.get(by.healthy.tx) === "healthy" && by.healthy.ms >= 0, "healthy: status, receipt tx and ms are recorded");
  eq(by["get-one"].grade, "ok", "a GET tool is bought with its example query");
  ok(seen.some((x) => x.path === "/api/get-one" && x.method === "GET" && x.query === "x" && x.paid), "the example query reached the server on the paid request");
  eq(by.hollow.grade, "empty:items", "hollow 200 fails on the empty array");
  eq(by.broken.grade, "http-500", "a persistent 5xx fails by status");
  eq(by.broken.attempts, 2, "a 5xx is retried exactly once");
  eq(paidAttempts.get("/api/broken"), 2, "the server saw two paid attempts for the broken tool");
  eq(by.flaky.grade, "ok", "a 5xx whose retry answers 200 passes on the second answer");
  eq(by.flaky.attempts, 2, "the retry is recorded");
  eq(by.four.attempts, 1, "a 4xx is not retried");
  eq(by.four.grade, "http-422", "a 4xx on the documented example fails by status");
  eq(by.unsettled.grade, "unsettled", "a 402 after paying is unsettled");
  eq(by["error-field"].grade, "error-field", "a 200 with an error field fails");
  eq(by.missing.grade, "missing-keys:a+b", "missing documented keys are named");
  eq(by.memory.grade, "ok", "a payer-keyed memory read may be empty");
  eq(by["demand-radar"].grade, "empty:radar", "a board-backed tool is graded strictly on production");
  eq(by.binary.grade, "ok", "a binary answer passes on bytes");
  eq(by["no-example"].grade, "no-example", "the tool without an example is reported by name");
  ok(by["no-example"].status === null && !seen.some((x) => x.path === "/api/no-example"), "and is never called");
  eq(by["quote-high"].grade, "quote-over-list", "a fixed-price tool's 402 quoting above list price is a graded failure");
  ok(!seen.some((x) => x.path === "/api/quote-high" && x.paid), "and it is not signed or paid");
  eq(by["quoted-ok"].grade, "ok", "a quoted tool's 402 above its list floor but under its documented ceiling is signed and graded on the answer");
  ok(seen.some((x) => x.path === "/api/quoted-ok" && x.paid) && by["quoted-ok"].quotedUsd === 0.02, "the quote that was paid is recorded");
  eq(by["quoted-high"].grade, "quote-over-ceiling", "a quoted tool's 402 above its documented ceiling is graded quote-over-ceiling");
  ok(!seen.some((x) => x.path === "/api/quoted-high" && x.paid), "and it is not signed or paid");
  eq(by["quoted-spec"].grade, "ok", "a ceiling read from the spec alone admits a quote under it");
  eq(by["by-model"].grade, "quote-over-list", "a priced-by-model flat tier quoting above its list price for its own example is a graded failure, not a quote under a ceiling");
  eq(by["nested-run"].grade, "ok", "a slug whose route is not /api/<slug> is bought at the spec's path");
  ok(seen.some((x) => x.path === "/api/nested/run" && x.paid) && !seen.some((x) => x.path === "/api/nested-run"), "the request went to /api/nested/run and never to a path spelled from the slug");
  eq(by.receipts.grade, "ok", "receipts empty for the burner passes");
  // Own-sale tools: bought after every other tool, naming a sale this run settled.
  const paidSeq = seen.filter((x) => x.paid).map((x) => x.path);
  const firstOwnSale = Math.min(paidSeq.indexOf("/api/attest"), paidSeq.indexOf("/api/feedback"));
  ok(firstOwnSale >= 0 && paidSeq.slice(firstOwnSale).every((p) => p === "/api/attest" || p === "/api/feedback"), "attest and feedback are bought after every other tool");
  eq(by.attest.grade, "ok", "attest passes on a sale this run settled (the published example's old tx would answer 422)");
  eq(by.feedback.grade, "ok", "feedback passes on a sale this run settled");
  const attestBody = JSON.parse(seen.find((x) => x.path === "/api/attest" && x.paid).body);
  ok(attestBody.tx !== OLD_TX && attestBody.tx === by.hash.tx && settled.get(attestBody.tx) === "hash", "attest's input tx is the settlement tx of the hash buy, from its payment-response");
  eq(by.attest.ownSaleOf, "hash", "the graded row names the tool whose sale it attested (the slug, not the tx)");
  ok(JSON.parse(seen.find((x) => x.path === "/api/feedback" && x.paid).body).verdict === "good", "the rest of the published example input is kept");
  ok(by.memory.ownSaleOf === undefined && by.receipts.ownSaleOf === undefined, "identity-bound tools whose input names no tx are bought as published");
  eq(paidQuotes.length, seen.filter((x) => x.paid).length, "every signature the payer produced was sent as a paid request (none for the over-list quote)");
  eq(by.pricey.grade, "ok", "a weekly product passes on its documented keys");
  eq(by.verb.grade, "ok", "a tool whose price-list row names another verb is still bought");
  ok(seen.some((x) => x.path === "/api/verb" && x.method === "POST" && x.paid), "with the spec's verb, which is the one the route answers");
  // The paid answers the run keeps for scripts/catalog-buy-examples.js.
  const cap = Object.fromEntries(s.captures.map((c) => [c.slug, c]));
  ok(cap.healthy?.captured && JSON.stringify(cap.healthy.captured.body) === JSON.stringify({ hex: "cd", rows: [1, 2] }), "a graded paid 200 is captured with its body");
  ok(cap.healthy.documented.source === "hand-written" && cap.healthy.documented.keys.join() === "hex,rows", "the capture records the documented example's shape");
  ok(cap.hollow?.captured && cap.hollow.pass === false && cap.hollow.grade === "empty:items", "a failing 200 is captured too, with its grade, for the enhancement report");
  ok(cap.broken && cap.broken.captured === null && cap.broken.dropped === "no-paid-200", "a non-200 keeps its grade and no body");
  ok(cap.receipts && cap.receipts.captured === null && cap.receipts.dropped === "denylist", "a payer-keyed read is never captured");
  ok(!cap["no-example"] && !cap["quote-high"]?.captured, "an unbought or unpaid tool has no captured body");
  ok(s.captures.every((c) => !("tx" in c) && !JSON.stringify(c).includes(fakePayer.address)), "no capture carries the receipt tx or the payer's address");
  ok(![...settled.keys()].some((tx) => JSON.stringify(s.captures).includes(tx)), "no capture carries any tx this run settled, including the one substituted into attest's input");
  ok(s.results.every((r) => !("body" in r)), "the graded report carries no answer bodies");
  const tools = seen.filter((x) => !["/api/pricing", "/openapi.json"].includes(x.path));
  ok(tools.every((x) => typeof x.heartbeat === "string" && x.heartbeat.length === 32), "every request carries the heartbeat token");
  const minute = Math.floor(Date.now() / 60_000);
  const valid = new Set([-1, 0, 1].map((o) => createHmac("sha256", SECRET).update(`heartbeat:${minute + o}`).digest("base64url").slice(0, 32)));
  ok(tools.every((x) => valid.has(x.heartbeat)), "the heartbeat token is the HMAC of the secret and the UTC minute");
  ok(tools.filter((x) => !x.paid).length >= catalog.length - 1, "every bought tool was first asked unpaid (the live 402 is the authority on the quote)");
  ok(maxInflight <= 1, `by default at most one request in flight (saw ${maxInflight})`);
  // Charged = every 200, whatever its grade: settlement runs on the 200.
  const charged = s.results.filter((r) => r.status === 200).reduce((a, r) => a + micro(r.quotedUsd), 0) / 1e6;
  ok(Math.abs(s.spentUsd - charged) < 1e-9, `the charged total counts every 200 at its quote ($${s.spentUsd})`);
  ok(s.results.filter((r) => r.status !== 200 && r.status !== null).every((r) => r.grade !== "ok"), "no non-200 answer is graded ok");
  eq(exitCodeFor(s), 5, "a run with failing grades exits 5");
  eq(s.exitCode, 5, "the summary carries the exit code");
  eq(resultWordFor(s), "fail", "the result word is fail");
  ok(/^\d+ FAILED$/.test(headlineFor(s)), `the headline counts failures only when nothing was cap-deferred (${headlineFor(s)})`);
  const table = summaryTable(s.results);
  ok(/slug\s+price\s+status\s+grade\s+ms/.test(table) && /hollow\s+\$0\.002\s+200\s+empty:items/.test(table), "the summary table has slug, price, status, grade, ms");
  ok(table.indexOf("hollow") < table.indexOf("healthy"), "failures are listed before passes");
  const md = markdownSummary(s);
  ok(md.includes("| slug | price | status | grade | ms |") && md.includes("| no-example | $0.001 | - | no-example | - |"), "the markdown summary lists unbought tools with a dash for status and ms");
  ok(!md.includes("stub-sig") && !table.includes("stub-sig") && !JSON.stringify(s.results).includes('"body"'), "neither summary nor results carry a payment header or a response body");
}

// Cap at run time, and the plan's cut: cap-deferred is counted apart from failures.
{
  seen.length = 0; paidAttempts.clear();
  const s = await run({ capUsd: 0.6 });
  const by = Object.fromEntries(s.results.map((r) => [r.slug, r]));
  eq(by.pricey.grade, "cap", "the product over the cap is reported as not bought");
  ok(!seen.some((x) => x.path === "/v1/pricey"), "and never requested");
  eq(by["pricey-two"].grade, "ok", "the product under the cap is bought");
  ok(s.spentUsd <= 0.6 + 1e-9, `the charged total never exceeds the cap (${s.spentUsd})`);
  eq(s.exitCode, 5, "real failures still exit 5 when tools were also cap-deferred");
  ok(/^\d+ FAILED, 1 cap-deferred$/.test(headlineFor(s)), `the headline counts failures and cap-deferred apart (${headlineFor(s)})`);
  ok(markdownSummary(s).includes("| failed ") && markdownSummary(s).includes("cap-deferred 1"), "the markdown summary carries both counts");
  const table = summaryTable(s.results);
  ok(table.indexOf("hollow") < table.indexOf("pricey") && table.indexOf("pricey") < table.indexOf("healthy"), "failures are listed first, then the cap-deferred, then the passes");
  // Nothing failed but the cap left a tool unbought: exit 4, result deferred, not a failure.
  seen.length = 0;
  const d = await run({ only: "pricey", capUsd: 0.6 });
  eq(d.results.map((r) => [r.slug, r.grade]), [["pricey", "cap"], ["pricey-two", "ok"]], "only pricey products: one bought, one cap-deferred");
  eq(d.exitCode, 4, "nothing failed and a tool was cap-deferred: exit 4");
  eq(resultWordFor(d), "deferred", "the result word is deferred");
  eq(headlineFor(d), "nothing failed, 1 cap-deferred", "the headline says nothing failed and names the deferred count");
  ok(d.results.filter((r) => r.grade === "cap").every((r) => !r.pass), "a cap-deferred row is not a pass either");
}

// Own-sale tools on a narrowed run: the cheap source is bought first, or the tool is deferred.
{
  const att = catalog.find((r) => r.slug === "attest");
  ok(needsOwnSale(att) && needsOwnSale(catalog.find((r) => r.slug === "feedback")), "attest and feedback need the buyer's own sale (identity-bound, input names a tx)");
  ok(!needsOwnSale(catalog.find((r) => r.slug === "receipts")) && !needsOwnSale(catalog.find((r) => r.slug === "memory")), "identity-bound reads without a tx input do not");
  ok(!needsOwnSale({ ...att, identityBound: false }), "a tx input on a tool that is not identity-bound is bought as published");
  ok(isSaleSource(catalog.find((r) => r.slug === "hash")) && !isSaleSource(catalog.find((r) => r.slug === "binary")) && !isSaleSource(catalog.find((r) => r.slug === "memory")) && !isSaleSource(att), "a sale source is a JSON, non-identity-bound tool");
  ok(!isSaleSource({ ...catalog.find((r) => r.slug === "hash"), example: { kind: "json", body: { stream: true } } }), "a streamed buy is not a sale source (no response digest)");
  eq(withOwnSale({ kind: "query", query: { tx: "a", n: "1" } }, "b"), { kind: "query", query: { tx: "b", n: "1" } }, "withOwnSale replaces a query tx too");
  eq(SALE_SOURCE_SLUG, "hash", "the sale source is the paid canary's choice");

  const p = planRun(catalog, { tier: "all", now: JAN7, only: "attest" });
  eq(p.buy.map((r) => r.slug), ["hash", "attest"], "--only attest adds the cheap source to the plan");
  ok(p.addedSaleSource && p.saleSource === "hash" && Math.abs(p.plannedUsd - 0.011) < 1e-9, "and its list price counts in the planned spend");
  const full = planRun(catalog, { tier: "all", now: JAN7, capUsd: 100 });
  ok(!full.addedSaleSource && full.saleSource === "hash" && full.buy.filter((r) => r.slug === "hash").length === 1, "a plan that already buys a source adds nothing");
  const noHash = planRun(catalog, { tier: "all", now: JAN7, only: "attest", skip: ["hash"] });
  ok(noHash.saleSource && noHash.saleSource !== "hash" && isSaleSource(catalog.find((r) => r.slug === noHash.saleSource)), `a skipped source is never added; the cheapest other source is (${noHash.saleSource})`);
  const tight = planRun(catalog, { tier: "all", now: JAN7, only: "attest", capUsd: 0.01 });
  ok(tight.buy.length === 0 && tight.noOwnSale.map((r) => r.slug).join() === "attest" && tight.plannedUsd === 0, "a cap that cannot fit the source defers attest and plans nothing for it");

  seen.length = 0;
  const s = await run({ only: "attest" });
  eq(s.results.map((r) => [r.slug, r.grade]), [["hash", "ok"], ["attest", "ok"]], "--only attest: the source is bought and graded, then attest passes");
  const paidSeq = seen.filter((x) => x.paid).map((x) => x.path);
  eq(paidSeq, ["/api/hash", "/api/attest"], "the source settles before attest is asked");
  eq(JSON.parse(seen.find((x) => x.path === "/api/attest" && x.paid).body).tx, s.results[0].tx, "attest names the source's settlement tx");
  eq(s.exitCode, 0, "and the run is green");
  ok(Math.abs(s.spentUsd - 0.011) < 1e-9, "charged the source plus attest");

  seen.length = 0;
  const d = await run({ only: "attest", capUsd: 0.01 });
  eq(d.results.map((r) => [r.slug, r.grade]), [["attest", NO_OWN_SALE]], "no source fits the cap: attest is deferred with a reason");
  ok(!seen.some((x) => x.path === "/api/attest" || x.path === "/api/hash"), "and nothing is requested");
  eq(d.exitCode, 4, "a deferral exits 4, never 5");
  eq(resultWordFor(d), "deferred", "the result word is deferred");
  eq(headlineFor(d), "nothing failed, 1 deferred (no own sale)", "the headline names the reason");
  ok(markdownSummary(d).includes("deferred without an own sale 1") && markdownSummary(d).includes("cap-deferred 0"), "the markdown summary counts it apart from the cap");

  seen.length = 0; hashDown = true;
  const down = await run({ only: "attest" });
  hashDown = false;
  const by = Object.fromEntries(down.results.map((r) => [r.slug, r]));
  eq(by.hash.grade, "http-500", "a source that does not settle fails on its own grade");
  eq(by.attest.grade, NO_OWN_SALE, "and attest, with no sale to name, is deferred rather than sent the old example");
  ok(!seen.some((x) => x.path === "/api/attest"), "attest is never asked");
  eq(down.exitCode, 5, "the run fails for the source, not for attest");
}

// The capture blanks a tx this run substituted into the input, though the input names it.
{
  const T = "0x" + "ab".repeat(32);
  const row = { slug: "plain-tool", path: "/api/plain", method: "post", usd: 0.01, op: {}, example: { kind: "json", body: { tx: T } } };
  const graded = { status: 200, grade: "ok", pass: true, ms: 1 };
  const answer = { status: 200, paid: true, body: { echoed: T, note: `sale ${T}` } };
  const control = captureRecord(row, graded, answer, {});
  ok(control.captured?.body.echoed === T, "control: a tx the published input names is kept");
  const ours = captureRecord(row, graded, answer, { ownTxs: [T.toUpperCase().replace("0X", "0x")] });
  ok(ours.captured?.body.echoed === REDACTED && ours.captured.body.note === `sale ${REDACTED}`, "a tx named as ours is blanked even when the input carries it, case-insensitively");
}

// Funding preflight.
{
  seen.length = 0;
  const s = await run({ readBalanceUsd: async () => 0.5 });
  ok(s.unfunded === true && s.exitCode === 3, "a burner below planned spend plus the floor exits 3");
  ok(!seen.some((x) => !["/api/pricing", "/openapi.json"].includes(x.path)), "and buys nothing");
  ok(markdownSummary(s).includes("UNFUNDED"), "the summary says unfunded");
  const planned = (await run({ dry: true })).plan.plannedUsd;
  const exact = await run({ readBalanceUsd: async () => planned + 2 - 0.001 });
  ok(exact.unfunded === true, "the floor is added to the planned spend, not compared alone");
  seen.length = 0;
  const unreadable = await run({ readBalanceUsd: async () => null });
  ok(unreadable.unfunded === false && seen.some((x) => x.path === "/api/healthy"), "an unreadable balance does not block the run (the cap bounds it)");
}

// A narrowed green run exits 0; a dry run buys nothing.
{
  seen.length = 0;
  const s = await run({ only: "healthy" });
  eq(s.results.map((r) => r.slug), ["healthy"], "only= narrows the run");
  eq(s.exitCode, 0, "a run where every graded tool passes exits 0");
  eq(resultWordFor(s), "ok", "the result word is ok");
  eq(headlineFor(s), "all passed", "the headline says all passed");
  ok(Math.abs(s.spentUsd - 0.001) < 1e-9, "and charged the one list price");
  seen.length = 0;
  const d = await run({ dry: true });
  ok(!seen.some((x) => !["/api/pricing", "/openapi.json"].includes(x.path)), "a dry run requests no tool");
  ok(d.dry === true && d.spentUsd === 0 && d.plan.plannedUsd > 5, "a dry run reports the planned spend from list prices");
}

// Misconfiguration: a target without a catalog.
{
  let threw = null;
  try { await runCatalogBuy({ target: `${target}/nowhere`, payer: fakePayer, log: quiet }); } catch (e) { threw = e; }
  ok(threw?.exitCode === 2, "an unreachable price list is a misconfiguration (exit 2)");
}

server.close();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
