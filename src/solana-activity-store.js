// The Solana activity scans' state, kept across restarts.
//
// A chain page's 30-day activity chart for a Solana wallet is built from one
// decoded transaction per payment (src/revenue-live.js `solanaActivity`). The
// decoded rows and the two cursors of that scan lived only in the page cache
// of one process, so every restart read every wallet's whole window again.
// This module stores each wallet's scan state and hands it back to the next
// process, which resumes from the stored cursors and reads only what is new.
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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonDocument } from "./json-document.js";
import { stateDbEnabled, stateDbSchema, stateQuery, records, leased } from "./state-db.js";

export const SOLANA_ACTIVITY_COLLECTION = "solana-activity";
export const SOLANA_ACTIVITY_STATE_VERSION = 1;
/** Rows a wallet's state may hold (the scanner's own cap). */
export const SOLANA_ACTIVITY_MAX_ENTRIES = 2000;
/** Wallets written per flush tick. */
export const FLUSH_CHUNK = 20;
const KEEP_DAYS = 35;
const PRUNE_EVERY_MS = 60 * 60_000;
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const maxWallets = (env = process.env) => { const n = Math.floor(Number(env.SOLANA_ACTIVITY_STORE_MAX_WALLETS)); return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 500; };
const flushMs = (env = process.env) => Math.max(1_000, Number(env.SOLANA_ACTIVITY_STORE_FLUSH_MS) || 60_000);
/** `off` keeps the scan state in memory only, as before this module. */
export const solanaActivityStoreEnabled = (env = process.env) => String(env.SOLANA_ACTIVITY_STORE || "").trim().toLowerCase() !== "off";

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

// ---- the file store (no state database) -----------------------------------
let fileDoc = null;
const fileOf = () => process.env.SOLANA_ACTIVITY_FILE || join(existsSync("/data") ? "/data" : tmpdir(), "solana-activity.json");
const docOf = () => (fileDoc ||= createJsonDocument({ name: "solana-activity", file: fileOf(), log: () => {} }));
const fileBody = (b) => (b && typeof b === "object" && b.wallets && typeof b.wallets === "object" ? b : { v: 1, wallets: {} });
function pruneWallets(wallets, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 86_400_000;
  for (const [w, b] of Object.entries(wallets)) if (!(Number(b?.at) >= cutoff)) delete wallets[w];
  const over = Object.keys(wallets).length - maxWallets();
  if (over > 0) for (const [w] of Object.entries(wallets).sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0)).slice(0, over)) delete wallets[w];
  return wallets;
}

// ---- state ----------------------------------------------------------------
const waiting = new Map();     // wallet -> scan state not yet written
const counters = { loads: 0, hits: 0, misses: 0, loadFailures: 0, writes: 0, writeFailures: 0, pruned: 0, flushes: 0 };
let timer = null;
let lastPruneAt = 0;

/**
 * The stored scan state of one wallet, or null (none stored, the store is
 * off, or it could not be read). One small read; never throws.
 */
export async function loadSolanaActivityState(wallet) {
  if (!solanaActivityStoreEnabled() || !WALLET_RE.test(String(wallet || ""))) return null;
  // A state this process has not written yet is the newest there is.
  if (waiting.has(wallet)) return waiting.get(wallet);
  counters.loads++;
  try {
    let body;
    if (stateDbEnabled()) body = await records.get(SOLANA_ACTIVITY_COLLECTION, wallet);
    else body = fileBody(await docOf().load(null)).wallets[wallet];
    const st = expandSolanaActivityState(body);
    if (st) counters.hits++; else counters.misses++;
    return st;
  } catch {
    counters.loadFailures++;
    return null;
  }
}

