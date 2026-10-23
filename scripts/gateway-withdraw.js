#!/usr/bin/env node
// Withdraw the seller's Circle Gateway balance to a wallet on a chain.
//
// Human-run only. Dry run by default: it prints the balance and the transfer
// it WOULD sign and submit, and stops. `--execute` signs the burn intent with
// GATEWAY_SELLER_KEY (read from the environment of the machine running this
// script, never a server variable), asks Gateway for the transfer attestation
// (POST /v1/transfer, keyless), and submits gatewayMint(attestation,
// signature) on the destination chain, which pays that chain's gas from the
// same key. The key is never printed, logged or written anywhere.
//
//   node scripts/gateway-withdraw.js                       # dry run, all Gateway domains we sell on
//   node scripts/gateway-withdraw.js --from arc --to base  # move the Arc-domain balance to Base
//   node scripts/gateway-withdraw.js --from base --amount 12.5 --recipient 0x... --execute
//
// Flags: --from arc|base (source domain; default: every domain with a balance,
// one transfer each), --to arc|base (destination chain; default: the source
// chain), --amount <usd> (default: the whole available balance of the source
// domain), --recipient <0x address> (default: the seller address itself),
// --max-fee <usd> (default 2, the ceiling the burn intent carries), --execute.
//
// What Gateway signs against (its EVM transfer reference): a BurnIntent typed
// under the domain { name: "GatewayWallet", version: "1" } (no chainId), with
// a TransferSpec naming the source and destination domains, the GatewayWallet
// and GatewayMinter contracts, the USDC on each side, the depositor, the
// recipient and the signer, a random salt and no hook data. The attestation
// Gateway answers is submitted to GatewayMinter.gatewayMint on the destination
// chain by the recipient-side signer.
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, pad, parseUnits, formatUnits, maxUint256, zeroAddress, encodeFunctionData } from "viem";
import { randomBytes } from "node:crypto";
import { GATEWAY_API_BASE, GATEWAY_DOMAINS, GATEWAY_NETWORK_NAMES, GatewayNanopaymentsClient } from "../src/gateway-nanopayments.js";

// Mainnet Gateway contracts (Circle's published addresses; the same on every
// EVM chain Gateway serves) and the USDC each of our chains settles.
const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
const USDC = { "eip155:5042": "0x3600000000000000000000000000000000000000", "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const RPC = { "eip155:5042": "https://rpc.mainnet.arc.io", "eip155:8453": "https://mainnet.base.org" };
const CHAIN_ID = { "eip155:5042": 5042, "eip155:8453": 8453 };

const args = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? "") : dflt; };
const has = (name) => args.includes(`--${name}`);
const execute = has("execute");
const netOf = (name) => (name ? GATEWAY_NETWORK_NAMES[String(name).toLowerCase()] || null : null);
const fromNet = netOf(flag("from"));
const toNet = netOf(flag("to")) || fromNet;
if (flag("from") && !fromNet) { console.error(`--from must be one of ${Object.keys(GATEWAY_NETWORK_NAMES).join(", ")}`); process.exit(2); }
if (flag("to") && !toNet) { console.error(`--to must be one of ${Object.keys(GATEWAY_NETWORK_NAMES).join(", ")}`); process.exit(2); }
const amountFlag = flag("amount");
const maxFeeUsd = Number(flag("max-fee", "2"));
if (!Number.isFinite(maxFeeUsd) || maxFeeUsd < 0) { console.error("--max-fee must be a non-negative number"); process.exit(2); }

const key = String(process.env.GATEWAY_SELLER_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("GATEWAY_SELLER_KEY (the treasury's private key, 0x + 64 hex) must be set in this shell. It is never printed.");
  process.exit(2);
}
const account = privateKeyToAccount(key);
const seller = account.address;
const recipient = flag("recipient") || seller;
if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) { console.error("--recipient must be a 0x address"); process.exit(2); }

const client = new GatewayNanopaymentsClient();
const domainsWanted = fromNet ? [GATEWAY_DOMAINS[fromNet]] : Object.values(GATEWAY_DOMAINS);
const netByDomain = Object.fromEntries(Object.entries(GATEWAY_DOMAINS).map(([n, d]) => [String(d), n]));
const balances = await client.balances({ depositor: seller, domains: domainsWanted });
console.log(`seller ${seller}`);
console.log(`Gateway USDC available: ${balances.usd} total`);
for (const [domain, usd] of Object.entries(balances.byDomain)) console.log(`  domain ${domain} (${netByDomain[domain] || "?"}): ${usd}`);

const TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" }, { name: "sourceDomain", type: "uint32" }, { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" }, { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" }, { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" }, { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" }, { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" }, { name: "salt", type: "bytes32" }, { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [{ name: "maxBlockHeight", type: "uint256" }, { name: "maxFee", type: "uint256" }, { name: "spec", type: "TransferSpec" }],
};
const b32 = (addr) => pad(addr.toLowerCase(), { size: 32 });

const plans = [];
for (const [domain, usd] of Object.entries(balances.byDomain)) {
  const source = netByDomain[domain];
  if (!source) continue;
  const dest = toNet || source;
  const amountUsd = amountFlag != null ? Number(amountFlag) : usd;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) { console.log(`  domain ${domain}: nothing to withdraw`); continue; }
  if (amountUsd > usd + 1e-9) { console.error(`  domain ${domain}: --amount ${amountUsd} is above the available ${usd}`); process.exit(2); }
  const spec = {
    version: 1, sourceDomain: Number(domain), destinationDomain: GATEWAY_DOMAINS[dest],
    sourceContract: b32(GATEWAY_WALLET), destinationContract: b32(GATEWAY_MINTER),
    sourceToken: b32(USDC[source]), destinationToken: b32(USDC[dest]),
    sourceDepositor: b32(seller), destinationRecipient: b32(recipient),
    sourceSigner: b32(seller), destinationCaller: b32(zeroAddress),
    value: parseUnits(amountUsd.toFixed(6), 6), salt: `0x${randomBytes(32).toString("hex")}`, hookData: "0x",
  };
  plans.push({ source, dest, amountUsd, burnIntent: { maxBlockHeight: maxUint256, maxFee: parseUnits(maxFeeUsd.toFixed(6), 6), spec } });
}
if (!plans.length) { console.log("nothing to withdraw"); process.exit(0); }
for (const p of plans) console.log(`plan: ${p.amountUsd} USDC from the ${p.source} domain to ${recipient} on ${p.dest} (max fee ${maxFeeUsd} USDC)`);
if (!execute) { console.log("dry run: pass --execute to sign the burn intent, fetch the attestation and mint on the destination chain"); process.exit(0); }

const bigintJson = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
for (const p of plans) {
  const signature = await account.signTypedData({ domain: { name: "GatewayWallet", version: "1" }, types: TYPES, primaryType: "BurnIntent", message: p.burnIntent });
  const res = await fetch(`${GATEWAY_API_BASE}/v1/transfer`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([{ burnIntent: p.burnIntent, signature }], bigintJson),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { console.error(`Gateway /v1/transfer answered HTTP ${res.status} for the ${p.source} transfer; nothing minted`); process.exit(1); }
  const out = await res.json();
  if (typeof out?.attestation !== "string" || typeof out?.signature !== "string") { console.error("Gateway answered without an attestation; nothing minted"); process.exit(1); }
  console.log(`attestation for ${p.source}: transferId ${out.transferId}, fees ${out.fees?.total ?? "?"} ${out.fees?.token ?? ""}, expires at block ${out.expirationBlock ?? "?"}`);
  const chain = { id: CHAIN_ID[p.dest], name: p.dest, nativeCurrency: { name: "gas", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [RPC[p.dest]] } } };
  const wallet = createWalletClient({ account, chain, transport: http(RPC[p.dest]) });
  const pub = createPublicClient({ chain, transport: http(RPC[p.dest]) });
  const data = encodeFunctionData({
    abi: [{ type: "function", name: "gatewayMint", stateMutability: "nonpayable", inputs: [{ name: "attestationPayload", type: "bytes" }, { name: "signature", type: "bytes" }], outputs: [] }],
    functionName: "gatewayMint", args: [out.attestation, out.signature],
  });
  const hash = await wallet.sendTransaction({ to: GATEWAY_MINTER, data });
  console.log(`gatewayMint sent on ${p.dest}: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  ${receipt.status === "success" ? "minted" : "REVERTED"} in block ${receipt.blockNumber} (${formatUnits(p.burnIntent.spec.value, 6)} USDC before fees)`);
  if (receipt.status !== "success") process.exit(1);
}
