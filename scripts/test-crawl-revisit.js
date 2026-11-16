#!/usr/bin/env node
// The scheduled crawl spends less of a seller's hosting (src/seller-load.js),
// driven through the REAL crawl (src/x402-index.js crawlScheduled ->
// crawlSeller -> probePath / probePaywall) with stub documents and probes:
//   * an origin whose manifest and OpenAPI come back unchanged (304s) waits
//     longer each time, up to the cap, and its listing stays as it was;
//   * a changed manifest, a failed crawl or a re-registration puts it back on
//     the cycle; a read the seller asked for never starts a back-off;
//   * a 429 with Retry-After holds the crawl and the probes of that host until
//     then, and a skipped turn sends nothing and leaves the entry untouched;
//   * past the host's daily budget the scheduled crawl waits and a scheduled
//     crawl's paywall probe is not sent (the stored verdict stands), while an
//     unscheduled read and the router's probe are counted, never refused;
//   * every crawler read asks for the crawler's User-Agent and every probe the
//     probe's.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-revisit"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "60";
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-revisit-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");
const { upstreamFailure } = await import("../src/tools/fetch-guard.js");
const UA = await import("../src/user-agents.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const H = 3_600_000, CYCLE = 30 * 60_000;
let clock = Date.parse("2026-11-16T00:05:00Z");
sellerLoad.setClock(() => clock);

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const manifest = (o, desc = "A thing.") => ({ x402Version: 2, name: "Seller", resources: [{ resource: `${o}/api/thing`, method: "GET", description: desc, price: "$0.005", accepts }] });
const openapi = (o) => ({ openapi: "3.1.0", info: { title: "Seller" }, servers: [{ url: o }], paths: { "/api/thing": { get: { operationId: "thing", summary: "A thing", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.005" } } } } } });

// Documents per URL, each with an ETag; a request that sends the ETag back gets a 304.
const docs = new Map();      // url -> { body, etag } | { throw: Error }
const reads = [];            // [url, userAgent]
idx.__setCrawlFetchForTest(async (url, opts) => {
  reads.push([url, opts?.userAgent]);
  const d = docs.get(url);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  if (d.throw) throw d.throw;
  if (opts?.allowNotModified && opts?.validators?.etag === d.etag) return { notModified: true, finalUrl: url, validators: { etag: d.etag } };
  return { html: d.body, finalUrl: url, validators: { etag: d.etag } };
});
const probes = [];           // [url, userAgent]
idx.__setProbeFetchForTest(async (url, opts) => {
  probes.push([url, opts?.userAgent]);
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } });
});
let etagN = 0;
function serve(o, m = manifest(o), api = openapi(o)) {
  docs.set(`${o}/.well-known/x402`, { body: JSON.stringify(m), etag: `"m${++etagN}"` });
  docs.set(`${o}/openapi.json`, { body: JSON.stringify(api), etag: `"o${++etagN}"` });
}
const fetchedFrom = (o) => reads.filter(([u]) => u.startsWith(o)).length;
const turn = async (o) => idx.__crawlScheduledForTest(o);

// ---- unchanged documents: the wait doubles to the cap -----------------------------
{
  const O = "https://steady.example";
  serve(O);
  let skip = await turn(O);
  ok(skip === null && fetchedFrom(O) >= 2, `the first turn reads the documents (${fetchedFrom(O)} reads)`);
  ok(reads.filter(([u]) => u.startsWith(O)).every(([, ua]) => ua === UA.CRAWLER_UA), "every crawler read asks for the crawler's User-Agent");
  const entry0 = idx._cacheForTests().get(O);
  ok(entry0 && !entry0.error && entry0.tools?.length === 1, "the seller is listed");
  // A day of 30-minute cycles.
  const readAt = [];
  for (let i = 1; i <= 48; i++) {
    clock += CYCLE;
    const before = fetchedFrom(O);
    const before0 = idx._cacheForTests().get(O);
    skip = await turn(O);
    if (skip === null) readAt.push(i);
    else {
      ok(skip === "unchanged" && fetchedFrom(O) === before && idx._cacheForTests().get(O) === before0, `cycle ${i}: a backed-off origin is not read and its entry is not touched`);
    }
  }
  const gaps = readAt.map((c, i) => (c - (i ? readAt[i - 1] : 0)) / 2);
  ok(gaps.slice(0, 5).join(",") === "0.5,1,2,4,8" && gaps.slice(5).every((g) => g === 12), `reads come further apart, doubling to 12 h: gaps ${gaps.join(",")} h`);
  ok(readAt.length <= 8, `${readAt.length} reads in a day instead of 48`);
  const entry = idx._cacheForTests().get(O);
  ok(entry && !entry.error && entry.tools?.length === 1 && entry.history?.every((h) => h === 1), "the listing stays healthy through the back-off");
  // A change, found on the next read, puts it back on the cycle.
  docs.set(`${O}/.well-known/x402`, { body: JSON.stringify(manifest(O, "A better thing.")), etag: `"m${++etagN}"` });
  while ((await turn(O)) !== null) clock += CYCLE;
  clock += CYCLE;
  ok((await turn(O)) === null, "after a changed manifest the very next cycle reads the origin again");
  clock += CYCLE;
  ok((await turn(O)) === "unchanged", "and an unchanged read after it starts the back-off over at one hour");
  // A re-registration resets it.
  await idx.registerOrigin(O).catch(() => null);
  clock += CYCLE;
  ok((await turn(O)) === null, "a re-registration puts the origin back on the cycle");
  // A read the seller asked for never starts a back-off.
  await idx.__crawlSellerForTest(O);
  clock += CYCLE;
  ok((await turn(O)) === null, "an unscheduled read (registration) does not lengthen the wait");
  // A re-registration inside the re-read cooldown reads nothing, and still
  // puts the origin back on the cycle.
  for (let i = 0; i < 4; i++) await sellerLoad.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined });
  clock += CYCLE;
  ok((await turn(O)) === "unchanged", "backed off for hours");
  const n = fetchedFrom(O);
  await idx.registerOrigin(O).catch(() => null);
  ok(fetchedFrom(O) === n, "a second registration inside the cooldown re-reads nothing");
  ok((await turn(O)) === null, "and the origin is read on the next cycle all the same");
}

// ---- a failed crawl resets -------------------------------------------------------
{
  const O = "https://flaky.example";
  serve(O);
  await turn(O);
  // Five unchanged reads: a 12 hour wait.
  for (let i = 0; i < 5; i++) await sellerLoad.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined });
  clock += CYCLE;
  ok((await turn(O)) === "unchanged", "backed off for 12 hours");
  const good = docs.get(`${O}/.well-known/x402`);
  docs.delete(`${O}/.well-known/x402`);
  clock += 12 * H;
  ok((await turn(O)) === null, "read again when the wait ends");
  const e = idx._cacheForTests().get(O);
  ok(e && e.tools?.length >= 1, "a missing manifest keeps the listing from the other documents");
  // The same manifest comes back: the back-off starts over from one hour,
  // not from the 12 hours it had reached before the failure.
  docs.set(`${O}/.well-known/x402`, good);
  clock += CYCLE;
  ok((await turn(O)) === null, "a manifest that stopped answering puts the origin back on the cycle");
  clock += H;
  ok((await turn(O)) === null, "and once it is back the wait starts over at one hour");
}

