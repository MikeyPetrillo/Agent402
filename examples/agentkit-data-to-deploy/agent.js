#!/usr/bin/env node
// An AgentKit agent with one wallet: buy live ETH data from agent402.tools
// over x402, then deploy a contract on Base mainnet that carries the data and
// the x402 settlement transaction that bought it. The same wallet pays for the
// data (USDC, gasless for the buyer) and pays gas for the deployment (ETH).
//
//   AGENT_WALLET_KEY=0x... node agent.js
//
// What it proves, in one run against production: an AgentKit ViemWalletProvider
// pays a wallet-only Agent402 tool through agent402_call, the settled
// PAYMENT-RESPONSE receipt names this wallet, and the deployed contract's
// paymentTx equals that receipt's transaction hash. Both links print at the end.
//
// Env: AGENT_WALLET_KEY (or BURNER_KEY) - the wallet's private key on Base.
//      TARGET_URL     - default https://agent402.tools
//      BASE_RPC_URL   - default https://mainnet.base.org
//      COIN           - default ETH (any symbol crypto-price accepts)
//      DRY_RUN=1      - buy nothing, deploy nothing: estimate the deployment
//                       gas from this wallet with placeholder data and exit.
//      AGENT402_PAYEES - optional comma-separated payTo allowlist (lowercased
//                       EVM addresses); a 402 naming any other payee is refused
//                       before signing. The live proof pins the Agent402 treasury.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const COIN = (process.env.COIN || "ETH").toUpperCase();
const DRY = process.env.DRY_RUN === "1";
const SLUG = "crypto-price";
const SOURCE = `${new URL(TARGET).host} GET /api/${SLUG}`;

const pk = (process.env.AGENT_WALLET_KEY || process.env.BURNER_KEY || "").trim();
if (!pk) { console.error("need AGENT_WALLET_KEY (a private key holding a little USDC and ETH on Base)"); process.exit(2); }
// AgentKit phones home when a wallet provider is constructed and throws an
// UNHANDLED rejection on a non-2xx from its endpoint (measured 2026-08-27).
// Their telemetry must not decide this run.
process.on("unhandledRejection", (e) => console.warn("ignored unhandled rejection (third-party):", String(e?.message || e).slice(0, 120)));

const artifact = JSON.parse(readFileSync(join(here, "contracts", "artifact.json"), "utf8"));
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const publicClient = createPublicClient({ chain: base, transport: http(RPC) });

// ---- 1. the wallet, as an AgentKit wallet provider --------------------------
const { ViemWalletProvider } = await import("@coinbase/agentkit");
const { agent402Actions } = await import(process.env.AGENTKIT_ADAPTER || "agent402-agentkit");
const walletProvider = new ViemWalletProvider(createWalletClient({ account, chain: base, transport: http(RPC) }));
console.log(`wallet ${account.address} on Base`);

// The deploy data for the snapshot contract. Prices are stored in micro-units
// (6 decimals) so a USD price is exact to the cent and beyond.
function deployData({ symbol, currency, priceMicro, observedAt, paymentTx }) {
  return encodeDeployData({
    abi: artifact.abi, bytecode: artifact.bytecode,
    args: [symbol, currency, priceMicro, observedAt, SOURCE, paymentTx],
  });
}

if (DRY) {
  const data = deployData({ symbol: COIN, currency: "usd", priceMicro: 1n, observedAt: 0n, paymentTx: `0x${"0".repeat(64)}` });
  const gas = await publicClient.estimateGas({ account: account.address, data });
  const gasPrice = await publicClient.getGasPrice();
  const [eth, usdc] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`DRY RUN: deployment estimates ${gas} gas at ${Number(gasPrice) / 1e9} gwei = ${(Number(gas * gasPrice) / 1e18).toFixed(9)} ETH; wallet holds ${(Number(eth) / 1e18).toFixed(6)} ETH and ${(Number(usdc) / 1e6).toFixed(4)} USDC`);
  process.exit(0);
}

