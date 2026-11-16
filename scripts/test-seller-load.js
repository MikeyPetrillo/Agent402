#!/usr/bin/env node
// The load controls our index puts on sellers' hosts (src/seller-load.js):
//   - an unchanged manifest and OpenAPI double the wait before the next crawl,
//     up to the cap, and a change, a failed crawl, a failed router purchase or
//     a re-registration resets it;
//   - every request the crawler and the probes send is counted per operator
//     per UTC day, past the budget a non-essential probe is refused, and the
//     router's probe for a paying caller never is;
//   - a 429 or 503 holds the host until its Retry-After (a default without
//     one, never past a day);
//   - a shared store that does not answer leaves this process deciding.
// Offline, on the memory store, with an injected clock.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { createSellerLoad, revisitIntervalMs, bodyHash, REVISIT_CAP_MS, DAILY_BUDGET, THROTTLE_DEFAULT_MS, THROTTLE_MAX_MS } = await import("../src/seller-load.js");
const { createMemoryLimits } = await import("../src/shared-limits.js");
const { CRAWL_INTERVAL_MS } = await import("../src/crawl-cadence.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const H = 3_600_000;
const T0 = Date.parse("2026-11-16T00:10:00Z");

ok(REVISIT_CAP_MS === 12 * H && DAILY_BUDGET === 200 && THROTTLE_DEFAULT_MS === 30 * 60_000 && THROTTLE_MAX_MS === 24 * H, "defaults: 12 h cap, 200 a day, 30 min hold, a day at most");
ok([1, 2, 3, 4, 5, 6].map((n) => revisitIntervalMs(n) / H).join(",") === "1,2,4,8,12,12" && revisitIntervalMs(0) === 0, "the wait doubles from two cycles (1 h, 2 h, 4 h, 8 h) and stops at the cap");
ok(revisitIntervalMs(1) === 2 * CRAWL_INTERVAL_MS, "the first wait is two crawl cycles");
ok(bodyHash("a") === bodyHash("a") && bodyHash("a") !== bodyHash("b") && bodyHash(null) === null, "a body hash is stable and tells two bodies apart");

function fresh(opts = {}) {
  let t = T0;
  const load = createSellerLoad({ store: createMemoryLimits(), now: () => t, ...opts });
  return { load, at: (ms) => { t = ms; }, now: () => t, step: (ms) => { t += ms; } };
}

// ---- revisit back-off ---------------------------------------------------------
{
  const { load, step } = fresh();
  const O = "https://seller.example";
  ok((await load.revisitDue(O)).due, "an origin with no state is due");
  let r = await load.noteDiscoveryRead(O, { manifestHash: "m1", openapiHash: "o1" });
  ok(!r.unchanged && r.streak === 0 && (await load.revisitDue(O)).due, "the first read records the hashes and stays on the cycle");
  const waits = [];
  for (let i = 0; i < 6; i++) {
    r = await load.noteDiscoveryRead(O, { manifestHash: i % 2 ? "m1" : undefined, openapiHash: undefined });
    waits.push(Math.round(r.intervalMs / H));
    const due = await load.revisitDue(O);
    ok(!due.due, `after unchanged read ${i + 1} the origin waits (${waits[i]} h)`);
    step(r.intervalMs);
    ok((await load.revisitDue(O)).due, `and is due again once the ${waits[i]} h wait has passed`);
  }
  ok(waits.join(",") === "1,2,4,8,12,12", `unchanged reads (304s and same-bytes alike) double the wait to the cap: ${waits.join(",")} h`);
  r = await load.noteDiscoveryRead(O, { manifestHash: "m2", openapiHash: undefined });
  ok(!r.unchanged && r.streak === 0 && (await load.revisitDue(O)).due, "a changed manifest puts the origin back on the cycle");
  await load.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined });
  r = await load.noteDiscoveryRead(O, { manifestHash: "m2", openapiHash: null });
  ok(!r.unchanged, "an OpenAPI that stopped answering is a change");
  for (const reason of ["listing-failure", "router-buy-failed", "re-registration"]) {
    await load.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined });
    await load.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined });
    ok(!(await load.revisitDue(O)).due, `backed off before a ${reason}`);
    ok(await load.resetRevisit(O, reason), `a ${reason} resets the back-off`);
    ok((await load.revisitDue(O)).due, `and the origin is due on the next cycle after a ${reason}`);
  }
  r = await load.noteDiscoveryRead(O, { manifestHash: undefined, openapiHash: undefined, advance: false });
  ok(r.streak === 0 && (await load.revisitDue(O)).due, "a read the seller asked for records the documents and keeps the origin on the cycle");
  ok(!(await load.resetRevisit("https://never.example", "listing-failure")), "a reset of an origin that was never backed off changes nothing");
  const st = load.status();
  ok(st.revisit.resets["re-registration"] === 1 && st.revisit.resets["listing-failure"] === 1 && st.revisit.unchangedReads > 0 && st.revisit.changedReads > 0, "the operator view counts unchanged reads, changes and resets by reason");
  ok(!JSON.stringify(st).includes("seller.example"), "the operator view names no origin");
}
{
  const { load } = fresh({ revisitCapMs: 0 });
  const O = "https://off.example";
  await load.noteDiscoveryRead(O, { manifestHash: "m" });
  const r = await load.noteDiscoveryRead(O, { manifestHash: undefined });
  ok(r.streak === 0 && (await load.revisitDue(O)).due, "SELLER_REVISIT_MAX_HOURS=off keeps every origin on the cycle");
}

