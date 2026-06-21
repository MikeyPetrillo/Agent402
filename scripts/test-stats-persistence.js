// /data persistent-volume contract for every SQLite-backed module that holds
// state buyers care about: pow.js (replay protection), stats.js (counters +
// recentCalls), and tools/memory.js (paid wallet-keyed storage). Each module
// uses the same fail-loud shape — silent fallback to /tmp on prod would be a
// silent data-loss bug, and stats + memory are the worst-case examples
// because buyers paid USDC for the storage to be durable.
//
// Four gate states are exercised against each module:
//   1) NODE_ENV != production (this runner)         → boots, *Persistent=false on no /data
//   2) NODE_ENV=production, no opt-out              → exits 1 with a clear stderr message
//   3) NODE_ENV=production + <MODULE>_ALLOW_EPHEMERAL → boots cleanly
//   4) NODE_ENV=production + FREE_MODE              → boots cleanly (local sweeps)
//
// Offline — no server, no network, no secrets. Spawns short-lived child node
// processes to swap NODE_ENV without polluting this runner's env.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { statsPersistent } from "../src/stats.js";
import { PERSISTENT as memoryPersistent } from "../src/tools/memory.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

// ---- 1) Default path on the test runner — both modules expose accurate state.
// CI runners and dev boxes have no Unix /data dir; the exports must reflect
// that truth (no white lies) so /health surfaces accurate persistence state.
ok(typeof statsPersistent === "boolean", "statsPersistent is a boolean export");
ok(statsPersistent === false, "no /data on the test runner → statsPersistent must be false");
ok(typeof memoryPersistent === "boolean", "memoryPersistent is a boolean export");
ok(memoryPersistent === false, "no /data on the test runner → memoryPersistent must be false");

// Build absolute file URLs so the child process resolves these modules
// regardless of cwd quirks on Windows vs Linux runners.
const urlOf = (rel) => pathToFileURL(resolve(rel)).href;

// One probe runs an isolated `import(modUrl)` under a clean env and reports
// exit status + stderr. The wrapper script exits 0 on import-success, 2 on
// any thrown error (distinct from the gate's deliberate exit 1).
const probe = (modUrl, env) => spawnSync(process.execPath, [
  "--input-type=module",
  "-e",
  `import(${JSON.stringify(modUrl)}).then(()=>process.exit(0)).catch((e)=>{console.error(e?.message||e);process.exit(2)});`,
], {
  // Start from a clean env so the parent's NODE_ENV/FREE_MODE/etc don't leak.
  env: { PATH: process.env.PATH || "", ...env },
  encoding: "utf8",
  timeout: 10_000,
});

// Each module has the same shape: a sentinel env var that opens the ephemeral
// path, plus an impact phrase the operator should see in stderr so the failure
// mode is obvious (recentCalls vs paid agent memory).
const MODULES = [
  { name: "stats",  url: urlOf("src/stats.js"),         optOut: "STATS_ALLOW_EPHEMERAL",  impact: "recentCalls" },
  { name: "memory", url: urlOf("src/tools/memory.js"),  optOut: "MEMORY_ALLOW_EPHEMERAL", impact: "paid agent memory" },
];

for (const mod of MODULES) {
  // ---- 2) Production + no /data + no opt-out → must exit 1.
  // Without this gate, a missing volume mount looks identical to a healthy
  // boot from outside — and in memory's case, buyers PAY for storage that
  // would then silently vanish on the next container restart.
  const r2 = probe(mod.url, { NODE_ENV: "production" });
  ok(r2.status === 1, `[${mod.name}] production+no-/data+no-opt-out must exit 1 (got status=${r2.status}, stderr=${r2.stderr})`);
  ok(new RegExp(mod.optOut).test(r2.stderr), `[${mod.name}] exit message must name the ${mod.optOut} opt-out env var`);
  ok(new RegExp(mod.impact).test(r2.stderr), `[${mod.name}] exit message must explain the user-visible impact (${mod.impact})`);
  ok(/\/data/.test(r2.stderr), `[${mod.name}] exit message must name the missing /data volume`);

  // ---- 3) Production + module-specific opt-out → boots cleanly.
  // Same escape hatch shape as pow.js (POW_ALLOW_EPHEMERAL) for symmetry.
  const r3 = probe(mod.url, { NODE_ENV: "production", [mod.optOut]: "true" });
  ok(r3.status === 0, `[${mod.name}] production+${mod.optOut} must boot cleanly (got status=${r3.status}, stderr=${r3.stderr})`);

  // ---- 4) FREE_MODE bypasses the gate (local sweeps).
  // FREE_MODE is the canonical "I know I'm running ephemeral" signal — same
  // branch as pow.js. Without it, scripts/test-all.js (which sets FREE_MODE)
  // would refuse to boot if anyone ever set NODE_ENV=production alongside.
  const r4 = probe(mod.url, { NODE_ENV: "production", FREE_MODE: "true" });
  ok(r4.status === 0, `[${mod.name}] production+FREE_MODE must boot cleanly (got status=${r4.status}, stderr=${r4.stderr})`);
}

console.log("test-stats-persistence: OK");