// ---- our own failed read after a long wait keeps the listing --------------------
{
  // An origin read 10 hours ago, on a 12 hour wait of our choosing: a read of
  // ours that then does not complete holds the last good entry, as it would
  // for an origin read half an hour ago (INDEX_CRAWL_HOLD_HOURS counts from
  // the end of the wait).
  const O = "https://patient.example";
  serve(O);
  await turn(O);
  for (let i = 0; i < 6; i++) await sellerLoad.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined });
  const e = idx._cacheForTests().get(O);
  idx._cacheForTests().set(O, { ...e, fetchedAt: Date.now() - 10 * H });
  clock += 13 * H;
  const timeout = () => Object.assign(new Error("Source URL did not respond within our 15 s limit"), { statusCode: 504, attribution: "unknown", hint: "source-timeout" });
  docs.set(`${O}/.well-known/x402`, { throw: timeout() });
  docs.set(`${O}/openapi.json`, { throw: timeout() });
  ok((await turn(O)) === null, "the origin is read when its 12 hour wait ends");
  const after = idx._cacheForTests().get(O);
  ok(after && !after.error && after.readIncomplete && after.tools?.length === 1, "a read of ours that did not complete keeps the listing, though the entry is 10 hours old");
}

// ---- Retry-After ---------------------------------------------------------------
{
  const O = "https://busy.example";
  serve(O);
  await turn(O);
  docs.set(`${O}/.well-known/x402`, { throw: upstreamFailure(429, { retryAfter: 3600, host: "busy.example" }) });
  clock += CYCLE;
  await turn(O);
  docs.set(`${O}/.well-known/x402`, { body: JSON.stringify(manifest(O)), etag: `"m${++etagN}"` });
  const held = idx._cacheForTests().get(O);
  const n = fetchedFrom(O), p = probes.length;
  clock += CYCLE;
  ok((await turn(O)) === "throttled" && fetchedFrom(O) === n && probes.length === p, "a 429 with Retry-After: 3600 holds the crawl: nothing is sent");
  ok(idx._cacheForTests().get(O) === held, "and the entry is left exactly as it was");
  clock += CYCLE + 60_000;
  ok((await turn(O)) === null && fetchedFrom(O) > n, "once the Retry-After has passed the origin is read again");
  const st = sellerLoad.status();
  ok(st.throttle.noted >= 1 && st.throttle.withRetryAfter >= 1 && st.crawlsSkipped.throttled >= 1, "the operator view counts the hold and the skipped turn");
}

