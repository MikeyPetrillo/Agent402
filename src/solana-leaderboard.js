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
// pass (~72k/day if left alone - the egress meter caught it within the hour).
// Now each payTo keeps three things across cycles: its USDC token account
// (never changes; a payTo with NO account is re-checked once a day, not every
// cycle), the newest signature already seen (getSignaturesForAddress `until`
// returns only what is new), and the credited events inside the window. A
// cycle therefore costs one signatures read per payTo with an account, plus
// one transaction read per NEW inbound transfer chain-wide - the true rate of
// Solana x402 settlement, not the size of the seller list. Two-hour cadence.
//
// Credits, not distinct funders, are the ranking measure: on Solana x402 the
// debited account is usually a shared facilitator, so distinct funders
// collapses to 1 for a real seller (the gate's own comment). Funders are
// still counted and shown. Never a per-transaction feed on the public surface.
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const SOLANA_LB_CACHE_FILE = process.env.SOLANA_LB_CACHE_FILE || "/data/solana-leaderboard.json";
const REFRESH_MS = Number(process.env.SOLANA_LB_REFRESH_MS) || 2 * 60 * 60_000;
const CONCURRENCY = Number(process.env.SOLANA_LB_CONCURRENCY) || 1;
const RETRY_PAUSE_MS = Number(process.env.SOLANA_LB_RETRY_PAUSE_MS) || 1500;
const MAX_PAYTOS = Number(process.env.SOLANA_LB_MAX_PAYTOS) || 600;
const MAX_TX_READS_PER_CYCLE = Number(process.env.SOLANA_LB_MAX_TX_READS) || 120;
const NO_ACCOUNT_RECHECK_MS = Number(process.env.SOLANA_LB_NO_ACCOUNT_RECHECK_MS) || 24 * 60 * 60_000;
const MAX_EVENTS_PER_PAYTO = 2000;
const STALE_MS = 3 * REFRESH_MS;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let current = emptyBoard();
let inFlight = null;
let timer = null, kick = null, kick2 = null;

function emptyBoard() {
  return { at: 0, rows: [], scanned: 0, errors: 0, windowHours: null, durationMs: 0, warm: false, rpcCalls: 0, state: {} };
}

export function solanaLeaderboardEnabled() {
  return String(process.env.SOLANA_LEADERBOARD || "on").toLowerCase() !== "off";
}

/** Pure: rank rows by credits desc, then payers, then payTo. Marks the host's own payTo. */
export function rankSolanaRows(rows, { self = null } = {}) {
  const s = self ? String(self) : null;
  return [...rows]
    .map((r) => ({ ...r, self: !!(s && r.payTo === s) }))
    .sort((a, b) => (b.credits - a.credits) || ((b.payers || 0) - (a.payers || 0)) || String(a.payTo).localeCompare(String(b.payTo)))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Incremental read of ONE payTo. `st` is that payTo's persisted state and is
 * mutated in place: { ata, ataCheckedAt, lastSig, events:[{t, f, s}] }.
 * `rpc(method, params)` is the Solana JSON-RPC call; `creditFromTx(meta,
 * payTo)` the gate's pure credit rule. Returns { credits, payers, truncated,
 * read, rpcCalls } over the window.
 */
