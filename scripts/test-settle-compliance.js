#!/usr/bin/env node
// A settle refusal on compliance grounds is final (src/settle-compliance.js).
//
// Offline. Drives the real settle-failure hook (src/payments.js), the
// demotion wrapper, the Stellar fallback, our own relayer's payer screen and
// the 402 wording against stub settlers, and asserts:
//   - a compliance refusal from the primary or any fallback asks NOTHING
//     further (zero calls to the next client, never our own relayer) and ends
//     in a failed result that names no transaction (nothing charged, nothing
//     owed);
//   - a refusal that is not about compliance still falls back as before;
//   - our own relayer's screen refuses a listed payer with nothing sent and
//     lets a clean one through to the settle;
//   - the 402 body says the settlement provider's compliance check refused
//     it, charged:false, and the operator count holds no address.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { SettleError } from "@x402/core/types";
import { registerFacilitatorFailureHooks, isRetryableSettleRefusal, isListedPassOnRefusal } from "../src/payments.js";
import {
  isComplianceSettleRefusal, complianceRefusedResult, settleComplianceView, __resetSettleComplianceForTests,
  SETTLE_COMPLIANCE_REFUSED, OWN_SETTLER_SCREEN_REFUSED,
} from "../src/settle-compliance.js";
import { complianceSettleRefusal, REJECTION_REASONS } from "../src/payment-reject.js";
import { withSettleDemotion, noteSettleOutcome, _resetSettleDemotion } from "../src/settle-demotion.js";
import { settleWithStellarFallback } from "../src/stellar-confirm.js";
import { screenOwnSettlerPayer } from "../src/own-settler-screen.js";
import { __seedPayoutListForTests, __resetPayoutListForTests } from "../src/tools/sanctions-kit.js";
import { createOwnRelayerClient } from "../src/robinhood-relayer.js";

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`ok - ${name}`); } catch (e) { fail++; console.error(`FAIL - ${name}\n   ${e.message}`); }
};
const quiet = () => {};
const BASE = "eip155:8453";
const RH = "eip155:4663";
const settleError = (statusCode, body, network = BASE) => new SettleError(statusCode, { success: false, transaction: "", network, ...body });
const rejection402 = () => Object.assign(new Error("settle failed (402)"), { status: 402 });
const sanctioned = (network = BASE) => settleError(403, { errorReason: "sanctioned_address", errorMessage: "payer address is on a sanctions list" }, network);
const fakeServer = () => {
  const hooks = {};
  return { hooks, onVerifyFailure(fn) { hooks.verifyFailure = fn; }, onAfterSettle(fn) { hooks.afterSettle = fn; }, onSettleFailure(fn) { hooks.settleFailure = fn; } };
};
const stub = (name, behavior, calls) => ({ settle: async () => { calls.push(name); return behavior(); } });

