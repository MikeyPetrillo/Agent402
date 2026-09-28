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

import { readFileSync, writeFileSync } from "node:fs";
import { timedSync } from "./boot-timing.js";
import { fetchAllBazaarItems as walkBazaar } from "./bazaar-pager.js";
import { EVM, OUR_EVM_WALLETS } from "./revenue-live.js";
import { redactSecrets } from "./tools/redact.js";
import { NETWORKS } from "./payments.js";
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { applyMetaTrims } from "./seo-meta.js";

import { REPO_URL } from "./repo-link.js";
// Base block time is ~2s, so 24h ≈ 43200 blocks and 7d ≈ 302400 blocks. A
// wider window surfaces sellers with bursty (vs. constant) traffic — without
// it, any seller below ~9 calls/sec averaged over a day shows $0 even when
// their lifetime revenue is real. The scan folds transfers incrementally
// (see initWalletAccumulator/foldTransfers/finalizeLeaderboard below) so any
// window is memory-bounded, but the default stays 24h — 7d re-enable is a
// deliberate staged env flip (SPAN_BLOCKS=302400) after prod verification,
// not a silent default. ?window= remains the hook for a future deep-cache
// rollout (30d/all-time) that doesn't require widening this live scan further.
const SECONDS_PER_BASE_BLOCK = 2;
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
  // PayAI's discovery catalog, walked with the same pager as the Bazaar (same
  // {items, pagination.total} contract). The Bazaar lists only resources that
  // settled through CDP, so most sellers settling through PayAI are absent
  // from it: measured 2026-09-28, 428 of the catalog's 524 Base wallets. The
  // crawl seed below reaches many of them, but without their advertised
  // prices, which priceMatches needs to admit a purchase above maxCallUsd.
  // Set PAYAI_DISCOVERY_URL="" to skip it.
  payaiUrl: process.env.PAYAI_DISCOVERY_URL ?? "https://facilitator.payai.network/discovery/resources",
  spanBlocks: parseInt(process.env.SPAN_BLOCKS || "43200", 10), // ~24h of Base blocks
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
 *  curated list of seven active services over the same 7-day window we scan:
 *  SIX were absent from our board entirely, and every one of those six has an
 *  average transfer above the ceiling - one of them by four cents (27,590
 *  transactions, 715 buyers, $0.79 each). We were not ranking them lower. We
 *  could not see them.
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

function seedResourceKey(item) {
  const raw = item?.resource || item?.url || item?.endpoint;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try { return new URL(raw.trim()).href; } catch { return raw.trim(); }
}

/**
 * Append a second Bazaar-shaped feed's items to the first, skipping any
 * resource the first already lists. A seller listed in both registries is one
 * endpoint, not two: counting it twice would inflate `endpoints`, which orders
 * the optional maxWalletsScan cap. The first feed's copy wins, so the Bazaar's
 * name and prices stay authoritative for anything it lists.
 */
