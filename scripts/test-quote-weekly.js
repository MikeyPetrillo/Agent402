#!/usr/bin/env node
// The crawl's live price reads (enrichLiveQuotes in src/x402-index.js) keep
// their weekly clock across crawls, driven through the real crawl with stub
// documents and probes:
//   * a seller whose manifest prices routes its OpenAPI lists without a price
//     is read once; the next crawls inside the week send no price read, and
//     the read comes due again once the week has passed;
//   * a learned quote carried onto a row a registry snapshot priced at the same
//     amount keeps its age (and is not due), a different amount stays due;
//   * a route priced above every router tier is read at most once a week
//     whatever else makes it due, and a re-registration still reads it;
//   * the paywall probe asks the seller's cheapest paid route.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("quote-weekly"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "quote-weekly-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");
const { EXEC_TIERS } = await import("../src/tools/route-execute.js");
const { isHost, urlMatches } = await import("./lib/url-host.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const DAY = 86_400_000;
const TOP_CAP = Math.max(...EXEC_TIERS.map((t) => t.underlyingMaxUsd));

const PAY = "0x000000000000000000000000000000000000dEaD";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const accepts = (amount) => [
  { scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
  { scheme: "exact", network: SOL, amount, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", maxTimeoutSeconds: 60, extra: { feePayer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } },
];
// [route, USD, atomic amount]: a cheap route, a mid one, one above every router tier.
const ROUTES = [["/api/cheap", "0.01", "10000"], ["/api/mid", "0.5", "500000"], ["/api/report", "3000", "3000000000"]];
ok(Number(ROUTES[2][1]) > TOP_CAP && Number(ROUTES[1][1]) <= TOP_CAP, `the report route is above the top router tier ($${TOP_CAP}) and the mid route is not`);

const docs = new Map();
idx.__setCrawlFetchForTest(async (url) => {
  const d = docs.get(url);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: d, finalUrl: url, validators: {} };
});
const probes = [];
idx.__setProbeFetchForTest(async (url, opts) => {
  probes.push(`${String(opts?.method || "GET").toUpperCase()} ${url}`);
  const r = ROUTES.find(([p]) => new URL(url).pathname === p);
  if (!r) return new Response("{}", { status: 404 });
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: accepts(r[2]) })).toString("base64") } });
});
const asked = (host, path) => probes.some((p) => urlMatches(p.split(" ")[1], host, path));
const quoteReads = () => Number(sellerLoad.status().budget.requests.quote || 0);
// The OpenAPI lists every route with no price; the manifest prices each with
// one entry per path (the shape that met the OpenAPI rows in the merge).
function serve(O) {
  docs.set(`${O}/.well-known/x402`, JSON.stringify({ x402Version: 2, name: "Seller", resources: ROUTES.map(([p, usd, amt]) => ({ resource: `${O}${p}`, method: "GET", description: `Route ${p}`, price: `$${usd}`, accepts: accepts(amt) })) }));
  docs.set(`${O}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "Seller" }, servers: [{ url: O }], paths: Object.fromEntries(ROUTES.map(([p]) => [p, { get: { operationId: p.slice(5), summary: `Route ${p}` } }])) }));
}
const rowsOf = (O) => idx._cacheForTests().get(O)?.tools || [];

// ---- the weekly clock survives the rebuild --------------------------------------
{
  const O = "https://weekly.example";
  serve(O);
  let before = quoteReads();
  await idx.__crawlSellerForTest(O);
  ok(quoteReads() - before === ROUTES.length, `the first crawl reads each paid route's 402 once (${quoteReads() - before})`);
  ok(rowsOf(O).every((t) => Number(t.originDeclaredPrice) > 0), `every row keeps the manifest's price as the origin's declaration (${JSON.stringify(rowsOf(O).map((t) => t.originDeclaredPrice))})`);
  for (let crawl = 2; crawl <= 4; crawl++) {
    before = quoteReads();
    await idx.__crawlSellerForTest(O);
    ok(quoteReads() - before === 0, `crawl ${crawl} inside the week sends no price read (${quoteReads() - before})`);
  }
  ok(rowsOf(O).length === ROUTES.length && rowsOf(O).every((t) => t.networks?.length === 2 && Number(t.networksVerifiedAt) > 0), "the rows keep both chains and their verification stamp");
  // A week on: every stamp eight days old.
  for (const t of rowsOf(O)) for (const k of ["networksVerifiedAt", "quoteObservedAt", "liveProvenAt"]) if (Number(t[k]) > 0) t[k] -= 8 * DAY;
  before = quoteReads();
  await idx.__crawlSellerForTest(O);
  ok(quoteReads() - before === ROUTES.length, `a week on, each route is read again (${quoteReads() - before})`);
  before = quoteReads();
  await idx.__crawlSellerForTest(O);
  ok(quoteReads() - before === 0, "and the crawl after that sends none");
}

// ---- the merge keeps the manifest's declaration ----------------------------------
{
  const [row] = idx.mergeManifestIntoTools([{ route: "/x", method: "GET", price: "$0.5", originDeclaredPrice: 0.5 }], [{ route: "/x", method: "GET", name: "x" }]);
  ok(row.price === "$0.5" && row.originDeclaredPrice === 0.5, "a manifest price filled onto an OpenAPI row is stamped the origin's declaration");
  const [kept] = idx.mergeManifestIntoTools([{ route: "/x", method: "GET", price: "$0.5", originDeclaredPrice: 0.5 }], [{ route: "/x", method: "GET", price: 0.2 }]);
  ok(kept.price === 0.2 && kept.originDeclaredPrice === undefined, "a row already priced at another amount is not stamped with the manifest's");
}

// ---- carry-forward keeps a confirmed quote's age ----------------------------------
{
  const at = Date.now() - 2 * DAY;
  const prev = { tools: [{ route: "/s", method: "GET", price: 0.02, quoteSource: "live-402", quoteObservedAt: at, networks: ["eip155:8453"], networksVerifiedAt: at, networksVerifiedMethod: "GET" }] };
  const [same] = idx.carryForwardLearnedQuotes([{ route: "/s", method: "GET", price: 0.02, networks: ["eip155:8453"] }], prev);
  ok(same.quoteSource === "live-402" && same.quoteObservedAt === at && idx.quoteIsStale(same) === false, "a snapshot price the live quote confirmed carries the quote's age and is not due");
  const [other] = idx.carryForwardLearnedQuotes([{ route: "/s", method: "GET", price: 0.05, networks: ["eip155:8453"] }], prev);
  ok(other.price === 0.05 && idx.quoteIsStale(other) === true, "a snapshot price the quote did not confirm keeps its amount and stays due");
}

// ---- above every router tier: weekly at most --------------------------------------
{
  const O = "https://dear.example";
  const hourAgo = Date.now() - 3_600_000;
  // Rows due for a reason other than the clock: a stamp written by another verb.
  const row = (p, usd, at) => ({ seller: O, route: p, method: "GET", price: `$${usd}`, originDeclaredPrice: Number(usd), networks: ["eip155:8453"], networksVerifiedAt: at, networksVerifiedMethod: "POST", declared: true });
  ok(idx.networksNeedLiveVerify(row("/api/report", "3000", hourAgo)) === true, "control: a row stamped by another verb is due its own read");
  probes.length = 0;
  await idx.enrichLiveQuotes([row("/api/mid", "0.5", hourAgo), row("/api/report", "3000", hourAgo)], O);
  ok(asked("dear.example", "/api/mid") && !asked("dear.example", "/api/report"), `read an hour ago: the routable route is asked, the one above every tier is not (${probes.join(", ")})`);
  probes.length = 0;
  await idx.enrichLiveQuotes([row("/api/report", "3000", Date.now() - 8 * DAY)], O);
  ok(asked("dear.example", "/api/report"), "read eight days ago: it is asked");
  probes.length = 0;
  await idx.enrichLiveQuotes([row("/api/report", "3000", hourAgo)], O, { ignoreBudget: true });
  ok(asked("dear.example", "/api/report"), "a re-registration asks it whatever its clock");
  ok(idx.readThisWeekAboveRouterCaps({ price: `$${TOP_CAP}`, networksVerifiedAt: hourAgo }) === false, "a route at the top tier's cap is routable and not held to the weekly read");
}

// ---- the paywall probe asks the cheapest paid route --------------------------------
{
  const O = "https://paywall.example";
  serve(O);
  await idx.__crawlSellerForTest(O);
  probes.length = 0;
  await idx.__crawlSellerForTest(O, { forcePaywall: true });
  ok(probes.length === 1 && probes[0] === `GET ${O}/api/cheap`, `the paywall probe asks the cheapest paid route (${probes.join(", ")})`);
  ok(probes.every((p) => isHost(p.split(" ")[1], "paywall.example")), "and only the seller's host");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
