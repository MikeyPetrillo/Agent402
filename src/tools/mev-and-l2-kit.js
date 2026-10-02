// MEV + L2 kit — visibility into the MEV-Boost relay layer and the L2 stack.
//
// Why this kit: post-Merge, ~90% of Ethereum blocks are built via MEV-Boost.
// Knowing who built which block, what the proposer was paid, and which builder
// is winning over time is the canonical "MEV market structure" feed. On the L2
// side, knowing aggregate TVL, gas conditions, and finality lag tells an agent
// where to route an L2 transaction (or which L2 to use at all).
//
// Honest scoping: read-only. We don't submit bundles (that needs signed L2
// requests + private mempool RPC), we don't simulate sandwiches, we don't
// estimate MEV revenue for a given strategy. We surface relay-published data
// and L2 state. Use chain-kit/dex-kit for executable read paths.
//
// Upstreams:
//   • MEV-Boost relay chain (keyless): Flashbots → Ultrasound → Agnostic — all
//     major relays serve the SAME data API (/relay/v1/data/bidtraces/*), so a
//     per-IP limit or outage on one relay walks to the next (see MEV_RELAYS)
//   • DeFiLlama chains (keyless):    https://api.llama.fi/v2/chains
//   • Alchemy multichain RPC (key):  eth_gasPrice + eth_blockNumber across L2s
//
// All 5 tools are wallet-only — every handler hits an external API and shares
// a per-IP rate limit (Flashbots relay) or our compute-unit quota (Alchemy).

import { redactSecrets } from "./redact.js";

const TIMEOUT_MS = 12_000;
const LLAMA = "https://api.llama.fi/v2/chains";

// All major MEV-Boost relays implement the identical data API. Ordered by
// preference; verified live 2026-07-21 that each answers
// /relay/v1/data/bidtraces/proposer_payload_delivered (incl. slot/block_number
// filters) with the same JSON row shape. `name` rides the response `relay` field.
const MEV_RELAYS = [
  { name: "flashbots", host: "boost-relay.flashbots.net" },
  { name: "ultrasound", host: "relay.ultrasound.money" },
  { name: "agnostic", host: "agnostic-relay.net" },
];

// Same chain map as chain-kit/dex-kit so an agent can pivot freely between them.
const NETWORKS = {
  ethereum: { subdomain: "eth-mainnet", chainId: 1,     llamaName: "Ethereum" },
  base:     { subdomain: "base-mainnet", chainId: 8453, llamaName: "Base" },
  polygon:  { subdomain: "polygon-mainnet", chainId: 137, llamaName: "Polygon" },
  arbitrum: { subdomain: "arb-mainnet", chainId: 42161, llamaName: "Arbitrum" },
  optimism: { subdomain: "opt-mainnet", chainId: 10,    llamaName: "Optimism" },
};

// L2Beat-style classification — we don't query L2Beat directly (their API is
// historically unstable for third-party callers), instead we tag each chain
// from the NETWORKS map. Used by l2-tvl filter.
const IS_L2 = new Set(["base", "polygon", "arbitrum", "optimism"]);

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function requireAlchemyKey() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw bad("L2 gas / finality tools are not configured on this deployment (no ALCHEMY_API_KEY)", 503);
  return key;
}

function pickNetwork(value, dflt = "ethereum") {
  const n = typeof value === "string" ? value.toLowerCase().trim() : dflt;
  const def = NETWORKS[n];
  if (!def) throw bad(`Unsupported network "${value}" - supported: ${Object.keys(NETWORKS).join(", ")}`);
  return { name: n, ...def };
}

async function fetchJson(url, label, init) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", "user-agent": "agent402/mev-and-l2-kit", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || /aborted/i.test(e.message)) {
      throw bad(`${label} upstream timed out after ${TIMEOUT_MS}ms`, 504);
    }
    throw bad(`${label} upstream unreachable: ${e.message}`, 502);
  }
  if (!res.ok) {
    // Redact the FULL body before slicing — the Alchemy key rides the request
    // URL and an upstream error body could reflect it.
    const body = redactSecrets(await res.text().catch(() => "")).slice(0, 240);
    throw bad(`${label} upstream returned HTTP ${res.status}${body ? ": " + body : ""}`, res.status >= 500 ? 502 : res.status);
  }
  return res.json();
}

