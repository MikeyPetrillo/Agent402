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
const { createSellerLoad, revisitIntervalMs, bodyHash, REVISIT_CAP_MS, DAILY_BUDGET, THROTTLE_DEFAULT_MS, THROTTLE_MAX_MS, landingGate, runAsRegistrant, REGISTRATION_HOURLY_MAX, REGISTRATION_HOST_HOURLY_MAX, REGISTRATION_PACE_MS } = await import("../src/seller-load.js");
const { operatorKey } = await import("../src/operator-key.js");
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
  const { load, at } = fresh({ dailyBudget: 5, probeShare: 1 });
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
  const load = createSellerLoad({ store: down, now: () => t, dailyBudget: 2, probeShare: 1 }); // the day total alone (the probe share has its own section)
  ok((await load.takeBudget("https://d.example", "quote")).ok && (await load.takeBudget("https://d.example", "quote")).ok && !(await load.takeBudget("https://d.example", "quote")).ok,
    "with the shared store down this process's own count decides");
  await load.noteDiscoveryRead("https://d.example", { manifestHash: "m" });
  await load.noteDiscoveryRead("https://d.example", { manifestHash: undefined });
  ok(!(await load.revisitDue("https://d.example")).due, "and keeps the back-off in its own memory");
}

// ---- a request is counted on the day of the origin whose crawl sent it ---------
{
  const { load, step } = fresh({ dailyBudget: 5, probeShare: 1 });
  const B = "https://stays.example", A1 = "https://moved-one.example", A2 = "https://moved-two.example";
  let sent = 0;
  for (let i = 0; i < 4; i++) if ((await load.takeBudget(`${B}/api/x`, "quote", { chargeTo: A1 })).ok) sent++;
  ok(sent === 4 && (await load.budgetSpent(B)).used === 0 && (await load.budgetSpent(A1)).used === 4, "a probe sent to another operator's host for a moved origin is counted on the moved origin's day");
  for (let i = 0; i < 4; i++) if ((await load.takeBudget(`${B}/api/x`, "quote", { chargeTo: A1 })).ok) sent++;
  ok(sent === 5 && (await load.budgetSpent(A1)).spent, `past its own day the moved origin's probes are refused (${sent} sent)`);
  ok((await load.probeRefusal(`${B}/api/x`, "quote", { chargeTo: A2 })) === "budget" && (await load.budgetSpent(A2)).used === 0, "a second moved origin's probe is refused once a day's allowance has landed on the host, and is not counted on its day");
  ok((await load.takeBudget(`${B}/api/x`, "quote", { essential: true, chargeTo: A2 })).ok === false, "an essential one included");
  ok((await load.landedToday(B)) === 5 && (await load.budgetSpent(B)).used === 0, "the landings are counted apart from the host's own day");
  ok((await load.hold(B)) === null && (await load.crawlPlan(B)).skip === null, "the host's own scheduled crawl is not held");
  for (let i = 0; i < 5; i++) await load.takeBudget(`${B}/openapi.json`, "crawler", { essential: true });
  ok((await load.budgetSpent(B)).spent && (await load.crawlPlan(B)).skip === "budget", "control: its own requests still spend its own day");
  ok((await load.takeBudget("https://api.stays.example/x", "quote", { chargeTo: "https://www.stays.example" })).ok === false && (await load.landedToday("https://api.stays.example")) === 5,
    "a move inside one operator's domain is counted on that operator's day as before, not as a landing");
  ok((await load.takeBudget(`${B}/api/x`, "router-probe", { essential: true, chargeTo: A1 })).ok && (await load.routerProbesToday(B)) === 1, "the router's probe stays on the host's router count and always goes through");
  step(24 * H);
  ok((await load.takeBudget(`${B}/api/x`, "quote", { chargeTo: A2 })).ok, "the next UTC day opens both allowances again");
  const own = fresh({ dailyBudget: 5, probeShare: 1 }).load;
  ok((await own.takeBudget("https://api.stays.example/x", "quote", { chargeTo: "https://www.stays.example" })).ok && (await own.landedToday("https://api.stays.example")) === 0 && (await own.budgetSpent("https://www.stays.example")).used === 1,
    "and such a move counts no landing");
}

