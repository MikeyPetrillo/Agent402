// Regression test for payerFromRequest — locks the fix for the header bug that
// silently attributed every standard-X-PAYMENT buyer to null, which broke
// wallet-keyed memory (400 after charging) and nulled payer analytics. The
// existing suites can't catch it: test-memory injects `actor` directly and
// never goes through the HTTP header. Pure-function, offline.
import { payerFromRequest, payerFromPaymentResponse, normalizePayerAddress } from "../src/payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const req = (headers) => ({ header: (k) => headers[String(k).toLowerCase()] ?? null });
const enc = (from) => Buffer.from(JSON.stringify({ payload: { authorization: { from } } })).toString("base64");
const A = "0xAbC0000000000000000000000000000000000001";
const B = "0xDdD0000000000000000000000000000000000002";

ok(payerFromRequest(req({ "x-payment": enc(A) })) === A.toLowerCase(),
  "reads the standard X-PAYMENT header (the bug returned null here)");
ok(payerFromRequest(req({ "payment-signature": enc(A) })) === A.toLowerCase(),
  "still reads the legacy payment-signature header");
// PRECEDENCE REVERSED 2026-08-04 — this assertion used to demand the opposite,
// and in doing so it PINNED a vulnerability in place.
//
// @x402/express settles from `payment-signature` first, falling back to
// `x-payment`. Attributing in the opposite order meant a request carrying BOTH
// was settled from one header and attributed from the other, and the second
// copy is signature-checked by nothing. An attacker paid with their own valid
// PAYMENT-SIGNATURE and added an X-Payment naming a victim; since memory
// namespaces are wallet-keyed ("payment = identity"), that was a namespace
// takeover for the price of one call.
//
// Attribution must read whatever settlement reads. Single-header clients are
// unaffected either way - the fallback still covers them, which the two
// assertions above prove.
ok(payerFromRequest(req({ "x-payment": enc(B), "payment-signature": enc(A) })) === A.toLowerCase(),
  "the SETTLED header (payment-signature) wins when both are present - an unsigned x-payment cannot name a victim");
ok(payerFromRequest(req({})) === null, "no payment header → null");
ok(payerFromRequest(req({ "x-payment": "not-base64-json!" })) === null, "garbage header → null, no throw");
ok(payerFromRequest(req({ "x-payment": Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xNOTHEX" } } })).toString("base64") })) === null,
  "well-formed payload with an invalid address → null");
ok(payerFromRequest(req({ "x-payment": Buffer.from(JSON.stringify({ from: A })).toString("base64") })) === null,
  "top-level `from` (unsigned field) is NOT accepted — only authorization.from");

// Receipt fallback — the facilitator-verified payer on chains whose request
// payloads carry no EIP-3009 authorization (SVM, Stellar, Algorand).
const receipt = (payer) => Buffer.from(JSON.stringify({ success: true, transaction: "sig", network: "solana", payer })).toString("base64");
const SOL = "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o";
const STL = "GBA2DDJ4KQXQCGNB7RUU5I2BK5SXROJFUNZV7EZ4XUS7RXFOXEPNY6O4";
const ALGO = "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE";
ok(payerFromPaymentResponse(receipt(SOL)) === SOL, "settle receipt yields the Solana payer, case preserved");
ok(payerFromPaymentResponse(receipt(STL)) === STL, "settle receipt yields the Stellar payer");
ok(payerFromPaymentResponse(receipt(ALGO)) === ALGO, "settle receipt yields the Algorand payer, case preserved");
ok(payerFromPaymentResponse(receipt(A)) === A.toLowerCase(), "EVM payer from receipt normalizes to lowercase");
ok(payerFromPaymentResponse(receipt("l0Il0Il0")) === null, "non-address payer string → null (0/I/l are not base58 anyway)");
ok(payerFromPaymentResponse("garbage!") === null, "garbage receipt → null, no throw");
ok(payerFromPaymentResponse(null) === null, "missing receipt → null");
ok(normalizePayerAddress(SOL.toLowerCase()) === null || normalizePayerAddress(SOL.toLowerCase()) !== SOL,
  "lowercased base58 does NOT round-trip to the original — why the sales ledger must not lowercase non-EVM payers");
ok(normalizePayerAddress(ALGO) === ALGO, "normalizePayerAddress accepts the 58-char Algorand base32 address, case preserved");
ok(normalizePayerAddress(ALGO.toLowerCase()) !== ALGO, "lowercased Algorand address does NOT round-trip — never lowercase it");
// payerFromRequest is EVM-only BY DESIGN — Algorand's AVM scheme signs no
// EIP-3009 authorization.from, so this request path must reject it exactly
// like Solana/Stellar (never weaken it to accept non-EVM addresses).
ok(payerFromRequest(req({ "x-payment": enc(ALGO) })) === null,
  "payerFromRequest rejects an Algorand address — that path is EIP-3009/EVM-only by design");

// A Permit2 payment is verified on permit2Authorization; an `authorization`
// block riding beside it is unsigned there and must never name the payer.
{
  const SIGNER = "0x1111111111111111111111111111111111111111", VICTIM = "0x2222222222222222222222222222222222222222";
  const p2 = (payload) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload })).toString("base64");
  const permit = { from: SIGNER, permitted: { token: SIGNER, amount: "1" }, spender: SIGNER, nonce: "1", deadline: "1" };
  ok(payerFromRequest(req({ "payment-signature": p2({ signature: "0x", permit2Authorization: permit, authorization: { from: VICTIM } }) })) === null,
    "a Permit2 payment naming a different authorization.from has no payer (the forged identity is refused)");
  ok(payerFromRequest(req({ "payment-signature": p2({ signature: "0x", permit2Authorization: permit }) })) === SIGNER,
    "a Permit2 payment's payer is the Permit2 signer");
  ok(payerFromRequest(req({ "payment-signature": p2({ signature: "0x", permit2Authorization: permit, authorization: { from: SIGNER.toUpperCase().replace("0X", "0x") } }) })) === SIGNER,
    "a matching authorization.from beside Permit2 is the same payer");
  ok(payerFromRequest(req({ "payment-signature": p2({ signature: "0x", permit2Authorization: { permitted: {} }, authorization: { from: VICTIM } }) })) === null,
    "a Permit2 block with no signer names nobody");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
