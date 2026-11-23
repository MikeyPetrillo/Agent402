// wallet-balances: a wallet's token balances read from this service's own RPC
// lanes, never from an indexed data API.
//
//   EVM (base, ethereum, base-sepolia): the keyed EVM lane (ALCHEMY_API_KEY):
//     eth_getBalance for the native coin and alchemy_getTokenBalances for
//     every ERC-20 the address holds, two reads side by side.
//   Solana (solana, solana-devnet): the configured Solana RPC (SOLANA_RPC_URL;
//     devnet SOLANA_DEVNET_RPC_URL, else the same keyed provider's devnet
//     host): getBalance for SOL and getTokenAccountsByOwner for the SPL Token
//     and Token-2022 programs, three reads side by side.
//
// Symbol, name and decimals come from the list below (the tokens most wallets
// here hold, USDC on every network); another token's row carries its contract
// and raw amount with those fields null. A network with no lane on this
// deployment answers 503 naming it, before any read. Each read runs under its
// own cap and the handler's budget (src/upstream-deadline.js); an upstream's
// own error text is never relayed to the buyer.
import { upstreamFetch, bodyUnderDeadline } from "../upstream-deadline.js";
import { formatUnits } from "./alchemy-data-kit.js";

const READ_MS = 10_000;
export const BALANCES_MAX_ROWS = 100;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const EVM_SUBDOMAIN = Object.freeze({ base: "base-mainnet", ethereum: "eth-mainnet", "base-sepolia": "base-sepolia" });
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Symbol, name and decimals of the tokens most wallets here hold, so their
// rows need no metadata read. Lowercase EVM contracts; Solana mints as is.
const KNOWN = Object.freeze({
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ["USDC", "USD Coin", 6],
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": ["USDbC", "USD Base Coin", 6],
    "0x4200000000000000000000000000000000000006": ["WETH", "Wrapped Ether", 18],
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": ["cbBTC", "Coinbase Wrapped BTC", 8],
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": ["DAI", "Dai Stablecoin", 18],
    "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": ["EURC", "EURC", 6],
  },
  ethereum: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ["USDC", "USD Coin", 6],
    "0xdac17f958d2ee523a2206206994597c13d831ec7": ["USDT", "Tether USD", 6],
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": ["WETH", "Wrapped Ether", 18],
    "0x6b175474e89094c44da98b954eedeac495271d0f": ["DAI", "Dai Stablecoin", 18],
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": ["WBTC", "Wrapped BTC", 8],
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": ["cbBTC", "Coinbase Wrapped BTC", 8],
  },
  "base-sepolia": {
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e": ["USDC", "USDC", 6],
  },
  solana: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: ["USDC", "USD Coin", 6],
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: ["USDT", "USDT", 6],
    So11111111111111111111111111111111111111112: ["wSOL", "Wrapped SOL", 9],
  },
  "solana-devnet": {
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": ["USDC", "USDC", 6],
  },
});

/** The EVM lane's URL for `network`, or null when this deployment has none. */
export function evmBalancesUrl(network, env = process.env) {
  const key = String(env.ALCHEMY_API_KEY || "").trim();
  const sub = EVM_SUBDOMAIN[network];
  return key && sub ? `https://${sub}.g.alchemy.com/v2/${key}` : null;
}

/** The Solana lane's URL for `network`, or null when this deployment has none. */
export function solanaBalancesUrl(network, env = process.env) {
  const main = String(env.SOLANA_RPC_URL || "").trim();
  if (network === "solana") return main || null;
  if (network !== "solana-devnet") return null;
  const devnet = String(env.SOLANA_DEVNET_RPC_URL || "").trim();
  if (devnet) return devnet;
  try {
    const u = new URL(main);
    if (u.host === "solana-mainnet.g.alchemy.com") { u.host = "solana-devnet.g.alchemy.com"; return u.toString(); }
  } catch { /* no main lane */ }
  return null;
}

const noLane = (network) => bad(`wallet-balances on ${network} is not available on this deployment: its RPC lane is not configured`, 503);

async function rpcPost(url, body, label, step) {
  const ctx = { label, step, timeoutMs: READ_MS, tag: "[wallet-balances]" };
  const res = await upstreamFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }, ctx);
  if (res.status === 429) throw bad(`${label} rate limit reached - retry shortly`, 503);
  if (!res.ok) throw bad(`${label} error (HTTP ${res.status})`, 502);
  try { return await bodyUnderDeadline(res.json(), ctx); }
  catch (err) { if (err?.statusCode) throw err; throw bad(`${label} returned non-JSON`, 502); }
}

