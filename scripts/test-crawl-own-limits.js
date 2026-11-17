#!/usr/bin/env node
// A limit of ours never costs a seller its day or its listing
// (src/seller-load.js, src/x402-index.js), driven through the REAL crawl
// (crawlScheduled -> crawlSeller -> the document reads and probes) with stub
// documents and probes:
//   * reads made for registrations (anyone may register any origin, path
//     origins under one domain included) are counted on a day count of their
//     own, so the domain's scheduled crawl keeps its whole day;
//   * a scheduled turn our own limits passed over moves the start of the hold
//     of the last good listing, so a read of ours that then does not complete
//     keeps the seller listed (a seller never drops because we chose not to
//     read it);
//   * a quote probe held back by the probes' share of the day is no answer:
//     nothing is noted against the route, and the document reads go on;
//   * an origin on the slow cycle is read by the clock, not by cycles.
// Offline: no network, no server, stub hosts only.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-own-limits"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "60";
process.env.CRAWL_SLOW_ORIGINS = "https://slowpoke.example,https://slowcycle.example";
process.env.X402_INDEX_SEEDS = "https://slowcycle.example";
// A hold window shorter than the slow cycle, so a hold that counted from the
// last read alone would have ended by the slow origin's next read.
process.env.INDEX_CRAWL_HOLD_HOURS = "5";
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-own-limits-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad, SLOW_READ_INTERVAL_MS } = await import("../src/seller-load.js");
const { hostOf, isHost } = await import("./lib/url-host.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const H = 3_600_000, CYCLE = 30 * 60_000;
let clock = Date.parse("2026-11-18T12:00:00Z");
sellerLoad.setClock(() => clock);
const realNow = Date.now;
Date.now = () => clock;

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const manifest = (o) => ({ x402Version: 2, name: "Seller", resources: [{ resource: `${o}/api/thing`, method: "GET", description: "A thing.", price: "$0.005", accepts }] });
const openapi = (o) => ({ openapi: "3.1.0", info: { title: "Seller" }, servers: [{ url: o }], paths: { "/api/thing": { get: { operationId: "thing", summary: "A thing", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.005" } } } } } });

const docs = new Map();      // url -> { body } | { throw: Error }
const reads = [];
idx.__setCrawlFetchForTest(async (url) => {
  reads.push(url);
  const d = docs.get(url);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  if (d.throw) throw d.throw();
  return { html: d.body, finalUrl: url, validators: {} };
});
const probes = [];
idx.__setProbeFetchForTest(async (url) => {
  probes.push(url);
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } });
});
function serve(o) {
  docs.set(`${o}/.well-known/x402`, { body: JSON.stringify(manifest(o)) });
  docs.set(`${o}/openapi.json`, { body: JSON.stringify(openapi(o)) });
}
const timeout = () => Object.assign(new Error("Source URL did not respond within our 15 s limit"), { statusCode: 504, attribution: "unknown", hint: "source-timeout" });
function dark(o) {
  docs.set(`${o}/.well-known/x402`, { throw: timeout });
  docs.set(`${o}/openapi.json`, { throw: timeout });
}
const readsOf = (o) => reads.filter((u) => isHost(u, hostOf(o))).length;
const probesOf = (o) => probes.filter((u) => isHost(u, hostOf(o))).length;
const turn = async (o) => idx.__crawlScheduledForTest(o);
const entry = (o) => idx._cacheForTests().get(o);

// ---- registrations never spend the domain's day ------------------------------------
{
  const V = "https://victim.example";
  serve(V);
  for (let i = 0; i < 50; i++) await idx.registerOrigin(`${V}/p${i}`).catch(() => null);
  const sent = readsOf(V) + probesOf(V);
  ok(sent >= 50, `control: fifty registrations under the domain were read (${sent} requests)`);
  ok((await sellerLoad.budgetSpent(V)).used === 0, "none of their reads is counted on the domain's day");
  ok((sellerLoad.status().budget.requests["crawler:unscheduled"] || 0) >= 50, "they are counted on a day count of their own");
  const before = readsOf(V);
  ok((await turn(V)) === null && readsOf(V) > before && entry(V)?.tools?.length === 1, "the domain's own scheduled crawl runs and lists it");
  ok((await sellerLoad.budgetSpent(V)).used > 0, "control: the scheduled crawl's own reads are counted on its day");
}

// ---- a turn we passed over moves the start of the hold ------------------------------
{
  clock = Date.parse("2026-11-21T01:00:00Z");
  idx.__setLastCycleOursShareForTest(0);
  const O = "https://passed-over.example", C = "https://read-long-ago.example";
  serve(O); serve(C);
  ok((await turn(O)) === null && (await turn(C)) === null && entry(O)?.tools?.length === 1 && entry(C)?.tools?.length === 1, "both sellers are listed");
  // O's day is spent (its own reads, say): every turn for 22 hours waits.
  for (let i = 0; i < 70; i++) await sellerLoad.takeBudget(`${O}/openapi.json`, "crawler", { essential: true });
  let waited = 0;
  for (let i = 0; i < 44; i++) { clock += CYCLE; if ((await turn(O)) === "budget") waited++; }
  ok(waited === 44, `its turns wait on the spent day for 22 hours (${waited})`);
  // The next UTC day both are read again, and a read of ours does not complete.
  clock = Date.parse("2026-11-22T00:30:00Z");
  dark(O); dark(C);
  ok((await turn(O)) === null && (await turn(C)) === null, "the next day both are read");
  const o = entry(O), c = entry(C);
  ok(o && !o.error && o.readIncomplete && o.tools?.length === 1, "the seller our limits passed over keeps its listing: the hold counts from its last turn we skipped");
  ok(c && c.error, "control: a seller last read and last due 23 hours ago, with no turn skipped, is not held");
}

// ---- a held-back quote probe is no answer --------------------------------------------
{
  clock = Date.parse("2026-11-23T12:00:00Z");
  const Q = "https://quoted.example";
  serve(Q);
  let refused = false;
  for (let i = 0; i < 40 && !refused; i++) refused = !(await sellerLoad.takeBudget(`${Q}/x`, "quote")).ok;
  ok(refused && !(await sellerLoad.budgetSpent(Q)).spent, "the probes' share of the day is spent; the day is not");
  const s0 = idx.quoteProbeStatsSnapshot(), p0 = probesOf(Q), r0 = readsOf(Q);
  ok((await turn(Q)) === null && readsOf(Q) > r0 && entry(Q)?.tools?.length === 1, "the scheduled crawl still reads the documents and lists the seller");
  const s1 = idx.quoteProbeStatsSnapshot();
  ok(probesOf(Q) === p0, "no probe is sent past the probes' share");
  ok(s1.probed === s0.probed && s1.missed === s0.missed && JSON.stringify(s1.attempts) === JSON.stringify(s0.attempts),
    "and a probe held back is noted as nothing: no attempt, no miss");
  clock += 24 * H;
  await turn(Q);
  const s2 = idx.quoteProbeStatsSnapshot();
  ok(probesOf(Q) > p0 && s2.probed > s1.probed, `control: the next day the same crawl probes the route and notes it (${probesOf(Q) - p0} probes)`);
}

// ---- the slow cycle is by the clock ---------------------------------------------------
{
  const S = "https://slowpoke.example";
  serve(S);
  const start = Date.parse("2026-11-25T00:00:00Z");
  const readAt = [];
  for (let m = 0; m < 18 * 60; m += 30) {
    // A boot's extra cycle 30 s after every third hour: six deploys a day.
    for (const at of m % 180 === 0 ? [m, m + 0.5] : [m]) {
      clock = start + at * 60_000;
      const before = readsOf(S);
      const skip = await turn(S);
      if (readsOf(S) > before) readAt.push(clock);
      else if (skip !== "slow" && skip !== "unchanged") ok(false, `a slow origin's turn waits on the slow cycle (${skip})`);
    }
  }
  ok(readAt.length === 3 && readAt.every((t, i) => i === 0 || t - readAt[i - 1] >= SLOW_READ_INTERVAL_MS),
    `read every six hours by the clock across six boots (${readAt.map((t) => new Date(t).toISOString().slice(11, 16)).join(", ")})`);
  ok(sellerLoad.status().crawlsSkipped.slow > 0, "the operator view counts the slow waits");
}

// ---- a slow origin waiting its cycle keeps its listing through our failed read -----
{
  // Whole crawl cycles: the slow origin is left out of each while it waits,
  // and each of those cycles is a turn we put off, so the hold of its last
  // good listing counts from the last of them.
  const SC = "https://slowcycle.example";
  serve(SC);
  idx.__setLastCycleOursShareForTest(0);
  const start = Date.parse("2026-11-27T00:00:00Z");
  clock = start;
  await idx.__runCrawlCycleForTest();
  ok(entry(SC)?.tools?.length === 1, "the slow origin is listed by its first cycle");
  const r0 = readsOf(SC);
  for (let m = 30; m < 6 * 60; m += 30) { clock = start + m * 60_000; idx.__setLastCycleOursShareForTest(0); await idx.__runCrawlCycleForTest(); }
  ok(readsOf(SC) === r0, "it is not read while it waits its slow cycle");
  dark(SC);
  clock = start + 6 * H;
  idx.__setLastCycleOursShareForTest(0);
  await idx.__runCrawlCycleForTest();
  const e = entry(SC);
  ok(readsOf(SC) > r0 && e && !e.error && e.readIncomplete && e.tools?.length === 1,
    "read when its cycle comes, a read of ours that does not complete keeps its listing, six hours after the last read");
}

Date.now = realNow;
console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