/** A finished scan's state, to be written by the next flush. Synchronous. */
export function noteSolanaActivityState(wallet, state) {
  if (!solanaActivityStoreEnabled() || !WALLET_RE.test(String(wallet || "")) || !state || typeof state !== "object") return false;
  waiting.delete(wallet); // newest last, so a flush writes the longest-waiting first
  waiting.set(wallet, state);
  // Wallets nobody could ever flush are not kept without bound.
  while (waiting.size > maxWallets()) waiting.delete(waiting.keys().next().value);
  if (!timer) {
    timer = setInterval(() => { flushSolanaActivityStore().catch(() => {}); }, flushMs());
    timer.unref?.();
  }
  return true;
}

async function pruneRows(now) {
  const T = `${stateDbSchema()}.records`;
  const old = await stateQuery(`DELETE FROM ${T} WHERE collection = $1 AND updated_at < now() - make_interval(days => $2)`, [SOLANA_ACTIVITY_COLLECTION, KEEP_DAYS]);
  const over = await stateQuery(
    `DELETE FROM ${T} WHERE collection = $1 AND id IN (SELECT id FROM ${T} WHERE collection = $1 ORDER BY updated_at DESC, id OFFSET $2)`,
    [SOLANA_ACTIVITY_COLLECTION, maxWallets()],
  );
  counters.pruned += (old.rowCount || 0) + (over.rowCount || 0);
  lastPruneAt = now;
}

async function flushUnleased({ max = FLUSH_CHUNK, now = Date.now() } = {}) {
  counters.flushes++;
  const batch = [...waiting.entries()].slice(0, Math.max(1, max));
  let written = 0;
  if (stateDbEnabled()) {
    for (const [wallet, st] of batch) {
      try {
        await records.put(SOLANA_ACTIVITY_COLLECTION, wallet, compactSolanaActivityState(st));
        // A newer state noted while this row was being written stays waiting.
        if (waiting.get(wallet) === st) waiting.delete(wallet);
        written++; counters.writes++;
      } catch { counters.writeFailures++; break; } // the store is not answering: the rest waits for the next tick
    }
    if (now - lastPruneAt >= PRUNE_EVERY_MS) { try { await pruneRows(now); } catch { /* the next tick tries again */ } }
  } else if (batch.length) {
    try {
      const r = await docOf().update((b) => {
        const x = fileBody(b);
        const wallets = { ...x.wallets };
        for (const [wallet, st] of batch) wallets[wallet] = compactSolanaActivityState(st);
        return { v: 1, wallets: pruneWallets(wallets, now) };
      }, { fallback: null });
      if (r?.ok) { for (const [wallet, st] of batch) if (waiting.get(wallet) === st) waiting.delete(wallet); written = batch.length; counters.writes += written; }
      else counters.writeFailures++;
    } catch { counters.writeFailures++; }
  }
  return { ok: true, written, waiting: waiting.size };
}
// The default (no fail-open): the flush writes only to the state database, so
// with the database not answering there is nothing a run without the lease
// could write; the wallets stay waiting.
const flushLeased = leased("solana-activity-store-flush", { ttlMs: 120_000, log: () => {} }, flushUnleased);

/**
 * Write up to `max` waiting wallets (FLUSH_CHUNK a tick; the drain passes a
 * larger number). Never throws. `{ skipped }` when another container holds
 * the lease: the wallets stay waiting.
 */
export async function flushSolanaActivityStore(opts = {}) {
  if (!waiting.size && Date.now() - lastPruneAt < PRUNE_EVERY_MS) return { ok: true, written: 0, waiting: 0 };
  try { return await flushLeased(opts); } catch { return { ok: false, written: 0, waiting: waiting.size }; }
}

/** Counts only, for the operator view. */
export function solanaActivityStoreStatus() {
  return { enabled: solanaActivityStoreEnabled(), backend: stateDbEnabled() ? "state-db" : "file", waiting: waiting.size, maxWallets: maxWallets(), maxEntries: SOLANA_ACTIVITY_MAX_ENTRIES, ...counters };
}

/** Test seam. */
export function __resetSolanaActivityStoreForTest() {
  waiting.clear(); fileDoc = null; lastPruneAt = 0;
  if (timer) { clearInterval(timer); timer = null; }
  for (const k of Object.keys(counters)) counters[k] = 0;
}
