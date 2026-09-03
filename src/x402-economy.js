// x402 Economy history/data machinery — live, chain-wide analytics on
// gasless USDC settlements on Base: the on-chain footprint of the x402
// economy.
//
// Method: an x402 "exact" payment settles as an EIP-3009
// transferWithAuthorization on USDC — one transaction on the USDC
// contract that emits BOTH `Transfer(from,to,value)` and
// `AuthorizationUsed(authorizer,nonce)`. We count Transfer events whose
// transaction also emitted AuthorizationUsed, chain-wide (every seller, not
// just us), via the CDP SQL API over decoded base.events. This includes any
// gasless authorized USDC transfer (x402 facilitators dominate this
// pattern).
//
// Data flows through the SAME paid `onchain-sql` tool users can buy. Results
// cache 30 min server-side (and lean on CDP's own 15-min query cache), so a
// caller costs at most a few queries per half hour regardless of traffic.
//
// The standalone /x402-economy page was folded into /index's "The economy,
// over time" section (id="economy") — /x402-economy now 301s there. This
// module keeps only the history recorder and the snapshot builder; the JSON
// endpoint (/api/x402-economy) is unchanged and still machine-readable.
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CDP_TOOLS } from "./tools/cdp-kit.js";

// Persistent daily history — the live query only reaches back 30 days, so
// every snapshot upserts its daily rows into SQLite (same /data-volume
// pattern as stats/revenue-ledger). History compounds forever; the weekly
// report reads trailing complete weeks from here, not from the query window.
//
// The open is GUARDED: since the /index fold this module loads at boot, so a
// missing/deleted DB directory must degrade to "history unavailable" - it
// must never crash the server (it did exactly that in CI, 2026-07-11, via an
// inherited X402_ECONOMY_DB pointing into a removed temp dir).
const HISTORY_DB = process.env.X402_ECONOMY_DB || join(existsSync("/data") ? "/data" : "/tmp", "agent402-economy.db");
let hdb = null;
try {
  mkdirSync(dirname(HISTORY_DB), { recursive: true });
  hdb = new Database(HISTORY_DB);
  hdb.pragma("journal_mode = WAL");
} catch (e) {
  console.warn(`x402-economy: history DB unavailable (${String(e?.message || e).slice(0, 120)}) - daily history disabled`);
  hdb = null;
}
let upsertDay = null;
if (hdb) {
  hdb.exec(`CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY,
  settlements INTEGER NOT NULL,
  payers INTEGER NOT NULL,
  updated_ts INTEGER
)`);
  upsertDay = hdb.prepare(`INSERT INTO daily (day, settlements, payers, updated_ts)
  VALUES (@day, @settlements, @payers, @updated_ts)
  ON CONFLICT (day) DO UPDATE SET settlements = excluded.settlements, payers = excluded.payers, updated_ts = excluded.updated_ts`);
}

/** Upsert a snapshot's daily rows into the persistent history. Exported for tests. */
export function recordDailyHistory(daily) {
  if (!hdb) return; // history disabled - nothing to record
  const now = Math.floor(Date.now() / 1000);
  const tx = hdb.transaction((rows) => {
    for (const d of rows) {
      if (d?.day && Number.isFinite(d.settlements)) {
        upsertDay.run({ day: String(d.day), settlements: d.settlements, payers: d.payers ?? 0, updated_ts: now });
      }
    }
  });
  tx(daily || []);
}

/** Week-over-week from stored history: the trailing 7 COMPLETE days (today
 *  excluded — it's partial) vs the 7 before them. Exported for tests. */
export function weeklyFromHistory(todayIso = new Date().toISOString().slice(0, 10)) {
  if (!hdb) return { thisWeek: null, lastWeek: null, growthPct: null, historyDays: 0 };
  const rows = hdb.prepare("SELECT day, settlements, payers FROM daily WHERE day < ? ORDER BY day DESC LIMIT 14").all(todayIso);
  const sum = (slice) => ({
    settlements: slice.reduce((s, r) => s + r.settlements, 0),
    payersPeak: slice.reduce((m, r) => Math.max(m, r.payers), 0),
    days: slice.length,
  });
  const thisWeek = sum(rows.slice(0, 7));
  const lastWeek = sum(rows.slice(7, 14));
  const growthPct = lastWeek.settlements > 0
    ? Number((((thisWeek.settlements - lastWeek.settlements) / lastWeek.settlements) * 100).toFixed(1))
    : null;
  return { thisWeek, lastWeek, growthPct, historyDays: hdb.prepare("SELECT COUNT(*) AS n FROM daily").get().n };
}

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sequential + 429-retry: CDP rate-limits concurrent SQL calls, and under the
// 30-minute snapshot cache a few extra seconds per refresh cost nothing.
async function runSql(sql) {
  const tool = CDP_TOOLS.find((t) => t.slug === "onchain-sql");
  for (let attempt = 1; ; attempt++) {
    try {
      return await tool.handler({ sql, cacheSeconds: 900 });
    } catch (e) {
      if (e?.statusCode === 429 && attempt < 4) { await sleep(4000 * attempt); continue; }
      throw e;
    }
  }
}

const utcStamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
const DAY_MS = 24 * 60 * 60 * 1000;

// Daily settlements over the last 30 days — from AuthorizationUsed ALONE.
// Every EIP-3009 settle emits exactly one AuthorizationUsed, and its
// `authorizer` parameter IS the payer, so counts + unique payers need no
// join with the (enormous) Transfer stream. The joined 30-day variant blew
// CDP's per-query budget (HTTP 502); this one is cheap at any window.
const dailyQuery = (since) => `
SELECT
  toDate(block_timestamp) AS day,
  count() AS settlements,
  uniqExact(toString(parameters['authorizer'])) AS payers
FROM base.events
WHERE address = '${USDC_BASE}'
  AND event_name = 'AuthorizationUsed'
  AND block_timestamp >= '${since}'
GROUP BY day
ORDER BY day DESC
LIMIT 31`;

// Dollar volume needs the Transfer values, so it joins — bounded to 7 days,
// the window the engine handles comfortably (validated live in CI).
const volumeQuery = (since) => `
WITH auth_txs AS (
  SELECT DISTINCT transaction_hash
  FROM base.events
  WHERE address = '${USDC_BASE}'
    AND event_name = 'AuthorizationUsed'
    AND block_timestamp >= '${since}'
)
SELECT
  count() AS settlements,
  uniqExact(toString(parameters['from'])) AS payers,
  uniqExact(toString(parameters['to'])) AS merchants,
  sum(toUInt256OrZero(toString(parameters['value']))) AS volume_units
FROM base.events
WHERE address = '${USDC_BASE}'
  AND event_name = 'Transfer'
  AND block_timestamp >= '${since}'
  AND transaction_hash IN (SELECT transaction_hash FROM auth_txs)
LIMIT 1`;

// Top receiving wallets (merchants) over the last 7 days.
const merchantsQuery = (since) => `
WITH auth_txs AS (
  SELECT DISTINCT transaction_hash
  FROM base.events
  WHERE address = '${USDC_BASE}'
    AND event_name = 'AuthorizationUsed'
    AND block_timestamp >= '${since}'
)
SELECT
  toString(parameters['to']) AS merchant,
  count() AS payments,
  uniqExact(parameters['from']) AS payers,
  sum(toUInt256OrZero(toString(parameters['value']))) AS volume_units
FROM base.events
WHERE address = '${USDC_BASE}'
  AND event_name = 'Transfer'
  AND block_timestamp >= '${since}'
  AND transaction_hash IN (SELECT transaction_hash FROM auth_txs)
GROUP BY merchant
ORDER BY payments DESC
LIMIT 12`;

const usd = (units) => Number(units || 0) / 1e6;

let cached = null;
let cachedAt = 0;
let inFlight = null;
// 3 hours, not 30 minutes.
//
// Every refresh is 3 BILLED CDP SQL queries, and the numbers they fetch are
// aggregates over 7- and 30-DAY windows. Refreshing a 30-day total every 30
// minutes is 48 paid rebuilds a day to move a figure by a rounding error: it
// was ~4,300 queries/month (~$36) for precision nobody can perceive on a
// dashboard. At 3 hours it is 8 rebuilds a day, ~720/month, ~$6.
//
// This is the one paid query we keep: it is the only way to see the WHOLE
// market (15,323 merchants, $12.7M volume). The leaderboard's free eth_getLogs
// path can only count wallets we already know from Bazaar - 25 of them - so it
// cannot answer "how big is x402" at all. Stale-while-revalidate is unchanged,
// so no visitor waits on the rebuild either way.
const ECONOMY_FRESH_MS = Number(process.env.ECONOMY_FRESH_MS) || 3 * 60 * 60 * 1000;

