// End-to-end paid test: a real x402 agent that buys calls from the live API.
// MODE=address  — generate/load the burner key, print the funding address.
// MODE=run      — wait for USDC funding, then buy every paid endpoint once.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { base } from "viem/chains";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const SUITE_BUDGET = 60000n; // ~$0.057 buys the whole suite; require $0.06
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
  if (bal >= SUITE_BUDGET) break;
  if (i % 8 === 0) console.log(`  balance: $${formatUnits(bal, 6)} — still waiting…`);
  await new Promise((r) => setTimeout(r, 15000));
}
if (bal < SUITE_BUDGET) {
  console.log("Never funded — nothing spent, nothing lost. Burner key (throwaway, do not reuse):", pk);
  process.exit(1);
}
console.log(`FUNDED: $${formatUnits(bal, 6)} USDC. Buying the full tool suite from ${TARGET}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

let calls = 0;
let failures = 0;
async function paidCall(label, url, init, { binary = false } = {}) {
  try {
    const res = await payFetch(url, init);
    const body = binary ? await res.arrayBuffer() : await res.json().catch(() => ({}));
    const ok = res.status === 200;
    ok ? calls++ : failures++;
    console.log(`[${label}] HTTP ${res.status} ${ok ? "PAID ✓" : `FAILED: ${JSON.stringify(body).slice(0, 200)}`}`);
    return { ok, body, res };
  } catch (e) {
    failures++;
    console.log(`[${label}] THREW: ${e.message?.slice(0, 200)}`);
    return { ok: false, body: {} };
  }
}
const post = (obj) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

// --- The original trio ($0.008) ---
const r1 = await paidCall("extract $0.005", `${TARGET}/api/extract`, post({ url: "https://www.bbc.com/news" }));
if (r1.ok) console.log(`  → "${r1.body.title}" (${r1.body.wordCount} words of markdown)`);

const r2 = await paidCall("meta    $0.002", `${TARGET}/api/meta?url=${encodeURIComponent("https://github.com")}`);
if (r2.ok) console.log(`  → title: ${r2.body.title}`);

const r3 = await paidCall("dns     $0.001", `${TARGET}/api/dns?name=google.com&type=A`);
if (r3.ok) console.log(`  → ${r3.body.records.length} A records`);

// --- The new tools ($0.049) ---
const r4 = await paidCall("render  $0.02", `${TARGET}/api/render`, post({ url: "https://react.dev" }));
if (r4.ok) console.log(`  → rendered=${r4.body.rendered} "${r4.body.title}" (${r4.body.wordCount} words)`);

const r5 = await paidCall(
  "shot    $0.015",
  `${TARGET}/api/screenshot?url=${encodeURIComponent("https://example.com")}`,
  undefined,
  { binary: true }
);
if (r5.ok) {
  const png = new Uint8Array(r5.body.slice(0, 4));
  const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  console.log(`  → ${r5.body.byteLength} bytes, PNG magic: ${isPng}`);
  if (!isPng) failures++;
}

const r6 = await paidCall("pdf     $0.01", `${TARGET}/api/pdf`, post({ url: "https://arxiv.org/pdf/1706.03762" }));
if (r6.ok) console.log(`  → ${r6.body.pages} pages, ${r6.body.wordCount} words: "${r6.body.text?.slice(0, 60)}…"`);

const stamp = `e2e-${Date.now()}`;
const r7 = await paidCall("mem-put $0.002", `${TARGET}/api/memory`, post({ key: "e2e", value: { stamp } }));
if (r7.ok) console.log(`  → stored key "e2e"`);

const r8 = await paidCall("mem-get $0.001", `${TARGET}/api/memory?key=e2e`);
if (r8.ok) {
  const roundTrip = r8.body?.value?.stamp === stamp;
  console.log(`  → round-trip value matches: ${roundTrip} (wallet-keyed namespace works)`);
  if (!roundTrip) failures++;
}

const r9 = await paidCall("mem-ls  $0.001", `${TARGET}/api/memory`);
if (r9.ok) console.log(`  → keys in this wallet's namespace: ${JSON.stringify(r9.body.keys ?? r9.body)}`);

bal = await balance();
console.log("");
console.log("================ RESULT ================");
console.log(`Successful paid calls: ${calls}, failures: ${failures}`);
console.log(`Burner wallet remainder: $${formatUnits(bal, 6)} USDC (kept for future test runs)`);
console.log(`Revenue landed at the owner wallet — verify on-chain:`);
console.log(`  https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns`);
console.log("Burner key (throwaway, do not reuse):", pk);
process.exit(calls > 0 && failures === 0 ? 0 : 1);
