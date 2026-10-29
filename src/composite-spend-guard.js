import { AsyncLocalStorage } from "node:async_hooks";
// composite-spend-guard — protects the expensive composite tools (research-deep,
// dossier) from an upstream-drain grief. Because x402 settles AFTER the ~90s
// handler and a non-200 RELEASES the EIP-3009 nonce (the signed authorization
// stays reusable), a payer can present a verify-passing authorization, make us
// run costly OpenRouter/search work, then dodge settlement (e.g. move the funds
// out during the 90s window so settle fails), repeatedly, at ~zero cost to them.
// Each iteration burns real upstream spend with no revenue.
//
// This tracks per-payer "spent-then-failed-to-settle" events and blocks a payer
// who crosses the threshold BEFORE the next expensive run. A genuine paid 200
// is an outcome in the same window and does not erase failures: a payer is
// blocked at MAX_FAILS failures only while they are more than MIN_FAIL_SHARE
// of its outcomes there, and at HARD_MAX_FAILS whatever it settled, so a
// buyer settling many runs is not cut off by a few failures and interleaving
// paid runs with unpaid ones does not reset the count. In memory per replica
// (the per-call drain is small, blocks are short, and the gateway-balance alarm
// is the outer backstop), and shared across replicas through
// src/shared-limits.js when a Redis is configured: failures go to a shared
// window per payer and a shared global window, a block and the pause are
// shared flags, and the two consults read them with this process's own state
// as the floor (synchronous without a shared store, a promise with one; the
// dispatcher awaits both). Tune via env. Only the EVM EIP-3009 payer is guarded
// (that is the rail the reusable-nonce mechanic applies to).
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded } from "./shared-limits.js";
const WINDOW_MS = Number(process.env.COMPOSITE_GUARD_WINDOW_MS) || 15 * 60_000;
const MAX_FAILS = Number(process.env.COMPOSITE_GUARD_MAX_FAILS) || 3;
const BLOCK_MS = Number(process.env.COMPOSITE_GUARD_BLOCK_MS) || 30 * 60_000;
/** The share of a payer's outcomes in the window that must be failures
 *  (strictly more than this) before MAX_FAILS of them block it. */
const MIN_FAIL_SHARE = (() => { const n = Number(process.env.COMPOSITE_GUARD_MIN_FAIL_SHARE); return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.5; })();
/** Failures in the window that block a payer whatever it settled. */
const HARD_MAX_FAILS = Number(process.env.COMPOSITE_GUARD_HARD_MAX) || 10;
/** Settled outcomes kept per payer (the rule needs a count, not every stamp). */
const MAX_OKS_KEPT = 5000;
function tripped(nFails, nOks) {
  return nFails >= MAX_FAILS && (nFails >= HARD_MAX_FAILS || nFails > MIN_FAIL_SHARE * (nFails + nOks));
}

const fails = new Map();        // payer -> number[] (failure timestamps in window)
const oks = new Map();          // payer -> number[] (settled-run timestamps in window)
const blockedUntil = new Map(); // payer -> timestamp the block lifts
// Global circuit breaker: spend-then-fail events across ALL keys in the window.
// The per-key guard is evadable by rotating wallets/IPs; this bounds the total
// unsettled upstream burn regardless of who causes it. Trips to a short pause
// on every composite (503, nobody charged) rather than blocking any one buyer.
//
// Each buyer adds at most MAX_FAILS of its own failures to that count, so the
// pause answers several buyers failing together and never one buyer alone
// (one buyer is the per-key bound's job). A failure that is everyone's (a
// facilitator refusing every settlement) still reaches the threshold at the
// same number of failures, spread over a few buyers. A wallet's concurrent
// runs are also held to what its balance covers before they start
// (src/inflight-cover.js). A failure with no key counts as its own buyer.
const GLOBAL_MAX_FAILS = Number(process.env.COMPOSITE_GUARD_GLOBAL_MAX_FAILS) || 12;
const GLOBAL_PAUSE_MS = Number(process.env.COMPOSITE_GUARD_GLOBAL_PAUSE_MS) || 15 * 60_000;
let globalFailKeys = new Map(); // key -> failure times inside the window
let anonSeq = 0;
let globalPausedUntil = 0;

