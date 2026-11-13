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
// the signed EIP-3009 payer, else the Tempo payer the gate verified, else the
// credits key, else the signer of a Solana, Algorand or Stellar payment read
// from what it signed, else the client IP (gatewaySettleBreakerKey).
//
// PER NETWORK. A signed EVM payer is counted per network its payment named
// (payer@network): failures on one network refuse payments on that network
// only, and the same wallet paying on another offered network is served at
// once. The 429 names the refused network and says so.
//
// NO REQUEST IS REFUSED FOR OTHER BUYERS' FAILURES ALONE. Distinct buyers
// failing to settle on the /v1 tiers inside one window are counted, and at
// GLOBAL_MAX_FAILS the count is reported: a console.warn and the
// settleFailures word on /api/gateway-status (ok / burst), which the status
// Worker and the heartbeat page on.
//
// THE SERVICE-WIDE BOUND. Every new wallet starts at zero, so the per-key
// counts alone let a caller who rotates wallets be served MAX_FAILS unpaid
// /v1 runs per wallet with no end. Distinct buyers whose /v1 failures are
// read against them (a verdict on the payment, or of unknown cause; never
// ours, a withdrawn sub-cent refusal or a payment still settling) are
// counted on their own, and at GLOBAL_MAX_FAILS inside the window the bound
// is up for one window (shared flag gwb-wide). While it is up, a /v1
// consult reads a key's buyer-verdict and unknown-cause counts at
// BURST_MAX_FAILS (default 1) instead of MAX_FAILS and UNKNOWN_MAX_FAILS:
// a wallet whose OWN payments mostly fail is held after its first unsettled
// run instead of its third or ninth, for no longer than the alarm lasts. The
// share rule is unchanged, so a wallet whose payments settle (failures at or
// under MIN_FAIL_SHARE of its outcomes) is never refused by it, a fresh
// wallet with no failure is served, failures that are ours (not-buyer) are
// not read at the lower count, and the catalog consult (global:false) is
// untouched.
//
// ONE AUTHORIZATION RE-PRESENTED. A settle that fails for a reason of ours
// leaves the signed authorization unspent, and the receipt invites the buyer
// to resend it. Those failures never count against the wallet, so one
// authorization could be re-presented and served unpaid with no bound. Every
// served run that does not settle is therefore also counted per signed EVM
// authorization (payer, network and nonce): at AUTH_MAX_FAILS inside the
// window that one authorization is refused, the 429 says to sign a new one,
// and a new authorization from the same wallet is served at once. A buyer
// signs a new authorization for every new call, so none is ever refused here.
//
// ONE PAYER ON SEVERAL NETWORKS. The per-network count lets one wallet reach
// the refusing count on every network a route offers, each one a run served
// and not paid. Distinct buyers never see it (it is one buyer), so the same
// alarm also trips when one payer's /v1 failures hold a refusing count on
// MULTI_NETWORK_MIN networks inside the window. Reported only: the wallet is
// refused per network exactly as before, and nobody else is refused.
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
// status rides with it.
//
// WHO IS COUNTED (src/settle-fault.js settleFailureFault; for the Tempo gate,
// which carries no x402 receipt, the gate's own SETTLE_FAULT mark):
//   buyer      a definite verdict on the buyer's payment (balance,
//              signature, an authorization used or expired, a payload
//              refused, or the chain's own words that the wallet came up
//              short): counted at MAX_FAILS, and the 429 names the payment.
//   unknown    a revert or failed simulation that names no balance, a bare
//              settlement_failed, a 402 with no receipt, a settle still
//              pending: counted at UNKNOWN_MAX_FAILS (a served run that is
//              never paid stays bounded per wallet), and the 429 says only
//              that settlement of the wallet's recent payments did not
//              complete, which is true whoever caused it.
//   not-buyer  ours or a third party's, proven (our timeout or socket error,
//              our store or a hook of ours, our relayer, our credentials, a
//              facilitator's HTTP error or a billing limit on our account):
//              never counted against the wallet.
// Every failure feeds the burst alarm, and one key's run of unknown or
// not-buyer failures at MAX_FAILS raises it too, so a loop is paged on.
// Not caught, and accepted: a MALFORMED facilitator
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
// read by the status word only, the service-wide bound is a shared flag
// read by the /v1 consult (THE SERVICE-WIDE BOUND), and the consult
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
import { nonEvmPayerFromRequest } from "./non-evm-payer.js";
import { decodePaymentHeader, canonicalNonce } from "./payment-header.js";
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded } from "./shared-limits.js";
import { settleFailureFault, isBlocklistSettleVerdict, SETTLE_FAULT, RAW_SETTLE_RECEIPT } from "./settle-fault.js";
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
/** Failures of unknown cause (WHO IS COUNTED) a wallet may accumulate inside
 *  the window before it is refused: three times MAX_FAILS by default, never
 *  under it. The share rule and HARD_MAX_FAILS apply to them as to verdicts. */
export const UNKNOWN_MAX_FAILS = Math.max(MAX_FAILS, num(process.env.GATEWAY_SETTLE_BREAKER_UNKNOWN_MAX, 3 * MAX_FAILS));
/** Settled outcomes kept per key (the window's rate needs a count, not every stamp). */
const MAX_OKS_KEPT = 5000;
/** The count a /v1 consult reads a key's buyer-verdict and unknown-cause
 *  failures at while the burst alarm is up (THE SERVICE-WIDE BOUND): at least
 *  1, never above MAX_FAILS. */
