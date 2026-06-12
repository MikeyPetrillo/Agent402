// Drain the burner: spend its entire USDC balance as real paid tool calls
// against production. Every purchase settles to the revenue wallet, exercises a
// live tool (extra verification), and bumps the /api/stats odometer — and it
// empties a wallet whose key has been in git history, so there's nothing left
// to take. Gas is facilitator-sponsored, so it spends USDC down to ~zero.
//
//   KEY_FILE=/path/to/key TARGET_URL=https://agent402.tools node scripts/drain-burner.js
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const MAX_CALLS = parseInt(process.env.MAX_CALLS, 10) || 400; // hard ceiling, safety
const STOP_BELOW = 5000n; // stop when < $0.005 (can't cover the cheapest basket item)

const pk = readFileSync(KEY_FILE, "utf8").trim();
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log(`Burner: ${account.address}`);

const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const balance = () => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

let bal = await balance();
console.log(`Starting balance: $${formatUnits(bal, 6)} USDC → draining into the revenue wallet as paid tool calls.\n`);
if (bal < STOP_BELOW) {
  console.log("Already empty (< $0.005). Nothing to drain.");
  process.exit(0);
}

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

// A rotating basket of cheap, fast, real tools so the drain doubles as varied
// live verification. (Prices in USDC.) Mid-priced enough to finish in minutes.
const basket = [
  { label: "dns",         get: "/api/dns?name=cloudflare.com&type=A" },
  { label: "gov-data",    get: "/api/gov-data?q=climate&rows=2" },
  { label: "earthquakes", get: "/api/earthquakes?minMag=4.5&period=day" },
  { label: "weather",     get: "/api/weather-alerts?area=TX" },
  { label: "extract",     post: "/api/extract", body: { url: "https://example.com" } },
  { label: "meta",        get: "/api/meta?url=https://example.com" },
  { label: "pdf",         post: "/api/pdf", body: { url: "https://arxiv.org/pdf/1706.03762" } },
];

const startBal = bal;
let calls = 0, ok = 0, spent = 0n;
for (let i = 0; calls < MAX_CALLS; i++) {
  if (bal < STOP_BELOW) break;
  const t = basket[i % basket.length];
  calls++;
  try {
    const res = t.post
      ? await payFetch(`${TARGET}${t.post}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t.body) })
      : await payFetch(`${TARGET}${t.get}`);
    if (res.status === 200) ok++;
    else { console.log(`  [${t.label}] HTTP ${res.status} (not counted)`); }
  } catch (e) {
    console.log(`  [${t.label}] ${String(e.message).slice(0, 90)}`);
  }
  // Re-check balance every few calls (each balance read is an RPC call).
  if (calls % 5 === 0 || calls < 5) {
    try {
      const nb = await balance();
      spent = startBal - nb;
      bal = nb;
      console.log(`  ${calls} calls (${ok} ok) · spent $${formatUnits(spent, 6)} · remaining $${formatUnits(bal, 6)}`);
    } catch { /* rpc hiccup; keep going */ }
  }
}

try { bal = await balance(); } catch {}
spent = startBal - bal;
console.log(`\n================ DRAIN COMPLETE ================`);
console.log(`Paid tool calls made: ${calls} (${ok} returned 200)`);
console.log(`Moved to revenue wallet: $${formatUnits(spent, 6)} USDC`);
console.log(`Burner remaining: $${formatUnits(bal, 6)} USDC`);
console.log(`Revenue verifiable on-chain: https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns`);
console.log(`Live tally: ${TARGET}/api/stats`);
process.exit(0);
