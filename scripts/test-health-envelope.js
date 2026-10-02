// /health is the single endpoint the production heartbeat, paid canary,
// CI smoke tests, and CDN load balancers all hit. A regression in its shape
// silently breaks the "is prod alive" answer everywhere at once. Beyond
// "ok: true", the `flags` block is the runtime feature-activation report —
// env vars flapped set→missing→set inside 26 hours, and a missing key on
// `flags` (vs `false`) silently slipped past truthy checks. So the flag
// shape itself is now a contract worth locking.
//
// This test boots FREE_MODE and locks:
//
//   1. GET /health → 200 application/json.
//   2. Envelope: { ok:true, checks{}, flags{} }.
//   3. checks{} carries `db` + `wallet` booleans — the baseline liveness
//      probes. (db=true on every boot; wallet=true means a wallet address
//      is configured.)
//   4. flags{} carries the full documented set: leadsDb, operatorToken,
//      EACH ONE must be a boolean — not undefined, not a string. The
//      `false` and `undefined`; downstream truthy checks couldn't tell.
//   5. Liveness sanity: /health responds in well under a second.
//
//   node scripts/test-health-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
// Full envelope is operator-gated now (A402-11); boot with a token to verify it.
const TOKEN = "healthtest-operator-token";

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", AGENT402_OPERATOR_TOKEN: TOKEN },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Public /health is generic liveness only (A402-11): 200 + ok, no wiring.
  const pub = await fetch(`${BASE}/health`);
  const pubBody = await pub.json();
  ok(pub.status === 200 && pubBody.ok === true, `public /health → 200 ok (got ${pub.status})`);
  ok(!("flags" in pubBody) && !("checks" in pubBody), "public /health hides flags/checks");

  const t0 = Date.now();
  const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const latencyMs = Date.now() - t0;
  ok(res.status === 200, `authed /health → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), `content-type is application/json`);
  ok(latencyMs < 1000, `/health responds in well under a second (got ${latencyMs}ms)`);
  const body = await res.json();

  // Envelope.
  for (const k of ["ok", "checks", "flags"]) {
    ok(k in body, `envelope key '${k}' present (got: ${Object.keys(body).join(",")})`);
  }
  ok(body.ok === true, `ok=true (got ${body.ok}) — heartbeat parses this exact value`);

  // checks{} — db + wallet baseline. db is the local catalog/sqlite probe;
  // wallet=true means WALLET_ADDRESS is configured. Both are booleans so a
  // probe can `&&` them.
  ok(typeof body.checks === "object" && body.checks != null, `checks is an object`);
  ok(typeof body.checks.db === "boolean", `checks.db is boolean (got ${typeof body.checks.db})`);
  ok(typeof body.checks.wallet === "boolean", `checks.wallet is boolean (got ${typeof body.checks.wallet})`);

  // flags{} — runtime activation report. Every flag here MUST be a boolean.
  // An `undefined` (key missing) silently reads as `false` to a truthy check
  // but breaks `=== false` / `=== true`, so an activation claim can read
  // either way depending on which comparison the caller used. Locking the
  // shape forces a boolean discipline that gap cannot slip past. Mirrors
  // scripts/test-health-flags.js: a flag added there belongs here too.
  const REQUIRED_FLAGS = [
    "leadsDb",
    "operatorToken",
    "posthog",
    "statsPersistent",
    "memoryPersistent",
    "llmGateway",
  ];
  ok(typeof body.flags === "object" && body.flags != null, `flags is an object`);
  for (const f of REQUIRED_FLAGS) {
    ok(f in body.flags, `flags carries '${f}' key (got: ${Object.keys(body.flags).join(",")})`);
    ok(typeof body.flags[f] === "boolean", `flags.${f} is a boolean (got ${typeof body.flags[f]}: ${body.flags[f]}) — a missing or non-boolean flag is the regression this pins`);
  }

  console.log(`\n${pass} passed (latency=${latencyMs}ms, flags: ${REQUIRED_FLAGS.map(f => `${f}=${body.flags[f]}`).join(", ")})`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
