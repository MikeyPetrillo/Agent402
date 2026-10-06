// Alchemy data kit - the EVM read primitives chain-kit does NOT already cover,
// each one a SINGLE upstream request per call (or one bounded, cached fan-out)
// so the compute-unit (CU) bill stays flat and predictable. Shares
// ALCHEMY_API_KEY with chain-kit / dex-kit / nft-market-kit / mev-and-l2-kit
// on the same CU pool. Wallet-only (egress = external quota), never PoW.
//
// What is deliberately NOT here (already sold elsewhere in the catalog):
//   wallet-balance (full ERC-20 portfolio), token-metadata, token-price (spot
//   by address), wallet-transactions (in+out merged history), nft-holdings,
//   nft-metadata, gas-snapshot / gas-estimate, eth-call / evm-rpc, event-logs,
//   block-info, erc721-owner, contract-code, tx-status, ens-resolve,
//   nft-collection / nft-floor.
//
// What IS here (the gaps):
//   asset-transfers     one filtered alchemy_getAssetTransfers query: one
//                       direction, optional counterparty, category subset,
//                       contract filter, block range, cursor. The "transfer
//                       logs for THIS token / THIS pair" read. 1 request.
//   token-balances      targeted alchemy_getTokenBalances for a named list of
//                       contracts (1-20) + decimals/symbol from
//                       alchemy_getTokenMetadata, cached 1h per contract so
//                       the metadata fan-out is bounded and mostly free.
//   token-allowance     alchemy_getTokenAllowance owner -> spender, formatted
//                       with cached metadata, unlimited-approval flag.
//   tx-receipt          receipt + transaction in ONE batched JSON-RPC request,
//                       with ERC-20 / ERC-721 / ERC-1155 Transfer events
//                       decoded locally. Status, fee, value, selector, logs.
//   block-receipts      alchemy_getTransactionReceipts for one block (a single
//                       250-CU read instead of N x 15 CU), summarised + rows
//                       capped.
//   token-price-history Alchemy Prices API historical series by symbol or by
//                       contract+network, interval 5m/1h/1d with span caps.
//
// CU discipline (why each tool looks the way it does): one upstream request
// per call is the rule; the only fan-out is token metadata, capped at 20
// contracts per call and served from a 1h in-process cache; no withMetadata
// on NFT endpoints, no page loops, result rows capped. getAssetTransfers is
// a flat 150 CU regardless of withMetadata, so the block timestamp rides free.
//
// Upstream bodies are never relayed to buyers: JSON-RPC error text is logged
// server-side (secret-redacted) and the buyer gets a generic 502; 429 -> 503;
// transport/timeout -> 504; a Prices-API 404 -> 404 "token not found".
//
// Covered by scripts/test-alchemy-data-kit.js (offline, stubbed fetch; live
// examples opt-in via ALCHEMY_LIVE_TEST=1).

import { redactSecrets } from "./redact.js";

const TIMEOUT_MS = 10_000;
const SOURCE = "alchemy";

// Same chain map as chain-kit so an agent can pivot between kits freely.
// subdomain = the exact Alchemy JSON-RPC host prefix; pricesId = the Prices
// API network id (same string today, kept separate in case they diverge).
export const NETWORKS = {
  ethereum: { subdomain: "eth-mainnet",     chainId: 1,     pricesId: "eth-mainnet",     nativeSymbol: "ETH" },
  base:     { subdomain: "base-mainnet",    chainId: 8453,  pricesId: "base-mainnet",    nativeSymbol: "ETH" },
  polygon:  { subdomain: "polygon-mainnet", chainId: 137,   pricesId: "polygon-mainnet", nativeSymbol: "POL" },
  arbitrum: { subdomain: "arb-mainnet",     chainId: 42161, pricesId: "arb-mainnet",     nativeSymbol: "ETH" },
  optimism: { subdomain: "opt-mainnet",     chainId: 10,    pricesId: "opt-mainnet",     nativeSymbol: "ETH" },
};
const NETWORK_NAMES = Object.keys(NETWORKS);

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const HEX_RE = /^0x[a-fA-F0-9]+$/;

// Bounds (all hard caps - buyers can go lower, never higher).
const TRANSFERS_MAX_COUNT = 100;
const TRANSFERS_DEFAULT_COUNT = 25;
const TRANSFERS_MAX_CONTRACTS = 10;
const BALANCES_MAX_CONTRACTS = 20;
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;
const METADATA_CACHE_MAX_ENTRIES = 5000;
const RECEIPT_MAX_TRANSFERS = 100;
const RECEIPT_MAX_CONTRACTS = 50;
const BLOCK_RECEIPTS_MAX_ROWS = 300;
const BLOCK_RECEIPTS_DEFAULT_ROWS = 100;
const PRICE_HISTORY_MAX_POINTS = 1000;
// Span caps per interval (ms). Measured live 2026-08-22: 5m over 2h, 1h over
// 10d, 1d over 4d all answer; these caps keep every response under ~750 points.
const PRICE_INTERVALS = {
  "5m": { maxSpanMs: 2 * 86_400_000, defaultSpanMs: 86_400_000 },
  "1h": { maxSpanMs: 30 * 86_400_000, defaultSpanMs: 7 * 86_400_000 },
  "1d": { maxSpanMs: 365 * 86_400_000, defaultSpanMs: 30 * 86_400_000 },
};

const TRANSFER_CATEGORIES = new Set(["external", "internal", "erc20", "erc721", "erc1155", "specialnft"]);
const TOKEN_CATEGORIES = new Set(["erc20", "erc721", "erc1155", "specialnft"]);
const DEFAULT_CATEGORIES = ["external", "erc20", "erc721", "erc1155"];

// Event topics decoded locally in tx-receipt.
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256) - ERC-20 (3 topics) and ERC-721 (4 topics)
const TOPIC_TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"; // TransferSingle(address,address,address,uint256,uint256)
const TOPIC_TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"; // TransferBatch(address,address,address,uint256[],uint256[])

