// What does this process actually talk to, continuously, in production?
//
// Three cost leaks were found by an invoice rather than by us - Alchemy
// (crawlers holding a cache warm), Brave (CI's own sweep), CDP SQL (a public
// page billing per seller wallet). Each fix was followed by a guard built from
// a list of vendors someone remembered, and a list cannot find what nobody
// thought of. scripts/egress-census.js measures instead, but it drives a
// synthetic sweep of pages we chose - so it sees the traffic we imagined, not
// the traffic that arrives.
//
// This is the always-on version. It counts every outbound request by host, in
// the real process, under real crawler load. The leaks all looked like ordinary
// traffic until someone totalled it up; this totals it up continuously.
//
// DESIGN CONSTRAINTS, because this sits on the hot path of every outbound call:
//   * O(1) per request ONCE a host is known - one Map lookup and an integer
//     increment. A stack trace is materialised only until a host has four
//     attributions, because building one per call is expensive enough to slow
//     boot measurably (it did, and the shutdown test caught it).
//   * never throws: a metering bug must not break a tool call. Every hook is
//     wrapped, and on any internal error it degrades to a plain pass-through
//   * no URLs, no paths, no query strings retained. Host only. A full URL log
//     would capture buyer-supplied inputs (a render target, a search query),
//     which is customer data we have no reason to hold
//   * bounded memory: hosts are capped, and the counter resets daily
const MAX_HOSTS = 2000;          // far above the ~1,300 seen in a census run
const counts = new Map();        // host -> { n, callers:Set, firstAt, lastAt }
let day = "";
let installed = false;
let dropped = 0;                 // hosts not recorded because the cap was hit

function today() { return new Date().toISOString().slice(0, 10); }

function rollIfNeeded() {
  const t = today();
  if (t !== day) { day = t; counts.clear(); dropped = 0; }
}

// Transport plumbing every outbound call passes through. Naming these as the
// caller is technically true and completely useless - "fetch-guard.js" does not
// tell you which feature is spending money, which is the only question the
// meter exists to answer. Skip them and report the first frame that is a real
// caller, falling back to the plumbing only if there is nothing else.
// Frames that sit BETWEEN a caller and the network without being the caller:
// the SSRF guard, this meter, and the two global fetch wrappers. Missing one
// makes every host read as that wrapper (the drain-aware fetch shipped
// 2026-09-02 and the Alchemy row read "drain-abort.js" within the hour).
const PLUMBING = /\/src\/tools\/fetch-guard\.js|\/src\/egress-meter\.js|\/src\/drain-abort\.js|\/src\/facilitator-diagnostics\.js/;

/** Which src/ file initiated this? Best-effort, first NON-plumbing frame.
 *
 *  Scans the WHOLE stack, not a 18-line window. The window version reported
 *  "egress-meter.js" for every metered vendor in a production census — the
 *  meter blaming itself — because the app frame was never inside it. Two
 *  independent causes, both fixed here and both needed:
 *
 *    1. Error.stackTraceLimit defaults to 10. Three of those frames are this
 *       module's own plumbing, so a caller more than ~7 frames down was never
 *       captured at all. See captureStack() for the lift.
 *    2. A request made from inside a vendor SDK (viem, the CDP client) has no
 *       /src/ frame anywhere near the top, so the /src/-only match found
 *       nothing and returned the plumbing fallback. An SDK is still a useful
 *       answer — "this is the CDP client, not our code" narrows the search a
 *       lot — so a package name is reported rather than discarded.
 *
 *  Preference order: our own code, then the package that called out, then "?".
 *  Never the plumbing unless there is genuinely nothing else. */
function callerOf(stack) {
  try {
    const lines = String(stack || "").split("\n").slice(1);
    let plumbing = "";
    let pkg = "";
    for (const line of lines) {
      const m = line.match(/\/src\/([A-Za-z0-9._/-]+\.js)/);
      if (m) {
        if (PLUMBING.test(line)) { plumbing = plumbing || m[1]; continue; }
        return m[1];                       // our code — the answer we want
      }
      if (!pkg) {
        // Deepest-wins would name a transport shim; the FIRST node_modules
        // frame is the package our code actually called.
        const p = line.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
        if (p) pkg = `pkg:${p[1]}`;
      }
    }
    return pkg || plumbing || "?";
  } catch { /* attribution is a nicety, never a failure */ }
  return "?";
}

