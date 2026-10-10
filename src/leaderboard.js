// x402 Leaderboard — the first public on-chain ranking of x402 sellers.
//
// There's no central registry of "who's most used in x402". The protocol is too
// young. But every seller registered on the Coinbase CDP Bazaar publishes a
// `payTo` wallet alongside their resource listing, and every settled call moves
// USDC on Base (and other chains). That's the trustless signal: rank sellers by their actual
// on-chain settlement volume.
//
// Pipeline (see runLeaderboard below):
//   1. Crawl the Bazaar discovery API → every resource + its Base-mainnet payTo.
//   2. Group by wallet (one seller can list many endpoints under one payTo).
//   3. eth_getLogs on Base USDC, topics[2] = array of all seller wallets, over
//      the last SPAN_BLOCKS blocks — chunked to respect public-RPC limits.
//   4. Filter to per-call settlements (within MAX_CALL_USD ceiling — bigger
//      transfers are funding/swaps, not tool buys).
//   5. Aggregate: count, total USD, unique buyers per seller.
//   6. Rank by total USD; ties on calls (more activity wins) then alphabetical.
//
// This module is read-only and idempotent. Best-effort: any RPC/registry
// failure surfaces as a snapshot with `scanSkipped: true` so the endpoint can
// still serve something useful (and `/health` stays green).
//
// Why server-side caching matters: a full run is ~28 Bazaar pages + several
// eth_getLogs calls (~30s-2min). We cache the snapshot in memory and refresh
// hourly; the endpoint reads from cache so each request is sub-millisecond.

import { createJsonDocument } from "./json-document.js";
import { trackStoreReady, leased } from "./state-db.js";
import { timedSync } from "./boot-timing.js";
import { fetchAllBazaarItems as walkBazaar } from "./bazaar-pager.js";
import { EVM, OUR_EVM_WALLETS } from "./revenue-live.js";
import { redactSecrets } from "./tools/redact.js";
import { FUNDING_DEFAULTS, posOf, endOfBlock, circularWalletsFrom, readSellerFunding, readPayerHistory, readFundingGaps, newFundingReadControl, fundingDayCalls, processSellerFunding, sellerFundingFigures, createFundingState, serializeFundingState, parseFundingState, pruneFundingState, fundingPairCount, fundingKnownCount, historyFromBlockFor, isScannableWallet } from "./seller-funding.js";
import { NETWORKS } from "./payments.js";

import { createBlockClock, rpcHeaderReader } from "./block-clock.js";
// The board's window is a span of TIME (24h by default, 7d in production),
// and the scan finds the block where it starts by BLOCK TIMESTAMP
// (src/block-clock.js). It used to be a block count at an assumed 2 s per Base
// block (24h = 43,200, 7d = 302,400); Base's Denim upgrade moves blocks to
// 200 ms on a date not known in advance, and that count would have become a
// 17-hour board with nothing failing. A wider window surfaces sellers with
// bursty (vs. constant) traffic. The scan folds transfers incrementally
// (see initWalletAccumulator/foldTransfers/finalizeLeaderboard below) so any
// window is memory-bounded.
//
// LEADERBOARD_WINDOW_SECONDS sets the window. The older SPAN_BLOCKS is still
// honoured and read as blocks of the 2 s Base block time it was written
// against (302400 -> 7d), so the production setting keeps its meaning across
// the fork rather than silently shrinking with it.
const LEGACY_SECONDS_PER_BLOCK = 2;
function windowSecondsFromEnv(env = process.env) {
  const s = parseInt(env.LEADERBOARD_WINDOW_SECONDS || "", 10);
  if (Number.isFinite(s) && s > 0) return s;
  const b = parseInt(env.SPAN_BLOCKS || "", 10);
  if (Number.isFinite(b) && b > 0) return b * LEGACY_SECONDS_PER_BLOCK;
  return 86_400;
}
export { windowSecondsFromEnv };
const DEFAULT_BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
];
// Published thresholds for the payer-concentration flag. Named here (and
// echoed in the API envelope) so the flag is reproducible from the two shares
// rather than being a verdict only we can compute.
export const CONCENTRATION = { majority: 0.5, supermajority: 0.9 };

// A payer is "broad" once it settles with this many DISTINCT sellers in the
// window. Measured 2026-09-13 across the top 22 Base sellers: 110 of 2,632
// payers paid more than one, the widest touching 14. A wallet walking the
// ecosystem is not the same customer signal as a wallet that chose you, and
// uniqueBuyers cannot tell them apart.
export const PAYER_BREADTH = { multiSellerMin: 3 };

