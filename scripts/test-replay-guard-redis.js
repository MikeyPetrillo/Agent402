#!/usr/bin/env node
// Exercise the REAL Redis-backed replay guard against a REAL redis server.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-replay-guard-redis.js
//
// WHY THIS EXISTS (2026-08-16). test-replay-guard.js proves the guard's STATE
// MACHINE (concurrent/sequential replay refused, release-on-failure, TTL,
// eviction) entirely against the per-process fallback - it never sets
// REDIS_URL, so it can never prove the property the Redis backing exists for:
// that TWO SEPARATE createReplayGuard() instances (standing in for two app
// replicas) sharing one Redis actually behave like ONE shared guard. A stub
// client would only prove "the code calls set/get/del", the same shallow
// coverage this repo has been burned by before (see test-redis-integration.js's
// own header) - this drives the real client against a real server instead.
//
// Deliberately does not skip when REDIS_URL is unset: a skipped integration
// test is how the cross-replica gap this guard now closes went uncaught for
// as long as it did.
if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis (CI provides a service container).");
  console.error("      It deliberately does not skip - see the header comment.");
  process.exit(1);
}

const { createReplayGuard, paymentReplayKey } = await import("../src/replay-guard.js");
const { getSharedRedisClient, __setTestClient } = await import("../src/shared-limit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const client = await getSharedRedisClient();
if (!client) { console.error("FAIL: could not reach redis at", process.env.REDIS_URL); process.exit(1); }

// Unique key prefix per run so repeated local runs never collide with leftover state.
const runId = `t${Date.now()}${Math.floor(Math.random() * 1e6) || 1}`;
const key = (suffix) => `replay-guard-redis-test:${runId}:${suffix}`;

// --- 1. Two independent guard instances = two "replicas" -------------------
// Neither instance's local Map/Set is shared - if the guard were still
// per-process, guardB would see nothing guardA claimed. It must, because
// both share the SAME Redis connection under the hood.
{
  const guardA = createReplayGuard();
  const guardB = createReplayGuard();
  const k = key("cross-replica");

  const first = await guardA.begin(k);
  ok(first === "ok", `replica A claims a fresh nonce (got "${first}")`);

  const second = await guardB.begin(k);
  ok(second === "inflight", `replica B sees it as in-flight, NOT "ok" (got "${second}") — proves cross-replica sharing`);

  await guardA.settle(k);
  const third = await guardB.begin(k);
  ok(third === "consumed", `after A settles, B sees it as consumed (got "${third}") — settlement is visible cross-replica`);
}

// --- 2. Release is also cross-replica visible -------------------------------
{
  const guardA = createReplayGuard();
  const guardB = createReplayGuard();
  const k = key("cross-release");

  await guardA.begin(k);
  await guardA.release(k); // e.g. facilitator rejected settlement
  const retried = await guardB.begin(k);
  ok(retried === "ok", `after A releases, B can claim the SAME nonce fresh (got "${retried}") — release-on-failure works cross-replica`);
}

// --- 3. The in-flight claim carries a real TTL (self-heals a crashed replica) ---
{
  const k = key("ttl-check");
  const guard = createReplayGuard();
  await guard.begin(k);
  const ttl = await client.ttl(`replay:f:${k}`);
  ok(ttl > 0 && ttl <= 120, `the in-flight Redis key carries a bounded TTL (got ${ttl}s, expect 0 < ttl <= 120)`);
  await guard.release(k);
}

// --- 4. The consumed marker's TTL matches the guard's configured ttlMs -------
{
  const k = key("consumed-ttl");
  const guard = createReplayGuard({ ttlMs: 5000 }); // 5s
  await guard.begin(k);
  await guard.settle(k);
  const ttl = await client.ttl(`replay:c:${k}`);
  ok(ttl > 0 && ttl <= 5, `the consumed Redis key's TTL matches ttlMs (got ${ttl}s, expect 0 < ttl <= 5)`);
}

// --- 5. Full paymentReplayKey() -> guard round trip, matching server.js's
// real usage shape (not a synthetic string key). ----------------------------
{
  const guardA = createReplayGuard();
  const guardB = createReplayGuard();
  const fakeReq = (cred) => ({ header: (n) => (String(n).toLowerCase() === "x-payment" ? cred : undefined) });
  const cred = Buffer.from(JSON.stringify({
    network: "eip155:8453",
    payload: { authorization: { nonce: `0x${runId}`, from: "0x" + "1".repeat(40) } },
  })).toString("base64");
  const rk = paymentReplayKey(fakeReq(cred));
  ok(typeof rk === "string" && rk.startsWith("n:"), "paymentReplayKey() extracts a real nonce-scoped key from an x402 credential");

  ok(await guardA.begin(rk) === "ok", "real payment-credential key: replica A claims it");
  ok(await guardB.begin(rk) === "inflight", "real payment-credential key: replica B sees inflight");
  await guardA.settle(rk);
}

// --- 5b. A call that runs past the claim's TTL keeps its claim ---------------
// The claim is renewed while the call is open, so a handler that outlives the
// in-flight TTL cannot be run a second time on the same signed payment from
// another replica; settle/release stop the renewal, and a holder that never
// finishes stops renewing after maxHoldMs so its claim lapses.
{
  const opts = { inflightTtlSeconds: 1, renewMs: 300 };
  const guardA = createReplayGuard(opts);
  const guardB = createReplayGuard(opts);
  const k = key("long-handler");
  ok(await guardA.begin(k) === "ok", "long handler: replica A claims the nonce");
  await new Promise((r) => setTimeout(r, 2_600)); // the handler runs past the 1 s TTL
  const during = await guardB.begin(k);
  ok(during === "inflight", `long handler: replica B still sees inflight past the claim's TTL while A runs (got "${during}")`);
  ok(guardA._state().renewing === 1, "long handler: A renews its claim while the call is open");
  await guardA.release(k);
  ok(guardA._state().renewing === 0, "long handler: release stops the renewal");
  ok(await guardB.begin(k) === "ok", "long handler: after A releases, B may claim the still-valid authorization");
  await guardB.settle(k);
  ok(guardB._state().renewing === 0, "long handler: settle stops the renewal");

  const guardC = createReplayGuard({ ...opts, maxHoldMs: 600 });
  const k2 = key("abandoned-holder");
  await guardC.begin(k2);
  await new Promise((r) => setTimeout(r, 2_600)); // renewal stops at 600 ms, the 1 s TTL then lapses
  const lapsed = await guardB.begin(k2);
  ok(lapsed === "ok", `a holder that never settles or releases stops renewing and its claim lapses (got "${lapsed}")`);
  ok(guardC._state().renewing === 0, "the abandoned holder's renewal timer is gone");
  await guardB.release(k2);
}

// --- 6. Fails OPEN to local state when Redis throws (not closed, not a crash) --
// A rejected paid call over an optimization layer going dark would be the
// wrong direction for THIS guard (see the fail-open rationale in
// replay-guard.js's header) - the real chain-level nonce protection holds
// regardless. Injects a broken client via shared-limit.js's own test seam
// (the same one test-shared-limit.js uses) so this doesn't need a second,
// duplicate connection-mocking mechanism.
{
  const broken = {
    get: async () => { throw new Error("simulated redis outage"); },
    set: async () => { throw new Error("simulated redis outage"); },
    del: async () => { throw new Error("simulated redis outage"); },
  };
  __setTestClient(broken);
  try {
    const g = createReplayGuard();
    const k = "outage-test";
    const r1 = await g.begin(k);
    ok(r1 === "ok", `begin() during a redis outage still resolves (not a throw/hang) — falls back to local state (got "${r1}")`);
    const r2 = await g.begin(k);
    ok(r2 === "inflight", `local-state fallback still enforces the concurrent-replay rule during the outage (got "${r2}")`);
    await g.settle(k);
    const r3 = await g.begin(k);
    ok(r3 === "consumed", `local-state fallback still enforces sequential-replay after settle during the outage (got "${r3}")`);
  } finally {
    __setTestClient(null); // restore the real client for anything after this
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
