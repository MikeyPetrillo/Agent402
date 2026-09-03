// Chain kit — wallet balances, token metadata + price, NFT ownership + metadata,
// gas snapshot, and read-only JSON-RPC passthroughs for power users. Backed by
// Alchemy (single key, every supported chain), except evm-rpc which rides
// keyless public RPC endpoints with failover (Alchemy lane first when the key
// is set) so it answers on every deployment. Wallet-only (egress = external
// quota), never PoW-eligible.
//
// Supported networks: ethereum, base, polygon, arbitrum, optimism. Mainnets only —
// agents debugging testnets can use eth-call against a public RPC if needed.
//
// All tools accept a `network` field. Default is "base" because that's where x402
// settles and where most agent activity lives today.
//
// Covered by scripts/test-chain-kit.js (offline validation tests, no key needed).

import { ssrfDispatcher } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";
import sha3 from "js-sha3"; // CommonJS — default import, then destructure (same as b20-kit)
const { keccak256 } = sha3;

const TIMEOUT_MS = 10_000;

// Alchemy URL conventions:
//   JSON-RPC node:  https://{net}-mainnet.g.alchemy.com/v2/{KEY}
//   NFT API v3:     https://{net}-mainnet.g.alchemy.com/nft/v3/{KEY}/{method}
//   Prices API:     https://api.g.alchemy.com/prices/v1/{KEY}/{method}
//   Data API:       https://api.g.alchemy.com/data/v1/{KEY}/{method}
//
// One key works for every product on the same app.
const NETWORKS = {
  ethereum: { subdomain: "eth-mainnet", chainId: 1, pricesId: "eth-mainnet" },
  base:     { subdomain: "base-mainnet", chainId: 8453, pricesId: "base-mainnet" },
  polygon:  { subdomain: "polygon-mainnet", chainId: 137, pricesId: "polygon-mainnet" },
  arbitrum: { subdomain: "arb-mainnet", chainId: 42161, pricesId: "arb-mainnet" },
  optimism: { subdomain: "opt-mainnet", chainId: 10, pricesId: "opt-mainnet" },
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE  = /^0x[a-fA-F0-9]*$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function requireKey() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw bad("Chain tools are not configured on this deployment", 503);
  return key;
}

export function pickNetwork(value, dflt = "base") {
  const n = typeof value === "string" ? value.toLowerCase().trim() : dflt;
  const def = NETWORKS[n];
  if (!def) throw bad(`Unsupported network "${value}" - supported: ${Object.keys(NETWORKS).join(", ")}`);
  return { name: n, ...def };
}

function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex Ethereum address`);
  }
  return raw.trim().toLowerCase();
}

async function alchemyFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Keep the evidence: log the transport cause (price-feed-kit rule).
    console.warn(`[chain] upstream unreachable: ${(() => { try { return new URL(url).host; } catch { return "?"; } })()} → ${err.name ?? err.code ?? err.message}`);
    throw bad("Chain upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Chain rate limit reached upstream - retry shortly", 503);
  if (!res.ok) throw bad(`Chain upstream error (HTTP ${res.status})`, 502);
  return res.json();
}

async function jsonRpc(network, method, params) {
  const key = requireKey();
  const url = `https://${network.subdomain}.g.alchemy.com/v2/${key}`;
  const data = await alchemyFetch(url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  // Upstream-derived text — the Alchemy key rides the request URL, so redact
  // before echoing (the route binder returns err.message verbatim to buyers).
  if (data.error) throw bad(`Chain RPC error: ${redactSecrets(String(data.error.message || "unknown")).slice(0, 300)}`, 502);
  return data.result;
}

async function nftApi(network, method, params) {
  const key = requireKey();
  const qs = new URLSearchParams(params).toString();
  const url = `https://${network.subdomain}.g.alchemy.com/nft/v3/${key}/${method}?${qs}`;
  return alchemyFetch(url);
}

async function pricesApi(method, body) {
  const key = requireKey();
  const url = `https://api.g.alchemy.com/prices/v1/${key}/${method}`;
  return alchemyFetch(url, { method: "POST", body: JSON.stringify(body) });
}

async function dataApi(method, body) {
  const key = requireKey();
  const url = `https://api.g.alchemy.com/data/v1/${key}/${method}`;
  return alchemyFetch(url, { method: "POST", body: JSON.stringify(body) });
}

// Convert a hex string ("0x...") to a decimal string. We return decimal strings,
// not Numbers, because uint256 values routinely exceed Number.MAX_SAFE_INTEGER.
function hexToDecString(hex) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) return "0";
  return BigInt(hex).toString(10);
}

