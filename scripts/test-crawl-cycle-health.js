#!/usr/bin/env node
// A crawl cycle's health (the dead-submission release's outage guard and the
// our-side share that lets a held listing age out) stays what it was when
// every origin was read, though the load controls back most origins off:
//   * 1000 origins, 200 of them dark with reads that time out on our side:
//     with the healthy ones backed off (in step, then on spread schedules),
//     each cycle still reads about 80% healthy and 20% our side, not 0% and
//     100% (no dead submission ever released, no dark listing ever aging out);
//   * the same origins with every read of ours failing (our egress cut), on
//     spread back-offs: each cycle reads about 0% healthy and fails on our
//     side, so no release runs and every healthy listing is held; counting a
//     backed-off origin as a healthy read kept the cycle above 50% and let the
//     holds age out (about 500 listings gone by hour 6).
// Driven through the real cycle (src/x402-index.js runCrawl) with stub reads.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-cycle-health"));
process.env.X402_INDEX_CRAWL = "off";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
process.env.X402_PAYWALL_PROBES_PER_CYCLE = "0";
const HEALTHY = 800, DARK = 200;
const healthy = Array.from({ length: HEALTHY }, (_, i) => `https://ok${i}.example`);
const dark = Array.from({ length: DARK }, (_, i) => `https://dark${i}.example`);
process.env.X402_INDEX_SEEDS = [...healthy, ...dark].join(",");
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-cycle-health-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");
const { hostOf } = await import("./lib/url-host.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
let clock = Date.now();
sellerLoad.setClock(() => clock);
// The index's own clock too (fetchedAt, the hold window), so hours pass.
const realNow = Date.now;
Date.now = () => clock;

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
// `warm`: while it rises, origin okN's manifest changes on each cycle until
// cycle N % 24, so the back-offs that follow run on spread schedules.
let warm = 0, egressCut = false;
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
idx.__setCrawlFetchForTest(async (url, opts) => {
  const host = hostOf(url);
  if (egressCut || host.startsWith("dark")) throw timeout();
  const u = new URL(url);
  if (u.pathname !== "/.well-known/x402") throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  const ver = Math.min(warm, (Number(host.match(/\d+/)?.[0]) || 0) % 24);
  const etag = `"m-${host}-${ver}"`;
  if (opts?.allowNotModified && opts?.validators?.etag === etag) return { notModified: true, finalUrl: url, validators: { etag } };
  const body = JSON.stringify({ x402Version: 2, name: host, resources: [{ resource: `${u.origin}/api/thing`, method: "GET", description: `A thing, version ${ver}.`, price: "$0.005", accepts }] });
  return { html: body, finalUrl: url, validators: { etag } };
});
idx.__setProbeFetchForTest(async () => {
  if (egressCut) throw timeout();
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } });
});

const cycles = [];
for (let c = 1; c <= 6; c++) {
  const sum = await idx.__runCrawlCycleForTest();
  cycles.push(sum);
  console.log(`# cycle ${c}: crawled ${sum.crawled} of ${sum.due}, waiting ${JSON.stringify(sum.skipped)}, ok ${sum.okFraction}, our side ${sum.oursShare}`);
  clock += 30 * 60_000;
}
const later = cycles.slice(1);
ok(later.some((c) => (c.skipped?.unchanged || 0) > HEALTHY / 2), "control: after the first cycle most healthy origins are backed off");
ok(later.every((c) => c.okFraction >= 0.5), `every cycle reads healthy enough to release dead submissions (ok ${later.map((c) => c.okFraction).join(", ")})`);
ok(later.every((c) => c.oursShare < 0.5), `no cycle reads as failing on our side (${later.map((c) => c.oursShare).join(", ")})`);
ok(cycles.every((c) => Math.abs(c.okFraction - HEALTHY / (HEALTHY + DARK)) < 0.05), `each cycle's health is the share of healthy origins, as when every origin was read (${cycles.map((c) => c.okFraction).join(", ")})`);

// ---- a slow shared store does not slow the cycle ------------------------------------
// Every command to the shared store now takes LATENCY. The load controls decide
// from this process's memory and read the store once per cycle in one batch
// (bounded by PREFETCH_WAIT_MS), so a cycle costs about one round trip, not one
// per origin: 1010 origins at 25 at a time with three reads each would be over
// two minutes.
{
  const LATENCY = 400;
  const { shared } = await import("../src/shared-limits.js");
  const { PREFETCH_WAIT_MS } = await import("../src/seller-load.js");
  const restore = {};
  for (const k of Object.keys(shared)) {
    if (typeof shared[k] !== "function") continue;
    const f = (restore[k] = shared[k]);
    shared[k] = async (...a) => { await new Promise((r) => setTimeout(r, LATENCY)); return f(...a); };
  }
  try {
    clock += 12 * 3_600_000; // every back-off has ended: the whole list is read
    const t0 = performance.now();
    const sum = await idx.__runCrawlCycleForTest();
    const secs = (performance.now() - t0) / 1000;
    ok(sum.crawled === sum.due && sum.due >= HEALTHY + DARK, `control: the slow-store cycle read every origin (${sum.crawled} of ${sum.due})`);
    ok(secs < (PREFETCH_WAIT_MS + 6 * LATENCY) / 1000 + 2, `a cycle of ${sum.due} origins behind a store answering in ${LATENCY} ms takes ${secs.toFixed(1)} s`);
  } finally { Object.assign(shared, restore); }
}