export function mergeSeedItems(primary, extra) {
  const items = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(items.map(seedResourceKey).filter(Boolean));
  let added = 0;
  for (const it of Array.isArray(extra) ? extra : []) {
    const k = seedResourceKey(it);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    items.push(it);
    added++;
  }
  return { items, added };
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
export function mergeCrawledWallets(sellers, payToOrigins, chain = undefined) {
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
    });
    added++;
  }
  return { merged: [...known.values()], added };
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
    if (!matched && t.usd > maxCallUsd) { row.overCeilingSkipped = (row.overCeilingSkipped || 0) + 1; continue; }
    if (matched && t.usd > maxCallUsd) row.abovePriceMatched = (row.abovePriceMatched || 0) + 1;
    // Skipped whole, not just as a payer: a settlement we paid for is not a
    // settlement the seller earned, so counting the call while dropping the
    // payer would leave callsSettled overstating what uniqueBuyers reports.
    if (t.payer && ours.has(String(t.payer).toLowerCase())) { row.selfPaidSkipped = (row.selfPaidSkipped || 0) + 1; continue; }
    row.callsSettled += 1;
    row.totalUsd += t.usd;
    if (t.payer) {
      const p = row.perPayer.get(t.payer) || { calls: 0, usd: 0 };
      p.calls += 1;
      p.usd += t.usd;
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
    const host = canonicalHost(w.homepage) || canonicalHost(w.origins?.[0]);
    const key = host ? `host:${host}` : `wallet:${w.wallet}`;
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
  return ranked;
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

/** Render a block count as a human-friendly window label ("5h", "24h", "7d"). */
export function windowLabelFromBlocks(blocks) {
  const seconds = (Number(blocks) || 0) * SECONDS_PER_BASE_BLOCK;
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
  scannedBlocks: opts.spanBlocks,
  windowLabel: windowLabelFromBlocks(opts.spanBlocks),
  maxCallUsd: opts.maxCallUsd,
  priceMatchMaxUsd: opts.priceMatchMaxUsd,
  scannedSellers: 0,
  walletsQueried: 0,
  leaderboard: [],
  scanSkipped: true,
  reason,
});

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
    // The rail's own tuned span and RPC list win unless the caller is explicit,
    // because a single SPAN_BLOCKS across chains is meaningless: identical
    // block counts are 24h on Base and under 7h on Arbitrum.
    spanBlocks: overrides.spanBlocks ?? (process.env.SPAN_BLOCKS ? DEFAULTS.spanBlocks : chain.spanBlocks),
    rpcs: overrides.rpcs ?? chain.rpcs,
    ...overrides,
  };
  opts.chain = chain;
  const onProgress = overrides.onProgress || (() => {});

  // 1. Bazaar discovery (paginated) → per-item payTo for Base-mainnet USDC.
  onProgress(`[1/3] Fetching Bazaar discovery (${opts.bazaarUrl})…`);
  const { items: bazaarItems, total } = await fetchAllBazaarItems(opts.bazaarUrl, opts);
  let seedItems = bazaarItems;
  // The PayAI catalog is a second seed. Best effort: if it is down, the scan
  // runs on the Bazaar alone, as it did before this seed existed.
  if (opts.payaiUrl) {
    try {
      const payai = await fetchAllBazaarItems(opts.payaiUrl, opts);
      const merged = mergeSeedItems(bazaarItems, payai.items);
      seedItems = merged.items;
      onProgress(`      +${merged.added} listing(s) from the PayAI catalog (${payai.items.length}/${payai.total ?? "?"}; ${payai.items.length - merged.added} already in the Bazaar)`);
    } catch (e) {
      onProgress(`      PayAI catalog seed skipped: ${redactSecrets(String(e?.message || e)).slice(0, 120)}`);
    }
  }
  const items = seedItems;
  let sellers = extractWalletsFromBazaar({ items }, chain);
  onProgress(`      ${bazaarItems.length}/${total ?? "?"} Bazaar listings, ${items.length} with PayAI → ${sellers.length} unique ${chain.label}-mainnet wallets`);
  // Our own crawl's payTo wallets, folded in so a self-registered seller can
  // accumulate settlement evidence without joining someone else's registry.
  if (typeof opts.crawledWallets === "function") {
    try {
      const { merged, added } = mergeCrawledWallets(sellers, opts.crawledWallets(chain), chain);
      sellers = merged;
      if (added) onProgress(`      +${added} wallet(s) from our own crawl (not in the Bazaar) → ${sellers.length} total`);
    } catch (e) {
      onProgress(`      crawled-wallet seed skipped: ${String(e?.message || e).slice(0, 120)}`);
    }
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
  onProgress(`[2/3] Scanning ${chain.label} USDC transfers (${opts.spanBlocks} blocks, ${wallets.length} wallets)…`);
  const latest = parseInt(await rpcCall(opts.rpcs, "eth_blockNumber", []), 16);
  const padded = wallets.map(pad);
  const walletChunks = [];
  for (let i = 0; i < padded.length; i += opts.walletChunk) walletChunks.push(padded.slice(i, i + opts.walletChunk));
  const start = latest - opts.spanBlocks;
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
  for (const [from, to] of blockChunks) {
    for (const chunk of walletChunks) {
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
          }));
          foldTransfers(byWallet, chunkTransfers, opts.maxCallUsd, OUR_EVM_WALLETS, opts.priceMatchMaxUsd);
          transferCount += chunkTransfers.length;
        }
      } catch (e) {
        failedChunks += 1;
        onProgress(`      chunk failed (blocks ${from}-${to}): ${redactSecrets(String(e?.message || e))}`);
      }
    }
  }
  if (callCount > 0 && failedChunks === callCount) {
    throw new Error(`All ${callCount} eth_getLogs chunk(s) failed - RPC outage, aborting scan`);
  }
  const partial = failedChunks > 0;
  onProgress(`      ${transferCount} transfer log(s) total${partial ? ` (partial: ${failedChunks} of ${callCount} ranges unavailable)` : ""}`);

  // 3. Aggregate. byWallet has already absorbed every successfully-scanned
  // chunk's transfers — finalize only does the bounded (O(sellers)) grouping
  // + ranking pass, no transfer-sized array involved.
  onProgress(`[3/3] Aggregating leaderboard…`);
  const ranked = finalizeLeaderboard(byWallet, { maxCallUsd: opts.maxCallUsd });
  const windowLabel = windowLabelFromBlocks(opts.spanBlocks);

  return {
    spec: "x402-leaderboard/1",
    asOf: new Date().toISOString(),
    scannedBlocks: opts.spanBlocks,
    windowLabel,
    maxCallUsd: opts.maxCallUsd,
    priceMatchMaxUsd: opts.priceMatchMaxUsd,
    scannedSellers: sellers.length,
    walletsQueried: wallets.length,
    bazaarTotal: total,
    leaderboard: ranked,
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

/** Best-effort persist of the full snapshot. No-op on a missing /data volume. */
function persistLeaderboardSnapshot(snapshot, file = LEADERBOARD_SNAPSHOT_FILE) {
  try {
    if (!snapshot || snapshot.scanSkipped || !Array.isArray(snapshot.leaderboard) || !snapshot.leaderboard.length) return false;
    writeFileSync(file, JSON.stringify(snapshot));
    return true;
  } catch { return false; }
}

/** Load the last persisted full snapshot from /data, or null. Structurally
 *  complete (origins present) but stale — used only to warm the cache at boot. */
export function loadPersistedLeaderboardSnapshot(file = LEADERBOARD_SNAPSHOT_FILE) {
  return timedSync("x402 leaderboard warm-start", file, () => _loadPersistedLeaderboardSnapshot(file));
}
function _loadPersistedLeaderboardSnapshot(file = LEADERBOARD_SNAPSHOT_FILE) {
  try {
    const snap = JSON.parse(readFileSync(file, "utf8"));
    if (snap && Array.isArray(snap.leaderboard) && snap.leaderboard.length) return snap;
    return null;
  } catch { return null; }
}

/** Read the persisted history: array of daily points, oldest first. [] on any error. */
export function readLeaderboardHistory(file = LEADERBOARD_HISTORY_FILE) {
  try {
    const arr = JSON.parse(readFileSync(file, "utf8"));
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
    writeFileSync(file, JSON.stringify(history.slice(-HISTORY_MAX_DAYS)));
    return true;
  } catch {
    return false; // no /data volume or disk error — skip silently
  }
}

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

async function refreshOnce(opts) {
  if (cached.warming) return; // overlapping refreshes would just rate-limit each other
  cached.warming = true;
  cached.lastTriedAt = new Date().toISOString();
  try {
    const snap = await runLeaderboard(opts);
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
    return {
      ...cached.snapshot,
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
    scannedBlocks: DEFAULTS.spanBlocks,
    windowLabel: windowLabelFromBlocks(DEFAULTS.spanBlocks),
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

/** Test hook: clear the cache. Not exported on the production path. */
export function _resetLeaderboardCacheForTests() {
  cached = { snapshot: null, warming: false, lastError: null, lastTriedAt: null, refreshIntervalMs: null };
  stopLeaderboardRefresh();
}

// --- HTML dashboard ---------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtUsd = (n) => {
  const v = Number(n) || 0;
  if (v >= 100) return `$${v.toFixed(2)}`;
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
};

const shortAddr = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || "-"));

/**
 * Public HTML dashboard for the x402 leaderboard. Self-contained: no client-side
 * polling - a page refresh re-renders from the latest cached snapshot. The
 * underlying snapshot is refreshed hourly by startLeaderboardRefresh().
 */
export function leaderboardPage(snapshot, { baseUrl, sort }) {
  const sortMode = sort === "calls" ? "calls" : "usd";
  const rawBoard = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [];
  const board = rankBy(rawBoard, sortMode);
  const explorer = "https://basescan.org";
  const totalUsd = board.reduce((s, r) => s + (Number(r.totalUsd) || 0), 0);
  const totalCalls = board.reduce((s, r) => s + (Number(r.callsSettled) || 0), 0);
  const top1 = board[0];
  const metricLabel = sortMode === "calls" ? "calls settled" : "USDC settled";
  const sortQueryUsd = "";
  const sortQueryCalls = "?sort=calls";
  const sortToggle = `<div class="sort-toggle" role="tablist" aria-label="Rank by">
    <a href="/leaderboard${sortQueryUsd}" class="${sortMode === "usd" ? "active" : ""}"${sortMode === "usd" ? ' aria-current="page"' : ""}>USDC earned</a>
    <a href="/leaderboard${sortQueryCalls}" class="${sortMode === "calls" ? "active" : ""}"${sortMode === "calls" ? ' aria-current="page"' : ""}>Total calls</a>
  </div>`;

  // Bazaar items are third-party-supplied: a seller can put anything in their
  // listing's homepage field. esc() HTML-escapes but doesn't filter dangerous
  // schemes (javascript:, data:, vbscript:) — so re-check protocol before
  // turning the value into a clickable link. originOf() validates this at
  // crawl time, but cache entries can drift; cheap defense-in-depth.
  const safeHref = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
  // A buyer count alone cannot distinguish a seller with many customers from
  // one wallet running a meter, or from a crowd of evaluators that pay
  // everyone. Both readings were available only in the JSON until 2026-09-13,
  // so the number a visitor actually looks at carries them now. Percent, never
  // an address.
  const pct = (x) => `${Math.round(x * 100)}%`;
  const concentrationBadge = (r) => {
    const bits = [];
    if (r.concentration) {
      const worst = Math.max(r.topPayerCallsShare || 0, r.topPayerUsdShare || 0);
      bits.push(`<span class="badge" title="One wallet is ${esc(pct(r.topPayerCallsShare || 0))} of settlements and ${esc(pct(r.topPayerUsdShare || 0))} of USDC here. Without it: ${esc(r.withoutTopPayer?.callsSettled ?? 0)} calls, ${esc(fmtUsd(r.withoutTopPayer?.totalUsd ?? 0))}, ${esc(r.withoutTopPayer?.uniqueBuyers ?? 0)} buyers.">1 payer ${esc(pct(worst))}</span>`);
    }
    if ((r.multiSellerCallsShare || 0) >= 0.5) {
      bits.push(`<span class="badge" title="${esc(r.multiSellerPayers ?? 0)} of this seller's payers also settle with ${esc(PAYER_BREADTH.multiSellerMin)}+ other sellers we index; they are ${esc(pct(r.multiSellerCallsShare))} of its settlements. Wallets that pay everyone are a weaker demand signal than wallets that chose one seller.">cross-seller ${esc(pct(r.multiSellerCallsShare))}</span>`);
    }
    return bits.length ? ` ${bits.join(" ")}` : "";
  };
  const rows = board
    .map((r) => {
      const href = safeHref(r.homepage);
      const nameCell = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${esc(r.name)}</a>`
        : esc(r.name);
      // When an operator runs multiple wallets behind one website we surface
      // the primary (highest-volume) wallet as the link target and tack on a
      // "+N more" badge whose title lists every address — so the row stays
      // compact while staying fully verifiable on Basescan.
      const allWallets = Array.isArray(r.wallets) && r.wallets.length ? r.wallets : (r.wallet ? [r.wallet] : []);
      const extraCount = Math.max(0, allWallets.length - 1);
      const walletCell = r.wallet
        ? `<a href="${esc(explorer)}/address/${esc(r.wallet)}#tokentxns" target="_blank" rel="noopener nofollow" title="${esc(allWallets.join("\n"))}">${esc(shortAddr(r.wallet))}</a>${extraCount ? ` <span class="badge" title="${esc(allWallets.join("\n"))}">+${esc(extraCount)} more</span>` : ""}`
        : "-";
      return `<tr>
        <td class="num">${esc(r.rank)}</td>
        <td>${nameCell}</td>
        <td class="muted">${walletCell}</td>
        <td>${esc(r.network || "base")}</td>
        <td class="num">${esc(r.callsSettled ?? 0)}</td>
        <td class="num">${esc(fmtUsd(r.totalUsd))}</td>
        <td class="num">${esc(r.uniqueBuyers ?? 0)}${concentrationBadge(r)}</td>
      </tr>`;
    })
    .join("");

  const emptyState = snapshot?.warming
    ? `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Warming the cache - first snapshot is in flight. Refresh in a few seconds.</td></tr>`
    : snapshot?.scanSkipped
    ? `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Snapshot skipped: ${esc(snapshot.reason || "no data")}</td></tr>`
    : `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No settled volume yet. Snapshot refreshes hourly.</td></tr>`;

  const asOf = snapshot?.asOf ? snapshot.asOf.replace("T", " ").slice(0, 19) + "Z" : "-";
  const windowLabel = snapshot?.windowLabel || windowLabelFromBlocks(snapshot?.scannedBlocks);
  const windowHuman = windowLabel === "-" ? "the scan window" : `last ${windowLabel}`;

  return applyMetaTrims(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 Leaderboard - Agent402</title>
<meta name="description" content="Public on-chain ranking of x402 sellers by Base USDC settled volume in the scan window - callsSettled, totalUsd, uniqueBuyers per seller.">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; --warn:#f97316; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:980px; margin:0 auto; padding:36px 20px 28px; }
  h1 { font-size:1.6rem; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:.95rem; max-width:680px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin:0 0 22px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .stat .k { color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .stat .v { font-family:ui-monospace,Menlo,monospace; font-size:1.65rem; color:var(--fg); margin-top:4px; word-break:break-word; }
  .stat .s { color:var(--muted); font-size:.78rem; margin-top:3px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:18px; }
  .ph { padding:14px 18px; border-bottom:1px solid var(--line); }
  .ph h2 { margin:0; font-size:1rem; color:var(--accent); }
  .ph .pn { color:var(--muted); font-size:.82rem; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:10px 18px; border-bottom:1px solid var(--line); }
  th.num { text-align:right; }
  td { padding:10px 18px; border-bottom:1px solid var(--line); }
  td.num { font-family:ui-monospace,Menlo,monospace; text-align:right; }
  td.muted { color:var(--muted); font-family:ui-monospace,Menlo,monospace; font-size:.85em; }
  .badge { display:inline-block; margin-left:6px; padding:1px 6px; border:1px solid var(--line); border-radius:10px; color:var(--muted); font-size:.72em; font-family:system-ui,-apple-system,sans-serif; cursor:help; }
  td a { color:var(--fg); text-decoration:none; border-bottom:1px solid transparent; }
  td a:hover { border-color:var(--accent); }
  code { background:#1a2236; padding:1px 5px; border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:.85em; }
  pre { background:#0a0d15; border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow:auto; font-size:.84rem; }
  .foot { color:var(--muted); font-size:.82rem; margin-top:24px; }
  .foot a { color:var(--accent); text-decoration:none; }
  .sort-toggle { display:inline-flex; gap:0; border:1px solid var(--line); border-radius:8px; padding:3px; margin:0 0 18px; background:var(--card); }
  .sort-toggle a { padding:6px 14px; color:var(--muted); text-decoration:none; border-radius:6px; font-size:.85rem; transition:color .12s, background .12s; }
  .sort-toggle a:hover { color:var(--fg); }
  .sort-toggle a.active { background:#1a2236; color:var(--accent); }
  ${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/leaderboard")}
<div class="wrap">

<h1>x402 Leaderboard</h1>
<p class="sub">Public on-chain ranking of the x402 sellers we can see: discovered from the Coinbase CDP Bazaar, the PayAI discovery catalog and our own crawl, and ranked by ${sortMode === "calls" ? "raw call volume" : "settled USDC volume"} on Base. A seller ranks here only once it settles inside the window, so this is not a roster of everyone listed - the card below reports how many ranked out of how many were scanned. Window: <b>${esc(windowHuman)}</b>. Snapshot is cached and refreshed hourly.</p>

${sortToggle}

<div class="grid">
  <div class="stat"><div class="k">Top seller (${esc(windowLabel)})</div><div class="v" style="font-size:1.05rem">${esc(top1?.name || "-")}</div><div class="s">${esc(top1 ? (sortMode === "calls" ? (top1.callsSettled || 0) + " calls · " + fmtUsd(top1.totalUsd) : fmtUsd(top1.totalUsd) + " · " + (top1.callsSettled || 0) + " calls") : "no data yet")}</div></div>
  <div class="stat"><div class="k">Sellers ranked</div><div class="v">${esc(board.length)}</div><div class="s">of ${esc(snapshot?.scannedSellers ?? 0)} scanned (${esc(snapshot?.bazaarTotal ?? "?")} Bazaar listings)</div></div>
  <div class="stat"><div class="k">Total volume (${esc(windowLabel)})</div><div class="v">${esc(fmtUsd(totalUsd))}</div><div class="s">across ${esc(totalCalls)} settled call${totalCalls === 1 ? "" : "s"}</div></div>
  <div class="stat"><div class="k">Window</div><div class="v" style="font-size:1.05rem">Last ${esc(windowLabel)}</div><div class="s">${esc(snapshot?.scannedBlocks ?? "-")} blocks · per-call ceiling ${esc(fmtUsd(snapshot?.maxCallUsd ?? 0))}</div></div>
  <div class="stat"><div class="k">Snapshot</div><div class="v" style="font-size:1rem">${esc(asOf)}</div><div class="s">refresh the page to update</div></div>
</div>

<div class="panel">
  <div class="ph"><h2>Sellers by ${sortMode === "calls" ? "call count" : "settled volume"} (${esc(windowHuman)})</h2><div class="pn">Wallet links open Basescan token-transfer view for independent verification. <b>${sortMode === "calls" ? "0 calls" : "$0"} ≠ no revenue</b> - sellers with bursty traffic may have lifetime ${sortMode === "calls" ? "activity" : "volume"} outside this window.</div></div>
  <table>
    <thead><tr><th class="num">#</th><th>Seller</th><th>Wallet</th><th>Network</th><th class="num">Calls (${esc(windowLabel)})</th><th class="num">USDC settled (${esc(windowLabel)})</th><th class="num">Buyers</th></tr></thead>
    <tbody>${rows || emptyState}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>How the ranking is built</h2><div class="pn">Trustless on-chain signal - no self-reported counters.</div></div>
  <div style="padding:14px 18px;">
    <ol class="foot" style="margin:0 0 10px 18px; padding:0;">
      <li>Walk the Coinbase CDP Bazaar and PayAI discovery APIs and extract every Base-mainnet USDC <code>payTo</code> wallet (x402 v2 <code>eip155:8453</code> or v1 <code>base</code>), counting a resource listed in both once.</li>
      <li>Query <code>eth_getLogs</code> on Base USDC for Transfer events to those wallets over the <b>${esc(windowHuman)}</b> (${esc(snapshot?.scannedBlocks ?? "?")} blocks).</li>
      <li>Filter to per-call settlements (≤ ${esc(fmtUsd(snapshot?.maxCallUsd ?? 0))}); larger inbound transfers are funding/swaps, not tool buys.</li>
      <li>Aggregate by recipient wallet, then fold by canonical website host → callsSettled, totalUsd, uniqueBuyers per operator. An operator listing multiple wallets under one site becomes one row with summed volume and unioned buyers (and a <code>+N more</code> badge listing the extra wallets).</li>
      <li>Measure, per row, what share of its settlements and its USDC come from its single busiest payer. A row flagged <code>1 payer N%</code> draws that much of its volume from one wallet: hover it for the row recomputed without that payer. Thresholds are ${esc(Math.round(CONCENTRATION.majority * 100))}% (majority) and ${esc(Math.round(CONCENTRATION.supermajority * 100))}% (supermajority) on either share, published on <code>/api/leaderboard</code> so the flag is reproducible from the two numbers.</li>
      <li>Measure how many DISTINCT sellers on this board each payer settles with. A row flagged <code>cross-seller N%</code> draws that share of its settlements from wallets that also pay ${esc(PAYER_BREADTH.multiSellerMin)}+ other sellers here - evaluators and scanners walking the ecosystem rather than customers who chose one seller. Breadth is measured against the sellers we index, never the whole chain.</li>
      <li>Payer addresses are never published on any of these surfaces. A seller's payer roster is their customer list, the same rule we apply to our own buyers on <a href="/revenue">/revenue</a>. Our own row is measured and flagged on identical terms.</li>
      <li>Rank by totalUsd; tiebreak on activity, then alphabetical.</li>
      <!-- A concentration flag is a MEASUREMENT, and next to a named business a
           measurement invites an inference we have not made and cannot prove.
           Say what it does not mean, in the methodology, where the figure is
           explained - and name a route to have a row corrected. -->
      <li><strong>What a concentration flag is not.</strong> <code>1 payer N%</code> and <code>cross-seller N%</code> report the distribution of on-chain settlements we observed, nothing more. A concentrated row is the expected shape for a seller with one large integration partner, a seller in its first weeks, or a seller whose buyers run many agents from one wallet. We are not asserting that any flagged row is inauthentic, and no row here is a judgement about a business or its operators.</li>
      <li><strong>Corrections.</strong> Every figure is an on-chain reading as of the scan above and may be stale or, where wallets fold to the wrong operator, simply wrong. A seller who believes their row misreads them can write to <a href="mailto:mike@agent402.tools">mike@agent402.tools</a> and we will re-scan and correct or withdraw it.</li>
    </ol>
    <pre>curl -s ${esc(baseUrl)}/api/leaderboard?top=10
curl -s ${esc(baseUrl)}/api/leaderboard?include=external   # exclude Agent402 itself
curl -s ${esc(baseUrl)}/api/leaderboard?window=7d           # window hint (default; 24h/30d/all documented, roadmap)</pre>
    <p class="foot" style="margin:10px 0 0;">Free - same gate as <code>/api/find</code> and <code>/api/route</code>. JSON snapshot at <code>${esc(baseUrl)}/api/leaderboard</code>.</p>
  </div>
</div>

<p class="foot">x402 Leaderboard is open-source - part of <a href="${REPO_URL}">Agent402</a>. Sellers don't have to register: any wallet that appears in the Bazaar or the PayAI catalog with Base-mainnet USDC payment options is scanned automatically.</p>

</div>
${renderFooter()}
</body></html>`);
}