// ---- the probes keep to their share of the day --------------------------------------
{
  // A day of 400: the unpaid price and paywall probes stop at half, so the
  // scheduled crawl's document reads always have the rest.
  const { load } = fresh({ dailyBudget: 400 });
  const O = "https://probed.example";
  let sent = 0;
  for (let i = 0; i < 400; i++) if ((await load.takeBudget(`${O}/r${i}`, i % 2 ? "quote" : "paywall")).ok) sent++;
  ok(sent === 200, `the probes stop at half the day (${sent} of 400 sent)`);
  ok(!(await load.budgetSpent(O)).spent && (await load.crawlPlan(O)).skip === null, "the day is not spent: the scheduled crawl still runs");
  ok((await load.probeRefusal(`${O}/x`, "quote")) === "budget", "a further probe is refused");
  let docs = 0;
  for (let i = 0; i < 200; i++) if ((await load.takeBudget(`${O}/openapi.json`, "crawler", { essential: true })).ok) docs++;
  ok(docs === 200 && (await load.budgetSpent(O)).spent, "control: the document reads use the rest, and then the day is spent");
  ok(load.status().budget.probesPerOperatorPerDay === 200 && load.status().budget.refused["quote:probe-share"] >= 1, "the operator view states the share and counts the refusals");
}

// ---- a host's hourly ceiling of registration reads ----------------------------------
{
  const { load, step, now } = fresh({ dailyBudget: 20, registrationHourlyMax: 5 });
  const V = "https://victim.example";
  const take = (i) => load.takeBudget(`${V}/p${i}/.well-known/x402`, "crawler", { essential: true, unscheduled: true });
  const first = [];
  for (let i = 0; i < 5; i++) first.push(await take(i));
  ok(first.every((b) => b.ok), "a host's registration reads are sent up to the hour's ceiling");
  ok((await load.registrationHeldFor(`${V}/p9`)) > 0, "then a registration on it is held before it starts");
  const over = await take(5);
  const toHour = Math.ceil((3_600_000 - (now() % 3_600_000)) / 1000);
  ok(over.ok === false && over.heldBy === "registration-hour" && over.retryAfterSeconds === toHour, `past it a read is not sent, with when to retry (${over.retryAfterSeconds} s)`);
  ok((await load.takeBudget(`${V}/x`, "crawler", { essential: true })).ok, "the host's scheduled reads are not held by it");
  ok((await load.takeBudget("https://other.example/.well-known/x402", "crawler", { essential: true, unscheduled: true })).ok, "another operator's host keeps its own ceiling");
  ok((load.status().budget.refused["crawler:registration-hour"] || 0) === 1, "the refusal is counted in the operator view");
  step(3_600_000);
  ok((await take(6)).ok && (await load.registrationHeldFor(V)) === 0, "the next hour the host is read again");
}

// ---- one registrant's reads never spend another's ---------------------------------
{
  ok(REGISTRATION_HOURLY_MAX === 20 && REGISTRATION_HOST_HOURLY_MAX === 200 && REGISTRATION_PACE_MS === 30_000, "defaults: 20 an hour per registrant and host, 200 at full pace per host, then one per 30 s");
  const waits = [];
  let clockRef;
  const { load, step, now } = fresh({ dailyBudget: 20, registrationHourlyMax: 5, registrationHostHourlyMax: 12, registrationPaceMs: 30_000, wait: async (ms) => { waits.push(ms); clockRef.step(ms); } });
  clockRef = { step };
  const V = "https://victimco.example";
  const as = (who, fn) => runAsRegistrant(who, fn);
  const read = (who, url) => as(who, () => load.takeBudget(url, "crawler", { essential: true, unscheduled: true }));
  // The lockout: one address spends its whole hour on path origins under the domain.
  const junk = [];
  for (let i = 0; i < 5; i++) junk.push(await read("198.51.100.1", `${V}/junk${i}/.well-known/x402`));
  ok(junk.every((b) => b.ok), "one registrant's reads are sent up to its hour on the host");
  const over = await read("198.51.100.1", `${V}/junk9/.well-known/x402`);
  ok(over.ok === false && over.heldBy === "registration-hour", "one registrant is still held past its own hour");
  ok((await as("198.51.100.1", () => load.registrationHeldFor(`${V}/junk10`))) > 0, "and its next registration on the host is held before it starts");
  ok((await as("203.0.113.9", () => load.registrationHeldFor("https://api.victimco.example"))) === 0, "another registrant's first registration of the host is not held by it");
  ok((await read("203.0.113.9", "https://api.victimco.example/.well-known/x402")).ok, "and its read is sent");
  // Many addresses together: none is refused for the host's hour; past it the reads wait in line.
  const sentAt = [];
  let refused = 0;
  for (let ip = 0; ip < 20; ip++) for (let j = 0; j < 5; j++) {
    const b = await read(`192.0.2.${ip}`, `${V}/m${ip}-${j}/openapi.json`);
    if (b.ok) sentAt.push(now()); else refused++;
  }
  ok(refused === 0, "many registrants: none is refused for the host's hour (first registrations are never held by others)");
  const paced = load.status().budget.requests["crawler:registration-paced"] || 0;
  ok(paced === 106 - 12 && waits.length > 0, `past the host's hour at full pace the reads wait in line (${paced} paced)`);
  const span = sentAt[sentAt.length - 1] - sentAt[0];
  ok(span >= (paced - 2) * 30_000, `many registrants are bounded to one read per pace interval past the ceiling (${Math.round(span / 1000)} s for ${paced} paced reads)`);
  ok(waits.every((ms) => ms > 0 && ms <= 30_000), "each wait is at most one pace interval after the read before it");
}