// ---- 200 dark origins, the healthy ones backed off on spread schedules -------------
const run = async (label) => {
  const sum = await idx.__runCrawlCycleForTest();
  console.log(`# ${label}: crawled ${sum.crawled} of ${sum.due}, waiting ${JSON.stringify(sum.skipped)}, ok ${sum.okFraction}, our side ${sum.oursShare}, release ${sum.reason}`);
  clock += 30 * 60_000;
  return sum;
};
const spread = [];
for (warm = 1; warm <= 24; warm++) await run(`spreading ${warm}`);
for (let c = 1; c <= 36; c++) spread.push(await run(`spread ${c}`));
const tail = spread.slice(-24);
const crawledCounts = tail.map((c) => c.crawled - DARK);
ok(tail.every((c) => (c.skipped?.unchanged || 0) > 0) && new Set(crawledCounts).size > 3 && Math.max(...crawledCounts) < HEALTHY / 2,
  `control: the healthy origins are backed off on spread schedules (healthy reads per cycle ${crawledCounts.join(", ")})`);
ok(tail.every((c) => Math.abs(c.okFraction - HEALTHY / (HEALTHY + DARK)) < 0.05), `200 dark: each cycle still reads about 80% healthy (${tail.map((c) => c.okFraction).join(", ")})`);
ok(tail.every((c) => c.oursShare < 0.5), `200 dark: no cycle reads as failing on our side (${tail.map((c) => c.oursShare).join(", ")})`);

// ---- our egress cut: every read of ours fails -------------------------------------
{
  egressCut = true;
  const outage = [];
  for (let c = 1; c <= 16; c++) outage.push(await run(`egress cut ${c}`)); // eight hours
  // Until the outage reaches an origin whose last read was good, only the
  // dark ones are read, and they fail as they always do: nothing yet tells
  // that cycle from a normal one. From the first such read on, every cycle
  // reads as ours.
  const first = outage.findIndex((c) => c.crawled > DARK);
  const late = outage.slice(first);
  ok(first >= 0 && first <= 6 && outage[0].skipped?.unchanged > HEALTHY / 2, `control: most healthy origins were backed off when the outage began, and the first was read again in cycle ${first + 1}`);
  ok(late.every((c) => c.okFraction !== null && c.okFraction < 0.1), `egress cut: from then on each cycle reads about 0% healthy (${outage.map((c) => c.okFraction).join(", ")})`);
  ok(late.every((c) => /^outage guard/.test(String(c.reason))), `egress cut: and the release pass does not run (${[...new Set(late.map((c) => c.reason))].join(" | ")})`);
  ok(late.length >= 10 && late.every((c) => c.oursShare >= 0.5), `egress cut: every such cycle reads as failing on our side (${late.map((c) => c.oursShare).join(", ")})`);
  const cache = idx._cacheForTests();
  const kept = healthy.filter((o) => { const e = cache.get(o); return e && !e.error && e.tools?.length; }).length;
  ok(kept === HEALTHY, `egress cut: after eight hours every healthy listing is held (${kept} of ${HEALTHY})`);
  egressCut = false;
  const back = await run("egress back");
  ok(back.okFraction > 0.5, `control: the first cycle after the outage reads healthy again (${back.okFraction})`);
}

// ---- a few failing origins do not set the vote, and votes are not reads ----------
{
  const few = Array.from({ length: 5 }, (_, i) => `https://few${i}.example`);
  const many = Array.from({ length: 20 }, (_, i) => `https://many${i}.example`);
  const allOurs = (list) => new Map(list.map((o) => [o, true]));
  ok(idx.__backedOffVoteForTest(few, allOurs(few), { reset: true }) === null, "five reads of once-good origins, all failing on our side, set no vote rate");
  const measured = idx.__backedOffVoteForTest(many, new Map());
  ok(measured?.ours === 0 && measured.ok === 0, `twenty such reads set the rate (${JSON.stringify(measured)})`);
  ok(idx.__backedOffVoteForTest(few, allOurs(few))?.ours === 0, "a later cycle with five failing reads keeps the rate measured on twenty");
  ok(idx.__backedOffVoteForTest(many, allOurs(many))?.ours === 1, "control: twenty failing reads do move the rate");
  ok(idx.__closeCrawlCycleTallyForTest({ done: 600, ours: 600, read: 5 }) === 0, "votes do not meet the our-side sample floor: 5 reads and 595 votes read as no share");
  ok(idx.__closeCrawlCycleTallyForTest({ done: 600, ours: 600, read: 20 }) === 1, "control: 20 reads meet it");
  idx.__setLastCycleOursShareForTest(0);
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