// ---- the shared half ----------------------------------------------------------
// cg-fail (per payer, one entry per failure), cg-ok (per payer, one entry per
// settled run), cg-block (flag per payer),
// cg-global (one entry per failure, at most MAX_FAILS per payer: the member
// is the payer plus the failure's index modulo MAX_FAILS, so a payer's later
// failures refresh its own entries instead of adding), cg-pause (flag).
const SHARED = sharedLimitsEnabled();
const PROC = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let sharedSeq = 0;
const CONTROL = "composite-spend-guard";
function sharedRecordFailure(payer, t, global) {
  const member = `${PROC}:${++sharedSeq}`;
  const perKey = payer
    ? sharedWrite(CONTROL, shared.windowAdd("cg-fail", payer, { windowMs: WINDOW_MS, member, now: t })).then((r) => {
      if (!r?.ok || r.count < MAX_FAILS) return r;
      return sharedWrite(CONTROL, shared.windowRead("cg-ok", payer, { windowMs: WINDOW_MS, now: t })).then((o) => {
        const nOks = Math.max(o?.ok ? o.count : 0, localOks(payer, t));
        if (!tripped(r.count, nOks)) return r;
        return Promise.all([
          sharedWrite(CONTROL, shared.flagSet("cg-block", payer, t + BLOCK_MS, { now: t })),
          sharedWrite(CONTROL, shared.windowClear("cg-fail", payer)),
        ]).then(() => r, () => r);
      });
    })
    : Promise.resolve({ ok: true, count: 1 });
  if (!global) return track(perKey);
  return track(perKey.then((r) => {
    const slot = r?.ok ? Math.max(0, r.count - 1) % MAX_FAILS : sharedSeq;
    return sharedWrite(CONTROL, shared.windowAdd("cg-global", "all", { windowMs: WINDOW_MS, member: payer ? `${payer}#${slot}` : `anon:${member}`, now: t }));
  }).then((r) => {
    if (!r?.ok || r.count < GLOBAL_MAX_FAILS) return;
    if (globalPausedUntil <= t) globalPausedUntil = t + GLOBAL_PAUSE_MS;
    return Promise.all([
      sharedWrite(CONTROL, shared.flagSet("cg-pause", "all", t + GLOBAL_PAUSE_MS, { now: t })),
      sharedWrite(CONTROL, shared.windowClear("cg-global", "all")),
    ]);
  }));
}
// The shared writes a failure starts (block, global window, pause) are a
// chain nobody on the request path waits for. A test awaits the whole chain
// rather than counting round trips.
const pendingShared = new Set();
function track(p) {
  const q = Promise.resolve(p).catch(() => {}).finally(() => pendingShared.delete(q));
  pendingShared.add(q);
  return q;
}
export function __compositeGuardSharedSettled() { return Promise.all([...pendingShared]); }
async function sharedBlocked(payer, now) {
  const r = await shared.flagGet("cg-block", payer, { now });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return false; }
  return r.until > now;
}
async function sharedPaused(now) {
  const r = await shared.flagGet("cg-pause", "all", { now });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return false; }
  return r.until > now;
}
function globalFailCount(t) {
  let n = 0;
  for (const [k, times] of globalFailKeys) {
    const kept = times.filter((x) => t - x < WINDOW_MS);
    if (!kept.length) { globalFailKeys.delete(k); continue; }
    globalFailKeys.set(k, kept);
    n += Math.min(kept.length, MAX_FAILS);
  }
  return n;
}
// Upstream usage telemetry for composites (the most expensive calls we make,
// invisible to the gateway's per-call margin event): running totals here, and
// a PostHog event per run when PostHog is configured.
const usage = { runs: 0, ok: 0, failed: 0, upstreamUsd: 0, overCap: 0, lastOverCap: null, bySlug: {} };

/** Slugs whose handlers run long, expensive upstream work before settlement.
 * Every composite that fans out to metered upstream (OpenRouter synthesis and
 * the probes that feed it) MUST be here, or its agent path is
 * an unguarded upstream-drain. `scripts/test-composite-guard.js` asserts the
 * full set so a new expensive product can't ship outside the guard. */
