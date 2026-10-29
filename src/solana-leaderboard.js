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
//
// PROGRESS IS CHECKPOINTED. A scan over every payTo runs for as long as its
// reads take at the public lane's pace, and a container can be replaced or
// restarted while one is running. The per-payTo cursors used to reach the
// store only when a whole scan finished, so a scan cut off by a restart lost
// every read it had made and the next one made them again. Now the cursors are
// saved every CHECKPOINT_MS during a scan and once more on drain, a scan starts
// from the newest saved cursors (its own or the other container's), and a read
// that fails the same way scan after scan is skipped visibly instead of
// holding that payTo's history open forever.
import { createDocumentCache } from "./json-document.js";
import { trackStoreReady, leased, leaseStillHeld } from "./state-db.js";
// Each store is one JSON document: on the volume, or in the state database
// when one is configured (imported from the file once).
const { docs, docFor } = createDocumentCache();
import { scanCoverage } from "./partial-answer.js";
import { registerMemoryStore } from "./memory-stores.js";

export const SOLANA_LB_CACHE_FILE = process.env.SOLANA_LB_CACHE_FILE || "/data/solana-leaderboard.json";
// Four hours: the board re-reads every settled payment through the keyed
// Solana lane, its largest metered line; production already ran at this value.
export const SOLANA_LB_DEFAULT_REFRESH_MS = 4 * 60 * 60_000;
const REFRESH_MS = Number(process.env.SOLANA_LB_REFRESH_MS) || SOLANA_LB_DEFAULT_REFRESH_MS;
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
// How often a running scan saves its cursors (0 = after every payTo).
const CHECKPOINT_MS = process.env.SOLANA_LB_CHECKPOINT_MS != null ? Math.max(0, Number(process.env.SOLANA_LB_CHECKPOINT_MS) || 0) : 5 * 60_000;
const LEASE_NAME = "solana-leaderboard-refresh";
// A transaction read that fails on every lane in this many scans in a row is
// counted as skipped (as a null answer is) and the cursor moves past it. One
// such read used to fail its payTo's whole batch every scan, so the cursor
// never moved and the payTo's history stayed open.
export const STUCK_READ_SCANS = Math.max(1, Number(process.env.SOLANA_LB_STUCK_READ_SCANS) || 3);
const STUCK_MAX = 200;
const STUCK = Symbol("stuck");
let scanSeq = 0;
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
export async function readPayToIncremental(payTo, st, { rpc, creditFromTx, windowMs = 168 * 3600e3, now = Date.now(), noAccountRecheckMs = NO_ACCOUNT_RECHECK_MS, txConcurrency = 12, budget = { left: BACKFILL_TX_PER_CYCLE }, backfillDays = BACKFILL_DAYS, scanId = null, stuckScans = STUCK_READ_SCANS } = {}) {
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
        const args = [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }];
        let tx;
        try { tx = await call("getTransaction", args); }
        catch {
          // One retry; a second failure fails the batch, unless this read has
          // now failed in `stuckScans` scans: then it is skipped like a null.
          try { tx = await call("getTransaction", args); }
          catch (e) {
            const stuck = (st.stuck ||= {});
            const rec = stuck[s.signature] || { n: 0, scan: null };
            if (scanId == null || rec.scan !== scanId) { rec.n++; rec.scan = scanId; }
            stuck[s.signature] = rec;
            for (const k of Object.keys(stuck)) { if (Object.keys(stuck).length <= STUCK_MAX) break; delete stuck[k]; }
            if (rec.n < stuckScans) throw e;
            delete stuck[s.signature];
            return STUCK;
          }
        }
        if (st.stuck?.[s.signature]) delete st.stuck[s.signature];
        return tx;
      }));
      txReads += chunk.length;
      got.forEach((tx, i) => {
        // A transaction the RPC answers null for (pruned or not yet indexed) is
        // counted as skipped, visibly, rather than blocking the cursor forever.
        // So is one that failed on every lane in scan after scan (above).
        if (!tx || tx === STUCK) { st.skipped++; return; }
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
export async function scanSolanaSellers(payTos, { readFn, concurrency = CONCURRENCY, now = Date.now(), previous = current.rows, maxPayTos = MAX_PAYTOS, windowHours = null, retryPauseMs = RETRY_PAUSE_MS, onRow = null } = {}) {
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
      // After every row, read or not: the caller checkpoints the cursors.
      if (onRow) { try { onRow(rows.length, list.length); } catch { /* a checkpoint never fails the scan */ } }
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
  // `inboundTransfers` is the name for what is counted: inbound USDC
  // transfers, not proven tool calls (there is no price match on this chain).
  // `callsSettled` stays beside it with the same value as a deprecated alias,
  // so no consumer of the live field breaks; `fieldNotes` says so.
  const withTransfers = (w) => (w ? { ...w, inboundTransfers: w.callsSettled } : w);
  const rows = rankSolanaRows((current.rows || []).map(({ error, ...r }) => {
    if (!r.windows) return { ...r, inboundTransfers: r.credits || 0, callsSettled: r.credits || 0 };
    const windows = Object.fromEntries(Object.entries(r.windows).map(([k, w]) => [k, withTransfers(w)]));
    return { ...r, windows, inboundTransfers: r.windows[win].callsSettled, callsSettled: r.windows[win].callsSettled, totalUsd: r.windows[win].totalUsd, uniqueBuyers: r.windows[win].uniqueBuyers };
  }), { self, window: win });
  const withWindows = rows.filter((r) => r.windows);
  return {
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "USDC",
    measure: "inbound USDC transfers into each seller's payTo, read from the chain: transfer count, USDC received and distinct buyers (the owner of the debited USDC account); self-funded transfers excluded; no price match, so a transfer may be a tool call or any other payment; no per-seller cap",
    fieldNotes: {
      inboundTransfers: "inbound USDC transfers into the payTo in the selected window",
      callsSettled: "deprecated alias of inboundTransfers (same value); these are transfers, not proven tool calls",
      totalUsd: "USDC received in the selected window",
      uniqueBuyers: "distinct wallets whose USDC paid in the selected window",
    },
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
    active: rows.filter((r) => (r.inboundTransfers || 0) > 0).length,
    rows,
  };
}

export function persistSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  // `stateAt` dates the cursors (a checkpoint moves them without a new
  // board), so a reader can tell the newest copy apart from an older one
  // that carries the same `at`.
  current.stateAt = Date.now();
  try { docFor(file).saveSync(current); } catch { /* the volume is best-effort; the next scan rebuilds */ }
}
/**
 * Save the cursors of the scan in progress (and the board as it stands):
 * every CHECKPOINT_MS from the scan, and once from the drain. Only while this
 * process still holds the scan's lease; a scan whose lease was lost keeps
 * reading but never overwrites the holder's progress. Returns false when
 * nothing is saved, else a promise that resolves once the save landed (the
 * drain waits on it; the scan does not).
 */
export function checkpointSolanaLeaderboard({ file = SOLANA_LB_CACHE_FILE } = {}) {
  if (!inFlight) return false;
  if (!leaseStillHeld(LEASE_NAME)) return false;
  current.stateAt = Date.now();
  try { return docFor(file).save(current).then((r) => r === true, () => false); } catch { return false; }
}
export function loadPersistedSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  const d = docFor(file);
  const apply = (j) => { if (j && Array.isArray(j.rows)) { current = { ...emptyBoard(), ...j, state: j.state || {}, warm: true }; return true; } return false; };
  if (d.backend === "pg") {
    // onLoad also runs when a failed load's background re-read lands; a scan
    // that finished meanwhile (current.at set) is newer and is kept.
    trackStoreReady(d.load(null, { onLoad: (j) => { if (!current.warm && !current.at && apply(j)) console.log(`[solana-leaderboard] warm-started ${current.rows.length} payTos from the state database`); } }));
    return false;
  }
  try { return apply(d.loadSync(null)); } catch { /* cold start */ }
  return false;
}
export function __setSolanaLeaderboardForTest(snap) { current = { ...current, ...snap }; }
export function __resetSolanaLeaderboardForTest() { current = emptyBoard(); inFlight = null; }
export function _stateForTest() { return current.state; }

