// token-facts: the facts token-safety and token-risk report about an EVM token,
// computed here from sources whose terms allow it:
//
//   chain RPC (the commercial-use lanes of src/evm-rpcs.js and the PublicNode
//   endpoints of src/rpc-terms.js; the keyed lane last):
//     eth_call       name, symbol, decimals, totalSupply, owner()/getOwner(),
//                    pendingOwner(), balances (owner share, LP burn share)
//     eth_getStorageAt  the EIP-1967 implementation, admin and beacon slots,
//                    the EIP-1822 slot and the ZeppelinOS slots (proxy)
//     eth_simulateV1 a small buy then sell against the token's deepest pool
//                    (taxes, honeypot); nothing is ever sent
//     eth_getLogs    the Transfer history, read whole on the keyed lane only,
//                    for a token small enough (holders)
//   Sourcify (v2 API): verification, ABI and source of the token and of its
//     implementation when it is a proxy (privileged functions, selfdestruct)
//   DexScreener: the token's pairs (the pool to simulate against, liquidity)
//
// A field this module cannot compute is null, and `limits` names it with the
// reason; nothing is guessed. Every read is bounded: one deadline per call
// (FACTS_BUDGET_MS), a cap on RPC requests (MAX_RPC_REQUESTS) and a cap on
// the Transfer logs a holder index reads (HOLDER_LOG_CAP).
import { decodeAbiParameters, encodeFunctionData, formatUnits, hexToString, parseAbi } from "viem";
import { upstreamFetch, bodyUnderDeadline } from "../upstream-deadline.js";
import { evmRpcLanesFor } from "../evm-rpcs.js";
import { PUBLICNODE_RPCS, alchemyRpcFor } from "../rpc-terms.js";

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** The chains served: each has a commercial-use RPC lane, Sourcify coverage
 *  and a DexScreener slug. One list for token-safety and token-risk. */
export const TOKEN_CHAINS = Object.freeze({
  base: { id: 8453, dex: "base" },
  ethereum: { id: 1, dex: "ethereum" },
  polygon: { id: 137, dex: "polygon" },
  arbitrum: { id: 42161, dex: "arbitrum" },
  optimism: { id: 10, dex: "optimism" },
  bsc: { id: 56, dex: "bsc" },
  gnosis: { id: 100, dex: "gnosischain" },
  celo: { id: 42220, dex: "celo" },
});
export const TOKEN_CHAIN_NAMES = Object.freeze(Object.keys(TOKEN_CHAINS));

/** The RPC lanes for `chain`, in the order they are tried: the PublicNode
 *  endpoint, then the operator override, the public default and the keyed
 *  lane (src/evm-rpcs.js), each once. */
export function tokenRpcLanes(chain, env = process.env) {
  const c = TOKEN_CHAINS[chain];
  if (!c) return [];
  return [PUBLICNODE_RPCS[chain], ...evmRpcLanesFor(`eip155:${c.id}`, env)]
    .map((u) => String(u || "").trim()).filter((u, i, a) => u && a.indexOf(u) === i);
}
/** The keyed lane that reads a whole Transfer history, or null. */
export const holderLogLane = (chain, env = process.env) => (TOKEN_CHAINS[chain] ? alchemyRpcFor(`eip155:${TOKEN_CHAINS[chain].id}`, env) : null);

export const FACTS_BUDGET_MS = 16_000;
export const RPC_READ_MS = 6_000;
export const MAX_RPC_REQUESTS = 10;
export const HOLDER_LOG_CAP = 10_000;
const SOURCIFY_READ_MS = 8_000;
const DEX_READ_MS = 8_000;
const OPTIONAL_FLOOR_MS = 2_500;

export const SLOTS = Object.freeze({
  eip1967Implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  eip1822Proxiable: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
  zosImplementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zosAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
});
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
// The simulated buyer: an address with no code and no history.
export const SIM_BUYER = "0x7a1c9b3e0d1f4c2a8b6e5d4c3b2a19087f6e5d4c";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ERC20 = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function owner() view returns (address)",
  "function getOwner() view returns (address)", "function pendingOwner() view returns (address)",
  "function transfer(address,uint256) returns (bool)", "function implementation() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const data = (functionName, args) => encodeFunctionData({ abi: ERC20, functionName, args });