export const DEFAULTS = {
  bazaarUrl: process.env.BAZAAR_URL || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
  // The window in seconds; the scan resolves its first block by timestamp.
  windowSeconds: windowSecondsFromEnv(),
  // Free-tier Base RPCs cap eth_getLogs at 10,000 blocks per call; chunk a wide
  // window into ranges no larger than this so it still scans cleanly.
  chunkBlocks: parseInt(process.env.CHUNK_BLOCKS || "9000", 10),
  maxCallUsd: parseFloat(process.env.MAX_CALL_USD || "0.75"),
  // A transfer that matches a price the seller publishes is admitted above
  // maxCallUsd, but only up to this: a published $1,000 gift card is still
  // value moved, not a tool call, and the board sorts by dollars.
  priceMatchMaxUsd: parseFloat(process.env.PRICE_MATCH_MAX_USD || "25"),
  // Public RPCs limit topic-filter array length; chunk the wallet list per call
  // so a corpus with thousands of unique payTo addresses still scans cleanly.
  walletChunk: parseInt(process.env.WALLET_CHUNK || "200", 10),
  bazaarPageSize: parseInt(process.env.BAZAAR_PAGE_SIZE || "1000", 10),
  bazaarMaxPages: parseInt(process.env.BAZAAR_MAX_PAGES || "200", 10),
  // 0 = no cap. Useful for keeping the on-chain scan tight when the Bazaar grows.
  maxWalletsScan: parseInt(process.env.MAX_WALLETS_SCAN || "0", 10),
  // BASE_RPCS (if set) fully replaces the list, same as before. Otherwise,
  // Alchemy goes first when ALCHEMY_API_KEY is configured — it handles wide
  // getLogs ranges far more reliably than public nodes (mirrors the EVM rpcs
  // pattern in src/revenue-live.js) — with the public list as fallback.
  rpcs: (process.env.BASE_RPCS ||
    [
      ...(process.env.ALCHEMY_API_KEY ? [`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      ...DEFAULT_BASE_RPCS,
    ].join(",")
  ).split(",").map((s) => s.trim()).filter(Boolean),
};

// CAIP-2 chain id for Base mainnet. The Bazaar tags every payment option with
// this — we only credit Base-mainnet settlements so testnet/Polygon noise stays
// out of the ranking.
const BASE_MAINNET = "eip155:8453";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers (unit-tested in scripts/test-x402-leaderboard.js) ---------

function originOf(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

/** The Transfer event's `from` (topics[1]) as a lowercase 0x-address.
 *  Mirrors scripts/revenue-scan.js#payerFromLog — kept local so src/ doesn't
 *  reach into scripts/. Behaviour identical; if either changes, change both. */
export function payerFromLog(l) {
  const t = l?.topics?.[1];
  return t && t.length >= 40 ? ("0x" + t.slice(-40)).toLowerCase() : null;
}

/** Does this accept pay on the scanned chain? x402 v2 names the chain by its
 *  CAIP-2 id. A v1 listing names it by shorthand ("base"), and that shorthand
 *  is the chain key NETWORKS already maps to the same id, so a v1 listing is
 *  read as that chain rather than skipped. The index does the same through
 *  NETWORK_SHORTHAND; this module keeps its own copy so it imports nothing
 *  from the index. */
function acceptOnChain(a, chain) {
  const n = a?.network;
  if (typeof n !== "string") return false;
  if (n === String(chain.caip2 || BASE_MAINNET)) return true;
  return n.toLowerCase() === String(chain.key || "base").toLowerCase();
}

/**
 * Pull the Base-mainnet payment wallet from a Bazaar item's `accepts[]`. An
 * item lists multiple payment options (different chains/schemes); for ranking
 * we only credit Base-mainnet USDC. Other chains and testnets stay out.
 *
 * Returns { wallet, network } or null. Wallet is lowercase-normalised so it
 * matches eth_getLogs `to` topics (which are zero-padded lowercase hex).
 */
export function baseUsdcPayToFromItem(item, chain = { caip2: BASE_MAINNET, token: USDC, key: "base" }) {
  const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
  const token = String(chain.token || USDC).toLowerCase();
  for (const a of accepts) {
    if (!acceptOnChain(a, chain)) continue;
    const asset = String(a.asset || "").toLowerCase();
    if (asset && asset !== token) continue;
    const w = a.payTo;
    if (typeof w !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(w)) continue;
    return { wallet: w.toLowerCase(), network: chain.key || "base" };
  }
  return null;
}

/** The price this listing ADVERTISES on the scanned chain, in micro-dollars,
 *  or null when it declares none we can read.
 *
 *  Reads the same accept `baseUsdcPayToFromItem` picked, so the price and the
 *  wallet always come from one row rather than two. USDC is 6 decimals on
 *  every chain we scan, so base units ARE micro-dollars. */
export function advertisedMicroUsd(item, chain = { caip2: BASE_MAINNET, token: USDC, key: "base" }) {
  const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
  const token = String(chain.token || USDC).toLowerCase();
  for (const a of accepts) {
    if (!acceptOnChain(a, chain)) continue;
    const asset = String(a.asset || "").toLowerCase();
    if (asset && asset !== token) continue;
    const raw = a.amount ?? a.maxAmountRequired;
    const n = Number(raw);
    // Whole positive base units only. A decimal, a NaN or a zero tells us
    // nothing about what this seller charges, and a wrong price here would
    // admit transfers rather than exclude them.
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    return n;
  }
  return null;
}

/** Does this transfer look like a purchase at a price the seller publishes?
 *
 *  WHY THIS EXISTS. The fold used to keep a transfer only when it was under a
 *  flat MAX_CALL_USD ceiling, with the reasoning that "bigger transfers are
 *  funding/swaps, not tool buys". That was true when every x402 tool cost a
 *  fraction of a cent and it is not true now. Measured 2026-09-21 against a
 *  list of active services over the same 7-day window we scan: most were
 *  absent from our board entirely, because their average transfer sat above
 *  the ceiling, some by a few cents. We were not ranking them lower. We could
 *  not see them.
 *
 *  The ceiling was not simply wrong, which is why this does not just raise it.
 *  Some of those services convert stablecoins or sell gift cards, so their
 *  volume is the value moved rather than a fee, and folding that in would make
 *  this a table of money-moved and call it API revenue. The ceiling was
 *  aiming at that and hitting everything else.
 *
 *  So ask the seller instead. We already hold every price each wallet
 *  advertises, from the same feed and the same accept the wallet came from. A
 *  transfer that equals one of them is a purchase at a published price, up to
 *  priceMatchMaxUsd ($25 by default): that rescues the $0.79 tool the flat
 *  ceiling hid and still refuses the $1,000 gift card whose price is published
 *  just the same (measured the day this shipped: five such transfers supplied
 *  ~$5,000 of one seller's $5,072 row). A transfer that matches nothing is
 *  held to the old ceiling, which is the honest fallback for a wallet whose
 *  listings we cannot read.
 *
 *  TOLERANCE. Premium chains quote slightly above list (NETWORK_PRICE_PREMIUMS)
 *  and a buyer may round up, so a payment AT or slightly ABOVE a published
 *  price counts, and one below it does not - underpaying is not buying. The
 *  window is one cent or 2%, whichever is larger, which covers a premium on a
 *  dollar-scale price without letting a $1,000 transfer match a $0.99 listing.
 */
export function priceMatches(microUsd, prices) {
  if (!prices || !prices.size || !Number.isFinite(microUsd)) return false;
  for (const p of prices) {
    const slack = Math.max(10_000, Math.round(p * 0.02));
    if (microUsd >= p && microUsd <= p + slack) return true;
  }
  return false;
}

/** Scan config for any EVM rail we settle on, assembled from the two places
 *  that already define them: NETWORKS (CAIP-2) and revenue-live's EVM block
 *  (USDC address, Alchemy-first RPCs, and a span already tuned to that chain's
 *  block time — Arbitrum's 0.25s blocks need a very different window from
 *  Base's 2s, which is the whole reason this is not one constant).
 *
 *  Returns null for a chain we have no config for, so a caller can never
 *  silently scan the wrong token on the wrong rail. */
export function chainScanConfig(chainKey) {
  const key = String(chainKey || "base").toLowerCase();
  const rail = EVM[key];
  const caip2 = NETWORKS[key];
  if (!rail || !caip2 || !rail.token || !(rail.rpcs || []).length) return null;
  return {
    key,
    label: rail.label || key,
    caip2,
    token: String(rail.token).toLowerCase(),
    rpcs: rail.rpcs,
    spanBlocks: rail.span,
    explorer: rail.explorer,
  };
}

/** Every EVM rail we can rank, Base first. */
export function rankableChains() {
  return Object.keys(EVM).map(chainScanConfig).filter(Boolean);
}

/**
 * Group Bazaar items by Base-mainnet payTo wallet. One seller can list many
 * endpoints under one payTo; the leaderboard ranks per wallet, not per
 * endpoint. Each row carries: name (most common serviceName across the
 * wallet's endpoints), origins (set of host origins), endpoints (count).
 */
export function extractWalletsFromBazaar(payload, chain = undefined) {
  const list =
    payload?.resources ||
    payload?.items ||
    payload?.data ||
    (Array.isArray(payload) ? payload : []);
  const byWallet = new Map();
  for (const item of list) {
    const pay = baseUsdcPayToFromItem(item, chain);
    if (!pay) continue;
    const origin = originOf(item?.resource || item?.url || item?.endpoint || item?.homepage);
    if (!byWallet.has(pay.wallet)) {
      byWallet.set(pay.wallet, {
        wallet: pay.wallet,
        network: pay.network,
        origins: new Set(),
        names: new Map(), // name → count, so we can pick the most common
        endpoints: 0,
        // Every price this wallet ADVERTISES, in micro-dollars. This is what
        // turns "is this transfer a tool buy" from a guess into a reading of
        // the seller's own listing - see priceMatches below.
        prices: new Set(),
      });
    }
    const row = byWallet.get(pay.wallet);
    if (origin) row.origins.add(origin);
    const name = String(item?.serviceName || item?.name || "").trim();
    if (name) row.names.set(name, (row.names.get(name) || 0) + 1);
    const micro = advertisedMicroUsd(item, chain);
    if (micro != null) row.prices.add(micro);
    row.endpoints += 1;
  }
  return [...byWallet.values()].map((r) => {
    // Pick the most common serviceName the wallet publishes — but allow a
    // domain-shaped extension (e.g. "Agent402.tools" extending "Agent402") to
    // win even when the Bazaar crawler hasn't fully re-harvested every endpoint
    // with the new brand yet. Brand renames almost always *add* a TLD rather
    // than change letters, so a longer name that starts with the top name + "."
    // is overwhelmingly the canonical one even if it's outvoted on count.
    const byCount = [...r.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    let topName = byCount[0]?.[0];
    if (topName) {
      const extension = byCount.find(([n]) =>
        n !== topName && n.length > topName.length && n.toLowerCase().startsWith(topName.toLowerCase() + ".")
      );
      if (extension) topName = extension[0];
    }
    const origins = [...r.origins];
    return {
      wallet: r.wallet,
      network: r.network,
      name: topName || origins[0]?.replace(/^https?:\/\//, "") || r.wallet,
      origins,
      homepage: origins[0] || null,
      endpoints: r.endpoints,
      // Carried through to the fold, which needs the seller's own prices to
      // decide whether a transfer is a purchase. Kept as a Set: it is read
      // per transfer and never serialised.
      prices: r.prices,
    };
  });
}

/**
 * Fold the payTo wallets OUR OWN CRAWL knows into the scan list (2026-09-18).
 *
 * Until today the list came from Coinbase Bazaar alone, so settlement evidence
 * on Base was only ever collected for wallets that registry happened to carry.
 * An origin we indexed ourselves, whose payTo we read from its own live 402,
 * could settle any volume and stay `settled: null` forever - and that field is
 * what dispatchEligibility reads, so the router's verdict for such a seller was
 * `settlement_required` permanently, whatever the chain said. Reported by a
 * seller who had traced it through this file before writing to us, and
 * corroborated here: their payTo is absent from all 15,636 Bazaar items.
 *
 * We had already built the right version once - the Solana board scans every
 * payTo the index knows (allSolanaPayToOrigins) and depends on no registry.
 * This is the Base twin of that, and it is deliberately a SEED, not evidence:
 * a wallet enters the scan, the chain still decides what it settled, and
 * evidencePayToVerdict still refuses a gate cleared on wallets an origin does
 * not itself pay to. Measured cost when it shipped: about 63 wallets on top of
 * 1,204 from the Bazaar, inside the existing chunking.
 *
 * `payToOrigins` is Map(lowercased wallet -> Set(origin)), the shape
 * allPayToOrigins() returns. Injected rather than imported so this module
 * keeps no dependency on the index and stays testable offline.
 */
export function mergeCrawledWallets(sellers, payToOrigins, chain = undefined, payToPrices = null) {
  if (!payToOrigins || typeof payToOrigins.entries !== "function") return { merged: sellers, added: 0 };
  // Match the shape extractWalletsFromBazaar emits: rows carry the chain KEY
  // ("base"), not the CAIP-2 id, and a mixed field would split the board.
  const network = chain?.key || "base";
  const known = new Map(sellers.map((s) => [String(s.wallet).toLowerCase(), s]));
  let added = 0;
  for (const [wallet, originSet] of payToOrigins.entries()) {
    if (typeof wallet !== "string" || !/^0x[0-9a-f]{40}$/.test(wallet)) continue;
    const origins = [...(originSet || [])].filter((o) => typeof o === "string");
    const existing = known.get(wallet);
    if (existing) {
      // Bazaar already names this wallet. Keep its row (its name and endpoint
      // count are better evidence of how the seller presents itself) and only
      // union in origins the crawl knows about, so attribution is not lost.
      for (const o of origins) if (!existing.origins.includes(o)) existing.origins.push(o);
      existing.source = existing.source === "crawl" ? "crawl" : "both";
      continue;
    }
    // A wallet only our crawl knows. `endpoints` drives the optional
    // maxWalletsScan cap's ordering, so it carries the number of origins
    // advertising this wallet rather than 0, which would put every crawled
    // wallet first in line to be dropped whenever a cap is set.
    known.set(wallet, {
      wallet,
      network,
      name: origins[0] ? origins[0].replace(/^https?:\/\//, "") : wallet,
      origins,
      homepage: origins[0] || null,
      endpoints: Math.max(1, origins.length),
      source: "crawl",
      // The prices this wallet's own routes publish, as the index read them
      // (2026-09-30). Without them priceMatches had nothing to read for a
      // crawl-only wallet. Bazaar rows above are left as the Bazaar lists
      // them: for a wallet both sources know, the Bazaar's prices stand.
      prices: payToPrices?.get?.(wallet) instanceof Set ? new Set(payToPrices.get(wallet)) : new Set(),
    });
    added++;
  }
  return { merged: [...known.values()], added };
}

/** The operator group a wallet row belongs to on the public board: its
 *  canonical host, else the wallet itself. Display grouping only: the host
 *  comes from listings, which anyone can write, so it never decides whose
 *  evidence a wallet is (the seller-funding rule reads a wallet's OWN
 *  outbound only). */
export function groupKeyOf(w) {
  // A path seller (an app under a prefix on a shared host) is its own operator
  // row: grouping by the host would merge every app on it, and its homepage is
  // often that shared host's root.
  const pathSeller = pathSellerGroup(w?.origins?.[0]);
  if (pathSeller) return `host:${pathSeller}`;
  const host = canonicalHost(w?.homepage) || canonicalHost(w?.origins?.[0]);
  return host ? `host:${host}` : `wallet:${String(w?.wallet || "").toLowerCase()}`;
}
// host + prefix of a listing key that carries a path, else null. Listing keys
// are normalised origins, so a path here is a path seller's prefix.
function pathSellerGroup(origin) {
  if (typeof origin !== "string") return null;
  try {
    const u = new URL(origin);
    const path = u.pathname.replace(/\/+$/, "");
    if (!path) return null;
    return `${u.host.toLowerCase().replace(/^www\./, "")}${path}`;
  } catch { return null; }
}

/**
 * Canonical host for grouping sellers. Two listings on the same operator-owned
 * website should be one row even if the operator publishes them under separate
 * wallets — the leaderboard ranks operators, not addresses. We lowercase + strip
 * a leading `www.`; we deliberately don't collapse arbitrary subdomains
 * (api.x.com vs docs.x.com could be different products run by different teams).
 *
 * Returns null if the URL doesn't have a usable http(s) host — those rows stay
 * keyed by wallet and don't merge with anything.
 */
export function canonicalHost(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch { return null; }
}

/**
 * Aggregate transfer logs into a per-operator leaderboard. Counts only
 * settlements within the per-call ceiling (per-call buys are ≤maxCallUsd;
 * larger inbound is funding/swaps and not what we're ranking).
 *
 * The shape is operator-first, not wallet-first: rows are grouped by canonical
 * host (see canonicalHost). A single operator who lists multiple wallets under
 * the same website becomes one row with summed volume, unioned buyers, and an
 * array of all their wallets. This is the right unit of measure for "who's
 * actually being used" — splitting a single seller's volume across wallets
 * under-counts them.
 *
 * `transfers`: [{ wallet, payer, usd }]  — `wallet` is the recipient (lowercase)
 * `sellers`:   [{ wallet, name, network, origins, homepage, endpoints }]
 *
 * Per-row fields:
 *   wallet       — primary (highest-volume) wallet in the group; preserved
 *                  for back-compat with consumers that only read one address
 *   wallets      — full array of every wallet in the group (≥1 entry)
 *   walletCount  — wallets.length, surfaced explicitly for templates
 *
 * Returns ranked array. Ties on totalUsd break on callsSettled (more activity
 * wins), then alphabetical (purely deterministic — no informational signal).
 */
export function aggregateLeaderboard(transfers, sellers, { maxCallUsd = DEFAULTS.maxCallUsd, ourWallets = OUR_EVM_WALLETS, priceMatchMaxUsd = DEFAULTS.priceMatchMaxUsd } = {}) {
  const byWallet = initWalletAccumulator(sellers);
  foldTransfers(byWallet, transfers, maxCallUsd, ourWallets, priceMatchMaxUsd);
  return finalizeLeaderboard(byWallet, { maxCallUsd });
}

/**
 * Phase A, step 1: seed the `byWallet` accumulator — one row per seller
 * wallet, ready to be folded into by one or many `foldTransfers` calls. Split
 * out of `aggregateLeaderboard` so `runLeaderboard` can build this once up
 * front and fold each block-chunk's transfers into it as the scan runs,
 * instead of collecting every transfer into one array first (see
 * `foldTransfers` / `finalizeLeaderboard` and `runLeaderboard` below — that's
 * the memory-bounded scan path this split exists for).
 */
export function initWalletAccumulator(sellers) {
  const byWallet = new Map();
  for (const s of sellers) {
    byWallet.set(s.wallet, {
      ...s,
      callsSettled: 0,
      totalUsd: 0,
      // Per-payer tallies, not a bare Set of addresses. Same cardinality as the
      // Set it replaces (one entry per distinct payer), plus two numbers each -
      // which is what makes the concentration read below possible at all.
      // uniqueBuyers is perPayer.size, so no count changes by adding this.
      perPayer: new Map(),
    });
  }
  return byWallet;
}

/**
 * Phase A, step 2: fold a batch of transfers into an existing `byWallet`
 * accumulator (mutates it in place; also returns it for chaining). Safe to
 * call repeatedly with successive batches — that's what makes the scan
 * memory-bounded: each batch (a block-chunk's worth of decoded logs) can be
 * discarded right after this call instead of being retained in a master list.
 *
 * `transfers`: [{ wallet, payer, usd }] — `wallet` is the recipient (lowercase)
 *
 * OUR OWN PAYMENTS ARE NOT A SELLER'S EVIDENCE (2026-09-19). Every distinct
 * sender used to count, including us, and these maps feed the router's own
 * gate through buildSettledByOrigin / buildPayersByOrigin - so money we sent a
 * seller counted toward the floor that decides whether we should send them
 * money. Found while verifying three transfers a seller offered as proof: one
 * was our Base spending wallet paying him because a third party had bought a
 * seller-payability check against his endpoint. A payment made to TEST whether
 * a seller can be paid is the clearest thing that is not demand.
 *
 * Measured before changing it: about 39 payments a week leave our wallets to
 * other sellers (route-execute, seller-payability),
 * against a board whose top row alone settles ~90,000 in the window. So this
 * moves no ranking. It matters at the BOTTOM, where a seller with three
 * settlements had one of them from us, and the bottom is exactly the
 * population the routing floor governs.
 *
 * `ourWallets` is injected rather than imported so this stays a pure fold; the
 * caller passes OUR_EVM_WALLETS. Omitted, behaviour is byte-identical to
 * before, which keeps every existing test honest.
 */
/** Over-ceiling inbound payments held for the funding pass: per wallet and in
 *  total across one scan's fold. */
export const UNCOUNTED_IN_MAX_PER_WALLET = 20_000;
export const UNCOUNTED_IN_MAX_TOTAL = 200_000;
const UNCOUNTED_HELD = Symbol("uncountedHeld");
export function foldTransfers(byWallet, transfers, maxCallUsd = DEFAULTS.maxCallUsd, ourWallets = null, priceMatchMaxUsd = DEFAULTS.priceMatchMaxUsd) {
  // ALWAYS normalize, including when a Set is passed. The first cut took a Set
  // as-is on the assumption it was already lowercase, which OUR_EVM_WALLETS is
  // - but that made the exclusion fail OPEN for any future caller holding
  // checksummed addresses: a mixed-case entry would simply never match, our
  // own payments would silently count as a seller's evidence again, and the
  // board would look MORE flattering rather than throwing. Lowercasing is
  // correct here and only here because this fold is EVM-only; base58 and
  // Stellar addresses are case-significant and are never folded through it.
  const ours = new Set([...(ourWallets || [])].map((w) => String(w).toLowerCase()));
  for (const t of transfers) {
    const row = byWallet.get(t.wallet);
    if (!row) continue;
    if (!(t.usd > 0)) continue;
    // A transfer counts when the seller publishes that price, up to
    // priceMatchMaxUsd; otherwise it falls back to the flat ceiling. `prices` is empty for a
    // wallet whose listings carry no readable amount, and then this is exactly
    // the old rule. See priceMatches for why the ceiling alone was hiding
    // whole sellers rather than ranking them low.
    const micro = Math.round(t.usd * 1e6);
    const matched = priceMatches(micro, row.prices) && t.usd <= priceMatchMaxUsd;
    if (!matched && t.usd > maxCallUsd) {
      row.overCeilingSkipped = (row.overCeilingSkipped || 0) + 1;
      // Not a tool call, so not evidence, but still money this payer sent the
      // wallet: the seller-funding pass lets it offset a later refund and pay
      // back a pool (src/seller-funding.js). Kept only with a chain position,
      // and never for our own wallets or the wallet itself.
      // Bounded per wallet and across the scan (every chunk folds into the same
      // map): a listing can name any busy wallet as its payTo, and an exchange
      // hot wallet's inbound would otherwise be held whole for the scan. Past
      // either cap the credit is dropped and counted, which only nets more.
      if (Number.isFinite(t.pos) && t.payer && !ours.has(String(t.payer).toLowerCase()) && String(t.payer).toLowerCase() !== String(t.wallet).toLowerCase()) {
        const held = byWallet[UNCOUNTED_HELD] || (byWallet[UNCOUNTED_HELD] = { n: 0 });
        if ((row.uncountedInHeld || 0) >= UNCOUNTED_IN_MAX_PER_WALLET || held.n >= UNCOUNTED_IN_MAX_TOTAL) { row.uncountedInDropped = (row.uncountedInDropped || 0) + 1; continue; }
        row.uncountedInHeld = (row.uncountedInHeld || 0) + 1; held.n++;
        const u = (row.uncountedIn ||= new Map()).get(t.payer) || { pos: [], micro: [] };
        u.pos.push(t.pos); u.micro.push(Math.round(t.usd * 1e6));
        row.uncountedIn.set(t.payer, u);
      }
      continue;
    }
    if (matched && t.usd > maxCallUsd) row.abovePriceMatched = (row.abovePriceMatched || 0) + 1;
    // Skipped whole, not just as a payer: a settlement we paid for is not a
    // settlement the seller earned, so counting the call while dropping the
    // payer would leave callsSettled overstating what uniqueBuyers reports.
    if (t.payer && ours.has(String(t.payer).toLowerCase())) { row.selfPaidSkipped = (row.selfPaidSkipped || 0) + 1; continue; }
    // A wallet paying itself is not a buyer (2026-09-28): skipped whole, the
    // same way our own payments are.
    if (t.payer && String(t.payer).toLowerCase() === String(t.wallet).toLowerCase()) { row.selfTransferSkipped = (row.selfTransferSkipped || 0) + 1; continue; }
    row.callsSettled += 1;
    row.totalUsd += t.usd;
    if (t.payer) {
      const p = row.perPayer.get(t.payer) || { calls: 0, usd: 0 };
      p.calls += 1;
      p.usd += t.usd;
      // Where on the chain each payment sits (block, log index) and its
      // amount in token units, kept only when the scan supplies a position:
      // the seller-funding pass works each payment against the USDC this
      // wallet had sent that payer before it (src/seller-funding.js). Two
      // numbers per payment, dropped with the accumulator once the scan
      // finalizes.
      if (Number.isFinite(t.pos)) { (p.pos ||= []).push(t.pos); (p.micro ||= []).push(Math.round(t.usd * 1e6)); }
      row.perPayer.set(t.payer, p);
    }
  }
  return byWallet;
}

/**
 * Phase B: fold the (fully-folded) per-wallet rows into per-operator groups
 * and rank. Pure function of `byWallet` — everything transfer-shaped has
 * already been absorbed into it by `foldTransfers`, so this only ever touches
 * O(sellers) rows regardless of how many transfers were scanned. Group key =
 * canonical host when we can derive one; otherwise the wallet itself (so
 * listings without a homepage stay as standalone rows rather than collapsing
 * into a single "no-website" mega-group).
 */
/**
 * Payer concentration for one seller row.
 *
 * Why this exists: on 2026-09-13 a trace of the #1 seller by settled volume
 * found ONE wallet accounting for 99.5% of its settlements and 99.0% of its
 * dollars over 30 days - the rest of the board was 386 payers doing $727 a
 * month. Re-running the read across the top 22 Base sellers, NINE of them draw
 * over 85% of their settlements from a single wallet. A row showing
 * `callsSettled 14525, uniqueBuyers 7` reads as a business; the same row
 * showing `topPayerCallsShare 0.90` reads as one integration, which is what it
 * is. Publishing counts without this is the registry inflation /transparency
 * criticises other people for.
 *
 * WHAT IS PUBLISHED: shares and residuals only, NEVER the payer address. A
 * per-seller roster of who pays them is their customer list, the same rule
 * /revenue applies to our own buyers. Shares are fractions of THIS window.
 *
 * THE REFERENCE WALLET IS ONE WALLET - the busiest by settlement count (ties
 * on dollars, then address, so it is deterministic). Both of its shares and
 * the residual after removing it describe that same wallet, so a consumer
 * never has to wonder whether two figures are about two different payers.
 * `topPayerIsAlsoTopUsd` says whether some OTHER payer carries more dollars;
 * when it is false, dollars are concentrated somewhere the call share cannot
 * see and the usd share here understates it.
 *
 * A row with no settled calls gets nulls and no flag: an empty window is not a
 * concentrated one, and a flag invented from no data is worse than no flag.
 */
export function payerConcentration(perPayer, callsSettled, totalUsd) {
  const empty = {
    topPayerCallsShare: null,
    topPayerUsdShare: null,
    topPayerIsAlsoTopUsd: null,
    withoutTopPayer: null,
    concentration: null,
  };
  if (!perPayer || perPayer.size === 0 || !(callsSettled > 0)) return empty;

  let top = null, topAddr = null, topUsdAddr = null, maxUsd = -1;
  for (const [addr, v] of perPayer) {
    if (
      !top ||
      v.calls > top.calls ||
      (v.calls === top.calls && v.usd > top.usd) ||
      (v.calls === top.calls && v.usd === top.usd && addr < topAddr)
    ) { top = v; topAddr = addr; }
    if (v.usd > maxUsd) { maxUsd = v.usd; topUsdAddr = addr; }
  }

  const callsShare = top.calls / callsSettled;
  const usdShare = totalUsd > 0 ? top.usd / totalUsd : 0;
  // Thresholds are published in the envelope legend so the flag can be
  // recomputed by anyone reading the two shares. Either axis can trip it:
  // the seller that started this is 41% of calls and 95% of dollars, so a
  // call-count-only rule would have called it unremarkable.
  const worst = Math.max(callsShare, usdShare);
  const concentration =
    worst >= CONCENTRATION.supermajority ? "single-payer-supermajority"
    : worst >= CONCENTRATION.majority ? "single-payer-majority"
    : null;

  return {
    topPayerCallsShare: Number(callsShare.toFixed(4)),
    topPayerUsdShare: Number(usdShare.toFixed(4)),
    topPayerIsAlsoTopUsd: topUsdAddr === topAddr,
    withoutTopPayer: {
      callsSettled: callsSettled - top.calls,
      totalUsd: Number(Math.max(0, totalUsd - top.usd).toFixed(6)),
      uniqueBuyers: perPayer.size - 1,
    },
    concentration,
  };
}

/**
 * Cross-seller payer breadth for one row.
 *
 * The companion to payerConcentration, and it answers the opposite failure
 * mode. Concentration catches a seller whose volume is one wallet. THIS
 * catches a seller whose buyer COUNT is inflated by wallets that pay everyone
 * - evaluators, indexers and scanners walking the ecosystem. Both read as
 * healthy in `uniqueBuyers`, which is the only buyer signal we published
 * before today.
 *
 * Measured on the top 22 Base sellers (7d, 2026-09-13): 110 of 2,632 distinct
 * payers settled with more than one of them; the widest paid 14. One wallet
 * appeared as the TOP payer of two different sellers while also ranking second
 * at a third.
 *
 * `sellersPerPayer` is the global payer -> distinct-seller-count map for the
 * whole scan, so this is only meaningful for sellers inside the same scan: a
 * payer's breadth is measured against the sellers WE index, never the whole
 * chain, and the legend says so. Addresses are never published here either.
 */
export function payerBreadth(perPayer, callsSettled, sellersPerPayer) {
  const empty = { multiSellerPayers: null, multiSellerCallsShare: null, maxPayerSellerSpan: null };
  if (!perPayer || perPayer.size === 0 || !(callsSettled > 0) || !sellersPerPayer) return empty;
  let broadPayers = 0, broadCalls = 0, maxSpan = 0;
  for (const [addr, v] of perPayer) {
    const span = sellersPerPayer.get(addr) || 1;
    if (span > maxSpan) maxSpan = span;
    if (span >= PAYER_BREADTH.multiSellerMin) { broadPayers += 1; broadCalls += v.calls; }
  }
  return {
    multiSellerPayers: broadPayers,
    multiSellerCallsShare: Number((broadCalls / callsSettled).toFixed(4)),
    maxPayerSellerSpan: maxSpan,
  };
}

export function finalizeLeaderboard(byWallet, { maxCallUsd = DEFAULTS.maxCallUsd } = {}) {
  const groups = new Map();
  for (const w of byWallet.values()) {
    const key = groupKeyOf(w);
    if (!groups.has(key)) {
      groups.set(key, {
        name: w.name,
        origins: new Set(w.origins || []),
        homepage: w.homepage,
        endpointsSum: 0,
        network: w.network,
        callsSettled: 0,
        totalUsd: 0,
        perPayer: new Map(),
        members: [], // [{ wallet, name, callsSettled, totalUsd, endpoints }]
      });
    }
    const g = groups.get(key);
    g.callsSettled += w.callsSettled;
    g.totalUsd += w.totalUsd;
    // Visible rather than silent: how much of this row the flat ceiling alone
    // would have dropped, and how much it is still dropping.
    g.abovePriceMatched = (g.abovePriceMatched || 0) + (w.abovePriceMatched || 0);
    g.overCeilingSkipped = (g.overCeilingSkipped || 0) + (w.overCeilingSkipped || 0);
    for (const [payer, v] of w.perPayer) {
      const p = g.perPayer.get(payer) || { calls: 0, usd: 0 };
      p.calls += v.calls;
      p.usd += v.usd;
      g.perPayer.set(payer, p);
    }
    g.endpointsSum += (w.endpoints || 0);
    (w.origins || []).forEach((o) => g.origins.add(o));
    g.members.push({
      wallet: w.wallet,
      name: w.name,
      callsSettled: w.callsSettled,
      totalUsd: w.totalUsd,
      endpoints: w.endpoints || 0,
    });
  }

  // How many DISTINCT sellers each payer settled with in this scan. Built from
  // the finished groups (so a seller running several wallets counts once) and
  // handed to every row, which is why it can only be computed here rather than
  // inside a per-row helper.
  const sellersPerPayer = new Map();
  for (const g of groups.values()) {
    for (const payer of g.perPayer.keys()) {
      sellersPerPayer.set(payer, (sellersPerPayer.get(payer) || 0) + 1);
    }
  }

  const ranked = [...groups.values()]
    .map((g) => {
      // Sort wallets within a group: highest-volume first, then most-active,
      // then deterministic by address. The first wallet becomes the row's
      // "primary" — the one shown by default in the wallet column.
      g.members.sort((a, b) =>
        b.totalUsd - a.totalUsd ||
        b.callsSettled - a.callsSettled ||
        a.wallet.localeCompare(b.wallet)
      );
      const primary = g.members[0];
      // Display name: prefer the most-volume wallet's name, but if it's empty
      // fall back to any non-empty name in the group.
      const name = primary?.name || g.members.find((m) => m.name)?.name || g.name;
      return {
        name,
        origins: [...g.origins],
        homepage: g.homepage,
        endpoints: g.endpointsSum || null,
        wallet: primary?.wallet || null,
        wallets: g.members.map((m) => m.wallet),
        walletCount: g.members.length,
        network: g.network,
        callsSettled: g.callsSettled,
        totalUsd: Number(g.totalUsd.toFixed(6)),
        uniqueBuyers: g.perPayer.size,
        // Published so a reader can see the rule working rather than take it on
        // trust: settlements counted ONLY because they matched a price this
        // seller advertises, and settlements still dropped for matching none.
        settlementsAbovePerCallCeiling: g.abovePriceMatched || 0,
        transfersSkippedOverCeiling: g.overCeilingSkipped || 0,
        ...payerConcentration(g.perPayer, g.callsSettled, g.totalUsd),
        ...payerBreadth(g.perPayer, g.callsSettled, sellersPerPayer),
      };
    })
    .sort((a, b) => {
      if (b.totalUsd !== a.totalUsd) return b.totalUsd - a.totalUsd;
      if (b.callsSettled !== a.callsSettled) return b.callsSettled - a.callsSettled;
      return (a.name || "").localeCompare(b.name || "");
    })
    .map((r, i) => ({ rank: i + 1, ...r }));
  // PER-WALLET EVIDENCE for the router (2026-09-28). A row above is an
  // OPERATOR group, so its totals add up every wallet in it. The router's gate
  // asks whether the ONE wallet a seller's live 402 names clears the floor on
  // that wallet's own history (src/evidence-binding.js), which the group totals
  // cannot answer. Kept beside the ranked rows, never on them: it is router
  // input, not a public column, and getLeaderboardSnapshot() strips it from
  // every served snapshot. Non-enumerable, so a caller that serializes the
  // ranked array directly cannot leak it either.
  //
  // Net of SELLER-FUNDED payments when the scan read the seller's outbound
  // transfers (applySellerFunding): callsSettled / uniqueBuyers are what the
  // router may credit, the gross figures and the self-funded share ride beside
  // them. The public row above stays gross.
  const walletEvidence = {};
  for (const w of byWallet.values()) {
    const k = typeof w.wallet === "string" ? w.wallet.toLowerCase() : null;
    if (!k) continue;
    const grossCalls = w.callsSettled || 0, grossBuyers = w.perPayer ? w.perPayer.size : 0;
    const f = w.funding;
    walletEvidence[k] = f
      ? {
          callsSettled: f.netCalls, uniqueBuyers: f.netPayers,
          grossCallsSettled: grossCalls, grossUniqueBuyers: grossBuyers,
          selfFundedCalls: f.fundedCalls, selfFundedPayers: f.fundedPayers, selfFundedUsd: Number(f.fundedUsd.toFixed(6)), grossUsd: Number(f.grossUsd.toFixed(6)),
          // The same over the Bazaar's 30 days: what third-party counts of
          // this wallet are reduced by (src/evidence-binding.js).
          selfFundedCalls30d: f.fundedCalls30d, selfFundedPayers30d: f.fundedPayers30d,
          // Payments the seller refunded: removed from the evidence, and from
          // third-party counts of the same wallet (src/evidence-binding.js).
          refundedCalls: f.refundedCalls || 0, refundedCalls30d: f.refundedCalls30d || 0, refundedUsd: Number((f.refundedUsd || 0).toFixed(6)),
          // Payers EVERY one of whose payments in the window was refunded: not
          // buyers, so third-party payer counts of this wallet lose them too.
          refundedPayers: f.refundedPayers || 0,
          circular: f.circular, lastCircularAt: f.lastCircularAt, fundingRead: f.read,
          ...(f.withheldUntilRead ? { fundingPending: true } : {}),
          ...(f.truncated ? { fundingTruncated: true } : {}),
          origins: [...(w.origins || [])],
        }
      : { callsSettled: grossCalls, uniqueBuyers: grossBuyers, origins: [...(w.origins || [])] };
  }
  Object.defineProperty(ranked, "walletEvidence", { value: walletEvidence, enumerable: false, configurable: true });
  return ranked;
}

/** The tail of the funding read's log line: why wallets were not read.
 *  Counts and reasons only, never a wallet. */
export function fundingReadNotes(f) {
  if (!f) return "";
  const parts = [];
  if (f.historyWalletsOverShare) parts.push(`${f.historyWalletsOverShare} over their share of the reads`);
  if (f.historyWalletsGaveUp) parts.push(`${f.historyWalletsGaveUp} refused at the narrowest range`);
  if (f.historyWalletsWaiting) parts.push(`${f.historyWalletsWaiting} waiting to retry`);
  if (f.historyWalletsTooLarge) parts.push(`${f.historyWalletsTooLarge} too large to read in a scan (FUNDING_HISTORY_CHUNK_BLOCKS, or widths they learned)`);
  if (f.historyWalletsTooDense) parts.push(`${f.historyWalletsTooDense} too dense to hold between scans`);
  if (f.historyReadsResumed) parts.push(`${f.historyReadsResumed} read(s) resumed`);
  if (f.historyWalletsDayHeld) parts.push(`${f.historyWalletsDayHeld} held for the day's retries`);
  if (f.dayCapReached) parts.push(`the day's retries are spent (LEADERBOARD_FUNDING_DAY_MAX_CALLS)`);
  if (f.readStopped) parts.push(`stopped: ${f.readStopped}${f.readStopped === "range-limited" ? (f.rangeLimitFits ? " (this RPC limits eth_getLogs ranges: set FUNDING_HISTORY_CHUNK_BLOCKS under its limit, or turn the reader off)" : " (this RPC limits eth_getLogs ranges too narrowly to read a history in a scan: use a primary RPC without that limit, or turn the reader off)") : ""}`);
  return parts.length ? `; ${parts.join(", ")}` : "";
}

// --- seller-funded payers (2026-09-28) --------------------------------------
//
// The rule, the incremental read and the persisted pools live in
// src/seller-funding.js; this is where the scan applies them. A wallet row gets
// `funding` = the netted figures the router may credit, the gross beside them,
// and the verdict. Only the paid wallet's OWN outbound transfers count.
export { FUNDING_DEFAULTS, posOf, circularWalletsFrom, readSellerFunding, readPayerHistory, readFundingGaps, processSellerFunding, sellerFundingFigures, createFundingState, serializeFundingState, parseFundingState, historyFromBlockFor, isScannableWallet } from "./seller-funding.js";

/**
 * Attach `funding` to every scanned row that has funding state (or a verdict
 * carried from an earlier scan). `previous` is the last snapshot's
 * walletEvidence, a fallback for the carried verdict when the state has none.
 * Mutates each row; returns byWallet.
 */
export function applySellerFunding(byWallet, state, { latest, now = Date.now(), previous = null, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, bazaarWindowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks } = {}) {
  for (const w of byWallet.values()) {
    const k = String(w.wallet).toLowerCase();
    const ws = state?.wallets?.get?.(k) || null;
    const carried = [ws?.lastCircularAt, previous && typeof previous === "object" ? previous[k]?.lastCircularAt : null].filter((x) => typeof x === "string").sort().pop() || null;
    if (!ws && !carried) continue;
    w.funding = sellerFundingFigures(w, ws, { latest, now, carriedAt: carried, circularWindowMs, bazaarWindowBlocks: bazaarWindowBlocks ?? FUNDING_DEFAULTS.bazaarWindowBlocks });
    if (ws) ws.lastCircularAt = w.funding.lastCircularAt;
  }
  return byWallet;
}

// --- network helpers --------------------------------------------------------

async function fetchJson(url, { timeoutMs = 30000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const r = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "agent402-x402-leaderboard/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > maxBytes) throw new Error(`response too large: ${text.length} bytes`);
  return JSON.parse(text);
}

// Fetch every page of the Bazaar discovery endpoint. The pagination loop lives
// in src/bazaar-pager.js so src/x402-index.js can reuse it; here we just inject
// the timeout + byte-capped fetcher.
async function fetchAllBazaarItems(baseUrl, opts) {
  return walkBazaar(baseUrl, { pageSize: opts.bazaarPageSize, maxPages: opts.bazaarMaxPages }, fetchJson);
}

// Exported for scripts/test-leaderboard-redaction.js (the messages this
// throws reach the public /api/leaderboard as cache.lastError).
export async function rpcCall(rpcs, method, params, { passes = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < passes; attempt++) {
    for (const url of rpcs) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(25000),
        });
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); }
        // Name the RPC by HOST only, never the URL: the Alchemy entry above
        // carries ALCHEMY_API_KEY in its path, and this message flows into
        // cached.lastError -> getLeaderboardSnapshot() -> the PUBLIC
        // /api/leaderboard body (and stderr via onProgress). Same rule
        // revenue-live.js's laneName() and b20-kit/x402-kit's redactSecrets()
        // already apply — this file was the instance the fix never reached
        // (leak audit 2026-08-18).
        catch { lastErr = new Error(`${rpcHost(url)}: non-JSON (${r.status})`); continue; }
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${rpcHost(url)}: ${redactSecrets(JSON.stringify(j.error ?? j)).slice(0, 160)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (attempt < passes - 1) await sleep(1500 * (attempt + 1));
  }
  // Belt and braces: a thrown fetch error (DNS, TLS, abort) can carry the
  // URL in its own message — scrub configured secret values regardless.
  throw new Error(`All RPCs failed for ${method}: ${redactSecrets(String(lastErr?.message || lastErr))}`);
}
function rpcHost(url) {
  try { return new URL(url).host; } catch { return "rpc"; }
}

// --- pipeline ---------------------------------------------------------------

/** Render a window length in seconds as a label ("5h", "24h", "7d"). */
export function windowLabelFromSeconds(secs) {
  const seconds = Number(secs) || 0;
  if (seconds <= 0) return "-";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Re-rank an already-aggregated leaderboard by a chosen metric. `sort="usd"`
 * (default) matches the pipeline's canonical order — total USDC settled, with
 * activity as tiebreak. `sort="calls"` ranks by raw call volume — useful when
 * an agent is shopping for the *most-used* tools regardless of price, e.g.
 * "which seller is everyone hitting?" vs. "who's earning the most?".
 *
 * Pure: takes the snapshot board, returns a new array with rank re-numbered.
 * The summary stats (total volume, total calls) computed by callers don't
 * change — only the row order and `rank` field.
 */
export function rankBy(board, sort = "usd") {
  const list = Array.isArray(board) ? [...board] : [];
  const mode = sort === "calls" ? "calls" : "usd";
  list.sort((a, b) => {
    const calls = (b.callsSettled || 0) - (a.callsSettled || 0);
    const usd = (b.totalUsd || 0) - (a.totalUsd || 0);
    const primary = mode === "calls" ? calls : usd;
    if (primary) return primary;
    const secondary = mode === "calls" ? usd : calls;
    if (secondary) return secondary;
    return (a.name || "").localeCompare(b.name || "");
  });
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

const emptySnapshot = (opts, reason) => ({
  spec: "x402-leaderboard/1",
  asOf: new Date().toISOString(),
  scannedBlocks: 0,
  windowSeconds: opts.windowSeconds,
  windowLabel: windowLabelFromSeconds(opts.windowSeconds),
  maxCallUsd: opts.maxCallUsd,
  priceMatchMaxUsd: opts.priceMatchMaxUsd,
  scannedSellers: 0,
  walletsQueried: 0,
  leaderboard: [],
  scanSkipped: true,
  reason,
});

/**
 * The block range a scan covers. The window is `opts.windowSeconds` of chain
 * time ending at the head; its first block is the first whose timestamp is
 * inside it, read from the chain (src/block-clock.js), so the range is right
 * whatever the chain's block time is and across a change to it. A caller
 * that pins `opts.spanBlocks` gets exactly that many blocks. When no header
 * can be read the head still comes from eth_blockNumber and the start is
 * estimated (`source` says which), so a flaky RPC narrows nothing silently.
 */
export async function resolveScanWindow(clock, opts, blockNumber) {
  let head = null;
  try { head = await clock.latest(); } catch { /* estimated below */ }
  const latest = head ? head.number : parseInt(await blockNumber(), 16);
  if (Number.isFinite(opts.spanBlocks) && opts.spanBlocks > 0) {
    return { latest, start: Math.max(0, latest - opts.spanBlocks), spanBlocks: opts.spanBlocks, windowSeconds: opts.spanBlocks * LEGACY_SECONDS_PER_BLOCK, source: "pinned" };
  }
  const windowSeconds = Number(opts.windowSeconds) > 0 ? Number(opts.windowSeconds) : 86_400;
  const nowSec = head ? head.timestamp : Math.floor((opts.now ?? Date.now()) / 1000);
  const at = await clock.blockAtOrAfter(nowSec - windowSeconds, { headNumber: latest });
  const start = Math.min(latest, at.block);
  return { latest, start, spanBlocks: latest - start, windowSeconds, source: at.source, headTimestamp: head ? head.timestamp : null };
}

/**
 * Block counts for the seller-funding state's time-based windows (the
 * Bazaar's 30 days, the 30-day credit and 45-day known-payer TTLs), read from
 * the chain the same way. The FUNDING_DEFAULTS constants are those windows at
 * 2 s blocks; a count that could not be read from the chain is never allowed
 * below them, because a narrower TTL prunes state that is still needed.
 */
export async function fundingWindowBlocks(clock, latest, nowSec) {
  const d = 86_400;
  const blocksBack = async (secs, floor) => {
    try {
      const at = await clock.blockAtOrAfter(nowSec - secs, { headNumber: latest });
      const n = latest - at.block;
      return at.source === "chain" ? n : Math.max(floor, n);
    } catch { return floor; }
  };
  const month = await blocksBack(30 * d, FUNDING_DEFAULTS.bazaarWindowBlocks);
  return {
    bazaarWindowBlocks: month,
    creditTtlBlocks: month,
    knownTtlBlocks: await blocksBack(45 * d, FUNDING_DEFAULTS.knownTtlBlocks),
  };
}

/**
 * Run the full pipeline once and return a snapshot. Pure data in / data out;
 * no globals touched. `onProgress` (optional) gets called with stage messages so
 * the CLI can stream them to stderr. Caller is responsible for catching: this
 * throws on RPC/Bazaar errors so callers can choose how to react. The server
 * wraps this in a try/catch and serves the last good snapshot on failure.
 */
export async function runLeaderboard(overrides = {}) {
  // Which rail are we ranking? Defaults to Base, so every existing caller and
  // the persisted snapshot shape are untouched. An unknown key is refused
  // rather than silently falling back to Base with the wrong token.
  const chain = chainScanConfig(overrides.chain || "base");
  if (!chain) throw new Error(`leaderboard: no scan config for chain "${overrides.chain}"`);
  const opts = {
    ...DEFAULTS,
    // The rail's own RPC list wins unless the caller is explicit. The window
    // is TIME, the same on every chain; its first block is found by
    // timestamp below. A caller may still pin `spanBlocks` (tests, one-off
    // scripts), which is then taken as given.
    rpcs: overrides.rpcs ?? chain.rpcs,
    ...overrides,
  };
  opts.chain = chain;
  const onProgress = overrides.onProgress || (() => {});

  // 1. Bazaar discovery (paginated) → per-item payTo for Base-mainnet USDC.
  onProgress(`[1/3] Fetching Bazaar discovery (${opts.bazaarUrl})…`);
  const { items, total } = await fetchAllBazaarItems(opts.bazaarUrl, opts);
  let sellers = extractWalletsFromBazaar({ items }, chain);
  onProgress(`      ${items.length}/${total ?? "?"} listings → ${sellers.length} unique ${chain.label}-mainnet wallets`);
  // Our own crawl's payTo wallets, folded in so a self-registered seller can
  // accumulate settlement evidence without joining someone else's registry.
  if (typeof opts.crawledWallets === "function") {
    try {
      const { merged, added } = mergeCrawledWallets(sellers, opts.crawledWallets(chain), chain, typeof opts.crawledPrices === "function" ? opts.crawledPrices(chain) : null);
      sellers = merged;
      if (added) onProgress(`      +${added} wallet(s) from our own crawl (not in the Bazaar) → ${sellers.length} total`);
    } catch (e) {
      onProgress(`      crawled-wallet seed skipped: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  // The zero address and the token contract are not anybody's wallet: a
  // listing naming either as its payTo would have burns (or transfers to the
  // contract) counted as sales, and would make every mint a "funding" source.
  const nonWallets = sellers.filter((s) => !isScannableWallet(s.wallet, chain.token)).length;
  if (nonWallets) {
    sellers = sellers.filter((s) => isScannableWallet(s.wallet, chain.token));
    onProgress(`      dropped ${nonWallets} listed payTo(s) that are not wallets (the zero address or the token contract)`);
  }
  if (!sellers.length) return emptySnapshot(opts, "no Base-mainnet payTo wallets found in Bazaar");

  // Optional cap: keep the on-chain scan tight by ranking by listing count first.
  // A capped scan is a SAMPLE, and the snapshot has to say so: `scannedSellers`
  // alone reads as "every seller we know", and a seller outside the cut would
  // be reported with zero settlements rather than as unmeasured - the reading
  // that turns a partial answer into a false negative.
  let walletCap = null;
  if (opts.maxWalletsScan > 0 && sellers.length > opts.maxWalletsScan) {
    walletCap = { limit: opts.maxWalletsScan, eligible: sellers.length, rankedBy: "listing count" };
    sellers = sellers.slice().sort((a, b) => b.endpoints - a.endpoints).slice(0, opts.maxWalletsScan);
    onProgress(`      capping scan to top ${opts.maxWalletsScan} wallets by listing count`);
  }

  // 2. Query USDC transfers — chunk both the block range AND the wallet array,
  //    since free-tier RPCs limit each.
  const wallets = [...new Set(sellers.map((s) => s.wallet))];
  const clock = createBlockClock(opts.getHeader || rpcHeaderReader((m, p) => rpcCall(opts.rpcs, m, p, { passes: 1 })), { fallbackMsPerBlock: 2000, maxCalls: 80 });
  const win = await resolveScanWindow(clock, opts, () => rpcCall(opts.rpcs, "eth_blockNumber", []));
  const latest = win.latest;
  onProgress(`[2/3] Scanning ${chain.label} USDC transfers (${win.spanBlocks} blocks, ${windowLabelFromSeconds(win.windowSeconds)}${win.source === "chain" ? "" : `, start by ${win.source}`}, ${wallets.length} wallets)…`);
  const padded = wallets.map(pad);
  const walletChunks = [];
  for (let i = 0; i < padded.length; i += opts.walletChunk) walletChunks.push(padded.slice(i, i + opts.walletChunk));
  const start = win.start;
  const blockChunks = [];
  for (let from = start; from <= latest; from += opts.chunkBlocks) {
    blockChunks.push([from, Math.min(from + opts.chunkBlocks - 1, latest)]);
  }
  const callCount = walletChunks.length * blockChunks.length;
  onProgress(`      ${blockChunks.length} block chunk(s) × ${walletChunks.length} wallet chunk(s) = ${callCount} eth_getLogs call(s)`);
  // A wide (7d) window means many more chunks than the old 24h scan — any
  // single chunk's rpcCall throwing (after exhausting every RPC + retry pass)
  // must NOT take down the whole refresh, or a wide scan becomes strictly
  // less reliable than the old narrow one. Catch per-chunk and keep going;
  // only abort (throw) if EVERY chunk failed, which really is a total RPC
  // outage — in that case the caller (refreshOnce) keeps serving the last
  // good snapshot, same as before this change.
  //
  // Memory: fold each chunk's decoded transfers into the accumulator right
  // away and let the chunk's logs go out of scope — never collect every log
  // across the whole window into one array. A 7d scan over ~1500 wallets is
  // hundreds of thousands of raw log objects; holding them all at once (the
  // old `logs.push` here + a final `logs.map`) is what OOM-crash-looped prod.
  const byWallet = initWalletAccumulator(sellers);
  let transferCount = 0;
  let failedChunks = 0;
  // The first block a failed chunk left unread, per wallet chunk: the
  // seller-funding pass never works a wallet's pools past it.
  const failedFromByChunk = new Map();
  for (const [from, to] of blockChunks) {
    for (const [chunkIdx, chunk] of walletChunks.entries()) {
      try {
        const part = await rpcCall(opts.rpcs, "eth_getLogs", [{
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          address: chain.token,
          topics: [TRANSFER, null, chunk],
        }]);
        if (Array.isArray(part) && part.length) {
          const chunkTransfers = part.map((l) => ({
            wallet: ("0x" + l.topics[2].slice(-40)).toLowerCase(),
            payer: payerFromLog(l),
            usd: Number(BigInt(l.data)) / 1e6,
            pos: posOf(parseInt(l.blockNumber, 16), parseInt(l.logIndex, 16)),
          }));
          foldTransfers(byWallet, chunkTransfers, opts.maxCallUsd, OUR_EVM_WALLETS, opts.priceMatchMaxUsd);
          transferCount += chunkTransfers.length;
        }
      } catch (e) {
        failedChunks += 1;
        failedFromByChunk.set(chunkIdx, Math.min(failedFromByChunk.get(chunkIdx) ?? Infinity, from));
        onProgress(`      chunk failed (blocks ${from}-${to}): ${redactSecrets(String(e?.message || e))}`);
      }
    }
  }
  if (callCount > 0 && failedChunks === callCount) {
    throw new Error(`All ${callCount} eth_getLogs chunk(s) failed - RPC outage, aborting scan`);
  }
  const partial = failedChunks > 0;
  onProgress(`      ${transferCount} transfer log(s) total${partial ? ` (partial: ${failedChunks} of ${callCount} ranges unavailable)` : ""}`);

  // 2b. Seller-funded payers (src/seller-funding.js): read the outbound
  // transfers each paid wallet sent its known payers since its cursor, the
  // whole history of every payer seen for the first time, and the gap before
  // the window of a wallet that fell behind; then work each (wallet, payer)
  // pool through the payments in chain order. Router input only; the public
  // rows stay gross. Base only by default (the router's chain).
  let fundingScan = null;
  let fundingStateUsed = null;
  let fundingWindows = null;
  const fundingOn = (opts.fundingScan ?? chain.key === "base") && sellerFundingEnabled();
  if (fundingOn) {
    const nowMs = opts.now ?? Date.now();
    const state = opts.fundingState || createFundingState(chain.token);
    const walletIndex = new Map(wallets.map((w, i) => [String(w).toLowerCase(), i]));
    const throughFor = (w) => {
      const failedFrom = failedFromByChunk.get(Math.floor((walletIndex.get(w) ?? -1) / opts.walletChunk));
      return failedFrom === undefined ? Infinity : endOfBlock(failedFrom - 1);
    };
    try {
      const floor = { minSettled: 50, minPayers: 3, ...(opts.fundingFloor || {}) };
      const skip = typeof opts.fundingSkip === "function" ? opts.fundingSkip : () => false;
      const clears = (w) => ((w.callsSettled || 0) >= floor.minSettled && w.perPayer.size >= floor.minPayers ? 1 : 0);
      // Wallets that clear the router's floor on gross figures first (only
      // they can change a routing decision on their own), then the busiest.
      const paid = [...byWallet.values()]
        .filter((w) => w.perPayer && w.perPayer.size && !skip(String(w.wallet).toLowerCase()))
        .sort((a, b) => clears(b) - clears(a) || (b.callsSettled || 0) - (a.callsSettled || 0));
      const paidList = paid.map((w) => ({ wallet: w.wallet, payers: new Set([...w.perPayer.keys()].map((p) => String(p).toLowerCase())) }));
      const primary = Array.isArray(opts.rpcs) && opts.rpcs.length ? [opts.rpcs[0]] : opts.rpcs;
      // The primary RPC only, one attempt: a refusal is answered by splitting
      // the job, not by walking every public fallback.
      const fundingRpc = opts.fundingRpc || ((method, params) => rpcCall(primary, method, params, { passes: 1 }));
      const maxCalls = Number.isFinite(opts.fundingMaxCalls) ? opts.fundingMaxCalls : FUNDING_DEFAULTS.maxCalls;
      // One control for the whole scan: its timeouts, its stop, and each
      // wallet's share of the history and gap reads (src/seller-funding.js).
      const ctl = newFundingReadControl();
      const held = Number.isFinite(opts.fundingMaxPartialLogsPerWallet) ? { maxPartialLogsPerWallet: opts.fundingMaxPartialLogsPerWallet } : {};
      const share = { ctl, scanMaxCalls: maxCalls, now: nowMs, ...held, ...(Number.isFinite(opts.fundingWalletMaxCalls) ? { walletMaxCalls: opts.fundingWalletMaxCalls } : {}), ...(Number.isFinite(opts.fundingDayMaxCalls) ? { dayMaxCalls: opts.fundingDayMaxCalls } : {}) };
      const facts = await readSellerFunding({
        rpc: fundingRpc,
        token: chain.token, state,
        wallets: paidList,
        latest,
        windowStartBlock: start,
        walletChunk: opts.walletChunk,
        maxCalls,
        ignore: new Set([...(OUR_EVM_WALLETS || [])].map((w) => String(w).toLowerCase())),
        now: nowMs,
        ctl,
        onProgress,
      });
      // The whole history of every payer a wallet has not seen before (and
      // the credit of a known payer about to be funded for the first time),
      // from what is left of the budget.
      const history = await readPayerHistory({ rpc: fundingRpc, token: chain.token, state, wallets: paidList, windowStartBlock: start, historyFromBlock: Number.isFinite(opts.fundingHistoryFromBlock) ? opts.fundingHistoryFromBlock : historyFromBlockFor(chain.token), walletChunk: opts.walletChunk, maxCalls: Math.max(0, maxCalls - facts.calls), ...share, onProgress });
      // Once per wallet whose pools start before the window: what its funded
      // payers paid it in between (see readFundingGaps), within what is left
      // of the budget.
      const gapRead = await readFundingGaps({ rpc: fundingRpc, token: chain.token, state, wallets: paid.map((w) => w.wallet), windowStartBlock: start, maxCalls: Math.max(0, maxCalls - facts.calls - history.stats.calls), ...share, onProgress });
      // The same rule the fold applies: a transfer the board would count is a
      // payment, anything larger is not a tool call.
      const classify = (wallet, micro) => {
        const row = byWallet.get(wallet);
        const usd = micro / 1e6;
        return (priceMatches(micro, row?.prices) && usd <= opts.priceMatchMaxUsd) || usd <= opts.maxCallUsd ? 1 : 2;
      };
      processSellerFunding(state, byWallet, { throughFor, windowStartBlock: start, gaps: gapRead.gaps, histories: history.histories, classify });
      const pruned = {};
      fundingWindows = await fundingWindowBlocks(clock, latest, win.headTimestamp ?? Math.floor(nowMs / 1000));
      pruneFundingState(state, { now: nowMs, latest, counts: pruned, ...held, ...fundingWindows });
      const h = history.stats;
      const g = gapRead.stats;
      fundingScan = {
        calls: facts.calls + h.calls + gapRead.stats.calls, refusals: facts.refusals + h.refusals + (gapRead.stats.refusals || 0), wallets: facts.wallets,
        historyCalls: h.calls, historyWallets: h.wallets, historyWalletsRead: h.read, historyWalletsFailed: h.failed, historyPayers: h.payers, historyPayersFunded: h.funded, creditReads: h.creditReads,
        // Counts only: wallets whose reads went past their share, were refused
        // over the narrowest range, need more calls than a scan has (or lost
        // their progress to its cap), or are waiting after one of those.
        historyWalletsOverShare: h.overShare + (g.overShare || 0), historyWalletsGaveUp: h.gaveUp + (g.gaveUp || 0), historyWalletsTooLarge: h.tooLarge + (g.tooLarge || 0) + (pruned.progressDropped || 0), historyWalletsTooDense: h.tooDense + (g.tooDense || 0), historyWalletsWaiting: h.waiting + (g.waiting || 0),
        // Reads that resumed an earlier scan's progress; retries (calls past
        // a wallet's plan, or picking up a read refused at every width last
        // time) this scan and in the rolling day; wallets the day's allowance
        // for them held back, and whether it held any.
        historyReadsResumed: h.resumed + (g.resumed || 0),
        historyRetryCalls: h.retries + (g.retries || 0), historyRetryCallsDay: fundingDayCalls(state, nowMs), historyWalletsDayHeld: h.dayHeld + (g.dayHeld || 0), ...(h.dayCapReached || g.dayCapReached ? { dayCapReached: true } : {}),
        ...(ctl.stop ? { readStopped: ctl.stop } : {}), ...(ctl.stop === "range-limited" ? { rangeLimitFits: !!h.rangeLimitFits } : {}),
        walletsReadTargeted: facts.targeted,
        gapWallets: gapRead.stats.wallets, gapWalletsRead: gapRead.stats.read, gapCalls: gapRead.stats.calls,
        walletsCaughtUp: facts.caughtUp, walletsBehind: facts.behind, walletsStuck: facts.stuck, walletsTruncated: facts.truncated, walletsNew: facts.fresh,
        fundingEvents: facts.events + h.events, budgetExhausted: facts.budgetExhausted || h.budgetExhausted || gapRead.stats.budgetExhausted,
        ...(facts.transportError || h.transportError || gapRead.stats.transportError ? { transportError: redactSecrets(facts.transportError || h.transportError || gapRead.stats.transportError) } : {}),
        partial: facts.behind > 0 || !!facts.transportError || h.failed > 0 || h.waiting > 0 || !!h.transportError || gapRead.stats.failed > 0 || gapRead.stats.waiting > 0 || facts.budgetExhausted || h.budgetExhausted || gapRead.stats.budgetExhausted || !!ctl.stop,
        stateWallets: state.wallets.size, statePairs: fundingPairCount(state), stateKnownPayers: fundingKnownCount(state),
      };
      onProgress(`      funding read: ${fundingScan.calls} eth_getLogs call(s) over ${facts.wallets} wallet(s) (${h.calls} for ${h.payers} new payer(s)), ${facts.caughtUp} caught up${facts.behind ? `, ${facts.behind} behind` : ""}${h.failed ? `, ${h.failed} with history pending` : ""}${fundingReadNotes(fundingScan)}`);
    } catch (e) {
      fundingScan = { error: redactSecrets(String(e?.message || e)).slice(0, 160), partial: true };
      onProgress(`      funding read failed: ${fundingScan.error}`);
    }
    // Always applied, from whatever the state knows: a wallet not read this
    // scan is "behind", and a circular one behind is credited nothing.
    applySellerFunding(byWallet, state, { latest, now: nowMs, previous: opts.previousWalletEvidence || null, bazaarWindowBlocks: fundingWindows?.bazaarWindowBlocks });
    fundingStateUsed = state;
  }

  // 3. Aggregate. byWallet has already absorbed every successfully-scanned
  // chunk's transfers — finalize only does the bounded (O(sellers)) grouping
  // + ranking pass, no transfer-sized array involved.
  onProgress(`[3/3] Aggregating leaderboard…`);
  const ranked = finalizeLeaderboard(byWallet, { maxCallUsd: opts.maxCallUsd });
  // A wallet found circular within the window keeps that verdict while the
  // Bazaar's 30 days still count its self-payments, even when this scan did
  // not see it at all (no longer listed, or no payments this window).
  const walletEvidenceOut = { ...(ranked.walletEvidence || {}) };
  const carryAt = new Map();
  if (fundingOn) for (const k of circularWalletsFrom(opts.previousWalletEvidence || null, { now: opts.now ?? Date.now() })) carryAt.set(k, opts.previousWalletEvidence[k]);
  for (const [k, ws] of fundingStateUsed?.wallets || []) {
    if (typeof ws.lastCircularAt === "string" && circularWalletsFrom({ [k]: { lastCircularAt: ws.lastCircularAt } }, { now: opts.now ?? Date.now() }).size) carryAt.set(k, { ...(carryAt.get(k) || {}), lastCircularAt: [carryAt.get(k)?.lastCircularAt, ws.lastCircularAt].filter((x) => typeof x === "string").sort().pop() });
  }
  for (const [k, prev] of carryAt) {
    if (!walletEvidenceOut[k]) walletEvidenceOut[k] = { callsSettled: 0, uniqueBuyers: 0, circular: false, lastCircularAt: prev.lastCircularAt, carried: true, origins: Array.isArray(prev.origins) ? prev.origins : [] };
  }
  const windowLabel = windowLabelFromSeconds(win.windowSeconds);

  return {
    spec: "x402-leaderboard/1",
    asOf: new Date().toISOString(),
    scannedBlocks: win.spanBlocks,
    windowLabel,
    maxCallUsd: opts.maxCallUsd,
    priceMatchMaxUsd: opts.priceMatchMaxUsd,
    // The window in time; its first block was found by timestamp ("chain").
    windowSeconds: win.windowSeconds,
    windowStartSource: win.source,
    scannedSellers: sellers.length,
    walletsQueried: wallets.length,
    bazaarTotal: total,
    leaderboard: ranked,
    // Router input, persisted with the snapshot so a warm start carries it;
    // removed from every served copy by getLeaderboardSnapshot().
    walletEvidence: walletEvidenceOut,
    ...(fundingScan ? { routerFundingScan: fundingScan } : {}),
    // Honesty flags: a partial scan under-covers the window (missed ranges
    // mean some settlements aren't counted) — never render it as if it were
    // a complete scan. See ledger-leaderboard.js / x402-index.js for where
    // this surfaces to humans.
    ...(partial ? {
      partial: true,
      windowNote: `${windowLabel} scan, partial: ${failedChunks} of ${callCount} ranges unavailable`,
    } : {}),
    // A wallet cap makes the board a sample of known sellers, not all of them.
    ...(walletCap ? {
      sellersSampled: true,
      sellerSampleNote: `scan capped to the top ${walletCap.limit} of ${walletCap.eligible} known seller wallets by ${walletCap.rankedBy}; sellers outside the cut are unmeasured, not zero`,
      sellersEligible: walletCap.eligible,
    } : {}),
  };
}

// --- history persistence (week-over-week deltas) -----------------------------
//
// One compact point per UTC day, written after every successful refresh (the
// day's point is always the latest scan of that day). Lives on the same /data
// persistent volume the stats DB and submitted-seeds file use — no new infra.
// Both bounds below exist because /data is shared: a point keeps only the top
// HISTORY_MAX_SELLERS rows and the file keeps only HISTORY_MAX_DAYS points, so
// the file stays a few hundred KB forever. Every write is try/caught: a missing
// volume (local dev, CI) or a full disk silently skips — history is a nicety,
// never a refresh-breaker. Consumed by the x402-trending tool (x402-kit.js).

export const LEADERBOARD_HISTORY_FILE =
  process.env.LEADERBOARD_HISTORY_FILE || "/data/leaderboard-history.json";
const HISTORY_MAX_DAYS = 35; // ~5 weeks — enough for WoW with slack
const HISTORY_MAX_SELLERS = 300; // per point — bounds file size on /data

// Full-snapshot warm-start (origins included). The daily HISTORY digest above
// keeps only wallets/totals, so it can't rebuild the origin→settled map the SOR
// resolver joins on. This file persists the WHOLE latest snapshot to the same
// /data volume so a fresh boot serves real reliability data immediately instead
// of the empty "warming" placeholder — otherwise the resolver (and every
// leaderboard consumer) reads ZERO settled sellers for the minutes the first
// on-chain scan takes after each deploy, which silently kills SOR external
// routing during that window. Stale-but-complete is correct for the gate: a
// seller proven yesterday is still proven today.
export const LEADERBOARD_SNAPSHOT_FILE =
  process.env.LEADERBOARD_SNAPSHOT_FILE || "/data/leaderboard-snapshot.json";

// Each file is one JSON document: on the volume, or in the state database
// when one is configured (imported from the file once). Documents are made per
// file name so tests that pass their own paths keep their own stores.
const docs = new Map();
const docFor = (file) => { let d = docs.get(file); if (!d) { d = createJsonDocument({ file, log: () => {} }); docs.set(file, d); } return d; };
/** Best-effort persist of the full snapshot. No-op on a missing /data volume. */
function persistLeaderboardSnapshot(snapshot, file = LEADERBOARD_SNAPSHOT_FILE) {
  try {
    if (!snapshot || snapshot.scanSkipped || !Array.isArray(snapshot.leaderboard) || !snapshot.leaderboard.length) return false;
    return docFor(file).saveSync(snapshot);
  } catch { return false; }
}

/** Load the last persisted full snapshot from /data, or null. Structurally
 *  complete (origins present) but stale — used only to warm the cache at boot. */
export function loadPersistedLeaderboardSnapshot(file = LEADERBOARD_SNAPSHOT_FILE) {
  return timedSync("x402 leaderboard warm-start", file, () => _loadPersistedLeaderboardSnapshot(file));
}
const wellFormedSnapshot = (snap) => (snap && Array.isArray(snap.leaderboard) && snap.leaderboard.length ? snap : null);
function _loadPersistedLeaderboardSnapshot(file = LEADERBOARD_SNAPSHOT_FILE) {
  try { return wellFormedSnapshot(docFor(file).loadSync(null)); } catch { return null; }
}
/** The database copy of the snapshot (null without a database or a row). */
async function loadPersistedLeaderboardSnapshotAsync(file = LEADERBOARD_SNAPSHOT_FILE, { onLoad = null } = {}) {
  const d = docFor(file);
  if (d.backend !== "pg") return null;
  // onLoad gets the snapshot whenever the row is read: now, or when a failed
  // load's background re-read lands.
  const opts = onLoad ? { onLoad: (j) => { const s = wellFormedSnapshot(j); if (s) onLoad(s); } } : {};
  try { return wellFormedSnapshot(await d.load(null, opts)); } catch { return null; }
}

// In database mode the history is held in memory (loaded once, updated on
// every persist) because the trending tool reads it synchronously per call.
const historyMemo = new Map(); // file -> array
function historyWarm(file) {
  const d = docFor(file);
  if (d.backend !== "pg" || historyMemo.has(file)) return;
  historyMemo.set(file, []);
  // A point recorded while the row was unread is merged over the stored
  // history (same day: the newer point wins), so a late read never drops it
  // and the next save does not replace the stored history with a short one.
  trackStoreReady(d.load(null, { onLoad: (arr) => {
    if (!Array.isArray(arr)) return;
    const mine = historyMemo.get(file) || [];
    const days = new Set(mine.map((p) => p && p.day));
    const merged = [...arr.filter((p) => p && !days.has(p.day)), ...mine].sort((a, b) => String(a.day).localeCompare(String(b.day))).slice(-HISTORY_MAX_DAYS);
    historyMemo.set(file, merged);
    if (mine.length) d.saveSync(merged);
  } }));
}
/** Read the persisted history: array of daily points, oldest first. [] on any error. */
export function readLeaderboardHistory(file = LEADERBOARD_HISTORY_FILE) {
  try {
    const d = docFor(file);
    if (d.backend === "pg") { historyWarm(file); return historyMemo.get(file) || []; }
    const arr = d.loadSync(null);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Persist a daily digest of a snapshot (idempotent per UTC day — re-running the
 * same day replaces that day's point). Returns true if written, false if
 * skipped (bad snapshot or no writable volume).
 */
export function persistLeaderboardHistoryPoint(snapshot, file = LEADERBOARD_HISTORY_FILE) {
  try {
    if (!snapshot || snapshot.scanSkipped || !Array.isArray(snapshot.leaderboard)) return false;
    const asOf = snapshot.asOf || new Date().toISOString();
    const day = String(asOf).slice(0, 10);
    const sellers = snapshot.leaderboard.slice(0, HISTORY_MAX_SELLERS).map((r) => ({
      // All of a group's wallets, so a later snapshot whose primary wallet
      // shifted within the same operator group still matches its history.
      wallets: Array.isArray(r.wallets) && r.wallets.length ? r.wallets : r.wallet ? [r.wallet] : [],
      callsSettled: Number(r.callsSettled) || 0,
      totalUsd: Number(r.totalUsd) || 0,
      uniqueBuyers: Number(r.uniqueBuyers) || 0,
    }));
    const history = readLeaderboardHistory(file).filter((p) => p && p.day !== day);
    history.push({ day, asOf, windowLabel: snapshot.windowLabel, sellers });
    history.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const kept = history.slice(-HISTORY_MAX_DAYS);
    if (docFor(file).backend === "pg") historyMemo.set(file, kept);
    return docFor(file).saveSync(kept);
  } catch {
    return false; // no /data volume or disk error — skip silently
  }
}

// Seller-funding state (src/seller-funding.js): per-wallet cursors, known
// payers and the (wallet, payer) pools, so each hourly read covers only new
// blocks, a payer's history is read once, and a pool is remembered until it is
// spent. Kept in its own file beside the snapshot, read once (asynchronously)
// before the first scan and written after each.
export const LEADERBOARD_FUNDING_FILE =
  process.env.LEADERBOARD_FUNDING_FILE || "/data/leaderboard-funding.json";
let fundingStateCache = null;
async function loadSellerFundingState(file = LEADERBOARD_FUNDING_FILE) {
  if (fundingStateCache) return fundingStateCache;
  let body = null;
  const d = docFor(file);
  try { body = await d.load(null); } catch { /* no state yet: a fresh state */ }
  const state = body ? parseFundingState(JSON.stringify(body), USDC) : createFundingState(USDC);
  // A fresh state that stands in for an unread row is not kept: the next
  // scan loads again, so the stored progress is resumed once it can be read
  // (the stand-in's saves are held meanwhile).
  if (d.backend === "pg" && d.loadState !== "ok") return state;
  fundingStateCache = state;
  return fundingStateCache;
}
async function persistSellerFundingState(state, file = LEADERBOARD_FUNDING_FILE) {
  try {
    return await docFor(file).save(JSON.parse(serializeFundingState(state)));
  } catch { return false; } // no /data volume (local dev, CI): the next scan reads every payer's history again
}

// THE SWITCH (2026-09-28): the seller-funding reader and everything it feeds
// the router, on by default. Off when LEADERBOARD_FUNDING_SCAN=off (read at
// call time; the env wins) or when the operator turned it off at runtime
// (POST /__operator/seller-funding {"action":"disable"}, persisted on the
// volume, no redeploy). OFF IS THE GROSS PER-WALLET EVIDENCE AND NOTHING ELSE:
// no funding read, no netting, no circular verdict, not even one carried from
// an earlier scan - and it applies from the next read of the getters below,
// not from the next scan, so a warm-started snapshot's netted figures and
// verdicts stop counting at once. The measurement already on the volume is
// left alone: switching back on resumes from it.
export const LEADERBOARD_FUNDING_SWITCH_FILE =
  process.env.LEADERBOARD_FUNDING_SWITCH_FILE || "/data/leaderboard-funding-switch.json";
let fundingSwitch = null; // null: not loaded; false: no operator choice; else { enabled, at, note, persisted }
let fundingSwitchVersion = 0;
function operatorFundingSwitch() {
  if (fundingSwitch === null) {
    fundingSwitch = false;
    const d = docFor(LEADERBOARD_FUNDING_SWITCH_FILE);
    const apply = (j) => {
      if (typeof j?.enabled === "boolean") { fundingSwitch = { enabled: j.enabled, at: typeof j.at === "string" ? j.at : null, note: typeof j.note === "string" ? j.note.slice(0, 200) : "", persisted: true }; fundingSwitchVersion++; }
    };
    // onLoad also runs when a failed load's background re-read lands. An
    // operator choice made meanwhile wins and is saved now that it can be.
    if (d.backend === "pg") trackStoreReady(d.load(null, { onLoad: (j) => {
      if (fundingSwitch === false) apply(j);
      else if (fundingSwitch && fundingSwitch.persisted !== true) { const f = fundingSwitch; void d.save({ enabled: f.enabled, at: f.at, note: f.note }).then((stored) => { f.persisted = stored === true; }); }
    } }));
    try {
      const j = d.loadSync(null);
      if (typeof j?.enabled === "boolean") fundingSwitch = { enabled: j.enabled, at: typeof j.at === "string" ? j.at : null, note: typeof j.note === "string" ? j.note.slice(0, 200) : "", persisted: true };
    } catch { /* no operator choice on the volume */ }
  }
  return fundingSwitch || null;
}
/** Whether the seller-funding reader and its evidence are on (see THE SWITCH). */
export function sellerFundingEnabled() {
  if (String(process.env.LEADERBOARD_FUNDING_SCAN || "").trim().toLowerCase() === "off") return false;
  const op = operatorFundingSwitch();
  return op ? op.enabled : true;
}
/** Operator view of the switch: whether it is on, and what decided it. */
export function sellerFundingSwitch() {
  const env = String(process.env.LEADERBOARD_FUNDING_SCAN || "").trim().toLowerCase() === "off";
  const op = operatorFundingSwitch();
  return { enabled: sellerFundingEnabled(), source: env ? "env" : op ? "operator" : "default", envOff: env, operator: op ? { enabled: op.enabled, at: op.at, note: op.note, persisted: op.persisted } : null };
}
/** The operator's runtime switch. Persisted on the volume when it can be
 *  (else it holds until the process restarts). */
export function setSellerFundingEnabled(enabled, { note = "", now = Date.now() } = {}) {
  if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false"), { statusCode: 400 });
  const before = sellerFundingEnabled();
  const next = { enabled, at: new Date(now).toISOString(), note: String(note || "").slice(0, 200), persisted: false };
  const d = docFor(LEADERBOARD_FUNDING_SWITCH_FILE);
  const body = { enabled: next.enabled, at: next.at, note: next.note };
  // `persisted` says whether the write landed: the file's write is known at
  // once; the database's is in flight (null) until it resolves.
  if (d.backend === "file") next.persisted = d.saveSync(body);
  else if (d.backend === "pg") { next.persisted = null; void d.save(body).then((stored) => { next.persisted = stored === true; }); }
  fundingSwitch = next;
  fundingSwitchVersion++;
  evidenceMemo = { ev: null, ver: null, out: null };
  circularMemo = { ev: null, at: 0, set: new Set(), version: "", ver: null };
  return { changed: before !== sellerFundingEnabled(), ...sellerFundingSwitch() };
}

// Operator levers for the seller-funding rule, handed in by the server:
//   cleared: wallets whose self-funded verdict the operator has cleared
//            (anything with has(wallet) and a changing `version`): their
//            evidence reads gross and they are never circular while listed;
//            the measurement goes on, so restoring one applies at once.
//   skip:    wallets whose outbound is not read at all (the operator-listed
//            shared settlement contracts: they credit nobody anyway, and they
//            pay out on every payment).
const fundingConfig = { cleared: null, skip: () => false };
export function configureSellerFunding({ cleared = null, skip = null } = {}) {
  fundingConfig.cleared = cleared && typeof cleared.has === "function" ? cleared : null;
  fundingConfig.skip = typeof skip === "function" ? skip : () => false;
  evidenceMemo = { ev: null, ver: null, out: null };
  circularMemo = { ev: null, at: 0, set: new Set(), version: "", ver: null };
}
const clearanceVersion = () => `${sellerFundingEnabled() ? "on" : "off"}:${fundingSwitchVersion}:${fundingConfig.cleared ? String(fundingConfig.cleared.version ?? "") : ""}`;

// --- server-side cache + refresh -------------------------------------------

// One process-global snapshot. Restart-tolerant by design: a fresh boot warms
// the cache in tens of seconds (one Bazaar walk + a handful of eth_getLogs).
let cached = {
  snapshot: null,        // last successful snapshot, or null until first warm
  warming: false,        // true while a refresh is in flight (debounces concurrent triggers)
  lastError: null,       // last refresh error string (preserved for /api/leaderboard reporting)
  lastTriedAt: null,     // ISO timestamp of last attempt (success or failure)
  refreshIntervalMs: null,
};
let refreshTimer = null;

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Under a lease (see src/state-db.js): the old and the new container of a
// deploy never scan at once, so the seller-funding cursors advance once.
const refreshOnce = leased("leaderboard-refresh", { ttlMs: 30 * 60_000, failOpen: true }, refreshOnceUnleased);
async function refreshOnceUnleased(opts) {
  if (cached.warming) return; // overlapping refreshes would just rate-limit each other
  cached.warming = true;
  cached.lastTriedAt = new Date().toISOString();
  try {
    // The persisted seller-funding state (cursors and pools) rides in and out
    // of every Base scan; the previous scan's per-wallet evidence rides in too,
    // so a wallet found circular keeps that verdict for the Bazaar's window.
    const base = !opts.chain || opts.chain === "base";
    const fundingState = base && sellerFundingEnabled() ? await loadSellerFundingState() : undefined;
    const snap = await runLeaderboard({ ...opts, fundingState, fundingSkip: fundingConfig.skip, previousWalletEvidence: cached.snapshot?.walletEvidence || null });
    if (snap?.routerFundingScan) {
      const f = snap.routerFundingScan;
      console.log(`[leaderboard] seller-funding read: ${f.calls ?? 0} call(s) over ${f.wallets ?? 0} wallet(s) (${f.historyCalls ?? 0} for ${f.historyPayers ?? 0} new payer(s)), ${f.walletsCaughtUp ?? 0} caught up${f.walletsBehind ? `, ${f.walletsBehind} behind` : ""}${f.historyWalletsFailed ? `, ${f.historyWalletsFailed} with history pending` : ""}${fundingReadNotes(f)}${f.error ? ` (failed: ${f.error})` : ""}`);
      if (fundingState) await persistSellerFundingState(fundingState);
    }
    cached.snapshot = snap;
    cached.lastError = null;
    // Best-effort daily digest to /data so week-over-week deltas (the
    // x402-trending tool) activate automatically once history accrues.
    // No-op when the volume is absent (local dev, CI).
    persistLeaderboardHistoryPoint(snap);
    // Full-snapshot warm-start file — lets the NEXT boot serve real reliability
    // data before its own scan lands (closes the post-deploy cold window).
    persistLeaderboardSnapshot(snap);
  } catch (e) {
    cached.lastError = redactSecrets(String(e?.message || e)).slice(0, 300);
    // Keep the previous snapshot — a transient RPC outage shouldn't wipe a
    // perfectly good 1-hour-old ranking from the public endpoint.
  } finally {
    cached.warming = false;
  }
}

/**
 * Start the periodic refresh loop. Idempotent — subsequent calls are no-ops.
 * The first refresh fires immediately (non-blocking) so the cache warms as
 * soon as the upstream APIs respond. Pass `{ intervalMs }` to override the
 * default 1-hour cadence (useful in tests).
 */
export function startLeaderboardRefresh(opts = {}) {
  if (refreshTimer) return;
  const intervalMs = opts.intervalMs ?? REFRESH_INTERVAL_MS;
  cached.refreshIntervalMs = intervalMs;
  // Warm-start from the persisted full snapshot so getLeaderboardSnapshot serves
  // real rows (origins + settled) from the very first request after a deploy,
  // instead of the empty "warming" placeholder that made the SOR resolver find
  // zero proven sellers for ~minutes. Marked staleFromDisk; the refresh below
  // overwrites it with a fresh scan. No-op when the /data file is absent.
  if (!cached.snapshot) {
    const disk = loadPersistedLeaderboardSnapshot();
    if (disk) cached.snapshot = { ...disk, staleFromDisk: true };
    else trackStoreReady(loadPersistedLeaderboardSnapshotAsync(LEADERBOARD_SNAPSHOT_FILE, { onLoad: (row) => { if (!cached.snapshot) cached.snapshot = { ...row, staleFromDisk: true }; } }));
  }
  // Skip the immediate boot scan when X402_SYNC_ON_START=false — the same flag
  // the facilitator handshake honors ("no upstream network sync at boot"). The
  // 7d scan is ~170 RPC calls plus a large aggregation; running it at boot made
  // a resource-constrained CI runner drop concurrent test requests as "fetch
  // failed" while the full-catalog example test hammered every endpoint. The
  // interval timer still schedules refreshes, and getLeaderboardSnapshot serves
  // the "warming" placeholder (with the correct window label) until one lands.
  // First refresh deferred past boot (2026-08-25): its RPC calls (~0.8 s of
  // self-time in the boot profile) competed with the first health check, and
  // the disk snapshot above serves the page meanwhile. opts.firstDelayMs: 0
  // keeps the old behaviour for callers that need the refresh at once.
  if (process.env.X402_SYNC_ON_START !== "false") {
    const firstDelayMs = Number.isFinite(opts.firstDelayMs) ? opts.firstDelayMs : Number(process.env.LEADERBOARD_FIRST_REFRESH_DELAY_MS ?? 20_000);
    const first = setTimeout(() => refreshOnce(opts).catch(() => {}), Math.max(0, firstDelayMs));
    if (typeof first.unref === "function") first.unref();
  }
  refreshTimer = setInterval(() => refreshOnce(opts).catch(() => {}), intervalMs);
  // Don't keep the event loop alive on shutdown.
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

/** Stop the refresh loop (used by tests to keep the process exitable). */
export function stopLeaderboardRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Return the cached snapshot. If the cache isn't warm yet, returns a
 * placeholder with `warming: true` so callers can show a meaningful response
 * instead of a 404. The placeholder is also what's returned if the first
 * refresh failed (with `lastError` populated).
 */
export function getLeaderboardSnapshot() {
  if (cached.snapshot) {
    // walletEvidence is router input (getLeaderboardWalletEvidence below).
    // Every public path spreads this return value, so this is the one place it
    // has to be dropped.
    const { walletEvidence: _routerOnly, routerFundingScan: _routerOnlyScan, ...served } = cached.snapshot;
    return {
      ...served,
      cache: {
        cachedAt: cached.snapshot.asOf,
        lastTriedAt: cached.lastTriedAt,
        lastError: cached.lastError,
        refreshIntervalMs: cached.refreshIntervalMs,
      },
    };
  }
  // Pre-warm placeholder: still surface the configured window so the HTML page
  // and JSON consumers see "Last 7d" instead of an em-dash while the cache
  // fills. Once a real snapshot lands these get overwritten from the scan.
  return {
    spec: "x402-leaderboard/1",
    asOf: new Date().toISOString(),
    warming: true,
    scannedBlocks: 0,
    windowSeconds: DEFAULTS.windowSeconds,
    windowLabel: windowLabelFromSeconds(DEFAULTS.windowSeconds),
    maxCallUsd: DEFAULTS.maxCallUsd,
    leaderboard: [],
    cache: {
      cachedAt: null,
      lastTriedAt: cached.lastTriedAt,
      lastError: cached.lastError,
      refreshIntervalMs: cached.refreshIntervalMs,
    },
  };
}

/**
 * The last scan's per-wallet evidence: wallet -> { callsSettled, uniqueBuyers,
 * origins }. Read by the router's evidence binding (src/evidence-binding.js) to
 * keep every figure against the wallet it was measured at, rather than an
 * operator row's totals. `{}` before the first scan and for a snapshot
 * persisted before this field existed, which credits a multi-wallet row
 * nothing (its totals cannot be split), never its totals.
 */
export function getLeaderboardWalletEvidence() {
  const ev = cached.snapshot?.walletEvidence;
  if (!(ev && typeof ev === "object" && !Array.isArray(ev))) return {};
  // Switched off: the gross per-wallet figures, with no netting and no verdict.
  if (!sellerFundingEnabled()) {
    const ver = clearanceVersion();
    if (evidenceMemo.ev === ev && evidenceMemo.ver === ver) return evidenceMemo.out;
    const out = {};
    for (const [w, e] of Object.entries(ev)) {
      if (!e || typeof e !== "object" || e.carried) continue;
      out[w] = { callsSettled: e.grossCallsSettled ?? e.callsSettled, uniqueBuyers: e.grossUniqueBuyers ?? e.uniqueBuyers, origins: Array.isArray(e.origins) ? e.origins : [] };
    }
    evidenceMemo = { ev, ver, out };
    return out;
  }
  const cleared = fundingConfig.cleared;
  if (!cleared) return ev;
  // A wallet the operator has cleared reads its gross figures (the netting
  // and the verdict are the measurement; the clearance is the judgement).
  const ver = clearanceVersion();
  if (evidenceMemo.ev === ev && evidenceMemo.ver === ver) return evidenceMemo.out;
  let out = ev;
  for (const [w, e] of Object.entries(ev)) {
    if (!e || e.grossCallsSettled === undefined || !cleared.has(w)) continue;
    if (out === ev) out = { ...ev };
    out[w] = { callsSettled: e.grossCallsSettled, uniqueBuyers: e.grossUniqueBuyers, origins: e.origins || [], selfFundingCleared: true };
  }
  evidenceMemo = { ev, ver, out };
  return out;
}
let evidenceMemo = { ev: null, ver: null, out: null };

/** The last scan's seller-funding read (counts only): router/operator input. */
export function getLeaderboardFundingScan() {
  return cached.snapshot?.routerFundingScan || null;
}

// Circular wallets, memoized per evidence object for ten minutes (the verdict
// only changes at a scan, but its 30-day window slides).
let circularMemo = { ev: null, at: 0, set: new Set(), version: "", ver: null };
/**
 * { wallets: Set, version }: the Base wallets whose settled evidence was mostly
 * self-funded in a scan inside the Bazaar's window. The router disregards
 * their Bazaar and chain-join figures (src/evidence-binding.js) and their
 * Bazaar payer count in ranking ties (x402-index routeQuery).
 */
export function getLeaderboardCircularWallets(now = Date.now()) {
  const ev = cached.snapshot?.walletEvidence || null;
  const ver = clearanceVersion();
  if (!sellerFundingEnabled()) return { wallets: new Set(), version: `${cached.snapshot?.asOf || "none"}:0:${ver}` };
  if (circularMemo.ev !== ev || circularMemo.ver !== ver || now - circularMemo.at > 10 * 60_000) {
    const set = circularWalletsFrom(ev, { now, cleared: fundingConfig.cleared });
    circularMemo = { ev, at: now, set, ver, version: `${cached.snapshot?.asOf || "none"}:${set.size}:${ver}` };
  }
  return { wallets: circularMemo.set, version: circularMemo.version };
}

/**
 * Operator view of the seller-funding rule (counts and verdicts only, never a
 * payer): the last read's counts, and per wallet the state and the figures.
 * `wallet` narrows it to one.
 */
export function sellerFundingStatus({ wallet = null, now = Date.now() } = {}) {
  const ev = cached.snapshot?.walletEvidence || {};
  const cleared = fundingConfig.cleared;
  const one = (w) => {
    const e = ev[w] || null;
    const ws = fundingStateCache?.wallets?.get(w) || null;
    return {
      wallet: w,
      circular: circularWalletsFrom(e ? { [w]: e } : {}, { now }).has(w),
      cleared: !!cleared?.has?.(w),
      lastCircularAt: e?.lastCircularAt || ws?.lastCircularAt || null,
      evidence: e ? { callsSettled: e.callsSettled, uniqueBuyers: e.uniqueBuyers, grossCallsSettled: e.grossCallsSettled ?? null, grossUniqueBuyers: e.grossUniqueBuyers ?? null, selfFundedCalls: e.selfFundedCalls ?? null, selfFundedPayers: e.selfFundedPayers ?? null, selfFundedUsd: e.selfFundedUsd ?? null, grossUsd: e.grossUsd ?? null, selfFundedCalls30d: e.selfFundedCalls30d ?? null, selfFundedPayers30d: e.selfFundedPayers30d ?? null, fundingRead: e.fundingRead ?? null, fundingPending: !!e.fundingPending, fundingTruncated: !!e.fundingTruncated } : null,
      state: ws ? { cursor: ws.cursor, since: ws.since, pools: ws.pairs.size, openPools: [...ws.pairs.values()].filter((p) => p.pool > 0).length, knownPayers: ws.known.size, truncated: ws.truncated, retryAt: ws.retryAt > 0 ? new Date(ws.retryAt).toISOString() : null, waits: ws.st || 0, readsInProgress: ws.hp?.length || 0, episodeCalls: ws.ep ? ws.ep.sp : 0 } : null,
    };
  };
  if (wallet) return { ...one(String(wallet).toLowerCase()), switch: sellerFundingSwitch() };
  const circularWallets = [...circularWalletsFrom(ev, { now })].sort();
  return {
    // `circular` below is what the last scans MEASURED; with the switch off
    // the router applies none of it (evidence gross, no verdict).
    switch: sellerFundingSwitch(),
    asOf: cached.snapshot?.asOf || null,
    lastRead: cached.snapshot?.routerFundingScan || null,
    stateWallets: fundingStateCache?.wallets?.size ?? null,
    statePairs: fundingStateCache ? fundingPairCount(fundingStateCache) : null,
    stateKnownPayers: fundingStateCache ? fundingKnownCount(fundingStateCache) : null,
    circular: circularWallets.map(one),
  };
}

/** Test hook: clear the cache. Not exported on the production path. */
export function _setLeaderboardSnapshotForTests(snap) { cached.snapshot = snap; }
export function _resetLeaderboardCacheForTests() {
  cached = { snapshot: null, warming: false, lastError: null, lastTriedAt: null, refreshIntervalMs: null };
  fundingStateCache = null;
  fundingSwitch = null;
  configureSellerFunding({});
  stopLeaderboardRefresh();
}
