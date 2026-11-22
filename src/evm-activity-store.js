// The EVM activity scans' state, kept across restarts.
//
// A chain page's 30-day activity chart for an EVM wallet is built from the
// wallet's inbound transfers (src/revenue-live.js `evmActivity`). The scan
// already resumes inside one process (a head read after the newest block it
// holds, a far end continued downward), but its rows lived only in the page
// cache, so every restart read every viewed wallet's whole window again
// through the keyed provider. This module stores each (chain, wallet) scan
// state and hands it back to the next process, which resumes from it.
//
// The store is src/scan-state-store.js: with a state database one `records`
// row per chain and wallet (collection `evm-activity`, id `<chain>:<wallet>`),
// read on that wallet's first view in a process, never at boot; without one
// the file EVM_ACTIVITY_FILE. Written by a timer under the lease
// `evm-activity-store-flush`, never on a request.
//
// BOUNDS. A stored state holds at most EVM_ACTIVITY_STORE_MAX_ROWS rows
// (default 20,000; a busier wallet's state is not kept and that wallet reads
// its window again after a restart, as before), about 30 bytes a row: block,
// time, amount, payer (by index into the state's payer list) and the
// internal flag. A row's transfer id is kept only where a resumed read can
// meet the row again (the newest blocks a head read re-reads, and the far
// block a continuation re-reads), so the stored copy stays small and a
// resumed scan still never counts a transfer twice. At most
// EVM_ACTIVITY_STORE_MAX_WALLETS states are kept (default 500), 35 days.
import { createScanStateStore } from "./scan-state-store.js";

export const EVM_ACTIVITY_COLLECTION = "evm-activity";
export const EVM_ACTIVITY_STATE_VERSION = 1;
const KEEP_DAYS = 35;
/** Days a stored state is kept (/privacy prints it). */
export const EVM_ACTIVITY_KEEP_DAYS = KEEP_DAYS;
const KEY_RE = /^[a-z][a-z0-9-]{1,30}:0x[0-9a-f]{40}$/;
const maxRows = (env = process.env) => { const n = Math.floor(Number(env.EVM_ACTIVITY_STORE_MAX_ROWS)); return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 20_000; };
/** The rows one stored state may hold. */
export const evmActivityStoreMaxRows = maxRows;

/** The store's key for a chain and wallet, or null for one it does not keep. */
export function evmActivityKey(chain, wallet) {
  const k = `${String(chain || "").toLowerCase()}:${String(wallet || "").toLowerCase()}`;
  return KEY_RE.test(k) ? k : null;
}

/**
 * The stored form of a scan state (the `__scanState` evmActivity returns), or
 * null when it is not one or holds more rows than the store keeps.
 * `uidBlocks` is how far below the newest block row ids are kept: a resumed
 * head read starts no lower than that (evmActivity reads `uidFloor`).
 */
export function compactEvmActivityState(st, { uidBlocks = 0, rowsMax = maxRows() } = {}) {
  if (!st || typeof st !== "object" || !Array.isArray(st.entries) || !Number.isFinite(st.newestBlock)) return null;
  if (st.entries.length > rowsMax) return null;
  const uidFloor = Math.max(0, st.newestBlock - Math.max(0, Math.floor(uidBlocks)));
  const far = Number.isFinite(st.farBlock) ? st.farBlock : null;
  const payers = [], pi = new Map(), e = [];
  for (const r of st.entries) {
    const t = Date.parse(r?.when || "");
    let p = -1;
    if (typeof r?.from === "string") { p = pi.get(r.from); if (p === undefined) { p = payers.length; payers.push(r.from); pi.set(r.from, p); } }
    const block = Number.isFinite(r?.block) ? r.block : null;
    const keepUid = typeof r?.uid === "string" && (block == null || block >= uidFloor || (far != null && block <= far));
    const row = [Number.isFinite(t) ? t : null, Math.round((Number(r?.usd) || 0) * 1e6), p, block, r?.internal ? 1 : 0];
    if (keepUid) row.push(r.uid);
    e.push(row);
  }
  return {
    v: EVM_ACTIVITY_STATE_VERSION, at: Number(st.at) || Date.now(),
    newestBlock: st.newestBlock, truncated: !!st.truncated, farBlock: far, capped: !!st.capped, uidFloor,
    p: payers, e,
  };
}

