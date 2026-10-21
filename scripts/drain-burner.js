// Drain the burner: spend its USDC/USDG balance to the revenue wallet as real
// paid x402 tool calls, on EVERY funded EVM chain. Settlement is facilitator-
// sponsored (gasless), so it works even though the burner holds no native gas —
// which is why we can't just do a direct transfer. Used to retire a burner
// (rotation) or empty a wallet whose key has been exposed.
//
// Denomination: one $0.50 tool (skill-company-dossier), bought repeatedly. The
// balance is swept ~$0.50 at a time; whatever is left UNDER $0.50 on each chain
// is stranded by design (draining the last few cents isn't worth the calls).
//
// Multi-chain: forces payment onto ONE chain per call by filtering the live
// 402's `accepts` down to that chain's CAIP-2 (same technique as the paid
// canary's pinned EVM legs), so a chain can't silently fall back to Base. No
// per-chain RPC needed: the stop signal is settlement itself — once the balance
// drops below $0.50 the facilitator can't settle and returns a 402, and after a
// few consecutive non-settles the chain is done (also covers a chain whose
// facilitator is temporarily unavailable — it just gets skipped, not hung).
// Settlement happens BEFORE the handler, so even a slow/erroring tool response
// still means the money moved.
//
//   KEY_FILE=/path/to/key TARGET_URL=https://agent402.tools node scripts/drain-burner.js
//
// Prints the derived burner ADDRESS first, so the CI log confirms WHICH wallet
// is being drained before any money moves.
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const MAX_CALLS_PER_CHAIN = parseInt(process.env.MAX_CALLS, 10) || 100; // backstop; the 402 stop ends it first
const STOP_AFTER_FAILS = 3; // consecutive non-settles = drained (<$0.50) or facilitator unavailable
const CALL_TIMEOUT_MS = 45000; // a skill pack does real work; don't hang forever on one call

// EVM chains to sweep, by CAIP-2. Robinhood settles USDG (not USDC); the money
// parser + facilitator are server-side, so the accept carries the right asset
// and the same signing path works. Monad and Celo USDC use a custom EIP-712
// name, also carried in the accept. No RPC/chain object needed — we never read balances.
const CHAINS = [
  { key: "base",      caip2: "eip155:8453" },
  { key: "arbitrum",  caip2: "eip155:42161" },
  { key: "polygon",   caip2: "eip155:137" },
  { key: "monad",     caip2: "eip155:143" },
  { key: "celo",      caip2: "eip155:42220" },
  { key: "avalanche", caip2: "eip155:43114" },
  { key: "sei",       caip2: "eip155:1329" },
  { key: "optimism",  caip2: "eip155:10" },
  { key: "arc",       caip2: "eip155:5042" },
  { key: "robinhood", caip2: "eip155:4663" },
];
const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM"];
const DENOM_URL = `${TARGET}/api/skill/company-dossier`; // $0.50, returns 402 with a valid ticker
const denomInit = (i) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ticker: TICKERS[i % TICKERS.length] }),
  signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
});

const pk = readFileSync(KEY_FILE, "utf8").trim();
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log(`Burner: ${account.address}`);
console.log(`Draining ~$0.50/call per chain until settlement fails (<$0.50/chain stranded, by design).\n`);

const client = disableVendorSpendControls(new x402Client());
registerExactEvmScheme(client, { signer: account });
const httpc = new x402HTTPClient(client);

// One forced-chain paid call. Returns { settled } — settled=false only on an
// explicit 402 (settlement rejected: drained or facilitator down) or a
// pre-payment error; a non-402 paid response means the money moved.
async function payOn(caip2, url, init) {
  const bare = await fetch(url, init);
  if (bare.status !== 402) return { settled: false, reason: `no-402 (HTTP ${bare.status})` };
  const body = await bare.json().catch(() => undefined);
  const pr = httpc.getPaymentRequiredResponse((n) => bare.headers.get(n), body);
  const accepts = (pr.accepts || []).filter((a) => String(a.network || "") === caip2);
  if (!accepts.length) return { settled: false, reason: "chain-not-offered" };
  const payload = await client.createPaymentPayload({ ...pr, accepts });
  const payHeaders = httpc.encodePaymentSignatureHeader(payload);
  const paid = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...payHeaders }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  return { settled: paid.status !== 402, status: paid.status };
}

let grandSettled = 0;
for (const cfg of CHAINS) {
  process.stdout.write(`[${cfg.key}] draining… `);
  let calls = 0, settled = 0, fails = 0, i = 0, notOffered = false;
  while (calls < MAX_CALLS_PER_CHAIN) {
    calls++;
    let r;
    try { r = await payOn(cfg.caip2, DENOM_URL, denomInit(i++)); }
    catch (e) { r = { settled: false, reason: String(e.message).slice(0, 50) }; }
    if (r.reason === "chain-not-offered") { notOffered = true; break; }
    if (r.settled) { settled++; fails = 0; }
    else if (++fails >= STOP_AFTER_FAILS) break;
  }
  grandSettled += settled;
  if (notOffered) console.log(`chain not in live accepts — skipped.`);
  else console.log(`~$${(settled * 0.5).toFixed(2)} moved (${settled} settled / ${calls} attempts).`);
}

console.log(`\n================ SWEEP COMPLETE ================`);
console.log(`Approx total moved to revenue: ~$${(grandSettled * 0.5).toFixed(2)} USDC/USDG (<$0.50/chain stranded by design).`);
console.log(`Verify on-chain: https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns`);
console.log(`Live tally: ${TARGET}/api/stats`);
process.exit(0);
