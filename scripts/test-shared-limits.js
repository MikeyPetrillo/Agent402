#!/usr/bin/env node
// The shared counter primitive (src/shared-limits.js) on both backends.
//
//   node scripts/test-shared-limits.js                              (memory half only; says so)
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-shared-limits.js   (both halves)
//
// The memory backend is what every control uses when no Redis is configured,
// so it is tested on every run. The Redis backend is the thing the two-replica
// deployment rests on, so it is tested against a REAL server (CI's service
// container): two independent instances of the Redis backend stand in for two
// replicas and must read one count. Under CI a missing REDIS_URL FAILS (a
// skipped integration test is not coverage); locally it is reported as skipped
// in so many words.
import { createMemoryLimits, createRedisLimits, createSharedDailySpend, sharedLimitsConfigured, SHARED_LIMITS_WORDS } from "../src/shared-limits.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const RUN = `t${process.pid}${Date.now().toString(36)}`;

/** The contract both backends keep. `make()` yields a fresh backend instance. */
async function contract(label, make) {
  const T0 = 1_000_000_000_000; // a fixed clock: the window is about the scores, not the wall
  const a = make(), b = make();
  // --- windows: count, sum, pruning -----------------------------------------
  {
    const name = `${RUN}-win`, key = "k1";
    let r = await a.windowAdd(name, key, { windowMs: 10_000, member: "m1", weight: 3, now: T0 });
    ok(r.ok && r.count === 1 && r.sum === 3, `${label}: the first add answers count 1, sum 3 (${JSON.stringify({ count: r.count, sum: r.sum })})`);
    r = await b.windowAdd(name, key, { windowMs: 10_000, member: "m2", weight: 5, now: T0 + 1_000 });
    ok(r.ok && r.count === 2 && r.sum === 8, `${label}: a second instance adding sees both entries (count ${r.count}, sum ${r.sum})`);
    r = await a.windowRead(name, key, { windowMs: 10_000, now: T0 + 2_000 });
    ok(r.ok && r.count === 2 && r.sum === 8 && Array.isArray(r.entries) && r.entries.length === 2, `${label}: a read answers the same count and sum with the entries`);
    ok(r.entries.every((e) => typeof e.score === "number" && typeof e.weight === "number" && typeof e.member === "string") && r.entries.map((e) => e.member).sort().join() === "m1,m2", `${label}: entries carry score, weight and member (${JSON.stringify(r.entries)})`);
    // T0 + 10_000: m1 (score T0) is exactly a window old and ages out; m2 stays.
    r = await b.windowRead(name, key, { windowMs: 10_000, now: T0 + 10_000 });
    ok(r.ok && r.count === 1 && r.sum === 5, `${label}: an entry exactly a window old has aged out (count ${r.count}, sum ${r.sum})`);
    // Distinct members: re-adding m2 keeps one entry and refreshes its time.
    r = await a.windowAdd(name, key, { windowMs: 10_000, member: "m2", weight: 5, now: T0 + 11_000 });
    ok(r.ok && r.count === 1 && r.sum === 5 && r.entries?.[0]?.score === T0 + 11_000, `${label}: re-adding a member keeps one entry at the new time (distinct counting)`);
    await a.windowRemove(name, key, { member: "m2", weight: 5 });
    r = await b.windowRead(name, key, { windowMs: 10_000, now: T0 + 11_000 });
    ok(r.ok && r.count === 0 && r.sum === 0, `${label}: a removed entry is gone for the other instance too`);
    await a.windowAdd(name, key, { windowMs: 10_000, member: "x", now: T0 + 11_000 });
    await a.windowClear(name, key);
    r = await b.windowRead(name, key, { windowMs: 10_000, now: T0 + 11_000 });
    ok(r.ok && r.count === 0, `${label}: clear empties the window`);
    // Negative weights (a lowered figure) sum arithmetically.
    await a.windowAdd(name, "k2", { windowMs: 10_000, member: "p", weight: 7, now: T0 });
    r = await a.windowAdd(name, "k2", { windowMs: 10_000, member: "q", weight: -2, now: T0 });
    ok(r.ok && r.sum === 5, `${label}: weights sum arithmetically (${r.sum})`);
    // A score may be set apart from now (replacing an entry at its original time).
    r = await a.windowAdd(name, "k3", { windowMs: 10_000, member: "old", weight: 1, now: T0 + 9_000, score: T0 });
    ok(r.ok && r.entries?.[0]?.score === T0, `${label}: an explicit score is kept`);
    r = await a.windowRead(name, "k3", { windowMs: 10_000, now: T0 + 10_000 });
    ok(r.ok && r.count === 0, `${label}: and ages out by that score`);
  }
  // --- readMany: several windows in one call, each with its own window -------
  {
    const name = `${RUN}-many`;
    await a.windowAdd(name, "g", { windowMs: 60_000, member: "1", weight: 10, now: T0 });
    await a.windowAdd(name, "h", { windowMs: 5_000, member: "1", weight: 20, now: T0 });
    const r = await b.windowReadMany([{ name, key: "g", windowMs: 60_000 }, { name, key: "h", windowMs: 5_000 }, { name, key: "none", windowMs: 5_000 }], { now: T0 + 6_000 });
    ok(r.ok && r.results.length === 3, `${label}: readMany answers one result per item`);
    ok(r.results[0].sum === 10 && r.results[1].sum === 0 && r.results[2].count === 0, `${label}: each item is pruned to its own window (${r.results.map((x) => x.sum).join(",")})`);
    const empty = await a.windowReadMany([], { now: T0 });
    ok(empty.ok && empty.results.length === 0, `${label}: readMany of nothing is ok and empty`);
  }
  // --- flags ------------------------------------------------------------------
  {
    const name = `${RUN}-flag`;
    let r = await a.flagGet(name, "p", { now: T0 });
    ok(r.ok && r.until === 0, `${label}: an unset flag reads 0`);
    await a.flagSet(name, "p", T0 + 30_000, { now: T0 });
    r = await b.flagGet(name, "p", { now: T0 + 1_000 });
    ok(r.ok && r.until === T0 + 30_000, `${label}: a set flag reads its until on the other instance (${r.until})`);
    r = await b.flagGet(name, "p", { now: T0 + 30_000 });
    ok(r.ok && r.until === 0, `${label}: a flag whose time has come reads 0`);
    await a.flagSet(name, "p", T0 + 30_000, { now: T0 });
    await a.flagSet(name, "p", 0, { now: T0 });
    r = await b.flagGet(name, "p", { now: T0 });
    ok(r.ok && r.until === 0, `${label}: setting a flag to a past time clears it`);
  }
  // --- counters -----------------------------------------------------------------
  {
    const name = `${RUN}-ctr`;
    let r = await a.counterAdd(name, "day", 250, 60_000, { now: T0 });
    ok(r.ok && r.value === 250, `${label}: a counter add answers the new value (${r.value})`);
    r = await b.counterAdd(name, "day", 100, 60_000, { now: T0 });
    ok(r.ok && r.value === 350, `${label}: the other instance adds to the same value (${r.value})`);
    r = await b.counterAdd(name, "day", -50, 60_000, { now: T0 });
    ok(r.ok && r.value === 300, `${label}: a negative delta releases (${r.value})`);
    r = await a.counterGet(name, "day", { now: T0 });
    ok(r.ok && r.value === 300, `${label}: a get reads it (${r.value})`);
    r = await a.counterGet(name, "other", { now: T0 });
    ok(r.ok && r.value === 0, `${label}: an unknown counter reads 0`);
    await a.counterClear(name, "day");
    r = await b.counterGet(name, "day", { now: T0 });
    ok(r.ok && r.value === 0, `${label}: a cleared counter reads 0 for the other instance`);
  }
}

