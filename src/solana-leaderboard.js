// Solana SPL leaderboard: inbound USDC credits per seller payTo on Solana,
// scanned INCREMENTALLY, persisted, and PRIMED into the pay-time gate.
//
// Why (2026-09-02): Solana was the one rail where proven-ness rested on a
// pay-time read alone. Every routed buy re-read the seller's USDC token
// account, the resolver had no settled/payers evidence for Solana rows (the
// Base leaderboard is eth_getLogs and cannot see SPL), and nothing public said
// which Solana sellers are actually paid. The first live scan corrected a
// belief too: over 7 days 80 of 357 payTos carry credits and ten sit past the
// read cap - not "one wallet", which was a 15-hour reading.
//
// COST IS THE DESIGN CONSTRAINT. The first version re-read every active payTo's
// recent transactions each hour and cost 3,122 Alchemy calls in its first
// pass (the egress meter caught it within the hour). So each payTo keeps its
// state across cycles: its USDC token account (resolved once; a payTo with NO
// account is re-checked once a day), the newest signature already folded
// (getSignaturesForAddress `until` returns only what is new), and HOURLY
// TOTALS - payments, micro-dollars and the distinct buyers of each hour.
// A cycle costs one signatures read per payTo plus one transaction read per
// NEW payment chain-wide: the real rate of Solana x402 settlement.
//
// NO PER-SELLER CAP (2026-09-26). The board used to keep at most 2,000 events
// per payTo and read at most 120 transactions per cycle, so a seller taking
// 36,000 payments a week read "2,000" beside one taking 2,100: a ceiling,
// published as a count. Now every new payment is read every cycle and folded
// into its hour, whatever the volume. The only pacing is on the BACKFILL
// (the history a payTo had before we first saw it), which fills over a few
// cycles and says so per row (`backfilling`, `coveredFrom`) and per window
// (`windowComplete`): a partial window is labelled, never passed off as whole.
//
// Measures match the Base board: settled calls, USDC settled, distinct buyers,
// over 24h / 7d / 30d. The buyer is the owner of the USDC account the payment
// was debited from. Self-funded transfers are excluded (creditFromTx).
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { scanCoverage } from "./partial-answer.js";

export const SOLANA_LB_CACHE_FILE = process.env.SOLANA_LB_CACHE_FILE || "/data/solana-leaderboard.json";
const REFRESH_MS = Number(process.env.SOLANA_LB_REFRESH_MS) || 2 * 60 * 60_000;
const CONCURRENCY = Number(process.env.SOLANA_LB_CONCURRENCY) || 1;
const RETRY_PAUSE_MS = Number(process.env.SOLANA_LB_RETRY_PAUSE_MS) || 1500;
// Every Solana payTo the index knows (a few hundred today); the bound is a
// memory belt, far above the population, and the snapshot says if it binds.
const MAX_PAYTOS = Number(process.env.SOLANA_LB_MAX_PAYTOS) || 5000;
// Backfill pacing only: history older than the first read is filled at most
// this many transaction reads per cycle, across all payTos. New payments are
// never paced.
const BACKFILL_TX_PER_CYCLE = Number(process.env.SOLANA_LB_BACKFILL_TX_PER_CYCLE) || 4_000;
const BACKFILL_DAYS = Number(process.env.SOLANA_LB_BACKFILL_DAYS) || 7;
const RETAIN_DAYS = 30;
const NO_ACCOUNT_RECHECK_MS = Number(process.env.SOLANA_LB_NO_ACCOUNT_RECHECK_MS) || 24 * 60 * 60_000;
const SIG_PAGE = 1000;
const STALE_MS = 3 * REFRESH_MS;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_WINDOWS = { "24h": 24, "7d": 168, "30d": 720 };
const STATE_VERSION = 2;

let current = emptyBoard();
let inFlight = null;
let timer = null, kick = null, kick2 = null;

function emptyBoard() {
  return { at: 0, rows: [], scanned: 0, candidates: 0, errors: 0, windowHours: null, durationMs: 0, warm: false, rpcCalls: 0, txReads: 0, state: {} };
}

export function solanaLeaderboardEnabled() {
  return String(process.env.SOLANA_LEADERBOARD || "on").toLowerCase() !== "off";
}

const winOf = (row, w) => row?.windows?.[w] || { callsSettled: 0, totalUsd: 0, uniqueBuyers: 0 };

