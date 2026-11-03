#!/usr/bin/env node
// When the shared replay claim is required (src/replay-topology.js): more
// than one replica configured, inside the deploy overlap window, draining,
// or a long-running route. Otherwise one container's per-process claim is
// the guarantee and a shared-store outage does not stop sales. The window is
// counted from the listen mark when the server makes one, else from import.
import { readFileSync } from "node:fs";
import { mayHaveSiblings, sharedClaimRequired, deployOverlapMs, markListening, windowStartedAt } from "../src/replay-topology.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const t0 = 1_000_000_000_000;
const one = { RATE_LIMIT_REPLICAS: "1" };
const two = { RATE_LIMIT_REPLICAS: "2" };
ok(deployOverlapMs({}) === 120_000 && deployOverlapMs({ DEPLOY_OVERLAP_SECONDS: "30" }) === 30_000, "the overlap window defaults to 120 s and reads DEPLOY_OVERLAP_SECONDS");
ok(mayHaveSiblings({ env: one, startedAt: t0, now: t0 + 60_000 }) === true, "one replica, 60 s after boot (a deploy's old container may still serve): siblings possible");
ok(mayHaveSiblings({ env: one, startedAt: t0, now: t0 + 121_000 }) === false, "one replica past the window: alone");
ok(mayHaveSiblings({ env: two, startedAt: t0, now: t0 + 3_600_000 }) === true, "two replicas configured: siblings always possible");
ok(mayHaveSiblings({ env: { STATE_DB_REPLICAS: "3", RATE_LIMIT_REPLICAS: "1" }, startedAt: t0, now: t0 + 3_600_000 }) === true, "STATE_DB_REPLICAS wins over RATE_LIMIT_REPLICAS, as for leases");
ok(mayHaveSiblings({ env: one, startedAt: t0, now: t0 + 3_600_000, draining: true }) === true, "draining (the replacement is live): siblings");
ok(sharedClaimRequired({ longRunning: true, env: one, startedAt: t0, now: t0 + 3_600_000 }) === true, "a long-running route always requires the shared claim");
ok(sharedClaimRequired({ env: one, startedAt: t0, now: t0 + 3_600_000 }) === false, "a fast route on a lone container past its window does not");
ok(sharedClaimRequired({ env: two, startedAt: t0, now: t0 + 3_600_000 }) === true, "a fast route with two replicas configured requires the shared claim");
ok(sharedClaimRequired({ env: one, startedAt: t0, now: t0 + 60_000 }) === true, "a fast route on a lone container inside its window requires the shared claim");
ok(sharedClaimRequired({ env: one, startedAt: t0, now: t0 + 3_600_000, draining: true }) === true, "a fast route on a draining container requires the shared claim");

// The window is counted from listen when the server marks it: a boot that
// spent 100 s loading stores before listen is still inside its window 30 s
// after listen (130 s after import), and leaves it 120 s after listen.
{
  const imported = windowStartedAt();
  ok(Number.isFinite(imported) && imported > 0 && Math.abs(Date.now() - imported) < 60_000, "before any mark the window starts at import time");
  const listen = t0 + 100_000;
  ok(markListening(listen) === listen && windowStartedAt() === listen, "markListening anchors the window at the listen time and returns it");
  ok(mayHaveSiblings({ env: one, now: listen + 30_000 }) === true, "30 s after listen (130 s after a slow import) siblings are still possible");
  ok(mayHaveSiblings({ env: one, now: listen + 120_000 }) === false, "120 s after listen the lone container is alone");
  ok(sharedClaimRequired({ env: one, now: listen + 119_000 }) === true && sharedClaimRequired({ env: one, now: listen + 120_000 }) === false, "sharedClaimRequired reads the same anchor");
  ok(mayHaveSiblings({ env: one, now: listen + 30_000, startedAt: t0 }) === false, "an explicit startedAt still wins over the mark");
}

// The server makes the mark from its listen callback (the caller path: a
// module that exports markListening and a server that never calls it would
// still count from import).
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const cb = /app\.listen\(PORT, \(\) => \{([\s\S]*?)\n\}\);/.exec(src);
  ok(!!cb && /markListening\(listenedAt\)/.test(cb[1]), "src/server.js calls markListening(listenedAt) inside its app.listen callback");
  ok(/import \{[^}]*\bmarkListening\b[^}]*\} from "\.\/replay-topology\.js"/.test(src), "src/server.js imports markListening from replay-topology.js");
}
console.log(`\ntest-replay-topology: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
