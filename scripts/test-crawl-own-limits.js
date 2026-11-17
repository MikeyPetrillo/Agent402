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
process.env.CRAWL_SLOW_ORIGINS = "https://slowpoke.example,https://slowcycle.example,https://slowfine.example";
process.env.X402_INDEX_SEEDS = "https://slowcycle.example,https://slowfine.example";
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
// The address each stub host resolves to, handed to the read's onResolved as
// the SSRF check hands it (src/tools/fetch-guard.js): two names on one address.
const ADDRESS = new Map([["alpha.sslip.io", "203.0.113.7"], ["beta.sslip.io", "203.0.113.7"], ["gamma.sslip.io", "203.0.113.8"]]);
const resolved = async (url, opts) => {
  if (typeof opts?.onResolved === "function") await opts.onResolved([{ address: ADDRESS.get(new URL(url).hostname) || "203.0.113.7", family: 4 }], url);
};
idx.__setCrawlFetchForTest(async (url, opts) => {
  await resolved(url, opts);
  reads.push(url);
  const d = docs.get(url);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  if (d.throw) throw d.throw();
  return { html: d.body, finalUrl: url, validators: {} };
});
const probes = [];
idx.__setProbeFetchForTest(async (url, opts) => {
  await resolved(url, opts);
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
  // An hour apart, inside the host's hourly ceiling of registration reads.
  for (let i = 0; i < 50; i++) { await idx.registerOrigin(`${V}/p${i}`).catch(() => null); clock += H; }
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
  serve(SC); serve("https://slowfine.example");
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

  // It stays dark. The turns it waits after a failed read are no longer turns
  // we chose to skip a working seller on: the hold runs from where the first
  // failed read put it, so the listing ends after the hold, not never.
  const SF = "https://slowfine.example";
  let droppedAt = 0, fineKept = true;
  for (let m = 6 * 60 + 30; m <= 72 * 60; m += 30) {
    clock = start + m * 60_000;
    idx.__setLastCycleOursShareForTest(0);
    await idx.__runCrawlCycleForTest();
    if (!droppedAt && entry(SC)?.error) droppedAt = clock;
    const f = entry(SF);
    if (!f || f.error || f.readIncomplete || f.tools?.length !== 1) fineKept = false;
  }
  ok(droppedAt > 0 && droppedAt - start <= 6 * H + 2 * 6 * H,
    `a slow origin that stays dark drops after the hold (${droppedAt ? ((droppedAt - start) / H).toFixed(1) + " h" : "never"} after its last good read)`);
  ok(fineKept, "a working slow origin waiting the same turns keeps its listing for three days");
}

// ---- a host's hourly ceiling of registration reads ---------------------------------
{
  // Three hundred registrations of path origins on one host, in one hour:
  // the host is sent at most the hour's ceiling, and each registration past
  // it is answered with when to retry, nothing listed or changed.
  clock = Date.parse("2026-12-02T10:00:00Z");
  const V2 = "https://victim2.example";
  serve(V2);
  const sent0 = readsOf(V2) + probesOf(V2);
  const answers = [];
  for (let i = 0; i < 300; i++) answers.push(await idx.registerOrigin(`${V2}/q${i}`).catch((e) => ({ thrown: String(e?.message || e) })));
  const sent = readsOf(V2) + probesOf(V2) - sent0;
  const max = sellerLoad.status().budget.registrationReadsPerOperatorPerHour;
  const held = answers.filter((r) => r?.held);
  ok(max === 20 && sent > 0 && sent <= max, `the host is sent at most the hour's ceiling of registration reads (${sent} of ${max})`);
  ok(held.length >= 280 && held.every((r) => r.listed === false && r.retryAfterSeconds > 0 && r.retryAfterSeconds <= 3600 && /register again/.test(r.error)),
    `every registration past it is told when to retry (${held.length} held)`);
  ok(!answers.some((r) => r?.thrown), "and none of them throws");
  clock += H;
  const before = readsOf(V2);
  const later = await idx.registerOrigin(V2);
  ok(later?.listed === true && readsOf(V2) > before, "the next hour a registration on the host is read and listed");
}

// ---- names that resolve to one address share its day -------------------------------
{
  // Names under a suffix whose owners point them anywhere (sslip.io): each is
  // its own operator, so each has its own day, but the requests to one
  // address are counted together, from the address the SSRF check read.
  const A = "https://alpha.sslip.io", B = "https://beta.sslip.io", C = "https://gamma.sslip.io";
  for (const o of [A, B, C]) serve(o);
  const sentTo = (o) => readsOf(o) + probesOf(o);
  const s0 = { A: sentTo(A), B: sentTo(B), C: sentTo(C) };
  const start = Date.parse("2026-12-05T00:00:00Z");
  const answers = [];
  for (let h = 0; h < 12; h++) {
    clock = start + h * H;
    for (let i = 0; i < 6; i++) {
      answers.push(await idx.registerOrigin(`${A}/h${h}p${i}`));
      answers.push(await idx.registerOrigin(`${B}/h${h}p${i}`));
    }
  }
  const a = sentTo(A) - s0.A, b = sentTo(B) - s0.B;
  ok(a > 0 && b > 0 && a + b <= 60, `two names on one address share its day: ${a} + ${b} requests of 60`);
  const held = answers.filter((r) => r?.held && /address this host resolves to/.test(r.error));
  ok(held.length > 0 && held.every((r) => r.retryAfterSeconds > 0 && r.retryAfterSeconds <= 86_400), `a registration past it is told when to retry (${held.length} held by the address)`);
  // A scheduled crawl meets the same day: the name's turn waits, nothing sent.
  const b0 = sentTo(B);
  const r = await turn(B);
  ok(sentTo(B) === b0 && r === "budget", `a scheduled turn past the address's day sends nothing (${r})`);
  const c0 = sentTo(C);
  const other = await idx.registerOrigin(`${C}/x`);
  ok(sentTo(C) > c0 && !other?.held, "a name on another address keeps its own day");
  clock = start + 24 * H;
  const a0 = sentTo(A);
  await idx.registerOrigin(`${A}/nextday`);
  ok(sentTo(A) > a0, "the next UTC day the address is read again");
}

Date.now = realNow;
console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