// Build the snapshot from scratch — the ~500ms on-chain read. Never throws:
// per-query failures are collected into out.errors so a partial read still
// renders. Cache bookkeeping lives in startEconomyRefresh, not here.
async function buildEconomySnapshot() {
  const out = {
    spec: "agent402-x402-economy/1",
    asOf: new Date().toISOString(),
    method: "EIP-3009 gasless USDC settlements on Base: Transfer events whose transaction also emitted AuthorizationUsed on the USDC contract - the settlement primitive x402 uses, measured chain-wide across every seller.",
    chain: "base (eip155:8453)",
    daily: [], topMerchants: [], totals: {}, errors: [],
  };
  const settle = (p) => p.then((value) => ({ status: "fulfilled", value })).catch((reason) => ({ status: "rejected", reason }));
  // Sequential on purpose — see runSql. allSettled semantics preserved so one
  // failed query still leaves the others rendering.
  const dailyRes = await settle(runSql(dailyQuery(utcStamp(30 * DAY_MS))));
  const volRes = await settle(runSql(volumeQuery(utcStamp(7 * DAY_MS))));
  const merchRes = await settle(runSql(merchantsQuery(utcStamp(7 * DAY_MS))));
  if (dailyRes.status === "fulfilled") {
    out.daily = (dailyRes.value.rows || []).map((r) => ({
      day: r.day,
      settlements: Number(r.settlements),
      payers: Number(r.payers),
    }));
    out.totals.last30d = { settlements: out.daily.reduce((s, d) => s + d.settlements, 0) };
    try { recordDailyHistory(out.daily); } catch (e) { out.errors.push(`history: ${String(e?.message || e).slice(0, 80)}`); }
  } else {
    out.errors.push(`daily: ${String(dailyRes.reason?.message || dailyRes.reason).slice(0, 200)}`);
  }
  try { out.weekly = weeklyFromHistory(); } catch (e) { out.errors.push(`weekly: ${String(e?.message || e).slice(0, 80)}`); }
  if (volRes.status === "fulfilled") {
    const r = volRes.value.rows?.[0] || {};
    out.totals.last7d = {
      settlements: Number(r.settlements || 0),
      payers: Number(r.payers || 0),
      merchants: Number(r.merchants || 0),
      volumeUsd: Number(usd(r.volume_units).toFixed(2)),
    };
  } else {
    out.errors.push(`volume: ${String(volRes.reason?.message || volRes.reason).slice(0, 200)}`);
  }
  if (merchRes.status === "fulfilled") {
    out.topMerchants = (merchRes.value.rows || []).map((r) => ({
      merchant: r.merchant,
      payments: Number(r.payments),
      payers: Number(r.payers),
      volumeUsd: Number(usd(r.volume_units).toFixed(2)),
    }));
  } else {
    out.errors.push(`merchants: ${String(merchRes.reason?.message || merchRes.reason).slice(0, 200)}`);
  }
  return out;
}

// Kick off (or join) a single in-flight rebuild, committing the result to the
// cache when it lands. Only cache successful reads for the full window; errored
// reads expire in ~5 min instead of 30 so a transient upstream failure retries
// sooner. Deduped: a concurrent burst runs one query, not one per caller.
function startEconomyRefresh() {
  if (inFlight) return inFlight;
  inFlight = buildEconomySnapshot()
    .then((out) => {
      cached = out;
      cachedAt = out.errors.length ? Date.now() - 25 * 60 * 1000 : Date.now();
      return out;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// Stale-while-revalidate. A fresh cache returns as-is; a stale-but-present
// cache is served immediately while a background rebuild runs, so no visitor
// ever waits on the on-chain read; only a cold cache (the first request after
// boot) awaits the build.
/**
 * The cached snapshot, or null — SYNCHRONOUS, and never triggers a fetch.
 *
 * For callers on a request-serving path that want on-chain evidence if it is
 * already in hand but must not block on a ~500ms CDP query to get it (the
 * router's proven-ness join). Returning null when cold is deliberate: a caller
 * that cannot tell "no evidence yet" from "no evidence exists" would treat a
 * cold boot as proof that nobody has settled.
 */
export function economySnapshotCached() {
  return cached;
}

export async function x402EconomySnapshot() {
  if (cached && Date.now() - cachedAt < ECONOMY_FRESH_MS) return cached;
  if (cached) {
    startEconomyRefresh().catch(() => {}); // stale cache stays valid on failure
    return cached;
  }
  return startEconomyRefresh();
}

/** Build the snapshot ONCE at boot so no visitor is ever the cold one.
 *
 *  The cache is stale-while-revalidate, so only a COLD cache blocks - and the
 *  cache is cold exactly once per deploy. Measured by an outside reviewer
 *  2026-08-28: /marketplace took 5.58 s wall clock on that first request,
 *  against 0.25-0.42 s warm, and we deployed ~25 times that day, so the odds
 *  of a crawler or a partner landing on the cold one were not small. Unref'd
 *  and delayed so it never competes with the boot path or the readiness
 *  probe, and a failure is swallowed: this is a warm-up, not a dependency.
 */
export function warmEconomySnapshot({ delayMs = 20_000 } = {}) {
  if (String(process.env.X402_SYNC_ON_START || "").toLowerCase() === "false") return null;
  const t = setTimeout(() => {
    if (cached) return; // a visitor already paid for it; nothing to warm
    startEconomyRefresh().catch(() => {});
  }, delayMs);
  t.unref?.();
  return t;
}

// esc/fmt formatting for the rendered section now live in x402-index.js,
// next to the section that consumes this snapshot.
