#!/usr/bin/env node
// mppx 0.18 throws at construction when a Tempo server method (charge,
// session, subscription) has no `store` and the process looks like a shared
// production runtime (NODE_ENV=production, or a multi-instance platform such
// as Railway). Every Tempo method this server builds passes our shared store,
// so each one must construct under exactly that environment.
//   control: a bare tempo.charge() with no store throws in this environment,
//            so the cases below are not passing only because nothing checks;
//   1. the one-shot charge method (src/mpp-tempo.js), relay and direct modes;
//   2. the subscription engine (src/mpp-subscriptions.js), with and without
//      the fee sponsor (the method is built when the engine is).
// Offline: no RPC, no relay, no key that holds anything.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.log(`  FAIL ${m}`); } };
const tryBuild = (fn) => { try { return { value: fn(), error: null }; } catch (error) { return { value: undefined, error }; } };

// The production shape: what Railway sets on the service.
process.env.NODE_ENV = "production";
process.env.RAILWAY_ENVIRONMENT = "production";
process.env.MPP_SECRET_KEY = "mppx-production-store-test-secret";
process.env.TEMPO_RECIPIENT_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_DECIMALS = "6";
delete process.env.TEMPO_RPC_URL;
delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;

const { tempo } = await import("mppx/server");
{
  const r = tryBuild(() => tempo.charge({ currencies: ["0x20C000000000000000000000b9537d11c60E8b50"], recipient: process.env.TEMPO_RECIPIENT_ADDRESS }));
  ok(r.error && /store/.test(String(r.error.message)), `control: tempo.charge() with no store refuses to construct here (${r.error ? "threw" : "built"})`);
}

const tempoMod = await import("../src/mpp-tempo.js");
for (const mode of ["relay", "direct"]) {
  if (mode === "direct") process.env.TEMPO_RELAY = "off"; else delete process.env.TEMPO_RELAY;
  tempoMod.__testResetMethodCache();
  const r = tryBuild(() => tempoMod._tempoMethodUsesRelay());
  ok(!r.error, `the one-shot charge method constructs in production (${mode} mode)${r.error ? `: ${r.error.message}` : ""}`);
}
delete process.env.TEMPO_RELAY;

const { createMppSubscriptions } = await import("../src/mpp-subscriptions.js");
const tmp = mkdtempSync(join(tmpdir(), "mppx-prod-store-"));
try {
  for (const sponsored of [false, true]) {
    if (sponsored) process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = generatePrivateKey();
    else delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
    const r = tryBuild(() => createMppSubscriptions({
      secretKey: process.env.MPP_SECRET_KEY, realm: "agent402.test",
      storePath: join(tmp, `subs-${sponsored ? "sponsored" : "plain"}.json`), log: () => {},
    }));
    ok(!r.error && r.value, `the subscription engine constructs in production (${sponsored ? "with" : "without"} the fee sponsor)${r.error ? `: ${r.error.message}` : ""}`);
    try { r.value?.stop?.(); } catch { /* best effort */ }
  }
} finally {
  delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  rmSync(tmp, { recursive: true, force: true });
}

if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log("\nall mppx production-store checks passed");
process.exit(0);
