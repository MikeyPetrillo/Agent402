// Live Robinhood Chain / USDG settlement test. Points the x402 buyer SDK at a
// Robinhood-ONLY server, so the only payment option is USDG on chain 4663 via
// the r402 (MPP) facilitator, then buys one cheap tool with the burner key — a
// real on-chain USDG settlement. Confirms the burner holds USDG first and prints
// the settlement transaction (and the facilitator's reason on failure, so a
// wrong EIP-712 version is obvious).
//
//   FACILITATOR_URL=https://mpp.hyreagent.fun/r402 NETWORK=robinhood \
//   PAYMENT_NETWORKS=robinhood WALLET_ADDRESS=<revenue-evm> PORT=3790 node src/server.js &
//   TARGET_URL=http://localhost:3790 KEY_FILE=/tmp/burner-key node scripts/rh-settle-test.js
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = process.env.TARGET_URL || "http://localhost:3790";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RH_RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const account = privateKeyToAccount(readFileSync(process.env.KEY_FILE, "utf8").trim());
console.log("buyer (burner):", account.address);

async function rpc(method, params) {
  const r = await fetch(RH_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  return (await r.json()).result;
}

// 0. Confirm the burner actually holds USDG on chain 4663 before we try to spend it.
const balHex = await rpc("eth_call", [
  { to: USDG, data: "0x70a08231" + account.address.slice(2).toLowerCase().padStart(64, "0") },
  "latest",
]);
const bal = BigInt(balHex && balHex !== "0x" ? balHex : "0x0");
console.log("burner USDG balance on chain 4663:", (Number(bal) / 1e6).toFixed(6), "USDG");
if (bal === 0n) {
  console.log(">>> burner holds 0 USDG on Robinhood Chain — fund it, then retry");
  process.exit(2);
}

// 1. Buy one cheap tool. The server offers only Robinhood/USDG, so the buyer must
//    sign a USDG transferWithAuthorization on chain 4663; r402 verifies + settles.
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

let res;
try {
  res = await payFetch(`${TARGET}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ text: "robinhood-usdg-live-settle" }),
  });
} catch (e) {
  console.log(">>> buyer threw (could not negotiate/sign):", e?.message || String(e));
  process.exit(1);
}
console.log("buy HTTP", res.status);

const settle = res.headers.get("payment-response") || res.headers.get("x-payment-response");
if (settle) {
  try {
    const d = JSON.parse(Buffer.from(settle, "base64").toString("utf8"));
    console.log("SETTLE RECEIPT:", JSON.stringify(d));
    if (d.transaction) {
      console.log(`✅ Robinhood Chain USDG settlement tx: ${d.transaction}`);
      console.log(`   explorer: https://robinhoodchain.blockscout.com/tx/${d.transaction}`);
    }
  } catch { console.log("settle header (raw):", settle.slice(0, 300)); }
}

if (res.status !== 200) {
  const h = res.headers.get("payment-required");
  if (h) {
    try {
      const dec = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (dec?.error) console.log(">>> facilitator reason:", dec.error);
    } catch {}
  }
  const body = await res.text();
  console.log("body:", body.slice(0, 300));
}

console.log(res.status === 200 ? "PASS: live USDG settlement on Robinhood Chain" : "FAIL: did not settle");
process.exit(res.status === 200 ? 0 : 1);
