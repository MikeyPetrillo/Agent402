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
// the heap gives the attempt up instead, with an error line: a rebuild is the
// last thing a full heap needs. A given-up rebuild tries again every
// GIVEN_UP_RETRY_MS (an hour) until it runs, so a heap that was high for one
// stretch costs a board an hour or two, not the twelve to its next slot.
//
// A rebuild that runs is bounded: past BOARD_REFRESH_RUN_MAX_MS (two hours by
// default) the gate is released with an error line and the run's signal is
// aborted, so a rebuild that never settles cannot hold its own board's later
// slots (a board whose rebuild "is still running" spends its tick) or make
// every peer wait out MAX_DEFER_MS. A run that settles after that releases
// nothing: a later run may hold the gate by then.
//
// boardRefreshStatus() is the word /api/gateway-status publishes: ok; held
// while a board has given an attempt up and not yet run; stalled once a
// board has given up STALLED_AFTER_GIVEN_UP attempts in a row, or its last
// run passed the bound and none has finished since. The pagers read stalled.
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
/** How long after a rebuild gave an attempt up (the heap) it tries again, until it runs. */
export const GIVEN_UP_RETRY_MS = HOUR_MS;
/** Given-up attempts in a row at which the board's word reads stalled. */
export const STALLED_AFTER_GIVEN_UP = 3;
export const BOARD_REFRESH_RUN_MAX_MS_DEFAULT = 2 * HOUR_MS;
/** The longest a rebuild holds the gate (BOARD_REFRESH_RUN_MAX_MS, ms; at least a minute; a malformed value reads as the default). */
export function boardRefreshRunMaxMs(env = process.env) {
  const raw = String(env.BOARD_REFRESH_RUN_MAX_MS ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : BOARD_REFRESH_RUN_MAX_MS_DEFAULT;
}

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

// One rebuild at a time, across the boards of this process. `runningToken`
// is the run that holds the gate: a run released at its bound and settling
// later is not the holder any more and releases nothing.
let running = null;
let runningToken = null;
/** The board whose rebuild is running now, or null. */
export function boardRefreshRunning() { return running; }
// Per board: attempts given up in a row (zero again when a rebuild starts),
// and whether the last run passed its bound with none finished since.
const boardState = new Map();
const stateOf = (board) => {
  let st = boardState.get(board);
  if (!st) { st = { givenUp: 0, givenUpSince: 0, givenUpTotal: 0, overran: false, overranTotal: 0, lastStartedAt: 0, lastFinishedAt: 0 }; boardState.set(board, st); }
  return st;
};
const wordOf = (st) => (st.overran || st.givenUp >= STALLED_AFTER_GIVEN_UP ? "stalled" : st.givenUp > 0 ? "held" : "ok");
const RANK = { ok: 0, held: 1, stalled: 2 };
/**
 * The rebuilds' word: { status: "ok" | "held" | "stalled" }, the worst of the
 * boards. `full` adds each board's word and counts (the operator view).
 */
export function boardRefreshStatus({ full = false } = {}) {
  let status = "ok";
  const boards = {};
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  for (const [board, st] of boardState) {
    const w = wordOf(st);
    if (RANK[w] > RANK[status]) status = w;
    boards[board] = { status: w, givenUpInARow: st.givenUp, givenUpSince: iso(st.givenUpSince), givenUpTotal: st.givenUpTotal, pastItsBound: st.overran, pastItsBoundTotal: st.overranTotal, lastStartedAt: iso(st.lastStartedAt), lastFinishedAt: iso(st.lastFinishedAt) };
  }
  return full ? { status, boards } : { status };
}
// What else must be quiet before a rebuild starts (the server hands in the
// index crawl check); each returns a reason string or a falsy value.
const quietChecks = [];
/** Register a check a due rebuild waits on: () => reason string, or falsy when quiet. */
export function addBoardRefreshQuietCheck(fn) { if (typeof fn === "function") quietChecks.push(fn); }
/** Test seam. */
export function __resetBoardRefresh() { running = null; runningToken = null; quietChecks.length = 0; boardState.clear(); }

/**
 * Schedule one board.
 *
 * @param {object} o
 * @param {string} o.board        "base", "solana" or "mpp" (its row in BOARD_SLOT_HOURS_UTC)
 * @param {(why: { slot: boolean }) => Promise<any>} o.run   the board's rebuild
 * @param {() => number} [o.snapshotAt]  when the board's current snapshot was built (ms; 0 = none)
 * @param {number|null} [o.bootDelayMs]  the boot kick's delay; null = no boot kick
 * @param {number|null} [o.secondKickMs] a second early pass after a boot kick that ran; null = none
 * @param {number} [o.runMaxMs]          the longest the rebuild holds the gate (its `signal` aborts then)
 * @param {number} [o.givenUpRetryMs]    how long after a given-up attempt the rebuild tries again
 * @returns {{ stop: () => void }}
 */
export function scheduleBoardRefresh({ board, run, snapshotAt = () => 0, bootDelayMs = null, secondKickMs = null, hoursUtc = BOARD_SLOT_HOURS_UTC[board], now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, heapHigh = () => heapIsHigh(), retryMs = DEFER_RETRY_MS, maxDeferMs = MAX_DEFER_MS, runMaxMs = boardRefreshRunMaxMs(), givenUpRetryMs = GIVEN_UP_RETRY_MS, log = console }) {
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
  const st = stateOf(board);
  // The one pending retry of a given-up rebuild (a second give-up while it
  // waits adds none; a rebuild that starts cancels it).
  let givenUpRetry = null;
  // One due rebuild: wait while held, then run under the shared gate.
  const attempt = (label, since, after = null) => {
    if (stopped) return;
    const h = held();
    if (h?.own) return; // this board is already rebuilding: the tick is spent
    if (h) {
      const waited = now() - since;
      if (waited < maxDeferMs) { later(() => attempt(label, since, after), retryMs); return; }
      if (h.heap) {
        st.givenUp++; st.givenUpTotal++;
        if (!st.givenUpSince) st.givenUpSince = now();
        log.error(`[board-refresh] ${board}: ${label} given up after ${Math.round(waited / 60_000)} min (${h.why}); tries again in ${Math.round(givenUpRetryMs / 60_000)} min (${st.givenUp} given up in a row)`);
        if (!givenUpRetry) givenUpRetry = later(() => { givenUpRetry = null; attempt("retry of a given-up rebuild", now(), after); }, givenUpRetryMs);
        return;
      }
      log.warn(`[board-refresh] ${board}: ${label} runs after waiting ${Math.round(waited / 60_000)} min (${h.why})`);
    }
    if (givenUpRetry) { clearTimer(givenUpRetry); timers.delete(givenUpRetry); givenUpRetry = null; }
    st.givenUp = 0; st.givenUpSince = 0;
    st.lastStartedAt = now();
    const token = {};
    running = board; runningToken = token;
    const abort = new AbortController();
    // The bound is not this schedule's to cancel: a schedule stopped while
    // its rebuild hangs must still give the gate back.
    const bound = setTimer(() => {
      if (runningToken !== token) return;
      running = null; runningToken = null;
      st.overran = true; st.overranTotal++;
      log.error(`[board-refresh] ${board}: ${label} still running after ${Math.round(runMaxMs / 60_000)} min; the gate is released and the next slot tries again`);
      try { abort.abort(); } catch { /* a listener's throw is not ours */ }
    }, Math.max(0, runMaxMs));
    bound?.unref?.();
    Promise.resolve()
      .then(() => run({ slot: label === "slot", signal: abort.signal }))
      .catch(() => {})
      .finally(() => {
        clearTimer(bound);
        // Released at its bound already: a later run may hold the gate, so
        // this one releases nothing, clears no flag and starts no second pass.
        if (runningToken !== token) return;
        running = null; runningToken = null;
        st.overran = false; st.lastFinishedAt = now();
        if (after) after();
      });
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
