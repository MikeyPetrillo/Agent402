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
// gatewaySettleBreakerCheck(req) as its FIRST statement: it refuses a blocked
// wallet (429) before any upstream call - a >= 400 cancels settlement, so
// nobody is charged for the refusal - and arms one outcome listener on req.res
// that records the outcome under the same key the consult used. The buyer is
// the composite guard's: the signed EIP-3009 payer, else the Tempo payer the
// gate verified, else the client IP.
//
// PER NETWORK. A signed EVM payer is counted per network its payment named
// (payer@network): failures on one network refuse payments on that network
// only, and the same wallet paying on another offered network is served at
// once. The 429 names the refused network and says so.
//
// NO REQUEST IS REFUSED FOR OTHER BUYERS' FAILURES. Distinct buyers failing
// to settle on the /v1 tiers inside one window are counted, and at
// GLOBAL_MAX_FAILS the count is reported: a console.warn and the
// settleFailures word on /api/gateway-status (ok / burst), which the status
// Worker and the heartbeat page on. It refuses nothing.
//
// The listener rides onSettleOutcome (src/hangup-settlement.js), which reports
// the final outcome whether or not the buyer stayed connected: a settlement
// sent while the buyer was connected that fails after the buyer left counts
// like one whose buyer stayed. A charge cancelled for a buyer who left inside
// the forgiveness budget (never sent) is not counted here; that budget is its
// bound.
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
// to a shared window under the same key, the burst alarm is a shared flag
// read by the status word only (never on the serving path), and the consult
// reads the shared counts with this process's own as the floor. Without Redis the consult is synchronous, exactly as before; with it
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
import { payerFromRequest, paymentHeaderOf } from "./payer.js";
import { decodePaymentHeader } from "./payment-header.js";
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded } from "./shared-limits.js";
import { isBillingRefusalReceipt } from "./payment-reject.js";
import { isWithdrawnSubcentRefusal } from "./avm-sponsorship.js";
import { isGatewayPendingAnswer } from "./gateway-wire.js";
import { onSettleOutcome } from "./hangup-settlement.js";
import { toolFailureMonitor } from "./tool-failure-monitor.js";
import { positiveNum as num } from "./env-num.js";

/** Settle failures a wallet may accumulate inside the window before it is refused. */
export const MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_MAX, 3);
/** Rolling window, and how long a tripped burst alarm reads burst. */
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
/** DISTINCT buyers with a /v1 settle failure inside the window that raise the
 *  burst alarm (the settleFailures word, a console.warn). An alarm only: no
 *  request is refused for it. Distinct, not a sum of failures: one wallet
 *  firing a burst of concurrent calls is one buyer, on however many networks,
 *  and is the per-key bound's job; the alarm reports many buyers failing at
 *  once. The one exception is a withdrawn sub-cent refusal: each counts on
 *  its own (see armGatewaySettleBreaker). */
export const GLOBAL_MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX, 12);

const fails = new Map(); // key -> number[] (failure timestamps inside the window)
const oks = new Map();   // key -> number[] (settled-call timestamps inside the window)
// key -> number[]: the subset of those failures that were a FACILITATOR billing
// refusal (src/payment-reject.js). They still count - nothing withdraws their
// offer, so the per-wallet bound is the only thing between them and an
// unbounded served-never-charged loop - but the 429 must not tell the buyer to
// check a wallet that was never the problem.
const billingFails = new Map();
// buyer -> the time of its latest settle failure inside the window: the burst
// alarm counts distinct buyers (see GLOBAL_MAX_FAILS), so a count key's
// network is dropped here (buyerOf). A failure with no key
// (no request to key it on, or a withdrawn sub-cent refusal, which is recorded
// keyless on purpose so it stays a backstop) counts as its own buyer.
let globalFailKeys = new Map();
let anonSeq = 0;
let globalAlarmUntil = 0;
let globalTrips = 0;

