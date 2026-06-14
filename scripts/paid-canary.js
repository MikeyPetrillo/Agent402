// Paid-path canary: make ONE real x402 USDC purchase from production to prove
// buying still settles end-to-end. Deliberately cheap ($0.001) and deterministic
// — it buys /api/hash (pure-CPU, no upstream flakiness) and checks the result.
// Assumes a funded burner via BURNER_KEY or KEY_FILE; it does NOT wait for funding.
//
// Exit codes: 0 = bought & verified · 1 = paid path failed · 2 = misconfigured.
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.error("paid-canary: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

const fail = (m) => { console.error("PAID CANARY FAILED:", m); process.exit(1); };

try {
  const res = await payFetch(`${TARGET}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello world" }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) fail(`paid /api/hash → HTTP ${res.status} ${JSON.stringify(body).slice(0, 150)}`);
  if (!body.hex || !body.hex.startsWith("b94d27b9")) fail(`unexpected result: ${JSON.stringify(body).slice(0, 150)}`);
  console.log(`paid-canary OK — real USDC purchase settled from ${TARGET} (/api/hash → ${body.hex.slice(0, 12)}…), payer ${account.address}`);
  process.exit(0);
} catch (e) {
  fail((e && e.message ? e.message : String(e)).slice(0, 200));
}