export const EXPENSIVE_COMPOSITE_SLUGS = new Set([
  "research", "research-pro", "research-max", "dossier", "dossier-max",
  "fund-report", "fund-report-max", "domain-audit", "domain-audit-pro",
  "token-risk", "token-risk-pro",
  "recall-report", "insider-report", "market-brief", "token-brief",
  // ticker-pack bundles the dossier + insider composites in one run.
  "ticker-pack",
  // filing-report reads up to 3 EDGAR documents then synthesizes; minutes long.
  "filing-report",
  // linkedin-article = the research pipeline + synthesis + image generation.
  "linkedin-article",
  // decide-execute runs a whole plan (our tools and paid outside sellers)
  // before its own payment settles: the same spend-then-fail, drain and abort
  // guards as a report.
  "decide-execute",
  // Media tiers: one upstream call each, but a flat per-call cost is spent BEFORE
  // settlement, so an unsettled repeat is free to the caller and real to us.
  // Being in this set also marks them longRunning (EVM exact only) - a 40-240 s
  // run outlives an SVM blockhash, the AVM default window and a Tempo credential.
  "v1-images-fast", "v1-images-pro", "v1-images-edit", "v1-videos",
]);

/** Slugs that are long-running for a reason OTHER than composite spend.
 *  Kept beside the set above because they feed the same rule.
 *
 *  `seller-payability` (2026-09-11) is here because it PAYS an outside seller
 *  from our Base wallet and then runs to a 55 s deadline in the worst case:
 *  a 15 s probe, a 45 s paid leg, and a refusal wait that must outlive the
 *  credential it signed. Settlement happens after the handler, so on the
 *  short-lived rails (SVM recent-blockhash, the default AVM window, a Tempo
 *  credential) the buyer's authorization can be dead by the time we answer -
 *  we would have paid the seller and earned nothing. EVM exact only.
 *  `image-gen-premium` (2026-09-29) renders the larger frame under a 75 s
 *  upstream bound, past what an SVM or Tempo credential reliably covers. */
export const LONG_RUNNING_SLUGS = new Set(["v1-videos", "seller-payability", "image-gen-premium", "decide-execute", "flight-search", "flight-status"]);

/** True when a route runs long enough that only EVM `exact` can settle it.
 *
 *  A 40 to 240 second run outlives an SVM recent-blockhash, the default AVM
 *  validity window and a Tempo credential, and settlement happens AFTER the
 *  handler - so offering those rails would mean the work is done and the buyer
 *  is never charged.
 *
 *  THIS IS THE ONE DEFINITION. server.js used to keep its own local copy of the
 *  long-running set, so the weekly Algorand sweep - which correctly imports
 *  isIdentityBoundRoute from the server rather than pattern-matching - had no
 *  way to know these routes advertise no AVM accept BY DESIGN, and reported
 *  three of them as a rail that had silently gone away. The sweep was right to
 *  ask; the answer simply lived somewhere it could not reach. */
export function isLongRunningSlug(slug) {
  return EXPENSIVE_COMPOSITE_SLUGS.has(slug) || LONG_RUNNING_SLUGS.has(slug);
}

/** True when a route's handler spends before the buyer's own payment settles:
 *  it pays an outside seller from one of this server's wallets (the tool def
 *  carries `spendsOwnWallet: true` - route-execute's tiers, seller-payability)
 *  or it is long-running composite work (above). A Tempo pull credential
 *  reaches such a route only when the gate has verified its sender
 *  (src/mpp-tempo.js, verifiedSenderRequired). */
export function spendsBeforeSettlement(def) {
  return !!def && (def.spendsOwnWallet === true || isLongRunningSlug(def.slug));
}

/** True if this payer is currently blocked (checked BEFORE the handler spends).
 *  A boolean without a shared store; a promise of one with it. */
export function compositeGuardBlocked(payer) {
  const local = localBlocked(payer);
  if (!SHARED || !payer) return local;
  return local ? Promise.resolve(true) : sharedBlocked(payer, Date.now());
}
function localBlocked(payer) {
  if (!payer) return false;
  const until = blockedUntil.get(payer);
  if (!until) return false;
  if (until > Date.now()) return true;
  blockedUntil.delete(payer); // block expired
  fails.delete(payer);
  return false;
}

/** True while the global breaker is tripped (checked BEFORE the handler spends).
 *  A boolean without a shared store; a promise of one with it. */