// Walk the relay chain: try each relay's bidtraces endpoint in order, moving on
// when one fails (non-ok, timeout, unreachable, or malformed/non-array JSON) so
// a single relay's per-IP rate limit never takes the tools down. Returns the
// rows plus WHICH relay served them; throws 502 only when every relay failed.
// NB: relays see different (partially overlapping) block sets, so a fallback
// relay's aggregates (e.g. mev-builder-share) differ slightly from Flashbots' —
// acceptable: availability over exact parity.
async function fetchBidtraces(params) {
  let lastErr = null;
  for (let i = 0; i < MEV_RELAYS.length; i++) {
    const { name, host } = MEV_RELAYS[i];
    try {
      const raw = await fetchJson(
        `https://${host}/relay/v1/data/bidtraces/proposer_payload_delivered?${params}`,
        `MEV relay ${host}`,
      );
      if (!Array.isArray(raw)) throw bad(`MEV relay ${host} returned non-array JSON`, 502);
      return { relay: name, rows: raw };
    } catch (e) {
      lastErr = e;
      const next = MEV_RELAYS[i + 1];
      if (next) console.warn(`[mev] relay ${host} failed (${e.message}) - trying ${next.host}`);
    }
  }
  throw bad(`All ${MEV_RELAYS.length} MEV-Boost relays failed - last: ${lastErr?.message || "unknown"}`, 502);
}

async function alchemyRpc(network, method, params) {
  const key = requireAlchemyKey();
  const net = pickNetwork(network);
  const url = `https://${net.subdomain}.g.alchemy.com/v2/${key}`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const json = await fetchJson(url, "Alchemy", { method: "POST", body, headers: { "content-type": "application/json" } });
  // Redact upstream-derived text: this error's message is folded into the
  // 200-status l2-gas-comparison body as networks[].error (not just a thrown
  // error), so an echoed Alchemy key would ship in a SUCCESS response.
  if (json.error) throw bad(`Alchemy ${method} error: ${redactSecrets(String(json.error.message || JSON.stringify(json.error))).slice(0, 300)}`, 502);
  return json.result;
}

// Flashbots relay reports proposer payment in wei (as a decimal string).
// Convert to ETH for the human-readable envelope.
function weiToEth(value) {
  if (value == null) return null;
  try {
    const wei = BigInt(value);
    // Number conversion is lossy beyond 2^53, but ETH-denominated MEV payments
    // are typically < 100 ETH (1e20 wei) so the float fits fine. Cap at 1e18
    // precision boundary anyway.
    return Number(wei) / 1e18;
  } catch {
    return null;
  }
}

function hexToInt(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
  try { return Number.parseInt(hex.slice(2), 16); } catch { return null; }
}

function hexToBigNumber(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
  try { return BigInt(hex); } catch { return null; }
}

// Builder pubkeys are 96-char hex; truncate for display while keeping them
// distinct (collisions vanish at 16 chars). The full pubkey stays in the
// payload as `pubkey` for agents that need to match against a registry.
function shortPubkey(pk) {
  if (typeof pk !== "string" || !pk.startsWith("0x") || pk.length < 18) return pk ?? null;
  return `${pk.slice(0, 10)}…${pk.slice(-6)}`;
}

// ----------------------------------------------------------------------------
// 1. mev-recent-blocks — last N MEV-Boost-built blocks (Flashbots relay)
// ----------------------------------------------------------------------------
async function mevRecentBlocks({ limit } = {}) {
  const lim = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  const { relay, rows: arr } = await fetchBidtraces(`limit=${lim}`);
  const blocks = arr.map((b) => ({
    slot: Number.parseInt(b.slot, 10),
    blockNumber: Number.parseInt(b.block_number, 10),
    blockHash: b.block_hash ?? null,
    parentHash: b.parent_hash ?? null,
    builderPubkey: b.builder_pubkey ?? null,
    builderShort: shortPubkey(b.builder_pubkey),
    proposerPubkey: b.proposer_pubkey ?? null,
    proposerFeeRecipient: b.proposer_fee_recipient ?? null,
    gasUsed: Number.parseInt(b.gas_used, 10),
    gasLimit: Number.parseInt(b.gas_limit, 10),
    valueWei: b.value ?? null,
    valueEth: weiToEth(b.value),
    numTx: Number.parseInt(b.num_tx, 10) || null,
  }));
  const totalEth = blocks.reduce((acc, b) => acc + (b.valueEth || 0), 0);
  return {
    count: blocks.length,
    totalEthToProposers: Math.round(totalEth * 1e6) / 1e6,
    avgEthPerBlock: blocks.length ? Math.round((totalEth / blocks.length) * 1e6) / 1e6 : 0,
    relay,
    blocks,
  };
}