// ---- the memory backend (every run) ------------------------------------------------
{
  // One store, two handles: the memory backend is one process's state, and
  // the contract is about what two callers of that state read.
  const store = createMemoryLimits();
  await contract("memory", () => store);
}
{
  // Two memory instances are two processes: they do NOT share. That is the
  // property the Redis half exists to change.
  const m1 = createMemoryLimits(), m2 = createMemoryLimits();
  await m1.windowAdd(`${RUN}-sep`, "k", { windowMs: 10_000, member: "a", now: 1 });
  const r = await m2.windowRead(`${RUN}-sep`, "k", { windowMs: 10_000, now: 1 });
  ok(r.ok && r.count === 0, "memory: two instances are two processes and share nothing (the one-replica baseline)");
  // The memory counter expires with its ttl.
  await m1.counterAdd(`${RUN}-ttl`, "x", 5, 1_000, { now: 1_000 });
  const live = await m1.counterGet(`${RUN}-ttl`, "x", { now: 1_500 });
  const gone = await m1.counterGet(`${RUN}-ttl`, "x", { now: 2_000 });
  ok(live.value === 5 && gone.value === 0, "memory: a counter expires at its ttl");
}
{
  // The daily spend helper on the process's own backend (memory here unless
  // REDIS_URL is set; with it, this runs on Redis too).
  const d = createSharedDailySpend(`${RUN}-daily`, "test-daily");
  if (!sharedLimitsConfigured()) {
    ok((await d.reserve(0.5, 1)) === true && (await d.today()) === null, "daily spend helper: without a shared store, reserve answers true and today reads null (the kit's own counter decides)");
  } else {
    const now = Date.UTC(2030, 0, 1, 12);
    ok((await d.reserve(0.6, 1, now)) === true, "daily spend helper: a reserve inside the cap is taken");
    ok((await d.reserve(0.6, 1, now)) === false, "daily spend helper: a reserve that would pass the cap is refused");
    ok(Math.abs((await d.today(now)) - 0.6) < 1e-9, `daily spend helper: and given back (today ${await d.today(now)})`);
    d.book(-0.1, now);
    await d.today(now); // the barrier: a later read on one connection lands after the earlier write
    ok(Math.abs((await d.today(now)) - 0.5) < 1e-9, `daily spend helper: a signed correction lands (today ${await d.today(now)})`);
    ok((await d.today(now + 86_400_000)) === 0, "daily spend helper: the next day starts at zero");
  }
}
{
  // A cap counted in whole units (the judge's tokens) passes scale 1.
  const t = createSharedDailySpend(`${RUN}-tokens`, "test-tokens", { scale: 1 });
  if (!sharedLimitsConfigured()) {
    ok((await t.reserve(600, 1000)) === true && (await t.today()) === null, "daily spend helper, scale 1: without a shared store reserve answers true and today reads null");
  } else {
    const now = Date.UTC(2030, 0, 2, 12);
    ok((await t.reserve(600, 1000, now)) === true && (await t.reserve(600, 1000, now)) === false, "daily spend helper, scale 1: 600 of a 1000-token day is taken, a second 600 is refused");
    ok((await t.today(now)) === 600, `daily spend helper, scale 1: today reads the whole units as given (${await t.today(now)})`);
  }
}
ok(SHARED_LIMITS_WORDS.join() === "on,memory,degraded", "the status words are on, memory, degraded");

