import { AsyncLocalStorage } from "node:async_hooks";
// composite-spend-guard — protects the expensive composite tools (research-deep,
// dossier) from an upstream-drain grief. Because x402 settles AFTER the ~90s
// handler and a non-200 RELEASES the EIP-3009 nonce (the signed authorization
// stays reusable), a payer can present a verify-passing authorization, make us
// run costly OpenRouter/search work, then dodge settlement (e.g. move the funds
// out during the 90s window so settle fails), repeatedly, at ~zero cost to them.
// Each iteration burns ~$0.45-0.70 of OUR upstream with no revenue.
//
// This tracks per-payer "spent-then-failed-to-settle" events and blocks a payer
// who crosses the threshold BEFORE the next expensive run. A genuine paid 200
// clears the counter, so it never penalizes real buyers. In-memory per replica
// (the per-call drain is small, blocks are short, and the gateway-balance alarm
// is the outer backstop); tune via env. Only the EVM EIP-3009 payer is guarded
// (that is the rail the reusable-nonce mechanic applies to).
const WINDOW_MS = Number(process.env.COMPOSITE_GUARD_WINDOW_MS) || 15 * 60_000;
const MAX_FAILS = Number(process.env.COMPOSITE_GUARD_MAX_FAILS) || 3;
const BLOCK_MS = Number(process.env.COMPOSITE_GUARD_BLOCK_MS) || 30 * 60_000;

const fails = new Map();        // payer -> number[] (failure timestamps in window)
const blockedUntil = new Map(); // payer -> timestamp the block lifts
// Global circuit breaker: spend-then-fail events across ALL keys in the window.
// The per-key guard is evadable by rotating wallets/IPs; this bounds the total
// unsettled upstream burn regardless of who causes it. Trips to a short pause
// on every composite (503, nobody charged) rather than blocking any one buyer.
const GLOBAL_MAX_FAILS = Number(process.env.COMPOSITE_GUARD_GLOBAL_MAX_FAILS) || 12;
const GLOBAL_PAUSE_MS = Number(process.env.COMPOSITE_GUARD_GLOBAL_PAUSE_MS) || 15 * 60_000;
let globalFails = [];
let globalPausedUntil = 0;
// Upstream usage telemetry for composites (the most expensive calls we make,
// invisible to the gateway's per-call margin event): running totals here, and
// a PostHog event per run when PostHog is configured.
const usage = { runs: 0, ok: 0, failed: 0, upstreamUsd: 0, overCap: 0, lastOverCap: null, bySlug: {} };

/** Slugs whose handlers run long, expensive upstream work before settlement.
 * Every composite that fans out to metered upstream (OpenRouter synthesis, and
 * for token-risk real Blockscout x402 buys) MUST be here, or its agent path is
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
  // Media tiers: one upstream call each, but a flat $0.014-$0.12 is spent BEFORE
  // settlement, so an unsettled repeat is free to the caller and real to us.
  // Being in this set also marks them longRunning (EVM exact only) - a 40-240 s
  // run outlives an SVM blockhash, the AVM default window and a Tempo credential.
  "v1-images-fast", "v1-images-pro", "v1-videos",
]);

/** Slugs that are long-running for a reason OTHER than composite spend.
 *  Kept beside the set above because they feed the same rule. */
export const LONG_RUNNING_SLUGS = new Set(["v1-videos"]);

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

/** True if this payer is currently blocked (checked BEFORE the handler spends). */
export function compositeGuardBlocked(payer) {
  if (!payer) return false;
  const until = blockedUntil.get(payer);
  if (!until) return false;
  if (until > Date.now()) return true;
  blockedUntil.delete(payer); // block expired
  fails.delete(payer);
  return false;
}

/** True while the global breaker is tripped (checked BEFORE the handler spends). */
export function compositeGuardGlobalPaused() {
  if (globalPausedUntil > Date.now()) return true;
  globalPausedUntil = 0;
  return false;
}

/** Record that we SPENT upstream for this payer and then did NOT settle (non-200). */
export function recordCompositeSpendFailure(payer) {
  const t = Date.now();
  globalFails = globalFails.filter((x) => t - x < WINDOW_MS);
  globalFails.push(t);
  if (globalFails.length >= GLOBAL_MAX_FAILS) { globalPausedUntil = t + GLOBAL_PAUSE_MS; globalFails = []; }
  if (!payer) return;
  const arr = (fails.get(payer) || []).filter((x) => t - x < WINDOW_MS);
  arr.push(t);
  if (arr.length >= MAX_FAILS) { blockedUntil.set(payer, t + BLOCK_MS); fails.delete(payer); }
  else fails.set(payer, arr);
}

/** A genuine paid success clears the payer's failure history. */
export function recordCompositeSpendSuccess(payer) {
  if (payer) fails.delete(payer);
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
// margin telemetry priced a $5 card report as $2 and could not say which door
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

/** Test/ops introspection. */
export function _compositeGuardState() {
  return { fails: fails.size, blocked: blockedUntil.size, WINDOW_MS, MAX_FAILS, BLOCK_MS, globalFails: globalFails.length, globalPausedUntil, GLOBAL_MAX_FAILS, GLOBAL_PAUSE_MS, usage: { ...usage, upstreamUsd: Math.round(usage.upstreamUsd * 1e4) / 1e4 } };
}
export function _compositeGuardReset() {
  fails.clear(); blockedUntil.clear(); globalFails = []; globalPausedUntil = 0;
  usage.runs = 0; usage.ok = 0; usage.failed = 0; usage.upstreamUsd = 0;
  usage.overCap = 0; usage.lastOverCap = null; usage.bySlug = {};
}
