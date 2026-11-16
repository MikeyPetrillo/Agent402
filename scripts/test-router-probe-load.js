#!/usr/bin/env node
// The seller load controls never sit on a buyer's path and never let the
// router's work for paying callers pause a seller's crawl:
//   * the router's pre-payment probe (sendRouterProbe, src/seller-load.js) is
//     sent with the host's day budget spent, is counted on a router count of
//     its own (the crawl's budget is untouched), and a 429 it reads holds the
//     host's unpaid probes;
//   * behind a shared store that answers in a second, the probe, the count
//     and the hold cost the buyer no store round trip, and the crawl's
//     decisions do not wait on it either;
//   * what one container counts reaches another through the store (prefetch);
//   * a 429 from a price probe holds the host, so the crawl's next probe is
//     not sent; a purchase that did not deliver puts the seller back on the
//     normal crawl cycle.
// Offline: stub stores and probes, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("router-probe-load"));
process.env.X402_INDEX_CRAWL = "off";
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "router-probe-load-")), "removed-origins.json");
}
const { createSellerLoad, sendRouterProbe, sellerLoad } = await import("../src/seller-load.js");
const { createMemoryLimits } = await import("../src/shared-limits.js");
const { urlMatches } = await import("./lib/url-host.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const T0 = Date.parse("2026-11-16T03:00:00Z");
const slow = (ms, inner = createMemoryLimits()) => {
  const s = { mode: "redis", ops: 0 };
  for (const k of ["windowAdd", "windowRead", "windowReadMany", "windowRemove", "windowClear", "flagSet", "flagGet", "counterAdd", "counterGet", "counterClear"]) {
    s[k] = async (...a) => { s.ops++; await new Promise((r) => setTimeout(r, ms)); return inner[k](...a); };
  }
  return s;
};
const reply = (status, headers = {}) => new Response("{}", { status, headers });

// ---- the router's probe with the day spent ---------------------------------------
{
  const load = createSellerLoad({ store: createMemoryLimits(), now: () => T0, dailyBudget: 3 });
  const U = "https://busy-seller.example/api/paid";
  for (let i = 0; i < 3; i++) await load.takeBudget(U, "quote");
  ok((await load.budgetSpent(U)).spent && (await load.probeRefusal(U, "quote")) === "budget", "control: the host's day is spent and an unpaid probe is refused");
  let sent = 0;
  const p = await sendRouterProbe(U, async () => { sent++; return reply(402); }, { load });
  await load.flush();
  ok(sent === 1 && p.status === 402, "the router's probe for a paying caller is sent with the day spent");
  ok((await load.routerProbesToday(U)) === 1, "it is counted on the host's router count");
  ok((await load.budgetSpent(U)).used === 3, "and not on the crawl's budget, so a seller busy with buyers keeps its crawl");
  ok(load.status().budget.requests["router-probe"] === 1 && !load.status().budget.refused["router-probe"], "the operator view counts it as sent, never refused");
  await sendRouterProbe(U, async () => reply(429, { "retry-after": "120" }), { load });
  await load.flush();
  ok((await load.throttledUntil(U)) === T0 + 120_000, "a 429 the router's probe reads holds the host for its Retry-After");
  ok((await load.probeRefusal(U, "paywall")) === "throttled", "so the crawl's unpaid probes wait");
  let after = 0;
  await sendRouterProbe(U, async () => { after++; return reply(402); }, { load });
  ok(after === 1, "and the next purchase is still sent");
}

// ---- a slow shared store is never on the buyer's path ------------------------------
{
  const store = slow(1000);
  const load = createSellerLoad({ store, now: () => T0, dailyBudget: 200 });
  const U = "https://slow-store-seller.example/api/paid";
  let t = performance.now();
  await sendRouterProbe(U, async () => reply(402), { load });
  ok(performance.now() - t < 100, `the probe returns without waiting on the store (${Math.round(performance.now() - t)} ms)`);
  t = performance.now();
  await sendRouterProbe(U, async () => reply(503), { load });
  ok(performance.now() - t < 100, `a 503 answer is held without waiting on the store (${Math.round(performance.now() - t)} ms)`);
  t = performance.now();
  await load.takeBudget(U, "router-probe", { essential: true });
  await load.takeBudget(U, "quote");
  await load.noteThrottle("https://other-held.example/x", 429, "60");
  ok(performance.now() - t < 100, `counting a request and noting a hold never wait on the store (${Math.round(performance.now() - t)} ms)`);
  await new Promise((r) => setImmediate(r)); // the hold is noted in memory on the next turn
  t = performance.now();
  const plan = await load.crawlPlan("https://slow-store-seller.example");
  const refusal = await load.probeRefusal(U, "quote");
  await load.noteDiscoveryRead("https://other.example", { manifestHash: "m" });
  ok(performance.now() - t < 100 && plan.skip === "throttled" && refusal === "throttled", `the crawl's plan, a probe's refusal and a recorded read decide from memory (${Math.round(performance.now() - t)} ms)`);
  t = performance.now();
  await load.flush();
  ok(store.ops > 0, `the writes still reach the store behind the decisions (${store.ops} commands, ${Math.round(performance.now() - t)} ms)`);
  // Prefetch is bounded by its wait.
  const bounded = createSellerLoad({ store: slow(5000), now: () => T0, prefetchWaitMs: 300 });
  t = performance.now();
  const r = await bounded.prefetch(Array.from({ length: 50 }, (_, i) => `https://p${i}.example`));
  ok(r.timedOut && performance.now() - t < 1000, `a cycle's prefetch waits at most its bound on a store answering in 5 s (${Math.round(performance.now() - t)} ms)`);
}

// ---- two containers share what they count -----------------------------------------
{
  const store = createMemoryLimits();
  const a = createSellerLoad({ store, now: () => T0, dailyBudget: 4 });
  const b = createSellerLoad({ store, now: () => T0, dailyBudget: 4 });
  const O = "https://shared.example";
  for (let i = 0; i < 4; i++) await a.takeBudget(`${O}/x`, "quote");
  await a.noteThrottle(`${O}/x`, 429, "300");
  await a.noteDiscoveryRead(O, { manifestHash: "m" });
  await a.noteDiscoveryRead(O, { manifestHash: undefined });
  await a.flush();
  ok(!(await b.budgetSpent(O)).spent && !(await b.throttledUntil(O)) && (await b.revisitDue(O)).due, "control: before a prefetch the other container has not read the store");
  await b.prefetch([O]);
  ok((await b.budgetSpent(O)).spent && (await b.throttledUntil(O)) === T0 + 300_000 && !(await b.revisitDue(O)).due, "after its cycle's prefetch it holds the count, the hold and the back-off the first one wrote");
}

// ---- the 429 hold on price probes and the reset after a failed purchase --------------
{
  const idx = await import("../src/x402-index.js");
  let clock = T0;
  sellerLoad.setClock(() => clock);
  const O = "https://held-probes.example";
  const probes = [];
  idx.__setProbeFetchForTest(async (url) => { probes.push(url); return reply(429, { "retry-after": "900" }); });
  const rows = ["/a", "/b", "/c"].map((route) => ({ seller: O, route, method: "GET", price: null, declared: true }));
  await idx.enrichLiveQuotes(rows, O, { gated: true });
  await sellerLoad.flush();
  ok(probes.length === 1 && urlMatches(probes[0], "held-probes.example", "/a"), `a 429 to the first price probe holds the host: the crawl sends nothing more (${probes.length} sent)`);
  ok((await sellerLoad.throttledUntil(O)) === clock + 900_000, "for the Retry-After it named");
  const { noteSellerDeliveryFailure } = await import("../src/x402-buyer.js");
  const S = "https://failed-buy.example";
  await sellerLoad.noteDiscoveryRead(S, { manifestHash: "m" });
  await sellerLoad.noteDiscoveryRead(S, { manifestHash: undefined });
  ok(!(await sellerLoad.revisitDue(S)).due, "control: the seller is backed off");
  noteSellerDeliveryFailure(S, "base", { status: 500 });
  await new Promise((r) => setTimeout(r, 20));
  ok((await sellerLoad.revisitDue(S)).due, "a purchase that did not deliver puts it back on the normal cycle");
  ok(sellerLoad.status().revisit.resets["router-buy-failed"] === 1, "counted as a reset for a failed purchase");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