/** A scan state from its stored form, or null when the body is not one this build reads. */
export function expandEvmActivityState(body) {
  if (!body || typeof body !== "object" || body.v !== EVM_ACTIVITY_STATE_VERSION || !Array.isArray(body.e) || !Array.isArray(body.p) || !Number.isFinite(body.newestBlock)) return null;
  const entries = [];
  for (const r of body.e) {
    if (!Array.isArray(r) || r.length < 5) return null;
    const from = r[2] >= 0 ? body.p[r[2]] : null;
    if (r[2] >= 0 && typeof from !== "string") return null;
    const row = { when: Number.isFinite(r[0]) ? new Date(r[0]).toISOString() : null, usd: (Number(r[1]) || 0) / 1e6, from, uid: typeof r[5] === "string" ? r[5] : null, block: Number.isFinite(r[3]) ? r[3] : null, internal: r[4] === 1 };
    entries.push(row);
  }
  return {
    entries, newestBlock: body.newestBlock, truncated: !!body.truncated,
    farBlock: Number.isFinite(body.farBlock) ? body.farBlock : null, capped: !!body.capped,
    uidFloor: Number.isFinite(body.uidFloor) ? body.uidFloor : body.newestBlock, at: Number(body.at) || 0,
  };
}

// How far below the newest block a stored state keeps row ids, per chain:
// set by the scanner (src/revenue-live.js), four times its resume overlap.
let uidBlocksFor = () => 0;
/** The scanner names how many blocks below the newest a resumed head read may start. */
export function setEvmActivityUidBlocks(fn) { if (typeof fn === "function") uidBlocksFor = fn; }

const store = createScanStateStore({
  name: "evm-activity", collection: EVM_ACTIVITY_COLLECTION,
  env: { file: "EVM_ACTIVITY_FILE", enabled: "EVM_ACTIVITY_STORE", maxWallets: "EVM_ACTIVITY_STORE_MAX_WALLETS", flushMs: "EVM_ACTIVITY_STORE_FLUSH_MS" },
  keyOk: (key) => KEY_RE.test(String(key || "")),
  compact: (st) => compactEvmActivityState(st, { uidBlocks: uidBlocksFor(st?.chain) }),
  expand: expandEvmActivityState,
  keepDays: KEEP_DAYS,
});

/** States kept (/privacy prints it). */
export const evmActivityMaxWallets = (env = process.env) => store.maxWallets(env);
/** `off` keeps the scan state in memory only, as before this module. */
export const evmActivityStoreEnabled = (env = process.env) => store.enabled(env);
/** The stored state of a chain's wallet, or null. One small read; never throws. */
export async function loadEvmActivityState(chain, wallet) {
  const key = evmActivityKey(chain, wallet);
  return key ? store.load(key) : null;
}
/** A finished scan's state, written by the next flush. Synchronous. */
export function noteEvmActivityState(chain, wallet, state) {
  const key = evmActivityKey(chain, wallet);
  if (!key || !state || typeof state !== "object") return false;
  return store.note(key, { ...state, chain: String(chain).toLowerCase() });
}
/** Write up to `max` waiting states (the drain passes a larger number). Never throws. */
export async function flushEvmActivityStore(opts = {}) { return store.flush(opts); }
/** Counts only, for the operator view. */
export function evmActivityStoreStatus() { return store.status({ maxRows: maxRows() }); }
/** Test seam. */
export function __resetEvmActivityStoreForTest() { store.reset(); }