// ---- the Redis backend (a real server) ---------------------------------------------------
if (!process.env.REDIS_URL) {
  if (process.env.CI) {
    console.error("FAIL - REDIS_URL is not set under CI: this test needs the real redis service container (a skipped integration test is not coverage)");
    fail++;
  } else {
    console.log("SKIPPED - the Redis half: REDIS_URL is not set (start a local redis and set REDIS_URL to run it; CI runs it against its service container)");
  }
} else {
  const { getSharedRedisClient, connectionState } = await import("../src/shared-limit.js");
  const client = await getSharedRedisClient();
  if (!client) { console.error("FAIL - could not reach redis at REDIS_URL"); fail++; }
  else {
    // Two instances of the Redis backend over one server: two replicas.
    await contract("redis", () => createRedisLimits(getSharedRedisClient));
    ok(connectionState().connected === true, "redis: the shared client reports a live connection (the contract ran against the server, not a fallback)");
    // Keys expire with their window / ttl on the server side (so leftover
    // state never outlives the window it bounds).
    const r1 = createRedisLimits(getSharedRedisClient);
    await r1.windowAdd(`${RUN}-exp`, "k", { windowMs: 1_500, member: "a", now: Date.now() });
    await r1.counterAdd(`${RUN}-exp-c`, "k", 1, 1_500);
    await r1.flagSet(`${RUN}-exp-f`, "k", Date.now() + 1_500, { now: Date.now() });
    const { keyOf } = await import("../src/shared-limits.js");
    const ttls = await Promise.all([client.pTTL(keyOf(`${RUN}-exp`, "k")), client.pTTL(keyOf(`${RUN}-exp-c`, "k")), client.pTTL(keyOf(`${RUN}-exp-f`, "k"))]);
    ok(ttls.every((t) => t > 0 && t <= 1_500), `redis: every key carries a server-side expiry no longer than its window (${ttls.join(",")} ms)`);
    // A counter's expiry is set once, never refreshed by later adds.
    await new Promise((r) => setTimeout(r, 300));
    await r1.counterAdd(`${RUN}-exp-c`, "k", 1, 1_500);
    const again = await client.pTTL(keyOf(`${RUN}-exp-c`, "k"));
    ok(again > 0 && again <= 1_250, `redis: a later add does not extend a counter's window (${again} ms left of 1500)`);

    // --- the degraded path: a backend whose client is gone answers ok:false, never throws ---
    const results = [];
    const down = createRedisLimits(async () => null, { onResult: (r) => results.push(r) });
    const d1 = await down.windowAdd("x", "y", { windowMs: 1_000, member: "m", now: 1 });
    const d2 = await down.flagGet("x", "y");
    const d3 = await down.counterAdd("x", "y", 1, 1_000);
    ok(d1.ok === false && d2.ok === false && d3.ok === false && results.length === 3, "redis: with no client every call answers ok:false (the control decides on its own counters) and each result is reported");
    const slow = createRedisLimits(async () => ({ eval: () => new Promise(() => {}), get: () => new Promise(() => {}) }), { opTimeoutMs: 100 });
    const t0 = Date.now();
    const d4 = await slow.flagGet("x", "y");
    ok(d4.ok === false && /timed out/.test(d4.error) && Date.now() - t0 < 1_000, `redis: a command that never answers fails at the op timeout (${Date.now() - t0} ms, ${d4.error})`);
    const throwing = createRedisLimits(async () => { throw new Error("boom"); });
    const d5 = await throwing.counterGet("x", "y");
    ok(d5.ok === false, "redis: a client getter that throws is a miss, not an exception");

    // --- the process's word, measured -----------------------------------------------
    const SL = await import("../src/shared-limits.js");
    SL._resetSharedLimitsState();
    ok(SL.sharedLimitsMode() === "redis" && SL.sharedLimitsStatus().status === "on", `the process's word reads on with a reachable Redis (${SL.sharedLimitsStatus().status})`);
    ok(Object.keys(SL.sharedLimitsStatus()).join() === "status", "the public status is the word alone");
    const full = SL.sharedLimitsStatus({ full: true });
    ok(full.mode === "redis" && typeof full.ops === "number" && typeof full.failures === "number", "the operator view carries the mode and the counts");
    // The word is computed from recorded results: a failure inside the hold reads degraded.
    const before = SL._sharedLimitsState();
    await SL.shared.flagGet(`${RUN}-word`, "k");
    ok(SL._sharedLimitsState().ops === before.ops + 1 && SL.sharedLimitsStatus().status === "on", "a successful command keeps the word on");
    const probe = await SL.probeSharedLimits();
    ok(probe.ok === true, "the boot probe reads the store");
    // Clean up this run's keys.
    const keys = await client.keys(`sl:*${RUN}*`);
    if (keys.length) await client.del(keys);
  }
}

console.log(`\ntest-shared-limits: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
