// The router worker must load under production's own conditions: NODE_ENV
// production, no /data volume, and no state database (the pool denies the
// worker STATE_DATABASE_URL). Three modules the worker imports (pow, stats,
// memory) refuse to load in that shape unless told the store may be ephemeral,
// and they refuse with process.exit - inside a worker that is a silent exit
// code 1, the pool respawns, and every route query runs on the main thread.
// That happened on every production boot from the day the volume was removed
// until this test existed; the in-repo suites boot in FREE_MODE, where the
// guards never fire. This boots the real pool and worker that way.
//
//   node scripts/test-router-worker-prod-boot.js
import "./lib/file-mode.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

if (existsSync("/data")) {
  // The condition under test is the absence of the volume; a host with /data
  // cannot exercise it. CI runners have none.
  if (process.env.CI) assert.fail("/data exists on this CI runner, so the no-volume boot cannot be tested");
  console.log("skip - /data exists on this machine; the no-volume boot is tested where it is absent (CI)");
  process.exit(0);
}
process.env.ROUTER_WORKERS = "1";
process.env.X402_INDEX_CRAWL = "off";
const { startRouterPool, stopRouterPool, routerPoolStatus, routerPoolLoaded } = await import("../src/router-pool.js");
// Production's shape, set after this process's own imports (this test is not
// the server; only the worker's environment, copied at spawn, matters).
process.env.NODE_ENV = "production";
delete process.env.FREE_MODE;
for (const k of ["POW_ALLOW_EPHEMERAL", "MEMORY_ALLOW_EPHEMERAL", "STATS_ALLOW_EPHEMERAL"]) delete process.env[k];
startRouterPool();
const loaded = await Promise.race([routerPoolLoaded().then(() => true), new Promise((r) => setTimeout(() => r(false), 45_000))]);
const s = routerPoolStatus();
await stopRouterPool();
assert.ok(loaded && s.loaded, `the router worker loads with NODE_ENV=production, no /data and no state database (loaded=${s.loaded}, crashes=${s.crashes})`);
assert.equal(s.crashes, 0, `the worker never exited on import (crashes=${s.crashes})`);
console.log(`ok - router worker loaded under production boot conditions (crashes ${s.crashes})`);
console.log("test-router-worker-prod-boot: 2 passed");
process.exit(0);