// ----------------------------------------------------------------------------
// 2. mev-builder-share — builder market share over last N blocks
// ----------------------------------------------------------------------------
async function mevBuilderShare({ window } = {}) {
  const w = Math.max(10, Math.min(200, Number.parseInt(window, 10) || 100));
  const { relay, rows: arr } = await fetchBidtraces(`limit=${w}`);
  // Aggregate by builder pubkey: count blocks + sum ETH paid to proposers
  // (a builder's payment proxy for the value they extracted, minus their cut).
  // When a fallback relay serves, the aggregate covers THAT relay's block set —
  // slightly different numbers from Flashbots' view, by design.
  const map = new Map();
  for (const b of arr) {
    const pk = b.builder_pubkey || "unknown";
    const eth = weiToEth(b.value) || 0;
    const cur = map.get(pk) || { pubkey: pk, blocks: 0, totalEth: 0 };
    cur.blocks += 1;
    cur.totalEth += eth;
    map.set(pk, cur);
  }
  const rows = [...map.values()]
    .map((r) => ({
      builderPubkey: r.pubkey,
      builderShort: shortPubkey(r.pubkey),
      blocks: r.blocks,
      sharePct: Math.round((r.blocks / arr.length) * 10000) / 100,
      totalEthToProposers: Math.round(r.totalEth * 1e6) / 1e6,
      avgEthPerBlock: Math.round((r.totalEth / r.blocks) * 1e6) / 1e6,
    }))
    .sort((a, b) => b.blocks - a.blocks);
  return {
    windowBlocks: arr.length,
    uniqueBuilders: rows.length,
    relay,
    builders: rows,
  };
}

// ----------------------------------------------------------------------------
// 3. mev-block-payment — look up MEV payment for a specific slot
// ----------------------------------------------------------------------------
async function mevBlockPayment({ slot, blockNumber } = {}) {
  const s = Number.parseInt(slot, 10);
  const b = Number.parseInt(blockNumber, 10);
  if (!Number.isFinite(s) && !Number.isFinite(b)) {
    throw bad('"slot" or "blockNumber" is required (one of them, integer)');
  }
  const params = new URLSearchParams();
  if (Number.isFinite(s)) params.set("slot", String(s));
  if (Number.isFinite(b)) params.set("block_number", String(b));
  const { relay, rows: arr } = await fetchBidtraces(String(params));
  if (!arr.length) {
    return {
      found: false,
      slot: Number.isFinite(s) ? s : null,
      blockNumber: Number.isFinite(b) ? b : null,
      relay,
      note: `Slot/block was not delivered via the ${relay} relay (may have been built locally, or via a different MEV-Boost relay).`,
    };
  }
  const entry = arr[0];
  return {
    found: true,
    slot: Number.parseInt(entry.slot, 10),
    blockNumber: Number.parseInt(entry.block_number, 10),
    blockHash: entry.block_hash ?? null,
    builderPubkey: entry.builder_pubkey ?? null,
    builderShort: shortPubkey(entry.builder_pubkey),
    proposerPubkey: entry.proposer_pubkey ?? null,
    proposerFeeRecipient: entry.proposer_fee_recipient ?? null,
    valueWei: entry.value ?? null,
    valueEth: weiToEth(entry.value),
    gasUsed: Number.parseInt(entry.gas_used, 10),
    gasLimit: Number.parseInt(entry.gas_limit, 10),
    numTx: Number.parseInt(entry.num_tx, 10) || null,
    relay,
  };
}