/** Pure: rank rows by USDC settled in `window` (Base's order), then calls, then buyers, then payTo. Marks the host's own payTo. */
export function rankSolanaRows(rows, { self = null, window = "7d" } = {}) {
  const s = self ? String(self) : null;
  const w = (r) => (r.windows ? winOf(r, window) : { callsSettled: r.credits || 0, totalUsd: 0, uniqueBuyers: r.payers || 0 });
  return [...rows]
    .map((r) => ({ ...r, self: !!(s && r.payTo === s) }))
    .sort((a, b) => (w(b).totalUsd - w(a).totalUsd) || (w(b).callsSettled - w(a).callsSettled) || (w(b).uniqueBuyers - w(a).uniqueBuyers) || String(a.payTo).localeCompare(String(b.payTo)))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Pure: fold hourly buckets into the published windows. */
export function summarizeHours(hours, { now = Date.now(), coveredFrom = null } = {}) {
  const nowSec = Math.floor(now / 1000);
  const out = {};
  for (const [name, h] of Object.entries(SOLANA_WINDOWS)) {
    const fromHour = Math.floor((nowSec - h * 3600) / 3600);
    let n = 0, micro = 0;
    const buyers = new Set();
    for (const [k, b] of Object.entries(hours || {})) {
      if (Number(k) < fromHour) continue;
      n += b.n || 0; micro += b.u || 0;
      for (const f of b.f || []) buyers.add(f);
    }
    out[name] = {
      callsSettled: n,
      totalUsd: Number((micro / 1e6).toFixed(6)),
      uniqueBuyers: buyers.size,
      // Whole only when the history we hold reaches back past the window start.
      complete: coveredFrom != null && coveredFrom <= nowSec - h * 3600,
    };
  }
  return out;
}

function addTo(hours, blockTime, amount, funder) {
  const k = String(Math.floor(Number(blockTime) / 3600));
  const b = (hours[k] ||= { n: 0, u: 0, f: [] });
  b.n += 1; b.u += Number(amount) || 0;
  if (funder && !b.f.includes(funder)) b.f.push(funder);
}
function mergeHours(into, from) {
  for (const [k, b] of Object.entries(from)) {
    const t = (into[k] ||= { n: 0, u: 0, f: [] });
    t.n += b.n; t.u += b.u;
    for (const f of b.f) if (!t.f.includes(f)) t.f.push(f);
  }
}

/**
 * Incremental read of ONE payTo. `st` is that payTo's persisted state and is
 * mutated in place. `rpc(method, params)` is the Solana JSON-RPC call;
 * `creditFromTx(meta, payTo)` the gate's pure credit rule. `budget.left` is the
 * cycle's shared BACKFILL allowance (new payments never draw on it).
 *
 * Money-safe ordering: a batch of transactions is folded into the hourly
 * totals only once every read in it has succeeded, and the cursor moves with
 * the fold, so a failure part-way leaves nothing half-counted - the next
 * cycle repeats that batch.
 */
export async function readPayToIncremental(payTo, st, { rpc, creditFromTx, windowMs = 168 * 3600e3, now = Date.now(), noAccountRecheckMs = NO_ACCOUNT_RECHECK_MS, txConcurrency = 12, budget = { left: BACKFILL_TX_PER_CYCLE }, backfillDays = BACKFILL_DAYS } = {}) {
  let rpcCalls = 0, txReads = 0;
  const call = async (m, p) => { rpcCalls++; return rpc(m, p); };
  const nowSec = Math.floor(now / 1000);
  // State from the capped design (an event list) is dropped and re-read.
  if (st.v !== STATE_VERSION) { for (const k of Object.keys(st)) if (k !== "ata" && k !== "ataCheckedAt") delete st[k]; st.v = STATE_VERSION; }
  st.hours ||= {};
  st.skipped ||= 0;
  if (st.bfFrom == null) st.bfFrom = nowSec - backfillDays * 86400;

  const finish = () => {
    const retainFrom = Math.floor((nowSec - RETAIN_DAYS * 86400) / 3600);
    for (const k of Object.keys(st.hours)) if (Number(k) < retainFrom) delete st.hours[k];
    const coveredFrom = st.ata === null ? 0 : (st.bfDone ? st.bfFrom : (st.bfOldest ?? nowSec));
    const windows = summarizeHours(st.hours, { now, coveredFrom });
    // The gate window (7 days by default) stays on `credits`/`payers`, which
    // the router's evidence and the pay-time primer read.
    const gate = (() => {
      const fromHour = Math.floor((nowSec - windowMs / 1000) / 3600);
      let n = 0; const f = new Set();
      for (const [k, b] of Object.entries(st.hours)) if (Number(k) >= fromHour) { n += b.n; for (const x of b.f) f.add(x); }
      return { n, f: f.size };
    })();
    return { credits: gate.n, payers: gate.f, windows, backfilling: st.ata !== null && !st.bfDone, coveredFrom, skipped: st.skipped, truncated: false, read: txReads, rpcCalls };
  };

  if (!st.ata) {
    if (st.ata === null && Number(st.ataCheckedAt) && now - st.ataCheckedAt < noAccountRecheckMs) return finish();
    const accounts = await call("getTokenAccountsByOwner", [payTo, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
    st.ata = accounts?.value?.[0]?.pubkey || null;
    st.ataCheckedAt = now;
    if (!st.ata) return finish();
  }

  const readTxs = async (sigs, into) => {
    const live = sigs.filter((s) => !s.err);
    for (let off = 0; off < live.length; off += txConcurrency) {
      const chunk = live.slice(off, off + txConcurrency);
      const got = await Promise.all(chunk.map(async (s) => {
        const args = [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }];
        try { return await call("getTransaction", args); }
        catch { return call("getTransaction", args); }          // one retry; a second failure fails the batch
      }));
      txReads += chunk.length;
      got.forEach((tx, i) => {
        // A transaction the RPC answers null for (pruned or not yet indexed) is
        // counted as skipped, visibly, rather than blocking the cursor forever.
        if (!tx) { st.skipped++; return; }
        const v = creditFromTx(tx.meta, payTo);
        if (v?.credited) addTo(into, chunk[i].blockTime || tx.blockTime, v.amount, v.funder);
      });
    }
    return live.length;
  };

  // 1. NEW payments since the cursor: every page, every transaction, no cap.
  if (st.lastSig) {
    const fresh = [];
    let before;
    const retainFrom = nowSec - RETAIN_DAYS * 86400;
    for (;;) {
      const params = { limit: SIG_PAGE, until: st.lastSig };
      if (before) params.before = before;
      const page = (await call("getSignaturesForAddress", [st.ata, params])) || [];
      let stop = page.length < SIG_PAGE;
      for (const s of page) {
        if (s.signature === st.lastSig || Number(s.blockTime || 0) < retainFrom) { stop = true; break; }
        fresh.push(s);
      }
      if (stop || !page.length) break;
      before = page[page.length - 1].signature;
    }
    if (fresh.length) {
      const delta = {};
      await readTxs(fresh, delta);
      mergeHours(st.hours, delta);
      st.lastSig = fresh[0].signature;
    }
  }

  // 2. BACKFILL, newest to oldest from where the first read began, paced by
  // the cycle's shared allowance. Committed a page at a time.
  while (!st.bfDone && budget.left > 0) {
    const params = { limit: Math.min(SIG_PAGE, budget.left) };
    if (st.bfBefore) params.before = st.bfBefore;
    const page = (await call("getSignaturesForAddress", [st.ata, params])) || [];
    const inRange = page.filter((s) => Number(s.blockTime || 0) >= st.bfFrom);
    const delta = {};
    budget.left -= await readTxs(inRange, delta);
    mergeHours(st.hours, delta);
    if (!st.bfBefore && !st.lastSig && page.length) st.lastSig = page[0].signature;
    if (page.length) st.bfBefore = page[page.length - 1].signature;
    const oldest = inRange.length ? Number(inRange[inRange.length - 1].blockTime || nowSec) : null;
    if (oldest != null) st.bfOldest = Math.min(st.bfOldest ?? nowSec, oldest);
    if (page.length < params.limit || inRange.length < page.length) { st.bfDone = true; break; }
  }
  return finish();
}

/**
 * One scan over `payTos`: Map(payTo -> Set(origins)). `readFn(payTo)` resolves
 * { credits, payers, truncated, rpcCalls }. A failed read is retried once,
 * then the previous row is kept marked stale (one hiccup never zeroes a
 * proven seller).
 */
export async function scanSolanaSellers(payTos, { readFn, concurrency = CONCURRENCY, now = Date.now(), previous = current.rows, maxPayTos = MAX_PAYTOS, windowHours = null, retryPauseMs = RETRY_PAUSE_MS } = {}) {
  const prevBy = new Map((previous || []).map((r) => [r.payTo, r]));
  const all = [...payTos.entries()];
  // How many there WERE to scan, kept beside how many we read. Without it the
  // board can only say "600 scanned", which a reader takes for the population.
  const candidates = all.length;
  const list = all.slice(0, maxPayTos);
  const rows = [];
  let errors = 0, cursor = 0, rpcCalls = 0, txReads = 0;
  const started = now;
  const worker = async () => {
    for (;;) {
      const entry = list[cursor++];
      if (!entry) return;
      const [payTo, origins] = entry;
      try {
        let r;
        try { r = await readFn(payTo); }
        catch { await new Promise((res) => setTimeout(res, retryPauseMs)); r = await readFn(payTo); }
        rpcCalls += Number(r?.rpcCalls) || 0;
        txReads += Number(r?.read) || 0;
        // `stale` is set EXPLICITLY on every row, including the happy path.
        // It used to appear only on the carried-over error branch below, so a
        // freshly read row carried no such key at all - which reads as "we do
        // not know" everywhere the field is projected rather than "this row is
        // current". Harmless while it was only a flag on a live page; not
        // harmless in the daily dataset, where the column landed 100% null on
        // its first recorded day (columnFill caught it) and would have been
        // null in every historical row after that, permanently, because a
        // snapshot of a past day cannot be rewritten.
        rows.push({ payTo, origins: [...origins].sort(), credits: Number(r?.credits) || 0, payers: Number(r?.payers) || 0, truncated: !!r?.truncated, ...(r?.windows ? { windows: r.windows, backfilling: !!r.backfilling, coveredFrom: r.coveredFrom ? new Date(r.coveredFrom * 1000).toISOString() : null, skippedTx: Number(r.skipped) || 0 } : {}), stale: false, at: Date.now() });
      } catch (e) {
        errors++;
        const prev = prevBy.get(payTo);
        if (prev) rows.push({ ...prev, origins: [...origins].sort(), stale: true, error: String(e?.message || e).slice(0, 80) });
        else rows.push({ payTo, origins: [...origins].sort(), credits: 0, payers: 0, truncated: false, stale: false, at: Date.now(), unreadable: true, error: String(e?.message || e).slice(0, 80) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { at: Date.now(), rows, scanned: list.length, candidates, scanCap: maxPayTos, errors, windowHours, durationMs: Date.now() - started, warm: false, rpcCalls, txReads };
}

/** Evidence maps for the router: origin -> credits / payers (max across a seller's payTos). */
export function solanaEvidenceByOrigin(snapshot = current) {
  const settled = new Map(), payers = new Map();
  for (const r of snapshot.rows || []) {
    for (const o of r.origins || []) {
      const k = String(o).replace(/\/+$/, "").toLowerCase();
      settled.set(k, Math.max(settled.get(k) || 0, r.credits || 0));
      payers.set(k, Math.max(payers.get(k) || 0, r.payers || 0));
    }
  }
  return { settled, payers };
}

export function getSolanaLeaderboardSnapshot({ self = null, now = Date.now(), window = "7d" } = {}) {
  const win = Object.hasOwn(SOLANA_WINDOWS, window) ? window : "7d";
  // Public rows carry counts and flags, never the RPC's own words (the
  // leaderboard-redaction rule: an error string on a public surface is a
  // provider detail at best and a key-bearing URL at worst). The selected
  // window's figures sit at the top level of each row under Base's names.
  const rows = rankSolanaRows((current.rows || []).map(({ error, ...r }) => ({ ...r, ...(r.windows ? { callsSettled: r.windows[win].callsSettled, totalUsd: r.windows[win].totalUsd, uniqueBuyers: r.windows[win].uniqueBuyers } : {}) })), { self, window: win });
  const withWindows = rows.filter((r) => r.windows);
  return {
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "USDC",
    measure: "settled USDC payments into each seller's payTo, read from the chain: calls, USDC settled and distinct buyers (the owner of the debited USDC account); self-funded transfers excluded; no per-seller cap",
    window: win,
    windows: Object.keys(SOLANA_WINDOWS),
    // A window is complete when every row's history reaches back past its
    // start. While a new payTo is backfilling, its row says so and this is false.
    windowComplete: withWindows.length > 0 && withWindows.every((r) => r.windows[win].complete),
    backfilling: withWindows.filter((r) => r.backfilling).length,
    windowHours: current.windowHours,
    scannedAt: current.at ? new Date(current.at).toISOString() : null,
    stale: !current.at || now - current.at > STALE_MS,
    warmStarted: !!current.warm,
    sellers: current.scanned,
    // ABSENCE HERE IS NOT EVIDENCE OF ABSENCE. The scan reads at most
    // MAX_PAYTOS payTos per cycle, so a seller past the cap is missing because
    // we never looked, not because nothing settled to them - and this board
    // PRIMES the router's proven-seller gate, so "not on the board" is the
    // reading that costs a seller routed volume. `sellers` is the scanned
    // count and was the only number here, which reads as the population. Same
    // shape as the 250-of-4,473 index page: the rows were right and the
    // contract was quiet.
    ...scanCoverage(current.candidates ?? current.scanned, current.scanned, current.scanCap ?? MAX_PAYTOS, "seller payTos"),
    errors: current.errors,
    rpcCallsLastScan: current.rpcCalls || 0,
    txReadsLastScan: current.txReads || 0,
    active: rows.filter((r) => (r.windows ? r.windows[win].callsSettled : r.credits) > 0).length,
    rows,
  };
}

export function persistSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(current));
    renameSync(tmp, file);
  } catch { /* the volume is best-effort; the next scan rebuilds */ }
}
export function loadPersistedSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && Array.isArray(j.rows)) { current = { ...emptyBoard(), ...j, state: j.state || {}, warm: true }; return true; }
  } catch { /* cold start */ }
  return false;
}
export function __setSolanaLeaderboardForTest(snap) { current = { ...current, ...snap }; }
export function __resetSolanaLeaderboardForTest() { current = emptyBoard(); }
export function _stateForTest() { return current.state; }

/** Rebuild: list payTos, scan incrementally against the persisted per-payTo state, prime the gate, persist. Deduped in flight. */
export async function refreshSolanaLeaderboard({ listPayTos, rpc, creditFromTx, readFn = null, prime, windowHours = 168 } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const payTos = await listPayTos();
      const state = current.state || {};
      const budget = { left: BACKFILL_TX_PER_CYCLE };
      const read = readFn || ((payTo) => readPayToIncremental(payTo, (state[payTo] ||= {}), { rpc, creditFromTx, windowMs: windowHours * 3600_000, budget }));
      const next = await scanSolanaSellers(payTos, { readFn: read, windowHours });
      // Forget state for payTos no longer listed (bounded memory).
      for (const k of Object.keys(state)) if (!payTos.has(k)) delete state[k];
      current = { ...next, state };
      if (typeof prime === "function") for (const r of next.rows) if (!r.unreadable && !r.stale) { try { prime(r.payTo, r.credits); } catch { /* priming is a nicety */ } }
      persistSolanaLeaderboard();
      console.log(`[solana-leaderboard] scanned ${next.scanned} payTos in ${next.durationMs}ms with ${next.rpcCalls} RPC calls, ${next.txReads} tx reads: ${next.rows.filter((r) => r.credits > 0).length} active, ${next.errors} unreadable`);
    } catch (e) {
      console.warn(`[solana-leaderboard] rebuild failed (previous board kept): ${String(e?.message || e).slice(0, 120)}`);
    } finally { inFlight = null; }
  })();
  return inFlight;
}

export function startSolanaLeaderboard({ listPayTos, rpc, creditFromTx, prime, windowHours = 168, delayMs = 180_000 } = {}) {
  if (!solanaLeaderboardEnabled()) { console.log("[solana-leaderboard] disabled (SOLANA_LEADERBOARD=off)"); return; }
  if (loadPersistedSolanaLeaderboard()) console.log(`[solana-leaderboard] warm-started ${current.rows.length} payTos from ${SOLANA_LB_CACHE_FILE}`);
  const run = () => refreshSolanaLeaderboard({ listPayTos, rpc, creditFromTx, prime, windowHours });
  kick = setTimeout(run, delayMs); kick.unref?.();
  kick2 = setTimeout(run, delayMs + 12 * 60_000); kick2.unref?.();
  timer = setInterval(run, REFRESH_MS); timer.unref?.();
}
export function stopSolanaLeaderboard() { for (const t of [timer, kick, kick2]) if (t) clearTimeout(t), clearInterval(t); timer = kick = kick2 = null; }