// ---- decoding ---------------------------------------------------------------
const isHex = (v) => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
export function wordAddress(hex) {
  if (!isHex(hex) || hex.length < 66) return null;
  const a = `0x${hex.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(a) ? null : a;
}
export function decodeUint(hex) {
  if (!isHex(hex) || hex.length < 66) return null;
  try { return BigInt(hex.slice(0, 66)); } catch { return null; }
}
export function decodeAddress(hex) {
  if (!isHex(hex) || hex.length !== 66) return undefined;
  if (!/^0x0{24}/.test(hex)) return undefined;
  return `0x${hex.slice(26)}`.toLowerCase();
}
/** A string() answer, or a bytes32 one (older tokens), or null. */
export function decodeText(hex) {
  if (!isHex(hex) || hex.length < 66) return null;
  try {
    const [s] = decodeAbiParameters([{ type: "string" }], hex);
    const t = String(s).replace(/\p{Cc}/gu, "").trim();
    if (t) return t.slice(0, 120);
  } catch { /* not a string() answer */ }
  if (hex.length === 66) {
    try { const t = hexToString(hex, { size: 32 }).replace(/\u0000+$/, "").replace(/\p{Cc}/gu, "").trim(); return t ? t.slice(0, 120) : null; } catch { return null; }
  }
  return null;
}
const round2 = (n) => Math.round(n * 100) / 100;
/** `part` / `whole` as a percentage, two decimals, or null. */
export function pctOf(part, whole) {
  if (typeof part !== "bigint" || typeof whole !== "bigint" || whole <= 0n) return null;
  return Number((part * 1_000_000n) / whole) / 10_000;
}

// ---- RPC --------------------------------------------------------------------
const LANE_REFUSAL = /rate|limit|too many|capacity|archive|personal token|unauthori[sz]ed|forbidden|method not (found|supported|available)|not supported|-32601|-32005/i;

/** One JSON-RPC batch, lane by lane until one answers it whole. Each entry
 *  comes back as { result } or { error }; a lane that refuses the batch (an
 *  HTTP failure, a rate limit, an unreadable body) is passed over. */
export async function rpcBatch(state, calls, step, { lanes = state.lanes, timeoutMs = RPC_READ_MS } = {}) {
  let last = null;
  for (const url of lanes) {
    if (state.requests >= MAX_RPC_REQUESTS) throw Object.assign(bad(`the chain read's request budget (${MAX_RPC_REQUESTS}) was spent before ${step}`, 503), { attribution: "ours", budgetSpent: true });
    const left = state.deadline - Date.now();
    if (left < 500) throw Object.assign(bad(`the chain read's time budget was spent before ${step}`, 503), { attribution: "ours", budgetSpent: true });
    state.requests++;
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
    const ctx = { label: "Chain RPC", step, timeoutMs: Math.min(timeoutMs, left), tag: "[token-facts]" };
    try {
      const res = await upstreamFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }, ctx);
      if (!res.ok) { last = Object.assign(bad(`chain RPC answered HTTP ${res.status} for ${step}`, 502), { attribution: "upstream", upstreamStatus: res.status }); continue; }
      let j;
      try { j = await bodyUnderDeadline(res.json(), ctx); } catch (e) { last = e?.statusCode ? e : Object.assign(bad(`chain RPC returned an unreadable body for ${step}`, 502), { attribution: "upstream" }); continue; }
      if (!Array.isArray(j) || j.length !== calls.length) { last = Object.assign(bad(`chain RPC did not answer the batch for ${step}`, 502), { attribution: "upstream" }); continue; }
      const byId = new Map(j.map((e) => [e?.id, e]));
      const out = calls.map((_, i) => byId.get(i + 1) || { error: { message: "missing" } });
      if (out.some((e) => e?.error && LANE_REFUSAL.test(`${e.error.code ?? ""} ${e.error.message ?? ""}`))) { last = Object.assign(bad(`chain RPC refused ${step}`, 503), { attribution: "upstream" }); continue; }
      return out;
    } catch (e) {
      last = e;
    }
  }
  throw last || bad(`no chain RPC lane for ${step}`, 503);
}
const resultOf = (e) => (e && !e.error && isHex(e.result) ? e.result : null);
const callOf = (to, d, from) => ({ method: "eth_call", params: [{ ...(from ? { from } : {}), to, data: d }, "latest"] });

// ---- Sourcify ----------------------------------------------------------------
/** Sourcify's record of `address`: { verified, match, compiler, verifiedAt,
 *  abi, sourceText, proxyImplementations } or { verified: false } on a clean
 *  miss. An upstream failure throws. */