const UINT256_MAX = (1n << 256n) - 1n;
const UNLIMITED_FLOOR = 1n << 255n; // anything at or above this is treated as an "unlimited" approval

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function nowIso() { return new Date().toISOString(); }

function requireKey() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw bad("Chain data tools are not configured on this deployment", 503);
  return key;
}

export function pickNetwork(value, dflt = "ethereum") {
  const n = typeof value === "string" && value.trim() ? value.toLowerCase().trim() : dflt;
  const def = NETWORKS[n];
  if (!def) throw bad(`Unsupported network "${value}" - supported: ${NETWORK_NAMES.join(", ")}`);
  return { name: n, ...def };
}

export function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex EVM address`);
  }
  return raw.trim().toLowerCase(); // EVM only - never case-fold non-EVM addresses
}

export function takeTxHash(raw, field = "hash") {
  if (typeof raw !== "string" || !TX_HASH_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 32-byte transaction hash`);
  }
  return raw.trim().toLowerCase();
}

/** Block tag: "latest", decimal, or 0x hex -> "latest" | 0x hex. */
export function takeBlockTag(raw, field = "block", { allowLatest = true } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    if (allowLatest) return "latest";
    throw bad(`"${field}" is required (decimal or 0x hex block number)`);
  }
  const s = String(raw).trim().toLowerCase();
  if (s === "latest") {
    if (allowLatest) return "latest";
    throw bad(`"${field}" must be a block number (decimal or 0x hex)`);
  }
  if (/^0x[0-9a-f]+$/.test(s)) return "0x" + BigInt(s).toString(16);
  if (/^\d+$/.test(s)) return "0x" + BigInt(s).toString(16);
  throw bad(`"${field}" must be a block number (decimal or 0x hex)${allowLatest ? ' or "latest"' : ""}`);
}

export function takeInt(raw, { field, min, max, dflt }) {
  if (raw === undefined || raw === null || raw === "") return dflt;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`"${field}" must be an integer between ${min} and ${max}`);
  return Math.trunc(n);
}

/** Accept an array or CSV of strings; lowercase + trim + dedupe. */
function takeList(raw, field) {
  if (raw === undefined || raw === null || raw === "") return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = [];
  for (const x of arr) {
    if (typeof x !== "string") throw bad(`"${field}" must be a list of strings`);
    const v = x.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function takeCategories(raw, { dflt = DEFAULT_CATEGORIES } = {}) {
  const list = takeList(raw, "category");
  if (!list.length) return [...dflt];
  for (const c of list) {
    if (!TRANSFER_CATEGORIES.has(c)) {
      throw bad(`"category" entries must be one of ${[...TRANSFER_CATEGORIES].join(", ")} (got "${c}")`);
    }
  }
  return list;
}

export function takeAddressList(raw, field, max) {
  const list = takeList(raw, field);
  if (list.length > max) throw bad(`"${field}" accepts at most ${max} addresses per call`);
  return list.map((a) => takeAddress(a, field));
}

export function hexToDecString(hex) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) return "0";
  return BigInt(hex).toString(10);
}
function hexToNumber(hex) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) return null;
  const n = Number(BigInt(hex));
  return Number.isSafeInteger(n) ? n : null;
}

/** Scale a raw uint256 decimal string by `decimals` -> human decimal string. */
export function formatUnits(rawDecimal, decimals) {
  const d = Number.parseInt(decimals, 10);
  if (!Number.isFinite(d) || d < 0 || d > 36) return rawDecimal;
  if (d === 0) return rawDecimal;
  const neg = rawDecimal.startsWith("-");
  const digits = neg ? rawDecimal.slice(1) : rawDecimal;
  const padded = digits.padStart(d + 1, "0");
  const whole = padded.slice(0, -d);
  const frac = padded.slice(-d).replace(/0+$/, "");
  return (neg ? "-" : "") + (frac ? `${whole}.${frac}` : whole);
}

function weiToGwei(weiBig) {
  return Number(formatUnits(weiBig.toString(), 9));
}

function topicToAddress(topic) {
  return typeof topic === "string" && topic.length === 66 ? "0x" + topic.slice(26).toLowerCase() : null;
}

function hostOf(url) { try { return new URL(url).host; } catch { return "?"; } }

// ---------------------------------------------------------------------------
// upstream plumbing - every path has one fetch; errors are classified, never
// relayed. `notFound` lets the Prices API map its 404 to a buyer-visible 404
// (the token genuinely is not in the feed - a 400 would blame the input
// shape, a 502 would blame us).
// ---------------------------------------------------------------------------
async function alchemyFetch(url, opts = {}, { notFound } = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[alchemy-data] upstream unreachable: ${hostOf(url)} -> ${err?.name ?? err?.code ?? err?.message}`);
    throw bad("Chain data upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Chain data rate limit reached upstream - retry shortly", 503);
  if (res.status === 404 && notFound) throw bad(notFound, 404);
  if (!res.ok) {
    // Upstream 4xx/5xx bodies carry their own error text - log (redacted,
    // the key rides the URL and could be echoed), never relay.
    let excerpt = "";
    try { excerpt = redactSecrets(await res.text()).slice(0, 200); } catch { /* ignore */ }
    console.warn(`[alchemy-data] upstream HTTP ${res.status} from ${hostOf(url)}: ${excerpt}`);
    throw bad(`Chain data upstream error (HTTP ${res.status})`, 502);
  }
  let data;
  try { data = await res.json(); } catch { throw bad("Chain data upstream returned a malformed response", 502); }
  return data;
}

function rpcUrl(network, key) {
  return `https://${network.subdomain}.g.alchemy.com/v2/${key}`;
}

function rpcError(data, network, method) {
  const e = data?.error;
  const msg = typeof e === "string" ? e : (e?.message ?? "unknown");
  console.warn(`[alchemy-data] ${network.name} ${method} JSON-RPC error: ${redactSecrets(String(msg)).slice(0, 300)}`);
  const err = bad("Chain data upstream rejected the request", 502);
  if (typeof e?.code === "number") err.rpcCode = e.code;
  return err;
}

