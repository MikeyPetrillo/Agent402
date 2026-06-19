// x402 Leaderboard — the first public on-chain ranking of x402 sellers.
//
// There's no central registry of "who's most used in x402". The protocol is too
// young. But every seller registered on the Coinbase CDP Bazaar publishes a
// `payTo` wallet alongside their resource listing, and every settled call moves
// USDC on Base. That's the trustless signal: rank sellers by their actual
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

import { fetchAllBazaarItems as walkBazaar } from "./bazaar-pager.js";
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

// Base block time is ~2s, so 24h ≈ 43200 blocks. A wider window than the old
// 5h default surfaces sellers with bursty (vs. constant) traffic — without it,
// any seller below ~9 calls/sec averaged over 5h shows $0 even when their
// lifetime revenue is real. 24h is the right default for "is this seller
// actually used"; ?window= is the hook for the deep-cache rollout (7d/30d).
const SECONDS_PER_BASE_BLOCK = 2;
const DEFAULTS = {
  bazaarUrl: process.env.BAZAAR_URL || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
  spanBlocks: parseInt(process.env.SPAN_BLOCKS || "43200", 10), // ~24h of Base blocks
  // Free-tier Base RPCs cap eth_getLogs at 10,000 blocks per call; chunk a wide
  // window into ranges no larger than this so it still scans cleanly.
  chunkBlocks: parseInt(process.env.CHUNK_BLOCKS || "9000", 10),
  maxCallUsd: parseFloat(process.env.MAX_CALL_USD || "0.5"),
  // Public RPCs limit topic-filter array length; chunk the wallet list per call
  // so a corpus with thousands of unique payTo addresses still scans cleanly.
  walletChunk: parseInt(process.env.WALLET_CHUNK || "200", 10),
  bazaarPageSize: parseInt(process.env.BAZAAR_PAGE_SIZE || "1000", 10),
  bazaarMaxPages: parseInt(process.env.BAZAAR_MAX_PAGES || "200", 10),
  // 0 = no cap. Useful for keeping the on-chain scan tight when the Bazaar grows.
  maxWalletsScan: parseInt(process.env.MAX_WALLETS_SCAN || "0", 10),
  rpcs: (process.env.BASE_RPCS || [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.llamarpc.com",
    "https://base.drpc.org",
  ].join(",")).split(",").map((s) => s.trim()).filter(Boolean),
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

/**
 * Pull the Base-mainnet payment wallet from a Bazaar item's `accepts[]`. An
 * item lists multiple payment options (different chains/schemes); for ranking
 * we only credit Base-mainnet USDC. Other chains and testnets stay out.
 *
 * Returns { wallet, network } or null. Wallet is lowercase-normalised so it
 * matches eth_getLogs `to` topics (which are zero-padded lowercase hex).
 */
export function baseUsdcPayToFromItem(item) {
  const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
  for (const a of accepts) {
    if (a?.network !== BASE_MAINNET) continue;
    const asset = String(a.asset || "").toLowerCase();
    if (asset && asset !== USDC) continue;
    const w = a.payTo;
    if (typeof w !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(w)) continue;
    return { wallet: w.toLowerCase(), network: "base" };
  }
  return null;
}

/**
 * Group Bazaar items by Base-mainnet payTo wallet. One seller can list many
 * endpoints under one payTo; the leaderboard ranks per wallet, not per
 * endpoint. Each row carries: name (most common serviceName across the
 * wallet's endpoints), origins (set of host origins), endpoints (count).
 */
export function extractWalletsFromBazaar(payload) {
  const list =
    payload?.resources ||
    payload?.items ||
    payload?.data ||
    (Array.isArray(payload) ? payload : []);
  const byWallet = new Map();
  for (const item of list) {
    const pay = baseUsdcPayToFromItem(item);
    if (!pay) continue;
    const origin = originOf(item?.resource || item?.url || item?.endpoint || item?.homepage);
    if (!byWallet.has(pay.wallet)) {
      byWallet.set(pay.wallet, {
        wallet: pay.wallet,
        network: pay.network,
        origins: new Set(),
        names: new Map(), // name → count, so we can pick the most common
        endpoints: 0,
      });
    }
    const row = byWallet.get(pay.wallet);
    if (origin) row.origins.add(origin);
    const name = String(item?.serviceName || item?.name || "").trim();
    if (name) row.names.set(name, (row.names.get(name) || 0) + 1);
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
    };
  });
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
export function aggregateLeaderboard(transfers, sellers, { maxCallUsd = DEFAULTS.maxCallUsd } = {}) {
  // 1. Per-wallet credit (the join key we have to use because eth_getLogs is
  //    wallet-addressed).
  const byWallet = new Map();
  for (const s of sellers) {
    byWallet.set(s.wallet, {
      ...s,
      callsSettled: 0,
      totalUsd: 0,
      buyers: new Set(),
    });
  }
  for (const t of transfers) {
    const row = byWallet.get(t.wallet);
    if (!row) continue;
    if (!(t.usd > 0) || t.usd > maxCallUsd) continue;
    row.callsSettled += 1;
    row.totalUsd += t.usd;
    if (t.payer) row.buyers.add(t.payer);
  }

  // 2. Fold per-wallet rows into per-operator groups. Group key = canonical
  //    host when we can derive one; otherwise the wallet itself (so listings
  //    without a homepage stay as standalone rows rather than collapsing into
  //    a single "no-website" mega-group).
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
        buyers: new Set(),
        members: [], // [{ wallet, name, callsSettled, totalUsd, endpoints }]
      });
    }
    const g = groups.get(key);
    g.callsSettled += w.callsSettled;
    g.totalUsd += w.totalUsd;
    for (const b of w.buyers) g.buyers.add(b);
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
        uniqueBuyers: g.buyers.size,
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