export async function readSourcify(chainId, address) {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi,proxyResolution,compilation,sources`;
  const ctx = { label: "Sourcify", step: "verification", timeoutMs: SOURCIFY_READ_MS, tag: "[token-facts]" };
  const res = await upstreamFetch(url, { headers: { accept: "application/json" } }, ctx);
  if (res.status === 404) return { verified: false };
  if (!res.ok) throw Object.assign(bad(`Sourcify answered HTTP ${res.status}`, 502), { attribution: "upstream", upstreamStatus: res.status });
  let j;
  try { j = await bodyUnderDeadline(res.json(), ctx); } catch (e) { if (e?.statusCode) throw e; throw Object.assign(bad("Sourcify returned an unreadable body", 502), { attribution: "upstream" }); }
  const match = j?.match || j?.runtimeMatch || j?.creationMatch || null;
  if (!match) return { verified: false };
  const srcs = j?.sources && typeof j.sources === "object" ? Object.values(j.sources) : [];
  const sourceText = srcs.map((s) => (typeof s === "string" ? s : s?.content)).filter((s) => typeof s === "string").join("\n\n").slice(0, 600 * 1024);
  const impls = Array.isArray(j?.proxyResolution?.implementations) ? j.proxyResolution.implementations.map((x) => String(x?.address || "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)) : [];
  return {
    verified: true, match, compiler: j?.compilation?.compilerVersion || null, verifiedAt: j?.verifiedAt || null,
    abi: Array.isArray(j?.abi) ? j.abi : null, sourceText,
    isProxy: j?.proxyResolution?.isProxy === true, proxyImplementations: impls,
  };
}

// ---- DexScreener ------------------------------------------------------------
/** The token's pairs on `chain`, deepest first (DexScreener's computed fields). */
export async function probeDexPairs({ chain, address }) {
  const c = TOKEN_CHAINS[chain]?.dex;
  if (!c) throw bad(`DexScreener does not cover ${chain}`, 422);
  const ctx = { label: "DEX pairs source", step: "pairs", timeoutMs: DEX_READ_MS, tag: "[token-facts]" };
  const res = await upstreamFetch(`https://api.dexscreener.com/token-pairs/v1/${c}/${address}`, { headers: { accept: "application/json" } }, ctx);
  if (!res.ok) throw Object.assign(bad(`upstream HTTP ${res.status}`, res.status === 429 ? 503 : 502), { upstreamStatus: res.status, attribution: "upstream" });
  let arr;
  try { arr = await bodyUnderDeadline(res.json(), ctx); } catch (e) { if (e?.statusCode) throw e; throw Object.assign(bad("DEX pairs source returned an unreadable body", 502), { attribution: "upstream" }); }
  const pairs = (Array.isArray(arr) ? arr : []).map((p) => ({
    dex: p.dexId || null, labels: Array.isArray(p.labels) ? p.labels.map(String).slice(0, 4) : [], pair: p.pairAddress || null,
    baseAddress: p.baseToken?.address || null, quoteAddress: p.quoteToken?.address || null, quote: p.quoteToken?.symbol || null,
    priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
    liquidityUsd: Number(p.liquidity?.usd) || 0, volume24h: Number(p.volume?.h24) || 0, volume1h: Number(p.volume?.h1) || 0,
    buys24h: Number(p.txns?.h24?.buys) || 0, sells24h: Number(p.txns?.h24?.sells) || 0, buys1h: Number(p.txns?.h1?.buys) || 0, sells1h: Number(p.txns?.h1?.sells) || 0,
    fdv: p.fdv != null ? Number(p.fdv) : null, marketCap: p.marketCap != null ? Number(p.marketCap) : null, createdAt: p.pairCreatedAt ? new Date(Number(p.pairCreatedAt)).toISOString() : null,
    hasProfile: Boolean(p.info && (p.info.imageUrl || (p.info.websites || []).length || (p.info.socials || []).length)),
    websites: Array.isArray(p.info?.websites) ? p.info.websites.map((w) => w.url).filter(Boolean).slice(0, 2) : [],
  })).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { totalPairs: pairs.length, liquidityUsd: pairs.reduce((a, p) => a + p.liquidityUsd, 0), volume24h: pairs.reduce((a, p) => a + p.volume24h, 0), txns24h: pairs.reduce((a, p) => a + p.buys24h + p.sells24h, 0), pairs: pairs.slice(0, 8) };
}

