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
// A RUN ALREADY PAID FOR is never refused by the pace, and starts first. A
// read of a run whose payment settled before its upstream work
// (src/settle-first.js) waits in a line of its own, first come first served,
// bounded by the run's ceiling and the caller's signal alone, so our own pace
// is never a charged failure. The read holding the next place in the unpaid
// line yields it while a paid read waits: each place that opens goes to the
// paid line first, then to the line, and every start is still counted by the
// one window, so the pace to the source is the same whoever starts.
// Paid means the payment is final, and a settlement that failed is unpaid.
// While a run's settlement is still in flight its reads are answered no 503
// of the pace: a read that would be refused (on arrival, or at its deadline in
// the line) waits for the outcome instead, to the run's ceiling or its
// caller's signal. On success it joins the paid line; on failure it is an
// unpaid read from then on.
// A run ARMED to settle at its settle point that has not reached it yet (the
// server armed it from a verified payment, src/settle-first.js
// settleArmedHere) is held the same way: one leg's read answered 503 here,
// while another leg of the same run goes on to settle, would fail a run that
// is then charged. Such a read keeps its place in the line like any unpaid
// read, and only where it would be answered the pace's 503 does it wait in
// the paid line instead. It is judged again when its place comes: it starts
// while the run is still armed, settling or paid, and is answered the 503 when
// the settlement failed or the handler ended without one (nothing was
// charged). A run that was never armed, which is every run served before it
// is charged, is unchanged.
//
// EACH READ IS JUDGED IN ITS OWN REQUEST'S SCOPE. Whether a run is paid, and
// whether its settlement is in flight, are read from the request scope the
// call runs in (an AsyncLocalStorage). The pace wakes one read from another's
// turn (the paid line hands the next place back to the unpaid holder), and a
// timer set there would inherit the waker's scope. So a read keeps the scope
// it arrived in (AsyncLocalStorage.snapshot) and everything done for it
// later, by whoever wakes it, runs inside that scope.
//
// PER PROCESS, SHARED BY PRESENCE. The count lives in this process; with
// more than one replica each takes its share of the pace (RATE_LIMIT_REPLICAS,
// as the rate limiter and the unpaid-quote budget do), so the replicas
// together stay under it. A deploy runs the old and the new process side by
// side for a while, which the replica count does not see, so with the shared
// store on (REDIS_URL) each process also says it is there every
// SEC_PEER_BEAT_MS (createSecPresence) and takes its share of the processes it
// sees. A process that has just arrived takes what is left under the SEC's
// own ten (SEC_SOURCE_PER_SECOND) beside a full share until the others have
// seen it and their windows have rolled; a process that cannot read the
// store takes the share of one more process than it last saw. So the old and
// the new process together stay at or under ten starts a second however the
// deploy overlaps. Without the shared store the share is the replica count's.
//
// THE PAID LINE IS BOUNDED for reads of runs ARMED to settle (not yet paid):
// past SEC_PAID_LINE_FACTOR times the unpaid line's length an armed read is
// answered as the unpaid read it still is (the pace's 503, uncharged unless
// its run then settles, when the charged-failure rules book it owed). A read
// of a run already paid for always joins it and is never refused; its wait
// is bounded by the line ahead of it, the run's ceiling and its caller.
//
// Every fetch of a host in SEC_HOSTS goes through secPaced
// (scripts/test-sec-rate.js fails a file that reaches one without it).
import { currentBudget } from "../upstream-deadline.js";
import { ceilingLeftMs, ceilingPassed, ceilingCutError } from "../run-ceiling.js";
import { notChargedHere } from "../not-charged.js";
import { createCallerTurns, TurnRefused } from "../caller-turns.js";
import { admissionCallerOf, currentCallerLeftSignal } from "../dispatch-caller.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { paidBeforeRunHere, settleInFlightHere, settleArmedHere } from "../settle-first.js";
import { shared, sharedLimitsEnabled } from "../shared-limits.js";
import { randomUUID } from "node:crypto";

