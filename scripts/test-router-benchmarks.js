#!/usr/bin/env node
// Router benchmarks (src/router-benchmarks.js, GET /api/router-benchmarks).
//
// Part 1 (in process) computes the document from crafted reputation records:
// the two cohorts, the medians and quartiles, the pooled delivery share, the
// comparison, and the rules that keep it an aggregate (no seller named, a
// statistic only past five scored sellers, no count of purchases anywhere).
// Part 2 boots a FREE_MODE server on port 0 whose reputation files are seeded
// and reads the route, its cache header, /openapi.json and /llms-full.txt; a
// second boot with nothing measured answers not-enough-data everywhere.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { computeRouterBenchmarks, distribution, quantile, MIN_COHORT_SELLERS, COHORT_METRICS, ROUTER_BENCHMARKS_PATH, ROUTER_BENCHMARKS_LEGEND } from "../src/router-benchmarks.js";
import { WINDOW_DAYS, DELIVERY_LABEL } from "../src/seller-reputation.js";

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++; };

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 19, 12), today = Math.floor(NOW / DAY);
// A per-day series [day, ok, n, ...]: `n` samples ending today, the first `okN` of them ok.
const series = (okN, n, endDay = today) => { const s = []; for (let i = n - 1; i >= 0; i--) s.push(endDay - i, i < okN ? 1 : 0, 1); return s; };
// A seller record scored on every crawl metric: uptime share u (of 20 crawls, 10 probes), answer time ms, price matches m of 10.
const rec = (u, ms, m) => ({ f: NOW - 40 * DAY, lc: NOW, lp: NOW, c: series(Math.round(20 * u), 20), p: series(Math.round(10 * u), 10), l: [today, ms, today, ms, today, ms, today, ms, today, ms], q: [10, m, NOW] });
const origin = (kind, i) => `https://${kind}-seller-${i}.example`;

