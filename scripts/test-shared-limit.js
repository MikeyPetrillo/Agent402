#!/usr/bin/env node
// A cap of 1 must mean 1 across every replica.
//
//   node scripts/test-shared-limit.js
//
// WHY: rate limits lived in a per-process Map, so scaling 1 -> 2 replicas
// doubled every one of them. The RATE_LIMIT_REPLICAS divisor fixes any budget
// larger than the replica count but CANNOT fix a budget of 1: dividing 1 by 2
// floors back to 1, because zero is an outage rather than a limit. The trial's
// per-tool cap is exactly 1, so it stayed doubled — measured in production as
// the same tool granting two trials.
//
// One shared counter is the only construction that makes a cap of 1 hold. These
// assertions run against an injected store rather than a live Redis: the
// property is "two callers share one counter", and a fake proves that exactly
// while a skipped test proves nothing.
import { spend, peek, refund, windowKey, sharedLimitEnabled, __setTestClient } from "../src/shared-limit.js";
import { childJson } from "./lib/child-json.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Minimal Redis-compatible store. INCR/DECR are atomic here for the same reason
// they are in Redis: single-threaded execution.
const makeStore = () => {
  const m = new Map();
  return {
    calls: { incr: 0, expire: 0, decr: 0 },
    async incr(k) { this.calls.incr++; const n = (m.get(k) || 0) + 1; m.set(k, n); return n; },
    async decr(k) { this.calls.decr++; const n = (m.get(k) || 0) - 1; m.set(k, n); return n; },
    async get(k) { return m.has(k) ? String(m.get(k)) : null; },
    async expire(k) { this.calls.expire++; return 1; },
    async set(k, v) { m.set(k, Number(v)); return "OK"; },
    _dump: m,
  };
};

// --- THE DEFECT, and the fix ------------------------------------------------
// Two replicas, one store. A cap of 1 must yield exactly one grant TOTAL.
{
  const store = makeStore();
  __setTestClient(store);
  ok(sharedLimitEnabled(), "shared limiting reports available when a store is present");

  const replicaA = await spend("trial-tool", "ip|uuid", 1, 3600);
  const replicaB = await spend("trial-tool", "ip|uuid", 1, 3600);
  ok(replicaA.limited === false, "replica A gets the one grant");
  ok(replicaB.limited === true,
    "replica B is refused — a cap of 1 means 1 across processes, which the in-memory limiter could not express");

  // The rejected increment must be handed back, or a refused caller inflates
  // the counter and extends their own lockout.
  ok(Number(store._dump.get(windowKey("trial-tool", "ip|uuid", 3600))) === 1,
    "an over-limit attempt does not inflate the counter");
  ok(store.calls.expire === 1, "the TTL is set once on creation, not refreshed on every hit (a sliding window never resets)");
}

// --- refund gives the grant back, and cannot mint budget --------------------
{
  const store = makeStore();
  __setTestClient(store);
  await spend("trial-tool", "k", 1, 3600);
  ok((await spend("trial-tool", "k", 1, 3600)).limited, "budget spent");
  await refund("trial-tool", "k", 3600);
  ok((await spend("trial-tool", "k", 1, 3600)).limited === false, "after a refund the grant is available again");

  await refund("trial-tool", "never-charged", 3600);
  const key = windowKey("trial-tool", "never-charged", 3600);
  ok(Number(store._dump.get(key)) === 0,
    "refunding an uncharged key floors at zero rather than minting negative budget");
}

// --- FAIL CLOSED ------------------------------------------------------------
// Granting when we cannot count turns a Redis outage into unmetered free
// access. A buyer paying is a worse experience; unbounded free calls are a
// worse failure.
{
  __setTestClient({
    async incr() { throw new Error("redis down"); },
    async decr() { throw new Error("redis down"); },
    async get() { throw new Error("redis down"); },
    async expire() { throw new Error("redis down"); },
    async set() { throw new Error("redis down"); },
  });
  const s = await spend("trial-tool", "k", 1, 3600);
  ok(s.limited === true && s.degraded === true, "a failing store reports LIMITED, not granted — fail closed");
  const p = await peek("trial-tool", "k", 1, 3600);
  ok(p.limited === true && p.degraded === true, "peek fails closed too");
  // A refund against a dead store must not throw into the request path.
  let threw = false;
  try { await refund("trial-tool", "k", 3600); } catch { threw = true; }
  ok(!threw, "a refund against a dead store never throws into the response path");
}

// --- An UNREACHABLE store must still take the shared path -------------------
//
// The fail-closed guarantee at the top of src/shared-limit.js was defeated by
// the branch that CHOSE it. sharedLimitEnabled() returned false once a connect
// failed, and the caller's `else` is the per-process limiter — which GRANTS. So
// a replica that could not reach Redis stopped refusing and began handing out
// its own private allowance: fail-OPEN, reached by a route the fail-closed code
// could not see. Observed in production as one tool granting two trials in a
// row while the logs showed connection timeouts.
//
// REDIS_URL is read at module load, so this runs in a child process with an
// unreachable address — the only way to observe the real boot-time behaviour.
{
  const { execFileSync } = await import("node:child_process");
  const probe = `
    import { sharedLimitEnabled, spend, connectionState } from "${new URL("../src/shared-limit.js", import.meta.url).pathname}";
    // Order matters, and it is the order production actually sees: the FIRST
    // request finds the flag clear, its spend fails and marks the store
    // unavailable, and the SECOND request is the one that used to be told
    // "not shared" and sent down the granting per-process branch. Checking
    // enabled before any connect attempt observes nothing.
    const t0 = Date.now();
    const first = await spend("trial-tool", "k", 1, 3600);
    const waitedMs = Date.now() - t0;
    const enabled = sharedLimitEnabled();
    const second = await spend("trial-tool", "k", 1, 3600);
    // The request path refuses on a short deadline while the connect keeps
    // running in the background, so the OUTCOME is recorded a moment later.
    // Poll for it rather than reading too early and asserting a null.
    for (let i = 0; i < 100 && connectionState().connected === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(JSON.stringify({ enabled, limited: second.limited, degraded: second.degraded, first: first.limited, waitedMs, st: connectionState() }));
  `;
  let out = {};
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      env: { ...process.env, REDIS_URL: "redis://127.0.0.1:6390" }, // nothing listening
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
    out = childJson(raw);
  } catch (e) { console.error("probe failed:", e.message); }

  ok(out.enabled === true,
    "a CONFIGURED but unreachable store still reports the shared path — never silently downgrades to the per-process limiter that grants");
  ok(out.limited === true, "...and the call is REFUSED rather than granted (fail closed holds end to end)");
  ok(out.degraded === true, "...and the refusal is marked degraded so it is attributable, not silent");
  ok(out.st?.connected === false, "connectionState reports the store was NOT reached, separately from being configured");
  // The request must not inherit the connect budget. connectTimeout is 10s so a
  // slow IPv6 private network is not mistaken for an outage, but a buyer on the
  // trial gate must never wait that long for an answer that is "refused"
  // regardless. node-redis also backs off ~3s across its reconnect attempts,
  // which is exactly the wait this deadline exists to cap.
  ok(typeof out.waitedMs === "number" && out.waitedMs < 2500,
    `a refused call returns on a SHORT deadline, not the connect timeout (waited ${out.waitedMs}ms)`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