// ---- names that resolve to one address share its day -------------------------------
{
  const { load, step } = fresh({ dailyBudget: 4 });
  const ip = [{ address: "203.0.113.7", family: 4 }];
  const sent = [];
  for (let i = 0; i < 4; i++) sent.push(await load.takeAddressBudget(`https://n${i}.sslip.io/.well-known/x402`, ip, "crawler"));
  ok(sent.every((b) => b.ok), "names on one address are read up to its day");
  const over = await load.takeAddressBudget("https://n9.duckdns.org/.well-known/x402", ip, "crawler");
  ok(over.ok === false && over.heldBy === "address-day" && over.retryAfterSeconds > 0, "another such name on the same address is held past it");
  ok((await load.takeAddressBudget("https://n9.sslip.io/x", [{ address: "203.0.113.8", family: 4 }], "crawler")).ok, "a name on another address keeps its own day");
  ok((await load.takeAddressBudget("https://shop.example/x", ip, "crawler")).ok, "a name on its own registrable domain is not counted per address");
  step(24 * 3_600_000);
  ok((await load.takeAddressBudget("https://n0.sslip.io/x", ip, "crawler")).ok, "the next UTC day the address is read again");
}

// ---- reads for a registration never spend the origin's day -------------------------
{
  // Anyone may register any origin (path origins under one domain included):
  // those reads are counted on a day count of their own, never refused, and
  // never read by the scheduled crawl's plan.
  // (The hourly ceiling on a host's registration reads is its own section.)
  const { load } = fresh({ dailyBudget: 20, registrationHourlyMax: 0 });
  const V = "https://victim.example";
  let allSent = true;
  for (let i = 0; i < 50; i++) {
    allSent = (await load.takeBudget(`${V}/p${i}/.well-known/x402`, "crawler", { essential: true, unscheduled: true })).ok && allSent;
    allSent = (await load.takeBudget(`${V}/p${i}/api/x`, "quote", { essential: true, chargeTo: `${V}/p${i}`, unscheduled: true })).ok && allSent;
  }
  ok(allSent, "every registration read is sent");
  ok((await load.budgetSpent(V)).used === 0 && (await load.crawlPlan(V)).skip === null, "a hundred registration reads leave the domain's day untouched: its scheduled crawl runs");
  ok(load.status().budget.requests["crawler:unscheduled"] === 50 && load.status().budget.requests["quote:unscheduled"] === 50, "they are counted apart in the operator view");
  const T = "https://landing.example";
  let landed = 0, held = null;
  for (let i = 0; i < 30 && !held; i++) {
    try { await landingGate(`${V}/p${i}`, "crawler", { load, unscheduled: true })(`${T}/doc`); landed++; } catch (e) { held = e; }
  }
  ok((await load.landedToday(T)) === 0 && !(await load.landingSpent(`${T}/doc`, "https://other.example")), "nor the landing allowance the scheduled reads of moved origins share");
  ok(landed === 20 && held?.landingHeld, `those that land on another host are held to an allowance of their own there (${landed} sent)`);
  for (let i = 0; i < 20; i++) await load.takeBudget(`${V}/openapi.json`, "crawler", { essential: true });
  ok((await load.crawlPlan(V)).skip === "budget", "control: the scheduled crawl's own reads still spend the day");
}

// ---- a registration's Retry-After holds only its registrant --------------------------
{
  // Anyone may register any URL: the 429 or 503 its read meets says nothing
  // about the origins the scheduled crawl reads on that host.
  const { load, now, step } = fresh();
  const V = "https://rival.example", P = "https://rival.example:8443";
  const as = (who, fn) => runAsRegistrant(who, fn);
  const read = (who, url) => as(who, () => load.takeBudget(url, "crawler", { essential: true, unscheduled: true }));
  const until = await as("198.51.100.1", () => load.noteThrottle(`${P}/any/path`, 429, 86_400));
  ok(until === now() + 86_400_000, "a registration's 429 is recorded with its Retry-After");
  await load.noteThrottle(`${V}/other`, 503, 86_400, { unscheduled: true });
  ok(!(await load.throttledUntil(V)) && !(await load.throttledUntil(P)) && (await load.crawlPlan(V)).skip === null && (await load.crawlPlan(P)).skip === null,
    "a registration's 429 or 503 never holds the host's scheduled crawl");
  ok((await load.probeRefusal(`${V}/x`, "paywall")) === null && (await load.probeRefusal(`${P}/x`, "quote")) === null, "nor its unpaid probes");
  const again = await read("198.51.100.1", `${P}/any/path/.well-known/x402`);
  ok(again.ok === false && again.heldBy === "seller-retry-after" && again.retryAfterSeconds === 86_400, `it holds that registrant's own reads of that origin (${again.retryAfterSeconds} s)`);
  ok((await read("203.0.113.9", `${P}/.well-known/x402`)).ok, "another registrant's read of the origin is sent");
  ok((await read("198.51.100.1", `${V}/.well-known/x402`)).ok, "the same registrant's read of another origin on the host is sent");
  step(86_400_000 + 1000);
  ok((await read("198.51.100.1", `${P}/any/path/.well-known/x402`)).ok, "the hold expires");
  await load.noteThrottle(`${V}/z`, 429, "60");
  ok((await load.crawlPlan(V)).skip === "throttled", "control: a scheduled read's 429 still holds the host");
}