// ---- per-host daily budget ------------------------------------------------------
{
  const { load, at } = fresh({ dailyBudget: 5 });
  const a = "https://a.example.com/x", b = "https://api.example.com/y";
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await load.takeBudget(i % 2 ? a : b, "crawler")).ok);
  ok(results.every(Boolean), "requests up to the budget are allowed, counted per registrable domain (two hosts, one budget)");
  ok(!(await load.takeBudget(a, "paywall")).ok, "past the budget a non-essential probe is refused");
  ok((await load.probeRefusal(b, "quote")) === "budget", "and a price probe reads why");
  ok((await load.budgetSpent(a)).spent, "the day reads spent");
  const ess = await load.takeBudget(a, "router-probe", { essential: true });
  ok(ess.ok && ess.used === 6, "the router's probe for a paying caller is counted and never refused");
  const plan = await load.crawlPlan("https://a.example.com");
  ok(plan.skip === "budget", "a scheduled crawl of a spent host waits");
  ok((await load.takeBudget("https://one.supabase.co/functions/v1/f", "crawler")).ok && (await load.takeBudget("https://two.supabase.co/x", "crawler")).ok, "on shared hosting each hostname has its own budget");
  at(Date.parse("2026-11-17T00:00:01Z"));
  ok((await load.takeBudget(a, "paywall")).ok && !(await load.crawlPlan("https://a.example.com")).skip, "the next UTC day starts a fresh budget");
  const st = load.status();
  ok(st.budget.refused.paywall === 1 && st.budget.refused.quote === 1 && st.budget.requests["router-probe"] === 1, "the operator view counts requests and refusals by kind");
}
{
  const { load } = fresh({ dailyBudget: 0 });
  let all = true;
  for (let i = 0; i < 300; i++) all = all && (await load.takeBudget("https://x.example", "quote")).ok;
  ok(all, "SELLER_PROBE_DAILY_BUDGET=off sets no budget");
}

// ---- Retry-After -------------------------------------------------------------------
{
  const { load, now, step } = fresh();
  const u = "https://busy.example/api/thing";
  ok(await load.noteThrottle(u, 404, "60") === 0 && !(await load.throttledUntil(u)), "a status other than 429 or 503 holds nothing");
  const until = await load.noteThrottle(u, 429, "120");
  ok(until === now() + 120_000 && (await load.throttledUntil("https://busy.example/other")) === until, "a 429 holds the whole host until its Retry-After");
  ok((await load.crawlPlan("https://busy.example")).skip === "throttled", "a scheduled crawl of a held host waits");
  ok((await load.probeRefusal(u, "paywall")) === "throttled", "and so does an unpaid probe");
  step(121_000);
  ok(!(await load.throttledUntil(u)) && !(await load.crawlPlan("https://busy.example")).skip, "the hold ends at the Retry-After");
  const t503 = await load.noteThrottle(u, 503, null);
  ok(t503 === now() + THROTTLE_DEFAULT_MS, "a 503 with no Retry-After holds for the default");
  const date = new Date(now() + 3 * H).toUTCString();
  const tDate = await load.noteThrottle(u, 503, date);
  ok(Math.abs(tDate - (now() + 3 * H)) < 2000, "an HTTP-date Retry-After is read");
  const tLong = await load.noteThrottle("https://slow.example", 429, 7 * 86400);
  ok(tLong === now() + THROTTLE_MAX_MS, "a hold never passes a day");
  ok((await load.noteThrottle(u, 429, "5")) >= tDate, "a shorter Retry-After never cuts a longer hold short");
}

// ---- a shared store that does not answer --------------------------------------------
{
  const down = new Proxy({ mode: "redis" }, { get: (t, k) => (k === "mode" ? "redis" : async () => ({ ok: false, error: "down" })) });
  let t = T0;
  const load = createSellerLoad({ store: down, now: () => t, dailyBudget: 2 });
  ok((await load.takeBudget("https://d.example", "quote")).ok && (await load.takeBudget("https://d.example", "quote")).ok && !(await load.takeBudget("https://d.example", "quote")).ok,
    "with the shared store down this process's own count decides");
  await load.noteDiscoveryRead("https://d.example", { manifestHash: "m" });
  await load.noteDiscoveryRead("https://d.example", { manifestHash: undefined });
  ok(!(await load.revisitDue("https://d.example")).due, "and keeps the back-off in its own memory");
}

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