// ---- the daily budget -------------------------------------------------------------
{
  const O = "https://budget.example";
  // Mid-day, so the day's budget does not roll over inside this block.
  clock = Date.parse("2026-11-20T12:00:00Z");
  serve(O);
  await idx.__crawlSellerForTest(O, { forcePaywall: true });
  const verdict = idx._cacheForTests().get(O)?.paywall;
  ok(verdict?.ok === true && probes.at(-1)?.[1] === undefined, "an unscheduled crawl probes the paywall (the probe seam is called with no User-Agent: probePublicUrl sends the probe's)");
  // Spend the rest of the host's day.
  let refused = false;
  for (let i = 0; i < 80 && !refused; i++) refused = !(await sellerLoad.takeBudget(`${O}/x`, "quote")).ok;
  ok(refused, "the host's day is spent");
  clock += CYCLE;
  const n = fetchedFrom(O);
  ok((await turn(O)) === "budget" && fetchedFrom(O) === n, "a scheduled crawl of a spent host waits and sends nothing");
  const p = probes.length;
  await idx.__crawlSellerForTest(O, { scheduled: true, forcePaywall: true });
  ok(probes.length === p, "a scheduled crawl's paywall probe is not sent past the budget");
  ok(idx._cacheForTests().get(O)?.paywall?.ok === true, "and the stored verdict stands");
  ok((await sellerLoad.takeBudget(`${O}/api/thing`, "router-probe", { essential: true })).ok, "the router's probe for a paying caller is still allowed");
  await idx.__crawlSellerForTest(O, { forcePaywall: true });
  ok(probes.length === p + 1, "and so is a read the seller asked for (counted, never refused)");
}

// ---- the router and the probes name themselves -------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const probeAt = server.slice(server.indexOf("const probeAt = async (u, timeoutMs = 6000) =>"), server.indexOf("let probe = await probeAt(r.url);"));
  ok(/takeBudget\(u, "router-probe", \{ essential: true \}\)/.test(probeAt) && /userAgent: ROUTER_UA/.test(probeAt) && /"X-Agent402-Via": "router"/.test(probeAt),
    "the router's pre-payment probe is counted as essential, sends the router's User-Agent and says it is the router");
  ok(!/probeRefusal|throttledUntil|crawlPlan/.test(probeAt), "and nothing in it can hold a paying caller's purchase back");
}

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