export async function readPayToIncremental(payTo, st, { rpc, creditFromTx, windowMs, now = Date.now(), maxTxReads = MAX_TX_READS_PER_CYCLE, noAccountRecheckMs = NO_ACCOUNT_RECHECK_MS, txConcurrency = 12 } = {}) {
  let rpcCalls = 0;
  const call = async (m, p) => { rpcCalls++; return rpc(m, p); };
  const cutoff = (now - windowMs) / 1000;
  const summarize = (truncated, read) => {
    st.events = (st.events || []).filter((e) => e.t >= cutoff).slice(-MAX_EVENTS_PER_PAYTO);
    const funders = new Set(st.events.map((e) => e.f).filter(Boolean));
    return { credits: st.events.length, payers: funders.size, truncated, read, rpcCalls };
  };
  // Token account: resolved once; a payTo with none is re-checked daily.
  if (!st.ata) {
    if (st.ata === null && Number(st.ataCheckedAt) && now - st.ataCheckedAt < noAccountRecheckMs) return summarize(false, 0);
    const accounts = await call("getTokenAccountsByOwner", [payTo, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
    st.ata = accounts?.value?.[0]?.pubkey || null;
    st.ataCheckedAt = now;
    if (!st.ata) return summarize(false, 0);
  }
  // Only signatures newer than the last one seen. The first read on a payTo
  // has no cursor and takes the recent window, bounded by the read cap.
  const params = { limit: Math.max(maxTxReads, 100) };
  if (st.lastSig) params.until = st.lastSig;
  const sigs = await call("getSignaturesForAddress", [st.ata, params]);
  // Belt beside `until`: an RPC that ignores the cursor (or a cached page)
  // would hand back signatures already folded; stop at the cursor and skip
  // anything the event log already holds, so nothing is ever double-counted.
  const seen = new Set((st.events || []).map((e) => e.s).filter(Boolean));
  const fresh = [];
  for (const s of sigs || []) {
    if (st.lastSig && s.signature === st.lastSig) break;
    if (s.err || Number(s.blockTime || 0) < cutoff || seen.has(s.signature)) continue;
    fresh.push(s);
  }
  if (fresh.length) st.lastSig = fresh[0].signature;   // newest first
  const toRead = fresh.slice(0, maxTxReads);
  const truncated = fresh.length > toRead.length;
  for (let off = 0; off < toRead.length; off += txConcurrency) {
    const batch = await Promise.all(toRead.slice(off, off + txConcurrency).map((s) => call("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => null)));
    batch.forEach((tx, i) => {
      const verdict = creditFromTx(tx?.meta, payTo);
      if (verdict?.credited) (st.events ||= []).push({ t: Number(toRead[off + i].blockTime || 0), f: verdict.funder || null, s: toRead[off + i].signature });
    });
  }
  return summarize(truncated, toRead.length);
}

/**
 * One scan over `payTos`: Map(payTo -> Set(origins)). `readFn(payTo)` resolves
 * { credits, payers, truncated, rpcCalls }. A failed read is retried once,
 * then the previous row is kept marked stale (one hiccup never zeroes a
 * proven seller).
 */
export async function scanSolanaSellers(payTos, { readFn, concurrency = CONCURRENCY, now = Date.now(), previous = current.rows, maxPayTos = MAX_PAYTOS, windowHours = null, retryPauseMs = RETRY_PAUSE_MS } = {}) {
  const prevBy = new Map((previous || []).map((r) => [r.payTo, r]));
  const list = [...payTos.entries()].slice(0, maxPayTos);
  const rows = [];
  let errors = 0, cursor = 0, rpcCalls = 0;
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
        rows.push({ payTo, origins: [...origins].sort(), credits: Number(r?.credits) || 0, payers: Number(r?.payers) || 0, truncated: !!r?.truncated, at: Date.now() });
      } catch (e) {
        errors++;
        const prev = prevBy.get(payTo);
        if (prev) rows.push({ ...prev, origins: [...origins].sort(), stale: true, error: String(e?.message || e).slice(0, 80) });
        else rows.push({ payTo, origins: [...origins].sort(), credits: 0, payers: 0, truncated: false, at: Date.now(), unreadable: true, error: String(e?.message || e).slice(0, 80) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { at: Date.now(), rows, scanned: list.length, errors, windowHours, durationMs: Date.now() - started, warm: false, rpcCalls };
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

export function getSolanaLeaderboardSnapshot({ self = null, now = Date.now() } = {}) {
  // Public rows carry counts and flags, never the RPC's own words (the
  // leaderboard-redaction rule: an error string on a public surface is a
  // provider detail at best and a key-bearing URL at worst).
  const rows = rankSolanaRows((current.rows || []).map(({ error, ...r }) => r), { self });
  return {
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "USDC",
    measure: "inbound USDC credits to the seller's payTo over the window (self-funded transfers excluded); truncated rows reached the per-cycle read cap",
    windowHours: current.windowHours,
    scannedAt: current.at ? new Date(current.at).toISOString() : null,
    stale: !current.at || now - current.at > STALE_MS,
    warmStarted: !!current.warm,
    sellers: current.scanned,
    errors: current.errors,
    rpcCallsLastScan: current.rpcCalls || 0,
    active: rows.filter((r) => r.credits > 0).length,
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
      const read = readFn || ((payTo) => readPayToIncremental(payTo, (state[payTo] ||= {}), { rpc, creditFromTx, windowMs: windowHours * 3600_000 }));
      const next = await scanSolanaSellers(payTos, { readFn: read, windowHours });
      // Forget state for payTos no longer listed (bounded memory).
      for (const k of Object.keys(state)) if (!payTos.has(k)) delete state[k];
      current = { ...next, state };
      if (typeof prime === "function") for (const r of next.rows) if (!r.unreadable && !r.stale) { try { prime(r.payTo, r.credits); } catch { /* priming is a nicety */ } }
      persistSolanaLeaderboard();
      console.log(`[solana-leaderboard] scanned ${next.scanned} payTos in ${next.durationMs}ms with ${next.rpcCalls} RPC calls: ${next.rows.filter((r) => r.credits > 0).length} active, ${next.errors} unreadable`);
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