export function compositeGuardGlobalPaused() {
  const local = localPaused();
  if (!SHARED) return local;
  return local ? Promise.resolve(true) : sharedPaused(Date.now());
}
function localPaused() {
  if (globalPausedUntil > Date.now()) return true;
  globalPausedUntil = 0;
  return false;
}

/** Slugs that keep the per-buyer bound but neither feed nor honour the global
 *  pause: plan execution carries its own global ceiling, and its failures must
 *  not be able to pause every report product for everyone. */
export const OWN_GLOBAL_BOUND_SLUGS = new Set(["decide-execute"]);

/** Record that we SPENT upstream for this payer and then did NOT settle (non-200). */
export function recordCompositeSpendFailure(payer, { global = true } = {}) {
  const t = Date.now();
  if (SHARED) sharedRecordFailure(payer, t, global);
  if (global) {
    const gk = payer || `anon:${++anonSeq}`;
    globalFailKeys.set(gk, [...(globalFailKeys.get(gk) || []), t]);
    if (globalFailCount(t) >= GLOBAL_MAX_FAILS) { globalPausedUntil = t + GLOBAL_PAUSE_MS; globalFailKeys = new Map(); }
  }
  if (!payer) return;
  const arr = (fails.get(payer) || []).filter((x) => t - x < WINDOW_MS);
  arr.push(t);
  if (tripped(arr.length, localOks(payer, t))) { blockedUntil.set(payer, t + BLOCK_MS); fails.delete(payer); }
  else fails.set(payer, arr);
}
function localOks(payer, t) {
  const kept = (oks.get(payer) || []).filter((x) => t - x < WINDOW_MS);
  if (kept.length) oks.set(payer, kept); else oks.delete(payer);
  return kept.length;
}

/** A genuine paid success is an outcome in the payer's window: enough of them
 *  keep its failures under the share that blocks it. It erases nothing. */
export function recordCompositeSpendSuccess(payer) {
  if (!payer) return;
  const t = Date.now();
  const kept = (oks.get(payer) || []).filter((x) => t - x < WINDOW_MS);
  kept.push(t);
  oks.set(payer, kept.length > MAX_OKS_KEPT ? kept.slice(-MAX_OKS_KEPT) : kept);
  if (SHARED) void sharedWrite(CONTROL, shared.windowAdd("cg-ok", payer, { windowMs: WINDOW_MS, member: `${PROC}:${++sharedSeq}`, now: t }));
}

/** A composite finished: account its upstream spend (PostHog when configured),
 *  and CHECK IT AGAINST THE TIER'S DECLARED CEILING.
 *
 *  Every report kit already reports through here, which makes this the one
 *  place that can enforce `maxUpstreamUsd` without touching ten kits. It was a
 *  declared bound in 8 of them - only research-deep and ticker-pack read their
 *  own field at runtime - so the number was a comment nothing checked, which is
 *  how it drifted below measured cost and how three products ended up priced
 *  under their own worst case.
 *
 *  It cannot ABORT: a single-synthesis report only knows its cost once the call
 *  has returned and been paid for, so aborting would throw away work already
 *  bought. What it can do is refuse to let a breach be silent - the run is
 *  counted, logged once with the numbers, and shipped to telemetry flagged, so
 *  drift shows up as a rising count instead of a surprise on an invoice. The
 *  structural bounds (one locked model, a bounded synthMaxTokens, bounded
 *  inputs) remain the thing that stops a runaway call.
 */
// The RAIL a report was sold on, and the price it actually sold for. Kits
// call recordCompositeUsage with the AGENT price (their tier), which is also
// what a card or monitor run reported until 2026-08-27 - so the composite
// margin telemetry priced a card report at the agent price and could not say which door
// it came through at all. The card door and the monitor scheduler run the
// same handler, so the door sets a context around the call instead of every
// kit learning about doors. Async-local: a context set around `await h()`
// is visible from recordCompositeUsage however deep the kit calls it.
const compositeContext = new AsyncLocalStorage();
export function withCompositeContext(ctx, fn) {
  return compositeContext.run({ rail: String(ctx?.rail || "agent"), priceUsd: ctx?.priceUsd }, fn);
}