export const BURST_MAX_FAILS = Math.min(MAX_FAILS, Math.max(1, Math.floor(num(process.env.GATEWAY_SETTLE_BREAKER_BURST_MAX, 1))));
/** Served runs that did not settle under ONE signed EVM authorization inside
 *  the window before that authorization is refused (ONE AUTHORIZATION
 *  RE-PRESENTED). */
export const AUTH_MAX_FAILS = Math.max(1, Math.floor(num(process.env.GATEWAY_SETTLE_BREAKER_AUTH_MAX, MAX_FAILS)));
const AUTH_KEYS_MAX = 20_000;
/** DISTINCT buyers with a /v1 settle failure inside the window that raise the
 *  burst alarm (the settleFailures word, a console.warn). An alarm only: no
 *  request is refused for it. Distinct, not a sum of failures: one wallet
 *  firing a burst of concurrent calls is one buyer, on however many networks,
 *  and is the per-key bound's job; the alarm reports many buyers failing at
 *  once. The one exception is a withdrawn sub-cent refusal: each counts on
 *  its own (see armGatewaySettleBreaker). */
export const GLOBAL_MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX, 12);
/** Networks on which ONE payer's /v1 settle failures must each hold a
 *  refusing count (`verdict`: MAX_FAILS and the share rule, or HARD_MAX_FAILS)
 *  inside the window for the burst alarm to trip on that payer alone. An
 *  alarm only. Never under 2: one network at its limit is the per-key bound
 *  doing its job. */
export const MULTI_NETWORK_MIN = Math.max(2, Math.floor(num(process.env.GATEWAY_SETTLE_BREAKER_MULTI_NETWORK_MIN, 3)));

const fails = new Map(); // key -> number[] (failure timestamps inside the window)
const oks = new Map();   // key -> number[] (settled-call timestamps inside the window)
// key -> number[]: failures inside the window that proved nothing about the
// wallet (see WHO IS COUNTED). Never read by the consult: at the same count
// and share that would refuse a wallet, they raise the burst alarm instead
// (this process's count; the alarm flag is shared).
const unprovenFails = new Map();
// key -> number[]: failures of unknown cause inside the window, the count the
// consult refuses at UNKNOWN_MAX_FAILS (shared window gwb-unk).
const unknownFails = new Map();
// key -> number[]: the buyer failures that were our own blocklist's verdict
// (wallet_blocked). A key refused with one of these in its window is told
// that settlement did not proceed for the wallet, never a balance or
// signature story the receipt does not tell.
const blocklistFails = new Map();
const unprovenAlarmed = new Map(); // key -> until when its run has raised the alarm
// authorization key -> number[]: served runs under that one signed
// authorization that did not settle (shared window gwb-auth).
const authFails = new Map();
let unprovenTrips = 0;
// buyer -> the time of its latest settle failure inside the window: the burst
// alarm counts distinct buyers (see GLOBAL_MAX_FAILS), so a count key's
// network is dropped here (buyerOf). A failure with no key
// (no request to key it on, or a withdrawn sub-cent refusal, which is recorded
// keyless on purpose so it stays a backstop) counts as its own buyer.
let globalFailKeys = new Map();
let anonSeq = 0;
let globalAlarmUntil = 0;
let globalTrips = 0;
// buyer -> the time of its latest /v1 failure read against it (THE
// SERVICE-WIDE BOUND), and until when the bound is up on this process.
let wideFailKeys = new Map();
let wideUntil = 0;
let wideTrips = 0;
// buyer -> Map(network -> when its count on that network last read refusing
// after a /v1 failure). The buyer is the count key's own payer text
// (buyerOf), never re-cased; only a key that names a network is held here.
const networksAtLimit = new Map();
const NETWORKS_AT_LIMIT_MAX_BUYERS = 5000;
let multiNetworkTrips = 0;

// ---- the shared half ----------------------------------------------------------
// Window names: gwb-fail (per key, one entry per verdict counted against
// the wallet), gwb-unk (per key, one entry per failure of unknown cause),
// gwb-ok (per key, one entry per settled call), gwb-blk (per key, one entry
// per counted verdict that was our blocklist's: it only picks the refusal's
// words), gwb-global (one entry per distinct buyer; a keyless failure is its own
// entry), gwb-nets (per payer, one entry per network its count reads
// refusing on), gwb-auth (per signed EVM authorization, one entry per
// served run under it that did not settle), gwb-wide-buyers (one entry per
// distinct buyer whose /v1 failure was read against it), the flag gwb-alarm
// (read by the status word only) and the flag gwb-wide (THE SERVICE-WIDE
// BOUND, read by the /v1 consult; an earlier build neither writes nor reads
// it, so a deploy overlap refuses nobody for it). A window add returns the shared count, so
// the trip decision is made on the count every replica contributed to. An
// earlier build also kept gwb-bill (billing refusals, then counted against
// the wallet); this build neither writes nor reads it, and it expires with
// its window.
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
function sharedRecordFailure(key, now, { global, withdrawn, walletCount = true, unknown = false, blocklisted = false, authKey = null, wide = false }) {
  const member = `${PROC}:${++sharedSeq}`;
  if (wide) {
    void write(shared.windowAdd("gwb-wide-buyers", "all", { windowMs: WINDOW_MS, member: sharedKey(buyerOf(key)), now })).then((r) => {
      if (!r?.ok || r.count < GLOBAL_MAX_FAILS) return;
      void write(shared.flagSet("gwb-wide", "all", now + WINDOW_MS, { now }));
      void write(shared.windowClear("gwb-wide-buyers", "all"));
      raiseWideBound(now, r.count, { acrossReplicas: true });
    });
  }
  if (authKey) void write(shared.windowAdd("gwb-auth", sharedKey(authKey), { windowMs: WINDOW_MS, member, now }));
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
  if (key && unknown) void write(shared.windowAdd("gwb-unk", sharedKey(key), { windowMs: WINDOW_MS, member, now }));
  if (key && walletCount && blocklisted) void write(shared.windowAdd("gwb-blk", sharedKey(key), { windowMs: WINDOW_MS, member, now }));
  if (!key || !walletCount) return;
  void write(shared.windowAdd("gwb-fail", sharedKey(key), { windowMs: WINDOW_MS, member, now })).then((r) => {
    // A /v1 failure that brings this key's shared count to the refusing
    // count: one more network for its payer (see MULTI_NETWORK_MIN).
    if (global && r?.ok && r.count >= MAX_FAILS && networkOf(key)) void write(sharedNoteNetworkAtLimit(key, r.count, now));
  });
}
/** The shared half of the one-payer rule: the key's settled count is read
 *  beside its failure count (the same verdict the consult reaches), its
 *  network joins the payer's window, and MULTI_NETWORK_MIN networks there set
 *  the alarm flag every replica's status word reads. Off the serving path. */