async function rpcCall(rpcs, method, params, { passes = 2 } = {}) {
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
        catch { lastErr = new Error(`${url}: non-JSON (${r.status})`); continue; }
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 160)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (attempt < passes - 1) await sleep(1500 * (attempt + 1));
  }
  throw new Error(`All RPCs failed for ${method}: ${lastErr?.message}`);
}

// --- pipeline ---------------------------------------------------------------

/** Render a block count as a human-friendly window label ("5h", "24h", "7d"). */
export function windowLabelFromBlocks(blocks) {
  const seconds = (Number(blocks) || 0) * SECONDS_PER_BASE_BLOCK;
  if (seconds <= 0) return "—";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

const emptySnapshot = (opts, reason) => ({
  spec: "x402-leaderboard/1",
  asOf: new Date().toISOString(),
  scannedBlocks: opts.spanBlocks,
  windowLabel: windowLabelFromBlocks(opts.spanBlocks),
  maxCallUsd: opts.maxCallUsd,
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
  const opts = { ...DEFAULTS, ...overrides };
  const onProgress = overrides.onProgress || (() => {});

  // 1. Bazaar discovery (paginated) → per-item payTo for Base-mainnet USDC.
  onProgress(`[1/3] Fetching Bazaar discovery (${opts.bazaarUrl})…`);
  const { items, total } = await fetchAllBazaarItems(opts.bazaarUrl, opts);
  let sellers = extractWalletsFromBazaar({ items });
  onProgress(`      ${items.length}/${total ?? "?"} listings → ${sellers.length} unique Base-mainnet wallets`);
  if (!sellers.length) return emptySnapshot(opts, "no Base-mainnet payTo wallets found in Bazaar");

  // Optional cap: keep the on-chain scan tight by ranking by listing count first.
  if (opts.maxWalletsScan > 0 && sellers.length > opts.maxWalletsScan) {
    sellers = sellers.slice().sort((a, b) => b.endpoints - a.endpoints).slice(0, opts.maxWalletsScan);
    onProgress(`      capping scan to top ${opts.maxWalletsScan} wallets by listing count`);
  }

  // 2. Query USDC transfers — chunk both the block range AND the wallet array,
  //    since free-tier RPCs limit each.
  const wallets = [...new Set(sellers.map((s) => s.wallet))];
  onProgress(`[2/3] Scanning Base USDC transfers (${opts.spanBlocks} blocks, ${wallets.length} wallets)…`);
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
  const logs = [];
  for (const [from, to] of blockChunks) {
    for (const chunk of walletChunks) {
      const part = await rpcCall(opts.rpcs, "eth_getLogs", [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        address: USDC,
        topics: [TRANSFER, null, chunk],
      }]);
      if (Array.isArray(part)) for (const l of part) logs.push(l);
    }
  }
  onProgress(`      ${logs.length} transfer log(s) total`);

  // 3. Aggregate.
  onProgress(`[3/3] Aggregating leaderboard…`);
  const transfers = logs.map((l) => ({
    wallet: ("0x" + l.topics[2].slice(-40)).toLowerCase(),
    payer: payerFromLog(l),
    usd: Number(BigInt(l.data)) / 1e6,
  }));
  const ranked = aggregateLeaderboard(transfers, sellers, { maxCallUsd: opts.maxCallUsd });

  return {
    spec: "x402-leaderboard/1",
    asOf: new Date().toISOString(),
    scannedBlocks: opts.spanBlocks,
    windowLabel: windowLabelFromBlocks(opts.spanBlocks),
    maxCallUsd: opts.maxCallUsd,
    scannedSellers: sellers.length,
    walletsQueried: wallets.length,
    bazaarTotal: total,
    leaderboard: ranked,
  };
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
  } catch (e) {
    cached.lastError = String(e?.message || e);
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
  refreshOnce(opts).catch(() => {});
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
  // and JSON consumers see "Last 24h" instead of an em-dash while the cache
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

const shortAddr = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || "—"));

