// A run's ceiling: the moment by which a caller needs a handler's upstream
// work to have ended, whatever each read's own timeout says.
//
// One caller sets it today: the referral gate (src/referral-gate.js), which
// stops waiting for a tool at its deadline and must not leave the tool
// reading upstream after the buyer was told nothing was charged. It runs the
// handler inside withRunCeiling(ms, fn). Every direct route runs with NO
// ceiling, and everything here is then a no-op: a read keeps its own timeout,
// its own error text and its own retries, unchanged.
//
// Two kinds of code read the ceiling:
//   - a budgeted handler (src/upstream-deadline.js underBudget): its budget
//     becomes the smaller of its own and what the ceiling has left;
//   - a read with a fixed timeout of its own (safeFetch and the retry helper
//     in src/tools/fetch-guard.js, and the few sockets and bare fetches the
//     kits open): its timeout becomes the smaller of its own and what the
//     ceiling has left (capByCeiling), or it is ended when the ceiling passes
//     (atCeiling), and no retry starts once the ceiling has passed.
//
// A tool definition whose EVERY upstream wait goes through one of those
// declares `endsAtCeiling: true` (markEndsAtCeiling): the gate serves it
// because its deadline really ends the tool's upstream work. The mark is a
// statement about the handler's code, so it is set next to that code, slug
// by slug, and never on a handler that opens a wait this module cannot end.
//
// No import: the fetch guard reads this module and imports nothing of the
// payment path.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

/** Run `fn` with a ceiling `ms` from now. Nested ceilings only ever shorten. */
export function withRunCeiling(ms, fn) {
  const endsAt = Date.now() + Math.max(1, Math.floor(Number(ms) || 1));
  const outer = store.getStore();
  return store.run({ endsAt: outer ? Math.min(outer.endsAt, endsAt) : endsAt }, fn);
}

/** Milliseconds the current run's ceiling has left (may be negative); Infinity with no ceiling. */
export function ceilingLeftMs() {
  const c = store.getStore();
  return c ? c.endsAt - Date.now() : Infinity;
}

/** True once the current run's ceiling has passed (never, with no ceiling). */
export const ceilingPassed = () => ceilingLeftMs() <= 0;

/** A read's timeout under the ceiling: `ms` itself with no ceiling, else the
 *  smaller of `ms` and what is left (at least 1 ms, so a timer still fires). */
export function capByCeiling(ms) {
  const left = ceilingLeftMs();
  return left === Infinity ? ms : Math.max(1, Math.floor(Math.min(Number(ms), left)));
}

/** Call `end` when the current run's ceiling passes (at once if it has).
 *  Returns a function that cancels the call; a no-op pair with no ceiling. */
export function atCeiling(end) {
  const left = ceilingLeftMs();
  if (left === Infinity) return () => {};
  const timer = setTimeout(() => { try { end(); } catch { /* ending a wait never throws out */ } }, Math.max(1, Math.floor(left)));
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Declare, on the tool definitions `tools` whose slug is in `slugs`, that
 *  every upstream wait of the handler ends at the run's ceiling. Returns the
 *  slugs named that were not found (a kit's own check). */
export function markEndsAtCeiling(tools, slugs) {
  const want = new Set(slugs);
  for (const t of tools) if (t && want.has(t.slug)) { t.endsAtCeiling = true; want.delete(t.slug); }
  return [...want];
}