// ----------------------------------------------------------------------------
// 4. l2-tvl — L2 TVL ranking via DeFiLlama
// ----------------------------------------------------------------------------
async function l2Tvl({ limit } = {}) {
  const lim = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 15));
  const raw = await fetchJson(LLAMA, "DeFiLlama");
  const arr = Array.isArray(raw) ? raw : [];
  // DeFiLlama tags chains with categories. The reliable signal for "is L2"
  // is when chain.parent.chain === "Ethereum" AND chain.parent.types
  // includes "L2"/"Rollup". As a safety net we also flag well-known L2s
  // by name (e.g. Base, Arbitrum, Optimism, zkSync Era, Linea, Scroll, Mantle).
  const KNOWN_L2 = new Set([
    "Arbitrum", "Optimism", "Base", "zkSync Era", "Linea", "Scroll", "Mantle",
    "Polygon zkEVM", "Starknet", "Blast", "Mode", "Manta", "Metis",
    "Polygon", "Immutable zkEVM", "Taiko", "World Chain",
  ]);
  const filtered = arr.filter((c) => {
    const parentTypes = c.chainAssets?.parent?.types || c.parent?.types || [];
    const isParentL2 = Array.isArray(parentTypes) && parentTypes.some((t) => /l2|rollup/i.test(String(t)));
    return isParentL2 || KNOWN_L2.has(c.name);
  });
  const sorted = filtered
    .map((c) => ({
      name: c.name,
      tvlUsd: typeof c.tvl === "number" ? c.tvl : null,
      tokenSymbol: c.tokenSymbol ?? null,
      gecko: c.gecko_id ?? null,
      cmcId: c.cmcId ?? null,
    }))
    .filter((c) => c.tvlUsd != null)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, lim);
  const totalTvl = sorted.reduce((acc, c) => acc + c.tvlUsd, 0);
  return {
    count: sorted.length,
    totalTvlUsd: Math.round(totalTvl),
    chains: sorted,
    source: "defillama",
    note: "TVL is the cross-DeFi snapshot from DeFiLlama; L2 classification combines parent-chain hint + a curated list of well-known L2s.",
  };
}

