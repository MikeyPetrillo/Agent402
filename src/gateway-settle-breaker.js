// gateway-settle-breaker - a settle-failure breaker for the LLM gateway tiers.
//
// THE HOLE. @x402/express runs the handler FIRST and settles AFTER, and a <400
// response whose settlement then fails is rewritten to a 402 with nothing
// charged. On the /v1/* tiers (chat, messages, responses, images, embeddings,
// rerank, speech, metered) the handler is an OpenRouter or OpenAI call we pay
// for, so "verify passes, settle fails" (USDC moved away between the two, a
// raced nonce, a facilitator refusal) is upstream spend with no revenue. The
// report composites already have src/composite-spend-guard.js for exactly
// this; the gateway tiers had nothing, and a handler there runs in seconds,
// so one wallet could loop it.
//
// THE SEAM. A tool handler is called as handler(input, req) and never sees the
// response, but Express hands every request its response as `req.res`, and the
// FINAL status of that response is the only honest settlement signal: a 200 is
// settled, a 402 after the handler ran is a settlement that failed (the vendor
// rewrite, the Tempo gate's post-handler broadcast failure - the same shape on
// every rail), a 4xx/5xx the handler threw was never settled and never charged
// (and is not this wallet's fault). So each gateway handler calls
// gatewaySettleBreakerCheck(req) as its FIRST statement: it refuses (429 for a
// wallet, 503 for the global pause) before any upstream call - a >= 400
// cancels settlement, so nobody is charged for the refusal - and arms one
// outcome listener on req.res that records the outcome under the same key the
// consult used. Keying is the composite guard's: the signed EIP-3009 payer,
// else the Tempo payer the gate verified, else the client IP.
//
// The listener rides onSettleOutcome (src/hangup-settlement.js), which reports
// the final outcome whether or not the buyer stayed connected: a settlement
// that fails after the buyer left counts like one whose buyer stayed. A charge
// cancelled for a buyer who left inside the forgiveness budget is not counted
// here; that budget is its bound.
//
// The finish listener reads the status AND the settle receipt (PAYMENT-RESPONSE
// with success:false), so a graceful facilitator rejection is caught whatever
// status rides with it. Not caught, and accepted: a MALFORMED facilitator
// response at settle (FacilitatorResponseError, answered 502 by the vendor) -
// indistinguishable from a handler 502 without a served marker, rare, and the
// facilitator-diagnostics wrapper logs it loudly.
//
// A handler must therefore never throw a 402 itself - a post-arm 402 IS a
// settlement failure here. scripts/test-gateway-settle-breaker.js pins that
// invariant from source for every gateway kit.
//
// In memory per process (a restart resets it, the same as the composite and
// external-spend guards), and shared across replicas through
// src/shared-limits.js when a Redis is configured: every failure is written
// to a shared window under the same key, the global pause is a shared flag,
// and the consult reads the shared counts with this process's own as the
// floor. Without Redis the consult is synchronous, exactly as before; with it
// the consult returns a promise (the handlers await it), and when the shared
// store does not answer the consult decides on this process's counts alone,
// which is never looser than one replica was. Tune via env.
//
// THE RATE. Failures are read against the settled calls in the same window:
// a key is refused only when it holds MAX_FAILS failures AND they are more
// than MIN_FAIL_SHARE of its outcomes. A buyer settling hundreds of calls an
// hour whose client re-sends a request (the same signed authorization, its
// nonce already used, so the copy reverts at every facilitator) is never cut
// off by a handful of such reverts, whatever order the fast reverts and the
// slower settlements land in; a key whose payments mostly fail is still
// stopped after MAX_FAILS of them, and any key at HARD_MAX_FAILS failures is
// stopped whatever it settled (the bound on unpaid handler runs). Settled
// calls stay in the window as outcomes; they do not erase the failures.
import { payerFromRequest } from "./payer.js";
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded } from "./shared-limits.js";
import { isBillingRefusalReceipt } from "./payment-reject.js";
import { isWithdrawnSubcentRefusal } from "./avm-sponsorship.js";
import { onSettleOutcome } from "./hangup-settlement.js";
import { toolFailureMonitor } from "./tool-failure-monitor.js";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** Settle failures a wallet may accumulate inside the window before it is refused. */
export const MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_MAX, 3);
/** Rolling window, and the length of a global pause. */
export const WINDOW_MS = num(process.env.GATEWAY_SETTLE_BREAKER_WINDOW_MS, 15 * 60_000);
/** The share of a key's outcomes inside the window that must be failures
 *  (strictly more than this) before MAX_FAILS of them refuse it. */
