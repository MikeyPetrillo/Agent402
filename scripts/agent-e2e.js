// End-to-end paid test: a real x402 agent that buys calls from the live API.
// MODE=address  — generate/load the burner key, print the funding address.
// MODE=run      — wait for USDC funding, then make paid calls until spent.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { base } from "viem/chains";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = process.env.TARGET_URL || "https://agent402-production.up.railway.app";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const PRICE_EXTRACT = 5000n; // $0.005 in 6-decimal USDC units
const FUND_WAIT_MINUTES = 40;

let pk;
if (existsSync(KEY_FILE)) {
  pk = readFileSync(KEY_FILE, "utf8").trim();
} else {
  pk = generatePrivateKey();
  writeFileSync(KEY_FILE, pk, { mode: 0o600 });
}
const account = privateKeyToAccount(pk);
console.log(`AGENT ADDRESS: ${account.address}`);

if (process.env.MODE === "address") {
  writeFileSync("agent-address.txt", account.address + "\n");
  process.exit(0);
}

const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const balance = () =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

console.log(`Waiting up to ${FUND_WAIT_MINUTES} min for USDC on Base at ${account.address} …`);
let bal = 0n;
for (let i = 0; i < FUND_WAIT_MINUTES * 4; i++) {
  try {
    bal = await balance();
  } catch (e) {
    console.log(`(rpc hiccup: ${e.message?.slice(0, 80)})`);
  }
  if (bal >= PRICE_EXTRACT) break;
  if (i % 8 === 0) console.log(`  balance: $${formatUnits(bal, 6)} — still waiting…`);
  await new Promise((r) => setTimeout(r, 15000));
}
if (bal < PRICE_EXTRACT) {
  console.log("Never funded — nothing spent, nothing lost. Burner key (throwaway, do not reuse):", pk);
  process.exit(1);
}
console.log(`FUNDED: $${formatUnits(bal, 6)} USDC. Starting paid calls against ${TARGET}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

let calls = 0;
async function paidCall(label, url, init) {
  const res = await payFetch(url, init);
  const body = await res.json().catch(() => ({}));
  const ok = res.status === 200;
  if (ok) calls++;
  console.log(`[${label}] HTTP ${res.status} ${ok ? "PAID ✓" : "FAILED"}`);
  return { ok, body };
}

const r1 = await paidCall("extract", `${TARGET}/api/extract`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://www.bbc.com/news" }),
});
if (r1.ok) console.log(`  → "${r1.body.title}" (${r1.body.wordCount} words of markdown)`);

const r2 = await paidCall("meta", `${TARGET}/api/meta?url=${encodeURIComponent("https://github.com")}`);
if (r2.ok) console.log(`  → title: ${r2.body.title}`);

const r3 = await paidCall("dns", `${TARGET}/api/dns?name=google.com&type=A`);
if (r3.ok) console.log(`  → ${r3.body.records.length} A records`);

// Spend the rest back to the owner, $0.005 at a time.
for (let i = 0; i < 25; i++) {
  bal = await balance();
  if (bal < PRICE_EXTRACT) break;
  const r = await paidCall(`sweep-${i + 1}`, `${TARGET}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  if (!r.ok) break;
}

bal = await balance();
console.log("");
console.log("================ RESULT ================");
console.log(`Successful paid calls: ${calls}`);
console.log(`Burner wallet remainder: $${formatUnits(bal, 6)} USDC`);
console.log(`Revenue landed at the owner wallet — verify on-chain:`);
console.log(`  https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns`);
console.log("Burner key (throwaway, do not reuse):", pk);
process.exit(calls > 0 ? 0 : 1);
