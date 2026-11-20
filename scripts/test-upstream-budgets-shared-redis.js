// The upstream call budgets read the UTC day's count across deploys and
// replicas over a REAL Redis (src/upstream-budgets.js on src/shared-limits.js).
//
// Two module instances (imported with distinct query strings, so each has its
// own shared-day state) stand in for the container before a deploy and the
// one after it. Each is handed its own process count, as the egress meter
// would give it: the count a restart resets.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-upstream-budgets-shared-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { randomBytes } from "node:crypto";

if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-upstream-budgets-shared-redis: no REDIS_URL; start a local redis and export REDIS_URL=redis://127.0.0.1:6379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
// A prefix of its own per run, so reruns and parallel lanes never share a count.
process.env.SHARED_LIMITS_PREFIX = `upbudget-test-${randomBytes(5).toString("hex")}`;
process.env.BUDGET_NEYNAR_CALLS = "100";
process.env.BUDGET_ALCHEMY_CALLS = "100";
process.env.HARDCAP_ALCHEMY_CALLS = "100000";

const { sharedLimitsMode } = await import("../src/shared-limits.js");
const A = await import("../src/upstream-budgets.js?container=before-deploy");
const B = await import("../src/upstream-budgets.js?container=after-deploy");
const caps = await import("../src/upstream-hard-caps.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rep = (host, calls) => ({ day: new Date(T0).toISOString().slice(0, 10), hosts: [{ host, calls }] });
const row = (M, r, name) => M.upstreamBudgetStatus(r, T0).upstreams[name];
// A's flush is fire and forget; a later sync reads the total once it lands.
async function syncUntil(M, r, name, want) {
  let seen = 0;
  for (let i = 0; i < 100; i++) {
    await M.syncUpstreamBudgets(T0, r);
    seen = row(M, r, name).callsToday;
    if (seen >= want) break;
    await sleep(20);
  }
  return seen;
}

ok(sharedLimitsMode() === "redis", `the shared store is Redis (${sharedLimitsMode()})`);
ok(A !== B && A.upstreamBudgetStatus !== B.upstreamBudgetStatus, "two separate module instances (the container before a deploy and the one after)");

// ---- a budget with no hard ceiling: its own shared counter ------------------
{
  const before = rep("api.neynar.com", 60);
  ok(row(A, before, "neynar").callsToday === 60 && row(A, before, "neynar").status === "ok" && row(A, before, "neynar").shared === false, "before any sync a process reads its own count, marked not shared");
  const seenA = await syncUntil(A, before, "neynar", 60);
  ok(seenA === 60 && row(A, before, "neynar").shared === true, `the container before the deploy books its 60 calls to the shared day (${seenA})`);

  // The deploy: a new process, its own count starts at zero and grows to 50.
  const after = rep("api.neynar.com", 50);
  const own = row(B, after, "neynar");
  ok(own.callsToday === 50 && own.status === "ok", `control: before its first sync the new container sees only its own 50 calls and reads ${own.status}`);
  const seenB = await syncUntil(B, after, "neynar", 110);
  const r = row(B, after, "neynar");
  ok(seenB === 110 && r.status === "elevated" && r.processCallsToday === 50 && r.shared === true, `after syncing it reads the day across the deploy: ${seenB} calls, ${r.status} (its own count stays ${r.processCallsToday})`);
  ok(B.upstreamBudgetStatus(after, T0).status === "elevated" && B.upstreamBudgetStatus(after, T0).sinceRestart === false, "the word the alarm reads is elevated, and the status no longer says since restart");
  // A second sync with no new call books nothing twice.
  await B.syncUpstreamBudgets(T0, after); await sleep(50); await B.syncUpstreamBudgets(T0, after);
  ok(row(B, after, "neynar").callsToday === 110, `a sync with no new call adds nothing (${row(B, after, "neynar").callsToday})`);
  // Calls made between syncs count at once, on top of the last shared read.
  ok(row(B, rep("api.neynar.com", 57), "neynar").callsToday === 117, "calls since the last sync are added to the shared total without waiting for the next one");
  // A new UTC day starts from zero.
  const tomorrow = T0 + 86_400_000;
  ok(B.upstreamBudgetStatus({ day: "next", hosts: [] }, tomorrow).upstreams.neynar.callsToday === 0, "a new UTC day starts from zero");
}

// ---- a budget whose host has a hard ceiling: the ceiling's shared day ------
{
  for (let i = 0; i < 120; i++) caps.takeHardCap("alchemy", T0);
  await caps.syncHardCaps(T0);
  // The new container made 7 calls of its own; the day holds 120.
  const mine = rep("solana-mainnet.g.alchemy.com", 7);
  const r = row(B, mine, "alchemy");
  ok(r.callsToday === 120 && r.status === "elevated" && r.processCallsToday === 7 && r.shared === true, `the keyed provider's budget reads the ceiling's shared day (${r.callsToday} calls, ${r.status}; own ${r.processCallsToday})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