export const MIN_FAIL_SHARE = (() => { const n = Number(process.env.GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE); return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.5; })();
/** Failures inside the window that refuse a key whatever its settled count:
 *  the share rule bounds a wallet's unpaid handler runs by its own settled
 *  calls, and this bounds them outright. */
export const HARD_MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_HARD_MAX, 40);
/** Settled outcomes kept per key (the window's rate needs a count, not every stamp). */
const MAX_OKS_KEPT = 5000;
/** DISTINCT buyers with a settle failure inside the window that pause every
 *  /v1 tier - the per-key count is evadable by rotating wallets or IPs; this
 *  is not. Distinct, not a sum of failures (2026-09-28): the per-key check
 *  runs before any of a burst's failures lands, so one wallet firing a burst
 *  of concurrent calls could otherwise supply the whole global count by itself
 *  and pause every /v1 buyer for a window. A single buyer is the per-key
 *  bound's job; the pause answers many buyers failing at once. The one
 *  exception is a withdrawn sub-cent refusal: each counts on its own (the
 *  backstop for requests already in flight, see armGatewaySettleBreaker). */
export const GLOBAL_MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX, 12);

const fails = new Map(); // key -> number[] (failure timestamps inside the window)
const oks = new Map();   // key -> number[] (settled-call timestamps inside the window)
// key -> number[]: the subset of those failures that were a FACILITATOR billing
// refusal (src/payment-reject.js). They still count - nothing withdraws their
// offer, so the per-wallet bound is the only thing between them and an
// unbounded served-never-charged loop - but the 429 must not tell the buyer to
// check a wallet that was never the problem.
const billingFails = new Map();
// key -> the time of its latest settle failure inside the window: the global
// pause counts distinct buyers (see GLOBAL_MAX_FAILS). A failure with no key
// (no request to key it on, or a withdrawn sub-cent refusal, which is recorded
// keyless on purpose so it stays a backstop) counts as its own buyer.
let globalFailKeys = new Map();
let anonSeq = 0;
let globalPausedUntil = 0;
let globalTrips = 0;

// ---- the shared half ----------------------------------------------------------
// Window names: gwb-fail / gwb-bill (per key, one entry per failure),
// gwb-ok (per key, one entry per settled call),
// gwb-global (one entry per distinct buyer; a keyless failure is its own
// entry), and the flag gwb-pause. A window add returns the shared count, so
// the trip decision is made on the count every replica contributed to.
const SHARED = sharedLimitsEnabled();
const PROC = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let sharedSeq = 0;
const CONTROL = "gateway-settle-breaker";
function sharedKey(key) { return key.replace(/[\s]/g, "_"); }
function sharedRecordFailure(key, now, { global, billing, withdrawn }) {
  const member = `${PROC}:${++sharedSeq}`;
  if (global) {
    void sharedWrite(CONTROL, shared.windowAdd("gwb-global", "all", { windowMs: WINDOW_MS, member: key ? sharedKey(key) : `${withdrawn ? "withdrawn" : "anon"}:${member}`, now })).then((r) => {
      if (!r?.ok || r.count < GLOBAL_MAX_FAILS) return;
      void sharedWrite(CONTROL, shared.flagSet("gwb-pause", "all", now + WINDOW_MS, { now }));
      void sharedWrite(CONTROL, shared.windowClear("gwb-global", "all"));
      if (globalPausedUntil <= now) {
        globalPausedUntil = now + WINDOW_MS;
        globalTrips++;
        console.warn(`[gateway-breaker] unsettled gateway calls from ${r.count} buyer(s) across replicas inside ${Math.round(WINDOW_MS / 1000)} s - pausing every /v1 tier until ${new Date(globalPausedUntil).toISOString()}`);
      }
    });
  }
  if (!key) return;
  void sharedWrite(CONTROL, shared.windowAdd("gwb-fail", sharedKey(key), { windowMs: WINDOW_MS, member, now }));
  if (billing) void sharedWrite(CONTROL, shared.windowAdd("gwb-bill", sharedKey(key), { windowMs: WINDOW_MS, member, now }));
}
function sharedRecordSuccess(key, now) {
  void sharedWrite(CONTROL, shared.windowAdd("gwb-ok", sharedKey(key), { windowMs: WINDOW_MS, member: `${PROC}:${++sharedSeq}`, now }));
}
function sharedClearKey(key) {
  for (const name of ["gwb-fail", "gwb-bill", "gwb-ok"]) void sharedWrite(CONTROL, shared.windowClear(name, sharedKey(key)));
}
/** The per-key state with the shared windows folded in: each count is the
 *  larger of the store's and this process's own (a write of this process
 *  may not have landed yet), and the lift time comes from whichever
 *  failure list is read. A store that does not answer leaves it to this
 *  process's counts. */
