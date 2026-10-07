// Offline unit test for the verify-time Algorand validity guard
// (src/avm-validity.js). Crafts real algosdk txns, wraps them in x402 payment
// headers, and checks the pure decision function against a fixed current round.
// No network, no server boot.
import assert from "node:assert";
import algosdk from "algosdk";
import {
  checkAvmValidity,
  lastValidFromPaymentHeader,
  requiredSecondsFor,
} from "../src/avm-validity.js";

const ADDR = "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE";
const GENESIS = new Uint8Array(Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"));

function makeHeader({ firstValid, lastValid, network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", paymentIndex = 0, extraTxns = [] }) {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: ADDR,
    receiver: ADDR,
    amount: 0,
    suggestedParams: {
      fee: 1000, flatFee: true, minFee: 1000,
      firstValid, lastValid,
      genesisHash: GENESIS, genesisID: "mainnet-v1.0",
    },
  });
  const group = [...extraTxns, Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64")];
  const payload = { x402Version: 2, scheme: "exact", network, payload: { paymentGroup: group, paymentIndex } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

const ROUND = 63_360_000;
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

ok("decodes lastValid from an unsigned payment txn header", () => {
  const h = makeHeader({ firstValid: ROUND, lastValid: ROUND + 10 });
  assert.strictEqual(Number(lastValidFromPaymentHeader(h)), ROUND + 10);
});

ok("paymentIndex selects the buyer txn, not a fee-payer txn", () => {
  const feePayer = makeHeader({ firstValid: ROUND, lastValid: ROUND + 5 });
  const fpTxnB64 = JSON.parse(Buffer.from(feePayer, "base64").toString("utf8")).payload.paymentGroup[0];
  const h = makeHeader({ firstValid: ROUND, lastValid: ROUND + 1000, paymentIndex: 1, extraTxns: [fpTxnB64] });
  assert.strictEqual(Number(lastValidFromPaymentHeader(h)), ROUND + 1000);
});

ok("non-AVM (EVM) header is ignored", () => {
  const evm = Buffer.from(JSON.stringify({
    x402Version: 2, scheme: "exact", network: "eip155:8453",
    payload: { authorization: { from: "0x902dCf34E53695bDEA2fFB354b1a2e58bD598256" } },
  })).toString("base64");
  assert.strictEqual(lastValidFromPaymentHeader(evm), null);
  checkAvmValidity(evm, "image-gen-premium", ROUND); // must not throw
});

ok("garbage header fails open", () => {
  assert.strictEqual(lastValidFromPaymentHeader("not-base64-json"), null);
  checkAvmValidity("not-base64-json", "image-gen-premium", ROUND);
  checkAvmValidity(null, "image-gen-premium", ROUND);
});

ok("default 10-round window passes a normal tool (default 20s requirement)", () => {
  // 10 rounds ≈ 28s remaining > 20s required
  checkAvmValidity(makeHeader({ firstValid: ROUND, lastValid: ROUND + 10 }), "hash", ROUND);
});

ok("default 10-round window is rejected for image-gen-premium with a self-explaining 422", () => {
  const h = makeHeader({ firstValid: ROUND, lastValid: ROUND + 10 });
  assert.throws(
    () => checkAvmValidity(h, "image-gen-premium", ROUND),
    (e) => e.statusCode === 422 &&
      /validity window too short/.test(e.message) &&
      /setDefaultValidityWindow/.test(e.message) &&
      /not been charged/.test(e.message),
  );
});

ok("1000-round window passes image-gen-premium", () => {
  checkAvmValidity(makeHeader({ firstValid: ROUND, lastValid: ROUND + 1000 }), "image-gen-premium", ROUND);
});

ok("already-expired txn is rejected even for a fast tool", () => {
  const h = makeHeader({ firstValid: ROUND - 100, lastValid: ROUND - 1 });
  assert.throws(() => checkAvmValidity(h, "hash", ROUND), (e) => e.statusCode === 422);
});

ok("unknown current round fails open", () => {
  const h = makeHeader({ firstValid: ROUND, lastValid: ROUND + 1 });
  checkAvmValidity(h, "image-gen-premium", null);
});

ok("requiredSecondsFor: slow map + default", () => {
  assert.strictEqual(requiredSecondsFor("image-gen-premium"), 90);
  assert.strictEqual(requiredSecondsFor("hash"), 20);
});

ok("route-execute keeps the default window (its external leg runs under its own budget)", () => {
  assert.strictEqual(requiredSecondsFor("route-execute-pro"), 20);
  const h = makeHeader({ firstValid: ROUND, lastValid: ROUND + 10 });
  assert.doesNotThrow(() => checkAvmValidity(h, "route-execute-pro", ROUND));
});

console.log(`\ntest-avm-validity: ${passed} passed`);
