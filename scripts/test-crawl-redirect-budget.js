#!/usr/bin/env node
// A request is counted on the day of the origin whose crawl sent it
// (src/seller-load.js takeBudget `chargeTo`, src/x402-index.js probeOnce),
// driven through the real crawl with stub documents and probes:
//   * an origin whose discovery documents permanently redirect to another
//     listed seller has its price and paywall reads counted on its own day,
//     not on the day of the seller they land on;
//   * however many of those reads it causes, the seller they land on keeps
//     its own day and its own scheduled crawl still runs;
//   * the reads that land on a host through other origins' redirects are
//     bounded per day on a count of their own.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-redirect-budget"));
process.env.X402_INDEX_CRAWL = "off";
const BUDGET = 20;
process.env.SELLER_PROBE_DAILY_BUDGET = String(BUDGET);
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-redirect-budget-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = (amount) => [{ scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const ROUTES = [["/api/one", "0.02", "20000"], ["/api/two", "0.01", "10000"]];
const B = "https://stays.example";   // a listed seller, serving its own documents
const A = "https://moved.example";   // an origin whose documents redirect to B
const DOCS = ["/.well-known/x402", "/openapi.json"];

const docs = new Map();
docs.set(`${B}/.well-known/x402`, JSON.stringify({ x402Version: 2, name: "Seller", resources: ROUTES.map(([p, usd, amt]) => ({ resource: `${B}${p}`, method: "GET", description: `Route ${p}`, price: `$${usd}`, accepts: accepts(amt) })) }));
docs.set(`${B}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "Seller" }, paths: Object.fromEntries(ROUTES.map(([p]) => [p, { get: { operationId: p.slice(5), summary: `Route ${p}` } }])) }));
idx.__setCrawlFetchForTest(async (url) => {
  // A's documents answer with a permanent redirect to B's (the fetch follows it).
  const moved = DOCS.find((p) => url === `${A}${p}`);
  const at = moved ? `${B}${moved}` : url;
  const d = docs.get(at);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: d, finalUrl: at, validators: {} };
});
const probes = [];
idx.__setProbeFetchForTest(async (url, opts) => {
  probes.push(`${String(opts?.method || "GET").toUpperCase()} ${url}`);
  const r = ROUTES.find(([p]) => new URL(url).pathname === p);
  if (!r) return new Response("{}", { status: 404 });
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: accepts(r[2]) })).toString("base64") } });
});
const used = async (o) => (await sellerLoad.budgetSpent(o)).used;
const landedOnB = () => probes.filter((p) => new URL(p.split(" ")[1]).origin === B).length;

// B is listed first, by its own crawl.
await idx.__crawlSellerForTest(B);
const bOwn = await used(B);
ok(bOwn > 0 && bOwn < BUDGET, `the seller's own crawl is counted on its own day (${bOwn} of ${BUDGET})`);
ok(idx.crossHostRedirectAccepted(A, B), "control: a redirect to a listed, self-canonical seller is accepted");

// A's crawl: its documents land on B, and so do its price and paywall reads.
probes.length = 0;
await idx.__crawlSellerForTest(A);
ok(idx._cacheForTests().get(A)?.redirectedTo === B, `the crawl recorded the redirect (${idx._cacheForTests().get(A)?.redirectedTo})`);
const first = landedOnB();
ok(first > 0, `control: the redirecting origin's reads land on the other seller's host (${first})`);
ok((await used(B)) === bOwn, `they are not counted on that seller's day (${await used(B)}, was ${bOwn})`);
ok((await used(A)) >= first, `they are counted on the day of the origin being crawled (${await used(A)})`);

// However often A is read (a registration is never held back), B's own day
// stays its own, B's scheduled crawl still runs, and the reads landing on B
// through the redirect stop at a day's allowance.
for (let i = 0; i < 3 * BUDGET; i++) await idx.__crawlSellerForTest(A, { forcePaywall: true });
ok((await used(B)) === bOwn, `after ${3 * BUDGET} more reads of the redirecting origin the seller's day is unchanged (${await used(B)})`);
ok((await sellerLoad.hold(B)) === null, `the seller is not held (${await sellerLoad.hold(B)})`);
const plan = await sellerLoad.crawlPlan(B);
ok(plan.skip !== "budget", `its scheduled crawl is not skipped for a spent day (${plan.skip})`);
const landed = landedOnB();
ok((await sellerLoad.landedToday(B)) === landed, `the landings are counted apart from its day (${await sellerLoad.landedToday(B)})`);
const docReads = [];
idx.__setCrawlFetchForTest(((prev) => async (url, o) => { docReads.push(url); return prev(url, o); })(async (url) => {
  const d = docs.get(url);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: d, finalUrl: url, validators: {} };
}));
await sellerLoad.resetRevisit(B, "test");
const skip = await idx.__crawlScheduledForTest(B);
ok(skip === null && docReads.some((u) => u.startsWith(`${B}/`)), `and its own scheduled crawl reads its documents (${skip}, ${docReads.length} reads)`);
ok(landed === BUDGET, `the reads that landed on its host through the redirect stopped at a day's allowance (${landed} of ${BUDGET})`);

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