// ---- the shared half ----------------------------------------------------------
// Window names: gwb-fail / gwb-bill (per key, one entry per failure),
// gwb-ok (per key, one entry per settled call),
// gwb-global (one entry per distinct buyer; a keyless failure is its own
// entry), and the flag gwb-alarm. A window add returns the shared count, so
// the trip decision is made on the count every replica contributed to.
//
// KEY SHAPES ACROSS BUILDS. An EVM payer's per-key windows are named
// payer@network; a build before that named them by the payer alone, and
// wrote a flag gwb-pause that it refused /v1 on. This build never reads a
// payer-only window for a payment that names a network (those failures name
// no network, so counting them could refuse a network they did not happen
// on) and never writes or reads gwb-pause (writing it would make the earlier
// build refuse every buyer). During a deploy overlap each build counts its
// own failures: a count is briefly not shared, and neither build crashes on
// or refuses from the other's keys. gwb-global members are the buyer alone
// in both builds. The earlier build's windows expire with their window.
const SHARED = sharedLimitsEnabled();
const PROC = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let sharedSeq = 0;
const CONTROL = "gateway-settle-breaker";
function sharedKey(key) { return key.replace(/[\s]/g, "_"); }
// Every write this process has sent and not yet heard back from, including
// the alarm flag a window add sets once its reply shows the trip. The writes are
// fire-and-forget on the serving path; only the test reset waits on them, so
// an alarm set by a write still in flight cannot land after the reset cleared
// the flag.
const pendingWrites = new Set();
function write(p) {
  const w = sharedWrite(CONTROL, p);
  pendingWrites.add(w);
  w.finally(() => pendingWrites.delete(w));
  return w;
}
function sharedRecordFailure(key, now, { global, billing, withdrawn, walletCount = true }) {
  const member = `${PROC}:${++sharedSeq}`;
  if (global) {
    void write(shared.windowAdd("gwb-global", "all", { windowMs: WINDOW_MS, member: key ? sharedKey(buyerOf(key)) : `${withdrawn ? "withdrawn" : "anon"}:${member}`, now })).then((r) => {
      if (!r?.ok || r.count < GLOBAL_MAX_FAILS) return;
      void write(shared.flagSet("gwb-alarm", "all", now + WINDOW_MS, { now }));
      void write(shared.windowClear("gwb-global", "all"));
      if (globalAlarmUntil <= now) {
        globalAlarmUntil = now + WINDOW_MS;
        globalTrips++;
        console.warn(`[gateway-breaker] unsettled gateway calls from ${r.count} buyer(s) across replicas inside ${Math.round(WINDOW_MS / 1000)} s - settleFailures reads burst until ${new Date(globalAlarmUntil).toISOString()}; no request is refused for it`);
      }
    });
  }
  if (!key || !walletCount) return;
  void write(shared.windowAdd("gwb-fail", sharedKey(key), { windowMs: WINDOW_MS, member, now }));
  if (billing) void write(shared.windowAdd("gwb-bill", sharedKey(key), { windowMs: WINDOW_MS, member, now }));
}
function sharedRecordSuccess(key, now) {
  void write(shared.windowAdd("gwb-ok", sharedKey(key), { windowMs: WINDOW_MS, member: `${PROC}:${++sharedSeq}`, now }));
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
/** The alarm with the shared flag folded in. Read by the status word only,
 *  never by the consult. */
async function sharedGlobalAlarm(now) {
  const local = gatewaySettleBreakerGlobalAlarm(now);
  if (local.alarm) return local;
  const r = await shared.flagGet("gwb-alarm", "all", { now });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return local; }
  return r.until > now ? { alarm: true, until: r.until } : local;
}

/** The buyer a gateway call belongs to. Same derivation as the
 *  composite guard in server.js: the signed EVM payer, else the Tempo sender
 *  the gate VERIFIED (src/mpp-tempo.js sets req.mppTempoSender, null for a
 *  sender neither the signature nor the chain proved; the credential's own
 *  `source` is client-supplied and a caller could name a fresh one per
 *  request, so it is never a key), else the
 *  credits key, else the client IP. Null only for an in-process caller with no
 *  request (route-execute dispatching a flat tier), which nothing here
 *  refuses. */
export function gatewaySettleBreakerKey(req) {
  if (!req || typeof req !== "object") return null;
  const payer = payerFromRequest(req);
  if (payer) return payer;
  if (req.mppTempoSender) return `tempo:${req.mppTempoSender}`;
  if (req.creditsKeyId) return `credits:${req.creditsKeyId}`;
  const ip = typeof req.ip === "string" && req.ip.trim() ? req.ip.trim() : req.socket?.remoteAddress;
  return ip ? `ip:${String(ip).trim()}` : null;
}

// CAIP-2: namespace:reference.
const CAIP2 = /^[a-z0-9]{3,8}:[A-Za-z0-9._=-]{1,64}$/;
/** The network a signed x402 payment names, read from the payment header
 *  through the shared decoder the way src/replay-guard.js reads it (v2
 *  accepted.network, v1 network). The consult runs after the paywall verified
 *  the payment against an offered accept, so this is an offered network. Null
 *  when no header decodes or it names none. */