// ---- ABI reading --------------------------------------------------------------
// Function names that ARE owner privileges: what an ABI can tell a reader that
// a verification badge cannot.
const PRIVILEGE_RE = /^(mint|mintTo|burnFrom|pause|unpause|blacklist|unblacklist|setBlacklist|addToBlacklist|removeFromBlacklist|setFee|setFees|setTax|setTaxes|setBuyTax|setSellTax|setMaxTx|setMaxTxAmount|setMaxWallet|setSwapAndLiquify|excludeFromFee|excludeFromFees|includeInFee|setTradingEnabled|enableTrading|openTrading|setRouter|updateRouter|transferOwnership|renounceOwnership|upgradeTo|upgradeToAndCall|setImplementation|rescueTokens|withdrawTokens|clearStuckBalance|setCooldown|setLimits|setAntiWhale|setMaxHolding|freeze|unfreeze|setWhitelist|addWhitelist|lockTokens|disableTransfers|setTransfersEnabled|configureMinter|updateMasterMinter|updatePauser|updateBlacklister|changeAdmin)$/i;
export function privilegedFunctions(abi) {
  const fns = (Array.isArray(abi) ? abi : []).filter((x) => x && x.type === "function" && x.name);
  return { total: fns.length, privileged: [...new Set(fns.map((f) => f.name).filter((n) => PRIVILEGE_RE.test(n)))].sort(), writable: fns.filter((f) => !/^(view|pure)$/.test(String(f.stateMutability || ""))).length };
}
const ABI_FLAGS = {
  mintable: /^(mint|mintTo|mintFor|mintTokens|issue|configureMinter)$/i,
  transferPausable: /^(pause|setPaused|togglePause|pauseTransfers|disableTransfers|setTransfersEnabled|setTradingEnabled|setTradingStatus|stopTrading)$/i,
  blacklist: /^(blacklist|setBlacklist|addToBlacklist|blacklistAddress|setBlacklisted|blockAddress|addBlocklist|setBlocklist|addToBlocklist|setDenylist|setBot|setBots|addBot|addBots|blockBots|setSniper|setSnipers|freeze|freezeAccount)$/i,
  whitelist: /^(whitelist|setWhitelist|addWhitelist|addToWhitelist|setWhitelisted|setAllowlist|addToAllowlist)$/i,
  slippageModifiable: /^(set|update|change)(Buy|Sell|Transfer|Total|Marketing|Liquidity|Dev|Swap)?(Fee|Fees|Tax|Taxes|TaxRate|TaxRates|FeePercent|FeePercents)$/i,
  tradingCooldown: /cooldown/i,
  antiWhaleModifiable: /^((set|update|change)(Max(Tx|TxAmount|Transaction|TransactionAmount|Wallet|WalletSize|WalletAmount|Holding|Buy|Sell)(Amount|Percent)?|Limits)|removeLimits)$/i,
  upgradeable: /^(upgradeTo|upgradeToAndCall|setImplementation|changeImplementation)$/i,
  takeBackOwnership: /^(unlock|reclaimOwnership|takeBackOwnership|recoverOwnership|regainOwnership)$/i,
};
const ANTI_WHALE_VIEW = /^(max(Tx|TxAmount|Transaction|TransactionAmount|Wallet|WalletSize|WalletAmount|Holding|Buy|Sell)(Amount|Percent)?|_max(Tx|Wallet)\w*)$/i;
/** Each ABI flag: true when a function of that name is present, false when an
 *  ABI was read and none is, null when no ABI was read. */
export function abiFlags(abi) {
  if (!Array.isArray(abi)) return Object.fromEntries([...Object.keys(ABI_FLAGS), "antiWhale"].map((k) => [k, null]));
  const fns = abi.filter((x) => x && x.type === "function" && x.name);
  const writes = fns.filter((f) => !/^(view|pure)$/.test(String(f.stateMutability || "")) && f.constant !== true);
  const has = (re, list = writes) => list.some((f) => re.test(f.name));
  const out = Object.fromEntries(Object.entries(ABI_FLAGS).map(([k, re]) => [k, has(re)]));
  out.antiWhale = out.antiWhaleModifiable || has(ANTI_WHALE_VIEW, fns);
  return out;
}

// ---- the probe ----------------------------------------------------------------
/** Is `code` an EIP-1167 minimal proxy? Its target, or null. */
export function minimalProxyTarget(code) {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(String(code || ""));
  return m ? `0x${m[1].toLowerCase()}` : null;
}

const NOT_DERIVABLE = {
  hiddenOwner: "a hidden owner needs bytecode analysis, which this tool does not run",
  ownerChangeBalance: "whether the owner can change balances is not derivable from the ABI or state reads",
  externalCall: "external calls in transfers are not derivable from the ABI or state reads",
  creatorAddress: "the contract creator is not read",
  creatorPct: "the contract creator is not read",
  lpHolderCount: "LP holder lists are not indexed",
  trustList: "no trust list is read",
  fakeToken: "no counterfeit list is read",
};

/** Every fact about `address` on `chain` (see the header). Throws 422 when the
 *  address holds no contract or does not answer the ERC-20 supply calls, and
 *  503/502 when no chain lane answered. */