async function run({ primaryError, network = BASE, payai = null, solvador = null, overrides = null }) {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  const calls = [];
  const s = fakeServer();
  const ov = overrides ? Object.fromEntries(Object.entries(overrides).map(([net, list]) => [net, list.map((c) => ({ ...c, client: stub(c.name, c.behavior, calls) }))])) : null;
  const origWarn = console.warn; const origLog = console.log;
  console.warn = quiet; console.log = quiet;
  try {
    registerFacilitatorFailureHooks(s, payai ? stub("PayAI", payai, calls) : null, solvador ? stub("Solvador", solvador, calls) : null, ov);
    const out = await s.hooks.settleFailure({ requirements: { network, scheme: "exact" }, paymentPayload: { payload: { authorization: { from: "0x" + "11".repeat(20), nonce: "0x" + "22".repeat(32) } } }, error: primaryError });
    return { out, calls };
  } finally {
    console.warn = origWarn; console.log = origLog;
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
}
const isComplianceEnd = (out) => out?.recovered === true && out.result?.success === false && out.result.errorReason === SETTLE_COMPLIANCE_REFUSED && out.result.transaction === "";

// --- the list ------------------------------------------------------------
await check("classifier: sanctions, OFAC/SDN, block and deny lists, flagged or blocked accounts, compliance, AML, KYT and high risk are compliance refusals", () => {
  for (const r of [
    { errorReason: "sanctioned_address" }, { errorReason: "payer_sanctioned" }, { errorMessage: "Address is on the OFAC SDN list" },
    { errorReason: "address_blocked" }, { errorReason: "blocked_address" }, { errorMessage: "recipient is blocked" }, { errorMessage: "the payer was flagged by screening" },
    { errorReason: "flagged_wallet" }, { errorMessage: "Blacklistable: account is blacklisted" }, { errorReason: "denylisted" }, { errorReason: "blocklisted_payer" },
    { errorReason: "compliance_check_failed" }, { errorMessage: "Transaction rejected by compliance" }, { errorReason: "aml_screening_failed" }, { errorReason: "kyt_rejected" },
    { errorReason: "high_risk_address" }, { errorMessage: "High-risk counterparty" }, { errorReason: "account_frozen" }, { errorMessage: "risk check failed" },
    { errorReason: OWN_SETTLER_SCREEN_REFUSED },
  ]) assert.equal(isComplianceSettleRefusal({ success: false, ...r }), true, JSON.stringify(r));
  assert.equal(isComplianceSettleRefusal(sanctioned()), true, "a thrown SettleError");
});
await check("classifier: a buyer verdict, a billing refusal, gas, a transport failure, a success or a named transaction is not one", () => {
  for (const r of [
    { errorReason: "insufficient_funds" }, { errorReason: "invalid_exact_evm_payload_signature" }, { errorReason: "free_tier_exhausted" },
    { errorMessage: "payment-method-required" }, { errorMessage: "gas required exceeds allowance" }, { errorReason: "authorization_expired" },
    { errorMessage: "Sorry, you have been blocked" }, { errorReason: "invalid_exact_evm_transaction_failed", errorMessage: "transferWithAuthorization reverted" },
  ]) assert.equal(isComplianceSettleRefusal({ success: false, ...r }), false, JSON.stringify(r));
  assert.equal(isComplianceSettleRefusal({ success: true, errorReason: "sanctioned" }), false, "a success");
  assert.equal(isComplianceSettleRefusal({ success: false, errorReason: "sanctioned", transaction: "0x" + "ab".repeat(32) }), false, "names a transaction: it may land");
  assert.equal(isComplianceSettleRefusal(Object.assign(new Error("sanctions screen timed out"), { code: "ETIMEDOUT" })), false, "transport");
  assert.equal(isComplianceSettleRefusal(Object.assign(new Error("aborted: compliance"), { name: "AbortError" })), false, "abort");
});
await check("gates: a compliance refusal is never retryable and never passed on, even as an HTTP 402", () => {
  const e402 = settleError(402, { errorReason: "sanctioned_address" });
  assert.equal(isRetryableSettleRefusal(e402, BASE), false);
  assert.equal(isRetryableSettleRefusal(settleError(402, { errorReason: "payment_required" }), BASE), true, "control: a plain 402 still is");
  assert.equal(isListedPassOnRefusal(settleError(500, { errorReason: "compliance_refused" }, RH), RH), false);
  assert.equal(isListedPassOnRefusal(settleError(500, { errorReason: "relay_unavailable" }, RH), RH), true, "control: a listed facilitator's own refusal still passes on");
});

// --- the fallback chain ------------------------------------------------------
await check("primary compliance refusal: no fallback is asked, the end names no transaction", async () => {
  __resetSettleComplianceForTests();
  const { out, calls } = await run({ primaryError: sanctioned(), payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.deepEqual(calls, []);
  assert.ok(isComplianceEnd(out), JSON.stringify(out));
  assert.equal(settleComplianceView().providerRefused, 1);
});
await check("primary compliance refusal sent as an HTTP 402: still final", async () => {
  const { out, calls } = await run({ primaryError: settleError(402, { errorReason: "address_blocked" }), payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.deepEqual(calls, []);
  assert.ok(isComplianceEnd(out));
});
await check("control: a plain pre-broadcast 402 still falls back as before", async () => {
  const { out, calls } = await run({ primaryError: rejection402(), solvador: () => ({ success: true, transaction: "0xabc" }), payai: () => ({ success: true }) });
  assert.deepEqual(calls, ["Solvador"]);
  assert.equal(out?.recovered, true);
  assert.equal(out.result.success, true);
});
await check("a fallback's graceful compliance refusal: the next fallback is never asked", async () => {
  const { out, calls } = await run({ primaryError: rejection402(), solvador: () => ({ success: false, errorReason: "kyt_rejected", transaction: "" }), payai: () => ({ success: true }) });
  assert.deepEqual(calls, ["Solvador"]);
  assert.ok(isComplianceEnd(out));
});
await check("a fallback's thrown compliance refusal (HTTP 402): the next fallback is never asked", async () => {
  const { out, calls } = await run({ primaryError: rejection402(), solvador: () => { throw settleError(402, { errorReason: "sanctioned_address" }); }, payai: () => ({ success: true }) });
  assert.deepEqual(calls, ["Solvador"]);
  assert.ok(isComplianceEnd(out));
});
const reverted = () => settleError(500, { errorReason: "invalid_exact_evm_transaction_failed", errorMessage: "transferWithAuthorization reverted" }, RH);
await check("Robinhood: a listed facilitator's compliance refusal never reaches our own relayer", async () => {
  const overrides = { [RH]: [
    { name: "Listed2", revertRetry: true, behavior: () => ({ success: false, errorReason: "payer_blocked", transaction: "" }) },
    { name: "own relayer", own: true, revertRetry: true, behavior: () => ({ success: true, transaction: "0x" + "cd".repeat(32) }) },
  ] };
  const { out, calls } = await run({ network: RH, primaryError: reverted(), overrides });
  assert.deepEqual(calls, ["Listed2"]);
  assert.ok(isComplianceEnd(out));
});
await check("Robinhood control: a reverted transfer at the next listed facilitator still reaches our relayer", async () => {
  const overrides = { [RH]: [
    { name: "Listed2", revertRetry: true, behavior: () => { throw reverted(); } },
    { name: "own relayer", own: true, revertRetry: true, behavior: () => ({ success: true, transaction: "0x" + "cd".repeat(32) }) },
  ] };
  const { calls } = await run({ network: RH, primaryError: reverted(), overrides });
  assert.deepEqual(calls, ["Listed2", "own relayer"]);
});
await check("our own relayer's screen refusal (own-first) does not go on to the facilitator it skipped", async () => {
  const own = { success: false, errorReason: OWN_SETTLER_SCREEN_REFUSED, errorMessage: "screen", transaction: "", nothingSent: true };
  const overrides = { [RH]: [{ name: "Listed2", revertRetry: true, behavior: () => ({ success: true, transaction: "0x" + "ef".repeat(32) }) }] };
  __resetSettleComplianceForTests();
  const { out, calls } = await run({ network: RH, primaryError: settleError(500, own, RH), overrides });
  assert.deepEqual(calls, []);
  assert.ok(isComplianceEnd(out));
  assert.match(out.result.errorMessage, /sanctions screening/);
  assert.equal(settleComplianceView().providerRefused, 0, "our relayer counts its own screen; the hook does not count it twice");
});

// --- the demotion wrapper and the slow-primary path --------------------------
await check("demoted primary: an alternate's compliance refusal ends it, the primary is not asked", async () => {
  _resetSettleDemotion();
  for (let i = 0; i < 5; i++) noteSettleOutcome(BASE, "Primary", "funds");
  const calls = [];
  const primary = stub("Primary", () => ({ success: true }), calls);
  const alts = [{ name: "AltA", client: stub("AltA", () => ({ success: false, errorReason: "sanctioned_address" }), calls) }, { name: "AltB", client: stub("AltB", () => ({ success: true }), calls) }];
  withSettleDemotion(primary, { network: BASE, label: "Primary", alternates: () => alts, isPreBroadcast: () => true });
  const r = await primary.settle({ p: 1 }, { network: BASE });
  assert.deepEqual(calls, ["AltA"]);
  assert.equal(r.errorReason, "sanctioned_address");
  // Control: a billing refusal still moves on.
  calls.length = 0;
  const p2 = stub("Primary", () => ({ success: true }), calls);
  const alts2 = [{ name: "AltA", client: stub("AltA", () => ({ success: false, errorReason: "free_tier_exhausted" }), calls) }, { name: "AltB", client: stub("AltB", () => ({ success: true }), calls) }];
  withSettleDemotion(p2, { network: BASE, label: "Primary", alternates: () => alts2, isPreBroadcast: () => true });
  await p2.settle({ p: 2 }, { network: BASE });
  assert.deepEqual(calls, ["AltA", "AltB"]);
  _resetSettleDemotion();
});
await check("slow-primary path: a fallback's compliance refusal neither continues nor reaches the primary (source)", () => {
  const src = readFileSync(new URL("../src/settle-deadlines.js", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("const facilitatorSide = async () => {"), src.indexOf("primaryAt = now();"));
  assert.ok(/if \(isComplianceSettleRefusal\(r\)\) return r;\s*if \(isPreBroadcast\(asError\(r\)\)\) continue;/.test(loop), "a graceful compliance refusal returns before the pre-broadcast continue");
  assert.ok(/if \(isComplianceSettleRefusal\(err\)\) throw err;\s*if \(isPreBroadcast\(err\)\) continue;/.test(loop), "a thrown one is rethrown untagged before the pre-broadcast continue");
});

// --- Stellar ----------------------------------------------------------------
await check("Stellar: a primary compliance refusal is not re-submitted through the fallback facilitator", async () => {
  let fallbackCalls = 0;
  const r = await settleWithStellarFallback({
    primary: async () => ({ success: false, errorReason: "sanctioned_address", transaction: "" }),
    fallback: async () => { fallbackCalls++; return { success: true, transaction: "abc" }; },
    confirm: async () => null, log: quiet,
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(r.success, false);
  let controlCalls = 0;
  await settleWithStellarFallback({ primary: async () => ({ success: false, errorReason: "settle_channel_service_failed" }), fallback: async () => { controlCalls++; return { success: true, transaction: "abc" }; }, confirm: async () => null, log: quiet });
  assert.equal(controlCalls, 1, "control: another refusal still goes to the fallback");
});
await check("Stellar settle client screens the signed payer before any submission (source)", () => {
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const cls = src.slice(src.indexOf("class StellarConfirmingFacilitatorClient"), src.indexOf("const res = await settleWithStellarFallback({"));
  assert.match(cls, /screenOwnSettlerPayer\(signedPayer\)/);
  assert.match(cls, /errorReason: OWN_SETTLER_SCREEN_REFUSED/);
});

// --- our own settler's screen -----------------------------------------------
const LISTED = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const CLEAN = "0x" + "12".repeat(20);
await check("screen: the OFAC list names a listed payer, passes a clean one, and with no list says unscreened", async () => {
  __resetPayoutListForTests();
  __resetSettleComplianceForTests();
  assert.equal(await screenOwnSettlerPayer(CLEAN), "unscreened");
  assert.equal(settleComplianceView().ownScreenUnscreened, 1);
  __seedPayoutListForTests();
  assert.equal(await screenOwnSettlerPayer(LISTED), "listed");
  assert.equal(await screenOwnSettlerPayer(LISTED.toUpperCase().replace("0X", "0x")), "listed", "case does not hide an EVM address");
  assert.equal(await screenOwnSettlerPayer(CLEAN), "clear");
  __resetPayoutListForTests();
});
const TOKEN = "0x" + "33".repeat(20), TREASURY = "0x" + "44".repeat(20);
const relayerOf = (screen) => createOwnRelayerClient({ key: "0x" + "59".repeat(32), network: RH, asset: TOKEN, payTo: TREASURY, rpcUrl: "http://127.0.0.1:1", minUnits: 1n, log: quiet, leaseImpl: async (_k, fn) => fn({ stillHeld: () => true }), screen });
const reqs = { network: RH, scheme: "exact", asset: TOKEN, payTo: TREASURY, amount: "10000", maxTimeoutSeconds: 60 };
const payloadFrom = (from) => ({ x402Version: 2, accepted: reqs, payload: { signature: "0x" + "00".repeat(65), authorization: { from, to: TREASURY, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: "0x" + "66".repeat(32) } } });
await check("own relayer: a listed payer is refused before anything is read or sent", async () => {
  __resetSettleComplianceForTests();
  const screened = [];
  const r = await relayerOf(async (a) => { screened.push(a); return a === LISTED ? "listed" : "clear"; }).settle(payloadFrom(LISTED), reqs);
  assert.deepEqual(screened, [LISTED]);
  assert.equal(r.success, false);
  assert.equal(r.errorReason, OWN_SETTLER_SCREEN_REFUSED);
  assert.equal(r.nothingSent, true);
  assert.equal(r.transaction, "");
  assert.ok(isComplianceSettleRefusal(r));
  assert.equal(settleComplianceView().ownScreenRefused, 1);
});
await check("own relayer: a clean payer passes the screen to the settle", async () => {
  const screened = [];
  const r = await relayerOf(async (a) => { screened.push(a); return "clear"; }).settle(payloadFrom(CLEAN), reqs);
  assert.deepEqual(screened, [CLEAN]);
  assert.notEqual(r.errorReason, OWN_SETTLER_SCREEN_REFUSED, "the screen did not refuse it");
});

// --- the 402 -----------------------------------------------------------------
await check("402: the receipt reads as refused by the settlement provider's compliance check, charged false, do-not-retry", () => {
  const receipt = complianceRefusedResult({ network: BASE, payer: CLEAN });
  const b64 = Buffer.from(JSON.stringify(receipt)).toString("base64");
  const body = complianceSettleRefusal(b64);
  assert.equal(body.reason, "settlement-compliance-refused");
  assert.equal(body.charged, false);
  assert.equal(body.retry, "do-not-retry");
  assert.equal(body.network, BASE);
  assert.match(body.detail, /settlement provider's compliance check refused this payment/);
  assert.match(body.detail, /nothing was charged/);
  const own = complianceSettleRefusal(complianceRefusedResult({ network: RH, own: true }));
  assert.match(own.detail, /sanctions screening refused this payment/);
  assert.equal(complianceSettleRefusal({ success: false, errorReason: "insufficient_funds" }), null, "another receipt is not this");
  assert.ok(REJECTION_REASONS.some((r) => r.reason === "settlement-compliance-refused"), "/x402-test documents the class");
  const hint = readFileSync(new URL("../src/verify-hint.js", import.meta.url), "utf8");
  assert.match(hint, /complianceSettleRefusal\(settled\)[\s\S]{0,400}charged: false/, "the 402 body carries charged: false");
});
await check("operator count: per network, never an address", () => {
  const v = JSON.stringify(settleComplianceView());
  assert.ok(!/0x[0-9a-f]{40}/i.test(v), v);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