async function sharedBlocked(key, now) {
  const local = gatewaySettleBreakerBlocked(key, now);
  if (!key) return local;
  const r = await shared.windowReadMany([
    { name: "gwb-fail", key: sharedKey(key), windowMs: WINDOW_MS },
    { name: "gwb-bill", key: sharedKey(key), windowMs: WINDOW_MS },
    { name: "gwb-ok", key: sharedKey(key), windowMs: WINDOW_MS },
  ], { now });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return local; }
  const [f, b, o] = r.results;
  const useShared = f.count > local.fails && Array.isArray(f.entries);
  const failTimes = useShared ? f.entries.map((e) => e.score).sort((x, y) => x - y) : inWindow(fails.get(key) || [], now);
  return verdict(failTimes, Math.max(f.count, local.fails), Math.max(o.count, local.oks), Math.max(b.count, local.billingFails));
}
async function sharedGlobalPaused(now) {
  const local = gatewaySettleBreakerGlobalPaused(now);
  if (local.paused) return local;
  const r = await shared.flagGet("gwb-pause", "all", { now });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return local; }
  return r.until > now ? { paused: true, until: r.until } : local;
}

/** The identity a gateway call is counted under. Same derivation as the
 *  composite guard in server.js: the signed EVM payer, else the Tempo sender
 *  the gate VERIFIED (src/mpp-tempo.js sets req.mppTempoSender, null for a
 *  sender neither the signature nor the chain proved; the credential's own
 *  `source` is client-supplied and a caller could name a fresh one per
 *  request, so it is never a key), else the
 *  credits key, else the client IP. Null only for an in-process caller with no
 *  request (route-execute dispatching a flat tier), which the global breaker
 *  still covers. */
export function gatewaySettleBreakerKey(req) {
  if (!req || typeof req !== "object") return null;
  const payer = payerFromRequest(req);
  if (payer) return payer;
  if (req.mppTempoSender) return `tempo:${req.mppTempoSender}`;
  if (req.creditsKeyId) return `credits:${req.creditsKeyId}`;
  const ip = typeof req.ip === "string" && req.ip.trim() ? req.ip.trim() : req.socket?.remoteAddress;
  return ip ? `ip:${String(ip).trim()}` : null;
}

function inWindow(arr, now) { return arr.filter((t) => now - t < WINDOW_MS); }
/** The rule: MAX_FAILS failures inside the window, and failures strictly more
 *  than MIN_FAIL_SHARE of the key's outcomes there. `until` is when the
 *  (len - MAX + 1)th newest failure ages out. */
function verdict(failTimes, nFails, nOks, nBills) {
  const out = { blocked: false, fails: nFails, oks: nOks, billingFails: nBills };
  if (nFails < MAX_FAILS) return out;
  if (nFails < HARD_MAX_FAILS && nFails <= MIN_FAIL_SHARE * (nFails + nOks)) return out;
  const idx = Math.max(0, failTimes.length - MAX_FAILS);
  return { ...out, blocked: true, until: (failTimes[idx] ?? failTimes[failTimes.length - 1] ?? Date.now()) + WINDOW_MS };
}
function pruneGlobal(now) { for (const [k, t] of globalFailKeys) if (now - t >= WINDOW_MS) globalFailKeys.delete(k); }