// ---- 2. find the tool, then buy the data over x402 --------------------------
let receipt = null, paidRetries = 0;
const fetchImpl = async (input, init) => {
  const req = new Request(input, init);
  if (req.headers.get("payment-signature") || req.headers.get("x-payment")) paidRetries++;
  const res = await fetch(req);
  const rh = res.headers.get("payment-response");
  if (rh) { try { receipt = JSON.parse(Buffer.from(rh, "base64").toString("utf8")); } catch { /* keep null */ } }
  return res;
};
const payees = (process.env.AGENT402_PAYEES || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
const [find, call] = await agent402Actions({ baseUrl: TARGET, fetchImpl, maxPerCallUsd: 0.02, payees: payees.length ? payees : null });

const found = JSON.parse(await find.invoke(find.schema.parse({ task: `live ${COIN} price in USD`, k: 5 })));
const row = found.results.find((r) => r.slug === SLUG);
console.log("find:", found.results.map((r) => `${r.slug} ${r.price}`).join(", "));
if (!row) { console.error(`agent402_find did not surface ${SLUG}`); process.exit(1); }

const t0 = Date.now();
// One retry on a 5xx: Agent402 cancels settlement on any >= 400, so a failed
// call is never charged and the retry costs nothing unless it succeeds
// (measured 2026-09-03: a 504 from a just-deployed container's boot stall).
async function buyOnce() { return JSON.parse(await call.invoke(walletProvider, call.schema.parse({ slug: SLUG, params: { coins: COIN, currency: "usd" } }))); }
let out;
try { out = await buyOnce(); }
catch (e) {
  if (!/HTTP 5\d\d/.test(String(e?.message))) throw e;
  console.warn(`first buy failed (${e.message}) - not charged on x402, retrying once in 5 s`);
  await new Promise((r) => setTimeout(r, 5000));
  out = await buyOnce();
}
const coinKey = Object.keys(out.coins || {})[0];
const quote = coinKey ? out.coins[coinKey] : null;
if (!quote || typeof quote.price !== "number") { console.error("no price in the tool's answer:", JSON.stringify(out).slice(0, 300)); process.exit(1); }
const paid = paidRetries >= 1 && receipt?.success === true && /^0x[0-9a-f]{64}$/i.test(receipt?.transaction || "")
  && String(receipt?.payer || "").toLowerCase() === account.address.toLowerCase();
console.log(`bought: ${coinKey} = $${quote.price} (as of ${quote.lastUpdated}) for ${row.price} in ${Date.now() - t0} ms`);
console.log(`x402 receipt: ${JSON.stringify(receipt)}`);
if (!paid) { console.error("NOT PROVEN: the data call did not settle from this wallet"); process.exit(1); }

// ---- 3. deploy the snapshot with the data and the payment tx inside ---------
const priceMicro = BigInt(Math.round(quote.price * 1e6));
const observedAt = BigInt(Math.floor(new Date(quote.lastUpdated || Date.now()).getTime() / 1000));
const data = deployData({ symbol: COIN, currency: "usd", priceMicro, observedAt, paymentTx: receipt.transaction });
const deployHash = await walletProvider.sendTransaction({ data });
console.log(`deploy tx ${deployHash} ... waiting for the receipt`);
const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) { console.error("deployment failed:", deployReceipt.status); process.exit(1); }
const address = deployReceipt.contractAddress;

// ---- 4. read it back from the chain and check every field -------------------
// A load-balanced public RPC can answer the read from a node that has not
// seen the deployment's block yet (measured 2026-09-03: "returned no data"
// half a second after the receipt), so read at the receipt's own block and
// retry a lagging node for up to a minute.
let snap;
for (let attempt = 1; ; attempt++) {
  try { snap = await publicClient.readContract({ address, abi: artifact.abi, functionName: "snapshot", blockNumber: deployReceipt.blockNumber }); break; }
  catch (e) {
    if (attempt >= 20) throw e;
    console.warn(`read-back attempt ${attempt} failed (${String(e?.shortMessage || e?.message).slice(0, 80)}) - node lagging, retrying`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const [buyer, symbol, currency, price, at, source, paymentTx] = snap;
const consistent = buyer.toLowerCase() === account.address.toLowerCase() && symbol === COIN && currency === "usd"
  && price === priceMicro && at === observedAt && source === SOURCE && paymentTx.toLowerCase() === receipt.transaction.toLowerCase();
console.log(`on-chain snapshot: ${symbol}/${currency} ${Number(price) / 1e6} at ${new Date(Number(at) * 1000).toISOString()}, buyer ${buyer}, paymentTx ${paymentTx}`);
if (!consistent) { console.error("NOT PROVEN: the deployed snapshot does not match what was bought"); process.exit(1); }

console.log(`PROVEN: one wallet bought ${coinKey} at $${quote.price} from ${TARGET} for ${row.price} over x402 and deployed it to Base.`);
console.log(`  payment  https://basescan.org/tx/${receipt.transaction}`);
console.log(`  deploy   https://basescan.org/tx/${deployHash}`);
console.log(`  contract https://basescan.org/address/${address}`);
console.log(JSON.stringify({ paymentTx: receipt.transaction, deployTx: deployHash, contract: address, price: quote.price, observedAt: quote.lastUpdated, gasUsed: String(deployReceipt.gasUsed) }));