export async function readTokenFacts({ chain, address }, deps = {}) {
  const c = TOKEN_CHAINS[chain];
  if (!c) throw bad(`"chain" must be one of: ${TOKEN_CHAIN_NAMES.join(", ")}`, 422);
  const token = String(address).toLowerCase();
  const env = deps.env || process.env;
  const state = { lanes: deps.lanes || tokenRpcLanes(chain, env), requests: 0, deadline: Date.now() + (deps.budgetMs || FACTS_BUDGET_MS) };
  if (!state.lanes.length) throw bad(`no chain RPC lane is configured for ${chain}`, 503);
  const sourcify = deps.readSourcify || readSourcify;
  const dexPairs = deps.probeDexPairs || probeDexPairs;
  const limits = [];
  const limit = (field, reason, detail) => { limits.push({ field, reason, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) }); return null; };
  const sources = [];

  // 1) One batch: code, the ERC-20 calls, owner, proxy slots.
  const slotKeys = Object.keys(SLOTS);
  const first = [
    { method: "eth_getCode", params: [token, "latest"] },
    callOf(token, data("name")), callOf(token, data("symbol")), callOf(token, data("decimals")), callOf(token, data("totalSupply")),
    callOf(token, data("owner")), callOf(token, data("getOwner")), callOf(token, data("pendingOwner")),
    ...slotKeys.map((k) => ({ method: "eth_getStorageAt", params: [token, SLOTS[k], "latest"] })),
  ];
  const dexP = Promise.resolve().then(() => dexPairs({ chain, address: token })).then((d) => ({ ok: true, d }), (e) => ({ ok: false, e }));
  const srcP = Promise.resolve().then(() => sourcify(c.id, token)).then((d) => ({ ok: true, d }), (e) => ({ ok: false, e }));
  const r = await rpcBatch(state, first, "token reads");
  const code = resultOf(r[0]);
  if (code == null) throw Object.assign(bad("chain RPC did not return the contract code", 502), { attribution: "upstream" });
  if (code === "0x" || code === "0x0") throw bad(`${address} on ${chain} has no contract code: it is not a token contract.`, 422);
  const decimalsBig = decodeUint(resultOf(r[3]));
  const supplyBig = decodeUint(resultOf(r[4]));
  if (decimalsBig == null || supplyBig == null || decimalsBig > 77n) throw bad(`${address} on ${chain} does not answer the ERC-20 decimals and totalSupply calls: it is not a token contract.`, 422);
  const decimals = Number(decimalsBig);
  sources.push("chain RPC: ERC-20 calls, owner and proxy slots (eth_call, eth_getStorageAt)");
  const ownerRaw = decodeAddress(resultOf(r[5])) ?? decodeAddress(resultOf(r[6]));
  const pendingOwner = decodeAddress(resultOf(r[7]));
  const slot = Object.fromEntries(slotKeys.map((k, i) => [k, wordAddress(resultOf(r[8 + i]))]));

  const [dexR, srcR] = await Promise.all([dexP, srcP]);
  const dex = dexR.ok ? dexR.d : null;
  if (dex) sources.push("DexScreener: pairs and liquidity");
  const src = srcR.ok ? srcR.d : null;

  // 2) Proxy: the slots, Sourcify's own proxy reading, EIP-1167 code.
  let implementation = slot.eip1967Implementation || slot.zosImplementation || minimalProxyTarget(code) || null;
  const beacon = slot.eip1967Beacon;
  if (!implementation && beacon) {
    try { const b = await rpcBatch(state, [callOf(beacon, data("implementation"))], "beacon implementation"); implementation = decodeAddress(resultOf(b[0])) || null; } catch { /* the beacon read is optional */ }
  }
  if (!implementation && src?.proxyImplementations?.length) implementation = src.proxyImplementations[0];
  let implSrc = null;
  if (implementation && implementation !== token && src) {
    try { implSrc = await sourcify(c.id, implementation); } catch (e) { limit("implementationAbi", "the implementation's Sourcify record was not read", e?.message); }
  }
  const abi = src?.verified ? [...(src.abi || []), ...(implSrc?.verified ? implSrc.abi || [] : [])] : null;
  const flags = abiFlags(abi && abi.length ? abi : null);
  const proxyByAbi = flags.upgradeable === true;
  const proxy = Boolean(implementation || slot.eip1822Proxiable || beacon || src?.isProxy || proxyByAbi);
  if (src) sources.push("Sourcify: verification, ABI and source");
  const openSource = src ? src.verified === true : limit("openSource", "the Sourcify verification read did not complete", srcR.e?.message);
  if (!proxy) limits.push({ field: "proxy", reason: "checked the EIP-1967, EIP-1822, beacon and ZeppelinOS slots, Sourcify's proxy reading and EIP-1167 code; other proxy patterns are not detected" });
  if (src && !src.verified) limits.push({ field: "openSource", reason: "reads Sourcify only: a contract verified only elsewhere reads false" });

  const abiReason = src ? "the contract's ABI is not verified on Sourcify" : "the Sourcify read did not complete";
  const fromAbi = (field, v) => (v == null ? limit(field, abiReason) : v);

  // Owner.
  let ownerAddress = null, ownerRenounced = null;
  if (ownerRaw === undefined) limit("ownerAddress", "the contract answers neither owner() nor getOwner()");
  else { ownerAddress = ownerRaw; ownerRenounced = ownerRaw === ZERO && !(pendingOwner && pendingOwner !== ZERO); }
  let canTakeBackOwnership;
  if (ownerRaw === ZERO && pendingOwner && pendingOwner !== ZERO) canTakeBackOwnership = true;
  else if (flags.takeBackOwnership != null) canTakeBackOwnership = flags.takeBackOwnership;
  else canTakeBackOwnership = limit("canTakeBackOwnership", abiReason);

  // selfdestruct, from the verified source text.
  const text = [src?.sourceText, implSrc?.sourceText].filter(Boolean).join("\n");
  const selfdestruct = text ? /\bselfdestruct\s*\(/.test(text) : limit("selfdestruct", src?.verified === false ? "the source is not verified on Sourcify" : "the verified source text was not read");

  // 3) The pool: the deepest listed pair whose address is a contract address.
  const pool = (dex?.pairs || []).find((p) => /^0x[0-9a-fA-F]{40}$/.test(String(p.pair || "")) && [p.baseAddress, p.quoteAddress].some((a) => String(a || "").toLowerCase() === token));
  const poolAddr = pool ? pool.pair.toLowerCase() : null;
  const owner = ownerAddress && ownerAddress !== ZERO ? ownerAddress : null;
  let poolBal = null, lp = null, ownerBal = null;
  if (poolAddr || owner) {
    const calls = [];
    if (poolAddr) calls.push(callOf(token, data("balanceOf", [poolAddr])), callOf(poolAddr, data("getReserves")), callOf(poolAddr, data("totalSupply")), callOf(poolAddr, data("balanceOf", [ZERO])), callOf(poolAddr, data("balanceOf", [DEAD])));
    if (owner) calls.push(callOf(token, data("balanceOf", [owner])));
    try {
      const b = await rpcBatch(state, calls, "pool and owner balances");
      if (poolAddr) {
        poolBal = decodeUint(resultOf(b[0]));
        const v2 = resultOf(b[1]) && resultOf(b[1]).length >= 194;
        const lpSupply = decodeUint(resultOf(b[2]));
        if (v2 && lpSupply && lpSupply > 0n) {
          const burned = (decodeUint(resultOf(b[3])) || 0n) + (decodeUint(resultOf(b[4])) || 0n);
          lp = { supply: lpSupply, burned };
        }
      }
      if (owner) ownerBal = decodeUint(resultOf(b[b.length - 1]));
    } catch (e) { limit("pool", "the pool and owner balances were not read", e?.message); }
  }
  const ownerPct = owner ? (ownerBal == null ? limit("ownerPct", "the owner's balance was not read") : pctOf(ownerBal, supplyBig)) : (ownerAddress === ZERO ? 0 : limit("ownerPct", "no owner address"));
  let lpLockedPct = null, lpTotalSupply = null;
  if (lp) {
    lpLockedPct = pctOf(lp.burned, lp.supply);
    lpTotalSupply = Number(formatUnits(lp.supply, 18));
    limits.push({ field: "lpLockedPct", reason: "the share of the deepest pool's LP tokens held by burn addresses; LP held in locker contracts is not counted" });
  } else limit("lpLockedPct", poolAddr ? "the deepest pool is not a V2-style pool with LP tokens" : "no DEX pool with this token was listed");

  // 4) Simulation: a small buy from the pool, then a sell into it.
  const sim = await simulateTrade(state, { token, pool: poolAddr, poolBal, why: !dex ? "the DEX pairs read did not complete" : null });
  if (sim.ran) sources.push("chain RPC: buy and sell simulation (eth_simulateV1)");
  for (const [field, reason] of Object.entries(sim.reasons)) limit(field, reason);

  // 5) Holders, from the whole Transfer history on the keyed lane.
  const hold = await holderIndex(state, { chain, token, supplyBig, env, lane: deps.holderLane });
  if (hold.ok) sources.push("chain RPC: Transfer logs (eth_getLogs)");
  else { limit("holderCount", "holder index not available for this token", hold.why); limit("topHolders", "holder index not available for this token", hold.why); }

  for (const [f, why] of Object.entries(NOT_DERIVABLE)) limit(f, why);

  return {
    tokenName: decodeText(resultOf(r[1])), tokenSymbol: decodeText(resultOf(r[2])), decimals,
    totalSupply: formatUnits(supplyBig, decimals),
    topHolders: hold.ok ? hold.top : [],
    openSource, proxy, proxyImplementation: implementation || null, proxyAdmin: slot.eip1967Admin || slot.zosAdmin || null,
    mintable: fromAbi("mintable", flags.mintable), honeypot: sim.honeypot,
    ownerAddress, ownerRenounced, pendingOwner: pendingOwner && pendingOwner !== ZERO ? pendingOwner : null,
    hiddenOwner: null, canTakeBackOwnership, ownerChangeBalance: null,
    buyTaxPct: sim.buyTaxPct, sellTaxPct: sim.sellTaxPct, cannotSellAll: sim.cannotSellAll, cannotBuy: sim.cannotBuy,
    transferPausable: fromAbi("transferPausable", flags.transferPausable), blacklist: fromAbi("blacklist", flags.blacklist), whitelist: fromAbi("whitelist", flags.whitelist),
    slippageModifiable: fromAbi("slippageModifiable", flags.slippageModifiable), tradingCooldown: fromAbi("tradingCooldown", flags.tradingCooldown),
    antiWhale: fromAbi("antiWhale", flags.antiWhale), antiWhaleModifiable: fromAbi("antiWhaleModifiable", flags.antiWhaleModifiable),
    selfdestruct, externalCall: null,
    holderCount: hold.ok ? hold.count : null, lpHolderCount: null, lpTotalSupply, lpLockedPct, lpTopHolders: [],
    dexes: (dex?.pairs || []).slice(0, 6).map((p) => ({ name: p.dex, type: p.labels.join(",") || null, liquidityUsd: p.liquidityUsd, pair: p.pair })),
    creatorAddress: null, creatorPct: null, ownerPct, trustList: null, fakeToken: null,
    pool: poolAddr ? { address: poolAddr, dex: pool.dex, simulated: sim.ran } : null,
    verification: src ? { verified: src.verified === true, match: src.match || null, compiler: src.compiler || null, verifiedAt: src.verifiedAt || null } : null,
    sourceText: text || "",
    abiInfo: abi && abi.length ? privilegedFunctions(abi) : null,
    dex, sources, limits,
  };
}

