// Opt-in idempotency, tested against a server with the x402 paywall ACTIVE (so
// the gate is real). Exercises the proof-of-work credential path: a retry with
// the same Idempotency-Key + same PoW token replays the result without
// re-charging, while the security properties hold — no header, or a different
// key, never replays (and never leaks a paid result). The facilitator is never
// contacted (X402_SYNC_ON_START=false); PoW bypasses settlement entirely.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PORT = 3071;
const B = `http://localhost:${PORT}`;
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const solve = (c) => { let n = 0; while (lz(createHash("sha256").update(`${c.challenge}:${n}`).digest()) < c.difficulty) n++; return n; };

const proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${B}/api/pow`)).ok) break; } catch {} await sleep(500); }

  const powFor = async () => { const c = await (await fetch(`${B}/api/pow/challenge?slug=hash`)).json(); return `${c.token}:${solve(c)}`; };
  const hash = (sol, idem) => fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": sol, ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: JSON.stringify({ text: "hello world" }),
  });
  let pass = 0; const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

  // 1. First paid+keyed call succeeds.
  const sol1 = await powFor();
  let r = await hash(sol1, "key-1");
  ok(r.status === 200 && (await r.json()).hex.slice(0, 8) === "b94d27b9", "first PoW call with Idempotency-Key -> 200");

  // 2. Retry with the SAME key + SAME (now-used) token replays instead of "already used".
  r = await hash(sol1, "key-1");
  ok(r.status === 200 && r.headers.get("x-idempotent-replay") === "true", "retry (same key + credential) replays without re-charging");

  // 3. Replaying the used token WITHOUT a key keeps normal behavior: rejected.
  r = await hash(sol1, null);
  ok(r.status !== 200, `used token without Idempotency-Key is rejected (got ${r.status})`);

  // 4. Used token + a DIFFERENT key: cache miss, no replay, no leak.
  r = await hash(sol1, "key-DIFFERENT");
  ok(r.status !== 200, `used token + different key does not replay (got ${r.status})`);

  // 5. Idempotency-Key but NO credential on an unproven call: gate still applies
  // (the paywall returns 402 with egress; 5xx here where the facilitator host is
  // unreachable — either way it never returns a result or a replay).
  r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "key-x" }, body: JSON.stringify({ text: "hi" }) });
  ok(r.status !== 200 && r.headers.get("x-idempotent-replay") !== "true", `Idempotency-Key without payment/PoW does not get through or replay (got ${r.status})`);

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
