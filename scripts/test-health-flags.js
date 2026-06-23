// /health is the shape Railway, heartbeat.yml, and operator probes pin to.
// Each documented flag is a published contract — a UI tile, a canary preflight,
// a memory-page lookup. The memory entry `project_yahoo_relay_envvar_flap.md`
// captured exactly this failure mode: an env var silently went missing and
// `flags.yahooRelay` flipped from true to undefined, which downstream consumers
// (paid-canary preflight) had to learn to defend against.
//
// This test boots a FREE_MODE server and locks the published flag contract:
// every documented key is present, each value is the documented shape (boolean
// for flags, boolean for checks), and `ok` is true in FREE_MODE. A future
// rename, a missing `typeof` coercion, or an environment refactor that drops a
// flag entirely will fail loudly here instead of silently.
//
//   node scripts/test-health-flags.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3096;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/health`);
  ok(res.ok, `/health returns 200 in FREE_MODE (got ${res.status})`);
  const body = await res.json();

  // Top-level shape.
  ok(body.ok === true, `body.ok is true in FREE_MODE (got ${JSON.stringify(body.ok)})`);
  ok(typeof body.checks === "object" && body.checks !== null, "body.checks is an object");
  ok(typeof body.flags === "object" && body.flags !== null, "body.flags is an object");

  // Required checks — `wallet` is the deal-breaker for paid mode but must still
  // exist in FREE_MODE (set to true). `db` reflects the stats-DB readability.
  for (const key of ["db", "wallet"]) {
    ok(key in body.checks, `body.checks.${key} is present`);
    ok(typeof body.checks[key] === "boolean", `body.checks.${key} is boolean (got ${typeof body.checks[key]})`);
  }

  // Required flags — every key documented in server.js:557-578. A future env
  // refactor that quietly drops one (the yahoo-relay flap pattern) will fail
  // this exact list. Add new flags here when they're added to the server.
  const REQUIRED_FLAGS = [
    "leadsDb",
    "operatorToken",
    "sentry",
    "posthog",
    "yahooRelay",
    "statsPersistent",
    "memoryPersistent",
  ];
  for (const key of REQUIRED_FLAGS) {
    ok(key in body.flags, `body.flags.${key} is present`);
    ok(typeof body.flags[key] === "boolean", `body.flags.${key} is boolean (got ${typeof body.flags[key]})`);
  }

  // 503 contract: when ok=false the response code must reflect it. We can't
  // force a failure here without breaking FREE_MODE, but assert the inverse
  // (ok=true → 200) covers half the contract. A future refactor that splits
  // status from body would break the heartbeat probe.
  ok(res.status === 200, "ok=true correlates with HTTP 200 (heartbeat probe contract)");

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
