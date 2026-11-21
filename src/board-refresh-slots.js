// When the seller boards rebuild: fixed slots, one board at a time.
//
// The three boards (Base, src/leaderboard.js; Solana, src/solana-leaderboard.js;
// MPP on Tempo, src/mpp-leaderboard.js) each used to run on a timer of their
// own, counted from boot, with nothing between them: after a deploy their boot
// kicks and every later tick could land together, and together with an index
// crawl, and the event loop stalled for seconds while two rebuilds and a crawl
// shared one heap. Each board now rebuilds twice a day at its own fixed UTC
// hour, an hour apart from the others, and a rebuild that is due waits while
//   - another board's rebuild is running (never two at once),
//   - an index crawl is in flight (the server hands that check in), or
//   - the heap is high (heapUsed over BOARD_REFRESH_HEAP_SHARE of V8's limit).
// A rebuild held back by another board or a crawl runs anyway once it has
// waited MAX_DEFER_MS (a stuck peer never silences a board); one held back by
// the heap gives the slot up instead, with an error line, and the next slot
// tries again: a rebuild is the last thing a full heap needs.
//
// A boot does not rebuild a board that is already current: the boot kick runs
// only when the board has no snapshot newer than its last slot (a first boot,
// or a slot missed while nothing was running).
//
// No store, no network: the boards hand in their own rebuild function.
import { getHeapStatistics } from "node:v8";
import { BOARD_SLOT_HOURS_UTC, BOARD_REFRESH_MS } from "./refresh-cadence.js";

export { BOARD_SLOT_HOURS_UTC, BOARD_REFRESH_MS };
const HOUR_MS = 3_600_000;
/** How often a rebuild that is held back looks again. */
export const DEFER_RETRY_MS = 60_000;
/** How long a rebuild waits for a peer or a crawl before it runs anyway, and for the heap before it gives the slot up. */
export const MAX_DEFER_MS = 45 * 60_000;
/** A snapshot this young at a slot was built by this slot (a peer container, or the run before a restart). */
export const SLOT_PEER_FRESH_MS = 30 * 60_000;
export const BOARD_REFRESH_HEAP_SHARE_DEFAULT = 0.7;

/** The share of V8's heap limit above which a rebuild waits (BOARD_REFRESH_HEAP_SHARE; `off` or 0 disables; a malformed value reads as the default). */
export function boardRefreshHeapShare(env = process.env) {
  const raw = String(env.BOARD_REFRESH_HEAP_SHARE ?? "").trim().toLowerCase();
  if (raw === "") return BOARD_REFRESH_HEAP_SHARE_DEFAULT;
  if (raw === "off") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : BOARD_REFRESH_HEAP_SHARE_DEFAULT;
}
/** True while the heap is above the share. */
export function heapIsHigh({ share = boardRefreshHeapShare(), used = process.memoryUsage().heapUsed, limit = getHeapStatistics().heap_size_limit } = {}) {
  return share > 0 && limit > 0 && used / limit > share;
}

/** The first slot strictly after `now` (ms), for slot hours in UTC. */
export function nextSlotAt(hoursUtc, now = Date.now()) {
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const all = [];
  for (const d of [day, day + 86_400_000]) for (const h of hoursUtc) all.push(d + h * HOUR_MS);
  return all.sort((a, b) => a - b).find((t) => t > now);
}
/** The last slot at or before `now` (ms). */
export function lastSlotAt(hoursUtc, now = Date.now()) {
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const all = [];
  for (const d of [day - 86_400_000, day]) for (const h of hoursUtc) all.push(d + h * HOUR_MS);
  return all.sort((a, b) => b - a).find((t) => t <= now);
}

// One rebuild at a time, across the boards of this process.
let running = null;
/** The board whose rebuild is running now, or null. */
export function boardRefreshRunning() { return running; }
// What else must be quiet before a rebuild starts (the server hands in the
// index crawl check); each returns a reason string or a falsy value.
const quietChecks = [];
/** Register a check a due rebuild waits on: () => reason string, or falsy when quiet. */
export function addBoardRefreshQuietCheck(fn) { if (typeof fn === "function") quietChecks.push(fn); }
/** Test seam. */
export function __resetBoardRefresh() { running = null; quietChecks.length = 0; }

/**
 * Schedule one board.
 *
 * @param {object} o
 * @param {string} o.board        "base", "solana" or "mpp" (its row in BOARD_SLOT_HOURS_UTC)
 * @param {(why: { slot: boolean }) => Promise<any>} o.run   the board's rebuild
 * @param {() => number} [o.snapshotAt]  when the board's current snapshot was built (ms; 0 = none)
 * @param {number|null} [o.bootDelayMs]  the boot kick's delay; null = no boot kick
 * @param {number|null} [o.secondKickMs] a second early pass after a boot kick that ran; null = none
 * @returns {{ stop: () => void }}
 */
export function scheduleBoardRefresh({ board, run, snapshotAt = () => 0, bootDelayMs = null, secondKickMs = null, hoursUtc = BOARD_SLOT_HOURS_UTC[board], now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, heapHigh = () => heapIsHigh(), retryMs = DEFER_RETRY_MS, maxDeferMs = MAX_DEFER_MS, log = console }) {
  if (!Array.isArray(hoursUtc) || !hoursUtc.length) throw new Error(`board-refresh-slots: no slots for ${board}`);
  let stopped = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimer(() => { timers.delete(t); if (!stopped) fn(); }, Math.max(0, ms));
    t?.unref?.();
    timers.add(t);
    return t;
  };
  const held = () => {
    if (running && running !== board) return { why: `the ${running} board is rebuilding`, heap: false };
    if (running === board) return { why: "its own rebuild is still running", heap: false, own: true };
    for (const check of quietChecks) {
      let why = null;
      try { why = check(); } catch { why = null; }
      if (why) return { why: String(why), heap: false };
    }
    let high = false;
    try { high = heapHigh() === true; } catch { high = false; }
    return high ? { why: "the heap is high", heap: true } : null;
  };
  // One due rebuild: wait while held, then run under the shared gate.
  const attempt = (label, since, after = null) => {
    if (stopped) return;
    const h = held();
    if (h?.own) return; // this board is already rebuilding: the tick is spent
    if (h) {
      const waited = now() - since;
      if (waited < maxDeferMs) { later(() => attempt(label, since, after), retryMs); return; }
      if (h.heap) { log.error(`[board-refresh] ${board}: ${label} given up after ${Math.round(waited / 60_000)} min (${h.why}); the next slot tries again`); return; }
      log.warn(`[board-refresh] ${board}: ${label} runs after waiting ${Math.round(waited / 60_000)} min (${h.why})`);
    }
    running = board;
    Promise.resolve()
      .then(() => run({ slot: label === "slot" }))
      .catch(() => {})
      .finally(() => { if (running === board) running = null; if (after) after(); });
  };
  const armSlot = () => {
    const at = nextSlotAt(hoursUtc, now());
    later(() => { armSlot(); attempt("slot", now()); }, at - now());
  };
  armSlot();
  if (bootDelayMs != null) {
    later(() => {
      // Current since its last slot: nothing to do until the next one.
      let built = 0;
      try { built = Number(snapshotAt()) || 0; } catch { built = 0; }
      if (built >= lastSlotAt(hoursUtc, now())) return;
      attempt("boot rebuild", now(), secondKickMs != null ? () => later(() => attempt("second boot pass", now()), secondKickMs) : null);
    }, bootDelayMs);
  }
  return { stop() { stopped = true; for (const t of timers) clearTimer(t); timers.clear(); } };
}
