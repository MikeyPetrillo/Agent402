// Unit tests for the settle-receipt decoders — the pure functions behind
// /api/stats.toolCallsServed.viaUSDCByNetwork and the charged-but-failed vs
// settle-failed classification. Defensive by contract: any shape surprise
// must yield null, never a throw (they run inside the tally middleware on
// every paid response).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { networkFromPaymentResponse, decodeSettleReceipt } from "../src/stats.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

// x402 v2 receipts carry CAIP-2 network ids.
ok(networkFromPaymentResponse(b64({ success: true, transaction: "0xabc", network: "eip155:8453", payer: "0x1" })) === "base", "eip155:8453 → base");
ok(networkFromPaymentResponse(b64({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })) === "solana", "solana mainnet CAIP-2 → solana");
ok(networkFromPaymentResponse(b64({ network: "eip155:137" })) === "polygon", "eip155:137 → polygon");
ok(networkFromPaymentResponse(b64({ network: "eip155:42161" })) === "arbitrum", "eip155:42161 → arbitrum");

// v1-style receipts used short names — pass them through unchanged.
ok(networkFromPaymentResponse(b64({ network: "base" })) === "base", "short name passes through");

// A chain we don't know yet must still be attributed, not dropped.
ok(networkFromPaymentResponse(b64({ network: "eip155:9999999" })) === "eip155:9999999", "unknown CAIP-2 passes through raw");

// Defensive cases: all null, never a throw.
ok(networkFromPaymentResponse(b64({ success: true })) === null, "receipt without network → null");
ok(networkFromPaymentResponse(b64({ network: 42 })) === null, "non-string network → null");
ok(networkFromPaymentResponse("!!!not-base64-json!!!") === null, "garbage header → null");
ok(networkFromPaymentResponse("") === null, "empty header → null");
ok(networkFromPaymentResponse(undefined) === null, "missing header → null");
ok(networkFromPaymentResponse(12345) === null, "non-string header → null");

// --- decodeSettleReceipt: the charged-vs-rejected discriminator ---
// The middleware attaches PAYMENT-RESPONSE to settle FAILURES too, so the
// classification contract is: explicit success:false = rejection (buyer NOT
// charged); anything else with the header present stays in the worst-case
// charged bucket (fail-loud).
const okReceipt = { success: true, transaction: "0xabc", network: "eip155:8453", payer: "0x1" };
ok(decodeSettleReceipt(b64(okReceipt))?.success === true, "success:true receipt decodes with success true");
const failReceipt = { success: false, errorReason: "insufficient_funds", errorMessage: "balance too low", network: "eip155:4663", transaction: "" };
ok(decodeSettleReceipt(b64(failReceipt))?.success === false, "success:false receipt decodes with success false");
ok(decodeSettleReceipt(b64(failReceipt))?.errorReason === "insufficient_funds", "failure receipt exposes errorReason");
// Legacy/odd receipts without a success field must NOT read as success:false
// (they stay in the charged bucket at the call site).
ok(decodeSettleReceipt(b64({ network: "base" }))?.success === undefined, "receipt without success field decodes, success undefined");
// Defensive cases: null, never a throw.
ok(decodeSettleReceipt(b64([1, 2, 3])) === null, "array receipt → null");
ok(decodeSettleReceipt(b64("just a string")) === null, "non-object JSON → null");
ok(decodeSettleReceipt("!!!not-base64-json!!!") === null, "garbage header → null");
ok(decodeSettleReceipt("") === null, "empty header → null");
ok(decodeSettleReceipt(undefined) === null, "missing header → null");
ok(decodeSettleReceipt(12345) === null, "non-string header → null");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