export const SEC_HOSTS = Object.freeze(["sec.gov", "www.sec.gov", "data.sec.gov", "efts.sec.gov"]);
/** Whether a URL names one of the SEC's hosts (the ones the pace covers). */
export function isSecHost(url) {
  try { return SEC_HOSTS.includes(new URL(String(url)).hostname.toLowerCase()); } catch { return false; }
}

/** Starts per rolling second across every replica: under the SEC's ten. */
export const SEC_STARTS_PER_SECOND_TOTAL = 8;
/** The SEC's own bound for one client, per second. */
export const SEC_SOURCE_PER_SECOND = 10;
/** How often a process says it is there (createSecPresence). */
export const SEC_PEER_BEAT_MS = 2_000;
/** An armed read joins the paid line only while it is shorter than this many unpaid lines. */
export const SEC_PAID_LINE_FACTOR = 4;
// The second, plus a margin: a read's turn is stamped a moment before its
// request leaves, so the margin keeps the pace true by the request's own clock.
export const SEC_WINDOW_MS = 1050;
/** The longest a read waits for its turn. */
export const SEC_MAX_WAIT_MS = 10_000;
/** What a read still needs of the handler budget after its wait. */
export const SEC_READ_RESERVE_MS = 3_000;
export const SEC_BUSY_RETRY_AFTER_S = 2;

const replicasOf = (env) => Math.max(1, Math.floor(Number(env.RATE_LIMIT_REPLICAS) || 1));
/** This process's share of the pace by the replica count alone. */
export function secStartsPerSecond(env = process.env) {
  return Math.max(1, Math.floor(SEC_STARTS_PER_SECOND_TOTAL / replicasOf(env)));
}

/** The processes pacing SEC reads together, as the shared store sees them
 *  (see PER PROCESS above). `share()` is this process's starts per second
 *  now; `beat()` says this process is there and reads how many are. */