// ----------------------------------------------------------------------------
// 5. l2-gas-comparison — current gas snapshot across L1 + supported L2s
// ----------------------------------------------------------------------------
async function l2GasComparison({ networks } = {}) {
  const named = Array.isArray(networks) && networks.length ? networks.map((n) => String(n).toLowerCase().trim()) : null;
  // An unknown name used to be dropped silently, so ["base","narnia"] answered
  // with base alone and the caller never learned (corpus, 2026-09-06).
  const unknown = (named || []).filter((n) => !NETWORKS[n]);
  if (unknown.length) throw bad(`Unknown network(s): ${unknown.join(", ")}; supported: ${Object.keys(NETWORKS).join(", ")}`);
  const requested = named || Object.keys(NETWORKS);
  // Fail-fast on missing key so 503 surfaces cleanly instead of being
  // swallowed per-chain by Promise.allSettled below.
  requireAlchemyKey();
  const results = await Promise.allSettled(
    requested.map(async (n) => {
      const [gasPriceHex, blockHex] = await Promise.all([
        alchemyRpc(n, "eth_gasPrice", []),
        alchemyRpc(n, "eth_blockNumber", []),
      ]);
      const gasPriceWei = hexToBigNumber(gasPriceHex);
      const gasPriceGwei = gasPriceWei != null ? Number(gasPriceWei) / 1e9 : null;
      return {
        network: n,
        chainId: NETWORKS[n].chainId,
        isL2: IS_L2.has(n),
        gasPriceWei: gasPriceWei != null ? gasPriceWei.toString() : null,
        gasPriceGwei: gasPriceGwei != null ? Math.round(gasPriceGwei * 1e4) / 1e4 : null,
        blockNumber: hexToInt(blockHex),
      };
    }),
  );
  const ok = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { network: requested[i], error: redactSecrets(String(r.reason?.message || "rpc-failed")).slice(0, 300) },
  );
  // Cheapest-first ordering is what an agent comparing chains actually wants.
  const sorted = ok.slice().sort((a, b) => {
    if (a.error && b.error) return 0;
    if (a.error) return 1;
    if (b.error) return -1;
    return (a.gasPriceGwei ?? Infinity) - (b.gasPriceGwei ?? Infinity);
  });
  return {
    queriedAt: new Date().toISOString(),
    networks: sorted,
    cheapest: sorted.find((r) => !r.error)?.network ?? null,
    source: "alchemy",
  };
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------
export const MEV_AND_L2_TOOLS = [
  {
    route: "POST /api/mev-recent-blocks",
    name: "MEV recent blocks",
    slug: "mev-recent-blocks",
    category: "crypto",
    price: "$0.002",
    description:
      "Last N MEV-Boost-built blocks via the Flashbots relay. For each block: slot, block number/hash, builder pubkey, proposer pubkey, gas used/limit, ETH paid to the proposer, and tx count. Use to monitor block-builder market share, proposer revenue, or to correlate an arbitrage opportunity with the block it landed in.",
    tags: ["mev", "flashbots", "mev-boost", "builder", "block-payment"],
    discovery: {
      bodyType: "json",
      input: { limit: 5 },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of recent blocks (1-100, default 20)." },
        },
      },
      output: {
        example: {
          count: 1,
          totalEthToProposers: 0.072345,
          avgEthPerBlock: 0.072345,
          relay: "flashbots",
          blocks: [{
            slot: 12345678,
            blockNumber: 22345678,
            blockHash: "0xabc...",
            parentHash: "0xdef...",
            builderPubkey: "0x9000...",
            builderShort: "0x90000000…abcdef",
            proposerPubkey: "0xa000...",
            proposerFeeRecipient: "0x1234...",
            gasUsed: 14987654,
            gasLimit: 30000000,
            valueWei: "72345000000000000",
            valueEth: 0.072345,
            numTx: 187,
          }],
        },
      },
    },
    handler: mevRecentBlocks,
  },
  {
    route: "POST /api/mev-builder-share",
    name: "MEV builder share",
    slug: "mev-builder-share",
    category: "crypto",
    price: "$0.002",
    description:
      "Builder market share aggregated over the last N MEV-Boost blocks via the Flashbots relay. Returns per-builder block count, share percent, total ETH paid to proposers, and average per block. Use to track block-builder concentration or detect a new builder gaining share.",
    tags: ["mev", "flashbots", "builder-share", "concentration", "market-structure"],
    discovery: {
      bodyType: "json",
      input: { window: 100 },
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "number", description: "Recent blocks to aggregate (10-200, default 100)." },
        },
      },
      output: {
        example: {
          windowBlocks: 100,
          uniqueBuilders: 5,
          relay: "flashbots",
          builders: [{
            builderPubkey: "0x9000...",
            builderShort: "0x90000000…abcdef",
            blocks: 42,
            sharePct: 42.0,
            totalEthToProposers: 3.456789,
            avgEthPerBlock: 0.082305,
          }],
        },
      },
    },
    handler: mevBuilderShare,
  },
  {
    route: "POST /api/mev-block-payment",
    name: "MEV block payment lookup",
    slug: "mev-block-payment",
    category: "crypto",
    price: "$0.002",
    description:
      "Look up the MEV-Boost payment for a specific slot or block number via the Flashbots relay. Returns the builder, proposer, value paid in ETH, gas usage, and tx count. Returns found=false if the block was built locally or via a different MEV-Boost relay (Flashbots is one of several).",
    tags: ["mev", "flashbots", "block-payment", "lookup"],
    discovery: {
      bodyType: "json",
      // A block the Flashbots relay delivered, so the documented call returns
      // found:true as shown (block 22000000 was not delivered through it).
      input: { blockNumber: 26104983 },
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "number", description: "Beacon chain slot number (one of slot/blockNumber required)." },
          blockNumber: { type: "number", description: "Execution layer block number (one of slot/blockNumber required)." },
        },
      },
      output: {
        example: {
          found: true,
          slot: 15343686,
          blockNumber: 26104983,
          blockHash: "0x29b12476c4bdbad3d080057a7c068c42da781d4bfb1545491d65b9f942a20461",
          builderPubkey: "0x89057b5818abfca92fb9d38ea74dfab0f6f58630b6138e4f73da26666295e047cb18d353a134c5fad672eba231ff610c",
          builderShort: "0x89057b58…ff610c",
          proposerPubkey: "0xb6ab19ca47a0b0f67e95e4cbb772fd8feff2a4f481eb494a06d54308f7fa959ee87889e2ffbe34ee8d466ed47a7d5dbd",
          proposerFeeRecipient: "0xd4E96eF8eee8678dBFf4d535E033Ed1a4F7605b7",
          valueWei: "9667520599769125",
          valueEth: 0.009667520599769124,
          gasUsed: 14100104,
          gasLimit: 60000000,
          numTx: 144,
          relay: "flashbots",
        },
      },
    },
    handler: mevBlockPayment,
  },
  {
    route: "POST /api/l2-tvl",
    name: "L2 TVL ranking",
    slug: "l2-tvl",
    category: "crypto",
    price: "$0.002",
    description:
      "Top L2s by Total Value Locked (TVL) via DeFiLlama. Returns each L2 with TVL in USD, native token symbol, and CoinGecko/CMC ids. Classification combines DeFiLlama's parent-chain hint with a curated list of well-known L2s (Arbitrum, Optimism, Base, zkSync Era, Linea, Scroll, Mantle, Polygon zkEVM, Starknet, Blast, Mode, Manta, Metis, Polygon, Taiko, Immutable zkEVM, World Chain).",
    // Vocabulary the ASKERS use, not just ours. Measured against the live
    // catalog: `l2beat` resolved to ZERO results while this tool shipped, and
    // `rollup tvs` scraped a weak 22. L2Beat is the canonical rollup-data site
    // and TVS (Total Value Secured) is its metric name, so an agent fluent in
    // the domain reaches for words no tool record contained. Ranking cannot
    // recover a word that appears nowhere, however good the scorer is.
    // The spelled-out "layer 2" form is
    // handled in find.js instead, NOT by a "layer" tag here: bare "layer" is an
    // ordinary English word, and tagging it sent "osi model layer" and "layer
    // of encryption" straight to this tool at high confidence. A zero-result
    // miss traded for a confidently wrong answer is a worse bug, not a fix -
    // the agent pays for that one.
    //
    // These are ROUTING terms, not a claim of equivalence: the source stays
    // DeFiLlama TVL, stated in the description and in the payload's `source`,
    // and TVS is a related-but-distinct measure. Returning the closest real
    // answer with its provenance on it beats returning nothing.
    // "rollups" is listed beside "rollup" deliberately: tag matching is exact
    // per token, so the plural reached NOTHING here and "total value locked on
    // rollups" resolved to crypto-global at score 2 (pre-existing, found by the
    // test below). The description now spells TVL out for the same reason.
    tags: ["l2", "tvl", "defillama", "rollup", "rollups", "ranking", "l2beat", "tvs"],
    discovery: {
      bodyType: "json",
      input: { limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of L2s to return (1-50, default 15)." },
        },
      },
      output: {
        example: {
          count: 2,
          totalTvlUsd: 5500000000,
          chains: [
            { name: "Arbitrum", tvlUsd: 3000000000, tokenSymbol: "ARB", gecko: "arbitrum", cmcId: 11841 },
            { name: "Base", tvlUsd: 2500000000, tokenSymbol: "ETH", gecko: "base", cmcId: null },
          ],
          source: "defillama",
          note: "TVL is the cross-DeFi snapshot from DeFiLlama; L2 classification combines parent-chain hint + a curated list of well-known L2s.",
        },
      },
    },
    handler: l2Tvl,
  },
  {
    route: "POST /api/l2-gas-comparison",
    name: "L2 gas comparison",
    slug: "l2-gas-comparison",
    category: "crypto",
    price: "$0.002",
    description:
      "Current gas snapshot across Ethereum + supported L2s (Base, Polygon, Arbitrum, Optimism), sorted cheapest-first. Returns gas price in gwei, latest block number, chain id, and an isL2 flag per chain. Use to route a transaction to the cheapest viable L2 or to track L1→L2 gas spread.",
    // Deliberately NOT "l2beat"/"tvs" - those name a TVL/risk dataset, and
    // pointing a gas query at them would be the same wrong-answer failure in
    // the other direction. The "layer 2" spelling is handled in find.js.
    tags: ["l2", "gas", "cross-chain", "comparison", "routing"],
    discovery: {
      bodyType: "json",
      input: { networks: ["ethereum", "base", "arbitrum", "optimism", "polygon"] },
      inputSchema: {
        type: "object",
        properties: {
          networks: {
            type: "array",
            description: "Subset of networks to query. Default = all 5. Supported: ethereum, base, polygon, arbitrum, optimism.",
          },
        },
      },
      output: {
        example: {
          queriedAt: "2026-06-22T19:00:00.000Z",
          networks: [
            { network: "base", chainId: 8453, isL2: true, gasPriceWei: "100000000", gasPriceGwei: 0.1, blockNumber: 22000000 },
            { network: "arbitrum", chainId: 42161, isL2: true, gasPriceWei: "100000000", gasPriceGwei: 0.1, blockNumber: 300000000 },
            { network: "ethereum", chainId: 1, isL2: false, gasPriceWei: "15000000000", gasPriceGwei: 15.0, blockNumber: 22000000 },
          ],
          cheapest: "base",
          source: "alchemy",
        },
      },
    },
    handler: l2GasComparison,
  },
];

// Test-only exports
export const __test = {
  MEV_RELAYS,
  fetchBidtraces,
  weiToEth,
  hexToInt,
  hexToBigNumber,
  shortPubkey,
  pickNetwork,
  NETWORKS,
  IS_L2,
};
