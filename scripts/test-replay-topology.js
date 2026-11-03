#!/usr/bin/env node
// When the shared replay claim is required (src/replay-topology.js): more
// than one replica configured, inside the deploy overlap window, draining,
// or a long-running route. Otherwise one container's per-process claim is
// the guarantee and a shared-store outage does not stop sales.
import { mayHaveSiblings, sharedClaimRequired, deployOverlapMs } from "../src/replay-topology.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const t0 = 1_000_000_000_000;
const one = { RATE_LIMIT_REPLICAS: "1" };
ok(deployOverlapMs({}) === 120_000 && deployOverlapMs({ DEPLOY_OVERLAP_SECONDS: "30" }) === 30_000, "the overlap window defaults to 120 s and reads DEPLOY_OVERLAP_SECONDS");
ok(mayHaveSiblings({ env: one, startedAt: t0, now: t0 + 60_000 }) === true, "one replica, 60 s after boot (a deploy's old container may still serve): siblings possible");
ok(mayHaveSiblings({ env: one, startedAt: t0, now: t0 + 121_000 }) === false, "one replica past the window: alone");
ok(mayHaveSiblings({ env: { RATE_LIMIT_REPLICAS: "2" }, startedAt: t0, now: t0 + 3_600_000 }) === true, "two replicas configured: siblings always possible");
ok(mayHaveSiblings({ env: { STATE_DB_REPLICAS: "3", RATE_LIMIT_REPLICAS: "1" }, startedAt: t0, now: t0 + 3_600_000 }) === true, "STATE_DB_REPLICAS wins over RATE_LIMIT_REPLICAS, as for leases");
ok(mayHaveSiblings({ env: one, startedAt: t0, now: t0 + 3_600_000, draining: true }) === true, "draining (the replacement is live): siblings");
ok(sharedClaimRequired({ longRunning: true, env: one, startedAt: t0, now: t0 + 3_600_000 }) === true, "a long-running route always requires the shared claim");
ok(sharedClaimRequired({ env: one, startedAt: t0, now: t0 + 3_600_000 }) === false, "a fast route on a lone container past its window does not");
console.log(`\ntest-replay-topology: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