// ---- Part 1: the computation ---------------------------------------------------
{
  // Six routed sellers (high scores, deliveries recorded), six not routed (lower scores).
  const sellers = {}, delivery = {};
  const routedUp = [1, 1, 0.9, 0.9, 0.8, 0.8], otherUp = [0.5, 0.5, 0.4, 0.4, 0.3, 0.3];
  routedUp.forEach((u, i) => { sellers[origin("routed", i)] = rec(u, 300 + i * 10, 10); });
  otherUp.forEach((u, i) => { sellers[origin("other", i)] = rec(u, 3000 + i * 10, 5); });
  // Deliveries: five sellers with 10 purchases each, 9 ok; one with 3 purchases, all ok (under the per-seller minimum).
  for (let i = 0; i < 5; i++) delivery[origin("routed", i)] = { d: series(9, 10), r: {} };
  delivery[origin("routed", 5)] = { d: series(3, 3), r: {} };
  const snap = { state: "ready", sellers, delivery, ourSideDays: [], updatedAt: NOW - 60_000 };
  const doc = await computeRouterBenchmarks(snap, { now: NOW });
  const text = JSON.stringify(doc);

  eq(doc.benchmark, "router-outcomes", "the document names itself");
  eq(doc.recordState, "ready", "the record state is the snapshot's");
  eq(doc.windowDays, WINDOW_DAYS, "the window is the reputation window");
  eq(doc.minCohortSellers, MIN_COHORT_SELLERS, "the minimum cohort is published");
  eq(doc.delivery.label, DELIVERY_LABEL, "the delivery label is the reputation record's");
  // Cohorts: six scored sellers each; medians by nearest rank at or below.
  for (const m of ["manifestUptime", "paywallUptime"]) {
    eq(doc.cohorts.routed.metrics[m], { status: "measured", sellersScored: 6, median: 0.9, p25: 0.8, p75: 0.9, minSellers: 5 }, `routed ${m}`);
    eq(doc.cohorts.notRouted.metrics[m], { status: "measured", sellersScored: 6, median: 0.4, p25: 0.3, p75: 0.4, minSellers: 5 }, `notRouted ${m}`);
    eq(doc.comparison[m], { status: "measured", routedMedian: 0.9, notRoutedMedian: 0.4, difference: 0.5 }, `comparison ${m}`);
  }
  eq(doc.cohorts.routed.metrics.responsiveness.median, 1, "routed sellers answered inside the threshold");
  eq(doc.cohorts.notRouted.metrics.responsiveness.median, 0, "the others did not");
  eq(doc.cohorts.routed.metrics.responsiveness.medianOfMedianMs, 320, "the median of the sellers' median answer times");
  eq(doc.cohorts.routed.metrics.priceMatchesListing.median, 1, "routed price match");
  eq(doc.cohorts.notRouted.metrics.priceMatchesListing.median, 0.5, "other price match");
  eq(Object.keys(doc.comparison), [...COHORT_METRICS], "every cohort metric is compared");
  // Delivery: pooled over 6 sellers = (5*9 + 3) / (5*10 + 3); per seller, five are past the minimum sample.
  eq(doc.delivery.pooledShare, { status: "measured", share: Math.round((48 / 53) * 1000) / 1000, minSellers: 5 }, "the pooled delivery share");
  eq(doc.delivery.perSeller.sellersScored, 5, "five sellers are scored on delivery");
  eq(doc.delivery.perSeller.median, 0.9, "their median delivery score");

  // An aggregate: no seller is named, no purchase is counted.
  ok(!/seller-\d|\.example/.test(text), "no seller origin is in the document");
  ok(!text.includes("53") && !text.includes("48"), "the pooled sample (53 purchases, 48 ok) is printed nowhere");
  const keys = new Set(); JSON.stringify(doc, (k, v) => { keys.add(k); return v; });
  const counted = [...keys].filter((k) => /count|sample|purchase|payment|settle|buyers|^n$|total/i.test(k) && !["minSamplePerSeller"].includes(k));
  eq(counted, [], "no field is a count of samples, purchases, payments, buyers or settlements");
  ok(!/\b(honest|dishonest|unreliable|reliable|trustworthy|scam|fraud|good|bad|best|worst)\b/i.test(text), "no judgment word");
  ok(ROUTER_BENCHMARKS_LEGEND.includes("not a cause"), "the legend says a difference is not a cause");
}
{
  // Under five scored sellers a statistic is withheld, with no count.
  const sellers = {}, delivery = {};
  for (let i = 0; i < 4; i++) { sellers[origin("routed", i)] = rec(1, 100, 10); delivery[origin("routed", i)] = { d: series(10, 10), r: {} }; }
  for (let i = 0; i < 9; i++) sellers[origin("other", i)] = rec(0.5, 100, 10);
  const doc = await computeRouterBenchmarks({ state: "ready", sellers, delivery, ourSideDays: [] }, { now: NOW });
  eq(doc.cohorts.routed.metrics.manifestUptime, { status: "not-enough-data", sellersScored: null, median: null, p25: null, p75: null, minSellers: 5 }, "four routed sellers: withheld, the count too");
  eq(doc.cohorts.notRouted.metrics.manifestUptime.status, "measured", "nine others: measured");
  eq(doc.comparison.manifestUptime, { status: "not-enough-data", routedMedian: null, notRoutedMedian: null, difference: null }, "a comparison needs both cohorts");
  eq(doc.delivery.pooledShare, { status: "not-enough-data", share: null, minSellers: 5 }, "four sellers' purchases are not pooled into a share");
  eq(doc.delivery.perSeller.status, "not-enough-data", "nor a per-seller distribution");
  ok(!JSON.stringify(doc).includes('"sellersScored":4'), "a count under the minimum is never printed");
}
{
  // A delivery older than the window does not make a seller routed; a seller with only deliveries still counts.
  const sellers = {}, delivery = {};
  for (let i = 0; i < 6; i++) { sellers[origin("old", i)] = rec(0.5, 100, 10); delivery[origin("old", i)] = { d: series(10, 10, today - WINDOW_DAYS - 5), r: {} }; }
  for (let i = 0; i < 5; i++) delivery[origin("only", i)] = { d: series(10, 10), r: {} };
  const doc = await computeRouterBenchmarks({ state: "ready", sellers, delivery, ourSideDays: [] }, { now: NOW });
  eq(doc.cohorts.notRouted.metrics.manifestUptime.sellersScored, 6, "sellers whose deliveries left the window are not routed");
  eq(doc.cohorts.routed.metrics.manifestUptime.status, "not-enough-data", "sellers with deliveries and no crawl record are scored on no crawl metric");
  eq(doc.delivery.pooledShare.share, 1, "and their purchases are pooled");
}
{
  // A day our own crawl failed broadly is left out of the crawl metrics, as on /api/reputation.
  const sellers = {};
  for (let i = 0; i < 6; i++) sellers[origin("x", i)] = { f: NOW - 40 * DAY, lc: NOW, lp: NOW, c: [today - 1, 12, 12, today, 0, 12], p: [today - 1, 6, 6, today, 0, 6], l: [], q: [0, 0, 0] };
  const withDay = await computeRouterBenchmarks({ state: "ready", sellers, delivery: {}, ourSideDays: [today] }, { now: NOW });
  const without = await computeRouterBenchmarks({ state: "ready", sellers, delivery: {}, ourSideDays: [] }, { now: NOW });
  eq(withDay.cohorts.notRouted.metrics.manifestUptime.median, 1, "the our-side day's failed reads are left out");
  eq(without.cohorts.notRouted.metrics.manifestUptime.median, 0.5, "and counted when the day is not ours");
}
{
  // Nothing measured: every statistic withheld, the state passed through.
  const doc = await computeRouterBenchmarks({ state: "not-measured-here", sellers: {}, delivery: {}, ourSideDays: [] }, { now: NOW });
  eq(doc.recordState, "not-measured-here", "the state word");
  ok(COHORT_METRICS.every((m) => doc.cohorts.routed.metrics[m].status === "not-enough-data" && doc.cohorts.notRouted.metrics[m].status === "not-enough-data" && doc.comparison[m].status === "not-enough-data"), "every statistic is withheld");
  eq(quantile([], 0.5), null, "an empty quantile");
  eq(distribution([0.1, 0.2, 0.3, 0.4, 0.5]).median, 0.3, "the median of five");
  eq(distribution([0.1, NaN, 0.3, null, 0.5]).status, "not-enough-data", "non-numbers are not scores");
  // The loop gets a turn while a large record is folded.
  const many = {}; for (let i = 0; i < 2000; i++) many[origin("m", i)] = rec(0.5, 100, 10);
  let turns = 0;
  await computeRouterBenchmarks({ state: "ready", sellers: many, delivery: {}, ourSideDays: [] }, { now: NOW, yieldTurn: async () => { turns++; } });
  ok(turns >= 7, `the fold yields while it runs (${turns} turns for 2000 sellers)`);
}

