// A scheduled callback (setImmediate, setTimeout, an interval tick) runs on a
// turn of its own, so a throw inside it reaches process.on("uncaughtException"),
// which ends the process (src/server.js keeps that fatal on purpose: a process
// is undefined after an uncaught exception). Work that reads data other people
// wrote (a crawled seller listing, a stored row) runs on such turns in the
// background, and one bad listing must fail alone, never the process and never
// another seller's request.
//
// contained(name, fn) returns fn as a callback whose throw is kept: counted by
// name in a bounded map, logged with a bounded message at most once per name
// per minute, never rethrown. A promise fn returns is watched the same way, so
// an async tick's rejection is counted instead of surfacing as unhandled. The
// callback's own continuation (an interval's next tick, a reschedule the
// callback makes in a finally) runs as before; the wrapper changes only what a
// throw does. Counts are read on /__operator/perf.json (containedTurns).
//
// A loop that throws on every tick is a code defect, not one seller's data, so
// it must page: each name keeps a ring of the minutes it threw in, and the
// public word (containedTurns on /api/gateway-status) reads `repeating` while
// one name has thrown in each of the last three or more consecutive minutes,
// ending at the current minute or the one before it (so the word holds through
// the turn of a minute before that minute's tick lands), or while one name's
// last three or more runs all threw with no clean run between them and those
// throws fall in three or more distinct minutes (a loop that ticks every 30 or
// 60 minutes never throws in adjacent minutes; a clean run clears it). A single
// throw, two with a gap, or a burst inside one minute never trips it.
const NAMES_MAX = 200;
const NAME_MAX = 80;
const MESSAGE_MAX = 160;
const MINUTE_MS = 60_000;
const RING_MINUTES = 16; // distinct minute stamps kept per name
export const CONTAINED_LOG_EVERY_MS = 60_000;
export const CONTAINED_REPEATING_MINUTES = 3;

const byName = new Map(); // name -> { count, lastAt, lastMessage, loggedAt, minutes: number[] }
let total = 0;
let overflow = 0; // throws under a name the full map could not hold
let log = (line) => console.warn(line);
let clock = () => Date.now();

function messageOf(err) {
  const m = err instanceof Error ? err.message : typeof err === "string" ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  return String(m ?? "").replace(/\s+/g, " ").slice(0, MESSAGE_MAX);
}

/** Record a throw caught on a scheduled turn under `name` (bounded, logged once a minute per name). */
export function noteContainedThrow(name, err, { run = false } = {}) {
  const key = String(name || "unnamed").slice(0, NAME_MAX);
  const now = clock();
  total++;
  let row = byName.get(key);
  if (!row) {
    if (byName.size >= NAMES_MAX) { overflow++; return; }
    row = { count: 0, lastAt: 0, lastMessage: "", loggedAt: -Infinity, minutes: [], streak: 0, streakMinutes: new Set() };
    byName.set(key, row);
  }
  row.count++;
  row.lastAt = now;
  // A run of the wrapped callback (contained below) counts toward the
  // throwing-runs rule; a bare count from elsewhere does not, since it says
  // nothing about the runs between.
  if (run) {
    row.streak++;
    if (row.streakMinutes.size < CONTAINED_REPEATING_MINUTES) row.streakMinutes.add(Math.floor(now / MINUTE_MS));
  }
  row.lastMessage = messageOf(err);
  const minute = Math.floor(now / MINUTE_MS);
  if (row.minutes[row.minutes.length - 1] !== minute) {
    row.minutes.push(minute);
    if (row.minutes.length > RING_MINUTES) row.minutes.shift();
  }
  if (now - row.loggedAt >= CONTAINED_LOG_EVERY_MS) {
    row.loggedAt = now;
    try { log(`[contained-turn] ${key}: ${row.lastMessage || "(no message)"} (${row.count} contained so far)`); } catch { /* a logger never fails the turn */ }
  }
}

/** A clean run under `name`: ends its run of throwing ticks (a name that never threw holds no row). */
export function noteContainedOk(name) {
  const row = byName.get(String(name || "unnamed").slice(0, NAME_MAX));
  if (row && row.streak) { row.streak = 0; row.streakMinutes = new Set(); }
}

/** fn as a scheduled callback whose throw (or returned promise's rejection) is contained under `name`. */
export function contained(name, fn) {
  if (typeof fn !== "function") throw new TypeError("contained(name, fn): fn must be a function");
  return function containedTurn(...args) {
    let out;
    try { out = fn.apply(this, args); }
    catch (e) { noteContainedThrow(name, e, { run: true }); return undefined; }
    if (out && typeof out.then === "function") out.then(() => noteContainedOk(name), (e) => noteContainedThrow(name, e, { run: true }));
    else noteContainedOk(name);
    return out;
  };
}

// Consecutive minutes with a throw, counted back from the latest stamp, when
// that stamp is the current minute or the one before it; 0 otherwise.
function consecutiveMinutes(row, nowMinute) {
  const ms = row.minutes;
  if (!ms.length) return 0;
  const last = ms[ms.length - 1];
  if (last !== nowMinute && last !== nowMinute - 1) return 0;
  let run = 1;
  for (let i = ms.length - 1; i > 0 && ms[i - 1] === ms[i] - 1; i--) run++;
  return run;
}

// Every run since the last clean one threw, at least CONTAINED_REPEATING_MINUTES
// of them, across that many distinct minutes, the latest within
// CONTAINED_RUNS_STALE_MS (twice the slowest wrapped loop's 60-minute cadence),
// so a loop that stopped being scheduled does not hold the word forever.
export const CONTAINED_RUNS_STALE_MS = 2 * 60 * MINUTE_MS;
const throwingTicks = (r, now) => r.streak >= CONTAINED_REPEATING_MINUTES && r.streakMinutes.size >= CONTAINED_REPEATING_MINUTES && now - r.lastAt <= CONTAINED_RUNS_STALE_MS;

/** Names throwing in each of the last CONTAINED_REPEATING_MINUTES or more
 *  consecutive minutes, or on each of their last that many runs (see above). */
export function repeatingContainedNames(now = clock()) {
  const nowMinute = Math.floor(now / MINUTE_MS);
  const out = [];
  for (const [k, r] of byName) if (consecutiveMinutes(r, nowMinute) >= CONTAINED_REPEATING_MINUTES || throwingTicks(r, now)) out.push(k);
  return out;
}

/** The public word: { status: "ok" | "repeating" }; the operator view (full) adds the names. */
export function containedTurnsStatus({ full = false } = {}) {
  const repeating = repeatingContainedNames();
  const status = repeating.length ? "repeating" : "ok";
  return full ? { status, repeating } : { status };
}

/** Counts by name for the operator surface: { total, names, overflow, status, byName: { name: { count, lastAt, lastMessage } } }. */
export function containedTurnsSummary() {
  const out = {};
  const nowMinute = Math.floor(clock() / MINUTE_MS);
  for (const [k, r] of byName) out[k] = { count: r.count, lastAt: new Date(r.lastAt).toISOString(), lastMessage: r.lastMessage, consecutiveMinutes: consecutiveMinutes(r, nowMinute), throwingRuns: r.streak };
  return { total, names: byName.size, overflow, status: containedTurnsStatus().status, byName: out };
}

/** Test hook: clear the counts and point the log and clock elsewhere. */
export function _resetContainedTurnsForTest({ log: l = null, now = null } = {}) {
  byName.clear();
  total = 0;
  overflow = 0;
  log = typeof l === "function" ? l : (line) => console.warn(line);
  clock = typeof now === "function" ? now : () => Date.now();
}