/** The buy then sell, as one eth_simulateV1 run per step (nothing is sent):
 *  the pool transfers a small amount to SIM_BUYER (the buy a pool makes on a
 *  swap), and the buyer transfers what arrived back into the pool (the sell)
 *  one block later. Taxes are what did not arrive; a sell that reverts at
 *  full and at half the balance is a honeypot. */
export async function simulateTrade(state, { token, pool, poolBal, why }) {
  const nul = (reason) => ({ ran: false, honeypot: null, buyTaxPct: null, sellTaxPct: null, cannotSellAll: null, cannotBuy: null,
    reasons: { honeypot: `not simulated: ${reason}`, buyTaxPct: `not simulated: ${reason}`, sellTaxPct: `not simulated: ${reason}`, cannotSellAll: `not simulated: ${reason}`, cannotBuy: `not simulated: ${reason}` } });
  if (!pool) return nul(why || "no DEX pool with this token was listed");
  if (poolBal == null) return nul("the pool's balance was not read");
  if (poolBal <= 0n) return nul("the listed pool holds none of this token");
  if (state.deadline - Date.now() < OPTIONAL_FLOOR_MS) return nul("the request's time budget was spent");
  const amount = poolBal / 10_000n > 0n ? poolBal / 10_000n : 1n;
  const bal = (a) => ({ to: token, data: data("balanceOf", [a]) });
  const buy = { from: pool, to: token, data: data("transfer", [SIM_BUYER, amount]) };
  const run = async (blocks, step) => {
    const res = await rpcBatch(state, [{ method: "eth_simulateV1", params: [{ blockStateCalls: blocks, validation: false }, "latest"] }], step);
    const e = res[0];
    if (e?.error || !Array.isArray(e?.result)) throw Object.assign(bad(`the simulation was not answered (${String(e?.error?.message || "no result").slice(0, 120)})`, 502), { attribution: "upstream" });
    return e.result.map((b) => (Array.isArray(b?.calls) ? b.calls : []));
  };
  const okCall = (c) => c && (c.status === "0x1" || c.status === 1) && !(isHex(c.returnData) && c.returnData.length === 66 && decodeUint(c.returnData) === 0n);
  try {
    const [b1] = await run([{ calls: [bal(SIM_BUYER), buy, bal(SIM_BUYER)] }], "buy simulation");
    if (!b1 || b1.length < 3) return nul("the simulation answer was incomplete");
    if (!okCall(b1[1])) return { ...nul("the buy transfer from the pool reverted"), ran: true, cannotBuy: true, reasons: { honeypot: "not simulated: the buy transfer from the pool reverted", buyTaxPct: "not simulated: the buy transfer from the pool reverted", sellTaxPct: "not simulated: the buy transfer from the pool reverted", cannotSellAll: "not simulated: the buy transfer from the pool reverted" } };
    const before = decodeUint(b1[0].returnData) ?? 0n, after = decodeUint(b1[2].returnData);
    if (after == null) return nul("the buyer's balance was not read back");
    const received = after - before;
    if (received < 0n || received > amount + amount / 1000n) return nul("the buy changed balances in a way a transfer does not explain");
    const buyTaxPct = taxPct(amount, received);
    // 0.01% of the buy or less arriving leaves too little to read a sell tax
    // from (a sell of a few units rounds any tax to zero).
    if (received * 10_000n <= amount) return { ran: true, honeypot: null, buyTaxPct, sellTaxPct: null, cannotSellAll: null, cannotBuy: false,
      reasons: { honeypot: "not simulated: the buy delivered too little to sell", sellTaxPct: "not simulated: the buy delivered too little to sell", cannotSellAll: "not simulated: the buy delivered too little to sell" } };
    const half = received / 2n > 0n ? received / 2n : received;
    const sellFull = { from: SIM_BUYER, to: token, data: data("transfer", [pool, received]) };
    const sellHalf = { from: SIM_BUYER, to: token, data: data("transfer", [pool, half]) };
    const [, b2] = await run([{ calls: [buy] }, { calls: [sellFull, sellHalf] }], "sell simulation");
    if (!b2 || b2.length < 2) return { ran: true, honeypot: null, buyTaxPct, sellTaxPct: null, cannotSellAll: null, cannotBuy: false, reasons: { honeypot: "not simulated: the sell answer was incomplete", sellTaxPct: "not simulated: the sell answer was incomplete", cannotSellAll: "not simulated: the sell answer was incomplete" } };
    const delivered = (c) => (Array.isArray(c?.logs) ? c.logs : []).filter((l) => String(l?.address || "").toLowerCase() === token && l?.topics?.[0] === TRANSFER_TOPIC
      && wordAddress(l.topics[1]) === SIM_BUYER && wordAddress(l.topics[2]) === pool).reduce((a, l) => a + (decodeUint(l.data) ?? 0n), 0n);
    if (okCall(b2[0])) {
      return { ran: true, honeypot: false, cannotSellAll: false, cannotBuy: false, buyTaxPct, sellTaxPct: taxPct(received, delivered(b2[0])), reasons: {} };
    }
    if (okCall(b2[1])) {
      return { ran: true, honeypot: false, cannotSellAll: true, cannotBuy: false, buyTaxPct, sellTaxPct: taxPct(half, delivered(b2[1])), reasons: {} };
    }
    return { ran: true, honeypot: true, cannotSellAll: true, cannotBuy: false, buyTaxPct, sellTaxPct: null, reasons: { sellTaxPct: "not simulated: the sell reverted at the full and at half the balance" } };
  } catch (e) {
    return nul(e?.budgetSpent ? "the request's budget was spent" : `the simulation did not complete (${String(e?.message || e).slice(0, 120)})`);
  }
}
/** The share of `sent` that did not arrive, in percent (two decimals). */
export function taxPct(sent, arrived) {
  if (typeof sent !== "bigint" || sent <= 0n || typeof arrived !== "bigint") return null;
  if (arrived >= sent) return 0;
  const p = Number(((sent - arrived) * 1_000_000n) / sent) / 10_000;
  return p < 0.01 ? 0 : round2(p);
}

