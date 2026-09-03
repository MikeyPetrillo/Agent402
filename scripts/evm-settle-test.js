// Per-chain EVM USDC settlement test. Boots a single-chain server (Polygon or
// Arbitrum via PayAI facilitator) and buys one cheap tool with the burner key.
// Confirms the burner holds USDC on that chain first, then verifies settlement.
//
// Usage:
//   CHAIN=polygon TARGET_URL=http://127.0.0.1:3791 KEY_FILE=/tmp/burner-key \
//     node scripts/evm-settle-test.js
//
// CHAIN must be "polygon" or "arbitrum". The server should already be booted
// with PAYMENT_NETWORKS=<chain> so the buyer's only option is that chain.
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const CHAIN = (process.env.CHAIN || "polygon").toLowerCase();
const TARGET = process.env.TARGET_URL || "http://127.0.0.1:3791";

const CHAINS = {
  polygon: {
    chainId: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcs: ["https://polygon-rpc.com", "https://polygon.drpc.org"],
    caip2: "eip155:137",
  },
  arbitrum: {
    chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
    caip2: "eip155:42161",
  },
};

const cfg = CHAINS[CHAIN];
if (!cfg) { console.log(`Unknown CHAIN="${CHAIN}" — use polygon or arbitrum`); process.exit(2); }

const account = privateKeyToAccount(readFileSync(process.env.KEY_FILE, "utf8").trim());
console.log(`chain: ${CHAIN} (${cfg.caip2})`);
console.log("buyer (burner):", account.address);

// --- RPC helper with fallback ---
async function rpc(method, params) {
  for (const url of cfg.rpcs) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch {}
  }
  return null;
}

// 0. Confirm the burner holds USDC on this chain.
const balHex = await rpc("eth_call", [
  { to: cfg.usdc, data: "0x70a08231" + account.address.slice(2).toLowerCase().padStart(64, "0") },
  "latest",
]);
const bal = BigInt(balHex && balHex !== "0x" ? balHex : "0x0");
console.log(`burner USDC balance on ${CHAIN} (chain ${cfg.chainId}):`, (Number(bal) / 1e6).toFixed(6), "USDC");
if (bal === 0n) {
  console.log(`>>> burner holds 0 USDC on ${CHAIN} — fund it, then retry`);
  process.exit(2);
}

// 1. Buy one cheap tool. The server offers only this chain, so the buyer's
//    ExactEvmScheme will sign a transferWithAuthorization for that network.
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

let res;
try {
  res = await payFetch(`${TARGET}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ text: `${CHAIN}-usdc-live-settle` }),
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
      const explorer = CHAIN === "polygon"
        ? `https://polygonscan.com/tx/${d.transaction}`
        : `https://arbiscan.io/tx/${d.transaction}`;
      console.log(`settlement tx: ${d.transaction}`);
      console.log(`   explorer: ${explorer}`);
    }
  } catch { console.log("settle header (raw):", settle.slice(0, 300)); }
}

if (res.status !== 200) {
  const h = res.headers.get("payment-required");
  if (h) {
    try {
      const dec = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (dec?.error) console.log(">>> facilitator reason:", dec.error);
      // Show which networks were offered
      if (dec?.accepts) console.log(">>> offered networks:", JSON.stringify(dec.accepts.map(a => a.network)));
    } catch {}
  }
  const body = await res.text();
  console.log("body:", body.slice(0, 300));
}

console.log(res.status === 200
  ? `PASS: live USDC settlement on ${CHAIN}`
  : `FAIL: did not settle on ${CHAIN}`);
process.exit(res.status === 200 ? 0 : 1);