export function gatewaySettleBreakerNetwork(req) {
  try {
    const p = decodePaymentHeader(paymentHeaderOf(req));
    const network = p?.accepted?.network || p?.network || p?.payload?.network;
    return typeof network === "string" && CAIP2.test(network) ? network : null;
  } catch { return null; }
}
/** The key a call's settle outcomes are counted and refused under.
 *  A signed EVM payer: payer@network, so failures on one network refuse only
 *  payments on that network. One key, as before, where there is no network
 *  to split on: a Tempo sender (one chain), a credits key (no chain), the IP
 *  fallback (the buyer is not a wallet this server can name), and an EVM
 *  payment whose header names no network. */
export function gatewaySettleBreakerCountKey(req) {
  const buyer = gatewaySettleBreakerKey(req);
  if (!buyer || !EVM_PAYER.test(buyer)) return buyer;
  const network = gatewaySettleBreakerNetwork(req);
  return network ? `${buyer}@${network}` : buyer;
}
/** The name a call's per-key shared windows (gwb-fail, gwb-bill, gwb-ok) are
 *  stored under: its count key as the store spells it. For a reader of the
 *  store (a test), so the key shape lives here only. Null with no key. */
export function gatewaySettleBreakerSharedKeyOf(req) {
  const key = gatewaySettleBreakerCountKey(req);
  return key ? sharedKey(key) : null;
}
const EVM_PAYER = /^0x[0-9a-f]{40}$/;
const EVM_COUNT_KEY = /^(0x[0-9a-f]{40})@(.+)$/;
/** The buyer inside a count key (the burst alarm counts buyers, not networks). */
function buyerOf(key) { const m = EVM_COUNT_KEY.exec(key); return m ? m[1] : key; }
/** The network inside a count key, or null for a key with none. */
function networkOf(key) { const m = typeof key === "string" ? EVM_COUNT_KEY.exec(key) : null; return m ? m[2] : null; }

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

/** The burst alarm (this process): raised for WINDOW_MS once GLOBAL_MAX_FAILS buyers fail to settle inside a window (a failure recorded with no buyer counts on its own). It refuses nothing. */
export function gatewaySettleBreakerGlobalAlarm(now = Date.now()) {
  if (globalAlarmUntil > now) return { alarm: true, until: globalAlarmUntil };
  globalAlarmUntil = 0;
  return { alarm: false };
}

