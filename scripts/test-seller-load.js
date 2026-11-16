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
  ok(!/seller\.example/.test(JSON.stringify(st)), "the operator view names no origin");
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
  ok(ess.ok && ess.used === 1 && ess.routine === false && (await load.routerProbesToday(a)) === 1, "the router's probe for a paying caller is counted on its own day count and never refused");
  ok((await load.budgetSpent(a)).used === 5, "and does not count against the crawl's budget");
  const crawlRead = await load.takeBudget(a, "crawler", { essential: true });
  ok(crawlRead.ok && crawlRead.used === 6, "a read inside a crawl already started is counted on the day's budget and never refused");
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

// ---- the request log ------------------------------------------------------------------
{
  const store = createMemoryLimits();
  let t = T0;
  const a = createSellerLoad({ store, now: () => t });
  const b = createSellerLoad({ store, now: () => t });
  const U = "https://logged.example/api/x";
  await a.takeBudget(U, "crawler", { essential: true });
  await a.takeBudget(U, "quote");
  await a.takeBudget(U, "quote");
  await b.takeBudget(U, "router-probe", { essential: true });
  t += 61_000;
  await a.takeBudget(U, "paywall");
  await a.flush(); await b.flush();
  const log = await b.requestLog("logged.example");
  const row = (minute, kind) => log.rows.find((r) => r.minute === new Date(minute).toISOString() && r.kind === kind)?.requests || 0;
  const m0 = Math.floor(T0 / 60_000) * 60_000;
  ok(log.total === 5 && row(m0, "quote") === 2 && row(m0, "crawler") === 1 && row(m0, "router-probe") === 1 && row(m0 + 60_000, "paywall") === 1,
    `the request log counts each component's requests to a host per minute, across containers (${JSON.stringify(log.rows)})`);
  const refused = createSellerLoad({ store: createMemoryLimits(), now: () => t, dailyBudget: 1 });
  await refused.takeBudget(U, "quote"); await refused.takeBudget(U, "quote");
  ok((await refused.requestLog("logged.example")).total === 1, "a request the budget refused was not sent and is not logged");
  t += 2 * 24 * H + 60_000;
  ok((await b.requestLog("logged.example")).total === 0, "past two days the counts are gone");
  // Requests outside the budget (a catalog fetch, the site-crawl tool, the
  // router's purchase) are logged by host and component, never refused or
  // counted against the day; the hosts held in memory stay capped.
  const c = createSellerLoad({ store: createMemoryLimits(), now: () => t, dailyBudget: 1 });
  c.logRequest("https://caller.example/a/b?q=1", "fetch");
  c.logRequest("https://caller.example/other", "fetch");
  c.logRequest("https://caller.example/", "site-crawl");
  c.logRequest("https://caller.example/buy", "router-buy");
  const cl = await c.requestLog("caller.example");
  ok(cl.total === 4 && cl.rows.find((r) => r.kind === "fetch")?.requests === 2 && cl.rows.every((r) => !/\//.test(r.kind)) && JSON.stringify(cl).indexOf("/a/b") < 0,
    `logged per host and component, with no path (${JSON.stringify(cl.rows)})`);
  ok((await c.budgetSpent("https://caller.example/")).used === 0 && (await c.takeBudget("https://caller.example/x", "quote")).ok, "and none of them uses the host's day");
  for (let i = 0; i < 6000; i++) c.logRequest(`https://h${i}.example/`, "fetch");
  ok(c.status().requestLog.hostsInMemory === 5000, `the hosts held in memory stay at 5,000 (${c.status().requestLog.hostsInMemory})`);
  await c.flush();
  ok((await c.requestLog("h0.example")).total === 1, "a host dropped from memory had its counts written first");
}

// ---- a busy host's request log: one counter per host, component and minute ----------
{
  // Three components each send a busy host a request every 5 s for two days,
  // flushed after every request (the write-behind's cadence). The store holds
  // one counter per (minute, component), grouped by hour: an add touches one
  // counter and never reads the host's window, so its cost does not grow with
  // the host's history.
  const store = createMemoryLimits();
  const calls = {};
  const spy = new Proxy(store, { get(target, p) {
    const v = target[p];
    if (typeof v !== "function") return v;
    return (...a) => { if (a[0] === "seller-request-log") calls[p] = (calls[p] || 0) + 1; return v.apply(target, a); };
  } });
  let t = Math.floor(T0 / H) * H;
  const load = createSellerLoad({ store: spy, now: () => t });
  const HOST = "busy.example", KINDS = ["fetch", "crawler", "router-buy"];
  const STEPS = (2 * 24 * H) / 5_000;
  for (let i = 0; i < STEPS; i++) {
    for (const k of KINDS) load.logRequest(`https://${HOST}/p${i}`, k);
    await load.flush();
    t += 5_000;
  }
  t -= 5_000;
  const sizes = store._tallySizes?.() || { keys: Infinity, fields: Infinity, maxFieldsPerKey: Infinity };
  ok(!calls.windowAdd && calls.tallyAdd > 0, `no request-log write scans a window (windowAdd ${calls.windowAdd || 0}, tallyAdd ${calls.tallyAdd || 0})`);
  ok(sizes.maxFieldsPerKey <= 60 * KINDS.length, `one counter per minute and component: at most ${60 * KINDS.length} in any one key an add touches (${sizes.maxFieldsPerKey})`);
  ok(sizes.fields <= (2 * 24 * 60 + 60) * KINDS.length && sizes.keys <= 50, `two days at a busy host are ${sizes.fields} counters in ${sizes.keys} keys (was one member per flush)`);
  const log = await load.requestLog(HOST);
  ok(log.complete && log.total === STEPS * KINDS.length,
    `the operator read still sums every request in the two days (${log.total} of ${STEPS * KINDS.length})`);
  t += 30 * 60_000;
  const later = await load.requestLog(HOST);
  ok(later.total === (STEPS - 30 * 12) * KINDS.length, `half an hour on, the oldest hour's later minutes are still read (${later.total} of ${(STEPS - 30 * 12) * KINDS.length})`);
  ok(log.rows.every((r) => r.requests <= 12) && new Set(log.rows.map((r) => r.kind)).size === KINDS.length, "per component and minute, twelve a minute each");
  const mem = load.status().requestLog;
  ok(mem.entriesInMemory <= 2 * KINDS.length, `this process holds only the last few minutes of the host (${mem.entriesInMemory} entries)`);
}

// ---- in-process memory is bounded per host, flushed or not ----------------------------
{
  const store = createMemoryLimits({ tallyFieldCap: 1_000_000 });
  let t = T0;
  const load = createSellerLoad({ store, now: () => t });
  const KINDS = ["fetch", "crawler", "router-buy", "quote"];
  // An hour of requests with no timer flush in between (a stalled loop):
  // the host's in-memory counts stay capped, and none of them is lost.
  for (let m = 0; m < 60; m++) { for (const k of KINDS) load.logRequest("https://unflushed.example/", k); t += 60_000; }
  const held = load.status().requestLog.entriesInMemory;
  ok(held <= 32, `one host's in-memory entries stay capped with no flush (${held})`);
  await load.flush();
  ok((await load.requestLog("unflushed.example")).total === 60 * KINDS.length, "and every request still reaches the operator read");
  // 3,000 hosts x 4 components x 60 minutes: bounded by hosts x the per-host cap.
  for (let m = 0; m < 60; m++) { for (let h = 0; h < 3000; h++) for (const k of KINDS) load.logRequest(`https://m${h}.example/`, k); t += 60_000; }
  const st = load.status().requestLog;
  ok(st.entriesInMemory <= st.hostsInMemory * 32, `3,000 busy hosts hold ${st.entriesInMemory} entries in memory (cap ${st.hostsInMemory} x 32)`);
  await load.flush();
  const sample = await load.requestLog("m7.example");
  ok(sample.total === 60 * KINDS.length, `an evicted or capped host's counts reached the store (${sample.total})`);
}

// ---- a cycle's prefetch of 3,000 origins never holds the event loop ----------------
{
  // Another container's state for 3,000 origins; this process reads it all
  // before a crawl cycle. One turn of the event loop must stay short: read in
  // one batch, the reads of every origin resolved inside one turn.
  const N = 3000, MAX_TURN_MS = 15;
  const store = createMemoryLimits();
  let t = T0;
  const writer = createSellerLoad({ store, now: () => t });
  const origins = Array.from({ length: N }, (_, i) => `https://s${i}.example`);
  for (const o of origins) {
    await writer.noteDiscoveryRead(o, { manifestHash: "m" });
    await writer.noteDiscoveryRead(o, { manifestHash: undefined });
    await writer.takeBudget(`${o}/x`, "quote");
    await writer.noteThrottle(o, 429, "60");
  }
  await writer.flush();
  const turns = [];
  for (let run = 0; run < 3; run++) {
    const reader = createSellerLoad({ store, now: () => t });
    let max = 0, last = performance.now(), done = false;
    const tick = () => { const n = performance.now(); max = Math.max(max, n - last); last = n; if (!done) setImmediate(tick); };
    setImmediate(tick);
    const r = await reader.prefetch(origins, { waitMs: 60_000 });
    done = true;
    await new Promise((res) => setImmediate(res));
    turns.push(max);
    if (run === 2) {
      ok(r.origins === N && !r.timedOut && (await reader.hold(origins[N - 1])) === "throttled" && !(await reader.revisitDue(origins[N - 1])).due && (await reader.budgetSpent(`${origins[0]}/x`)).used === 1,
        "control: the prefetch read every origin's state (hold, back-off, count)");
    }
  }
  const best = Math.min(...turns);
  ok(best < MAX_TURN_MS, `the prefetch of ${N} origins holds the event loop at most ${best.toFixed(1)} ms in one turn (runs ${turns.map((x) => x.toFixed(1)).join(", ")} ms; limit ${MAX_TURN_MS})`);
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
