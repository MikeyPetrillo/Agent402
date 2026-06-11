// Watch an agent pay an agent — a self-contained autonomous buyer with NO human
// in the loop. It discovers the catalog, hits an HTTP 402, settles payment, and
// uses the result. Two settlement paths, both machine-native:
//
//   • proof-of-work (default) — no wallet, no funds: spend CPU. Runs anywhere.
//       node scripts/demo-payment.js
//   • USDC via x402 — real money on Base, if you supply a funded key:
//       AGENT_KEY=0x... node scripts/demo-payment.js
//
// TARGET defaults to the live service; point it anywhere with TARGET=...
import { createHash } from "node:crypto";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const log = (s = "") => console.log(s);
const hr = () => log("─".repeat(66));

log(`\n  Agent402 — watch an agent pay an agent  (target: ${TARGET})`);
hr();

// 1) DISCOVER — the buyer reads the machine-readable catalog, no docs, no human.
log("[1] Agent discovers the catalog (GET /api/pricing) …");
const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
const free = pricing.endpoints.filter((e) => e.computePayable);
log(`    → ${pricing.endpoints.length} tools; ${free.length} payable with compute, the rest in USDC.`);
log(`    → settlement: ${pricing.payment.protocol} on ${pricing.payment.network} (${pricing.payment.currency}).`);

// 2) GET QUOTED — call a tool with no payment, receive the 402 price quote.
const tool = "/api/hash";
log(`\n[2] Agent calls ${tool} with no payment …`);
const unpaid = await fetch(`${TARGET}${tool}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ text: "machine to machine" }),
});
log(`    → HTTP ${unpaid.status} ${unpaid.status === 402 ? "Payment Required" : ""} — the server quotes a price, no human prompted.`);
const powChallengeUrl = unpaid.headers.get("x-pow-challenge");

const AGENT_KEY = process.env.AGENT_KEY;
let result;

if (AGENT_KEY) {
  // 3a) PAY IN USDC — sign an x402 payment from the agent's own wallet.
  log(`\n[3] Agent pays in USDC via x402 (wallet settlement on Base) …`);
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { privateKeyToAccount } = await import("viem/accounts");
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(AGENT_KEY) });
  const payFetch = wrapFetchWithPayment(fetch, client);
  const res = await payFetch(`${TARGET}${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "machine to machine" }),
  });
  log(`    → HTTP ${res.status}, settled on-chain. Verify the inbound USDC at:`);
  log(`      ${pricing && (await (await fetch(`${TARGET}/api/stats`)).json()).onchainRevenueProof}`);
  result = await res.json();
} else {
  // 3b) PAY WITH COMPUTE — solve the proof-of-work challenge, no wallet needed.
  log(`\n[3] No wallet — agent pays with COMPUTE (proof-of-work) instead …`);
  const c = await (await fetch(`${TARGET}/api/pow/challenge?slug=hash`)).json();
  log(`    → got challenge (difficulty ${c.difficulty} bits). Solving …`);
  const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
  const t0 = Date.now();
  let n = 0;
  while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
  log(`    → solved in ${Date.now() - t0} ms (nonce ${n}). Resending with the proof …`);
  const res = await fetch(`${TARGET}${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": `${c.token}:${n}` },
    body: JSON.stringify({ text: "machine to machine" }),
  });
  log(`    → HTTP ${res.status}, X-Pow-Accepted: ${res.headers.get("x-pow-accepted")}.`);
  result = await res.json();
}

// 4) USE THE RESULT — the whole exchange happened with zero human involvement.
log(`\n[4] Agent has its result: sha256 = ${result.hex?.slice(0, 24)}…`);
hr();
log(`  One program discovered a service, was quoted a price over HTTP 402, settled`);
log(`  payment ${AGENT_KEY ? "in USDC on-chain" : "with compute"}, and used the result — no human, no signup,`);
log(`  no API key. That is machine-to-machine commerce. Live economy stats: ${TARGET}/api/stats\n`);
process.exit(result.hex ? 0 : 1);