/**
 * Public HTML dashboard for the x402 leaderboard. Self-contained: no client-side
 * polling — a page refresh re-renders from the latest cached snapshot. The
 * underlying snapshot is refreshed hourly by startLeaderboardRefresh().
 */
export function leaderboardPage(snapshot, { baseUrl }) {
  const board = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [];
  const explorer = "https://basescan.org";
  const totalUsd = board.reduce((s, r) => s + (Number(r.totalUsd) || 0), 0);
  const totalCalls = board.reduce((s, r) => s + (Number(r.callsSettled) || 0), 0);
  const top1 = board[0];

  // Bazaar items are third-party-supplied: a seller can put anything in their
  // listing's homepage field. esc() HTML-escapes but doesn't filter dangerous
  // schemes (javascript:, data:, vbscript:) — so re-check protocol before
  // turning the value into a clickable link. originOf() validates this at
  // crawl time, but cache entries can drift; cheap defense-in-depth.
  const safeHref = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
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
        : "—";
      return `<tr>
        <td class="num">${esc(r.rank)}</td>
        <td>${nameCell}</td>
        <td class="muted">${walletCell}</td>
        <td>${esc(r.network || "base")}</td>
        <td class="num">${esc(r.callsSettled ?? 0)}</td>
        <td class="num">${esc(fmtUsd(r.totalUsd))}</td>
        <td class="num">${esc(r.uniqueBuyers ?? 0)}</td>
      </tr>`;
    })
    .join("");

  const emptyState = snapshot?.warming
    ? `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Warming the cache — first snapshot is in flight. Refresh in a few seconds.</td></tr>`
    : snapshot?.scanSkipped
    ? `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Snapshot skipped: ${esc(snapshot.reason || "no data")}</td></tr>`
    : `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No settled volume yet. Snapshot refreshes hourly.</td></tr>`;

  const asOf = snapshot?.asOf ? snapshot.asOf.replace("T", " ").slice(0, 19) + "Z" : "—";
  const windowLabel = snapshot?.windowLabel || windowLabelFromBlocks(snapshot?.scannedBlocks);
  const windowHuman = windowLabel === "—" ? "the scan window" : `last ${windowLabel}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 Leaderboard — Agent402</title>
<meta name="description" content="Public on-chain ranking of every x402 seller by Base USDC settled volume — callsSettled, totalUsd, uniqueBuyers per seller.">
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
  ${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/leaderboard")}
<div class="wrap">

<h1>x402 Leaderboard</h1>
<p class="sub">Public on-chain ranking of every x402 seller listed on the Coinbase CDP Bazaar, ranked by settled USDC volume on Base. Window: <b>${esc(windowHuman)}</b>. Snapshot is cached and refreshed hourly.</p>

<div class="grid">
  <div class="stat"><div class="k">Top seller (${esc(windowLabel)})</div><div class="v" style="font-size:1.05rem">${esc(top1?.name || "—")}</div><div class="s">${esc(top1 ? fmtUsd(top1.totalUsd) + " · " + (top1.callsSettled || 0) + " calls" : "no data yet")}</div></div>
  <div class="stat"><div class="k">Sellers ranked</div><div class="v">${esc(board.length)}</div><div class="s">of ${esc(snapshot?.scannedSellers ?? 0)} scanned (${esc(snapshot?.bazaarTotal ?? "?")} Bazaar listings)</div></div>
  <div class="stat"><div class="k">Total volume (${esc(windowLabel)})</div><div class="v">${esc(fmtUsd(totalUsd))}</div><div class="s">across ${esc(totalCalls)} settled call${totalCalls === 1 ? "" : "s"}</div></div>
  <div class="stat"><div class="k">Window</div><div class="v" style="font-size:1.05rem">Last ${esc(windowLabel)}</div><div class="s">${esc(snapshot?.scannedBlocks ?? "—")} blocks · per-call ceiling ${esc(fmtUsd(snapshot?.maxCallUsd ?? 0))}</div></div>
  <div class="stat"><div class="k">Snapshot</div><div class="v" style="font-size:1rem">${esc(asOf)}</div><div class="s">refresh the page to update</div></div>
</div>

<div class="panel">
  <div class="ph"><h2>Sellers by settled volume (${esc(windowHuman)})</h2><div class="pn">Wallet links open Basescan token-transfer view for independent verification. <b>$0 ≠ no revenue</b> — sellers with bursty traffic may have lifetime volume outside this window.</div></div>
  <table>
    <thead><tr><th class="num">#</th><th>Seller</th><th>Wallet</th><th>Network</th><th class="num">Calls (${esc(windowLabel)})</th><th class="num">USDC settled (${esc(windowLabel)})</th><th class="num">Buyers</th></tr></thead>
    <tbody>${rows || emptyState}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>How the ranking is built</h2><div class="pn">Trustless on-chain signal — no self-reported counters.</div></div>
  <div style="padding:14px 18px;">
    <ol class="foot" style="margin:0 0 10px 18px; padding:0;">
      <li>Walk the Coinbase CDP Bazaar discovery API and extract every Base-mainnet USDC <code>payTo</code> wallet.</li>
      <li>Query <code>eth_getLogs</code> on Base USDC for Transfer events to those wallets over the <b>${esc(windowHuman)}</b> (${esc(snapshot?.scannedBlocks ?? "?")} blocks).</li>
      <li>Filter to per-call settlements (≤ ${esc(fmtUsd(snapshot?.maxCallUsd ?? 0))}); larger inbound transfers are funding/swaps, not tool buys.</li>
      <li>Aggregate by recipient wallet, then fold by canonical website host → callsSettled, totalUsd, uniqueBuyers per operator. An operator listing multiple wallets under one site becomes one row with summed volume and unioned buyers (and a <code>+N more</code> badge listing the extra wallets).</li>
      <li>Rank by totalUsd; tiebreak on activity, then alphabetical.</li>
    </ol>
    <pre>curl -s ${esc(baseUrl)}/api/leaderboard?top=10
curl -s ${esc(baseUrl)}/api/leaderboard?include=external   # exclude Agent402 itself
curl -s ${esc(baseUrl)}/api/leaderboard?window=24h         # window hint (default; 7d/30d coming)</pre>
    <p class="foot" style="margin:10px 0 0;">Free — same gate as <code>/api/find</code> and <code>/api/route</code>. JSON snapshot at <code>${esc(baseUrl)}/api/leaderboard</code>.</p>
  </div>
</div>

<p class="foot">x402 Leaderboard is open-source — part of <a href="https://github.com/MikeyPetrillo/Agent402">Agent402</a>. Sellers don't have to register: any wallet that appears in the Bazaar with Base-mainnet USDC payment options is scanned automatically.</p>

</div>
${renderFooter()}
</body></html>`;
}