/** Rebuild: list payTos, scan incrementally against the persisted per-payTo state, prime the gate, persist. Deduped in flight. */
const refreshSolanaLeaderboardLeased = leased("solana-leaderboard-refresh", { ttlMs: 30 * 60_000, failOpen: true }, refreshSolanaLeaderboardUnleased);
// The container without the lease skips the scan; it adopts the board the
// other container saved (when newer) and primes its own gate from it, so both
// containers hold the same evidence.
//
// The lease serializes scans; it does not share them: a tick that landed
// after the other container's scan had ended held the lease and read every
// payTo's signatures again, so two containers scanned twice per interval,
// and every boot kick scanned however fresh the saved board was. A tick now
// first takes the saved board when its finished scan (`at`) is at least as
// new as ours and younger than `peerFreshMs` (half the interval), and scans
// only otherwise; the check runs again under the lease. The cursors in the
// store keep the next scan incremental. Without a state database nothing
// changes.
export async function refreshSolanaLeaderboard(opts = {}) {
  const peerFreshMs = Number.isFinite(opts.peerFreshMs) ? opts.peerFreshMs : REFRESH_MS / 2;
  if (!inFlight && await adoptFreshStoredSolanaLeaderboard({ prime: opts.prime, peerFreshMs }).catch(() => false)) return { adopted: true };
  const r = await refreshSolanaLeaderboardLeased({ ...opts, peerFreshMs });
  if (r && r.skipped) await adoptPeerSolanaLeaderboard({ prime: opts.prime }).catch(() => {});
  return r;
}
/**
 * Take the stored board and cursors when they are newer than ours: the other
 * container's finished scan, or a checkpoint of a scan a restart cut off.
 * Never while this process is scanning (its cursors are the live ones).
 */
