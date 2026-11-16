#!/usr/bin/env node
// A crawl cycle's health (the dead-submission release's outage guard and the
// our-side share that lets a held listing age out) is measured on the origins
// the load controls backed off as well as on those read: an origin backed off
// because its documents did not change was read, and read well, within its
// wait. Reproduces the case that broke it: 1000 origins, 200 of them dark
// with reads that time out on our side; once the healthy ones are backed off,
// the cycles read 0% healthy and 100% our side unless they vote.
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

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
idx.__setCrawlFetchForTest(async (url, opts) => {
  const host = hostOf(url);
  if (host.startsWith("dark")) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const u = new URL(url);
  if (u.pathname !== "/.well-known/x402") throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  const etag = `"m-${host}"`;
  if (opts?.allowNotModified && opts?.validators?.etag === etag) return { notModified: true, finalUrl: url, validators: { etag } };
  const body = JSON.stringify({ x402Version: 2, name: host, resources: [{ resource: `${u.origin}/api/thing`, method: "GET", description: "A thing.", price: "$0.005", accepts }] });
  return { html: body, finalUrl: url, validators: { etag } };
});
idx.__setProbeFetchForTest(async () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } }));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
