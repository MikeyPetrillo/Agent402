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
// chain), --amount <usd> (requires --from: an amount names one source domain,
// never every domain at once; default: the whole available balance of the
// source domain), --recipient <0x address> (default: the seller address
// itself), --max-fee <usd> (the ceiling the burn intent carries; below),
// --expiry-blocks <n> (the burn intent's validity window, below), --execute.
//
// Fee: Gateway takes its fee from the source balance on top of the value
// withdrawn, up to the burn intent's maxFee, so a transfer of the whole
// balance would leave nothing to pay it and be refused. The value is
// therefore at most the available balance minus --max-fee: the whole-balance
// default withdraws exactly that, and an --amount above it is refused before
// anything is signed. The --max-fee default is DEFAULT_MAX_FEE_USD, 1% of the
// default withdraw alert (GATEWAY_WITHDRAW_ALERT_USD's default,
// src/gateway-nanopayments.js): a withdrawal made when the alert fires gives
// up at most 1% of it to fees. A fee above the ceiling is Gateway's refusal,
// and nothing is minted; pass a higher --max-fee to accept it.
//
// Expiry: the burn intent's maxBlockHeight is the source chain's current block
// (eth_blockNumber on its RPC, src/evm-rpcs.js) plus a window of
// DEFAULT_EXPIRY_BLOCKS (10,000 blocks: about five and a half hours on Base at
// two seconds a block, less on a faster chain), overridable with
// --expiry-blocks between MIN_EXPIRY_BLOCKS and MAX_EXPIRY_BLOCKS. A signed
// intent that is never submitted, or leaks, stops being spendable once the
// source chain passes that height. An unreadable block number refuses the
// run: an intent is never signed without an expiry.
//
// What Gateway signs against (its EVM transfer reference): a BurnIntent typed
// under the domain { name: "GatewayWallet", version: "1" } (no chainId), with
// a TransferSpec naming the source and destination domains, the GatewayWallet
// and GatewayMinter contracts, the USDC on each side, the depositor, the
// recipient and the signer, a random salt and no hook data. The attestation
// Gateway answers is submitted to GatewayMinter.gatewayMint on the destination
// chain by the recipient-side signer.
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, pad, parseUnits, formatUnits, zeroAddress, encodeFunctionData } from "viem";
import { randomBytes } from "node:crypto";
import { GATEWAY_API_BASE, GATEWAY_DOMAINS, GATEWAY_NETWORK_NAMES, GatewayNanopaymentsClient, DEFAULT_WITHDRAW_ALERT_USD } from "../src/gateway-nanopayments.js";
import { evmRpcFor } from "../src/evm-rpcs.js";

