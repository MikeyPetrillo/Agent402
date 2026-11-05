#!/usr/bin/env node
// Robinhood (eip155:4663) settle refusals in words. A listed facilitator that
// answers HTTP 200 {success:false, transaction:""} with a prose errorReason
// that is not a verdict about the buyer passes the payment to the NEXT LISTED
// facilitator, before our own relayer and the default chain; when none of them
// settles it, that refusal is read on chain (the outage handler) before our
// relayer may submit. A prose verdict about the buyer (a bad signature, too
// little balance, an expired window) is retried nowhere; a used authorization
// is handed to no other settler but is read on chain (the facilitator's own
// earlier submission may have used it). An HTTP 5xx, a transport failure and
// every other network keep the old rules: their words are never a verdict.
// Offline: the real failure hook (src/payments.js), stub facilitators, a stub
// outage handler.
//   node scripts/test-rh-prose-refusal.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { SettleError } from "@x402/core/types";

process.env.PAYMENT_SETTLE_FALLBACK = "true";
const { registerFacilitatorFailureHooks, isListedPassOnRefusal, markGracefulRefusals, gracefulRefusalOf } = await import("../src/payments.js");
const { isPaymentVerdictReason, isUsedAuthorizationReason } = await import("../src/settle-verdict.js");
const { isAmbiguousSettleFailure } = await import("../src/robinhood-outage.js");
const { __resetSettlementClaims } = await import("../src/settlement-claims.js");

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack?.split("\n").slice(0, 2).join(" | ") || e.message}`); }
};

const RH = "eip155:4663", CELO = "eip155:42220";
const TOKEN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TREASURY = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const SIGNATURE = 'Signature does not authorize this transfer for 0x00000000000000000000000000000000000a0001 (EIP-712 domain "Global Dollar" v1 on chain 4663)';
const BALANCE = "Insufficient balance: payer holds 0 of the 2500 required";
const NONCE_USED = "Authorization nonce already used";
const FIAT_USED = "FiatTokenV2: authorization is used or canceled";
const EXPIRED = "Authorization expired (validBefore has passed)";
const NO_VERDICT = "Relay temporarily unavailable, try again";
const GAS = "Facilitator signer has insufficient funds for gas";
let seq = 0;
const txh = (s) => `0x${Buffer.from(String(s)).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const payment = (network = RH) => {
  seq++;
  const from = `0x${(0xa000 + seq).toString(16).padStart(40, "0")}`;
  return {
    requirements: { scheme: "exact", network, asset: TOKEN, amount: "2500", payTo: TREASURY, maxTimeoutSeconds: 300 },
    paymentPayload: { x402Version: 2, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: TREASURY, value: "2500", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: txh(`n-${seq}-${Math.random()}`) } } },
  };
};
// What @x402/core hands the failure hook for a graceful {success:false}:
// a SettleError(500) built from the result (settleResponseToError).
const asCoreError = (result) => new SettleError(500, { ...result, errorReason: result.errorReason || "Settlement failed" });
const graceful = (reason, network = RH) => ({ success: false, errorReason: reason, transaction: "", payer: "", network });

/** One failed settlement through the real hook. The primary is a marked stub
 *  that answers `primary` (a result, or throws); `listed` are the listed
 *  fallbacks; our relayer and the default chain follow them, as at boot. */
