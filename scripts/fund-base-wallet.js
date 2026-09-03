#!/usr/bin/env node
// Send USDC on Base from the CI canary burner to one address (dispatch-only,
// DRY RUN by default, capped). Built 2026-08-28 to fund the AgentCore Payments
// test instrument so the x402 buyer sample can be retested on mainnet; the
// burner key lives only in Actions secrets, so a funding transfer has to be a
// workflow. Same shape as fund-tempo-fee-payer.js, on a normal EVM chain:
// gas is native ETH (the burner holds a little), the token is Base USDC.
import { createWalletClient, createPublicClient, http, encodeFunctionData, isAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = process.env.AGENT402_BASE_RPC || "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX_USD = Number(process.env.FUND_MAX_USD || 5);
const to = (process.env.FUND_ADDRESS || "").trim();
const amountUsd = Number(process.env.FUND_USD || 1);
const live = String(process.env.LIVE || "").toLowerCase() === "true";

const die = (m) => { console.error(`fund-base-wallet: ${m}`); process.exit(2); };
if (!isAddress(to)) die(`FUND_ADDRESS is not an address: ${JSON.stringify(to)}`);
if (!Number.isFinite(amountUsd) || amountUsd <= 0) die(`FUND_USD must be positive, got ${JSON.stringify(process.env.FUND_USD)}`);
if (amountUsd > MAX_USD) die(`FUND_USD ${amountUsd} exceeds the ${MAX_USD} cap`);
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) die("no BURNER_KEY");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const target = getAddress(to);
if (target.toLowerCase() === account.address.toLowerCase()) die("refusing to send to the sender");

const pub = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
const ERC20 = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
const bal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [a] });
const usd = (u) => (Number(u) / 1e6).toFixed(6);

const units = BigInt(Math.round(amountUsd * 1e6));
const before = await bal(account.address);
const beforeTo = await bal(target);
const eth = await pub.getBalance({ address: account.address });
console.log(`from   ${account.address}  ${usd(before)} USDC  ${(Number(eth) / 1e18).toFixed(6)} ETH`);
console.log(`to     ${target}  ${usd(beforeTo)} USDC`);
console.log(`amount ${usd(units)} USDC on Base`);
if (before < units) die(`sender holds ${usd(before)}, needs ${usd(units)}`);
if (eth === 0n) die("sender holds no ETH on Base for gas");

const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [target, units] });
const gas = await pub.estimateGas({ account: account.address, to: USDC, data });
if (!live) { console.log(`DRY RUN (set LIVE=true to send). estimated gas ${gas}`); process.exit(0); }

const hash = await wallet.sendTransaction({ to: USDC, data, gas });
console.log(`sent ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status ${receipt.status}  gasUsed ${receipt.gasUsed}`);
if (receipt.status !== "success") die("transfer reverted");
console.log(`after  ${target}  ${usd(await bal(target))} USDC`);
console.log("PASS - wallet funded on Base.");