async function sharedNoteNetworkAtLimit(key, nFails, now) {
  const o = await shared.windowReadMany([{ name: "gwb-ok", key: sharedKey(key), windowMs: WINDOW_MS }], { now });
  if (!o.ok) return o;
  if (!verdict([], nFails, o.results[0].count).blocked) return o;
  const payer = sharedKey(buyerOf(key));
  const r = await shared.windowAdd("gwb-nets", payer, { windowMs: WINDOW_MS, member: networkOf(key), now });
  if (!r?.ok || r.count < MULTI_NETWORK_MIN) return r;
  void write(shared.flagSet("gwb-alarm", "all", now + WINDOW_MS, { now }));
  void write(shared.windowClear("gwb-nets", payer));
  raiseMultiNetworkAlarm(now, r.count, { acrossReplicas: true });
  return r;
}
function sharedRecordSuccess(key, now) {
  void write(shared.windowAdd("gwb-ok", sharedKey(key), { windowMs: WINDOW_MS, member: `${PROC}:${++sharedSeq}`, now }));
}
/** The per-key state with the shared windows folded in: each count is the
 *  larger of the store's and this process's own (a write of this process
 *  may not have landed yet), and the lift time comes from whichever
 *  failure list is read. A store that does not answer leaves it to this
 *  process's counts. */
async function sharedBlocked(key, now, { burstUntilP = 0, authKey = null } = {}) {
  if (!key) return gatewaySettleBreakerBlocked(key, now);
  // The alarm read (when asked for) runs beside the window read.
  const [r, burstUntil] = await Promise.all([shared.windowReadMany([
    { name: "gwb-fail", key: sharedKey(key), windowMs: WINDOW_MS },
    { name: "gwb-ok", key: sharedKey(key), windowMs: WINDOW_MS },
    { name: "gwb-unk", key: sharedKey(key), windowMs: WINDOW_MS },
    { name: "gwb-blk", key: sharedKey(key), windowMs: WINDOW_MS },
    ...(authKey ? [{ name: "gwb-auth", key: sharedKey(authKey), windowMs: WINDOW_MS }] : []),
  ], { now }), Promise.resolve(burstUntilP).catch(() => 0)]);
  const local = gatewaySettleBreakerBlocked(key, now, { burstUntil, authKey });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return local; }
  const [f, o, u, k, a] = r.results;
  const timesOf = (w, localCount, map, mapKey = key) => (w.count > localCount && Array.isArray(w.entries) ? w.entries.map((e) => e.score).sort((x, y) => x - y) : inWindow(map.get(mapKey) || [], now));
  const nOks = Math.max(o.count, local.oks);
  const burst = burstUntil > now;
  return combined(
    clampToBurst(verdict(timesOf(f, local.fails, fails), Math.max(f.count, local.fails), nOks, burst ? BURST_MAX_FAILS : MAX_FAILS), burstUntil, now),
    clampToBurst(verdict(timesOf(u, local.unknownFails, unknownFails), Math.max(u.count, local.unknownFails), nOks, burst ? BURST_MAX_FAILS : UNKNOWN_MAX_FAILS), burstUntil, now),
    local.blocklisted || (k?.count || 0) > 0,
    authKey ? authVerdict(timesOf(a, local.authFails, authFails, authKey), Math.max(a?.count || 0, local.authFails)) : null,
  );
}
/** Until when THE SERVICE-WIDE BOUND is up (0: it is not), with the shared
 *  flag folded in. Read by the /v1 consult; a store that does not answer
 *  leaves this process's own. */
