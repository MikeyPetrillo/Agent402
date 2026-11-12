#!/usr/bin/env node
// mppx 0.18 throws at construction when a Tempo server method (charge,
// session, subscription) has no `store` and the process looks like a shared
// production runtime (NODE_ENV=production, or a multi-instance platform such
// as Railway). Every Tempo method this server builds passes our shared store,
// so each one must construct under exactly that environment.
//   control: a bare tempo.charge() with no store throws in this environment,
//            so the cases below are not passing only because nothing checks;
//   1. the one-shot charge method (src/mpp-tempo.js), relay and direct modes,
//      each handed our shared replay store itself (mppx would otherwise fall
//      back to a per-process memory store in relay mode);
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

// Constructing is not enough: in relay mode mppx falls back to its own
// in-memory store when none is passed, so the method would build and still
// lose the shared replay guard. The build is observed through tempo.charge
// (the same object src/mpp-tempo.js calls) and the store it is handed must
// be our shared store itself, in both modes.
const tempoMod = await import("../src/mpp-tempo.js");
const { mppxReplayStore } = await import("../src/mppx-store.js");
const realCharge = tempo.charge;
const builds = [];
tempo.charge = (opts, ...rest) => { builds.push(opts); return realCharge.call(tempo, opts, ...rest); };
try {
  for (const mode of ["relay", "direct"]) {
    if (mode === "direct") process.env.TEMPO_RELAY = "off"; else delete process.env.TEMPO_RELAY;
    tempoMod.__testResetMethodCache();
    builds.length = 0;
    const r = tryBuild(() => tempoMod._tempoMethodUsesRelay());
    ok(!r.error, `the one-shot charge method constructs in production (${mode} mode)${r.error ? `: ${r.error.message}` : ""}`);
    ok(r.value === (mode === "relay"), `the method is built in ${mode} mode (${r.value})`);
    ok(builds.length === 1 && !!builds[0]?.relay === (mode === "relay"), `one tempo.charge build observed in ${mode} mode (${builds.length})`);
    ok(builds.length === 1 && builds[0].store === mppxReplayStore(), `the ${mode}-mode method is handed our shared replay store itself, not a fallback`);
  }
} finally {
  tempo.charge = realCharge;
  delete process.env.TEMPO_RELAY;
}

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