// Mainnet Gateway contracts (Circle's published addresses; the same on every
// EVM chain Gateway serves) and the USDC each of our chains settles.
const GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
const USDC = { "eip155:5042": "0x3600000000000000000000000000000000000000", "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const CHAIN_ID = { "eip155:5042": 5042, "eip155:8453": 8453 };

export const DEFAULT_EXPIRY_BLOCKS = 10_000n;
/** The --max-fee default: 1% of the default withdraw alert (see Fee above). */
export const DEFAULT_MAX_FEE_USD = DEFAULT_WITHDRAW_ALERT_USD / 100;
export const MIN_EXPIRY_BLOCKS = 100n;
export const MAX_EXPIRY_BLOCKS = 1_000_000n;

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
const domainNames = () => Object.entries(GATEWAY_NETWORK_NAMES).map(([name, caip2]) => `${name} (Gateway domain ${GATEWAY_DOMAINS[caip2]})`).join(", ");

/** The source chain's current block number (eth_blockNumber on its RPC). Throws when unreadable. */
export async function currentBlock(network, { fetchImpl = (...a) => globalThis.fetch(...a), env = process.env, timeoutMs = 10_000 } = {}) {
  const url = evmRpcFor(network, env);
  if (!url) throw new Error(`no RPC configured for ${network}`);
  const res = await fetchImpl(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${network} RPC answered HTTP ${res.status}`);
  const out = await res.json();
  const hex = String(out?.result || "");
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(hex)) throw new Error(`${network} RPC answered no block number`);
  const n = BigInt(hex);
  if (n <= 0n) throw new Error(`${network} RPC answered block 0`);
  return n;
}

/**
 * The whole run. Returns the exit code; never calls process.exit, so a test
 * can drive it with stubs (fetchImpl serves Gateway and the RPC; log/error
 * collect the output).
 */
export async function runWithdraw({ argv = process.argv.slice(2), env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), log = console.log, error = console.error } = {}) {
  const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] ?? "") : dflt; };
  const has = (name) => argv.includes(`--${name}`);
  const execute = has("execute");
  const netOf = (name) => (name ? GATEWAY_NETWORK_NAMES[String(name).toLowerCase()] || null : null);
  const fromNet = netOf(flag("from"));
  const toNet = netOf(flag("to")) || fromNet;
  if (flag("from") && !fromNet) { error(`--from must be one of ${Object.keys(GATEWAY_NETWORK_NAMES).join(", ")}`); return 2; }
  if (flag("to") && !toNet) { error(`--to must be one of ${Object.keys(GATEWAY_NETWORK_NAMES).join(", ")}`); return 2; }
  const amountFlag = flag("amount");
  // An amount without a source would be spent from EVERY domain with a
  // balance, once each: refused, and the domains it would spend from named.
  if (amountFlag != null && !fromNet) {
    error(`--amount needs --from: without it the amount would be withdrawn from each of ${domainNames()}. Name one source domain with --from.`);
    return 2;
  }
  const maxFeeUsd = Number(flag("max-fee", String(DEFAULT_MAX_FEE_USD)));
  if (!Number.isFinite(maxFeeUsd) || maxFeeUsd < 0) { error("--max-fee must be a non-negative number"); return 2; }
  const expiryRaw = flag("expiry-blocks", DEFAULT_EXPIRY_BLOCKS.toString());
  const expiryBlocks = /^[0-9]{1,9}$/.test(String(expiryRaw)) ? BigInt(expiryRaw) : -1n;
  if (expiryBlocks < MIN_EXPIRY_BLOCKS || expiryBlocks > MAX_EXPIRY_BLOCKS) { error(`--expiry-blocks must be a whole number from ${MIN_EXPIRY_BLOCKS} to ${MAX_EXPIRY_BLOCKS}`); return 2; }

  const key = String(env.GATEWAY_SELLER_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    error("GATEWAY_SELLER_KEY (the treasury's private key, 0x + 64 hex) must be set in this shell. It is never printed.");
    return 2;
  }
  const account = privateKeyToAccount(key);
  const seller = account.address;
  const recipient = flag("recipient") || seller;
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) { error("--recipient must be a 0x address"); return 2; }

  const client = new GatewayNanopaymentsClient({ fetchImpl });
  const domainsWanted = fromNet ? [GATEWAY_DOMAINS[fromNet]] : Object.values(GATEWAY_DOMAINS);
  const netByDomain = Object.fromEntries(Object.entries(GATEWAY_DOMAINS).map(([n, d]) => [String(d), n]));
  const balances = await client.balances({ depositor: seller, domains: domainsWanted });
  log(`seller ${seller}`);
  log(`Gateway USDC available: ${balances.usd} total`);
  for (const [domain, usd] of Object.entries(balances.byDomain)) log(`  domain ${domain} (${netByDomain[domain] || "?"}): ${usd}`);

  const plans = [];
  for (const [domain, usd] of Object.entries(balances.byDomain)) {
    const source = netByDomain[domain];
    if (!source) continue;
    const dest = toNet || source;
    // Room for Gateway's fee (see Fee above): the value is at most the
    // available balance less the fee ceiling, counted in USDC's 6 decimals.
    const availableAtomic = parseUnits(Number(usd).toFixed(6), 6);
    const feeAtomic = parseUnits(maxFeeUsd.toFixed(6), 6);
    const roomAtomic = availableAtomic > feeAtomic ? availableAtomic - feeAtomic : 0n;
    if (amountFlag != null) {
      const asked = Number(amountFlag);
      if (!Number.isFinite(asked) || asked <= 0) { log(`  domain ${domain}: nothing to withdraw`); continue; }
      if (parseUnits(asked.toFixed(6), 6) > roomAtomic) { error(`  domain ${domain}: --amount ${asked} leaves no room for the fee: at most ${formatUnits(roomAtomic, 6)} (the available ${usd} less --max-fee ${maxFeeUsd})`); return 2; }
    }
    if (roomAtomic <= 0n) { log(`  domain ${domain}: nothing to withdraw (the available ${usd} does not cover --max-fee ${maxFeeUsd})`); continue; }
    const amountUsd = amountFlag != null ? Number(amountFlag) : Number(formatUnits(roomAtomic, 6));
    let head;
    try { head = await currentBlock(source, { fetchImpl, env }); }
    catch (e) { error(`  domain ${domain}: could not read the current block on ${source} (${String(e?.message || e).slice(0, 120)}); a burn intent is never signed without an expiry`); return 1; }
    const spec = {
      version: 1, sourceDomain: Number(domain), destinationDomain: GATEWAY_DOMAINS[dest],
      sourceContract: b32(GATEWAY_WALLET), destinationContract: b32(GATEWAY_MINTER),
      sourceToken: b32(USDC[source]), destinationToken: b32(USDC[dest]),
      sourceDepositor: b32(seller), destinationRecipient: b32(recipient),
      sourceSigner: b32(seller), destinationCaller: b32(zeroAddress),
      value: parseUnits(amountUsd.toFixed(6), 6), salt: `0x${randomBytes(32).toString("hex")}`, hookData: "0x",
    };
    plans.push({ source, dest, amountUsd, head, burnIntent: { maxBlockHeight: head + expiryBlocks, maxFee: parseUnits(maxFeeUsd.toFixed(6), 6), spec } });
  }
  if (!plans.length) { log("nothing to withdraw"); return 0; }
  for (const p of plans) log(`plan: ${p.amountUsd} USDC from the ${p.source} domain to ${recipient} on ${p.dest} (max fee ${maxFeeUsd} USDC; the intent expires at ${p.source} block ${p.burnIntent.maxBlockHeight}, ${expiryBlocks} blocks past ${p.head})`);
  if (!execute) { log("dry run: pass --execute to sign the burn intent, fetch the attestation and mint on the destination chain"); return 0; }

  const bigintJson = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  for (const p of plans) {
    const signature = await account.signTypedData({ domain: { name: "GatewayWallet", version: "1" }, types: TYPES, primaryType: "BurnIntent", message: p.burnIntent });
    const res = await fetchImpl(`${GATEWAY_API_BASE}/v1/transfer`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify([{ burnIntent: p.burnIntent, signature }], bigintJson),
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { error(`Gateway /v1/transfer answered HTTP ${res.status} for the ${p.source} transfer; nothing minted`); return 1; }
    const out = await res.json();
    if (typeof out?.attestation !== "string" || typeof out?.signature !== "string") { error("Gateway answered without an attestation; nothing minted"); return 1; }
    log(`attestation for ${p.source}: transferId ${out.transferId}, fees ${out.fees?.total ?? "?"} ${out.fees?.token ?? ""}, expires at block ${out.expirationBlock ?? "?"}`);
    const rpc = evmRpcFor(p.dest, env);
    if (!rpc) { error(`no RPC configured for ${p.dest}; the attestation was not minted`); return 1; }
    const chain = { id: CHAIN_ID[p.dest], name: p.dest, nativeCurrency: { name: "gas", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
    const wallet = createWalletClient({ account, chain, transport: http(rpc) });
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const data = encodeFunctionData({
      abi: [{ type: "function", name: "gatewayMint", stateMutability: "nonpayable", inputs: [{ name: "attestationPayload", type: "bytes" }, { name: "signature", type: "bytes" }], outputs: [] }],
      functionName: "gatewayMint", args: [out.attestation, out.signature],
    });
    const hash = await wallet.sendTransaction({ to: GATEWAY_MINTER, data });
    log(`gatewayMint sent on ${p.dest}: ${hash}`);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    log(`  ${receipt.status === "success" ? "minted" : "REVERTED"} in block ${receipt.blockNumber} (${formatUnits(p.burnIntent.spec.value, 6)} USDC before fees)`);
    if (receipt.status !== "success") return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWithdraw().then((code) => { process.exitCode = code; }, (e) => { console.error(String(e?.message || e).slice(0, 200)); process.exitCode = 1; });
}
