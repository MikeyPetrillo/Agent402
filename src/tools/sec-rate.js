// One pace for every request this process starts to the SEC's hosts.
//
// The SEC's fair-access policy for automated readers is a declared
// User-Agent (edgarUserAgent, src/tools/edgar-kit.js) and at most ten
// requests a second per client. Each EDGAR tool bounds its own reads, and
// several tools, reports and pages can run at once, so the bound that matters
// is one across all of them: at most SEC_STARTS_PER_SECOND requests STARTED in
// any rolling second, by this process, to any host in SEC_HOSTS.
//
// THIS PACES OUR OUTBOUND READS. It is not a limit on callers: nothing counts
// who asked, no call is refused for how many came before it, and a read that
// finds the second full waits its turn (first come, first served) and then
// runs as it always did.
//
// THE WAIT IS BOUNDED AND ENDS WITH THE RUN. A waiting read leaves the line
// when the first of these comes:
//   - its turn;
//   - its deadline: the handler budget it runs under (src/upstream-deadline.js
//     currentBudget) less what a read still needs, never more than
//     SEC_MAX_WAIT_MS. Past it the call is answered 503 with Retry-After,
//     "the source is busy": our own pace, nothing was read, nothing charged;
//   - the run's ceiling (src/run-ceiling.js): a 504 (ceilingCutError), and
//     nothing starts once the ceiling has passed, so a tool whose reads come
//     through here keeps its `endsAtCeiling` mark;
//   - the caller's own signal, when it passes one.
// The line holds at most SEC_QUEUE_MAX waiting reads (what the pace can start
// inside the longest wait, twice over), so it cannot grow without bound; a
// read that finds it full is answered the same 503 at once.
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

/** A pace of its own (the process has one, below; tests build others). */
export function createSecPace({ perSecond = secStartsPerSecond(), windowMs = SEC_WINDOW_MS, maxWaitMs = SEC_MAX_WAIT_MS, queueMax = null, now = () => performance.now() } = {}) {
  const limit = Math.max(1, Math.floor(perSecond));
  const lineMax = queueMax ?? Math.max(limit, Math.ceil((limit * maxWaitMs) / windowMs) * 2);
  const recent = []; // start times inside the window, oldest first (at most `limit`)
  const line = [];   // waiting reads, first come first
  let timer = null;
  let started = 0, refused = 0, longestLine = 0;

  const prune = (t) => { while (recent.length && t - recent[0] >= windowMs) recent.shift(); };
  function pump() {
    if (timer) { clearTimeout(timer); timer = null; }
    const t = now();
    prune(t);
    while (line.length && recent.length < limit) {
      const w = line.shift();
      recent.push(t);
      started++;
      w.go();
    }
    if (line.length) {
      // The next place opens when the oldest start leaves the window. (The
      // timers here hold the process open: a read in line is work in flight.)
      timer = setTimeout(pump, Math.max(1, Math.ceil(recent[0] + windowMs - now())));
    }
  }

  /** Resolves when this read may start; rejects when its wait ended first. */
  function turn({ signal = null, waitMs = null } = {}) {
    if (ceilingPassed()) return Promise.reject(ceilingCutError());
    if (signal?.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = now();
    prune(t);
    if (!line.length && recent.length < limit) { recent.push(t); started++; return Promise.resolve(); }
    // The deadline: the handler budget less what the read needs, the longest
    // wait, or what the caller gave, whichever is least.
    const budget = currentBudget();
    const budgetLeft = budget ? budget.remaining() - SEC_READ_RESERVE_MS : Infinity;
    const allowed = Math.min(maxWaitMs, budgetLeft, Number.isFinite(Number(waitMs)) && waitMs != null ? Number(waitMs) : Infinity);
    if (line.length >= lineMax || !(allowed > 0)) { refused++; return Promise.reject(secBusyError()); }
    return new Promise((resolve, reject) => {
      const w = { go: null };
      let done = false, deadline = null, ceiling = null;
      const leave = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(deadline); clearTimeout(ceiling);
        signal?.removeEventListener?.("abort", onAbort);
        const i = line.indexOf(w);
        if (i >= 0) line.splice(i, 1);
        settle(value);
      };
      const onAbort = () => leave(reject, signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
      w.go = () => leave(resolve);
      deadline = setTimeout(() => { refused++; leave(reject, secBusyError()); }, Math.max(1, Math.floor(allowed)));
      const left = ceilingLeftMs();
      if (left !== Infinity) { ceiling = setTimeout(() => leave(reject, ceilingCutError()), Math.max(1, Math.floor(left))); }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      line.push(w);
      if (line.length > longestLine) longestLine = line.length;
      if (!timer) pump();
    });
  }

  /** Run `read` (the function that makes ONE request) at this pace. */
  async function paced(read, opts = {}) {
    await turn(opts);
    return read();
  }

  return { paced, turn, limit, lineMax, status: () => ({ limit, waiting: line.length, inWindow: (prune(now()), recent.length), started, refused, longestLine }), _reset: () => { recent.length = 0; for (const w of line.splice(0)) w.go(); started = 0; refused = 0; longestLine = 0; if (timer) { clearTimeout(timer); timer = null; } } };
}

const pace = createSecPace();

/** Run `read`, a function that starts ONE request to an SEC host, in its turn.
 *  `signal` ends the wait when the caller's own work is cancelled. */
export function secPaced(read, opts = {}) { return pace.paced(read, opts); }
/** Counts for a test or an operator view: no host, URL or caller. */
export function secPaceStatus() { return pace.status(); }
export function _resetSecPaceForTests() { pace._reset(); }