/** Per-key state (this process): see `verdict`. */
export function gatewaySettleBreakerBlocked(key, now = Date.now()) {
  if (!key) return { blocked: false, fails: 0, oks: 0, billingFails: 0 };
  const arr = inWindow(fails.get(key) || [], now);
  if (arr.length) fails.set(key, arr); else fails.delete(key);
  const bill = inWindow(billingFails.get(key) || [], now);
  if (bill.length) billingFails.set(key, bill); else billingFails.delete(key);
  const ok = inWindow(oks.get(key) || [], now);
  if (ok.length) oks.set(key, ok); else oks.delete(key);
  return verdict(arr, arr.length, ok.length, bill.length);
}

/** Global state: paused for WINDOW_MS once GLOBAL_MAX_FAILS buyers fail to settle inside a window (a failure recorded with no buyer counts on its own). */
export function gatewaySettleBreakerGlobalPaused(now = Date.now()) {
  if (globalPausedUntil > now) return { paused: true, until: globalPausedUntil };
  globalPausedUntil = 0;
  return { paused: false };
}

/** A payment was presented, the handler served, and settlement FAILED. */
export function recordGatewaySettleFailure(key, now = Date.now(), { global = true, billing = false, withdrawn = false } = {}) {
  if (SHARED) sharedRecordFailure(key, now, { global, billing, withdrawn });
  // `global:false` (the wallet-only catalog consult): the failure counts
  // against the WALLET only. A catalog read costs a fraction of a cent, so
  // twelve of them must never pause the LLM tiers - that would hand anyone
  // with twelve failed settlements a lever on the gateway (the operator,
  // 2026-09-06).
  if (global) {
    pruneGlobal(now);
    globalFailKeys.set(key || `${withdrawn ? "withdrawn" : "anon"}:${++anonSeq}`, now);
    if (globalFailKeys.size >= GLOBAL_MAX_FAILS) {
      // Say what was counted: buyers, and the failures recorded with no buyer
      // (each counted on its own), so one buyer's withdrawn refusals never
      // read as that many buyers.
      const keys = [...globalFailKeys.keys()];
      const nWithdrawn = keys.filter((k) => k.startsWith("withdrawn:")).length, nAnon = keys.filter((k) => k.startsWith("anon:")).length;
      const parts = [`${keys.length - nWithdrawn - nAnon} buyer(s)`, ...(nWithdrawn ? [`${nWithdrawn} withdrawn sub-cent refusal(s)`] : []), ...(nAnon ? [`${nAnon} failure(s) with no buyer`] : [])];
      globalPausedUntil = now + WINDOW_MS;
      globalFailKeys = new Map();
      globalTrips++;
      console.warn(`[gateway-breaker] unsettled gateway calls from ${parts.join(", ")} inside ${Math.round(WINDOW_MS / 1000)} s - pausing every /v1 tier until ${new Date(globalPausedUntil).toISOString()}`);
    }
  }
  if (!key) return;
  const arr = inWindow(fails.get(key) || [], now);
  arr.push(now);
  fails.set(key, arr);
  if (billing) {
    const bill = inWindow(billingFails.get(key) || [], now);
    bill.push(now);
    billingFails.set(key, bill);
  }
  const v = verdict(arr, arr.length, inWindow(oks.get(key) || [], now).length, 0);
  if (v.blocked) console.warn(`[gateway-breaker] ${arr.length} settle failures against ${v.oks} settled calls inside the window for one buyer - refusing its gateway calls until the window clears`);
}

/** A settled 200 is an outcome in the window: enough of them keep a key's
 *  failures under the share that refuses it. */
export function recordGatewaySettleSuccess(key, now = Date.now()) {
  if (!key) return;
  const ok = inWindow(oks.get(key) || [], now);
  ok.push(now);
  oks.set(key, ok.length > MAX_OKS_KEPT ? ok.slice(-MAX_OKS_KEPT) : ok);
  if (SHARED) sharedRecordSuccess(key, now);
}

function decodeReceipt(res) {
  try {
    const h = res.getHeader?.("PAYMENT-RESPONSE") || res.getHeader?.("X-PAYMENT-RESPONSE");
    if (typeof h !== "string" || !h) return null;
    return JSON.parse(Buffer.from(h, "base64").toString("utf-8"));
  } catch { return null; }
}

