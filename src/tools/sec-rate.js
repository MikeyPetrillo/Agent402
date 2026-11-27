// One pace for every request this process starts to the SEC's hosts.
//
// The SEC's fair-access policy for automated readers is a declared
// User-Agent (edgarUserAgent, src/tools/edgar-kit.js) and at most ten
// requests a second per client. Each EDGAR tool bounds its own reads, and
// several tools, reports and pages can run at once, so the bound that matters
// is one across all of them: at most SEC_STARTS_PER_SECOND requests STARTED in
// any rolling second, by this process, to any host in SEC_HOSTS.
//
// THIS PACES OUR OUTBOUND READS. It is not a limit on callers: no call is
// refused for how many came before it, and a read that finds the second full
// waits its turn and then runs as it always did.
//
// WHOSE TURN. Turns are fair across callers (src/caller-turns.js, the rule the
// OCR engines use; src/dispatch-caller.js names the caller: the signed payer,
// a credits key, a Tempo sender, then the client address, and one shared key
// for work no request asked for, such as a page build). One caller's burst
// stands behind its own earlier reads, so another caller's read is the next
// to start when a place opens, and a caller that already holds places is the
// one answered busy when the line is full.
//
// THE WAIT IS BOUNDED AND ENDS WITH THE RUN. A waiting read leaves the line
// when the first of these comes:
//   - its turn;
//   - its deadline: the handler budget it runs under (src/upstream-deadline.js
//     currentBudget) less what a read still needs, never more than
//     SEC_MAX_WAIT_MS. Past it the call is answered 503 with Retry-After,
//     "the source is busy": our own pace, nothing was read, nothing charged.
//     A read the pace cannot start before that deadline even if nobody else
//     were ahead of it (the holder of the next place and the caller's own
//     earlier reads counted, no one else) is answered the same 503 at once
//     instead of waiting for it;
//   - the run's ceiling (src/run-ceiling.js): a 504 (ceilingCutError), and
//     nothing starts once the ceiling has passed, so a tool whose reads come
//     through here keeps its `endsAtCeiling` mark;
//   - the caller's signal: the one passed, or the dispatching request's own
//     (currentCallerLeftSignal: its connection closed before the first byte
//     and its call is no longer charged).
// The line holds at most SEC_QUEUE_MAX waiting reads (what the pace can start
// inside the longest wait), so it cannot grow without bound.
//
// A RUN ALREADY PAID FOR is never refused by the pace. A read of a run whose
// payment settled before its upstream work (src/settle-first.js) waits for
// the next place outside the line, bounded by the run's ceiling and the
// caller's signal alone, so our own pace is never a charged failure.
//
// PER PROCESS. The count lives in this process; with more than one replica
// each takes its share of the pace (RATE_LIMIT_REPLICAS, as the rate limiter
// and the unpaid-quote budget do), so the replicas together stay under it.
//
// Every fetch of a host in SEC_HOSTS goes through secPaced
// (scripts/test-sec-rate.js fails a file that reaches one without it).
import { currentBudget } from "../upstream-deadline.js";
import { ceilingLeftMs, ceilingPassed, ceilingCutError } from "../run-ceiling.js";
import { notChargedHere } from "../not-charged.js";
import { createCallerTurns, TurnRefused } from "../caller-turns.js";
import { admissionCallerOf, currentCallerLeftSignal } from "../dispatch-caller.js";
import { paidBeforeRunHere } from "../settle-first.js";

export const SEC_HOSTS = Object.freeze(["sec.gov", "www.sec.gov", "data.sec.gov", "efts.sec.gov"]);
/** Whether a URL names one of the SEC's hosts (the ones the pace covers). */
export function isSecHost(url) {
  try { return SEC_HOSTS.includes(new URL(String(url)).hostname.toLowerCase()); } catch { return false; }
}

/** Starts per rolling second across every replica: under the SEC's ten. */
export const SEC_STARTS_PER_SECOND_TOTAL = 8;
// The second, plus a margin: a read's turn is stamped a moment before its
// request leaves, so the margin keeps the pace true by the request's own clock.
export const SEC_WINDOW_MS = 1050;
/** The longest a read waits for its turn. */
export const SEC_MAX_WAIT_MS = 10_000;
/** What a read still needs of the handler budget after its wait. */
export const SEC_READ_RESERVE_MS = 3_000;
export const SEC_BUSY_RETRY_AFTER_S = 2;

/** This process's share of the pace. */
export function secStartsPerSecond(env = process.env) {
  const replicas = Math.max(1, Math.floor(Number(env.RATE_LIMIT_REPLICAS) || 1));
  return Math.max(1, Math.floor(SEC_STARTS_PER_SECOND_TOTAL / replicas));
}

/** The 503 of a read whose turn did not come in time. Our own pace: the
 *  source refused nothing, nothing was read and the call is not charged. */
export function secBusyError() {
  return Object.assign(new Error(`EDGAR is busy: this server paces its own reads of the source, and this call's turn did not come in time. Nothing was read.${notChargedHere()} Retry in a few seconds.`), {
    statusCode: 503, retryAfter: SEC_BUSY_RETRY_AFTER_S, attribution: "ours", hint: "source-busy", secBusy: true,
  });
}

const abortReason = (signal) => signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
const LANE = "sec";

/** A pace of its own (the process has one, below; tests build others).
 *  `callerOf()` names the caller a read runs for, `leftSignalOf()` the signal
 *  of a caller that has left, `paidOf()` whether the run is already paid for. */
