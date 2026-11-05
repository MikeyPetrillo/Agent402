#!/usr/bin/env node
// Rate limits are per-PROCESS, so replicas multiply them.
//
//   node scripts/test-limiter-replicas.js
//
// WHY: buckets live in a Map inside one process. Scaling the service from 1 to
// 2 replicas silently doubled EVERY limit built on createLimiter — the trial
// caps, the proof-of-work tier, the MCP free tier, and the operator
// credential-guessing bound, which is a security control. It was caught only by
// probing production and seeing a per-tool trial granted twice.
//
// No single-process test could have found it, which is the point: the defect
// lives in the gap between how we test (one process) and how we run (several).
//
// RATE_LIMIT_REPLICAS divides each budget so the SYSTEM-WIDE total matches the
// configured intent. It is deliberately the conservative approximation — a
// client pinned to one replica gets its share, never the whole budget — because
// for a security bound, too tight is the right direction to be wrong in.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createLimiter, perReplica } from "../src/rate-limit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const grants = (l, key, n) => { let g = 0; for (let i = 0; i < n; i++) if (!l.check(key).limited) g++; return g; };

// --- the division itself ----------------------------------------------------
ok(perReplica(10) === (process.env.RATE_LIMIT_REPLICAS ? Math.max(1, Math.floor(10 / Number(process.env.RATE_LIMIT_REPLICAS))) : 10),
  "perReplica divides by the configured replica count");
ok(perReplica(1) >= 1, "a budget never divides below 1 — a limiter that blocks everything is not a limit, it is an outage");
ok(perReplica(0) >= 1, "and a zero budget is floored to 1 rather than locking the surface out");

// --- the multiplication this exists to cancel -------------------------------
// Two independent limiters are two processes: each holds its own bucket, so a
// client round-robined across them gets the sum. That IS the production bug.
{
  const replicaA = createLimiter("t", { perMin: 10, perHour: 10 });
  const replicaB = createLimiter("t", { perMin: 10, perHour: 10 });
  const total = grants(replicaA, "ip", 10) + grants(replicaB, "ip", 10);
  const single = grants(createLimiter("t", { perMin: 10, perHour: 10 }), "ip", 20);
  ok(total > single,
    `two processes grant more than one for the same configured budget (${total} vs ${single}) — the defect, reproduced`);
}

// --- refund, which the trial needs ------------------------------------------
{
  const l = createLimiter("t", { perMin: 1, perHour: 1 });
  ok(!l.check("ip").limited, "first grant");
  ok(l.check("ip").limited, "second is blocked");
  l.refund("ip");
  ok(!l.check("ip").limited, "after a refund the budget is available again");
  // A refund with nothing charged must not create budget from nothing.
  const l2 = createLimiter("t", { perMin: 1, perHour: 1 });
  l2.refund("never-charged");
  ok(!l2.check("never-charged").limited && l2.check("never-charged").limited,
    "refunding an uncharged key does not mint extra budget");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