/** Arm ONE finish listener per request on `req.res`, recording the FINAL
 *  outcome under `key`. Exported for the test; the check below calls it.
 *
 *  A LATER consult that takes part in the global pause UPGRADES the listener
 *  already armed (2026-09-28). Every /v1 slug is wallet-only, so the
 *  dispatcher's catalog consult (global:false) arms first and the /v1
 *  handler's own consult (global:true) arrives second; when the second could
 *  not re-arm, no /v1 settle failure ever reached the global count and the
 *  /v1 pause could never trip. Never the other way round: a later
 *  global:false consult does not downgrade. */
export function armGatewaySettleBreaker(req, key, { global = true } = {}) {
  if (!req || typeof req !== "object") return false;
  if (req.__gatewaySettleBreakerArmed) {
    if (global && req.__gatewaySettleBreakerState) req.__gatewaySettleBreakerState.global = true;
    return false;
  }
  const res = req.res;
  if (!res || typeof res.once !== "function") return false;
  req.__gatewaySettleBreakerArmed = true;
  // Read at finish time, so an upgrade after arming counts.
  const state = { global };
  Object.defineProperty(req, "__gatewaySettleBreakerState", { value: state, enumerable: false, configurable: true });
  onSettleOutcome(req, res, () => {
    const global = state.global;
    try {
      const st = res.statusCode;
      const receipt = decodeReceipt(res);
      // The Algorand facilitator refused a SUB-CENT settle for our spent
      // sponsored allowance (2026-09-28: one outside buyer refused 325 calls
      // for it, told their wallet was the problem). The offer gate has
      // already withdrawn Algorand from the next sub-cent 402
      // (src/avm-sponsorship.js), so the loop is closed and this is not the
      // buyer's to carry: kept off the WALLET's count, and not a clear either.
      // It still feeds the /v1 global pause when this consult takes part in
      // it - that pause names no wallet, and it is the backstop if requests
      // already in flight keep arriving. It is recorded with no key, so each
      // one counts as its own buyer toward that pause: counting distinct
      // buyers does not weaken the backstop. The request is handed over so the
      // gate checks the requirement THIS call paid against (sub-cent, to the
      // paused payTo) and that the route's next 402 really drops it.
      if (isWithdrawnSubcentRefusal(receipt, { req })) {
        if (global) recordGatewaySettleFailure(null, Date.now(), { global: true, withdrawn: true });
        return;
      }
      // Any OTHER facilitator billing refusal (free_tier_exhausted, a credits
      // wall, the gate switched off) has nothing withdrawing its offer, so it
      // counts exactly like a failed settle - per wallet and globally - and is
      // only marked, so the 429 says what happened instead of blaming the wallet.
      if (st === 402 || receipt?.success === false) recordGatewaySettleFailure(key, Date.now(), { global, billing: isBillingRefusalReceipt(receipt) });
      else if (st === 200) recordGatewaySettleSuccess(key);
      // Anything else (a 4xx/5xx the handler threw) was never settled and is
      // not this wallet's doing: neither counted nor cleared.
    } catch { /* never break a response */ }
  });
  return true;
}

/**
 * THE CONSULT LINE. Every gateway handler awaits this first, before validation
 * and before any upstream call. Throws 503 while the global pause holds, 429
 * while this buyer is blocked; otherwise arms the outcome listener.
 * Synchronous (returns undefined, throws at once) without a shared store; a
 * promise with one, so `await` covers both.
 */
