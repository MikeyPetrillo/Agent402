// TypeSafe credits are metered from each response's own usage, because TypeSafe
// publishes no balance API. Pinned offline:
//   1. unconfigured without TYPESAFE_CREDIT_USD (never pages);
//   2. usage reported by responses is summed and costed at the input rate;
//   3. low under TYPESAFE_LOW_USD, ok above it;
//   4. a new TYPESAFE_CREDIT_SINCE (a top-up) restarts the count;
//   5. a rejected key (401/402/403) reads low even when unconfigured;
//   6. /v1/judge books the usage of a real (stubbed) response and maps a 402
//      to a 503 that never blames the buyer's request;
//   7. the public gateway-status carries the status word only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.TYPESAFE_USAGE_FILE = "/nonexistent-dir/typesafe-usage.json";
const m = await import("../src/typesafe-credit.js");

let n = 0;
const ok = (c, msg) => { n++; assert.ok(c, msg); console.log(`ok - ${msg}`); };
const env = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

m._resetTypesafeCreditForTest();
env({ TYPESAFE_CREDIT_USD: undefined, TYPESAFE_CREDIT_SINCE: undefined, TYPESAFE_LOW_USD: undefined, TYPESAFE_USD_PER_MTOK: undefined });
ok(m.typesafeCreditStatus().status === "unconfigured", "no credit figure: unconfigured, never pages");
env({ TYPESAFE_CREDIT_USD: "50", TYPESAFE_CREDIT_SINCE: "2026-09-25" });
ok(m.typesafeCreditStatus().status === "unconfigured", "no input rate configured: unconfigured (no vendor rate is kept in code)");
env({ TYPESAFE_USD_PER_MTOK: "0.1" });
m._resetTypesafeCreditForTest();

env({ TYPESAFE_CREDIT_USD: "50", TYPESAFE_CREDIT_SINCE: "2026-09-25" });
m.noteTypesafeUsage({ input_tokens: 1_000_000, output_tokens: 500 });
m.noteTypesafeUsage({ input_tokens: 1_000_000 });
m.noteTypesafeUsage({ input_tokens: "junk" });
let s = m.typesafeCreditStatus();
ok(s.inputTokens === 2_000_000 && s.calls === 2 && Math.abs(s.spentUsd - 0.2) < 1e-9, `input tokens summed and costed at the configured rate (${s.spentUsd})`);
ok(s.status === "ok" && Math.abs(s.remainingUsd - 49.8) < 1e-9, `ok with most of the credit left (${s.remainingUsd})`);

env({ TYPESAFE_CREDIT_USD: "10.1" });
ok(m.typesafeCreditStatus().status === "low", "low once the estimated remainder drops under $10");

env({ TYPESAFE_CREDIT_USD: "50", TYPESAFE_CREDIT_SINCE: "2026-10-15" });
s = m.typesafeCreditStatus();
ok(s.inputTokens === 0 && s.status === "ok", "a new TYPESAFE_CREDIT_SINCE restarts the count from zero");

m.noteTypesafeRejected();
ok(m.typesafeCreditStatus().status === "low", "a rejected key reads low");
env({ TYPESAFE_CREDIT_USD: undefined });
ok(m.typesafeCreditStatus().status === "low", "...even with no credit figure set");

// --- 6. judge-kit books real usage and maps 402
m._resetTypesafeCreditForTest();
env({ TYPESAFE_CREDIT_USD: "50", TYPESAFE_CREDIT_SINCE: "2026-09-25", TYPESAFE_USD_PER_MTOK: "0.1", TYPESAFE_API_KEY: "test-key" });
const { judge } = await import("../src/tools/judge-kit.js");
const input = { state: "a short state", questions: { q: { type: "noul", instructions: "Is it short?" } } };
const okFetch = async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { probability: 0.9 } }, usage: { input_tokens: 363, output_tokens: 37 } }), { status: 200 });
try { await judge(input, { fetchImpl: okFetch }); } catch (e) { console.log("judge threw:", e.message); }
ok(m.typesafeCreditStatus().inputTokens === 363, `a /v1/judge response's reported usage is booked (${m.typesafeCreditStatus().inputTokens})`);
let err;
try { await judge(input, { fetchImpl: async () => new Response("{}", { status: 402 }) }); } catch (e) { err = e; }
ok(err?.statusCode === 503 && !/question shapes/i.test(err.message), `a 402 from TypeSafe is a 503 on us, not a 400 on the buyer (${err?.statusCode}: ${err?.message})`);
ok(m.typesafeCreditStatus().status === "low", "...and marks the credits low");

// --- 7. public surface
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/typesafeCredits: full \? typesafeCreditStatus\(\) : \{ status: typesafeCreditStatus\(\)\.status \}/.test(src), "gateway-status publishes the status word only unless operator-authed");
const hb = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
ok(hb.includes(".typesafeCredits.status") && hb.includes("TypeSafe credits LOW"), "the heartbeat pages on low");

console.log(`test-typesafe-credit: ${n} passed`);