async function rpc(network, method, params) {
  const key = requireKey();
  const data = await alchemyFetch(rpcUrl(network, key), {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (data?.error) throw rpcError(data, network, method);
  return data?.result;
}

/** One HTTP request carrying several JSON-RPC calls; results in call order. */
async function rpcBatch(network, calls) {
  const key = requireKey();
  const body = calls.map((c, idx) => ({ jsonrpc: "2.0", id: idx + 1, method: c.method, params: c.params }));
  const data = await alchemyFetch(rpcUrl(network, key), { method: "POST", body: JSON.stringify(body) });
  if (!Array.isArray(data)) {
    if (data?.error) throw rpcError(data, network, "batch");
    throw bad("Chain data upstream returned a malformed batch response", 502);
  }
  const byId = new Map(data.map((d) => [d?.id, d]));
  return calls.map((c, idx) => {
    const d = byId.get(idx + 1);
    if (!d) throw bad("Chain data upstream returned an incomplete batch response", 502);
    if (d.error) throw rpcError(d, network, c.method);
    return d.result;
  });
}

async function pricesApi(method, body, extra) {
  const key = requireKey();
  return alchemyFetch(`https://api.g.alchemy.com/prices/v1/${key}/${method}`, {
    method: "POST",
    body: JSON.stringify(body),
  }, extra);
}

// ---------------------------------------------------------------------------
// token metadata cache - the ONLY fan-out in this kit, bounded per call and
// served from memory for an hour. Key = network:contract.
// ---------------------------------------------------------------------------
const metadataCache = new Map();

function cacheGet(k) {
  const hit = metadataCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > METADATA_CACHE_TTL_MS) { metadataCache.delete(k); return null; }
  return hit.meta;
}
function cacheSet(k, meta) {
  if (metadataCache.size >= METADATA_CACHE_MAX_ENTRIES) {
    const oldest = metadataCache.keys().next().value;
    if (oldest !== undefined) metadataCache.delete(oldest);
  }
  metadataCache.set(k, { meta, at: Date.now() });
}

/** symbol/name/decimals for one contract (cached 1h). Never throws on a
 *  per-token upstream miss - a balance row with unknown decimals is still a
 *  balance row; the raw value is always returned. */
async function tokenMetadata(network, contract) {
  const k = `${network.name}:${contract}`;
  const cached = cacheGet(k);
  if (cached) return cached;
  let meta;
  try {
    const r = await rpc(network, "alchemy_getTokenMetadata", [contract]);
    meta = {
      symbol: r?.symbol ?? null,
      name: r?.name ?? null,
      decimals: typeof r?.decimals === "number" ? r.decimals : null,
      logo: r?.logo ?? null,
    };
  } catch (err) {
    if (err?.statusCode === 503 && /not configured/.test(err.message)) throw err;
    meta = { symbol: null, name: null, decimals: null, logo: null, unavailable: true };
  }
  if (!meta.unavailable) cacheSet(k, meta);
  return meta;
}

async function metadataFor(network, contracts) {
  const out = new Map();
  await Promise.all(contracts.map(async (c) => { out.set(c, await tokenMetadata(network, c)); }));
  return out;
}

// ---------------------------------------------------------------------------
// transfer decoding (tx-receipt)
// ---------------------------------------------------------------------------
export function decodeTransferLogs(logs) {
  const transfers = [];
  for (const log of Array.isArray(logs) ? logs : []) {
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    const t0 = typeof topics[0] === "string" ? topics[0].toLowerCase() : "";
    const contract = typeof log?.address === "string" ? log.address.toLowerCase() : null;
    const logIndex = hexToNumber(log?.logIndex);
    const data = typeof log?.data === "string" ? log.data.replace(/^0x/, "") : "";
    if (t0 === TOPIC_TRANSFER && topics.length === 3) {
      transfers.push({ standard: "erc20", contract, from: topicToAddress(topics[1]), to: topicToAddress(topics[2]),
        rawValue: data ? BigInt("0x" + data.slice(0, 64)).toString(10) : "0", tokenId: null, logIndex });
    } else if (t0 === TOPIC_TRANSFER && topics.length === 4) {
      transfers.push({ standard: "erc721", contract, from: topicToAddress(topics[1]), to: topicToAddress(topics[2]),
        rawValue: "1", tokenId: BigInt(topics[3]).toString(10), logIndex });
    } else if (t0 === TOPIC_TRANSFER_SINGLE && topics.length === 4 && data.length >= 128) {
      transfers.push({ standard: "erc1155", contract, operator: topicToAddress(topics[1]), from: topicToAddress(topics[2]),
        to: topicToAddress(topics[3]), tokenId: BigInt("0x" + data.slice(0, 64)).toString(10),
        rawValue: BigInt("0x" + data.slice(64, 128)).toString(10), logIndex });
    } else if (t0 === TOPIC_TRANSFER_BATCH && topics.length === 4) {
      // ids[]/values[] are dynamic arrays: [offsetIds][offsetValues][lenIds][ids...][lenValues][values...]
      try {
        const word = (i) => BigInt("0x" + data.slice(i * 64, i * 64 + 64));
        const offIds = Number(word(0) / 32n), offVals = Number(word(1) / 32n);
        const nIds = Number(word(offIds)), nVals = Number(word(offVals));
        const n = Math.min(nIds, nVals, 50);
        const items = [];
        for (let i = 0; i < n; i++) items.push({ tokenId: word(offIds + 1 + i).toString(10), rawValue: word(offVals + 1 + i).toString(10) });
        transfers.push({ standard: "erc1155-batch", contract, operator: topicToAddress(topics[1]), from: topicToAddress(topics[2]),
          to: topicToAddress(topics[3]), items, count: nIds, logIndex });
      } catch {
        transfers.push({ standard: "erc1155-batch", contract, operator: topicToAddress(topics[1]), from: topicToAddress(topics[2]),
          to: topicToAddress(topics[3]), items: [], count: null, logIndex, undecoded: true });
      }
    }
    if (transfers.length >= RECEIPT_MAX_TRANSFERS) break;
  }
  return transfers;
}

function receiptRow(r) {
  const gasUsed = typeof r?.gasUsed === "string" ? BigInt(r.gasUsed) : 0n;
  const gasPrice = typeof r?.effectiveGasPrice === "string" ? BigInt(r.effectiveGasPrice) : 0n;
  const l1Fee = typeof r?.l1Fee === "string" ? BigInt(r.l1Fee) : null;
  const fee = gasUsed * gasPrice + (l1Fee ?? 0n);
  return {
    hash: r?.transactionHash ?? null,
    index: hexToNumber(r?.transactionIndex),
    status: r?.status === "0x1" ? "success" : r?.status === "0x0" ? "failed" : null,
    from: r?.from ?? null,
    to: r?.to ?? null,
    contractAddress: r?.contractAddress ?? null,
    type: r?.type ?? null,
    gasUsed: gasUsed.toString(10),
    effectiveGasPriceGwei: weiToGwei(gasPrice),
    feeWei: fee.toString(10),
    ...(l1Fee !== null ? { l1FeeWei: l1Fee.toString(10) } : {}),
    logCount: Array.isArray(r?.logs) ? r.logs.length : 0,
  };
}

// ---------------------------------------------------------------------------
// price-history time window
// ---------------------------------------------------------------------------
function parseTime(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  let ms;
  if (typeof raw === "number") ms = raw < 1e12 ? raw * 1000 : raw;
  else if (/^\d+$/.test(String(raw).trim())) { const n = Number(String(raw).trim()); ms = n < 1e12 ? n * 1000 : n; }
  else ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) throw bad(`"${field}" must be an ISO-8601 timestamp or unix seconds`);
  return ms;
}