async function sharedWideUntil(now) {
  const local = wideBoundUntil(now);
  if (local) return local;
  const r = await shared.flagGet("gwb-wide", "all", { now });
  if (!r.ok) { noteSharedLimitsDegraded(CONTROL, r); return local; }
  return r.until > now ? r.until : 0;
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

/** The buyer a gateway call belongs to: the signed EVM payer, else the Tempo
 *  sender the gate VERIFIED (src/mpp-tempo.js sets req.mppTempoSender, null for
 *  a sender neither the signature nor the chain proved; the credential's own
 *  `source` is client-supplied and a caller could name a fresh one per
 *  request, so it is never a key), else the credits key, else the signer of
 *  a Solana, Algorand or Stellar payment read from what it signed
 *  (src/non-evm-payer.js: `svm:`, `avm:`, `stellar:`, case kept, read by
 *  resolveGatewaySettleBreakerSigner before the consult), else the client IP.
 *  Without the signer, every wallet paying on those rails from one address
 *  shared one IP key, so one wallet's settle failures refused the others.
 *  Null only for an in-process caller with no request (route-execute
 *  dispatching a flat tier), which nothing here refuses. */
export function gatewaySettleBreakerKey(req) {
  if (!req || typeof req !== "object") return null;
  const payer = payerFromRequest(req);
  if (payer) return payer;
  if (req.mppTempoSender) return `tempo:${req.mppTempoSender}`;
  if (req.creditsKeyId) return `credits:${req.creditsKeyId}`;
  const signer = Object.hasOwn(req, NON_EVM_SIGNER) ? req[NON_EVM_SIGNER] : null;
  if (signer) return signer;
  const ip = typeof req.ip === "string" && req.ip.trim() ? req.ip.trim() : req.socket?.remoteAddress;
  return ip ? `ip:${String(ip).trim()}` : null;
}
// The non-EVM signer read for this request: a rail-prefixed address, or ""
// once read and none was found (the IP fallback). Own, non-enumerable, read
// once per request (the catalog consult and the /v1 handler's own share it).
const NON_EVM_SIGNER = "__a402BreakerNonEvmSigner";
/** Does this request still need its non-EVM signer read? Only a request with
 *  a payment header and none of the keys ahead of the signer. */
function signerReadPending(req) {
  if (!req || typeof req !== "object" || Object.hasOwn(req, NON_EVM_SIGNER)) return false;
  if (req.mppTempoSender || req.creditsKeyId) return false;
  if (!paymentHeaderOf(req)) return false;
  return !payerFromRequest(req);
}
/** Read the signer of a Solana, Algorand or Stellar payment on this request
 *  into its breaker key. The paywall verified the payment before any consult
 *  runs, so the signer named inside it is the wallet that paid. Never throws;
 *  an unreadable payload leaves the IP fallback. Exported for tests. */
export async function resolveGatewaySettleBreakerSigner(req) {
  if (!signerReadPending(req)) return;
  let signer = "";
  try { signer = (await nonEvmPayerFromRequest(req)) || ""; } catch { signer = ""; }
  try { Object.defineProperty(req, NON_EVM_SIGNER, { value: signer, enumerable: false, configurable: true }); } catch { /* a frozen request keeps the IP key */ }
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
/** The name a call's per-key shared windows (gwb-fail, gwb-ok) are
 *  stored under: its count key as the store spells it. For a reader of the
 *  store (a test), so the key shape lives here only. Null with no key. */
export function gatewaySettleBreakerSharedKeyOf(req) {
  const key = gatewaySettleBreakerCountKey(req);
  return key ? sharedKey(key) : null;
}
/** The signed EVM authorization a call paid with, as one key: its count key
 *  (payer@network) and its canonical nonce (EIP-3009 authorization, or a
 *  Permit2 authorization). Null for any other rail or a payment naming no
 *  nonce. */
export function gatewaySettleBreakerAuthKey(req) {
  const key = gatewaySettleBreakerCountKey(req);
  if (!key || !EVM_PAYER.test(buyerOf(key))) return null;
  try {
    const p = decodePaymentHeader(paymentHeaderOf(req));
    const inner = p?.payload;
    const raw = inner?.authorization?.nonce ?? inner?.permit2Authorization?.nonce;
    if (raw == null || (typeof raw !== "string" && typeof raw !== "number")) return null;
    const nonce = canonicalNonce(raw);
    return nonce ? `${key}#${nonce.slice(0, 160)}` : null;
  } catch { return null; }
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
function verdict(failTimes, nFails, nOks, max = MAX_FAILS) {
  const out = { blocked: false, fails: nFails, oks: nOks };
  if (nFails < max) return out;
  if (nFails < HARD_MAX_FAILS && nFails <= MIN_FAIL_SHARE * (nFails + nOks)) return out;
  const idx = Math.max(0, failTimes.length - max);
  return { ...out, blocked: true, until: (failTimes[idx] ?? failTimes[failTimes.length - 1] ?? Date.now()) + WINDOW_MS };
}
/** A refusal reached at the burst count is held no longer than the alarm. */
function clampToBurst(v, burstUntil, now) {
  if (!v.blocked || !(burstUntil > now) || !(v.until > burstUntil)) return v;
  return { ...v, until: burstUntil };
}
/** One authorization's unsettled runs: refused at AUTH_MAX_FAILS (no share
 *  rule: an authorization settles once or not at all). */
function authVerdict(times, n) {
  const out = { blocked: false, fails: n };
  if (n < AUTH_MAX_FAILS) return out;
  const idx = Math.max(0, times.length - AUTH_MAX_FAILS);
  return { ...out, blocked: true, until: (times[idx] ?? times[times.length - 1] ?? Date.now()) + WINDOW_MS };
}
/** One key's state from its counts: refused when its verdicts, its unknown
 *  failures or this call's authorization are at their limit; `kind` says
 *  which (a verdict first), and the refusal's words follow it. */
function combined(v, u, blocklisted = false, a = null) {
  const out = { blocked: v.blocked || u.blocked || !!a?.blocked, fails: v.fails, oks: v.oks, unknownFails: u.fails, authFails: a?.fails || 0, blocklisted: !!blocklisted };
  if (v.blocked) return { ...out, kind: "buyer", until: v.until };
  if (u.blocked) return { ...out, kind: "unknown", until: u.until };
  if (a?.blocked) return { ...out, kind: "authorization", until: a.until };
  return out;
}
/** The alarm, raised for one payer (this process's word; the shared flag is
 *  the caller's). Logged once per raise: a trip that finds the alarm already
 *  up for the same reason from the other half extends nothing and says nothing. */
function raiseMultiNetworkAlarm(now, nNetworks, { acrossReplicas = false } = {}) {
  if (acrossReplicas && globalAlarmUntil > now) return;
  globalAlarmUntil = now + WINDOW_MS;
  globalTrips++;
  multiNetworkTrips++;
  console.warn(`[gateway-breaker] one buyer's unsettled gateway calls reached the per-network limit on ${nNetworks} networks${acrossReplicas ? " across replicas" : ""} inside ${Math.round(WINDOW_MS / 1000)} s - settleFailures reads burst until ${new Date(globalAlarmUntil).toISOString()}; no request is refused for it`);
}
/** A /v1 failure left this count key refusing: note its network for its
 *  payer, and raise the alarm at MULTI_NETWORK_MIN networks inside the
 *  window. A key with no network (Tempo, credits, IP, an unnamed network) is
 *  one key and is never counted here. */
function noteNetworkAtLimit(key, now) {
  const network = networkOf(key);
  if (!network) return;
  const buyer = buyerOf(key);
  let nets = networksAtLimit.get(buyer);
  if (!nets) {
    if (networksAtLimit.size >= NETWORKS_AT_LIMIT_MAX_BUYERS) pruneNetworksAtLimit(now);
    if (networksAtLimit.size >= NETWORKS_AT_LIMIT_MAX_BUYERS) networksAtLimit.clear();
    nets = new Map();
    networksAtLimit.set(buyer, nets);
  }
  for (const [n, t] of nets) if (now - t >= WINDOW_MS) nets.delete(n);
  nets.set(network, now);
  if (nets.size < MULTI_NETWORK_MIN) return;
  networksAtLimit.delete(buyer);
  raiseMultiNetworkAlarm(now, nets.size);
}
function pruneNetworksAtLimit(now) {
  for (const [buyer, nets] of networksAtLimit) {
    for (const [n, t] of nets) if (now - t >= WINDOW_MS) nets.delete(n);
    if (!nets.size) networksAtLimit.delete(buyer);
  }
}
function pruneGlobal(now) { for (const [k, t] of globalFailKeys) if (now - t >= WINDOW_MS) globalFailKeys.delete(k); }
/** Until when THE SERVICE-WIDE BOUND is up on this process (0: it is not). */
function wideBoundUntil(now) { if (wideUntil > now) return wideUntil; wideUntil = 0; return 0; }
function raiseWideBound(now, nBuyers, { acrossReplicas = false } = {}) {
  if (acrossReplicas && wideUntil > now) return;
  const fresh = wideUntil <= now;
  wideUntil = now + WINDOW_MS;
  if (!fresh) return;
  wideTrips++;
  console.warn(`[gateway-breaker] /v1 payments from ${nBuyers} buyer(s)${acrossReplicas ? " across replicas" : ""} failed to settle inside ${Math.round(WINDOW_MS / 1000)} s - until ${new Date(wideUntil).toISOString()} a wallet whose own payments mostly fail is held after ${BURST_MAX_FAILS} unsettled /v1 run(s); a wallet whose payments settle is served as before`);
}
/** A /v1 failure read against its buyer, for THE SERVICE-WIDE BOUND. */
function noteWideFailure(key, now) {
  for (const [k, t] of wideFailKeys) if (now - t >= WINDOW_MS) wideFailKeys.delete(k);
  wideFailKeys.set(buyerOf(key), now);
  if (wideFailKeys.size < GLOBAL_MAX_FAILS) return;
  const n = wideFailKeys.size;
  wideFailKeys = new Map();
  raiseWideBound(now, n);
}

/** Per-key state (this process): see `verdict`. `burstUntil` (a /v1 consult
 *  while the alarm is up) reads the key's verdict and unknown counts at
 *  BURST_MAX_FAILS; `authKey` adds this call's authorization count. */
export function gatewaySettleBreakerBlocked(key, now = Date.now(), { burstUntil = 0, authKey = null } = {}) {
  if (!key) return { blocked: false, fails: 0, oks: 0, unknownFails: 0, authFails: 0, blocklisted: false };
  const arr = inWindow(fails.get(key) || [], now);
  if (arr.length) fails.set(key, arr); else fails.delete(key);
  const unk = inWindow(unknownFails.get(key) || [], now);
  if (unk.length) unknownFails.set(key, unk); else unknownFails.delete(key);
  const ok = inWindow(oks.get(key) || [], now);
  if (ok.length) oks.set(key, ok); else oks.delete(key);
  const blk = inWindow(blocklistFails.get(key) || [], now);
  if (blk.length) blocklistFails.set(key, blk); else blocklistFails.delete(key);
  let a = null;
  if (authKey) {
    const at = inWindow(authFails.get(authKey) || [], now);
    if (at.length) authFails.set(authKey, at); else authFails.delete(authKey);
    a = authVerdict(at, at.length);
  }
  const burst = burstUntil > now;
  return combined(
    clampToBurst(verdict(arr, arr.length, ok.length, burst ? BURST_MAX_FAILS : MAX_FAILS), burstUntil, now),
    clampToBurst(verdict(unk, unk.length, ok.length, burst ? BURST_MAX_FAILS : UNKNOWN_MAX_FAILS), burstUntil, now),
    blk.length > 0, a,
  );
}

/** The burst alarm (this process): raised for WINDOW_MS once GLOBAL_MAX_FAILS buyers fail to settle inside a window (a failure recorded with no buyer counts on its own), or once one payer's failures read refusing on MULTI_NETWORK_MIN networks. It refuses nothing. */
export function gatewaySettleBreakerGlobalAlarm(now = Date.now()) {
  if (globalAlarmUntil > now) return { alarm: true, until: globalAlarmUntil };
  globalAlarmUntil = 0;
  return { alarm: false };
}

/** A key's failures that proved nothing about the wallet (see WHO IS
 *  COUNTED), and whether they would refuse it were they verdicts. */
export function gatewaySettleBreakerUnproven(key, now = Date.now()) {
  if (!key) return { fails: 0, atLimit: false };
  const arr = inWindow(unprovenFails.get(key) || [], now);
  if (arr.length) unprovenFails.set(key, arr); else unprovenFails.delete(key);
  return { fails: arr.length, atLimit: verdict(arr, arr.length, inWindow(oks.get(key) || [], now).length).blocked };
}
/** One key's unproven failures reached the count and share that would refuse
 *  a wallet: the burst alarm, once per window per key. Refuses nothing. */
function noteUnprovenFailure(key, now) {
  const arr = inWindow(unprovenFails.get(key) || [], now);
  arr.push(now);
  if (arr.length > MAX_OKS_KEPT) arr.splice(0, arr.length - MAX_OKS_KEPT);
  unprovenFails.set(key, arr);
  if (unprovenFails.size > NETWORKS_AT_LIMIT_MAX_BUYERS) { for (const [k, a] of unprovenFails) if (!inWindow(a, now).length) unprovenFails.delete(k); }
  const v = verdict(arr, arr.length, inWindow(oks.get(key) || [], now).length);
  // Once per window per key, so a long run raises it once.
  if (!v.blocked || (unprovenAlarmed.get(key) || 0) > now) return;
  unprovenAlarmed.set(key, now + WINDOW_MS);
  if (unprovenAlarmed.size > NETWORKS_AT_LIMIT_MAX_BUYERS) { for (const [k, t] of unprovenAlarmed) if (t <= now) unprovenAlarmed.delete(k); }
  unprovenTrips++;
  if (globalAlarmUntil <= now) globalTrips++;
  globalAlarmUntil = now + WINDOW_MS;
  if (SHARED) void write(shared.flagSet("gwb-alarm", "all", now + WINDOW_MS, { now }));
  console.warn(`[gateway-breaker] ${arr.length} paid calls from one buyer${networkOf(key) ? ` on ${networkOf(key)}` : ""} were served and could not be settled inside ${Math.round(WINDOW_MS / 1000)} s, none of them a verdict on the buyer's payment - settleFailures reads burst until ${new Date(globalAlarmUntil).toISOString()}`);
}

/** A payment was presented, the handler served, and settlement FAILED.
 *  `fault` (WHO IS COUNTED): "buyer" counts at MAX_FAILS, "unknown" at
 *  UNKNOWN_MAX_FAILS, "not-buyer" never; both of the latter feed the one-key
 *  alarm. `walletCount:false` keeps a buyer failure off the wallet. */
export function recordGatewaySettleFailure(key, now = Date.now(), { global = true, withdrawn = false, walletCount = true, fault = "buyer", blocklisted = false, authKey = null } = {}) {
  const isBuyer = fault !== "unknown" && fault !== "not-buyer";
  const unknown = fault === "unknown" && !!key;
  // ONE AUTHORIZATION RE-PRESENTED: every served run that did not settle,
  // whoever's the fault, except a payment still settling (walletCount:false).
  const authCounted = typeof authKey === "string" && !!authKey && !!key && walletCount;
  if (authCounted) {
    const at = inWindow(authFails.get(authKey) || [], now);
    at.push(now);
    if (at.length > MAX_OKS_KEPT) at.splice(0, at.length - MAX_OKS_KEPT);
    authFails.delete(authKey);
    authFails.set(authKey, at);
    if (authFails.size > AUTH_KEYS_MAX) { for (const [k, t] of authFails) if (!inWindow(t, now).length) authFails.delete(k); }
    while (authFails.size > AUTH_KEYS_MAX) authFails.delete(authFails.keys().next().value);
  }
  // THE SERVICE-WIDE BOUND counts a /v1 failure read against its buyer.
  const wide = !!global && !!key && !withdrawn && walletCount && fault !== "not-buyer";
  if (wide) noteWideFailure(key, now);
  if (SHARED) sharedRecordFailure(key, now, { global, withdrawn, walletCount: walletCount && isBuyer, unknown, blocklisted: blocklisted && isBuyer, authKey: authCounted ? authKey : null, wide });
  if (!isBuyer && key) noteUnprovenFailure(key, now);
  if (unknown) {
    const u = inWindow(unknownFails.get(key) || [], now);
    u.push(now);
    if (u.length > MAX_OKS_KEPT) u.splice(0, u.length - MAX_OKS_KEPT);
    unknownFails.set(key, u);
    if (verdict(u, u.length, inWindow(oks.get(key) || [], now).length, UNKNOWN_MAX_FAILS).blocked) console.warn(`[gateway-breaker] ${u.length} settlements of unknown cause against ${inWindow(oks.get(key) || [], now).length} settled calls inside the window for one buyer${networkOf(key) ? ` on ${networkOf(key)}` : ""} - refusing its paid calls${networkOf(key) ? " on that network" : ""} until the window clears`);
  }
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
  // walletCount:false (a Circle Gateway settlement still pending), and every
  // failure that is not a verdict: nothing more against the wallet here.
  if (!key || !walletCount || !isBuyer) return;
  const arr = inWindow(fails.get(key) || [], now);
  arr.push(now);
  fails.set(key, arr);
  if (blocklisted) {
    const blk = inWindow(blocklistFails.get(key) || [], now);
    blk.push(now);
    if (blk.length > MAX_OKS_KEPT) blk.splice(0, blk.length - MAX_OKS_KEPT);
    blocklistFails.set(key, blk);
  }
  const v = verdict(arr, arr.length, inWindow(oks.get(key) || [], now).length);
  // A /v1 failure that leaves the key refusing is one network at its limit
  // for this payer (the catalog consult's failures, global:false, are the
  // wallet's count only, like the rest of the alarm).
  if (v.blocked && global) noteNetworkAtLimit(key, now);
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
  const authKey = gatewaySettleBreakerAuthKey(req);
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
      // Every other failed settle feeds the burst alarm; it counts against
      // the WALLET only when it is a definite verdict on the buyer's payment
      // (WHO IS COUNTED). Anything else - our own timeout, store or hook, a
      // facilitator's HTTP error or a billing refusal on our account, a 402
      // with no receipt - is unproven: kept off the wallet, and a run of
      // them on one key raises the alarm instead.
      if (st === 402 || receipt?.success === false) {
        const marked = req[SETTLE_FAULT];
        const fault = receipt?.success === false
          ? settleFailureFault({ receipt, raw: req[RAW_SETTLE_RECEIPT] || null, network: gatewaySettleBreakerNetwork(req) })
          : marked === "buyer" || marked === "not-buyer" ? marked : "unknown";
        const blocklisted = receipt?.success === false && isBlocklistSettleVerdict({ receipt, raw: req[RAW_SETTLE_RECEIPT] || null });
        recordGatewaySettleFailure(key, Date.now(), { global, fault, blocklisted, authKey });
      } else if (st === 200) recordGatewaySettleSuccess(key);
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
 * the outcome listener. Nothing here refuses for other buyers' failures
 * alone: while THE SERVICE-WIDE BOUND is up a /v1 key is read at
 * BURST_MAX_FAILS on its own failures, under the same share rule.
 * `global` says whether this call's settle failure feeds the burst alarm
 * (the /v1 tiers) or the wallet's count only (the catalog consult).
 * Synchronous (returns undefined, throws at once) without a shared store; a
 * promise with one, so `await` covers both.
 */
export function gatewaySettleBreakerCheck(req, { now = Date.now(), global = true } = {}) {
  // A non-EVM payment's signer is read first (an async parse for Algorand and
  // Stellar); every other key is decided as before.
  if (signerReadPending(req)) return resolveGatewaySettleBreakerSigner(req).then(() => consultKey(req, now, global));
  return consultKey(req, now, global);
}
function consultKey(req, now, global) {
  const key = gatewaySettleBreakerCountKey(req);
  const authKey = key ? gatewaySettleBreakerAuthKey(req) : null;
  // A /v1 consult reads THE SERVICE-WIDE BOUND; the catalog consult never does.
  if (!SHARED) {
    const burstUntil = global && key ? wideBoundUntil(now) : 0;
    decide(req, key, now, global, gatewaySettleBreakerBlocked(key, now, { burstUntil, authKey }));
    return undefined;
  }
  // Shared: this key's windows, read with this process's own counts as the
  // floor; a store that does not answer leaves the decision to those counts.
  // The bound's flag is read beside them (this process's own first; an
  // unanswered read leaves this process's).
  return (async () => {
    const burstUntilP = global && key ? sharedWideUntil(now).catch(() => wideBoundUntil(now)) : 0;
    decide(req, key, now, global, await sharedBlocked(key, now, { burstUntilP, authKey }));
  })();
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
    // A verdict on the buyer's payment is named; a run of unknown cause is
    // said as what it is, with no claim about whose fault it was.
    // A wallet whose strikes include our blocklist's verdict is told only
    // that settlement did not proceed for it (each receipt carries the reason
    // code): no balance or signature story the receipt does not tell.
    const e = new Error(b.kind === "authorization"
      ? `This payment authorization${on} was served ${b.authFails} times in the last ${mins} min and its settlement did not complete; this one authorization is refused until ${new Date(b.until).toISOString()} (about ${secs} s). Sign a new authorization (a new nonce) and the call is served at once. Nothing was charged for this request.`
      : b.kind === "unknown"
      ? `Settlement of this wallet's recent payments${on} did not complete (${b.unknownFails} in the last ${mins} min: each verified and was served, and its settlement did not complete); ${until}`
      : b.blocklisted
      ? `Recent payments from this wallet${on} were not settled (${b.fails} in the last ${mins} min: each verified and was served, and settlement did not proceed for this wallet; each refused settlement's PAYMENT-RESPONSE receipt carries its reason code); ${until}`
      : `Recent payments from this wallet${on} failed to settle (${b.fails} in the last ${mins} min: they verified, the call was served, and the settlement then refused the payment itself, for its balance, its signature, or an authorization already used or expired); ${until} ${network ? `Before paying on ${network} again, check the wallet's balance of the payment token there and sign a new authorization.` : "Check the wallet's USDC balance on the paying chain and sign a new authorization before retrying."}`);
    e.statusCode = 429;
    e.retryAfterMs = b.until - now;
    // Machine-readable, beside the message (src/tool-error-fields.js):
    // retryAfterSeconds, and for a network key the refused network, what to
    // do (retry: other-network) and where the other networks are listed. The
    // route's offer is built per request by the paywall and is not held
    // here, so the fields name its 402 instead of repeating a list.
    e.retryAfter = secs;
    if (b.kind === "authorization") e.hint = "sign-new-authorization";
    else if (network) { e.retry = "other-network"; e.refusedNetwork = network; e.otherNetworksFrom = "accepts[].network in this route's 402"; }
    try { req?.res?.setHeader?.("Retry-After", String(secs)); } catch { /* headers are best-effort */ }
    throw e;
  }
  armGatewaySettleBreaker(req, key, { global });
}

/** Counts only - never a key, address or IP. */
export function gatewaySettleBreakerStatus(now = Date.now()) {
  let blockedKeys = 0, trackedKeys = 0;
  for (const key of new Set([...fails.keys(), ...unknownFails.keys()])) {
    const s = gatewaySettleBreakerBlocked(key, now);
    if (s.fails || s.unknownFails) trackedKeys++;
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
    // Payers with a network at its limit inside the window (this process),
    // and how many times one payer alone raised the alarm.
    payersWithNetworkAtLimit: (pruneNetworksAtLimit(now), networksAtLimit.size), multiNetworkTrips, multiNetworkMin: MULTI_NETWORK_MIN,
    // Times one key's failures that proved nothing about the wallet reached
    // the refusing count and raised the alarm instead.
    unprovenTrips,
    globalAlarm: g.alarm, globalAlarmUntil: g.alarm ? new Date(g.until).toISOString() : null, globalTrips,
    // THE SERVICE-WIDE BOUND on this process: whether it is up, and how often it was raised.
    wideBound: wideBoundUntil(now) > 0, wideTrips,
    maxFails: MAX_FAILS, unknownMaxFails: UNKNOWN_MAX_FAILS, burstMaxFails: BURST_MAX_FAILS, authMaxFails: AUTH_MAX_FAILS, minFailShare: MIN_FAIL_SHARE, hardMaxFails: HARD_MAX_FAILS, windowMs: WINDOW_MS, globalMaxFails: GLOBAL_MAX_FAILS,
  };
}

/** The settleFailures word for /api/gateway-status: ok, or burst for one
 *  window after GLOBAL_MAX_FAILS distinct buyers failed to settle /v1 calls
 *  inside a window, or one payer's /v1 failures read refusing on
 *  MULTI_NETWORK_MIN networks (on any replica, through the shared flag). The word only
 *  publicly; the operator read adds the counts. Never a key. */
export async function gatewaySettleFailuresStatus({ full = false, now = Date.now() } = {}) {
  const g = SHARED ? await sharedGlobalAlarm(now) : gatewaySettleBreakerGlobalAlarm(now);
  const status = g.alarm ? "burst" : "ok";
  if (!full) return { status };
  const s = gatewaySettleBreakerStatus(now);
  return { status, until: g.alarm ? new Date(g.until).toISOString() : null, buyersInWindow: s.globalFailsInWindow, threshold: GLOBAL_MAX_FAILS, windowMinutes: WINDOW_MS / 60_000, trips: s.globalTrips, blockedKeys: s.blockedKeys, trackedKeys: s.trackedKeys, multiNetworkThreshold: MULTI_NETWORK_MIN, multiNetworkTrips: s.multiNetworkTrips, payersWithNetworkAtLimit: s.payersWithNetworkAtLimit, unprovenTrips: s.unprovenTrips, wideBound: s.wideBound, wideTrips: s.wideTrips, burstMaxFails: BURST_MAX_FAILS };
}

/** Test-only. With a shared store it returns a promise that settles once
 *  every write already sent (a trip's alarm flag included) has landed and the
 *  shared windows and flag are cleared after them; await it. */
export function _gatewaySettleBreakerReset() {
  const keys = new Set([...fails.keys(), ...oks.keys(), ...unknownFails.keys()]);
  const authKeys = [...authFails.keys()];
  authFails.clear();
  fails.clear(); unknownFails.clear(); blocklistFails.clear(); unprovenFails.clear(); unprovenAlarmed.clear(); unprovenTrips = 0; oks.clear(); globalFailKeys = new Map(); globalAlarmUntil = 0; globalTrips = 0;
  wideFailKeys = new Map(); wideUntil = 0; wideTrips = 0;
  networksAtLimit.clear(); multiNetworkTrips = 0;
  if (!SHARED) return undefined;
  return (async () => {
    while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
    await Promise.allSettled([
      ...[...keys].flatMap((k) => ["gwb-fail", "gwb-ok", "gwb-unk", "gwb-blk"].map((name) => shared.windowClear(name, sharedKey(k)))),
      ...authKeys.map((k) => shared.windowClear("gwb-auth", sharedKey(k))),
      ...[...new Set([...keys].filter((k) => networkOf(k)).map((k) => sharedKey(buyerOf(k))))].map((payer) => shared.windowClear("gwb-nets", payer)),
      shared.flagSet("gwb-alarm", "all", 0), shared.windowClear("gwb-global", "all"),
      shared.flagSet("gwb-wide", "all", 0), shared.windowClear("gwb-wide-buyers", "all"),
    ]);
    globalAlarmUntil = 0; globalTrips = 0; multiNetworkTrips = 0; wideUntil = 0; wideTrips = 0; wideFailKeys = new Map();
  })();
}
/** Whether this process writes the breaker through to the shared store. */
export const _gatewaySettleBreakerShared = SHARED;