/** Holder count and the top ten, from every Transfer the token ever logged:
 *  read only on the keyed lane, only whole (one request from block 0), and
 *  only under HOLDER_LOG_CAP logs. */
export async function holderIndex(state, { chain, token, supplyBig, env, lane }) {
  const url = lane === undefined ? holderLogLane(chain, env) : lane;
  if (!url) return { ok: false, why: "no keyed log lane for this chain" };
  if (state.deadline - Date.now() < OPTIONAL_FLOOR_MS) return { ok: false, why: "the request's time budget was spent" };
  let logs;
  try {
    const r = await rpcBatch(state, [{ method: "eth_getLogs", params: [{ address: token, fromBlock: "0x0", toBlock: "latest", topics: [TRANSFER_TOPIC] }] }], "transfer history", { lanes: [url], timeoutMs: 8_000 });
    if (r[0]?.error || !Array.isArray(r[0]?.result)) return { ok: false, why: `the history read was refused (${String(r[0]?.error?.message || "no result").slice(0, 120)})` };
    logs = r[0].result;
  } catch (e) { return { ok: false, why: String(e?.message || e).slice(0, 160) }; }
  if (logs.length >= HOLDER_LOG_CAP) return { ok: false, why: `the history holds ${HOLDER_LOG_CAP} or more transfers` };
  const bal = new Map();
  const add = (a, v) => bal.set(a, (bal.get(a) || 0n) + v);
  for (const l of logs) {
    if (!Array.isArray(l?.topics) || l.topics.length < 3) continue; // ERC-721 style or malformed
    const from = `0x${String(l.topics[1]).slice(-40)}`.toLowerCase(), to = `0x${String(l.topics[2]).slice(-40)}`.toLowerCase();
    const v = decodeUint(l.data);
    if (v == null) continue;
    if (from !== ZERO) add(from, -v);
    if (to !== ZERO) add(to, v);
  }
  const held = [...bal.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const top = held.slice(0, 10);
  let codes = [];
  if (top.length) {
    try { codes = await rpcBatch(state, top.map(([a]) => ({ method: "eth_getCode", params: [a, "latest"] })), "holder code"); } catch { codes = []; }
  }
  return {
    ok: true, count: held.length,
    top: top.map(([address, v], i) => {
      const c = resultOf(codes[i]);
      return { address, tag: null, isContract: c == null ? null : c !== "0x", percent: pctOf(v, supplyBig), locked: null };
    }),
  };
}
