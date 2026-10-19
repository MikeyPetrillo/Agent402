// Hard daily ceilings shared across replicas over a REAL Redis
// (src/upstream-hard-caps.js on src/shared-limits.js).
//
// Two module instances (imported with distinct query strings, so each has its
// own per-process counts) stand in for two containers on one Redis. Container
// A spends a host's whole ceiling and syncs; container B, which made no call
// of its own, refuses once its sync reads the shared total at the ceiling.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-upstream-hard-caps-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import { randomBytes } from "node:crypto";

if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-upstream-hard-caps-redis: no REDIS_URL; start a local redis and export REDIS_URL=redis://127.0.0.1:6379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
// A prefix of its own per run, so reruns and parallel lanes never share a count.
process.env.SHARED_LIMITS_PREFIX = `hardcap-test-${randomBytes(5).toString("hex")}`;
process.env.HARDCAP_BRAVE_CALLS = "5";

const { sharedLimitsMode } = await import("../src/shared-limits.js");
const A = await import("../src/upstream-hard-caps.js?container=a");
const B = await import("../src/upstream-hard-caps.js?container=b");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const T0 = Date.parse("2026-10-19T12:00:00Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ok(sharedLimitsMode() === "redis", `the shared store is Redis (${sharedLimitsMode()})`);
ok(A !== B && A.hardCapStatus !== B.hardCapStatus, "two separate module instances (two containers)");
{
  const used = [1, 2, 3, 4, 5].map(() => A.takeHardCap("brave", T0));
  ok(used.every(Boolean), "container A spends the whole ceiling under its own count");
  ok(A.takeHardCap("brave", T0) === false, "container A refuses its next call from its own count");
  // The live control: before any sync, B has no evidence and would let a call
  // through, so a refusal below can only come from the shared total.
  const before = B.hardCapStatus(T0).upstreams.brave;
  ok(before.usedToday === 0 && before.status === "ok" && before.shared === true, `before syncing, container B sees no calls (usedToday ${before.usedToday}, shared ${before.shared})`);

  await A.syncHardCaps(T0);
  // A's flush is fire and forget; B's sync reads the shared total once it lands.
  let seen = 0;
  for (let i = 0; i < 100 && seen < 5; i++) {
    await B.syncHardCaps(T0);
    seen = B.hardCapStatus(T0).upstreams.brave.usedToday;
    if (seen < 5) await sleep(20);
  }
  ok(seen === 5, `container B reads the day's shared total after syncing (usedToday ${seen})`);
  ok(B.takeHardCap("brave", T0) === false, "container B refuses its first call once the shared total reached the ceiling");
  const after = B.hardCapStatus(T0);
  ok(after.upstreams.brave.status === "capped" && after.upstreams.brave.refusedToday === 1, "container B reads capped and counts its refusal");
  ok(B.hardCapRefusalForHost("api.search.brave.com", T0)?.hardCap === true, "the fetch hook on container B refuses the host too");
  ok(B.hardCapRefusalForHost("api.search.brave.com", T0 + 86_400_000) === null, "a new UTC day starts from zero on container B");
}

console.log(`\ntest-upstream-hard-caps-redis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