/** Materialise a stack deep enough to contain the app frame.
 *
 *  The default limit of 10 is the reason attribution silently failed. Raised
 *  only for this capture and restored immediately, and only reached while a
 *  host still needs attribution (MAX_CALLERS), so the cost stays bounded to a
 *  handful of traces per host rather than one per request. */
function captureStack() {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  try { return new Error().stack; } finally { Error.stackTraceLimit = prev; }
}

const MAX_CALLERS = 4;

/** Record one outbound call.
 *
 *  `stack` may be a STRING or a FUNCTION returning one. Prefer the function:
 *  materialising a stack trace is by far the most expensive thing here, and it
 *  is only needed until a host has MAX_CALLERS attributions. The first version
 *  of this took a string and the fetch hook built it with `new Error().stack`
 *  on EVERY call - the comment above claimed "one Map lookup and an integer
 *  increment" while actually capturing a stack trace per request. At boot the
 *  index crawler makes hundreds of requests and it pushed startup past the
 *  20s budget in scripts/test-shutdown.js, which is how it was caught. */
export function recordEgress(host, stack) {
  try {
    if (!host) return;
    rollIfNeeded();
    let e = counts.get(host);
    if (!e) {
      if (counts.size >= MAX_HOSTS) { dropped++; return; }
      e = { n: 0, callers: new Set(), firstAt: Date.now(), lastAt: 0 };
      counts.set(host, e);
    }
    e.n++;
    e.lastAt = Date.now();
    // The hot path for a host we already know: increment and leave. No Error
    // is constructed, which is the whole point.
    if (e.callers.size >= MAX_CALLERS) return;
    const s = typeof stack === "function" ? stack() : stack;
    e.callers.add(callerOf(s));
  } catch { /* metering must never break a request */ }
}

/** Does this host still need attribution? Lets a caller skip building a stack
 *  entirely, rather than building one and having it discarded. */
export function needsCaller(host) {
  try {
    const e = counts.get(host);
    return !e || e.callers.size < MAX_CALLERS;
  } catch { return false; }
}

/** Install the hooks. Idempotent; safe to call once at boot. */
export function installEgressMeter() {
  if (installed) return false;
  installed = true;
  day = today();
  const origFetch = globalThis.fetch;
  if (typeof origFetch === "function") {
    globalThis.fetch = function meteredFetch(input, init) {
      try {
        let h = "";
        if (typeof input === "string") h = new URL(input).host;
        else if (input instanceof URL) h = input.host;
        else if (input && typeof input.url === "string") h = new URL(input.url).host;
        // Lazy: the stack is only materialised while this host still needs
        // attribution. Building it unconditionally is what slowed boot.
        if (h) recordEgress(h, needsCaller(h) ? captureStack : null);
      } catch { /* an unparseable input is the caller's problem, not ours */ }
      return origFetch.apply(this, arguments);
    };
  }
  return true;
}

/** Snapshot for the operator surface. Host + counts + callers only. */
export function egressReport({ top = 60 } = {}) {
  rollIfNeeded();
  const rows = [...counts.entries()]
    .map(([host, e]) => ({
      host,
      calls: e.n,
      callers: [...e.callers],
      firstAt: new Date(e.firstAt).toISOString(),
      lastAt: new Date(e.lastAt).toISOString(),
    }))
    .sort((a, b) => b.calls - a.calls);
  return {
    day,
    distinctHosts: rows.length,
    totalCalls: rows.reduce((a, r) => a + r.calls, 0),
    droppedHosts: dropped,
    note: "Host-level only, reset daily. Counts every outbound request this process made, "
      + "so a metered vendor appearing here with a non-tool caller is spend with no revenue attached.",
    hosts: rows.slice(0, top),
  };
}

/** Test seam: clear state without restarting. */
export function __resetEgressMeter() { counts.clear(); dropped = 0; day = today(); }