// Apply ERC-20 decimals to a raw uint256 balance and return a human-readable
// decimal string (e.g. raw "1500000000" with 6 decimals → "1500"). Trailing
// zeros after the decimal point are trimmed.
function formatUnits(rawDecimal, decimals) {
  const d = parseInt(decimals, 10);
  if (!Number.isFinite(d) || d < 0 || d > 36) return rawDecimal;
  if (d === 0) return rawDecimal;
  const padded = rawDecimal.padStart(d + 1, "0");
  const whole = padded.slice(0, -d);
  const frac = padded.slice(-d).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// JSON-RPC methods the eth-call passthrough will accept. Strictly read-only —
// no eth_sendTransaction / eth_sendRawTransaction / anything that mutates state
// or could be used to relay a paid broadcast through our quota.
const RPC_METHOD_WHITELIST = new Set([
  "eth_call",
  "eth_blockNumber",
  "eth_chainId",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getUncleCountByBlockHash",
  "eth_getUncleCountByBlockNumber",
  "eth_maxPriorityFeePerGas",
  "net_version",
  "web3_clientVersion",
]);

// ============================================================================
// evm-rpc transport — keyless public RPC endpoints with failover, following
// the x402-kit rpc() pattern. Distinct from jsonRpc() above: it does NOT
// require ALCHEMY_API_KEY (the Alchemy lane simply goes first when the key is
// set), so the passthrough answers on every deployment. 8s per-endpoint
// timeout, one full retry pass over the endpoint list on transport/5xx
// failures. A well-formed JSON-RPC *error* from a node is the node's verdict
// on the request (bad params, reverted call) — consistent across nodes, so it
// passes through as a 502 instead of burning the failover chain.
// ============================================================================
const EVM_RPC_TIMEOUT_MS = 8_000;
const PUBLIC_RPCS = {
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"],
  base:     ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
  polygon:  ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  optimism: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
};

export async function publicJsonRpc(network, method, params) {
  const key = process.env.ALCHEMY_API_KEY;
  const urls = [
    ...(key ? [`https://${network.subdomain}.g.alchemy.com/v2/${key}`] : []),
    ...PUBLIC_RPCS[network.name],
  ];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of urls) {
      let res, text;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(EVM_RPC_TIMEOUT_MS),
          dispatcher: ssrfDispatcher,
        });
        text = await res.text();
      } catch (e) { lastErr = e; continue; } // timeout / transport → next endpoint
      let data;
      try { data = JSON.parse(text); } catch { lastErr = new Error(`non-JSON from upstream (HTTP ${res.status})`); continue; }
      if (data.error) {
        const msg = redactSecrets(String(data.error.message || "unknown node error")).slice(0, 300);
        const err = bad(`Node error: ${msg}`, 502);
        // Carry the JSON-RPC error code so callers (tx-simulate) can tell a
        // revert verdict (code 3) from node-side failures like rate limits.
        if (typeof data.error.code === "number") err.rpcCode = data.error.code;
        throw err;
      }
      if (data.result !== undefined) return data.result;
      lastErr = new Error(`HTTP ${res.status} from upstream`);
    }
  }
  throw bad(`RPC upstream unavailable for ${network.name}${lastErr ? ` (${redactSecrets(String(lastErr.message)).slice(0, 120)})` : ""}`, 502);
}

// evm-rpc method whitelist — HARD, read-only only. Tighter than
// RPC_METHOD_WHITELIST above: no eth_getLogs (unbounded result sets), no
// send/sign/subscribe anything. Matching is case-insensitive on input but the
// canonical casing is what goes upstream.
const EVM_RPC_METHODS = [
  "eth_blockNumber", "eth_gasPrice", "eth_getBalance", "eth_getTransactionCount",
  "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_call", "eth_getCode", "eth_getStorageAt", "eth_chainId", "eth_feeHistory",
  "net_version",
];
const EVM_RPC_METHOD_BY_LOWER = new Map(EVM_RPC_METHODS.map((m) => [m.toLowerCase(), m]));
const EVM_RPC_MAX_PARAMS = 8;
const EVM_RPC_MAX_PARAMS_BYTES = 4096;
const EVM_RPC_MAX_RESULT_BYTES = 200_000;

// event-logs bounds: eth_getLogs is the one read that can be unbounded, so the
// named tool ships with hard caps (evm-rpc rejects the method outright). 2000
// blocks mirrors the public-RPC chunk ceilings that burned the Sei scanner;
// 200 logs keeps the response inside the same budget as evm-rpc's result cap.
const EVENT_LOGS_MAX_SPAN = 2000;
const EVENT_LOGS_DEFAULT_SPAN = 100;
const EVENT_LOGS_MAX_RETURNED = 200;
// Node-side size/range rejections for busy contracts (USDC on Base can exceed
// a public node's response cap in under 100 blocks). When the CALLER pinned
// the range we surface the node's verdict; when the range was our default we
// narrow it and retry - the tool's contract is "always answers", not "always
// covers the default span".
const EVENT_LOGS_SIZE_ERR = /too large|response size|limit exceeded|block range|query returned more than/i;

