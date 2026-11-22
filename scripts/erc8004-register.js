#!/usr/bin/env node
// Register Agent402 in the ERC-8004 identity registry on Base, once.
//
// The registry (0x8004A169…a432, an ERC-721 behind a proxy) mints an agent id
// to whoever calls `register(string agentURI)`. The URI must resolve to our
// registration file, which src/server.js serves at
// /.well-known/agent-registration.json with the EIP's required fields.
//
// DRY BY DEFAULT. Nothing is signed unless LIVE=true, because this writes to a
// public registry under our own name and cannot be undone by us - the token can
// be transferred, not unminted. Run it dry first and read what it prints.
//
// Money: one ERC-721 mint on Base. Bounded by MAX_GAS_USD (default $0.50) from
// a live gas estimate; over the bound it refuses rather than guessing. The key
// is the Base spending wallet (the same one the attest tool signs with), never
// the treasury.
//
// Idempotent: it reads our balance in the registry first and refuses to mint a
// second identity, printing the id we already hold. A registry that cannot be
// read is a refusal, never a second mint.
//
//   LIVE=true BASE_KEY=0x... AGENT_URI=https://agent402.tools/.well-known/agent-registration.json \
//     node scripts/erc8004-register.js
import { createPublicClient, createWalletClient, http, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { installPublicLog, figure } from "./lib/public-log.js";
// Under PUBLIC_LOG=1 (set by the workflow: its log is public) dollar figures print as words.
installPublicLog();

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const RPC = process.env.AGENT402_BASE_RPC || "https://mainnet.base.org";
const LIVE = String(process.env.LIVE || "").toLowerCase() === "true";
const MAX_GAS_USD = Number(process.env.MAX_GAS_USD || 0.5);
const ETH_USD = Number(process.env.ETH_USD || 5000); // deliberately high: a high price makes the bound STRICTER
const AGENT_URI = String(process.env.AGENT_URI || "https://agent402.tools/.well-known/agent-registration.json");

const ABI = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

const key = (process.env.BASE_KEY || "").trim();
if (!key) { console.error("BASE_KEY is required (the Base spending wallet, never the treasury)"); process.exit(2); }
if (!/^https:\/\//.test(AGENT_URI)) { console.error(`AGENT_URI must be https, got ${AGENT_URI}`); process.exit(2); }

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const pub = createPublicClient({ chain: base, transport: http(RPC) });
console.log(`wallet ${account.address}`);
console.log(`registry ${REGISTRY} on Base`);
console.log(`agentURI ${AGENT_URI}`);

// The URI has to resolve BEFORE we mint: an identity pointing at a 404 is worse
// than no identity, and this is the one moment it is free to check.
const probe = await fetch(AGENT_URI, { signal: AbortSignal.timeout(15000) }).catch((e) => ({ ok: false, status: 0, _err: e }));
if (!probe.ok) { console.error(`agentURI does not resolve (HTTP ${probe.status || 0}${probe._err ? ` ${probe._err.message}` : ""}) - refusing to mint an identity that points nowhere`); process.exit(1); }
const doc = await probe.json().catch(() => null);
const missing = ["type", "name", "description", "image", "services"].filter((f) => doc?.[f] === undefined);
if (missing.length) { console.error(`agentURI resolves but is missing required field(s): ${missing.join(", ")}`); process.exit(1); }
console.log(`agentURI resolves and carries every required field (name "${doc.name}", ${doc.services.length} services)`);

let owned;
try { owned = await pub.readContract({ address: REGISTRY, abi: ABI, functionName: "balanceOf", args: [account.address] }); }
catch (e) { console.error(`could not read the registry (${e.shortMessage || e.message}) - refusing rather than risking a second mint`); process.exit(1); }
if (owned > 0n) {
  let id = "unknown";
  try { id = String(await pub.readContract({ address: REGISTRY, abi: ABI, functionName: "tokenOfOwnerByIndex", args: [account.address, 0n] })); } catch { /* enumeration is optional */ }
  console.log(`ALREADY REGISTERED: this wallet holds ${owned} agent identity(ies), first id ${id}. Nothing to do.`);
  process.exit(0);
}

let gas;
try { gas = await pub.estimateContractGas({ address: REGISTRY, abi: ABI, functionName: "register", args: [AGENT_URI], account }); }
catch (e) { console.error(`gas estimate failed (${e.shortMessage || e.message})`); process.exit(1); }
const price = await pub.getGasPrice();
const costWei = gas * price;
const costUsd = Number(formatEther(costWei)) * ETH_USD;
console.log(`estimate ${gas} gas at ${price} wei = ${formatEther(costWei)} ETH ~= $${costUsd.toFixed(4)} (bound $${MAX_GAS_USD})`);
if (costUsd > MAX_GAS_USD) { console.error("over the gas bound - refusing"); process.exit(1); }

const bal = await pub.getBalance({ address: account.address });
console.log(`wallet ETH ${figure(formatEther(bal))}`);
if (bal < costWei * 2n) { console.error("wallet ETH is under twice the estimate - top up before minting"); process.exit(1); }

if (!LIVE) { console.log("\nDRY RUN - nothing signed. Re-run with LIVE=true to mint."); process.exit(0); }

const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
const hash = await wallet.writeContract({ address: REGISTRY, abi: ABI, functionName: "register", args: [AGENT_URI] });
console.log(`submitted ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 180000 });
console.log(`status ${rcpt.status} in block ${rcpt.blockNumber}, gas used ${rcpt.gasUsed}`);
if (rcpt.status !== "success") process.exit(1);
let id = "unknown";
try { id = String(await pub.readContract({ address: REGISTRY, abi: ABI, functionName: "tokenOfOwnerByIndex", args: [account.address, 0n] })); } catch { /* fall back to the logs */ }
console.log(`\nAGENT ID ${id}`);
console.log(`Set ERC8004_AGENT_ID=${id} on Railway so /.well-known/agent-registration.json publishes it.`);