/** One JSON-RPC read's result; a refusal is a 502 that relays none of the
 *  upstream's text. */
async function rpcCall(url, method, params, label) {
  const a = await rpcPost(url, { jsonrpc: "2.0", id: 1, method, params }, label, method);
  if (!a || typeof a !== "object" || a.error || a.result === undefined) throw bad(`${label} refused the ${method} read`, 502);
  return a.result;
}

const decString = (v) => {
  try { return BigInt(v).toString(10); } catch { return null; }
};
const row = (symbol, name, contract, raw, decimals, extra = {}) => ({
  symbol: symbol ?? null,
  name: name ?? null,
  contract,
  amount: raw != null && Number.isInteger(decimals) ? formatUnits(raw, decimals) : null,
  raw: raw ?? "0",
  decimals: Number.isInteger(decimals) ? decimals : null,
  ...extra,
});

async function evmBalances(address, network) {
  const url = evmBalancesUrl(network);
  if (!url) throw noLane(network);
  const label = "Chain RPC";
  const [nativeHex, tokenPage] = await Promise.all([
    rpcCall(url, "eth_getBalance", [address, "latest"], label),
    rpcCall(url, "alchemy_getTokenBalances", [address, "erc20"], label),
  ]);
  const known = KNOWN[network] || {};
  const held = (Array.isArray(tokenPage?.tokenBalances) ? tokenPage.tokenBalances : [])
    .map((t) => ({ contract: String(t?.contractAddress || "").toLowerCase(), raw: decString(t?.tokenBalance) }))
    .filter((t) => /^0x[0-9a-f]{40}$/.test(t.contract) && t.raw && t.raw !== "0");
  const rows = [];
  const nativeRaw = decString(nativeHex);
  if (nativeRaw && nativeRaw !== "0") rows.push(row("ETH", "Ether", null, nativeRaw, 18, { native: true }));
  const listed = held.slice(0, BALANCES_MAX_ROWS - rows.length);
  for (const t of listed) {
    const k = known[t.contract];
    rows.push(k ? row(k[0], k[1], t.contract, t.raw, k[2]) : row(null, null, t.contract, t.raw, null));
  }
  const truncated = held.length > listed.length || !!tokenPage?.pageKey;
  return { rows, truncated };
}

async function solanaBalances(address, network) {
  const url = solanaBalancesUrl(network);
  if (!url) throw noLane(network);
  const label = "Solana RPC";
  const [lamports, spl, spl2022] = await Promise.all([
    rpcCall(url, "getBalance", [address], label),
    rpcCall(url, "getTokenAccountsByOwner", [address, { programId: SPL_TOKEN }, { encoding: "jsonParsed" }], label),
    rpcCall(url, "getTokenAccountsByOwner", [address, { programId: SPL_TOKEN_2022 }, { encoding: "jsonParsed" }], label),
  ]);
  const known = KNOWN[network] || {};
  const rows = [];
  const sol = decString(lamports?.value);
  if (sol && sol !== "0") rows.push(row("SOL", "Solana", null, sol, 9, { native: true }));
  const accounts = [...(Array.isArray(spl?.value) ? spl.value : []), ...(Array.isArray(spl2022?.value) ? spl2022.value : [])];
  // One row per mint: a wallet can hold several token accounts of one mint.
  const byMint = new Map();
  for (const a of accounts) {
    const info = a?.account?.data?.parsed?.info;
    const mint = typeof info?.mint === "string" ? info.mint : null;
    const raw = decString(info?.tokenAmount?.amount);
    const decimals = info?.tokenAmount?.decimals;
    if (!mint || !raw || raw === "0") continue;
    const cur = byMint.get(mint);
    byMint.set(mint, { mint, raw: cur ? (BigInt(cur.raw) + BigInt(raw)).toString(10) : raw, decimals: Number.isInteger(decimals) ? decimals : cur?.decimals ?? null });
  }
  const held = [...byMint.values()];
  const listed = held.slice(0, BALANCES_MAX_ROWS - rows.length);
  for (const t of listed) {
    const k = known[t.mint];
    rows.push(row(k?.[0], k?.[1], t.mint, t.raw, t.decimals ?? k?.[2] ?? null));
  }
  return { rows, truncated: held.length > listed.length };
}

/** `{ balances, truncated }` for a validated address on a validated network. */
export async function readWalletBalances(address, network) {
  const { rows, truncated } = network.startsWith("solana") ? await solanaBalances(address, network) : await evmBalances(address, network);
  return { balances: rows, truncated };
}