export function takeWindow(i) {
  const intervalRaw = typeof i.interval === "string" && i.interval.trim() ? i.interval.trim().toLowerCase() : "1d";
  const spec = PRICE_INTERVALS[intervalRaw];
  if (!spec) throw bad(`"interval" must be one of ${Object.keys(PRICE_INTERVALS).join(", ")}`);
  const now = Date.now();
  let end = parseTime(i.endTime, "endTime") ?? now;
  if (end > now) end = now;
  let start = parseTime(i.startTime, "startTime");
  if (start === null) {
    const days = i.days === undefined || i.days === null || i.days === "" ? null : Number(i.days);
    if (days !== null && (!Number.isFinite(days) || days <= 0)) throw bad(`"days" must be a positive number`);
    start = end - (days !== null ? days * 86_400_000 : spec.defaultSpanMs);
  }
  if (start >= end) throw bad(`"startTime" must be before "endTime"`);
  if (end - start > spec.maxSpanMs) {
    throw bad(`"interval" ${intervalRaw} covers at most ${Math.round(spec.maxSpanMs / 86_400_000)} days per call - narrow the window or use a coarser interval`);
  }
  return { interval: intervalRaw, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
const NETWORK_PROP = { type: "string", description: `${NETWORK_NAMES.join(" / ")} (default ethereum).` };

export const ALCHEMY_DATA_TOOLS = [
  // =========================================================================
  // asset-transfers
  // =========================================================================
  {
    route: "POST /api/asset-transfers",
    name: "Wallet token transfers (filtered)",
    slug: "asset-transfers", aliases: ["blockchain-transfers"],
    category: "crypto",
    price: "$0.003",
    description:
      "Recent token transfers for a wallet on Base, Ethereum and other EVM chains, newest first. Filtered transfer log for an EVM address: one direction (in or out), optional counterparty, a category subset (external / internal / erc20 / erc721 / erc1155 / specialnft), an optional contract filter (e.g. only USDC), a block range, and a cursor for paging. One indexed query per call - the cheap way to ask 'every USDC transfer into this wallet' or 'all transfers from A to B' without scanning logs. Values are exact decimal strings scaled by the token's decimals; each row carries the block timestamp.",
    tags: ["crypto", "transfers", "erc20", "erc721", "erc1155", "wallet", "history", "evm", "ethereum", "base", "logs"],
    discovery: {
      bodyType: "json",
      input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", direction: "in", category: ["erc20"], contracts: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"], maxCount: 5, network: "ethereum" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char EVM address (the wallet or contract whose transfers you want). Optional when `contracts` is set." },
          direction: { type: "string", description: "in (transfers TO address) or out (transfers FROM address). Default in." },
          counterparty: { type: "string", description: "Optional other party: with direction in, only transfers FROM this address; with out, only transfers TO it." },
          category: { type: "array", items: { type: "string" }, description: "Subset of external, internal, erc20, erc721, erc1155, specialnft. Default external+erc20+erc721+erc1155 (erc20+erc721+erc1155 when `contracts` is set)." },
          contracts: { type: "array", items: { type: "string" }, description: "Optional token contract filter, up to 10 addresses (token categories only)." },
          fromBlock: { type: "string", description: "Start block (decimal or 0x hex). Default 0 = genesis." },
          toBlock: { type: "string", description: "End block (decimal, 0x hex, or latest). Default latest." },
          maxCount: { type: "number", description: "Rows per call, 1-100 (default 25)." },
          order: { type: "string", description: "desc (newest first, default) or asc." },
          includeZeroValue: { type: "boolean", description: "Include zero-value transfers (plain contract calls). Default false." },
          pageKey: { type: "string", description: "Cursor from a previous response to fetch the next page." },
          network: NETWORK_PROP,
        },
      },
      output: {
        example: {
          network: "ethereum", chainId: 1,
          address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", direction: "in", counterparty: null,
          categories: ["erc20"], contracts: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
          fromBlock: "0x0", toBlock: "latest", order: "desc", maxCount: 5, count: 5,
          transfers: [
            { blockNum: 25563191, timestamp: "2026-07-19T00:32:23.000Z", hash: "0x214b…e56b", from: "0xa916…6081", to: "0xd8da…6045", category: "erc20", asset: "USDC", value: "0.42", contract: "0xa0b8…eb48", rawValue: "420000", decimals: 6, tokenId: null },
          ],
          pageKey: "1f449b0c-…", source: "alchemy", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const contracts = takeAddressList(i.contracts, "contracts", TRANSFERS_MAX_CONTRACTS);
      const address = i.address === undefined || i.address === null || i.address === "" ? null : takeAddress(i.address);
      if (!address && !contracts.length) throw bad(`"address" is required (or pass "contracts" to list every transfer of a token)`);
      const directionRaw = typeof i.direction === "string" && i.direction.trim() ? i.direction.trim().toLowerCase() : "in";
      if (directionRaw !== "in" && directionRaw !== "out") throw bad(`"direction" must be "in" or "out"`);
      const counterparty = i.counterparty === undefined || i.counterparty === null || i.counterparty === "" ? null : takeAddress(i.counterparty, "counterparty");
      const categories = takeCategories(i.category, { dflt: contracts.length ? ["erc20", "erc721", "erc1155"] : DEFAULT_CATEGORIES });
      if (contracts.length && categories.some((c) => !TOKEN_CATEGORIES.has(c))) {
        throw bad(`"contracts" only filters token categories (erc20, erc721, erc1155, specialnft) - drop external/internal from "category"`);
      }
      const fromBlock = i.fromBlock === undefined || i.fromBlock === null || i.fromBlock === "" ? "0x0"
        : takeBlockTag(i.fromBlock, "fromBlock", { allowLatest: false });
      const toBlock = takeBlockTag(i.toBlock, "toBlock");
      const maxCount = takeInt(i.maxCount, { field: "maxCount", min: 1, max: TRANSFERS_MAX_COUNT, dflt: TRANSFERS_DEFAULT_COUNT });
      const order = typeof i.order === "string" && i.order.trim() ? i.order.trim().toLowerCase() : "desc";
      if (order !== "asc" && order !== "desc") throw bad(`"order" must be "asc" or "desc"`);
      const pageKey = typeof i.pageKey === "string" && i.pageKey.trim() ? i.pageKey.trim() : null;
      if (pageKey && pageKey.length > 200) throw bad(`"pageKey" is not a valid cursor`);

      const params = {
        fromBlock, toBlock, category: categories, maxCount: "0x" + maxCount.toString(16), order, withMetadata: true,
        excludeZeroValue: i.includeZeroValue !== true,
      };
      if (address) {
        if (directionRaw === "in") params.toAddress = address; else params.fromAddress = address;
      }
      if (counterparty) {
        if (directionRaw === "in") params.fromAddress = counterparty; else params.toAddress = counterparty;
      }
      if (contracts.length) params.contractAddresses = contracts;
      if (pageKey) params.pageKey = pageKey;

      const result = await rpc(network, "alchemy_getAssetTransfers", [params]);
      const rows = Array.isArray(result?.transfers) ? result.transfers : [];
      const transfers = rows.map((t) => {
        const rawHex = t?.rawContract?.value;
        const decimals = hexToNumber(t?.rawContract?.decimal);
        const rawValue = typeof rawHex === "string" && HEX_RE.test(rawHex) ? hexToDecString(rawHex) : null;
        const value = rawValue !== null && decimals !== null ? formatUnits(rawValue, decimals)
          : t?.value != null ? String(t.value) : null;
        const row = {
          blockNum: hexToNumber(t?.blockNum),
          timestamp: t?.metadata?.blockTimestamp ?? null,
          hash: t?.hash ?? null,
          from: t?.from ?? null,
          to: t?.to ?? null,
          category: t?.category ?? null,
          asset: t?.asset ?? null,
          value,
          contract: typeof t?.rawContract?.address === "string" ? t.rawContract.address.toLowerCase() : null,
          rawValue,
          decimals,
          tokenId: t?.tokenId ?? t?.erc721TokenId ?? null,
        };
        if (Array.isArray(t?.erc1155Metadata) && t.erc1155Metadata.length) {
          row.erc1155 = t.erc1155Metadata.slice(0, 50).map((m) => ({ tokenId: m?.tokenId ?? null, value: m?.value ?? null }));
        }
        return row;
      });
      return {
        network: network.name, chainId: network.chainId,
        address, direction: directionRaw, counterparty,
        categories, contracts,
        fromBlock: params.fromBlock, toBlock, order, maxCount,
        count: transfers.length, transfers,
        pageKey: result?.pageKey ?? null,
        source: SOURCE, fetchedAt: nowIso(),
      };
    },
  },

  // =========================================================================
  // token-balances (targeted)
  // =========================================================================
  {
    route: "POST /api/token-balances",
    name: "Token balances (named contracts)",
    slug: "token-balances",
    category: "crypto",
    price: "$0.002",
    description:
      "ERC-20 balances of one wallet for a NAMED list of token contracts (1-20) - the targeted complement to the full-portfolio wallet-balance tool. One balance read for the whole list plus symbol/decimals per contract (cached an hour server-side), so 'how much USDC and WETH does this wallet hold on Base?' is a single cheap call with exact decimal strings, not a portfolio dump.",
    tags: ["crypto", "erc20", "balance", "balances", "wallet", "usdc", "evm", "ethereum", "base"],
    discovery: {
      bodyType: "json",
      input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", contracts: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"], network: "ethereum" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char EVM wallet address." },
          contracts: { type: "array", items: { type: "string" }, description: "1-20 ERC-20 contract addresses to read." },
          network: NETWORK_PROP,
        },
        required: ["address", "contracts"],
      },
      output: {
        example: {
          network: "ethereum", chainId: 1,
          address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
          tokens: [
            { contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", name: "USDC", decimals: 6, balance: "37.192124", raw: "37192124" },
            { contract: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", name: "Wrapped Ether", decimals: 18, balance: "1.461", raw: "1461000000000000000" },
          ],
          source: "alchemy", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      const contracts = takeAddressList(i.contracts, "contracts", BALANCES_MAX_CONTRACTS);
      if (!contracts.length) throw bad(`"contracts" must list 1-${BALANCES_MAX_CONTRACTS} ERC-20 contract addresses`);
      const result = await rpc(network, "alchemy_getTokenBalances", [address, contracts]);
      const rows = Array.isArray(result?.tokenBalances) ? result.tokenBalances : [];
      const byContract = new Map(rows.map((r) => [String(r?.contractAddress ?? "").toLowerCase(), r]));
      const metas = await metadataFor(network, contracts);
      const tokens = contracts.map((c) => {
        const r = byContract.get(c);
        const meta = metas.get(c) ?? {};
        const raw = r?.tokenBalance && HEX_RE.test(r.tokenBalance) ? hexToDecString(r.tokenBalance) : null;
        return {
          contract: c,
          symbol: meta.symbol ?? null,
          name: meta.name ?? null,
          decimals: meta.decimals ?? null,
          balance: raw !== null && meta.decimals !== null && meta.decimals !== undefined ? formatUnits(raw, meta.decimals) : raw,
          raw,
          ...(r?.error ? { error: "balance unavailable for this contract" } : {}),
        };
      });
      return { network: network.name, chainId: network.chainId, address, tokens, source: SOURCE, fetchedAt: nowIso() };
    },
  },

  // =========================================================================
  // token-allowance
  // =========================================================================
  {
    route: "POST /api/token-allowance",
    name: "ERC-20 allowance (owner to spender)",
    slug: "token-allowance",
    category: "crypto",
    price: "$0.002",
    description:
      "How much of an ERC-20 token a spender contract is approved to move from an owner wallet - the approval check an agent runs before a swap, a bridge, or an x402 transferWithAuthorization flow. Returns the allowance as an exact decimal string scaled by the token's decimals, the raw uint256, and an `unlimited` flag for max-uint style approvals.",
    tags: ["crypto", "erc20", "allowance", "approval", "approve", "spender", "wallet", "evm", "security"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", spender: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", network: "ethereum" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char ERC-20 contract address." },
          owner: { type: "string", description: "Wallet that granted (or did not grant) the approval." },
          spender: { type: "string", description: "Contract or wallet whose allowance to read." },
          network: NETWORK_PROP,
        },
        required: ["contract", "owner", "spender"],
      },
      output: {
        example: {
          network: "ethereum", chainId: 1,
          contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", owner: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", spender: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
          symbol: "USDC", decimals: 6, allowance: "0", raw: "0", unlimited: false,
          source: "alchemy", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const owner = takeAddress(i.owner, "owner");
      const spender = takeAddress(i.spender, "spender");
      const network = pickNetwork(i.network);
      const result = await rpc(network, "alchemy_getTokenAllowance", [{ contract, owner, spender }]);
      let rawBig;
      try {
        const s = typeof result === "string" ? result.trim() : String(result ?? "0");
        rawBig = /^0x/i.test(s) ? BigInt(s) : BigInt(s || "0");
      } catch { throw bad("Chain data upstream returned a malformed allowance", 502); }
      const meta = await tokenMetadata(network, contract);
      const raw = rawBig.toString(10);
      return {
        network: network.name, chainId: network.chainId,
        contract, owner, spender,
        symbol: meta.symbol ?? null,
        decimals: meta.decimals ?? null,
        allowance: meta.decimals !== null && meta.decimals !== undefined ? formatUnits(raw, meta.decimals) : raw,
        raw,
        unlimited: rawBig >= UNLIMITED_FLOOR || rawBig === UINT256_MAX,
        source: SOURCE, fetchedAt: nowIso(),
      };
    },
  },

  // =========================================================================
  // tx-receipt
  // =========================================================================
  {
    route: "POST /api/tx-receipt",
    name: "Transaction receipt (decoded transfers)",
    slug: "tx-receipt",
    category: "crypto",
    price: "$0.003",
    description:
      "Full receipt for a transaction hash in one call: status, block, from/to, value, gas used vs limit, effective gas price, total fee, tx type, calldata selector, contract created, plus every ERC-20 / ERC-721 / ERC-1155 Transfer event decoded locally from the logs (token, from, to, amount, tokenId) and the list of contracts that emitted logs. Receipt and transaction are fetched in a single batched request. 404 (not charged) when the hash is unknown on that chain; a seen-but-unmined tx answers with status pending.",
    tags: ["crypto", "transaction", "receipt", "tx", "logs", "transfers", "gas", "fee", "evm", "ethereum", "base"],
    discovery: {
      bodyType: "json",
      input: { hash: "0x214b3526ee64f7eabfc94ea536b8680bd95a2da634ebf5149aea189d311be56b", network: "ethereum" },
      inputSchema: {
        properties: {
          hash: { type: "string", description: "0x-prefixed 32-byte transaction hash." },
          network: NETWORK_PROP,
        },
        required: ["hash"],
      },
      output: {
        example: {
          network: "ethereum", chainId: 1,
          hash: "0x214b3526ee64f7eabfc94ea536b8680bd95a2da634ebf5149aea189d311be56b",
          status: "success", blockNumber: 25563191, blockHash: "0x8e12…1243", transactionIndex: 128, timestamp: "2026-07-19T00:32:23.000Z",
          from: "0xa916…6081", to: "0xa0b8…eb48", contractAddress: null, nonce: 873, type: "0x2",
          value: "0", valueWei: "0", gasUsed: "45148", gasLimit: "54633", effectiveGasPriceGwei: 0.040610326, feeWei: "1833474998248", feeNative: "0.000001833474998248",
          selector: "0xa9059cbb", inputBytes: 68,
          logCount: 1, contractsTouched: ["0xa0b8…eb48"],
          transfers: [{ standard: "erc20", contract: "0xa0b8…eb48", from: "0xa916…6081", to: "0xd8da…6045", rawValue: "420000", tokenId: null, logIndex: 413 }],
          source: "alchemy", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const hash = takeTxHash(i.hash);
      const network = pickNetwork(i.network);
      const [receipt, tx] = await rpcBatch(network, [
        { method: "eth_getTransactionReceipt", params: [hash] },
        { method: "eth_getTransactionByHash", params: [hash] },
      ]);
      if (!receipt && !tx) throw bad(`Transaction not found on ${network.name}`, 404);
      const valueWei = typeof tx?.value === "string" ? hexToDecString(tx.value) : null;
      const input = typeof tx?.input === "string" ? tx.input : "0x";
      const base = {
        network: network.name, chainId: network.chainId, hash,
        from: tx?.from ?? receipt?.from ?? null,
        to: tx?.to ?? receipt?.to ?? null,
        nonce: hexToNumber(tx?.nonce),
        type: receipt?.type ?? tx?.type ?? null,
        value: valueWei !== null ? formatUnits(valueWei, 18) : null,
        valueWei,
        gasLimit: typeof tx?.gas === "string" ? hexToDecString(tx.gas) : null,
        selector: input.length >= 10 ? input.slice(0, 10).toLowerCase() : null,
        inputBytes: Math.max(0, (input.length - 2) / 2),
      };
      if (!receipt) {
        return { ...base, status: "pending", blockNumber: null, blockHash: null, transactionIndex: null, timestamp: null,
          contractAddress: null, gasUsed: null, effectiveGasPriceGwei: null, feeWei: null, feeNative: null,
          logCount: 0, contractsTouched: [], transfers: [], source: SOURCE, fetchedAt: nowIso() };
      }
      const row = receiptRow(receipt);
      const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
      const tsHex = logs.find((l) => typeof l?.blockTimestamp === "string")?.blockTimestamp;
      const timestamp = tsHex && HEX_RE.test(tsHex) ? new Date(Number(BigInt(tsHex)) * 1000).toISOString() : null;
      const touched = [];
      for (const l of logs) {
        const a = typeof l?.address === "string" ? l.address.toLowerCase() : null;
        if (a && !touched.includes(a)) touched.push(a);
        if (touched.length >= RECEIPT_MAX_CONTRACTS) break;
      }
      return {
        ...base,
        status: row.status,
        blockNumber: hexToNumber(receipt.blockNumber),
        blockHash: receipt.blockHash ?? null,
        transactionIndex: row.index,
        timestamp,
        contractAddress: row.contractAddress,
        gasUsed: row.gasUsed,
        effectiveGasPriceGwei: row.effectiveGasPriceGwei,
        feeWei: row.feeWei,
        feeNative: formatUnits(row.feeWei, 18),
        ...(row.l1FeeWei !== undefined ? { l1FeeWei: row.l1FeeWei } : {}),
        logCount: logs.length,
        contractsTouched: touched,
        transfers: decodeTransferLogs(logs),
        source: SOURCE, fetchedAt: nowIso(),
      };
    },
  },

  // =========================================================================
  // block-receipts
  // =========================================================================
  {
    route: "POST /api/block-receipts",
    name: "Block receipts (one block, summarised)",
    slug: "block-receipts",
    category: "crypto",
    price: "$0.005",
    description:
      "Every transaction receipt in one block, fetched as a single upstream read and summarised: tx count, succeeded vs failed, total gas used, total fees, log count, contract creations, tx-type mix - plus compact per-transaction rows (hash, from, to, status, gas used, effective gas price, fee, log count) capped at 300. Block analytics, failed-tx hunting, or 'who paid what in block N' without N separate receipt calls.",
    tags: ["crypto", "block", "receipts", "transactions", "gas", "analytics", "evm", "ethereum", "base"],
    discovery: {
      bodyType: "json",
      input: { block: "25563191", network: "ethereum", limit: 5 },
      inputSchema: {
        properties: {
          block: { type: "string", description: "Block number (decimal or 0x hex) or latest." },
          limit: { type: "number", description: "Per-transaction rows to return, 0-300 (default 100). The summary always covers the whole block." },
          network: NETWORK_PROP,
        },
        required: ["block"],
      },
      output: {
        example: {
          network: "ethereum", chainId: 1, block: 25563191, blockHash: "0x8e12…1243",
          summary: { txCount: 149, succeeded: 143, failed: 6, gasUsed: "16506190", feeWei: "4453605500724532", feeNative: "0.004453605500724532", logCount: 420, contractCreations: 0, types: { "0x2": 126, "0x0": 16, "0x4": 6, "0x3": 1 } },
          returned: 5,
          receipts: [{ hash: "0xdcae…9cd6", index: 0, status: "success", from: "0xb01c…9c2e", to: "0x7c46…0f54", contractAddress: null, type: "0x2", gasUsed: "21000", effectiveGasPriceGwei: 1.040610226, feeWei: "21852814746000", logCount: 0 }],
          source: "alchemy", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      if (i.block === undefined || i.block === null || i.block === "") throw bad(`"block" is required (decimal, 0x hex, or "latest")`);
      let tag = takeBlockTag(i.block, "block", { allowLatest: true });
      const limit = takeInt(i.limit, { field: "limit", min: 0, max: BLOCK_RECEIPTS_MAX_ROWS, dflt: BLOCK_RECEIPTS_DEFAULT_ROWS });
      if (tag === "latest") {
        // The receipts method needs a concrete number; "latest" costs one extra cheap read.
        const head = await rpc(network, "eth_blockNumber", []);
        if (typeof head !== "string" || !HEX_RE.test(head)) throw bad("Chain data upstream returned a malformed head block", 502);
        tag = head;
      }
      const result = await rpc(network, "alchemy_getTransactionReceipts", [{ blockNumber: tag }]);
      const receipts = Array.isArray(result?.receipts) ? result.receipts : null;
      if (!receipts) throw bad(`Block ${hexToNumber(tag) ?? tag} not found on ${network.name}`, 404);
      const rows = receipts.map(receiptRow);
      const summary = { txCount: rows.length, succeeded: 0, failed: 0, gasUsed: "0", feeWei: "0", feeNative: "0", logCount: 0, contractCreations: 0, types: {} };
      let gas = 0n, fee = 0n;
      for (const r of rows) {
        if (r.status === "success") summary.succeeded++; else if (r.status === "failed") summary.failed++;
        gas += BigInt(r.gasUsed);
        fee += BigInt(r.feeWei);
        summary.logCount += r.logCount;
        if (r.contractAddress) summary.contractCreations++;
        const t = r.type ?? "unknown";
        summary.types[t] = (summary.types[t] ?? 0) + 1;
      }
      summary.gasUsed = gas.toString(10);
      summary.feeWei = fee.toString(10);
      summary.feeNative = formatUnits(summary.feeWei, 18);
      return {
        network: network.name, chainId: network.chainId,
        block: hexToNumber(tag),
        blockHash: receipts[0]?.blockHash ?? null,
        summary,
        returned: Math.min(limit, rows.length),
        receipts: rows.slice(0, limit),
        source: SOURCE, fetchedAt: nowIso(),
      };
    },
  },

  // =========================================================================
  // token-price-history
  // =========================================================================
  {
    route: "POST /api/token-price-history",
    name: "Token price history (USD)",
    slug: "token-price-history",
    category: "crypto",
    price: "$0.004",
    description:
      "Historical USD price series for a token, by ticker symbol (ETH, BTC, SOL, ...) or by ERC-20 contract + network, at 5-minute (up to 2 days), hourly (up to 30 days) or daily (up to 365 days) resolution. Returns the points plus first/last/high/low and the percent change over the window - the data behind 'how did this token move over the last N days' without a separate market-data subscription. 404 (not charged) when the token is not in the price feed.",
    tags: ["crypto", "price", "history", "ohlc", "usd", "token", "erc20", "chart", "timeseries"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", network: "ethereum", interval: "1d", days: 7 },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "Ticker symbol (e.g. ETH, BTC). Use this OR contract+network." },
          contract: { type: "string", description: "0x-prefixed 40-char ERC-20 contract address (with `network`)." },
          network: NETWORK_PROP,
          interval: { type: "string", description: "5m, 1h, or 1d (default 1d)." },
          days: { type: "number", description: "Shortcut: window length in days ending now (default 1 for 5m, 7 for 1h, 30 for 1d)." },
          startTime: { type: "string", description: "ISO-8601 or unix seconds. Overrides `days`." },
          endTime: { type: "string", description: "ISO-8601 or unix seconds (default now)." },
        },
      },
      output: {
        example: {
          symbol: null, contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", network: "ethereum", currency: "usd",
          interval: "1d", startTime: "2026-08-15T12:00:00.000Z", endTime: "2026-08-22T12:00:00.000Z",
          count: 7, first: 0.99966, last: 0.99971, high: 0.99982, low: 0.99951, changePct: 0.005,
          points: [{ t: "2026-08-16T00:00:00Z", price: 0.99966 }],
          source: "alchemy", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const symbol = typeof i.symbol === "string" && i.symbol.trim() ? i.symbol.trim().toUpperCase() : null;
      const hasContract = i.contract !== undefined && i.contract !== null && i.contract !== "";
      if (!symbol && !hasContract) throw bad(`Pass "symbol" (e.g. ETH) or "contract" + "network"`);
      if (symbol && hasContract) throw bad(`Pass either "symbol" or "contract", not both`);
      if (symbol && !/^[A-Z0-9.$_-]{1,20}$/.test(symbol)) throw bad(`"symbol" must be a 1-20 char ticker`);
      const contract = hasContract ? takeAddress(i.contract, "contract") : null;
      const network = hasContract ? pickNetwork(i.network) : null;
      const win = takeWindow(i);
      const body = symbol ? { symbol, ...win } : { network: network.pricesId, address: contract, ...win };
      const r = await pricesApi("tokens/historical", body, { notFound: symbol ? `Symbol "${symbol}" is not in the price feed` : `No price feed for ${contract} on ${network.name}` });
      const raw = Array.isArray(r?.data) ? r.data : [];
      const points = [];
      for (const p of raw) {
        const price = Number(p?.value);
        if (!Number.isFinite(price) || typeof p?.timestamp !== "string") continue;
        points.push({ t: p.timestamp, price });
        if (points.length >= PRICE_HISTORY_MAX_POINTS) break;
      }
      if (!points.length) throw bad(symbol ? `No price history for "${symbol}" in that window` : `No price history for ${contract} on ${network.name} in that window`, 404);
      const first = points[0].price, last = points[points.length - 1].price;
      let high = -Infinity, low = Infinity;
      for (const p of points) { if (p.price > high) high = p.price; if (p.price < low) low = p.price; }
      return {
        symbol: symbol ?? (typeof r?.symbol === "string" ? r.symbol : null),
        contract, network: network?.name ?? null,
        currency: typeof r?.currency === "string" ? r.currency : "usd",
        interval: win.interval, startTime: win.startTime, endTime: win.endTime,
        count: points.length, first, last, high, low,
        changePct: first ? Number((((last - first) / first) * 100).toFixed(4)) : null,
        points,
        source: SOURCE, fetchedAt: nowIso(),
      };
    },
  },
];

export const __test = {
  NETWORKS, pickNetwork, takeAddress, takeTxHash, takeBlockTag, takeInt, takeCategories, takeAddressList,
  hexToDecString, formatUnits, decodeTransferLogs, takeWindow, receiptRow,
  metadataCache, clearMetadataCache: () => metadataCache.clear(),
  TRANSFERS_MAX_COUNT, TRANSFERS_MAX_CONTRACTS, BALANCES_MAX_CONTRACTS, BLOCK_RECEIPTS_MAX_ROWS, RECEIPT_MAX_TRANSFERS,
  METADATA_CACHE_MAX_ENTRIES, PRICE_INTERVALS,
};