export async function adoptPeerSolanaLeaderboard(opts = {}) {
  if (inFlight) return false;
  return adoptStoredSolanaLeaderboard(opts);
}
async function readStoredSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  const r = await docFor(file).read({ quiet: true });
  const j = r?.ok && r.exists ? r.body : null;
  return j && Array.isArray(j.rows) ? j : null;
}
function applyStoredSolanaLeaderboard(j, prime) {
  current = { ...emptyBoard(), ...j, state: j.state || {}, warm: true };
  if (typeof prime === "function") for (const row of current.rows) if (!row.unreadable && !row.stale) { try { prime(row.payTo, row.credits); } catch { /* priming is a nicety */ } }
}
async function adoptStoredSolanaLeaderboard({ prime, file = SOLANA_LB_CACHE_FILE } = {}) {
  const j = await readStoredSolanaLeaderboard(file);
  if (!j) return false;
  const ours = Math.max(Number(current.stateAt) || 0, Number(current.at) || 0);
  const theirs = Math.max(Number(j.stateAt) || 0, Number(j.at) || 0);
  if (!(theirs > ours)) return false;
  applyStoredSolanaLeaderboard(j, prime);
  return true;
}
/**
 * True when the stored board is this tick's answer: its finished scan is at
 * least as new as ours (an older one is never taken over a newer one held)
 * and younger than `peerFreshMs`. Taken when newer; the scan is skipped.
 */
async function adoptFreshStoredSolanaLeaderboard({ prime, peerFreshMs, now = Date.now(), file = SOLANA_LB_CACHE_FILE } = {}) {
  if (!(peerFreshMs > 0) || docFor(file).backend !== "pg") return false;
  const j = await readStoredSolanaLeaderboard(file);
  const at = Number(j?.at) || 0, ours = Number(current.at) || 0;
  if (!(at > 0 && now - at < peerFreshMs) || at < ours) return false;
  if (at > ours) applyStoredSolanaLeaderboard(j, prime);
  return true;
}
async function refreshSolanaLeaderboardUnleased({ listPayTos, rpc, creditFromTx, readFn = null, prime, windowHours = 168, checkpointMs = CHECKPOINT_MS, peerFreshMs = 0 } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // Start from the newest cursors in the store: a restart lands this
      // container on the board it loaded at boot, which a checkpoint of the
      // scan the restart cut off (ours or the other container's) can postdate.
      await adoptStoredSolanaLeaderboard({ prime }).catch(() => {});
      // A scan that ended while the lease was taken: nothing to read.
      if (await adoptFreshStoredSolanaLeaderboard({ prime, peerFreshMs }).catch(() => false)) return { adopted: true };
      const payTos = await listPayTos();
      const state = (current.state ||= {});
      const budget = { left: BACKFILL_TX_PER_CYCLE };
      // Unique across restarts too: a stuck record is persisted with the scan
      // it last failed in, and a new process must not read its own first
      // scan as that one.
      const scanId = `${Date.now()}.${++scanSeq}`;
      const read = readFn || ((payTo) => readPayToIncremental(payTo, (state[payTo] ||= {}), { rpc, creditFromTx, windowMs: windowHours * 3600_000, budget, scanId }));
      let lastCheckpoint = Date.now();
      const onRow = () => {
        if (Date.now() - lastCheckpoint < checkpointMs) return;
        lastCheckpoint = Date.now();
        checkpointSolanaLeaderboard();
      };
      const next = await scanSolanaSellers(payTos, { readFn: read, windowHours, onRow });
      // Forget state for payTos no longer listed (bounded memory).
      for (const k of Object.keys(state)) if (!payTos.has(k)) delete state[k];
      if (!leaseStillHeld(LEASE_NAME)) {
        // Another container took the scan over; its cursors are the ones in
        // the store. This board is served here but not written over them.
        current = { ...next, state, stateAt: current.stateAt };
        console.warn(`[solana-leaderboard] scanned ${next.scanned} payTos after the lease was lost: board kept here, cursors not saved`);
        return;
      }
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

// Operator heap read (/__operator/heap.json `stores`).
registerMemoryStore("solana-leaderboard.current", () => current, { note: "Solana leaderboard" });
