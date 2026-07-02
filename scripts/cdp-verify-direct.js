// THE definitive test: sign a real Base-mainnet payment against a running
// local server's 402, then call CDP's /verify DIRECTLY with that payload and
// print CDP's literal verdict. CDP is proven healthy + supports the kind, and
// PayAI settles the same payload — so this isolates the exact server→CDP
// /verify failure with CDP's own words (isValid + invalidReason, or the raw
// thrown error/response).
//
//   TARGET_URL=http://localhost:3777 KEY_FILE=/tmp/burner-key \
//   CDP_API_KEY_ID=.. CDP_API_KEY_SECRET=.. node scripts/cdp-verify-direct.js
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createFacilitatorConfig } from "@coinbase/x402";

const TARGET = process.env.TARGET_URL || "http://localhost:3777";
const account = privateKeyToAccount(readFileSync(process.env.KEY_FILE, "utf8").trim());
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// 1. Get a 402 challenge from the (CDP-configured) server.
const res = await fetch(`${TARGET}/api/hash`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "cdp-verify-direct" }),
});
console.log(`challenge HTTP ${res.status}`);
const hdr = res.headers.get("payment-required") || res.headers.get("x-payment-required");
if (!hdr) { console.log("no PAYMENT-REQUIRED header; body:", (await res.text()).slice(0, 300)); process.exit(0); }
let paymentRequired;
try {
  paymentRequired = decodePaymentRequiredHeader(hdr);
} catch {
  paymentRequired = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
}
const accepts = paymentRequired.accepts || [];
console.log(`accepts (${accepts.length}):`);
for (const a of accepts) console.log(`  ${a.network} ${a.scheme} asset=${a.asset} payTo=${a.payTo} max=${a.maxAmountRequired} extra=${JSON.stringify(a.extra || {})}`);
console.log(`top-level extensions on challenge: ${JSON.stringify(Object.keys(paymentRequired.extensions || {}))}`);

// 2. Sign the payment (buyer side) — the client selects a requirement.
let paymentPayload;
try {
  paymentPayload = await client.createPaymentPayload(paymentRequired);
} catch (e) {
  console.log("createPaymentPayload THREW (client cannot sign this challenge):", e?.message);
  process.exit(0);
}
const chosen = paymentPayload.accepted || accepts.find((a) => String(a.network) === "eip155:8453");
console.log(`\nsigned payment for: ${chosen?.network} ${chosen?.scheme}`);
console.log(`payload x402Version=${paymentPayload.x402Version} extensions=${JSON.stringify(Object.keys(paymentPayload.extensions || {}))}`);

// 3. Call CDP /verify DIRECTLY with exactly this payload + requirement.
const cdp = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
console.log("\n=== calling CDP /verify directly ===");
try {
  const vr = await cdp.verify(paymentPayload, chosen);
  console.log("CDP VERIFY RETURNED:", JSON.stringify(vr));
} catch (e) {
  console.log("CDP VERIFY THREW:", e?.constructor?.name || "", "|", e?.message || String(e));
  for (const k of Object.keys(e || {})) {
    let v; try { v = JSON.stringify(e[k]); } catch { v = String(e[k]); }
    console.log(`   e.${k} = ${String(v).slice(0, 400)}`);
  }
  if (e?.cause) console.log("   e.cause =", e.cause?.message || String(e.cause), e.cause?.code || "");
}