async function run({ network = RH, primary, listed = [], withOwn = true, outage = null }) {
  __resetSettlementClaims();
  const asked = [];
  const p = payment(network);
  const prim = markGracefulRefusals({ settle: async () => { asked.push("primary"); return primary(); } });
  let error;
  try {
    const r = await prim.settle(p.paymentPayload, p.requirements);
    error = asCoreError(r);
  } catch (e) { error = e; }
  const stub = (name, answer, extra = {}) => ({ name, ...extra, client: { settle: async () => { asked.push(name); return answer(); } } });
  const candidates = [
    ...listed.map(([name, answer]) => stub(name, answer, { revertRetry: true, confirmed: true })),
    ...(withOwn ? [stub("own", () => ({ success: true, transaction: txh(`own-${seq}`), network }), { revertRetry: true, confirmed: true, own: true })] : []),
    stub("Solvador", () => ({ success: true, transaction: txh(`default-${seq}`), network })),
  ];
  const hooks = {};
  const server = { onVerifyFailure() { return this; }, onAfterVerify() { return this; }, onAfterSettle() { return this; }, onSettleFailure(fn) { hooks.fail = fn; return this; } };
  const handled = [];
  const outageStub = outage ? { network: RH, handle: async (ctx) => { handled.push(ctx?.paymentPayload === p.paymentPayload); asked.push("outage"); return outage(p); } } : null;
  registerFacilitatorFailureHooks(server, null, null, { [network]: () => candidates }, { outageFor: (n) => (n === RH ? outageStub : null) });
  const out = await hooks.fail({ requirements: p.requirements, paymentPayload: p.paymentPayload, error });
  return { out, asked, handled, error, p };
}
const ok = (name) => () => ({ success: true, transaction: txh(`${name}-${seq}`), network: RH });
const served = (p) => ({ served: true, result: { success: true, transaction: txh(`chain-${seq}`), network: RH, payer: p.paymentPayload.payload.authorization.from } });

// ------------------------------------------------------------- classifiers
await check("a prose verdict about the buyer is a verdict; the settler's own trouble and other prose are not", () => {
  for (const r of [SIGNATURE, BALANCE, NONCE_USED, EXPIRED, "invalid_exact_evm_payload_signature", "insufficient_funds", "Transfer amount exceeds balance", "Authorization is not yet valid"]) assert.equal(isPaymentVerdictReason(r), true, r);
  for (const r of [NO_VERDICT, GAS, "invalid_exact_evm_transaction_failed", "unexpected_error", "Settlement failed", "", "Fee payer balance too low"]) assert.equal(isPaymentVerdictReason(r), false, r);
});
await check("a balance verdict names the buyer's balance; a node's bare funds or fee message is the settler's own wallet", () => {
  for (const r of ["ERC20: transfer amount exceeds balance", "Insufficient balance", "invalid_exact_evm_insufficient_balance", "insufficient_funds"]) assert.equal(isPaymentVerdictReason(r), true, r);
  for (const r of ["insufficient funds", "Insufficient funds", "insufficient funds for gas * price + value", "insufficient funds for transfer", "Insufficient funds to pay the network fee", "Insufficient balance for the network fee", "max fee per gas less than block base fee"]) assert.equal(isPaymentVerdictReason(r), false, r);
});
await check("a used authorization, as a code or in words, is its own class", () => {
  for (const r of [NONCE_USED, FIAT_USED, "EIP3009: authorization is used or canceled", "Authorization already used", "nonce has already been used", "invalid_exact_evm_nonce_already_used"]) assert.equal(isUsedAuthorizationReason(r), true, r);
  for (const r of [SIGNATURE, BALANCE, EXPIRED, NO_VERDICT, "invalid_exact_evm_payload_signature", "nonce too low", "already known", ""]) assert.equal(isUsedAuthorizationReason(r), false, r);
});
await check("isListedPassOnRefusal: a no-verdict refusal with no transaction, on 4663 only", () => {
  assert.equal(isListedPassOnRefusal(asCoreError(graceful(NO_VERDICT)), RH), true);
  assert.equal(isListedPassOnRefusal(asCoreError(graceful(GAS)), RH), true, "the settler's gas is not the buyer's verdict");
  assert.equal(isListedPassOnRefusal(asCoreError(graceful(NO_VERDICT)), "eip155:8453"), false, "Base keeps the old gate");
  assert.equal(isListedPassOnRefusal(asCoreError({ ...graceful(NO_VERDICT), transaction: txh("named") }), RH), false, "names a transaction");
  for (const r of [SIGNATURE, BALANCE, NONCE_USED, FIAT_USED, EXPIRED]) assert.equal(isListedPassOnRefusal(asCoreError(graceful(r)), RH), false, r);
  assert.equal(isListedPassOnRefusal(new SettleError(500, { success: false, errorReason: "", transaction: "", network: RH }), RH), false, "no reason");
  assert.equal(isListedPassOnRefusal(Object.assign(new Error(NO_VERDICT), { errorReason: NO_VERDICT, code: "ETIMEDOUT" }), RH), false, "transport");
});
await check("the outage read: words are a verdict on a graceful answer only; a used authorization never is; codes as before", () => {
  const g = { graceful: true };
  assert.equal(isAmbiguousSettleFailure(asCoreError(graceful(SIGNATURE)), g), false);
  assert.equal(isAmbiguousSettleFailure(asCoreError(graceful(NO_VERDICT)), g), true);
  for (const r of [SIGNATURE, EXPIRED, BALANCE, "Broadcast succeeded but receipt wait expired"]) assert.equal(isAmbiguousSettleFailure(new SettleError(502, graceful(r))), true, `HTTP 502 ${r}`);
  for (const r of [FIAT_USED, NONCE_USED, "Authorization already used", "invalid_exact_evm_nonce_already_used"]) {
    assert.equal(isAmbiguousSettleFailure(asCoreError(graceful(r)), g), true, `graceful ${r}`);
    assert.equal(isAmbiguousSettleFailure(new SettleError(502, graceful(r))), true, `HTTP 502 ${r}`);
  }
  for (const r of ["invalid_exact_evm_payload_signature", "invalid_exact_evm_insufficient_balance"]) {
    assert.equal(isAmbiguousSettleFailure(asCoreError(graceful(r)), g), false, `graceful ${r}`);
    assert.equal(isAmbiguousSettleFailure(new SettleError(502, graceful(r))), false, `HTTP 502 ${r}`);
  }
});
await check("markGracefulRefusals: a 200 refusal is noted, a thrown HTTP error clears it", async () => {
  const p = payment();
  let mode = "graceful";
  const c = markGracefulRefusals({ settle: async () => { if (mode === "graceful") return graceful(NO_VERDICT); throw new SettleError(502, graceful(NO_VERDICT)); } });
  await c.settle(p.paymentPayload, p.requirements);
  assert.equal(gracefulRefusalOf(p.paymentPayload), true);
  mode = "5xx";
  await assert.rejects(() => c.settle(p.paymentPayload, p.requirements));
  assert.equal(gracefulRefusalOf(p.paymentPayload), false);
});

