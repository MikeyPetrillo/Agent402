// Move USDC.e on Tempo from the CI burner to the subscription rail's gas
// sponsor. DRY RUN unless LIVE=true.
//
// This exists because a standard EVM wallet cannot do it. Tempo transactions
// are type 0x76 with fees settled in a stablecoin (the receipt's `feeToken`),
// not EIP-1559 with native gas - `eth_getBalance` on Tempo returns a SENTINEL
// (4242... repeating), so a wallet that budgets native gas has nothing real to
// budget and the send fails before it is built. viem's tempo chain speaks the
// right type, which is the only reason this script is a few lines.
//
// It also has to PREPARE the request rather than sign a bare one: that is the
// exact defect the subscription canary found upstream - viem does not populate
// gas or fee fields on its own, and an unprepared transaction is signed with a
// zero gas price and refused with "gas price is less than basefee".
import { createWalletClient, createPublicClient, http, encodeFunctionData, isAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo } from "viem/tempo/chains";
import { prepareTransactionRequest, signTransaction, sendRawTransaction, waitForTransactionReceipt } from "viem/actions";
import { installPublicLog, figure } from "./lib/public-log.js";
// Under PUBLIC_LOG=1 (set by the workflow: its log is public) money figures print as words.
installPublicLog();

const RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
// Tempo ships two TIP-20 stablecoins and they are NOT interchangeable here.
// A SPONSORED transaction pays its fee in PathUSD unless something specifies
// otherwise, and mppx's subscription path never does: its `complete()` returns
// no feeToken, so the chain falls back to the default. Measured live - a
// sponsor funded only with USDC.e was refused `-32003 insufficient funds for
// gas * price + value: have 0 want 4859`, 4859 being PathUSD base units.
// So the gas sponsor needs PATHUSD; USDC.e is what the products are PRICED in.
const TOKENS = {
  usdc: "0x20C000000000000000000000b9537d11c60E8b50",
  pathusd: "0x20c0000000000000000000000000000000000000",
};
// A funding transfer is not a spend on anyone's behalf, but it is still money
// leaving a wallet from CI, so it is bounded the same way refund-run.js is.
const MAX_USD = Number(process.env.FUND_MAX_USD || 5);

const tokenKey = (process.env.FUND_TOKEN || "pathusd").trim().toLowerCase();
const to = (process.env.FEE_PAYER_ADDRESS || "").trim();
const amountUsd = Number(process.env.FUND_USD || 1);
const live = String(process.env.LIVE || "").toLowerCase() === "true";

const die = (m) => { console.error(`fund-tempo-fee-payer: ${m}`); process.exit(2); };
if (!isAddress(to)) die(`FEE_PAYER_ADDRESS is not an address: ${JSON.stringify(to)}`);
if (!Number.isFinite(amountUsd) || amountUsd <= 0) die(`FUND_USD must be positive, got ${JSON.stringify(process.env.FUND_USD)}`);
if (amountUsd > MAX_USD) die(`FUND_USD ${amountUsd} exceeds the ${MAX_USD} cap`);
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) die("no BURNER_KEY");
if (!Object.hasOwn(TOKENS, tokenKey)) die(`FUND_TOKEN must be one of ${Object.keys(TOKENS).join(", ")}, got ${JSON.stringify(tokenKey)}`);
const TOKEN = TOKENS[tokenKey];

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const target = getAddress(to);
if (target.toLowerCase() === account.address.toLowerCase()) die("refusing to send to the sender");

const pub = createPublicClient({ chain: tempo, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: tempo, transport: http(RPC) });

const ERC20 = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
const bal = (a) => pub.readContract({ address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [a] });
const usd = (u) => figure((Number(u) / 1e6).toFixed(6));

const units = BigInt(Math.round(amountUsd * 1e6));
const before = await bal(account.address);
const beforeTo = await bal(target);
console.log(`token  ${tokenKey} ${TOKEN}`);
console.log(`from   ${account.address}  ${usd(before)}`);
console.log(`to     ${target}  ${usd(beforeTo)}`);
console.log(`amount ${usd(units)}`);
if (before < units) die(`sender holds ${usd(before)}, needs ${usd(units)}`);

const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [target, units] });
if (!live) {
  const gas = await pub.estimateGas({ account: account.address, to: TOKEN, data });
  console.log(`DRY RUN (set LIVE=true to send). estimated gas ${gas}`);
  process.exit(0);
}

// Prepare, do not hand-roll: this is what populates gas and fee fields.
const prepared = await prepareTransactionRequest(wallet, { account, chainId: tempo.id, calls: [{ to: TOKEN, data }] });
const serialized = await signTransaction(wallet, prepared);
const hash = await sendRawTransaction(wallet, { serializedTransaction: serialized });
console.log(`sent ${hash}`);
const receipt = await waitForTransactionReceipt(pub, { hash });
console.log(`status ${receipt.status}  gasUsed ${receipt.gasUsed}  feeToken ${receipt.feeToken || "(n/a)"}`);
if (receipt.status !== "success") die("transfer reverted");
console.log(`after  ${target}  ${usd(await bal(target))}`);
console.log("PASS - gas sponsor funded.");