export function recordCompositeUsage({ slug, upstreamUsd, ok, priceUsd }) {
  const usd = Number(upstreamUsd) || 0;
  const ctx = compositeContext.getStore() || {};
  const rail = ctx.rail || "agent";
  const ctxPrice = Number(ctx.priceUsd);
  const soldFor = ctx.priceUsd != null && Number.isFinite(ctxPrice) ? ctxPrice : (Number(priceUsd) || null);
  usage.runs++; if (ok) usage.ok++; else usage.failed++;
  usage.upstreamUsd += usd;
  const b = (usage.bySlug[slug] ||= { runs: 0, ok: 0, upstreamUsd: 0 });
  b.runs++; if (ok) b.ok++; b.upstreamUsd += usd;
  // The cap lookup is DEFERRED, not because it is slow but because the registry
  // imports every report kit and the kits import this module: a static import
  // here is a cycle, and the symptom is a TDZ error at boot rather than
  // anything that looks like a cycle. Same deferred shape the telemetry below
  // already uses, so nothing about billing waits on it.
  _settled = (async () => {
    let cap = null;
    try { const rt = await import("./report-tiers.js"); cap = rt.capUsdFor(slug); }
    catch { cap = null; }
    const overCap = cap != null && usd > cap;
    if (overCap) {
      usage.overCap++;
      b.overCap = (b.overCap || 0) + 1;
      usage.lastOverCap = { slug, upstreamUsd: +usd.toFixed(6), capUsd: cap, at: new Date().toISOString() };
      console.warn(`[composite] ${slug} spent $${usd.toFixed(4)} upstream, OVER its declared cap of $${cap} - re-measure the tier or raise the cap, and check the price still clears it (scripts/test-report-margins.js)`);
    }
    try {
      const ph = await import("./posthog.js");
      ph.capturePostHogCompositeUsage?.({ slug, upstreamUsd: usd, ok: !!ok, priceUsd: soldFor, rail, capUsd: cap, overCap });
    } catch { /* telemetry never throws */ }
  })().catch(() => {});
}

/** Resolves once the deferred cap check + telemetry for the last recorded run
 *  have finished. Tests await this; nothing in the serving path does. */
let _settled = Promise.resolve();
export function _compositeUsageSettled() { return _settled; }

/** Upstream spend totals, including cap breaches. Operator-visible so a rising
 *  `overCap` is something a human can see without a PostHog query. */
export function compositeUsageSnapshot() {
  return {
    runs: usage.runs, ok: usage.ok, failed: usage.failed,
    upstreamUsd: +usage.upstreamUsd.toFixed(6),
    overCap: usage.overCap, lastOverCap: usage.lastOverCap,
    bySlug: Object.fromEntries(Object.entries(usage.bySlug).map(([k, v]) => [k, { ...v, upstreamUsd: +v.upstreamUsd.toFixed(6) }])),
  };
}

/** Whether this process writes the guard through to the shared store. */
export const _compositeGuardShared = SHARED;
/** Test/ops introspection. */
export function _compositeGuardState() {
  return { fails: fails.size, oks: oks.size, blocked: blockedUntil.size, WINDOW_MS, MAX_FAILS, MIN_FAIL_SHARE, HARD_MAX_FAILS, BLOCK_MS, globalFails: globalFailCount(Date.now()), globalPausedUntil, GLOBAL_MAX_FAILS, GLOBAL_PAUSE_MS, usage: { ...usage, upstreamUsd: Math.round(usage.upstreamUsd * 1e4) / 1e4 } };
}
export function _compositeGuardReset() {
  if (SHARED) {
    for (const k of new Set([...fails.keys(), ...blockedUntil.keys(), ...oks.keys()])) { void shared.windowClear("cg-fail", k); void shared.windowClear("cg-ok", k); void shared.flagSet("cg-block", k, 0); }
    void shared.flagSet("cg-pause", "all", 0); void shared.windowClear("cg-global", "all");
  }
  fails.clear(); oks.clear(); blockedUntil.clear(); globalFailKeys = new Map(); globalPausedUntil = 0;
  usage.runs = 0; usage.ok = 0; usage.failed = 0; usage.upstreamUsd = 0;
  usage.overCap = 0; usage.lastOverCap = null; usage.bySlug = {};
}
