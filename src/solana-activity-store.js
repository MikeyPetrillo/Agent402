// The Solana activity scans' state, kept across restarts.
//
// A chain page's 30-day activity chart for a Solana wallet is built from one
// decoded transaction per payment (src/revenue-live.js `solanaActivity`). The
// decoded rows and the two cursors of that scan lived only in the page cache
// of one process, so every restart read every wallet's whole window again.
// This module stores each wallet's scan state and hands it back to the next
// process, which resumes from the stored cursors and reads only what is new.
// The store itself is src/scan-state-store.js (shared with the EVM scans).
//
// WHERE. With a state database: one row per wallet in the `records` table
// (collection `solana-activity`, id the wallet), read one wallet at a time on
// that wallet's first view in a process, never as a whole at boot. Without
// one: a single JSON document in the file SOLANA_ACTIVITY_FILE (default
// /data/solana-activity.json, the temp directory without a volume).
//
// BOUNDS. A wallet's state holds at most the scanner's row cap (2,000 rows,
// about 70 bytes each as stored); at most SOLANA_ACTIVITY_STORE_MAX_WALLETS
// wallets are kept (default 500, the page cache's own bound), the least
// recently written dropped first, and a row not written for 35 days (longer
// than the window it describes) is dropped.
//
// WRITES ARE OFF THE REQUEST PATH. A finished scan marks its wallet's state
// as waiting; a timer (SOLANA_ACTIVITY_STORE_FLUSH_MS, default 60000) writes
// at most FLUSH_CHUNK wallets a tick, one small row each, under the lease
// `solana-activity-store-flush`, and prunes once an hour. A write that does
// not land keeps the wallet waiting for the next tick. Nothing here throws to
// a caller: a store that cannot be read is a cold wallet, as before.
import { createScanStateStore } from "./scan-state-store.js";

export const SOLANA_ACTIVITY_COLLECTION = "solana-activity";
export const SOLANA_ACTIVITY_STATE_VERSION = 1;
/** Rows a wallet's state may hold (the scanner's own cap). */
export const SOLANA_ACTIVITY_MAX_ENTRIES = 2000;
/** Wallets written per flush tick. */
export const FLUSH_CHUNK = 20;
const KEEP_DAYS = 35;
/** Days a stored row is kept (/privacy prints it). */
export const SOLANA_ACTIVITY_KEEP_DAYS = KEEP_DAYS;
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Wallets whose scan state is kept (/privacy prints it). */
export const solanaActivityMaxWallets = (env = process.env) => store.maxWallets(env);
/** `off` keeps the scan state in memory only, as before this module. */
export const solanaActivityStoreEnabled = (env = process.env) => store.enabled(env);

const str = (v) => (typeof v === "string" && v ? v : null);

/** The stored form of a scan state: cursors, and rows as [unix seconds, micro-dollars, payer]. */
export function compactSolanaActivityState(st) {
  if (!st || typeof st !== "object") return null;
  const e = [];
  for (const r of Array.isArray(st.entries) ? st.entries : []) {
    const t = Date.parse(r?.when || "");
    if (!Number.isFinite(t)) continue;
    e.push([Math.floor(t / 1000), Math.round((Number(r.usd) || 0) * 1e6), str(r.from)]);
    if (e.length >= SOLANA_ACTIVITY_MAX_ENTRIES) break;
  }
  return {
    v: SOLANA_ACTIVITY_STATE_VERSION, at: Number(st.at) || Date.now(),
    ata: str(st.ata), newestSig: str(st.newestSig), farSig: str(st.farSig),
    covered: !!st.covered, full: !!st.full, fullFloor: Number(st.fullFloor) || 0, headAt: Number(st.headAt) || 0, headHeld: st.headHeld ? String(st.headHeld).slice(0, 12) : null,
    skipped: Number(st.skipped) || 0,
    stuck: st.stuck && str(st.stuck.sig) ? { sig: st.stuck.sig, n: Number(st.stuck.n) || 0 } : null,
    e,
  };
}

/** A scan state from its stored form, or null when the body is not one this build reads. */
export function expandSolanaActivityState(body) {
  if (!body || typeof body !== "object" || body.v !== SOLANA_ACTIVITY_STATE_VERSION || !Array.isArray(body.e)) return null;
  const entries = [];
  for (const r of body.e) {
    if (!Array.isArray(r) || !Number.isFinite(Number(r[0]))) continue;
    entries.push({ when: new Date(Number(r[0]) * 1000).toISOString(), usd: Number(((Number(r[1]) || 0) / 1e6).toFixed(6)), from: str(r[2]) });
    if (entries.length >= SOLANA_ACTIVITY_MAX_ENTRIES) break;
  }
  return {
    v: SOLANA_ACTIVITY_STATE_VERSION, at: Number(body.at) || 0,
    ata: str(body.ata), newestSig: str(body.newestSig), farSig: str(body.farSig),
    covered: !!body.covered, full: !!body.full, fullFloor: Number(body.fullFloor) || 0, headAt: Number(body.headAt) || 0, headHeld: body.headHeld ? String(body.headHeld).slice(0, 12) : null,
    skipped: Number(body.skipped) || 0,
    stuck: body.stuck && str(body.stuck.sig) ? { sig: body.stuck.sig, n: Number(body.stuck.n) || 0 } : null,
    entries,
  };
}

// ---- the store (src/scan-state-store.js) -----------------------------------
const store = createScanStateStore({
  name: "solana-activity", collection: SOLANA_ACTIVITY_COLLECTION,
  env: { file: "SOLANA_ACTIVITY_FILE", enabled: "SOLANA_ACTIVITY_STORE", maxWallets: "SOLANA_ACTIVITY_STORE_MAX_WALLETS", flushMs: "SOLANA_ACTIVITY_STORE_FLUSH_MS" },
  keyOk: (wallet) => WALLET_RE.test(String(wallet || "")),
  compact: compactSolanaActivityState, expand: expandSolanaActivityState,
  keepDays: KEEP_DAYS, flushChunk: FLUSH_CHUNK,
});

/**
 * The stored scan state of one wallet, or null (none stored, the store is
 * off, or it could not be read). One small read; never throws.
 */
export async function loadSolanaActivityState(wallet) { return store.load(wallet); }

/** A finished scan's state, to be written by the next flush. Synchronous. */
export function noteSolanaActivityState(wallet, state) { return store.note(wallet, state); }

/**
 * Write up to `max` waiting wallets (FLUSH_CHUNK a tick; the drain passes a
 * larger number). Never throws. `{ skipped }` when another container holds
 * the lease: the wallets stay waiting.
 */
export async function flushSolanaActivityStore(opts = {}) { return store.flush(opts); }

/** Counts only, for the operator view. */
export function solanaActivityStoreStatus() { return store.status({ maxEntries: SOLANA_ACTIVITY_MAX_ENTRIES }); }

/** Test seam. */
export function __resetSolanaActivityStoreForTest() { store.reset(); }