export function createSecPace({ perSecond = secStartsPerSecond(), windowMs = SEC_WINDOW_MS, maxWaitMs = SEC_MAX_WAIT_MS, queueMax = null, now = () => performance.now(),
  callerOf = () => admissionCallerOf(null), leftSignalOf = currentCallerLeftSignal, paidOf = paidBeforeRunHere } = {}) {
  const limit = Math.max(1, Math.floor(perSecond));
  // What the pace can start inside the longest wait: a place past it is
  // never reached in time.
  const lineMax = queueMax ?? Math.max(limit, Math.ceil((limit * maxWaitMs) / windowMs));
  const recent = []; // start times inside the window, oldest first (at most `limit`)
  // The line: one lane, so one read at a time holds the next place to open,
  // and the room orders the rest across callers.
  const turns = createCallerTurns({ maxRunning: 1, maxWaiters: lineMax, hardWaiters: lineMax, now });
  const active = new Set(); // reads waiting (in the room, holding the next place, or outside the line)
  let started = 0, refused = 0, longestLine = 0;

  const prune = (t) => { while (recent.length && t - recent[0] >= windowMs) recent.shift(); };
  /** Take a place in the window now, or say when the next one opens. */
  const take = () => {
    const t = now();
    prune(t);
    if (recent.length < limit) { recent.push(t); started++; return 0; }
    return Math.max(1, Math.ceil(recent[0] + windowMs - t));
  };
  /** When the `k`-th start from now can leave at the earliest. */
  const earliest = (k) => {
    const t = now();
    prune(t);
    const sim = recent.slice();
    let at = t;
    for (let i = 0; i < k; i++) {
      if (sim.length >= limit) at = Math.max(at, sim[sim.length - limit] + windowMs);
      sim.push(at);
    }
    return at - t;
  };
  const busyRefusal = () => { refused++; return secBusyError(); };

  /** Resolves when this read may start; rejects when its wait ended first. */
  function turn({ signal = undefined, waitMs = null } = {}) {
    if (ceilingPassed()) return Promise.reject(ceilingCutError());
    if (signal === undefined) { try { signal = leftSignalOf() || null; } catch { signal = null; } }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const room = turns.state(LANE);
    if (!room.busy && !room.waitingAll && !active.size && take() === 0) return Promise.resolve();
    let paid = false;
    try { paid = paidOf() === true; } catch { paid = false; }
    // The deadline: the handler budget less what the read needs, the longest
    // wait, or what the caller gave, whichever is least. A run already paid
    // for has none: its wait ends at the ceiling or on its signal.
    const budget = currentBudget();
    const budgetLeft = budget ? budget.remaining() - SEC_READ_RESERVE_MS : Infinity;
    const allowed = paid ? Infinity : Math.min(maxWaitMs, budgetLeft, Number.isFinite(Number(waitMs)) && waitMs != null ? Number(waitMs) : Infinity);
    let who = null;
    try { who = callerOf(); } catch { who = null; }
    // A place the pace cannot reach in time: the read holding the next place
    // and this caller's own earlier reads start first, whoever else waits.
    if (!paid && (!(allowed > 0) || earliest((room.busy ? 1 : 0) + turns.ownAhead(who) + 1) >= allowed)) return Promise.reject(busyRefusal());

    return new Promise((resolve, reject) => {
      const t0 = now();
      let done = false, timer = null, ceiling = null, pending = null, held = null;
      const me = { finish: null };
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(ceiling);
        signal?.removeEventListener?.("abort", onAbort);
        active.delete(me);
        if (pending && !held) pending.cancel();
        if (held) held.release();
        settle(value);
      };
      me.finish = () => finish(resolve);
      const onAbort = () => finish(reject, abortReason(signal));
      // The next place to open is this read's: take it, or wait for it.
      const place = () => {
        if (done) return;
        if (Number.isFinite(allowed) && now() - t0 >= allowed) return finish(reject, busyRefusal());
        const wait = take();
        if (wait === 0) return finish(resolve);
        timer = setTimeout(place, Number.isFinite(allowed) ? Math.max(1, Math.min(wait, Math.ceil(allowed - (now() - t0)))) : wait);
      };
      active.add(me);
      if (active.size > longestLine) longestLine = active.size;
      const left = ceilingLeftMs();
      if (left !== Infinity) ceiling = setTimeout(() => finish(reject, ceilingCutError()), Math.max(1, Math.floor(left)));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (paid) { place(); return; }
      pending = turns.acquire(LANE, who, { waitMs: Math.max(1, Math.floor(allowed)) });
      pending.then((t) => {
        if (done) { t.release(); return; }
        held = t;
        place();
      }, (e) => {
        // "left" is this read's own cancel (finish already answered it).
        if (e instanceof TurnRefused && e.why === "left") return;
        finish(reject, e instanceof TurnRefused ? busyRefusal() : e);
      });
    });
  }

  /** Run `read` (the function that makes ONE request) at this pace. */
  async function paced(read, opts = {}) {
    await turn(opts);
    return read();
  }

  return { paced, turn, limit, lineMax,
    status: () => ({ limit, waiting: active.size, inWindow: (prune(now()), recent.length), started, refused, longestLine }),
    _reset: () => { recent.length = 0; for (const w of [...active]) w.finish(); turns.reset(); started = 0; refused = 0; longestLine = 0; } };
}

const pace = createSecPace();

/** Run `read`, a function that starts ONE request to an SEC host, in its turn.
 *  `signal` ends the wait when the caller's own work is canceled; without
 *  one, the dispatching request's own signal does (currentCallerLeftSignal). */
export function secPaced(read, opts = {}) { return pace.paced(read, opts); }
/** Counts for a test or an operator view: no host, URL or caller. */
export function secPaceStatus() { return pace.status(); }
export function _resetSecPaceForTests() { pace._reset(); }
