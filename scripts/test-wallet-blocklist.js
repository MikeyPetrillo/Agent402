// Unit tests for the WALLET_BLOCKLIST payer matcher — the pure function behind
// the beforeSettle abort that refuses service to blocked wallets WITHOUT
// charging them. Env is read at call time, so each case just sets the var.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { blockedPayerFromPayload, registerWalletBlocklistPayerEnrichment } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const EVM = "0xFedA7403aabe9A492eD70e810B396D8548A4A022";
const SOL = "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o";
const ALGO = "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE";
const evmPayload = { payload: { authorization: { from: EVM } } };

// Unset / empty → never blocks.
delete process.env.WALLET_BLOCKLIST;
ok(blockedPayerFromPayload(evmPayload) === null, "no env → null");
process.env.WALLET_BLOCKLIST = " , ,";
ok(blockedPayerFromPayload(evmPayload) === null, "whitespace/junk-only list → null");

// EVM: case-insensitive both directions (normalized to lowercase).
process.env.WALLET_BLOCKLIST = EVM; // checksum case in env
ok(blockedPayerFromPayload({ payload: { authorization: { from: EVM.toLowerCase() } } }) === EVM.toLowerCase(), "EVM blocked: lowercase payload vs checksum env");
ok(blockedPayerFromPayload(evmPayload) === EVM.toLowerCase(), "EVM blocked: checksum payload vs checksum env");
ok(blockedPayerFromPayload({ payload: { authorization: { from: "0x" + "1".repeat(40) } } }) === null, "different EVM wallet → null");

// Non-EVM (SVM/Stellar/AVM): the raw client payload NEVER carries a payer
// field - real wire shapes are { payload: { transaction: "<base64>" } } for
// SVM/Stellar and { payload: { paymentGroup: [...], paymentIndex } } for AVM.
// The payer only exists on the verify() RESULT, enriched onto the payload via
// registerWalletBlocklistPayerEnrichment's onAfterVerify hook (__verifiedPayer)
// - the earlier version of this test used a fabricated { payload: { payer } }
// shape that no real SDK ever produces, which is exactly what let the
// non-EVM-payer gap ship unnoticed (see payments.js's doc comment).
process.env.WALLET_BLOCKLIST = `${SOL},${ALGO}`;
ok(blockedPayerFromPayload({ payload: { transaction: "AAAA..." }, __verifiedPayer: SOL }) === SOL, "Solana payer blocked via __verifiedPayer (post-enrichment)");
ok(blockedPayerFromPayload({ payload: { paymentGroup: ["AAAA"], paymentIndex: 0 }, __verifiedPayer: ALGO }) === ALGO, "Algorand payer blocked via __verifiedPayer (post-enrichment)");
ok(blockedPayerFromPayload({ payload: { transaction: "AAAA..." } }) === null, "Solana payload with NO enrichment (pre-fix behavior) → null, not a false negative on a wallet that isn't actually blocked");
ok(blockedPayerFromPayload(evmPayload) === null, "EVM wallet not in the non-EVM list → null");

// Defensive: shapes that carry no payer never match, never throw.
process.env.WALLET_BLOCKLIST = EVM;
ok(blockedPayerFromPayload({}) === null, "empty payload → null");
ok(blockedPayerFromPayload(undefined) === null, "missing payload → null");
ok(blockedPayerFromPayload({ payload: { authorization: { from: 42 } } }) === null, "non-string from → null");

delete process.env.WALLET_BLOCKLIST;

// ---- registerWalletBlocklistPayerEnrichment: the onAfterVerify hook itself ----
// Fake server stub that just captures the registered hook, matching the real
// @x402/core server's onAfterVerify(hook) signature.
function fakeServer() {
  let hook;
  return { onAfterVerify: (h) => { hook = h; }, run: (ctx) => hook(ctx) };
}

{
  const server = fakeServer();
  registerWalletBlocklistPayerEnrichment(server);
  const payload = { payload: { transaction: "AAAA..." } };
  server.run({ result: { isValid: true, payer: SOL }, paymentPayload: payload });
  ok(payload.__verifiedPayer === SOL, "enrichment hook stashes verify()'s payer onto the SAME payload object");
}

{
  // EVM payloads already carry a real, signature-covered payer
  // (authorization.from) - the enrichment must not touch them at all, since
  // overwriting with a facilitator-reported value would trade a
  // signature-covered field for an unauthenticated one.
  const server = fakeServer();
  registerWalletBlocklistPayerEnrichment(server);
  const payload = { payload: { authorization: { from: EVM } } };
  server.run({ result: { isValid: true, payer: "some-other-address" }, paymentPayload: payload });
  ok(payload.__verifiedPayer === undefined, "enrichment hook never touches an EVM payload (authorization.from already present)");
}

{
  // No payer on the verify result (e.g. isValid:false, or a scheme this
  // hook doesn't know about) - must not throw, must not attach anything.
  const server = fakeServer();
  registerWalletBlocklistPayerEnrichment(server);
  const payload = { payload: { transaction: "AAAA..." } };
  server.run({ result: { isValid: false, invalidReason: "expired" }, paymentPayload: payload });
  ok(payload.__verifiedPayer === undefined, "enrichment hook is a no-op when the verify result carries no payer");
}

{
  // End-to-end shape: enrichment runs at afterVerify, blockedPayerFromPayload
  // runs at beforeSettle - same payload object, same request, matching the
  // real @x402/core request lifecycle where both hooks share one paymentPayload reference.
  const server = fakeServer();
  registerWalletBlocklistPayerEnrichment(server);
  process.env.WALLET_BLOCKLIST = SOL;
  const payload = { payload: { transaction: "AAAA..." } };
  server.run({ result: { isValid: true, payer: SOL }, paymentPayload: payload });
  ok(blockedPayerFromPayload(payload) === SOL, "end-to-end: afterVerify enrichment + beforeSettle matcher together block a non-EVM wallet");
  delete process.env.WALLET_BLOCKLIST;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