// ---- a Retry-After met through another operator's redirect holds only that operator --
{
  const { load } = fresh();
  const B = "https://landed-on.example", A = "https://redirector.example", A2 = "https://other-mover.example";
  await load.noteThrottle(`${B}/api/x`, 429, 86_400, { chargeTo: A });
  ok(!(await load.throttledUntil(B)) && (await load.crawlPlan(B)).skip === null && (await load.probeRefusal(`${B}/api/x`, "quote")) === null,
    "a 429 to a probe sent for another operator's moved origin never holds the landing host's crawl or probes");
  ok((await load.probeRefusal(`${B}/api/x`, "quote", { chargeTo: A })) === "throttled", "it holds the requesting operator's probes there");
  ok((await load.probeRefusal(`${B}/api/x`, "quote", { chargeTo: A2 })) === null, "and no other operator's");
  await load.noteThrottle("https://api.samehost.example/x", 429, 60, { chargeTo: "https://www.samehost.example" });
  ok((await load.crawlPlan("https://api.samehost.example")).skip === "throttled", "control: a move inside one operator's domain holds the host as before");
}

// ---- registrations never spend an address's scheduled day ---------------------------
{
  const { load } = fresh({ dailyBudget: 4 });
  const ip = [{ address: "203.0.113.20", family: 4 }];
  const regs = [];
  for (let i = 0; i < 6; i++) regs.push(await runAsRegistrant(`198.51.100.${i}`, () => load.takeAddressBudget(`https://r${i}.sslip.io/.well-known/x402`, ip, "crawler")));
  ok(regs.filter((b) => b.ok).length === 4 && regs[5].heldBy === "address-day", "registration reads of names on one address stop at a day of their own");
  ok((await load.takeAddressBudget("https://r9.sslip.io/x", ip, "crawler", { unscheduled: true })).ok === false, "one flagged unscheduled is counted on it too");
  const own = [];
  for (let i = 0; i < 4; i++) own.push(await load.takeAddressBudget("https://victim.sslip.io/.well-known/x402", ip, "crawler"));
  ok(own.every((b) => b.ok), "the scheduled reads of a name on that address keep their whole day");
  ok((await load.takeAddressBudget("https://victim.sslip.io/openapi.json", ip, "crawler")).ok === false, "control: the scheduled reads still stop at theirs");
}

// ---- shared hosting: each tenant has its own day ------------------------------------
{
  const { load } = fresh({ dailyBudget: 2, probeShare: 1 });
  for (const [a, b] of [
    ["https://abc123.execute-api.us-east-1.amazonaws.com", "https://def456.execute-api.us-east-1.amazonaws.com"],
    ["https://one.lambda-url.us-east-1.on.aws", "https://two.lambda-url.us-east-1.on.aws"],
    ["https://alice.github.io", "https://bob.github.io"],
    ["https://d111.cloudfront.net", "https://d222.cloudfront.net"],
    ["https://app-one.ondigitalocean.app", "https://app-two.ondigitalocean.app"],
    ["https://one--fn.modal.run", "https://two--fn.modal.run"],
  ]) {
    ok(operatorKey(a) !== operatorKey(b), `${new URL(a).hostname} and ${new URL(b).hostname} are different operators`);
    for (let i = 0; i < 3; i++) await load.takeBudget(`${a}/x`, "quote");
    ok((await load.crawlPlan(a)).skip === "budget" && (await load.crawlPlan(b)).skip === null, `one spending its day leaves the other's (${new URL(a).hostname.split(".").slice(-2).join(".")})`);
  }
  ok(operatorKey("https://api.seller.example") === operatorKey("https://www.seller.example"), "control: two hosts of one registrable domain stay one operator");
}

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