/** A payment was presented, the handler served, and settlement FAILED. */
export function recordGatewaySettleFailure(key, now = Date.now(), { global = true, billing = false, withdrawn = false, walletCount = true } = {}) {
  if (SHARED) sharedRecordFailure(key, now, { global, billing, withdrawn, walletCount });
  // `global:false` (the wallet-only catalog consult): the failure counts
  // against the WALLET only; the burst alarm reports the /v1 tiers, where a
  // served call that fails to settle is upstream spend.
  if (global) {
    pruneGlobal(now);
    globalFailKeys.set(key ? buyerOf(key) : `${withdrawn ? "withdrawn" : "anon"}:${++anonSeq}`, now);
    if (globalFailKeys.size >= GLOBAL_MAX_FAILS) {
      // Say what was counted: buyers, and the failures recorded with no buyer
      // (each counted on its own), so one buyer's withdrawn refusals never
      // read as that many buyers.
      const keys = [...globalFailKeys.keys()];
      const nWithdrawn = keys.filter((k) => k.startsWith("withdrawn:")).length, nAnon = keys.filter((k) => k.startsWith("anon:")).length;
      const parts = [`${keys.length - nWithdrawn - nAnon} buyer(s)`, ...(nWithdrawn ? [`${nWithdrawn} withdrawn sub-cent refusal(s)`] : []), ...(nAnon ? [`${nAnon} failure(s) with no buyer`] : [])];
      globalAlarmUntil = now + WINDOW_MS;
      globalFailKeys = new Map();
      globalTrips++;
      console.warn(`[gateway-breaker] unsettled gateway calls from ${parts.join(", ")} inside ${Math.round(WINDOW_MS / 1000)} s - settleFailures reads burst until ${new Date(globalAlarmUntil).toISOString()}; no request is refused for it`);
    }
  }
  // walletCount:false (a Circle Gateway settlement still pending): one buyer
  // toward the burst alarm, nothing against the wallet.
  if (!key || !walletCount) return;
  const arr = inWindow(fails.get(key) || [], now);
  arr.push(now);
  fails.set(key, arr);
  if (billing) {
    const bill = inWindow(billingFails.get(key) || [], now);
    bill.push(now);
    billingFails.set(key, bill);
  }
  const v = verdict(arr, arr.length, inWindow(oks.get(key) || [], now).length, 0);
  if (v.blocked) console.warn(`[gateway-breaker] ${arr.length} settle failures against ${v.oks} settled calls inside the window for one buyer${networkOf(key) ? ` on ${networkOf(key)}` : ""} - refusing its paid calls${networkOf(key) ? " on that network" : ""} until the window clears`);
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
 *  A LATER consult that feeds the burst alarm UPGRADES the listener already
 *  armed. Every /v1 slug is wallet-only, so the dispatcher's catalog consult
 *  (global:false) arms first and the /v1 handler's own consult (global:true)
 *  arrives second; when the second could not re-arm, no /v1 settle failure
 *  ever reached the alarm's count. Never the other way round: a later
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
      // It still feeds the /v1 burst alarm when this consult takes part in
      // it - the alarm names no wallet, and it reports requests already in
      // flight that keep arriving. It is recorded with no key, so each one
      // counts as its own buyer toward the alarm. The request is handed over so the
      // gate checks the requirement THIS call paid against (sub-cent, to the
      // paused payTo) and that the route's next 402 really drops it.
      if (isWithdrawnSubcentRefusal(receipt, { req })) {
        if (global) recordGatewaySettleFailure(null, Date.now(), { global: true, withdrawn: true });
        return;
      }
      // A Circle Gateway batched payment Gateway is still settling
      // (src/gateway-wire.js): the buyer was told to resend the same payment,
      // and nothing about it is the wallet's doing, so it is kept off the
      // WALLET's count (and is not a clear either). The run was served and
      // not yet paid, so it still counts toward the /v1 burst alarm when
      // this consult takes part in it, as this buyer (distinct buyers trip
      // the alarm, so one buyer's pending payments count once).
      if (isGatewayPendingAnswer(req, receipt)) {
        if (global) recordGatewaySettleFailure(key, Date.now(), { global: true, walletCount: false });
        return;
      }
      // Any OTHER facilitator billing refusal (free_tier_exhausted, a credits
      // wall, the gate switched off) has nothing withdrawing its offer, so it
      // counts exactly like a failed settle - per wallet and in the alarm - and is
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
 * and before any upstream call. Throws 429 while this buyer's key is blocked
 * (for an EVM payer, on the network this payment names only); otherwise arms
 * the outcome listener. Nothing here refuses for other buyers' failures.
 * `global` says whether this call's settle failure feeds the burst alarm
 * (the /v1 tiers) or the wallet's count only (the catalog consult).
 * Synchronous (returns undefined, throws at once) without a shared store; a
 * promise with one, so `await` covers both.
 */
export function gatewaySettleBreakerCheck(req, { now = Date.now(), global = true } = {}) {
  const key = gatewaySettleBreakerCountKey(req);
  if (!SHARED) {
    decide(req, key, now, global, gatewaySettleBreakerBlocked(key, now));
    return undefined;
  }
  // Shared: this key's windows, read with this process's own counts as the
  // floor; a store that does not answer leaves the decision to those counts.
  return (async () => { decide(req, key, now, global, await sharedBlocked(key, now)); })();
}
function decide(req, key, now, global, b) {
  if (b.blocked) {
    // A key that settled a call inside the window is a paying buyer: its
    // refusal is noted on the failure monitor (a count per bucket, shared
    // across replicas, no key), and /api/gateway-status reads buyerRefusals
    // as refusing while one is recent, so a refused buyer is seen instead of
    // read from a log afterward. A key with no settled call is not counted.
    if (b.oks > 0) { try { toolFailureMonitor().noteBuyerRefusal({ at: now }); } catch { /* counting only */ } }
    const secs = Math.max(1, Math.ceil((b.until - now) / 1000));
    const mins = Math.round(WINDOW_MS / 60_000);
    // A key with a network refuses that network only, and says how to keep
    // buying at once; a key without one (Tempo, credits, IP) refuses the key.
    const network = networkOf(key);
    const on = network ? ` on ${network}` : "";
    const until = `paid tools refuse new calls from it${on} until ${new Date(b.until).toISOString()} (about ${secs} s).${network ? ` That holds ${network} only: this wallet can pay on any other network this route offers right now (the networks are accepts[].network in the route's 402).` : ""} Nothing was charged for this request.`;
    // Every counted failure a facilitator billing refusal: say that, and do
    // not send the buyer to a wallet balance that was never the problem.
    const e = new Error(b.billingFails >= b.fails
      ? `Recent payments from this wallet${on} could not be settled (${b.fails} in the last ${mins} min: each verified and was served, then the paying network's facilitator refused to settle it under a billing limit on this server's own account - not because of the wallet); ${until}${network ? "" : " After that, pay on a network other than the one refused, from the route's current 402."}`
      : `Recent payments from this wallet${on} failed to settle (${b.fails} in the last ${mins} min: they verified, the call was served, and the transfer did not go through${b.billingFails ? `; ${b.billingFails} of them ${b.billingFails === 1 ? "was" : "were"} a facilitator billing refusal on this server's account, not the wallet's` : ""}); ${until} ${network ? `Before paying on ${network} again, check the wallet's balance of the payment token there.` : "Check the wallet's USDC balance on the paying chain before retrying."}`);
    e.statusCode = 429;
    e.retryAfterMs = b.until - now;
    // Machine-readable, beside the message (src/tool-error-fields.js):
    // retryAfterSeconds, and for a network key the refused network, what to
    // do (retry: other-network) and where the other networks are listed. The
    // route's offer is built per request by the paywall and is not held
    // here, so the fields name its 402 instead of repeating a list.
    e.retryAfter = secs;
    if (network) { e.retry = "other-network"; e.refusedNetwork = network; e.otherNetworksFrom = "accepts[].network in this route's 402"; }
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
  const g = gatewaySettleBreakerGlobalAlarm(now);
  return {
    // Count keys: an EVM payer counts once per network it failed on.
    trackedKeys, blockedKeys,
    // Buyers with a settle failure inside the window, plus each failure
    // recorded with no buyer (a withdrawn sub-cent refusal counts on its
    // own): the count the burst alarm trips on.
    globalFailsInWindow: (pruneGlobal(now), globalFailKeys.size),
    globalAlarm: g.alarm, globalAlarmUntil: g.alarm ? new Date(g.until).toISOString() : null, globalTrips,
    maxFails: MAX_FAILS, minFailShare: MIN_FAIL_SHARE, hardMaxFails: HARD_MAX_FAILS, windowMs: WINDOW_MS, globalMaxFails: GLOBAL_MAX_FAILS,
  };
}

/** The settleFailures word for /api/gateway-status: ok, or burst for one
 *  window after GLOBAL_MAX_FAILS distinct buyers failed to settle /v1 calls
 *  inside a window (on any replica, through the shared flag). The word only
 *  publicly; the operator read adds the counts. Never a key. */
export async function gatewaySettleFailuresStatus({ full = false, now = Date.now() } = {}) {
  const g = SHARED ? await sharedGlobalAlarm(now) : gatewaySettleBreakerGlobalAlarm(now);
  const status = g.alarm ? "burst" : "ok";
  if (!full) return { status };
  const s = gatewaySettleBreakerStatus(now);
  return { status, until: g.alarm ? new Date(g.until).toISOString() : null, buyersInWindow: s.globalFailsInWindow, threshold: GLOBAL_MAX_FAILS, windowMinutes: WINDOW_MS / 60_000, trips: s.globalTrips, blockedKeys: s.blockedKeys, trackedKeys: s.trackedKeys };
}

/** Test-only. With a shared store it returns a promise that settles once
 *  every write already sent (a trip's alarm flag included) has landed and the
 *  shared windows and flag are cleared after them; await it. */
export function _gatewaySettleBreakerReset() {
  const keys = new Set([...fails.keys(), ...billingFails.keys(), ...oks.keys()]);
  fails.clear(); billingFails.clear(); oks.clear(); globalFailKeys = new Map(); globalAlarmUntil = 0; globalTrips = 0;
  if (!SHARED) return undefined;
  return (async () => {
    while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
    await Promise.allSettled([
      ...[...keys].flatMap((k) => ["gwb-fail", "gwb-bill", "gwb-ok"].map((name) => shared.windowClear(name, sharedKey(k)))),
      shared.flagSet("gwb-alarm", "all", 0), shared.windowClear("gwb-global", "all"),
    ]);
    globalAlarmUntil = 0; globalTrips = 0;
  })();
}
/** Whether this process writes the breaker through to the shared store. */
export const _gatewaySettleBreakerShared = SHARED;
