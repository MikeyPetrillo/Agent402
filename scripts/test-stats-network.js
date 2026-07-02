// Unit tests for the settle-receipt network decoder — the pure function that
// turns an X-PAYMENT-RESPONSE header into the short chain name behind
// /api/stats.toolCallsServed.viaUSDCByNetwork. Defensive by contract: any
// shape surprise must yield null, never a throw (it runs inside the tally
// middleware on every paid response).
import { networkFromPaymentResponse } from "../src/stats.js";

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
ok(networkFromPaymentResponse(b64({ network: "eip155:43114" })) === "eip155:43114", "unknown CAIP-2 passes through raw");

// Defensive cases: all null, never a throw.
ok(networkFromPaymentResponse(b64({ success: true })) === null, "receipt without network → null");
ok(networkFromPaymentResponse(b64({ network: 42 })) === null, "non-string network → null");
ok(networkFromPaymentResponse("!!!not-base64-json!!!") === null, "garbage header → null");
ok(networkFromPaymentResponse("") === null, "empty header → null");
ok(networkFromPaymentResponse(undefined) === null, "missing header → null");
ok(networkFromPaymentResponse(12345) === null, "non-string header → null");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