export function gatewaySettleBreakerCheck(req, { now = Date.now(), global = true } = {}) {
  const key = gatewaySettleBreakerKey(req);
  if (!SHARED) {
    decide(req, key, now, global, global ? gatewaySettleBreakerGlobalPaused(now) : { paused: false }, gatewaySettleBreakerBlocked(key, now));
    return undefined;
  }
  // Shared: the pause flag and this key's window, read together with this
  // process's own counts as the floor; a store that does not answer leaves
  // the decision to those counts.
  return (async () => {
    const g = global ? await sharedGlobalPaused(now) : { paused: false };
    const b = g.paused ? null : await sharedBlocked(key, now);
    decide(req, key, now, global, g, b);
  })();
}
function decide(req, key, now, global, g, b) {
  // The wallet-only catalog consults with global:false: no global pause is
  // honoured and none is fed. Only the /v1 tiers, where a wasted call costs
  // real money, take part in the global pause.
  if (g.paused) {
    const secs = Math.max(1, Math.ceil((g.until - now) / 1000));
    const e = new Error(`Paid tools are briefly paused after a burst of payments that verified and then failed to settle; retry after ${new Date(g.until).toISOString()} (about ${secs} s). Nothing was charged for this request.`);
    e.statusCode = 503;
    e.retryAfterMs = g.until - now;
    try { req?.res?.setHeader?.("Retry-After", String(secs)); } catch { /* headers are best-effort */ }
    throw e;
  }
  if (b.blocked) {
    // A key that settled a call inside the window is a paying buyer: its
    // refusal is noted on the failure monitor (a count per bucket, shared
    // across replicas, no key), and /api/gateway-status reads buyerRefusals
    // as refusing while one is recent, so a refused buyer is seen instead of
    // read from a log afterward. A key with no settled call is not counted.
    if (b.oks > 0) { try { toolFailureMonitor().noteBuyerRefusal({ at: now }); } catch { /* counting only */ } }
    const secs = Math.max(1, Math.ceil((b.until - now) / 1000));
    const mins = Math.round(WINDOW_MS / 60_000);
    const until = `paid tools refuse new calls from it until ${new Date(b.until).toISOString()} (about ${secs} s). Nothing was charged for this request.`;
    // Every counted failure a facilitator billing refusal: say that, and do
    // not send the buyer to a wallet balance that was never the problem.
    const e = new Error(b.billingFails >= b.fails
      ? `Recent payments from this wallet could not be settled (${b.fails} in the last ${mins} min: each verified and was served, then the paying network's facilitator refused to settle it under a billing limit on this server's own account - not because of the wallet); ${until} After that, pay on a network other than the one refused, from the route's current 402.`
      : `Recent payments from this wallet failed to settle (${b.fails} in the last ${mins} min: they verified, the call was served, and the transfer did not go through${b.billingFails ? `; ${b.billingFails} of them ${b.billingFails === 1 ? "was" : "were"} a facilitator billing refusal on this server's account, not the wallet's` : ""}); ${until} Check the wallet's USDC balance on the paying chain before retrying.`);
    e.statusCode = 429;
    e.retryAfterMs = b.until - now;
    try { req?.res?.setHeader?.("Retry-After", String(secs)); } catch { /* headers are best-effort */ }
    throw e;
  }
  armGatewaySettleBreaker(req, key, { global });
}

/** Counts only - never a key, address or IP. */
export function gatewaySettleBreakerStatus(now = Date.now()) {
  let blockedKeys = 0, trackedKeys = 0;
  for (const [key] of fails) {
    const s = gatewaySettleBreakerBlocked(key, now);
    if (s.fails) trackedKeys++;
    if (s.blocked) blockedKeys++;
  }
  const g = gatewaySettleBreakerGlobalPaused(now);
  return {
    trackedKeys, blockedKeys,
    // Buyers with a settle failure inside the window, plus each failure
    // recorded with no buyer (a withdrawn sub-cent refusal counts on its
    // own): the count the global pause trips on.
    globalFailsInWindow: (pruneGlobal(now), globalFailKeys.size),
    globalPaused: g.paused, globalPausedUntil: g.paused ? new Date(g.until).toISOString() : null, globalTrips,
    maxFails: MAX_FAILS, minFailShare: MIN_FAIL_SHARE, hardMaxFails: HARD_MAX_FAILS, windowMs: WINDOW_MS, globalMaxFails: GLOBAL_MAX_FAILS,
  };
}

/** Test-only. */
export function _gatewaySettleBreakerReset() {
  if (SHARED) {
    for (const k of new Set([...fails.keys(), ...billingFails.keys(), ...oks.keys()])) sharedClearKey(k);
    void shared.flagSet("gwb-pause", "all", 0); void shared.windowClear("gwb-global", "all");
  }
  fails.clear(); billingFails.clear(); oks.clear(); globalFailKeys = new Map(); globalPausedUntil = 0; globalTrips = 0;
}
/** Whether this process writes the breaker through to the shared store. */
export const _gatewaySettleBreakerShared = SHARED;