// ---- Part 2: the served route -----------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "router-benchmarks-"));
const boot = (extra = {}) => bootServer({ stores: "router-benchmarks", env: { FREE_MODE: "true", NODE_ENV: "test", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", ROUTER_WORKERS: "0", LOAD_SHED: "off", X402_SYNC_ON_START: "false", INDEX_FIRST_CRAWL_DELAY_MS: "999999999", ...extra } });
try {
  // Seeded: the reputation files hold six routed and six other sellers.
  const now = Date.now(), d0 = Math.floor(now / DAY);
  const s2 = (okN, n) => { const s = []; for (let i = n - 1; i >= 0; i--) s.push(d0 - i, i < okN ? 1 : 0, 1); return s; };
  const r2 = (u) => ({ f: now - 40 * DAY, lc: now, lp: now, c: s2(Math.round(20 * u), 20), p: s2(Math.round(10 * u), 10), l: [d0, 200, d0, 200, d0, 200, d0, 200, d0, 200], q: [10, 10, now] });
  const sellers = {}, o = {};
  for (let i = 0; i < 6; i++) { sellers[origin("routed", i)] = r2(1); o[origin("routed", i)] = { d: s2(8, 10), r: {} }; sellers[origin("other", i)] = r2(0.5); }
  const repFile = join(dir, "rep.json"), delFile = join(dir, "del.json");
  writeFileSync(repFile, JSON.stringify({ v: 1, since: now - 40 * DAY, updatedAt: now, sellers }));
  writeFileSync(delFile, JSON.stringify({ v: 1, o }));
  let srv = await boot({ X402_INDEX_CRAWL: "on", SELLER_REPUTATION_FILE: repFile, SELLER_DELIVERY_FILE: delFile, INDEX_CACHE_FILE: join(dir, "index-cache.json"), X402_ECONOMY_DB: join(dir, "econ.db") });
  try {
    let doc = null, res = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      res = await fetch(`${srv.url}${ROUTER_BENCHMARKS_PATH}`);
      doc = await res.json();
      if (doc.recordState === "ready" && doc.delivery.pooledShare.status === "measured") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    eq(res.status, 200, "the route answers 200");
    eq(doc.recordState, "ready", "the seeded records are loaded");
    eq(doc.delivery.pooledShare.share, 0.8, "the served pooled delivery share is the seeded one");
    eq(doc.comparison.manifestUptime, { status: "measured", routedMedian: 1, notRoutedMedian: 0.5, difference: 0.5 }, "the served comparison");
    ok(/max-age=300/.test(res.headers.get("cache-control") || ""), "the answer is cacheable for five minutes");
    ok(!/\.example/.test(JSON.stringify(doc)), "no seeded seller is named");
    const openapi = await (await fetch(`${srv.url}/openapi.json`)).json();
    ok(openapi.paths?.[ROUTER_BENCHMARKS_PATH]?.get?.operationId === "getRouterBenchmarks", "/openapi.json lists the route");
    const llms = await (await fetch(`${srv.url}/llms-full.txt`)).text();
    ok(llms.split("\n").some((l) => l.startsWith("- Router benchmarks: ") && l.includes(ROUTER_BENCHMARKS_PATH)), "/llms-full.txt points at it");
    eq((await fetch(`${srv.url}${ROUTER_BENCHMARKS_PATH}`, { method: "POST" })).status >= 400, true, "it is a GET");
  } finally { await srv.stop(); }

  // Nothing measured on this boot (the crawl is off): a 200 that withholds everything.
  srv = await boot({ X402_INDEX_CRAWL: "off" });
  try {
    const res = await fetch(`${srv.url}${ROUTER_BENCHMARKS_PATH}`);
    const doc = await res.json();
    eq(res.status, 200, "a boot that measures nothing still answers");
    eq(doc.recordState, "not-measured-here", "and says so");
    ok(COHORT_METRICS.every((m) => doc.comparison[m].status === "not-enough-data") && doc.delivery.pooledShare.share === null, "with every statistic withheld");
  } finally { await srv.stop(); }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\nrouter benchmarks: ${pass} passed`);