function formatGwei(wei) {
  const s = wei.toString().padStart(10, "0");
  const whole = s.slice(0, -9);
  const frac = s.slice(-9).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Block tag for eth_getBlockByNumber: "latest", decimal, or 0x hex. */
function takeBlockTag(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "latest") return "latest";
  const s = String(raw).trim().toLowerCase();
  if (s === "latest") return "latest";
  if (/^0x[0-9a-f]+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return "0x" + BigInt(s).toString(16);
  throw bad(`"block" must be a block number (decimal or 0x hex) or "latest"`);
}

/** Strict block NUMBER (no "latest") for event-logs range fields. */
function takeBlockNumber(raw, field) {
  const s = String(raw).trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return Number(BigInt(s));
  if (/^\d+$/.test(s)) return Number(BigInt(s));
  throw bad(`"${field}" must be a block number (decimal or 0x hex)`);
}

/** ERC-721 token id: decimal or 0x hex string, returned as BigInt. */
function takeTokenId(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return BigInt(s);
  if (/^\d+$/.test(s)) return BigInt(s);
  throw bad(`"tokenId" must be a decimal or 0x hex token id`);
}

export const CHAIN_TOOLS = [
  // ===========================================================================
  // wallet-balance — native + ERC-20 balances for an address.
  // ===========================================================================
  {
    route: "POST /api/wallet-balance",
    name: "Wallet balance (native + ERC-20)",
    slug: "wallet-balance",
    category: "crypto",
    price: "$0.002",
    description:
      "Look up the native coin balance (ETH/MATIC) plus every ERC-20 holding for a wallet address on Ethereum, Base, Polygon, Arbitrum, or Optimism. Returns clean decimal balances (already scaled by token decimals) plus symbol and contract - ready to display in a UI or feed into a portfolio tool.",
    tags: ["crypto", "wallet", "balance", "erc20", "evm", "base", "ethereum", "token", "balances"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char hex wallet address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: "base",
          native: { symbol: "ETH", balance: "0.001234", raw: "1234000000000000" },
          tokens: [
            { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, balance: "100", raw: "100000000" },
          ],
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      // Native via eth_getBalance.
      const rawHex = await jsonRpc(network, "eth_getBalance", [address, "latest"]);
      const rawNative = hexToDecString(rawHex);
      const nativeSymbol = network.name === "polygon" ? "MATIC" : "ETH";
      const native = { symbol: nativeSymbol, balance: formatUnits(rawNative, 18), raw: rawNative };
      // ERC-20 portfolio via Data API.
      const portfolio = await dataApi("assets/tokens/by-address", {
        addresses: [{ address, networks: [network.pricesId] }],
      });
      const rows = portfolio?.data?.tokens ?? portfolio?.tokens ?? [];
      const tokens = rows
        .filter((r) => r.tokenAddress && r.tokenBalance && r.tokenBalance !== "0x0")
        .map((r) => {
          const raw = hexToDecString(r.tokenBalance);
          const decimals = r.tokenMetadata?.decimals ?? 18;
          return {
            contract: String(r.tokenAddress).toLowerCase(),
            symbol: r.tokenMetadata?.symbol ?? null,
            decimals,
            balance: formatUnits(raw, decimals),
            raw,
          };
        });
      return { address, network: network.name, native, tokens };
    },
  },

  // ===========================================================================
  // token-metadata — symbol, decimals, name, logo for an ERC-20 contract.
  // ===========================================================================
  {
    route: "POST /api/token-metadata",
    name: "ERC-20 token metadata",
    slug: "token-metadata",
    category: "crypto",
    price: "$0.001",
    description:
      "Resolve an ERC-20 contract address to its on-chain metadata: symbol, decimals, name, and logo URL where available. Use this to humanize a raw contract address before showing it to a user or before computing fiat values.",
    tags: ["crypto", "erc20", "token", "metadata", "evm"],
    discovery: {
      bodyType: "json",
      input: { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", network: "base" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char ERC-20 contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract"],
      },
      output: {
        example: {
          contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base",
          symbol: "USDC", name: "USD Coin", decimals: 6,
          logo: "https://example.com/usdc.png",
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const network = pickNetwork(i.network);
      const meta = await jsonRpc(network, "alchemy_getTokenMetadata", [contract]);
      return {
        contract,
        network: network.name,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        decimals: typeof meta?.decimals === "number" ? meta.decimals : null,
        logo: meta?.logo ?? null,
      };
    },
  },

  // ===========================================================================
  // token-price — spot USD price for an ERC-20 contract (Alchemy Prices API).
  // ===========================================================================
  {
    route: "POST /api/token-price",
    name: "Token spot price (USD)",
    slug: "token-price",
    category: "crypto",
    price: "$0.001",
    description:
      "Return the current USD spot price for an ERC-20 token, identified by its contract address and network. Sourced from Alchemy's aggregated price feed. Use this for portfolio-value calculations or to denominate a balance in fiat without depending on a separate market-data API.",
    tags: ["crypto", "price", "token", "usd", "spot", "erc20"],
    discovery: {
      bodyType: "json",
      input: { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", network: "base" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char ERC-20 contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract"],
      },
      output: {
        example: {
          contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base",
          symbol: "USDC", priceUsd: 1.0001, lastUpdated: "2026-06-22T17:30:00Z",
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const network = pickNetwork(i.network);
      const r = await pricesApi("tokens/by-address", {
        addresses: [{ network: network.pricesId, address: contract }],
      });
      const row = r?.data?.[0] ?? r?.[0] ?? null;
      const priceObj = row?.prices?.find?.((p) => (p.currency || "").toLowerCase() === "usd") ?? row?.prices?.[0] ?? null;
      const priceUsd = priceObj?.value != null ? Number(priceObj.value) : null;
      return {
        contract,
        network: network.name,
        symbol: row?.symbol ?? null,
        priceUsd,
        lastUpdated: priceObj?.lastUpdatedAt ?? null,
      };
    },
  },

  // ===========================================================================
  // wallet-transactions — last N asset transfers (in + out).
  // ===========================================================================
  {
    route: "POST /api/wallet-transactions",
    name: "Wallet transaction history",
    slug: "wallet-transactions",
    category: "crypto",
    price: "$0.002",
    description:
      "Return the most recent asset transfers (incoming + outgoing) for a wallet address - native coin, ERC-20, ERC-721, ERC-1155 - already merged and sorted newest first. Each row carries the block, tx hash, counterparty, asset, and decimal value. Cap is 100 per direction; widen the window via `fromBlock` if you need deeper history.",
    tags: ["crypto", "wallet", "transactions", "history", "transfers", "evm"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base", limit: 10 },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char hex wallet address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
          limit: { type: "number", description: "Max transfers per direction (1-100, default 25)." },
          fromBlock: { type: "string", description: "Optional starting block in hex (default 0x0 = earliest)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: "base", limit: 10,
          transfers: [
            { direction: "in", blockNum: 18250000, hash: "0xabc…", from: "0x…", to: "0xabf…", asset: "USDC", value: "0.001", category: "erc20" },
          ],
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 25, 1), 100);
      const fromBlock = typeof i.fromBlock === "string" && HEX_RE.test(i.fromBlock) ? i.fromBlock : "0x0";
      const categories = ["external", "erc20", "erc721", "erc1155"];
      const baseParams = { fromBlock, toBlock: "latest", category: categories, maxCount: `0x${limit.toString(16)}`, order: "desc" };
      const [out, inc] = await Promise.all([
        jsonRpc(network, "alchemy_getAssetTransfers", [{ ...baseParams, fromAddress: address }]),
        jsonRpc(network, "alchemy_getAssetTransfers", [{ ...baseParams, toAddress: address }]),
      ]);
      const norm = (rows, direction) =>
        (rows?.transfers ?? []).map((t) => ({
          direction,
          blockNum: parseInt(t.blockNum, 16),
          hash: t.hash,
          from: t.from,
          to: t.to,
          asset: t.asset ?? null,
          value: t.value != null ? String(t.value) : null,
          category: t.category,
        }));
      const merged = [...norm(out, "out"), ...norm(inc, "in")]
        .sort((a, b) => b.blockNum - a.blockNum)
        .slice(0, limit * 2);
      return { address, network: network.name, limit, transfers: merged };
    },
  },

  // ===========================================================================
  // nft-holdings — NFTs owned by a wallet.
  // ===========================================================================
  {
    route: "POST /api/nft-holdings",
    name: "NFT holdings for an address",
    slug: "nft-holdings",
    category: "crypto",
    price: "$0.002",
    description:
      "Return the NFTs owned by a wallet address on a given network. Each row carries the collection name, contract address, token ID, image URL (where available), and ERC-721 vs ERC-1155 standard. Up to 100 per call - paginate with `pageKey` from the previous response.",
    tags: ["crypto", "nft", "wallet", "erc721", "erc1155", "evm"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char hex wallet address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
          pageKey: { type: "string", description: "Optional pagination cursor from a previous response." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: "base",
          totalCount: 0,
          nfts: [],
          pageKey: null,
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      const params = { owner: address, withMetadata: "true", pageSize: "100" };
      if (typeof i.pageKey === "string" && i.pageKey) params.pageKey = i.pageKey;
      const data = await nftApi(network, "getNFTsForOwner", params);
      const nfts = (data.ownedNfts ?? []).map((n) => ({
        contract: n.contract?.address?.toLowerCase() ?? null,
        tokenId: n.tokenId ?? null,
        standard: n.tokenType ?? null,
        title: n.name ?? n.contract?.name ?? null,
        collection: n.contract?.name ?? null,
        image: n.image?.cachedUrl ?? n.image?.originalUrl ?? null,
        balance: n.balance ?? "1",
      }));
      return {
        address,
        network: network.name,
        totalCount: data.totalCount ?? nfts.length,
        nfts,
        pageKey: data.pageKey ?? null,
      };
    },
  },

  // ===========================================================================
  // nft-metadata — metadata for a single NFT (contract + tokenId).
  // ===========================================================================
  {
    route: "POST /api/nft-metadata",
    name: "NFT metadata lookup",
    slug: "nft-metadata",
    category: "crypto",
    price: "$0.001",
    description:
      "Resolve the metadata for a single NFT: title, description, image URLs (original + cached CDN), attributes/traits, and the standard (ERC-721 vs ERC-1155). Useful when you have a contract+tokenId and need the display data without re-fetching the whole collection.",
    tags: ["crypto", "nft", "metadata", "erc721", "erc1155", "evm"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xed5af388653567af2f388e6224dc7c4b3241c544", tokenId: "1", network: "ethereum" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char NFT contract address." },
          tokenId: { type: "string", description: "Token ID as a string (decimal or hex)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract", "tokenId"],
      },
      output: {
        example: {
          contract: "0xed5af388653567af2f388e6224dc7c4b3241c544",
          tokenId: "1",
          network: "ethereum",
          title: "Azuki #1",
          collection: "Azuki",
          standard: "ERC721",
          description: "Azuki starts with…",
          image: "https://example.com/azuki1.png",
          attributes: [{ trait_type: "Hair", value: "Pink Hairband" }],
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const tokenId = typeof i.tokenId === "string" ? i.tokenId.trim() : "";
      if (!tokenId) throw bad(`"tokenId" is required (decimal or hex string)`);
      const network = pickNetwork(i.network);
      const data = await nftApi(network, "getNFTMetadata", { contractAddress: contract, tokenId });
      return {
        contract,
        tokenId,
        network: network.name,
        title: data.name ?? null,
        collection: data.contract?.name ?? null,
        standard: data.tokenType ?? null,
        description: data.description ?? null,
        image: data.image?.cachedUrl ?? data.image?.originalUrl ?? null,
        attributes: data.raw?.metadata?.attributes ?? [],
      };
    },
  },

  // ===========================================================================
  // gas-snapshot — slow / standard / fast gas tier in gwei + USD.
  // ===========================================================================
  {
    route: "POST /api/gas-snapshot",
    name: "Gas snapshot (slow / standard / fast)",
    slug: "gas-snapshot",
    category: "crypto",
    price: "$0.005",
    description:
      "Live gas price snapshot for a chain - slow / standard / fast tiers in gwei, plus the latest base fee. Sampled from eth_feeHistory (last 4 blocks, 25th/50th/90th percentile priority fees). Use to estimate before broadcasting a transaction from another tool.",
    tags: ["crypto", "gas", "fees", "evm", "transaction"],
    discovery: {
      bodyType: "json",
      input: { network: "base" },
      inputSchema: {
        properties: {
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
      },
      output: {
        example: {
          network: "base", chainId: 8453,
          baseFeeGwei: 0.005,
          slow: { priorityFeeGwei: 0.001, totalGwei: 0.006 },
          standard: { priorityFeeGwei: 0.002, totalGwei: 0.007 },
          fast: { priorityFeeGwei: 0.005, totalGwei: 0.010 },
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const history = await jsonRpc(network, "eth_feeHistory", ["0x4", "latest", [25, 50, 90]]);
      const baseHexArr = history?.baseFeePerGas ?? [];
      const rewardsArr = history?.reward ?? [];
      const baseFee = baseHexArr.length ? BigInt(baseHexArr[baseHexArr.length - 1]) : 0n;
      const lastReward = rewardsArr.length ? rewardsArr[rewardsArr.length - 1] : ["0x0", "0x0", "0x0"];
      const toGwei = (wei) => Number(wei) / 1e9;
      const tier = (idx) => {
        const priority = BigInt(lastReward[idx] || "0x0");
        return {
          priorityFeeGwei: Number(toGwei(priority).toFixed(6)),
          totalGwei: Number(toGwei(baseFee + priority).toFixed(6)),
        };
      };
      return {
        network: network.name,
        chainId: network.chainId,
        baseFeeGwei: Number(toGwei(baseFee).toFixed(6)),
        slow: tier(0),
        standard: tier(1),
        fast: tier(2),
      };
    },
  },

  // ===========================================================================
  // eth-call — read-only JSON-RPC passthrough (whitelisted methods).
  // ===========================================================================
  {
    route: "POST /api/eth-call",
    name: "Read-only JSON-RPC passthrough",
    slug: "eth-call",
    category: "crypto",
    price: "$0.002",
    description:
      "Escape hatch for power users: forward an arbitrary read-only JSON-RPC method to the chain. Method must be in our read-only whitelist (eth_call, eth_getLogs, eth_getBlockByNumber, eth_getTransactionReceipt, eth_chainId, eth_blockNumber, etc.). Mutating methods (eth_sendTransaction, eth_sendRawTransaction) are rejected - sign and broadcast through your own provider.",
    tags: ["crypto", "rpc", "json-rpc", "evm", "eth-call", "advanced"],
    discovery: {
      bodyType: "json",
      input: { method: "eth_blockNumber", params: [], network: "base" },
      inputSchema: {
        properties: {
          method: { type: "string", description: "JSON-RPC method (must be in the read-only whitelist)." },
          params: { type: "array", description: "JSON-RPC parameter array (often empty for simple methods)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["method"],
      },
      output: {
        example: {
          network: "base",
          method: "eth_blockNumber",
          result: "0x1234567",
        },
      },
    },
    handler: async (i) => {
      const method = typeof i.method === "string" ? i.method.trim() : "";
      if (!method) throw bad(`"method" is required`);
      if (!RPC_METHOD_WHITELIST.has(method)) {
        throw bad(`Method "${method}" is not in the read-only whitelist. Allowed: ${[...RPC_METHOD_WHITELIST].join(", ")}`);
      }
      const params = Array.isArray(i.params) ? i.params : [];
      const network = pickNetwork(i.network);
      const result = await jsonRpc(network, method, params);
      return { network: network.name, method, result };
    },
  },

  // ===========================================================================
  // evm-rpc — multi-chain read-only JSON-RPC micro-feed. Keyless public RPC
  // failover (works on every deployment, no Alchemy key required), a hard
  // read-only whitelist (no eth_getLogs, no send/sign/subscribe), bounded
  // params in and a bounded result out.
  // ===========================================================================
  {
    route: "POST /api/evm-rpc",
    name: "Multi-chain EVM RPC (read-only)",
    slug: "evm-rpc",
    category: "crypto",
    price: "$0.004",
    description:
      "Read-only JSON-RPC against Ethereum, Base, Polygon, Arbitrum, or Optimism with built-in multi-endpoint failover - one paid call, no node or API key of your own. Prefer the named reads (block-number, chain-info, block-info, event-logs, erc721-owner, contract-code) for common tasks - they validate inputs and cost less; use this when you need a whitelisted method they do not wrap. Whitelisted methods only: eth_blockNumber, eth_gasPrice, eth_getBalance, eth_getTransactionCount, eth_getBlockByNumber, eth_getTransactionByHash, eth_getTransactionReceipt, eth_call, eth_getCode, eth_getStorageAt, eth_chainId, eth_feeHistory, net_version. Mutating, signing, subscription, and unbounded methods (eth_getLogs) are rejected. Results over 200KB serialized return 413 - narrow the query.",
    tags: ["crypto", "rpc", "json-rpc", "evm", "multichain", "base", "ethereum", "polygon", "arbitrum"],
    discovery: {
      bodyType: "json",
      input: { network: "base", method: "eth_blockNumber", params: [] },
      inputSchema: {
        properties: {
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
          method: { type: "string", description: "Whitelisted read-only JSON-RPC method (e.g. eth_blockNumber, eth_getBalance, eth_call)." },
          params: { type: "array", description: "JSON-RPC positional parameter array (default []). Max 8 entries, 4KB serialized. eth_call's block parameter defaults to \"latest\"." },
        },
        required: ["method"],
      },
      output: {
        example: {
          network: "base",
          method: "eth_blockNumber",
          result: "0x1a2b3c4",
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const rawMethod = typeof i.method === "string" ? i.method.trim() : "";
      const method = EVM_RPC_METHOD_BY_LOWER.get(rawMethod.toLowerCase());
      if (!method) {
        throw bad(
          `${rawMethod ? `Method "${rawMethod}" is not allowed - read-only whitelist only` : `"method" is required`}. Allowed: ${EVM_RPC_METHODS.join(", ")}`
        );
      }
      let params = i.params === undefined || i.params === null ? [] : i.params;
      if (!Array.isArray(params)) throw bad(`"params" must be an array (JSON-RPC positional parameters)`);
      if (params.length > EVM_RPC_MAX_PARAMS) throw bad(`"params" is capped at ${EVM_RPC_MAX_PARAMS} entries (got ${params.length})`);
      let serialized;
      try { serialized = JSON.stringify(params); } catch { serialized = undefined; }
      if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > EVM_RPC_MAX_PARAMS_BYTES) {
        throw bad(`"params" must be JSON-serializable and ≤${EVM_RPC_MAX_PARAMS_BYTES} bytes serialized`);
      }
      if (method === "eth_call" && params.length === 1) params = [...params, "latest"];
      const result = await publicJsonRpc(network, method, params);
      const resultJson = JSON.stringify(result);
      const resultBytes = resultJson === undefined ? 0 : Buffer.byteLength(resultJson, "utf8");
      if (resultBytes > EVM_RPC_MAX_RESULT_BYTES) {
        throw bad(
          `Result too large (${resultBytes} bytes serialized, cap ${EVM_RPC_MAX_RESULT_BYTES}) - narrow the query (e.g. eth_getBlockByNumber with hydrated transactions off)`,
          413
        );
      }
      return { network: network.name, method, result };
    },
  },

  // ===========================================================================
  // Named chain-read primitives (2026-07-29). evm-rpc above already answers
  // eth_blockNumber etc., but an agent searching "block number" or "event logs"
  // never finds a whitelist parameter - it finds a TOOL. These are the
  // first-buy primitives the market proves demand for (api.onesource.io:
  // 319 distinct buyers/week on a bare page of exactly these reads, measured
  // on our own leaderboard 2026-07-29), priced at the floor and riding the
  // same keyless publicJsonRpc failover so they answer on every deployment.
  // ===========================================================================
  {
    route: "GET /api/block-number",
    name: "Latest block number",
    slug: "block-number",
    category: "crypto",
    price: "$0.001",
    description:
      "The latest block number on Ethereum, Base, Polygon, Arbitrum, or Optimism. The cheapest possible on-chain read - the hello world of paid chain access. Keyless multi-endpoint failover. ?network=base",
    tags: ["crypto", "block", "number", "latest", "height", "rpc", "evm", "chain"],
    discovery: {
      input: { network: "base" },
      inputSchema: {
        properties: { network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." } },
        required: [],
      },
      output: { example: { network: "base", blockNumber: 27000000, hex: "0x19bfcc0" } },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const hex = await publicJsonRpc(network, "eth_blockNumber", []);
      return { network: network.name, blockNumber: Number(BigInt(hex)), hex };
    },
  },

  {
    route: "GET /api/chain-info",
    name: "Chain info snapshot",
    slug: "chain-info",
    category: "crypto",
    price: "$0.001",
    description:
      "One-call chain state snapshot: chain id, latest block number, and current gas price (wei + gwei) for Ethereum, Base, Polygon, Arbitrum, or Optimism. Keyless multi-endpoint failover. ?network=base",
    tags: ["crypto", "chain", "info", "chainid", "gas", "price", "block", "rpc", "evm"],
    discovery: {
      input: { network: "base" },
      inputSchema: {
        properties: { network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." } },
        required: [],
      },
      output: { example: { network: "base", chainId: 8453, latestBlock: 27000000, gasPriceWei: "5000000", gasPriceGwei: "0.005" } },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const [chainIdHex, blockHex, gasHex] = await Promise.all([
        publicJsonRpc(network, "eth_chainId", []),
        publicJsonRpc(network, "eth_blockNumber", []),
        publicJsonRpc(network, "eth_gasPrice", []),
      ]);
      const gasWei = BigInt(gasHex);
      return {
        network: network.name,
        chainId: Number(BigInt(chainIdHex)),
        latestBlock: Number(BigInt(blockHex)),
        gasPriceWei: gasWei.toString(),
        gasPriceGwei: formatGwei(gasWei),
      };
    },
  },

  {
    route: "GET /api/block-info",
    name: "Block info",
    slug: "block-info",
    category: "crypto",
    price: "$0.002",
    description:
      "Header-level detail for one block on Ethereum, Base, Polygon, Arbitrum, or Optimism: hash, timestamp (unix + ISO), transaction count, gas used/limit, base fee. Pass a block number, 0x hex, or \"latest\". Keyless multi-endpoint failover. ?block=latest&network=base",
    tags: ["crypto", "block", "info", "header", "timestamp", "gas", "rpc", "evm"],
    discovery: {
      input: { block: "latest", network: "base" },
      inputSchema: {
        properties: {
          block: { type: "string", description: "Block number (decimal or 0x hex) or \"latest\" (default latest)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: [],
      },
      output: {
        example: {
          network: "base", number: 27000000, hash: "0x…", timestamp: 1753747200,
          timestampIso: "2026-07-29T00:00:00.000Z", txCount: 142, gasUsed: "8123456", gasLimit: "180000000", baseFeePerGas: "4100000",
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const block = await publicJsonRpc(network, "eth_getBlockByNumber", [takeBlockTag(i.block), false]);
      if (!block) throw bad("Block not found - it may not exist yet on this chain", 404);
      const ts = Number(BigInt(block.timestamp));
      return {
        network: network.name,
        number: Number(BigInt(block.number)),
        hash: block.hash,
        timestamp: ts,
        timestampIso: new Date(ts * 1000).toISOString(),
        txCount: Array.isArray(block.transactions) ? block.transactions.length : 0,
        gasUsed: BigInt(block.gasUsed ?? "0x0").toString(),
        gasLimit: BigInt(block.gasLimit ?? "0x0").toString(),
        baseFeePerGas: block.baseFeePerGas ? BigInt(block.baseFeePerGas).toString() : null,
      };
    },
  },

  {
    route: "GET /api/erc721-owner",
    name: "NFT owner lookup (ERC-721 ownerOf)",
    slug: "erc721-owner",
    category: "crypto",
    price: "$0.002",
    description:
      "Who owns this NFT? Calls ownerOf(tokenId) on any ERC-721 contract on Ethereum, Base, Polygon, Arbitrum, or Optimism. Complements nft-holdings (which lists a WALLET's NFTs) - this answers by TOKEN. Keyless multi-endpoint failover. ?contract=0x…&tokenId=123&network=ethereum",
    tags: ["crypto", "nft", "erc721", "owner", "ownerof", "token", "rpc", "evm"],
    discovery: {
      input: {
        contract: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85",
        tokenId: "0xaf2caa1c2ca1d027f1ac823b529d0a67cd144264b2789fa2ea4d63a67c7103cc",
        network: "ethereum",
      },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "ERC-721 contract address (0x…)." },
          tokenId: { type: "string", description: "Token id - decimal or 0x hex string." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract", "tokenId"],
      },
      output: { example: { network: "ethereum", contract: "0x57f1…", tokenId: "0xaf2c…", owner: "0x…" } },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const tokenId = takeTokenId(i.tokenId);
      const network = pickNetwork(i.network);
      const data = "0x6352211e" + tokenId.toString(16).padStart(64, "0");
      let hex;
      try {
        hex = await publicJsonRpc(network, "eth_call", [{ to: contract, data }, "latest"]);
      } catch (e) {
        // JSON-RPC code 3 = execution revert: for ownerOf that means the token
        // does not exist (or the contract is not ERC-721) - a caller error,
        // not an upstream outage.
        if (e?.rpcCode === 3) throw bad("ownerOf reverted - the token id does not exist on this contract (or the contract is not ERC-721)", 422);
        throw e;
      }
      if (!hex || hex === "0x" || hex.length < 66) {
        throw bad("No ownerOf result - the contract is likely not ERC-721", 422);
      }
      return { network: network.name, contract, tokenId: "0x" + tokenId.toString(16), owner: "0x" + hex.slice(-40) };
    },
  },

  {
    route: "GET /api/contract-code",
    name: "Contract bytecode check",
    slug: "contract-code",
    category: "crypto",
    price: "$0.002",
    description:
      "Is this address a contract, and what code does it hold? Returns isContract, deployed bytecode size, and the keccak-256 hash of the bytecode (stable fingerprint for comparing deployments) on Ethereum, Base, Polygon, Arbitrum, or Optimism. Keyless multi-endpoint failover. ?address=0x…&network=base",
    tags: ["crypto", "contract", "bytecode", "code", "keccak", "verify", "rpc", "evm"],
    discovery: {
      input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "EVM address to check (0x…)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["address"],
      },
      output: { example: { network: "base", address: "0x8335…", isContract: true, bytecodeBytes: 2148, keccak256: "0x…" } },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      const code = await publicJsonRpc(network, "eth_getCode", [address, "latest"]);
      const hexBody = typeof code === "string" && code.startsWith("0x") ? code.slice(2) : "";
      const isContract = hexBody.length > 0;
      return {
        network: network.name,
        address,
        isContract,
        bytecodeBytes: hexBody.length / 2,
        keccak256: isContract ? "0x" + keccak256(Buffer.from(hexBody, "hex")) : null,
      };
    },
  },

  {
    route: "POST /api/event-logs",
    name: "Contract event logs",
    slug: "event-logs",
    category: "crypto",
    price: "$0.003",
    description:
      "Fetch contract event logs (eth_getLogs) on Ethereum, Base, Polygon, Arbitrum, or Optimism - bounded so it always answers: block range capped at 2000 blocks (default: the last 100, auto-narrowed for busy contracts), at most 200 logs returned (truncated flag set if more matched). Filter by contract address and optional topic0 (event signature hash). Keyless multi-endpoint failover.",
    tags: ["crypto", "event", "events", "logs", "getlogs", "transfer", "topic", "rpc", "evm"],
    discovery: {
      bodyType: "json",
      input: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        topic0: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        network: "base",
      },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Contract address to read logs from (0x…)." },
          topic0: { type: "string", description: "Optional event signature hash (32-byte 0x hex), e.g. the ERC-20 Transfer topic." },
          fromBlock: { type: "string", description: "Start block (decimal or 0x hex). Default: toBlock - 100." },
          toBlock: { type: "string", description: "End block (decimal, 0x hex, or \"latest\"). Default latest." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          network: "base", address: "0x8335…", fromBlock: 26999500, toBlock: 27000000,
          count: 87, truncated: false, logs: [{ blockNumber: 26999512, txHash: "0x…", topics: ["0xddf2…"], data: "0x…" }],
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      let topic0 = null;
      if (i.topic0 !== undefined && i.topic0 !== null && i.topic0 !== "") {
        if (typeof i.topic0 !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(i.topic0.trim())) {
          throw bad(`"topic0" must be a 32-byte 0x hex event signature hash`);
        }
        topic0 = i.topic0.trim().toLowerCase();
      }
      const latestHex = await publicJsonRpc(network, "eth_blockNumber", []);
      const latest = Number(BigInt(latestHex));
      const toBlock = i.toBlock === undefined || i.toBlock === "latest" ? latest : takeBlockNumber(i.toBlock, "toBlock");
      const pinnedFrom = i.fromBlock !== undefined;
      let fromBlock = pinnedFrom ? takeBlockNumber(i.fromBlock, "fromBlock") : Math.max(0, toBlock - EVENT_LOGS_DEFAULT_SPAN);
      if (fromBlock > toBlock) throw bad(`"fromBlock" (${fromBlock}) is after "toBlock" (${toBlock})`);
      if (toBlock - fromBlock + 1 > EVENT_LOGS_MAX_SPAN) {
        throw bad(`Block range is capped at ${EVENT_LOGS_MAX_SPAN} blocks per call (got ${toBlock - fromBlock + 1}) - page with fromBlock/toBlock`);
      }
      const fetchRange = (from) =>
        publicJsonRpc(network, "eth_getLogs", [{
          address,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + toBlock.toString(16),
          ...(topic0 ? { topics: [topic0] } : {}),
        }]);
      let raw;
      try {
        raw = await fetchRange(fromBlock);
      } catch (e) {
        if (pinnedFrom || !EVENT_LOGS_SIZE_ERR.test(String(e?.message ?? ""))) throw e;
        // Default range too busy for the node - narrow toward toBlock until it fits.
        let span = toBlock - fromBlock + 1;
        for (;;) {
          span = Math.floor(span / 2);
          if (span < 1) throw e;
          fromBlock = Math.max(0, toBlock - span + 1);
          try { raw = await fetchRange(fromBlock); break; }
          catch (e2) { if (!EVENT_LOGS_SIZE_ERR.test(String(e2?.message ?? ""))) throw e2; }
        }
      }
      const all = Array.isArray(raw) ? raw : [];
      const logs = all.slice(0, EVENT_LOGS_MAX_RETURNED).map((l) => ({
        blockNumber: Number(BigInt(l.blockNumber)),
        txHash: l.transactionHash,
        logIndex: Number(BigInt(l.logIndex ?? "0x0")),
        topics: l.topics,
        data: l.data,
      }));
      return {
        network: network.name,
        address,
        fromBlock,
        toBlock,
        count: logs.length,
        truncated: all.length > EVENT_LOGS_MAX_RETURNED,
        logs,
      };
    },
  },
];