export function createSecPresence({ store = shared, enabled = sharedLimitsEnabled, env = process.env, beatMs = SEC_PEER_BEAT_MS, windowMs = SEC_WINDOW_MS, clock = Date.now, id = randomUUID() } = {}) {
  const ttlMs = 3 * beatMs;
  // From the first beat the others read, their next beat and one window of
  // their starts rolling off: then they have made room.
  const joinMs = beatMs + windowMs + 250;
  let joinedAt = null, okAt = 0, peers = 1, timer = null;
  const on = () => { try { return enabled() === true; } catch { return false; } };
  async function beat() {
    if (!on()) return;
    const now = clock();
    let r = null;
    try { r = await store.windowAdd("sec-pace-peers", "all", { windowMs: ttlMs, member: id, now }); } catch { r = null; }
    if (r?.ok && Number.isFinite(Number(r.count))) {
      peers = Math.max(1, Math.floor(Number(r.count)));
      okAt = now;
      if (joinedAt === null) joinedAt = now;
    }
  }
  function share(now = clock()) {
    const replicas = replicasOf(env);
    const base = Math.max(1, Math.floor(SEC_STARTS_PER_SECOND_TOTAL / replicas));
    if (!on()) return base;
    // Not yet seen by the others: what is left under the source's bound beside full shares.
    if (joinedAt === null || now - joinedAt < joinMs) return Math.max(1, Math.min(base, SEC_SOURCE_PER_SECOND - SEC_STARTS_PER_SECOND_TOTAL));
    // The store has not answered lately: one more process than last seen.
    if (now - okAt > ttlMs) return Math.max(1, Math.floor(SEC_STARTS_PER_SECOND_TOTAL / (Math.max(replicas, peers) + 1)));
    return Math.max(1, Math.floor(SEC_STARTS_PER_SECOND_TOTAL / Math.max(replicas, peers)));
  }
  function start() {
    if (timer || !on()) return;
    void beat();
    timer = setInterval(() => { void beat(); }, beatMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }
  return { beat, share, start, stop, status: () => ({ peers, joined: joinedAt !== null }) };
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
 *  of a caller that has left, `paidOf()` whether the run is already paid for,
 *  `pendingOf()` the run's settlement in flight (a promise that ends with its
 *  outcome) or null, `armedOf()` whether the run is armed to settle and has
 *  not reached its settle point. */
export function createSecPace({ perSecond = secStartsPerSecond(), lineLimit = null, windowMs = SEC_WINDOW_MS, maxWaitMs = SEC_MAX_WAIT_MS, queueMax = null, now = () => performance.now(),
  callerOf = () => admissionCallerOf(null), leftSignalOf = currentCallerLeftSignal, paidOf = paidBeforeRunHere, pendingOf = settleInFlightHere, armedOf = settleArmedHere } = {}) {
  // `perSecond` is a number, or a function read at every start (the process's
  // share as its presence sees it); `lineLimit` sizes the line for it.
  const limitNow = typeof perSecond === "function" ? () => { let v = 1; try { v = Number(perSecond()); } catch { v = 1; } return Math.max(1, Math.floor(v) || 1); } : null;
  const limit = Math.max(1, Math.floor(lineLimit ?? (limitNow ? limitNow() : perSecond)));
  const current = limitNow || (() => limit);
  // What the pace can start inside the longest wait: a place past it is
  // never reached in time.
  const lineMax = queueMax ?? Math.max(limit, Math.ceil((limit * maxWaitMs) / windowMs));
  const paidLineMax = SEC_PAID_LINE_FACTOR * lineMax;
  const recent = []; // start times inside the window, oldest first (at most `limit`)
  // The line: one lane, so one read at a time holds the next place to open,
  // and the room orders the rest across callers.
  const turns = createCallerTurns({ maxRunning: 1, maxWaiters: lineMax, hardWaiters: lineMax, now });
  const active = new Set(); // reads waiting (in the room, holding the next place, or in the paid line)
  const paidLine = []; // reads of runs already paid for, oldest first: `serve()` starts one
  let paidTimer = null; // the paid line's wait for the next place
  let yielded = null;   // the unpaid line holder's `place`, held back while a paid read waits
  let started = 0, refused = 0, longestLine = 0;

  const prune = (t) => { while (recent.length && t - recent[0] >= windowMs) recent.shift(); };
  /** Take a place in the window now, or say when the next one opens. */
  const take = () => {
    const t = now();
    prune(t);
    const L = current();
    if (recent.length < L) { recent.push(t); started++; return 0; }
    // The window holds L or more: the place opens when all but L - 1 have left it.
    return Math.max(1, Math.ceil(recent[recent.length - L] + windowMs - t));
  };
  /** When the `k`-th start from now can leave at the earliest. */
  const earliest = (k) => {
    const t = now();
    prune(t);
    const sim = recent.slice();
    const L = current();
    let at = t;
    for (let i = 0; i < k; i++) {
      if (sim.length >= L) at = Math.max(at, sim[sim.length - L] + windowMs);
      sim.push(at);
    }
    return at - t;
  };
  const busyRefusal = () => { refused++; return secBusyError(); };
  /** Start paid reads in the order they came while places are open, then
   *  hand the next place back to the line's holder. */
  const servePaid = () => {
    clearTimeout(paidTimer); paidTimer = null;
    while (paidLine.length) {
      const wait = take();
      if (wait !== 0) { paidTimer = setTimeout(servePaid, wait); return; }
      paidLine.shift().serve();
    }
    const next = yielded;
    yielded = null;
    if (next) next();
  };

  /** Resolves when this read may start; rejects when its wait ended first. */
  function turn({ signal = undefined, waitMs = null } = {}) {
    if (ceilingPassed()) return Promise.reject(ceilingCutError());
    if (signal === undefined) { try { signal = leftSignalOf() || null; } catch { signal = null; } }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const room = turns.state(LANE);
    if (!room.busy && !room.waitingAll && !active.size && take() === 0) return Promise.resolve();
    // This read's own scope: every later step for it runs inside it.
    const mine = AsyncLocalStorage.snapshot();
    let paid = false;
    try { paid = paidOf() === true; } catch { paid = false; }
    // The deadline: the handler budget less what the read needs, the longest
    // wait, or what the caller gave, whichever is least. A run already paid
    // for has none: its wait ends at the ceiling or on its signal.
    const budget = currentBudget();
    const budgetLeft = budget ? budget.remaining() - SEC_READ_RESERVE_MS : Infinity;
    let allowed = paid ? Infinity : Math.min(maxWaitMs, budgetLeft, Number.isFinite(Number(waitMs)) && waitMs != null ? Number(waitMs) : Infinity);
    let who = null;
    try { who = callerOf(); } catch { who = null; }
    // A place the pace cannot reach in time: the read holding the next place
    // and this caller's own earlier reads start first, whoever else waits.
    // With the run's settlement in flight that read is not refused: it waits
    // for the outcome first (`settling`, below).
    const inFlight = () => { if (paid) return null; let p = null; try { p = mine(pendingOf); } catch { p = null; } return p && typeof p.then === "function" ? p : null; };
    const late = !paid && (!(allowed > 0) || earliest((room.busy ? 1 : 0) + turns.ownAhead(who) + 1) >= allowed);
    // An armed run that has not reached its settle point is held too.
    const armedNow = () => { if (paid) return false; try { return mine(armedOf) === true; } catch { return false; } };
    const settling = late ? inFlight() : null;
    const armedLate = late && !settling && paidLine.length < paidLineMax && armedNow();
    if (late && !settling && !armedLate) return Promise.reject(busyRefusal());

    return new Promise((resolve, reject) => {
      const t0 = now();
      let done = false, timer = null, ceiling = null, pending = null, held = null;
      const me = { finish: null, serve: null };
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(ceiling);
        signal?.removeEventListener?.("abort", onAbort);
        active.delete(me);
        if (yielded === place) yielded = null;
        const inPaid = paidLine.indexOf(me);
        // A paid read that left (its ceiling, its caller) leaves its line; the
        // line's wait for the next place then hands it to the holder.
        if (inPaid >= 0) paidLine.splice(inPaid, 1);
        if (pending && !held) pending.cancel();
        if (held) held.release();
        settle(value);
      };
      me.finish = () => finish(resolve);
      me.serve = me.finish;
      const onAbort = () => finish(reject, abortReason(signal));
      // The pace's own refusal of a waiting read. The run is read once more
      // first: a payment that became final during the wait makes this a paid
      // read, which leaves the line for the paid one and is never refused.
      // Leave the unpaid line (a place held or waited for), still waiting.
      const leaveLine = () => {
        clearTimeout(timer); timer = null;
        if (yielded === place) yielded = null;
        if (pending && !held) pending.cancel();
        pending = null;
        if (held) { const t = held; held = null; t.release(); }
      };
      // A settlement in flight: nothing is answered until its outcome is
      // known (the ceiling and the caller's signal still end the wait). Then
      // the run is read once more: paid joins the paid line, unpaid is refused.
      const awaitOutcome = (p) => { leaveLine(); const again = () => mine(() => { if (!done) refuse(true); }); p.then(again, again); };
      // An armed run's read, where the pace would refuse it: it waits in the
      // paid line, and is judged again when its place comes.
      const holdArmed = () => {
        // The paid line is full of armed reads: this one is the unpaid read it still is.
        if (paidLine.length >= paidLineMax) return finish(reject, busyRefusal());
        allowed = Infinity;
        leaveLine();
        me.serve = () => mine(() => {
          if (done) return;
          let backed = false;
          try { backed = paidOf() === true; } catch { backed = false; }
          if (backed || armedNow() || inFlight()) return finish(resolve);
          finish(reject, busyRefusal());
        });
        paidLine.push(me);
        if (!paidTimer) servePaid();
      };
      const refuse = (known = false) => {
        let nowPaid = false;
        if (!paid) { try { nowPaid = mine(paidOf) === true; } catch { nowPaid = false; } }
        if (!nowPaid) {
          const p = known ? null : inFlight();
          if (p) return awaitOutcome(p);
          if (!known && armedNow()) return holdArmed();
          return finish(reject, busyRefusal());
        }
        paid = true; allowed = Infinity;
        leaveLine();
        paidLine.push(me);
        if (!paidTimer) servePaid();
      };
      // The next place to open is this read's, unless a paid read waits: take
      // it, or wait for it (to its own deadline, as ever).
      // Called from this read's own turn, from its timer, or by the paid
      // line's pump in another read's turn: always run in this read's scope,
      // so the timers it sets are this read's too.
      const place = () => mine(placeNow);
      const placeNow = () => {
        if (done) return;
        clearTimeout(timer);
        if (Number.isFinite(allowed) && now() - t0 >= allowed) return refuse();
        if (paidLine.length) {
          yielded = place;
          if (Number.isFinite(allowed)) timer = setTimeout(place, Math.max(1, Math.ceil(allowed - (now() - t0))));
          return;
        }
        const wait = take();
        if (wait === 0) return finish(resolve);
        timer = setTimeout(place, Number.isFinite(allowed) ? Math.max(1, Math.min(wait, Math.ceil(allowed - (now() - t0)))) : wait);
      };
      active.add(me);
      if (active.size > longestLine) longestLine = active.size;
      const left = ceilingLeftMs();
      if (left !== Infinity) ceiling = setTimeout(() => finish(reject, ceilingCutError()), Math.max(1, Math.floor(left)));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (paid) { paidLine.push(me); if (!paidTimer) servePaid(); return; }
      if (settling) { awaitOutcome(settling); return; }
      if (armedLate) { holdArmed(); return; }
      pending = turns.acquire(LANE, who, { waitMs: Math.max(1, Math.floor(allowed)) });
      pending.then((t) => {
        if (done) { t.release(); return; }
        held = t;
        place();
      }, (e) => {
        // "left" is this read's own cancel (finish already answered it).
        if (e instanceof TurnRefused && e.why === "left") return;
        if (e instanceof TurnRefused) { pending = null; return refuse(); }
        finish(reject, e);
      });
    });
  }

  /** Run `read` (the function that makes ONE request) at this pace. */
  async function paced(read, opts = {}) {
    await turn(opts);
    return read();
  }

  return { paced, turn, limit, lineMax, paidLineMax,
    status: () => ({ limit: current(), waiting: active.size, paidWaiting: paidLine.length, inWindow: (prune(now()), recent.length), started, refused, longestLine }),
    _reset: () => { recent.length = 0; clearTimeout(paidTimer); paidTimer = null; paidLine.length = 0; yielded = null; for (const w of [...active]) w.finish(); turns.reset(); started = 0; refused = 0; longestLine = 0; } };
}

const presence = createSecPresence();
presence.start();
const pace = createSecPace({ perSecond: () => presence.share(), lineLimit: secStartsPerSecond() });

/** Run `read`, a function that starts ONE request to an SEC host, in its turn.
 *  `signal` ends the wait when the caller's own work is canceled; without
 *  one, the dispatching request's own signal does (currentCallerLeftSignal). */
export function secPaced(read, opts = {}) { return pace.paced(read, opts); }
/** Counts for a test or an operator view: no host, URL or caller. */
export function secPaceStatus() { return pace.status(); }
export function _resetSecPaceForTests() { pace._reset(); }
