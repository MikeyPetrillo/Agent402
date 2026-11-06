// Watch an agent pay an agent: a self-contained autonomous buyer with NO human
// in the loop. It discovers the catalog, hits an HTTP 402, settles payment, and
// uses the result. Served as https://agent402.tools/demo.js; it imports nothing
// from this repo, so the downloaded copy runs on its own (Node 18+).
// Two settlement paths, both machine-native:
//
//   - proof-of-work (default): no wallet, no funds, no install. Spend CPU.
//       node demo.js
//   - USDC via x402: real money on Base (or another EVM rail the 402 offers),
//     with a funded EVM key and four packages installed next to this file:
//       npm i @x402/core @x402/evm @x402/fetch viem
//       AGENT_KEY=0x... node demo.js
//
// The target defaults to the live service; point it anywhere with TARGET_URL=...
// The USDC path pays only Agent402 itself (or a loopback server) unless
// ALLOW_EXTERNAL_PAID_TARGET=1 is set, and signs at most DEMO_MAX_USD (default
// $0.01) per payment, priced from the USDC decimals below, never from a hint in
// the 402.
import { createHash } from "node:crypto";

// USDC (6 decimals) on the EVM rails, the same addresses as client/known-assets.js
// (scripts/test-paid-scripts-guarded.js keeps the two in step).
const KNOWN_USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "eip155:143": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  "eip155:42220": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  "eip155:43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  "eip155:1329": "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  "eip155:5042": "0x3600000000000000000000000000000000000000",
};

function assertOwnPaidTarget(url) {
  let u = null;
  try { u = new URL(url); } catch { /* refused below */ }
  const host = u?.hostname.toLowerCase();
  const own = !!u && !u.username && !u.password && (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
    ? /^https?:$/.test(u.protocol)
    : u.protocol === "https:" && (host === "agent402.tools" || host === "www.agent402.tools"));
  if (own || process.env.ALLOW_EXTERNAL_PAID_TARGET === "1") return url;
  console.error(`demo: refusing to pay ${JSON.stringify(url)}: not our service (Agent402). Set ALLOW_EXTERNAL_PAID_TARGET=1 to pay another origin.`);
  process.exit(2);
}

// The base units one accept asks this signer to sign, or null when it cannot be
// priced: an exact EIP-3009 USDC accept on a rail above, read from the field
// the signer signs for the version (v2 amount, v1 maxAmountRequired).
function signedAtomic(version, a) {
  if (a?.scheme !== "exact" || !KNOWN_USDC[a.network] || String(a.asset).toLowerCase() !== KNOWN_USDC[a.network].toLowerCase()) return null;
  if (a.extra?.assetTransferMethod !== undefined && a.extra.assetTransferMethod !== "eip3009") return null;
  if (a.amount != null && a.maxAmountRequired != null && String(a.amount) !== String(a.maxAmountRequired)) return null;
  const raw = Number(version) === 2 ? a.amount : Number(version) === 1 ? a.maxAmountRequired : null;
  return /^\d+$/.test(String(raw ?? "")) ? BigInt(String(raw)) : null;
}

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const log = (s = "") => console.log(s);
// With a key, check the target before anything is fetched or signed.
if (process.env.AGENT_KEY) assertOwnPaidTarget(TARGET);
const hr = () => log("─".repeat(66));

log(`\n  Agent402: watch an agent pay an agent  (target: ${TARGET})`);
hr();

// 1) DISCOVER: the buyer reads the machine-readable catalog, no docs, no human.
log("[1] Agent discovers the catalog (GET /api/pricing) …");
const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
const free = pricing.endpoints.filter((e) => e.computePayable);
log(`    → ${pricing.endpoints.length} tools; ${free.length} payable with compute, the rest in USDC.`);
log(`    → settlement: ${pricing.payment.protocol} on ${pricing.payment.network} (${pricing.payment.currency}).`);

// 2) GET QUOTED: call a tool with no payment, receive the 402 price quote.
const tool = "/api/hash";
log(`\n[2] Agent calls ${tool} with no payment …`);
const unpaid = await fetch(`${TARGET}${tool}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ text: "machine to machine" }),
});
log(unpaid.status === 402
  ? `    → HTTP 402 Payment Required: the server quotes a price, no human prompted.`
  : `    → HTTP ${unpaid.status}: this server is not charging (free mode), so there is no quote; the steps below still run.`);
const powChallengeUrl = unpaid.headers.get("x-pow-challenge");

const AGENT_KEY = process.env.AGENT_KEY;
let result;

if (AGENT_KEY) {
  // 3a) PAY IN USDC: sign an x402 payment from the agent's own wallet.
  log(`\n[3] Agent pays in USDC via x402 (wallet settlement on Base) …`);
  const maxUsd = Number(process.env.DEMO_MAX_USD || 0.01);
  if (!(Number.isFinite(maxUsd) && maxUsd > 0)) { console.error("demo: DEMO_MAX_USD must be a positive number; not paying"); process.exit(2); }
  const capAtomic = BigInt(Math.floor(maxUsd * 1e6));
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { privateKeyToAccount } = await import("viem/accounts");
  const client = new x402Client();
  // The client's built-in spend filter caps payments at its own default; this
  // demo's spend is the one call below, so it is switched off (a no-op on
  // client versions without it).
  client.setSpendControls?.(false);
  registerExactEvmScheme(client, { signer: privateKeyToAccount(AGENT_KEY) });
  // This demo's own cap instead: only accepts it can price, at or under the cap,
  // checked again on the accept selected and on the value actually signed.
  const priced = (v, a) => { const n = signedAtomic(v, a); return n !== null && n <= capAtomic ? n : null; };
  client.registerPolicy((v, accepts) => accepts.filter((a) => priced(v, a) !== null));
  client.onBeforePaymentCreation(async ({ paymentRequired: pr, selectedRequirements: a }) =>
    priced(pr?.x402Version, a) === null ? { abort: true, reason: "accept over the demo cap or not priceable" } : undefined);
  client.onAfterPaymentCreation(async ({ paymentRequired: pr, selectedRequirements: a, paymentPayload: p }) => {
    const n = priced(pr?.x402Version, a), value = p?.payload?.authorization?.value;
    if (n === null || Number(p?.x402Version) !== Number(pr?.x402Version) || String(value) !== String(n)) throw new Error("demo: signed value is not the checked amount under the cap; not sending");
  });
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
  // 3b) PAY WITH COMPUTE: solve the proof-of-work challenge, no wallet needed.
  log(`\n[3] No wallet: agent pays with COMPUTE (proof-of-work) instead …`);
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

// 4) USE THE RESULT: the whole exchange happened with zero human involvement.
log(`\n[4] Agent has its result: sha256 = ${result.hex?.slice(0, 24)}…`);
hr();
log(`  One program discovered a service, was quoted a price over HTTP 402, settled`);
log(`  payment ${AGENT_KEY ? "in USDC on-chain" : "with compute"}, and used the result: no human, no signup,`);
log(`  no API key. That is machine-to-machine commerce. Live economy stats: ${TARGET}/api/stats\n`);
process.exit(result.hex ? 0 : 1);
