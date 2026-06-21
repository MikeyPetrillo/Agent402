// Stats DB volume contract: counters + the recentCalls ring buffer must live
// on the /data persistent volume in production. Mirrors the same fail-loud
// gate as pow.js — silent fallback to /tmp would wipe the live activity feed
// on every container restart and make traffic look thinner than it is.
//
// Three states this test covers (the third is the real safety net):
//   1) NODE_ENV != production (this runner)        → boots, statsPersistent=false on no /data
//   2) NODE_ENV=production, no opt-out             → exits 1 with a clear stderr message
//   3) NODE_ENV=production + STATS_ALLOW_EPHEMERAL → boots cleanly
//
// Offline — no server, no network, no secrets. Spawns short-lived child node
// processes to swap NODE_ENV without polluting this runner's env.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { statsPersistent } from "../src/stats.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

// ---- 1) Default path on the test runner ----
ok(typeof statsPersistent === "boolean", "statsPersistent is a boolean export");
// CI runners and dev boxes have no Unix /data dir; the export must reflect
// that truth (no white lies) so /health surfaces accurate persistence state.
ok(statsPersistent === false, "no /data on the test runner → statsPersistent must be false");

// Absolute file URL so the child process resolves stats.js regardless of cwd
// quirks on Windows vs Linux runners.
const STATS_URL = pathToFileURL(resolve("src/stats.js")).href;
const probe = (env) => spawnSync(process.execPath, [
  "--input-type=module",
  "-e",
  `import(${JSON.stringify(STATS_URL)}).then(()=>process.exit(0)).catch((e)=>{console.error(e?.message||e);process.exit(2)});`,
], {
  // Start from a clean env so the parent's NODE_ENV/FREE_MODE/etc don't leak.
  env: { PATH: process.env.PATH || "", ...env },
  encoding: "utf8",
  timeout: 10_000,
});

// ---- 2) Production + no /data + no opt-out → must exit 1 ----
// This is the gate that prevents a misconfigured deploy from silently wiping
// recentCalls. Without it, a missing volume mount looks identical to a
// healthy boot from outside.
const r2 = probe({ NODE_ENV: "production" });
ok(r2.status === 1, `production+no-/data+no-opt-out must exit 1 (got status=${r2.status}, stderr=${r2.stderr})`);
ok(/STATS_ALLOW_EPHEMERAL/.test(r2.stderr), "exit message must name the STATS_ALLOW_EPHEMERAL opt-out env var");
ok(/recentCalls/.test(r2.stderr), "exit message must explain the user-visible impact (recentCalls)");
ok(/\/data/.test(r2.stderr), "exit message must name the missing /data volume");

// ---- 3) Production + opt-out → boots cleanly ----
// Same escape hatch shape as pow.js (POW_ALLOW_EPHEMERAL) for symmetry.
const r3 = probe({ NODE_ENV: "production", STATS_ALLOW_EPHEMERAL: "true" });
ok(r3.status === 0, `production+STATS_ALLOW_EPHEMERAL must boot cleanly (got status=${r3.status}, stderr=${r3.stderr})`);

// ---- 4) FREE_MODE also bypasses the gate (local sweeps) ----
// FREE_MODE is the canonical "I know I'm running ephemeral" signal — same
// branch as pow.js. Without this, scripts/test-all.js (which sets FREE_MODE)
// would refuse to boot if anyone ever set NODE_ENV=production alongside it.
const r4 = probe({ NODE_ENV: "production", FREE_MODE: "true" });
ok(r4.status === 0, `production+FREE_MODE must boot cleanly (got status=${r4.status}, stderr=${r4.stderr})`);

console.log("test-stats-persistence: OK");