// ------------------------------------------------------------- the chain
await check("primary refuses in words, no verdict -> the next listed facilitator settles; our relayer and the default chain are never asked", async () => {
  const { out, asked } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", ok("rh2")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2"]);
});
await check("two listed refuse in words -> the third listed settles", async () => {
  const { out, asked } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", () => graceful("Upstream RPC unavailable")], ["RH3", ok("rh3")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2", "RH3"]);
});
await check("every listed refuses in words -> read on chain once (outage), only then may our relayer act; never asked in the chain", async () => {
  const { out, asked, handled } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", () => graceful(NO_VERDICT)]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2", "outage"]);
  assert.deepEqual(handled, [true]);
});
await check("primary refuses in words, the next listed says the nonce is used -> read on chain (the first one's transfer may have landed)", async () => {
  const { out, asked } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", () => graceful(NONCE_USED)], ["RH3", ok("rh3")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2", "outage"], "a verdict stops the chain; the passed-on refusal is read on chain");
});
for (const [label, reason] of [["bad signature", SIGNATURE], ["insufficient buyer balance", BALANCE], ["expired", EXPIRED]]) {
  await check(`a prose buyer verdict (${label}) from the primary is retried nowhere: no listed, no relayer, no chain read`, async () => {
    const { out, asked } = await run({ primary: () => graceful(reason), listed: [["RH2", ok("rh2")]], outage: served });
    assert.equal(out, undefined);
    assert.deepEqual(asked, ["primary"]);
  });
}
for (const reason of [FIAT_USED, "Authorization already used", "nonce has already been used", "invalid_exact_evm_nonce_already_used"]) {
  await check(`a used authorization from the primary ("${reason}") goes to no other settler but is read on chain`, async () => {
    const { out, asked, handled } = await run({ primary: () => graceful(reason), listed: [["RH2", ok("rh2")]], outage: served });
    assert.equal(out?.recovered, true);
    assert.deepEqual(asked, ["primary", "outage"]);
    assert.deepEqual(handled, [true]);
  });
}
await check("a used authorization from a listed fallback (after a primary revert) is read on chain; the next listed is not asked", async () => {
  const { out, asked } = await run({ primary: () => ({ success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "", network: RH }), listed: [["RH2", () => graceful(FIAT_USED)], ["RH3", ok("rh3")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2", "outage"]);
});
await check("verdict words over an HTTP 5xx from the primary are read on chain (it may have broadcast)", async () => {
  for (const reason of [SIGNATURE, EXPIRED, "Broadcast succeeded but receipt wait expired"]) {
    const { out, asked } = await run({ primary: () => { throw new SettleError(502, graceful(reason)); }, listed: [["RH2", ok("rh2")]], outage: served });
    assert.equal(out?.recovered, true, reason);
    assert.deepEqual(asked, ["primary", "outage"], reason);
  }
});
await check("a prose buyer verdict from a listed fallback (after a primary revert) stops there", async () => {
  const { out, asked } = await run({ primary: () => ({ success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "", network: RH }), listed: [["RH2", () => graceful(SIGNATURE)], ["RH3", ok("rh3")]], outage: served });
  assert.equal(out, undefined);
  assert.deepEqual(asked, ["primary", "RH2"]);
});
await check("the same words over an HTTP 5xx keep the old rule: no listed fallback, straight to the chain read", async () => {
  const { out, asked } = await run({ primary: () => { throw new SettleError(502, graceful(NO_VERDICT)); }, listed: [["RH2", ok("rh2")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "outage"]);
});
await check("a listed fallback's HTTP 5xx in words after a pass-on stops the chain and is read on chain once", async () => {
  const { out, asked } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", () => { throw new SettleError(502, graceful(NO_VERDICT)); }], ["RH3", ok("rh3")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2", "outage"]);
});
await check("the chain read refuses after a pass-on and a listed 5xx: it ran once, the buyer gets 402", async () => {
  const { out, asked, handled } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", () => { throw new SettleError(502, graceful(NO_VERDICT)); }], ["RH3", ok("rh3")]], outage: () => ({ refused: true, lateAuth: null, reason: "stub refused" }) });
  assert.equal(out, undefined);
  assert.deepEqual(asked, ["primary", "RH2", "outage"]);
  assert.equal(handled.length, 1, "one chain read per payment");
});
await check("without our relayer (no outage handler): the next listed is still asked; none settles -> 402", async () => {
  const { out, asked } = await run({ primary: () => graceful(NO_VERDICT), listed: [["RH2", () => graceful(NO_VERDICT)]], withOwn: false, outage: null });
  assert.equal(out, undefined);
  assert.deepEqual(asked, ["primary", "RH2"]);
});
await check("the codes that already pass on still do: a revert reaches the listed fallback", async () => {
  const { out, asked } = await run({ primary: () => ({ success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "", network: RH }), listed: [["RH2", ok("rh2")]], outage: served });
  assert.equal(out?.recovered, true);
  assert.deepEqual(asked, ["primary", "RH2"]);
});
await check("another network keeps its rules: a no-verdict refusal in words there asks no fallback", async () => {
  const { out, asked } = await run({ network: CELO, primary: () => graceful(NO_VERDICT, CELO), listed: [["Celo2", () => ({ success: true, transaction: txh("celo"), network: CELO })]], outage: served });
  assert.equal(out, undefined);
  assert.deepEqual(asked, ["primary"]);
});

console.log(failures ? `\ntest-rh-prose-refusal: FAILED (${failures})` : "\ntest-rh-prose-refusal: all passed");
process.exit(failures ? 1 : 0);
