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

const DEFAULTS = {
  bazaarUrl: process.env.BAZAAR_URL || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
  spanBlocks: parseInt(process.env.SPAN_BLOCKS || "9000", 10), // ~5h of Base blocks
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
    const topName = [...r.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
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
 * Aggregate transfer logs into a per-seller leaderboard. Counts only settlements
 * within the per-call ceiling (per-call buys are ≤maxCallUsd; larger inbound is
 * funding/swaps and not what we're ranking).
 *
 * `transfers`: [{ wallet, payer, usd }]  — `wallet` is the recipient (lowercase)
 * `sellers`:   [{ wallet, name, network, origins, homepage, endpoints }]
 *
 * Returns ranked array. Ties on totalUsd break on callsSettled (more activity
 * wins), then alphabetical (purely deterministic — no informational signal).
 */
export function aggregateLeaderboard(transfers, sellers, { maxCallUsd = DEFAULTS.maxCallUsd } = {}) {
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
  const ranked = [...byWallet.values()]
    .map((r) => ({
      name: r.name,
      origins: r.origins || [],
      homepage: r.homepage,
      endpoints: r.endpoints ?? null,
      wallet: r.wallet,
      network: r.network,
      callsSettled: r.callsSettled,
      totalUsd: Number(r.totalUsd.toFixed(6)),
      uniqueBuyers: r.buyers.size,
    }))
    .sort((a, b) => {
      if (b.totalUsd !== a.totalUsd) return b.totalUsd - a.totalUsd;
      if (b.callsSettled !== a.callsSettled) return b.callsSettled - a.callsSettled;
      return a.name.localeCompare(b.name);
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

// Fetch every page of the Bazaar discovery endpoint. The Bazaar paginates at
// up to 1000 items per page (default 100) and reports a `total` we walk to.
async function fetchAllBazaarItems(baseUrl, opts) {
  const { bazaarPageSize, bazaarMaxPages } = opts;
  const items = [];
  let offset = 0;
  let total = null;
  for (let p = 0; p < bazaarMaxPages; p++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}limit=${bazaarPageSize}&offset=${offset}`;
    const page = await fetchJson(url);
    const pageItems = page?.items || page?.resources || (Array.isArray(page) ? page : []);
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    for (const it of pageItems) items.push(it);
    total = page?.pagination?.total ?? total;
    offset += pageItems.length;
    if (total != null && offset >= total) break;
    if (pageItems.length < bazaarPageSize) break;
  }
  return { items, total };
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

const emptySnapshot = (opts, reason) => ({
  spec: "x402-leaderboard/1",
  asOf: new Date().toISOString(),
  scannedBlocks: opts.spanBlocks,
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
  return {
    spec: "x402-leaderboard/1",
    asOf: new Date().toISOString(),
    warming: true,
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
