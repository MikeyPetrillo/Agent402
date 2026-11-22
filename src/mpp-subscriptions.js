// mpp-subscriptions - recurring monitor subscriptions paid with a WALLET over
// MPP, alongside the card path in src/stripe-subscriptions.js. An agent that
// holds a Tempo account can now subscribe to the same MONITOR_PRODUCTS a human
// buys with a card, and the SAME fulfilment engine (src/monitor-scheduler.js)
// serves both: the records this module hands out are the shape the scheduler
// already reads ({subId, product, target, email, status}), so the scheduler
// needs no change at all.
//
// WHAT MPPX ACTUALLY PROVIDES (verified against the installed mppx 0.8.17, not
// its docs; every claim below was executed before this file was written):
//   - `mppx/tempo` exports `Methods.subscription` = a real tempo/subscription
//     method whose request schema is
//       { amount, accessKey?, chainId?, currency, decimals, description?,
//         externalId?, methodDetails?, periodCount, periodUnit, recipient,
//         subscriptionExpires }
//     and whose CREDENTIAL payload is { type: "keyAuthorization", signature }.
//     `periodUnit` is only "day" | "week" | "dev_second" - there is NO "month",
//     so a monthly product is periodCount 30 / periodUnit "day" (2,592,000s).
//   - The wire shape after mppx's own schema transform is exactly the shape
//     lesson mpp-tempo.js already learned: base-units integer `amount`, NO
//     `decimals` key, `chainId` and `accessKey` moved under `methodDetails`,
//     addresses lowercased. So challenges here are minted through
//     Challenge.fromMethod, NEVER hand-assembled.
//   - `Tempo.Subscription.verifySubscriptionKeyAuthorization` verifies the
//     buyer's signed key authorization against the request and RECOVERS the
//     payer address cryptographically. That makes an MPP subscriber's identity
//     stronger than a tempo/charge payer (which is a client-supplied did:pkh we
//     never recover - see checkTempoCredentialBinding's payerHint comment).
//   - `mppx/server` exports `tempo.subscription()` (the activation method) and
//     `tempo.renewSubscription()` (the background biller).
//
// WHAT IT DOES NOT PROVIDE, contrary to a common description of this feature:
//   - `chargeModes: ["push","pull"]` is exported from `mppx/tempo` Methods but
//     belongs to tempo/CHARGE (`supportedModes` on the charge request). The
//     subscription request schema has no mode field at all. A subscription is
//     always PULL: the buyer signs a key authorization delegating one transfer
//     per period, and the SERVER pulls it.
//   - There is NO relay path for subscriptions. api.tempo.xyz's
//     /v1/mpp/validate + /v1/mpp/broadcast (what mpp-tempo.js rides for
//     tempo/charge) are wired by Relay.configure onto the charge method only.
//     A subscription charge is a `transferWithMemo` transaction signed by a
//     SERVER-HELD access key and broadcast straight to a Tempo RPC.
//
// SO THIS MODULE HOLDS A SIGNING KEY, and mpp-tempo.js's "we never hold a Tempo
// signing key" does not extend here. The key is tightly bounded by the buyer's
// own signature: the authorization scopes it to ONE token contract, ONE
// selector (transferWithMemo), ONE recipient (our payTo), a per-period LIMIT
// equal to the price, and an on-chain expiry. It cannot move anything else,
// anywhere else. It also holds no gas: the transaction is sent from the
// SUBSCRIBER's own account with the access key as the delegated signer, so the
// subscriber pays their own fees and we fund nothing.
//
// KEY LIFETIME. The key is held only while a later period can still be pulled.
// It is deleted from the store (both copies mppx keeps, found by content) the
// moment that stops being true: a cancel is stored (also while the paid period
// runs on, since a canceled subscription is never pulled again), the signed
// term runs out, dunning gives up, or a sweep closes the record. The house
// record of an ended subscription is reduced in the same step to the fields
// TOMBSTONE_FIELDS names (no email, no watched subject, no error text) and is
// deleted ENDED_RECORD_KEEP_MS after the end (src/mpp-subscription-retention.js)
// by a leased sweep, which also closes records whose end only the clock
// decides and reduces ended records written before this rule existed.
//
// BILLING PERIOD HANDLING (the money rules, all fail-closed):
//   - Activation charges period 0 on-chain at subscribe time. No confirmed
//     transfer, no subscriber record: an unpaid activation is simply a 402.
//   - Every later period is pulled by us, lazily, from refreshStatus() - which
//     the scheduler already calls BEFORE every paid run (the exact gate the
//     Stripe path uses). A period whose charge has not confirmed leaves the
//     subscription "past_due", which the scheduler reads as not-active, so no
//     paid report is produced. Free probes and change detection keep running.
//   - A failed charge is retried on a bounded schedule inside the grace
//     window (RENEWAL RETRIES below): a leased sweep pulls every past_due
//     record whose retry time has come, through the same refreshStatus a
//     scheduled run uses (its per-subscription lease, the period claim and the
//     chain check of an unconfirmed send), so a retry can never charge a
//     period twice. Only a retry that fails at or after the end of
//     PAST_DUE_GRACE_MS cancels the subscription as unpaid; it is then never
//     charged again.
//   - The paying wallet is screened (src/sanctions-screen.js: the exact OFAC
//     SDN match, then the one-hop funding check with its per-payer cache)
//     BEFORE the first payment is sent and BEFORE every renewal is signed,
//     never after. A refused first payment is a 402 with the answer the
//     per-call Tempo rail gives and nothing is sent. A refused renewal sends
//     nothing and ends the subscription (canceledReason "payer-not-accepted"),
//     so its key is destroyed like any other end. With no list loaded the
//     payment proceeds and is counted as unscreened, as the x402 payer screen
//     does; /api/gateway-status then reads sanctionsScreen missing.
//   - Cancellation is ours to honour, never ours to fake: the subscriber calls
//     cancel() with the manage token minted at activation, we stop pulling, and
//     the subscription stays active until the period they already paid for
//     runs out. The buyer can also revoke the access key on their own account
//     at any time, which makes the next pull fail and lands in past_due -> the
//     same fail-closed place.
//
// ROLLOUT SWITCH: MPP_SECRET_KEY (the HMAC secret the challenge binding rests
// on) + a Tempo recipient + the mppx subscription method being present. Any of
// those missing and nothing is offered: no route, no challenge, no store. Set
// MPP_SUBSCRIPTIONS=off to disarm it while the rest of the MPP stack stays up.
// Deliberately NOT gated on TEMPO_API_KEY: that key is the relay credential for
// tempo/charge, and no subscription call ever touches the relay.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { shortPayer } from "./verify-failure-log.js";
import { assertSigningAllowed } from "./signing-halt.js";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { leaseOwnerId, leased, stateDbEnabled, stateDbSchema, stateQuery, trackStoreReady, withLease } from "./state-db.js";
import { ENDED_RECORD_KEEP_MS, ENDED_SWEEP_INTERVAL_MS, ENDED_SWEEP_MAX_PER_RUN, CHALLENGE_TTL_MS, OFFER_SWEEP_AFTER_MS, OFFER_SWEEP_INTERVAL_MS, OFFER_SWEEP_FIRST_MS, OFFER_SWEEP_LEASE_TTL_MS } from "./mpp-subscription-retention.js";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Challenge, Credential, Method, Receipt } from "mppx";
import * as Tempo from "mppx/tempo";
import { tempo as tempoServer } from "mppx/server";
import { privateKeyToAccount } from "viem/accounts";
import { MONITOR_PRODUCTS, publicReceipts } from "./stripe-subscriptions.js";
import { appendPeriodReceipt } from "./receipt-signing.js";
import { usdToBaseUnits, usdToTokenDecimalString } from "./base-units.js";
import { redactSecrets } from "./tools/redact.js";
import { withSponsorCeiling, sponsorCeilingWord } from "./tempo-sponsor-ceiling.js";
import { screenAddresses, screenFunding, maskAddress, TEMPO_SCREEN_REFUSED_DETAIL } from "./sanctions-screen.js";

// Tempo mainnet. Same constant mpp-tempo.js pins; a subscription authorization
// commits to the chain id, so a mismatch is a rejected signature, not a
// silently-wrong charge.
export const TEMPO_MAINNET_CHAIN_ID = 4217;
// The two TIP-20 stablecoins Tempo ships. Duplicated from mpp-tempo.js on
// purpose: that module's accessors are gated on TEMPO_API_KEY (the relay key),
// which subscriptions do not need, so importing them would tie this rollout
// switch to an unrelated credential.
const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
const USDC_E_ADDRESS = "0x20C000000000000000000000b9537d11c60E8b50";

// A month is 30 days: mppx's periodUnit enum has no "month" (verified).
export const PERIOD_COUNT = 30;
export const PERIOD_UNIT = "day";

// ---------------------------------------------------------------------------
// The rail canary's own product. DELIBERATELY NOT in MONITOR_PRODUCTS, which is
// what makes it safe: listActive() skips any record whose product is not in
// that map, so a canary subscription can never reach the monitor scheduler, can
// never produce a paid report and can never send an email. It exists only to
// exercise the two on-chain halves of this rail against production.
//
// It is minted ONLY for a caller that proved the POW_SECRET-signed heartbeat
// token (server.js gates it), so it is not reachable by an outside buyer, and
// the same token keeps its settlements out of the external revenue series.
//
// The period is in mppx's `dev_second` unit, which is the whole reason a live
// renewal is provable at all: a 30-day period would put the pull half of this
// rail beyond any canary's reach, and the pull half - a server-held delegated
// key moving a buyer's money with no buyer present - is the half worth proving.
export const CANARY_PRODUCT_KEY = "rail-canary";
export const CANARY_PERIOD_SECONDS = Math.max(30, Number(process.env.MPP_SUB_CANARY_PERIOD_SECONDS) || 60);
export const CANARY_PRODUCT = {
  label: "MPP subscription rail canary",
  // One cent per period: two periods per run is the proof, and the money is
  // ours on both ends (canary burner -> our payTo), so the real cost is the
  // Tempo fee. Never below the smallest representable amount at our decimals.
  price: 1,
  kind: "canary",
  inputLabel: "a canary label",
};
/** MONITOR_PRODUCTS plus the canary product. The ONLY resolver that admits the
 *  canary; every product read that must stay real-products-only keeps using
 *  MONITOR_PRODUCTS directly. */
export function productDefFor(product) {
  const key = String(product ?? "");
  if (key === CANARY_PRODUCT_KEY) return CANARY_PRODUCT;
  return Object.hasOwn(MONITOR_PRODUCTS, key) ? MONITOR_PRODUCTS[key] : null;
}
/** True for the canary product only. */
export const isCanaryProduct = (product) => String(product ?? "") === CANARY_PRODUCT_KEY;
/** A canary run lasts at most its workflow's 10-minute timeout (one period,
 *  the renewal wait and the transient retry). A rail-canary record older than
 *  this is one the run never closed. */
export const CANARY_SWEEP_AFTER_MS = Number(process.env.MPP_CANARY_SWEEP_AFTER_MS) > 0 ? Number(process.env.MPP_CANARY_SWEEP_AFTER_MS) : 30 * 60 * 1000;
// How long the standing authorization is good for. The buyer signs this, so it
// is the hard ceiling on how long we could ever pull from them.
export const SUBSCRIPTION_TERM_MS = 365 * 24 * 60 * 60 * 1000;
// How long a minted subscribe challenge stays payable, and when an unpaid
// offer is swept: defined in src/mpp-subscription-retention.js, which /privacy reads.
export { CHALLENGE_TTL_MS, OFFER_SWEEP_AFTER_MS, OFFER_SWEEP_INTERVAL_MS, OFFER_SWEEP_FIRST_MS, OFFER_SWEEP_LEASE_TTL_MS };
// Dunning: a period that never clears within this window ends the subscription.
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const CHARGE_BACKOFF_MS = 60 * 60_000;
export const MAX_CHARGE_BACKOFF_MS = 24 * 60 * 60_000;
// A TRANSIENT charge failure retries in minutes, not an hour. Measured
// 2026-09-02 (tempo-subscription-canary run 33657453172): the renewal's
// transferWithMemo reached rpc.tempo.xyz's eth_estimateGas with its
// `validBefore` two seconds in the past - viem's Tempo chain config then
// stamped validBefore = now + 25 s on every request, and that minute our own
// tempo-volume run had the RPC answering in 7-20 s. The transfer never
// existed on chain, nobody was charged, and the next attempt an hour later
// would have succeeded - but an hour of past_due for a slow RPC is the wrong
// price, and for the canary it read as "the pull half of the rail is broken".
// A refused transfer (insufficient funds, revoked key) keeps the hour.
export const TRANSIENT_CHARGE_BACKOFF_MS = 2 * 60_000;

// RENEWAL RETRIES. A past_due subscription is not listed to the monitor
// scheduler (listActive lists active records only), so the scheduler's gate
// never pulls it again: the retry sweep below does. The schedule, counted from
// the first failed attempt of the episode (firstFailedAt):
//   - a transient (RPC or network) failure, for the first
//     TRANSIENT_RETRIES_MAX failures of the episode: 2, 4, then 6 minutes;
//   - any other failure (and a transient one after those): 1 h, doubling,
//     at most 24 h between attempts;
//   - no retry is ever placed past the end of the grace window: the last
//     one is placed AT firstFailedAt + PAST_DUE_GRACE_MS;
//   - a failure at or after that instant cancels the subscription (unpaid).
// So an episode makes at most about 15 attempts over 7 days, and ends either
// renewed (the first attempt that confirms) or canceled after the last one.
// Each attempt is one pull under the subscription's lease with the period
// claimed on the record first; a send whose landing is unknown is asked of the
// chain before any new signature (unconfirmedCharge), so no retry ever pays a
// period twice.
export const TRANSIENT_RETRIES_MAX = 3;
/** How often the retry sweep runs, and the most records one run pulls. */
export const RENEWAL_RETRY_SWEEP_MS = 5 * 60_000;
export const RENEWAL_RETRY_MAX_PER_RUN = 50;
/** When the attempt after the `failures`-th failed one is due (ms since the
 *  epoch), or null when the episode is over (the failure came at or after the
 *  end of the grace window). */
export function nextRenewalAttemptAt({ failures, transient, firstFailedAtMs, atMs }) {
  const graceEnd = firstFailedAtMs + PAST_DUE_GRACE_MS;
  if (atMs >= graceEnd) return null;
  const backoff = transient && failures <= TRANSIENT_RETRIES_MAX
    ? TRANSIENT_CHARGE_BACKOFF_MS * failures
    : Math.min(CHARGE_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_CHARGE_BACKOFF_MS);
  return Math.min(atMs + backoff, graceEnd);
}

/**
 * Hours a renewal may stay unconfirmed (a send whose landing the chain read
 * has not decided) before the subscriptionRenewals word reads unconfirmed.
 * Unset, blank or not a positive number: 3. 0 or "off": null (the word reads off).
 */
export const RENEWAL_UNCONFIRMED_ALERT_HOURS_DEFAULT = 3;
export function renewalUnconfirmedAlertHours(env = process.env) {
  const raw = String(env.MPP_SUB_UNCONFIRMED_ALERT_HOURS ?? "").trim();
  if (/^off$/i.test(raw)) return null;
  if (!raw) return RENEWAL_UNCONFIRMED_ALERT_HOURS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return RENEWAL_UNCONFIRMED_ALERT_HOURS_DEFAULT;
  return n === 0 ? null : n;
}

/**
 * The subscriptionRenewals word over a set of subscription records: off (the
 * alert disabled), unconfirmed (a record that is neither canceled nor expired
 * has carried the same unconfirmed renewal for longer than `hours`), ok.
 * Publicly { status }; the operator view adds the threshold, the count and the
 * oldest attempt time.
 */
export function renewalsWord(recs, { hours = renewalUnconfirmedAlertHours(), at = Date.now(), full = false } = {}) {
  if (hours == null) return full ? { status: "off", alertHours: null } : { status: "off" };
  let stuck = 0, oldest = null;
  for (const rec of recs || []) {
    if (!rec || rec.status === "canceled" || rec.status === "expired") continue;
    const since = Date.parse(rec.unconfirmedCharge?.at || "");
    if (!Number.isFinite(since) || at - since <= hours * 3_600_000) continue;
    stuck++;
    if (oldest == null || since < oldest) oldest = since;
  }
  const status = stuck ? "unconfirmed" : "ok";
  return full ? { status, alertHours: hours, unconfirmedCount: stuck, oldestAttemptAt: oldest == null ? null : new Date(oldest).toISOString() } : { status };
}
const TRANSIENT_CHARGE_RE = /transaction expired|validBefore|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|\b(?:429|502|503|504)\b|rate.?limit|temporarily unavailable|UND_ERR/i;
/** True when the failed charge looks like RPC/network trouble rather than a refused transfer. */
export function isTransientChargeError(err) {
  const seen = new Set();
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (typeof e !== "object" || seen.has(e)) break;
    seen.add(e);
    for (const k of ["details", "shortMessage", "message", "code", "name"]) {
      const v = e[k];
      if (v !== undefined && v !== null && TRANSIENT_CHARGE_RE.test(String(v))) return true;
    }
  }
  return typeof err === "string" && TRANSIENT_CHARGE_RE.test(err);
}

// A SEND-PHASE ambiguity is the one failure that can have moved money: the
// renewal's transferWithMemo was handed to the RPC (`eth_sendRawTransactionSync`
// waits for inclusion) and the answer never came back. Measured 2026-09-02
// (canary run 33659899394): "TimeoutError ... eth_sendRawTransactionSync" -
// the chain showed it never landed that time, but nothing in the path could
// know that, and mppx renews with Tempo's EXPIRING nonce (validBefore = now +
// the renewal window below), so a retry is a NEW transaction that would land beside an earlier one
// that did. Such a failure is remembered as `unconfirmedCharge` and the next
// pull first asks the CHAIN whether that period already settled
// (findRenewalOnChain) - exact, because every mppx renewal carries a memo
// bound to `renewal:<subscriptionId>:<period>` - before it signs anything.
const SEND_PHASE_RE = /sendRawTransactionSync|sendTransactionSync|eth_sendRawTransaction|waitForTransactionReceipt/i;
/** True when a failed charge may have been broadcast: the error names the send call and is network/timeout shaped. */
export function isSendPhaseAmbiguity(err) {
  if (!isTransientChargeError(err)) return false;
  const seen = new Set();
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (typeof e !== "object" || seen.has(e)) break;
    seen.add(e);
    for (const k of ["details", "shortMessage", "message", "metaMessages"]) {
      const v = e[k];
      if (v !== undefined && v !== null && SEND_PHASE_RE.test(Array.isArray(v) ? v.join("\n") : String(v))) return true;
    }
  }
  return false;
}
/** How far back the chain is read for an unconfirmed renewal, before the attempt time. A sent transaction can only land before its validBefore, which lies AFTER the attempt; the forward bound is `settleableUntil` below. */
export const UNCONFIRMED_LOOKBACK_MS = 60_000;

// VALIDITY WINDOW OF A SERVER-SIGNED TRANSACTION. Both subscription sends
// (activation and renewal) are mppx `prepareTransactionRequest(client, {...,
// nonceKey: "expiring"})` calls with no validBefore, so the window is whatever
// the client's chain hook stamps. viem's stock Tempo chain stamps its own
// default and has changed it (25 s through 2.57.13, 270 s from 2.57.16), and
// the protocol rejects anything past now + 300 s (Tempo T11, TIP-1093; viem
// `Transaction.expiringNonceMaxExpiry`). An expiring-nonce transaction has no
// sequence number, so a retry is a NEW transaction and an earlier one stays
// includable until its validBefore. Neither window may follow viem's default:
// each client's chain hook stamps validBefore first (`withRenewalValidity`).
// - Renewal: 120 s by default. A renewal that met a slow RPC on 2026-09-02
//   expired between signing and eth_estimateGas at 25 s, and a timed-out
//   renewal is reconciled against the chain until `settleableUntil` (built
//   from this same window), so a longer window only lengthens that wait.
// - Activation: 25 s, which must stay under the RPC timeout. A failed
//   activation answers "Nothing was charged; request a fresh challenge", and
//   nothing reconciles it, so a send that timed out must already be unable to
//   land when the error surfaces. validBefore is fixed before the send, and
//   the sync send is cut off TEMPO_RPC_TIMEOUT_MS (30 s) after it started.
//   On viem's 270 s default a timed-out activation could land minutes after
//   that answer, beside the buyer's retry.
// Buyer-side charge credentials are untouched: mppx's charge client names
// its own validBefore (25 s) and never sees these clients.
export const ACTIVATION_VALID_FOR_S = 25;      // under TEMPO_RPC_TIMEOUT_MS; 10 s above the sponsor's 15 s minimum remaining validity
export const RENEWAL_VALID_FOR_DEFAULT_S = 120;
export const RENEWAL_VALID_FOR_MAX_S = 240;   // under the protocol's 300 s cap, with 60 s for clock skew
export const RENEWAL_VALID_FOR_MIN_S = ACTIVATION_VALID_FOR_S; // never shorter than the window a slow RPC already beat
/** TEMPO_SUBSCRIPTION_VALID_FOR_S, clamped to [25, 240]; unset or malformed -> 120. */
export function renewalValidForSeconds(raw = process.env.TEMPO_SUBSCRIPTION_VALID_FOR_S) {
  const txt = String(raw ?? "").trim();
  if (!/^\d+$/.test(txt)) return RENEWAL_VALID_FOR_DEFAULT_S;
  const n = Number(txt);
  if (!Number.isSafeInteger(n) || n <= 0) return RENEWAL_VALID_FOR_DEFAULT_S;
  return Math.min(RENEWAL_VALID_FOR_MAX_S, Math.max(RENEWAL_VALID_FOR_MIN_S, n));
}
const MAX_UINT256 = 2n ** 256n - 1n;
/**
 * A copy of a viem chain whose prepareTransactionRequest hook stamps an
 * expiring-nonce request with validBefore = now + `seconds` before viem's own
 * hook runs, so viem's default window never applies (viem then keeps it: it
 * only fills an undefined validBefore). A request that already names
 * validBefore, or does not use the expiring nonce, passes through untouched.
 */
export function withRenewalValidity(chain, seconds, nowMs = () => Date.now()) {
  const hook = chain?.prepareTransactionRequest;
  const [fn, opts] = Array.isArray(hook) ? hook : typeof hook === "function" ? [hook, { runAt: ["beforeFillTransaction"] }] : [null, null];
  if (!fn) throw new Error("chain has no prepareTransactionRequest hook to extend");
  const wrapped = async (r, ctx) => {
    const expiring = r && (r.nonceKey === "expiring" || r.nonceKey === MAX_UINT256 || (r.feePayer && r.nonceKey === undefined));
    const req = expiring && r.validBefore === undefined ? { ...r, validBefore: Math.floor(nowMs() / 1000) + seconds } : r;
    return fn(req, ctx);
  };
  return { ...chain, prepareTransactionRequest: [wrapped, opts] };
}
/** Extra time past the validity window before an unconfirmed send is treated as unable to land. */
export const SETTLEABLE_SLACK_MS = 30_000;
/** viem's default request timeout is 10 s; a sync send waits for inclusion and the RPC was answering in 7-20 s on 2026-09-02. */
export const TEMPO_RPC_TIMEOUT_MS = Number(process.env.TEMPO_SUBSCRIPTION_RPC_TIMEOUT_MS) > 0 ? Number(process.env.TEMPO_SUBSCRIPTION_RPC_TIMEOUT_MS) : 30_000;

/**
 * The bytes32 memo mppx stamps on a renewal transfer (tempo/Attribution.js,
 * reproduced here because the package does not export it): keccak("mpp")[0..4]
 * + version 0x01 + keccak(lookupKey)[0..10] + 10 zero bytes (no clientId) +
 * keccak(`renewal:<subscriptionId>:<period>`)[0..7]. Matching the whole memo
 * is what makes the chain check EXACT: an activation, a different period or a
 * different subscription from the same buyer for the same amount never matches.
 */
export async function expectedRenewalMemo({ lookupKey, subscriptionId, periodIndex }) {
  const { keccak256, stringToBytes, hexToBytes, bytesToHex } = await import("viem");
  const k = (str, n) => hexToBytes(keccak256(stringToBytes(String(str)))).slice(0, n);
  const buf = new Uint8Array(32);
  buf.set(k("mpp", 4), 0);
  buf[4] = 0x01;
  buf.set(k(lookupKey, 10), 5);
  buf.set(k(`renewal:${subscriptionId}:${periodIndex}`, 7), 25);
  return bytesToHex(buf);
}

/** Blocks per getLogs request when the chain is searched for an unconfirmed renewal. */
export const RENEWAL_SCAN_CHUNK_BLOCKS = 5000n;
/** Past this many blocks the search answers "unknown" (wait), never "not found". */
export const RENEWAL_SCAN_MAX_BLOCKS = 200_000n;

/**
 * Decides whether one transaction is THIS renewal: "match" | "no" |
 * "unknown" | "fallback" (the receipt carries no TransferWithMemo from the
 * currency, so call again with `tx`). Order of evidence: the receipt's
 * TransferWithMemo log from the currency (token, from, to, amount and memo all
 * equal, the same proof mppx itself requires), then the transaction's
 * `calls[]` (Tempo 0x76: each call to the currency), then a legacy `input`.
 * An unreadable receipt or a shape it does not know is "unknown", never "no".
 */
export async function classifyRenewalEvidence({ receipt, tx, currency, payer, recipient, amount, memo }) {
  const { decodeEventLog, decodeFunctionData, parseAbi } = await import("viem");
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (!receipt || !Array.isArray(receipt.logs)) return "unknown";
  if (receipt.status === "reverted") return "no";
  if (receipt.status !== "success") return "unknown";
  const evAbi = parseAbi(["event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)"]);
  let sawMemoLog = false;
  for (const l of receipt.logs) {
    if (!same(l?.address, currency)) continue;
    let ev = null;
    try { ev = decodeEventLog({ abi: evAbi, data: l.data, topics: l.topics }); } catch { ev = null; }
    if (ev?.eventName !== "TransferWithMemo") continue;
    sawMemoLog = true;
    const a = ev.args;
    if (same(a.from, payer) && same(a.to, recipient) && a.amount === amount && same(a.memo, memo)) return "match";
  }
  if (sawMemoLog) return "no";
  if (tx === undefined) return "fallback";
  if (!tx || typeof tx !== "object") return "unknown";
  const fnAbi = parseAbi(["function transferWithMemo(address to, uint256 amount, bytes32 memo)", "function transfer(address to, uint256 amount)"]);
  const judge = (data) => {
    let d = null;
    try { d = decodeFunctionData({ abi: fnAbi, data }); } catch { return "unknown"; }
    if (d.functionName !== "transferWithMemo") return "no";
    const [to, value, m] = d.args;
    return same(to, recipient) && value === amount && same(m, memo) ? "match" : "no";
  };
  if (Array.isArray(tx.calls)) {
    let verdict = "no";
    for (const c of tx.calls) {
      if (!same(c?.to, currency)) continue;
      const v = judge(c.data ?? c.input);
      if (v === "match") return "match";
      if (v === "unknown") verdict = "unknown";
    }
    return verdict;
  }
  if (typeof tx.input === "string" && tx.input !== "0x" && same(tx.to, currency)) return judge(tx.input);
  return "unknown";
}
// Every unpaid 402 mints and PERSISTS a server-owned access key, so an
// unauthenticated caller can grow the shared offer store by asking for
// offers it never pays. Bounded two ways: unclaimed offers are swept once their
// challenge can no longer be paid, and minting refuses outright past the cap
// (the disk-fill guard, same posture as the memory namespace byte budget).
// (OFFER_SWEEP_AFTER_MS and the sweep timer: src/mpp-subscription-retention.js.)
export const MAX_OPEN_OFFERS = 500;
/** How long the offer sweep runs before it gives the event loop a turn. */
export const OFFER_SWEEP_SLICE_MS = 20;
/** How long one container's pull of a subscription's due period holds the
 *  cross-container lease (renewed while it runs): longer than a sync send
 *  can take, short enough that a crashed holder frees it. */
export const RENEWAL_LEASE_TTL_MS = 10 * 60_000;

/**
 * What an ended subscription's record keeps (the reduced record): its id,
 * product and final state, the paying wallet, the dates, and what a question
 * about its last charge reads (amount, period, last transaction, a send whose
 * landing was never decided). The access key ADDRESS stays so the subscriber
 * can revoke it on their account; our private half is gone. Not kept: the
 * email, the watched subject, error text, dunning and claim state.
 */
export const TOMBSTONE_FIELDS = Object.freeze([
  "subId", "status", "product", "createdAt", "rail", "wire", "canary",
  "mppxSubscriptionId", "lookupKey", "payer", "accessKeyAddress",
  "currency", "chainId", "amountAtomic", "priceUsd", "periodCount", "periodUnit",
  "billingAnchor", "lastChargedPeriod", "subscriptionExpires", "lastChargeTx", "lastChargeAt", "unconfirmedCharge",
  "cancelAtPeriodEnd", "canceledAt", "canceledReason",
]);
/** The canceledReason of a subscription a refused renewal ended (the word the
 *  x402 payer screen answers with). Its status answer carries the refusal text. */
export const SCREEN_ENDED_REASON = "payer-not-accepted";
const SUB_PREFIX = "mpp_";                       // our subscription ids
const REC_KEY = (subId) => `a402:sub:${subId}`;      // our records inside the shared kv
const OFFER_KEY = (nonce) => `a402:offer:${nonce}`;  // an open, unpaid offer

function envRecipient() {
  return (process.env.TEMPO_RECIPIENT_ADDRESS || process.env.WALLET_ADDRESS || "").trim();
}
function envCurrency() {
  const raw = (process.env.TEMPO_CURRENCY || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || PATH_USD_ADDRESS;
  const c = raw.toLowerCase() === "usdc" ? USDC_E_ADDRESS : raw.toLowerCase() === "pathusd" ? PATH_USD_ADDRESS : raw;
  return c;
}
/**
 * THE GAS SPONSOR, and why this rail cannot run without one.
 *
 * A Tempo subscription charge is signed and broadcast straight to an RPC with
 * no relay in the path, so nothing sponsors its gas the way api.tempo.xyz
 * sponsors a tempo/charge. mppx has two code paths for that transaction and
 * they are not equivalent: WITH a fee payer it builds the transaction through
 * `prepareTransactionRequest`, which populates gas and fee fields; WITHOUT one
 * it calls `signTransaction` on a bare request that carries none. viem does not
 * fill them in, so the unsponsored transaction is signed with a ZERO gas price
 * and Tempo rejects it - measured live against production, three runs, every
 * one `-32000 gas price is less than basefee` (basefee 0.6 gwei), and pinned at
 * the byte level: the serialized transaction reads `821079 80 80 80`, i.e.
 * chainId 4217 followed by three empty fee fields.
 *
 * So the unsponsored path can never settle on a chain with a non-zero basefee.
 * mppx's fee-payer URL form (a sponsorship service) is wired for tempo/CHARGE
 * only - `Subscription.createContext` reads `feePayer` and never `feePayerUrl` -
 * so a URL is not an option here and an ACCOUNT is required.
 *
 * `TEMPO_SUBSCRIPTION_FEE_PAYER_KEY` is that account: a dedicated Tempo wallet
 * holding gas, NEVER the treasury and never the CI burner. We pay the gas for
 * every activation and every renewal, which is the honest description of this
 * rail: the earlier note that "the tx sends from THEIR account so they pay
 * their own gas" was wrong about who funds it.
 */
/**
 * Gas ceiling for a sponsored subscription transaction.
 *
 * mppx's default fee-payer policy caps `maxGas` at 2,000,000, and its own docs
 * point at this override "when the access key renewal tx requires more gas than
 * the default policy allows". An ACTIVATION does more than a renewal: it
 * installs the access key as well as moving the first period, and a plain
 * transferWithMemo already costs 46,575 gas measured on-chain, so the 2M default
 * is the wrong shape for the activation leg.
 *
 * 6,000,000 is deliberately generous rather than tuned, because the gas ceiling
 * is NOT the money bound here - `maxTotalFee` is. Fees settle in USDC.e (the
 * receipt's `feeToken`), and mppx's untouched `maxTotalFee` still refuses an
 * outsized fee however far the gas price moves.
 *
 * The ~4M figure for an access-key install is an UNVERIFIED note carried in
 * project docs, not something measured here, which is the other reason to leave
 * headroom instead of pinning the number to it.
 */
export const SUB_FEE_PAYER_MAX_GAS = 6_000_000n;
export function subscriptionFeePayerPolicy() {
  const raw = (process.env.MPP_SUB_FEE_PAYER_MAX_GAS || "").trim();
  let maxGas = SUB_FEE_PAYER_MAX_GAS;
  if (raw) {
    try {
      const v = BigInt(raw);
      if (v > 0n) maxGas = v;
    } catch { /* keep the default: a malformed knob must never widen or void the policy */ }
  }
  return { maxGas };
}

/**
 * Low-water status for the gas sponsor, for `/api/gateway-status` + heartbeat.
 *
 * Watches PATHUSD, not USDC.e, and that distinction is the whole point: a
 * sponsored transaction pays its fee in Tempo's default token, so a sponsor
 * holding plenty of USDC.e and no PathUSD is EMPTY for this purpose and the
 * chain reports it as `insufficient funds ... have 0`. Funding the wrong token
 * is the mistake this alarm exists to catch, because it looks identical to
 * having no wallet at all.
 *
 * An empty sponsor does not error loudly: activations fail 402 (nobody is
 * charged, fine) but RENEWALS just go past_due, which means existing
 * subscribers are served for FREE until their grace window ends. That is a
 * silent revenue leak, hence a balance alarm rather than relying on the canary.
 *
 * Unreadable is "unknown", never "ok" - the same rule the gateway balance
 * follows, because a balance we cannot read is its own alarm.
 */
export async function subscriptionFeePayerStatus() {
  const acct = subscriptionFeePayer();
  if (!acct) return { status: "unconfigured" };
  const low = Number(process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_LOW_USD ?? 0.25);
  const rpcUrl = (process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz").trim();
  try {
    const data = "0x70a08231" + acct.address.toLowerCase().slice(2).padStart(64, "0");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let hex;
    try {
      const res = await fetch(rpcUrl, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PATH_USD_ADDRESS, data }, "latest"] }),
      });
      const j = await res.json();
      hex = j?.result;
    } finally { clearTimeout(t); }
    if (typeof hex !== "string" || !hex.startsWith("0x")) return { status: "unknown", ceiling: await sponsorCeilingWord(), asset: "PathUSD", chain: `eip155:${TEMPO_MAINNET_CHAIN_ID}` };
    const usd = Number(BigInt(hex)) / 1e6;
    // Bucketed, never the number: this rides a PUBLIC surface.
    return { status: usd < low ? "low" : "ok", ceiling: await sponsorCeilingWord(), asset: "PathUSD", chain: `eip155:${TEMPO_MAINNET_CHAIN_ID}` };
  } catch {
    return { status: "unknown", ceiling: await sponsorCeilingWord(), asset: "PathUSD", chain: `eip155:${TEMPO_MAINNET_CHAIN_ID}` };
  }
}

export function subscriptionFeePayer() {
  const raw = (process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY || "").trim();
  if (!raw) return null;
  try { return privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`); }
  catch { return null; }
}

function envDecimals() {
  const n = Number(process.env.TEMPO_DECIMALS);
  return Number.isInteger(n) && n >= 0 ? n : 6;
}
/** Is the mppx build we are actually running able to do this at all? Feature
 *  detection, never a version string: a version number is a claim, an export is
 *  a fact. */
export function mppSubscriptionMethodAvailable() {
  return Boolean(
    Tempo?.Methods?.subscription &&
    typeof Tempo?.Subscription?.verifySubscriptionKeyAuthorization === "function" &&
    typeof Tempo?.Subscription?.fromStore === "function" &&
    typeof Tempo?.Subscription?.toSubscriptionPeriodSeconds === "function" &&
    typeof tempoServer?.subscription === "function" &&
    typeof tempoServer?.renewSubscription === "function"
  );
}
/**
 * Configured: the env asks for the rail (MPP_SUBSCRIPTIONS not off, a secret,
 * a Tempo recipient, a usable fee payer), whatever the installed mppx offers.
 * Call-time read. A configured rail whose method is missing reads failed on
 * /api/gateway-status (buildMppSubscriptionsEngine), never off.
 */
export function mppSubscriptionsConfigured() {
  if (String(process.env.MPP_SUBSCRIPTIONS || "").toLowerCase() === "off") return false;
  if (!(process.env.MPP_SECRET_KEY || "").trim()) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(envRecipient())) return false;
  // No sponsor, no rail. Without a fee payer every subscribe attempt is signed
  // with a zero gas price and refused by the chain, so mounting the routes
  // would advertise a product we provably cannot deliver - the endpoint would
  // 402 forever and the offer would be a lie. See subscriptionFeePayer().
  if (!subscriptionFeePayer()) return false;
  return true;
}
/** Rollout switch: configured, and the installed mppx has the method. Call-time read. */
export function mppSubscriptionsEnabled() {
  return mppSubscriptionsConfigured() && mppSubscriptionMethodAvailable();
}

/** The period length mppx itself computes from our period fields, in ms. Read
 *  from mppx so our accounting can never drift from the number the buyer's
 *  signature actually committed to. */
export function periodMs(periodCount = PERIOD_COUNT, periodUnit = PERIOD_UNIT) {
  return Tempo.Subscription.toSubscriptionPeriodSeconds({ periodCount: String(periodCount), periodUnit }) * 1000;
}

// ---------------------------------------------------------------------------
// Store. ONE JSON document holds both mppx's own key-value entries (access
// keys, subscription records, activation locks - all under mppx's own
// prefixes) and our house subscriber records under `a402:sub:`. Without a
// state database it is a file (same atomic tmp+rename and merge-on-save
// discipline as stripe-subscriptions.js); with one (STATE_DATABASE_URL) the
// same document lives in the database, imported from the file once at the
// first load, and the file is kept current by write-through. Prod runs one
// replica, so this is single-writer in practice; it is written to survive two.
// ---------------------------------------------------------------------------
const STORE_PATH = () => join(existsSync("/data") ? "/data" : "/tmp", "mpp-subscriptions.json");

function readFile(path) {
  try { const v = JSON.parse(readFileSync(path, "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
/** An mppx Store.AtomicStore (get/put/delete/update) over a JSON file.
 *  `update` must be synchronous and side-effect free per mppx's contract; it is. */
export function createFileStore(path) {
  let mem = readFile(path);
  let dirty = new Set();
  const flush = () => {
    try {
      const disk = readFile(path);
      for (const k of dirty) { if (k in mem) disk[k] = mem[k]; else delete disk[k]; }
      dirty = new Set();
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(disk));
      renameSync(tmp, path);
      mem = disk;
    } catch { /* best effort, same posture as the other file stores here */ }
  };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    async get(key) { return key in mem ? clone(mem[key]) : null; },
    async put(key, value) { mem[key] = clone(value); dirty.add(key); flush(); },
    async delete(key) { delete mem[key]; dirty.add(key); flush(); },
    async update(key, fn) {
      const change = fn(key in mem ? clone(mem[key]) : null);
      if (change.op === "set") { mem[key] = clone(change.value); dirty.add(key); flush(); }
      else if (change.op === "delete") { delete mem[key]; dirty.add(key); flush(); }
      return change.result;
    },
    /** One process holds the file: the map is the fresh copy. */
    async getFresh(key) { return key in mem ? clone(mem[key]) : null; },
    async refreshAll() { return true; },
    /** `decide(current)` returns the new value, or null to leave it; resolves { won, value }. */
    async compareAndSet(key, decide) {
      const next = decide(key in mem ? clone(mem[key]) : null);
      if (next == null) return { won: false, value: key in mem ? clone(mem[key]) : null };
      mem[key] = clone(next); dirty.add(key); flush();
      return { won: true, value: clone(next) };
    },
    // Test/ops visibility only. Never used for money decisions. `_snapshot`
    // exists so the engine can warm its synchronous read cache at construction:
    // the file was already read synchronously, and the scheduler calls
    // listActive()/get() synchronously, so there must be no boot window where a
    // paid-up subscriber is invisible.
    _keys: () => Object.keys(mem),
    _snapshot: () => JSON.parse(JSON.stringify(mem)),
    /** Same surface as the database store: the file was read at construction. */
    _ready: Promise.resolve(),
    backend: "file",
    async flush() {},
  };
}

/**
 * The same AtomicStore over the state database: the whole document is one
 * row (src/json-document.js, named after the file, imported from it once),
 * and this process keeps an in-memory map of it. Reads answer from the map,
 * which the first load fills (`_ready`, registered with trackStoreReady so
 * the server awaits it before listening) and every put/delete/update keeps
 * current. Writes merge the touched keys into the row (merge-on-save, so two
 * containers writing different keys never overwrite each other), one queue
 * per store so they land in call order; put and delete resolve once their
 * key is in the row and THROW when it is not, because a house record that
 * carries `unconfirmedCharge` must be durable before the next pull can rely
 * on it. A failed write leaves its keys dirty and the next write re-sends
 * them. `update` applies to the map synchronously (mppx's contract: its
 * callback is synchronous and side-effect free; the map is the only state it
 * sees) and queues the write. Cross-container atomicity of a single update
 * is NOT provided, exactly as the file never provided it: mppx's activation
 * locks guard one HTTP request, which one container serves.
 *
 * Two containers overlap during a deploy, so the map is never the authority
 * for a key another container may have written: get() reads the key from the
 * row (a key with a write of ours still queued answers from the map, which
 * outranks the row for it), getFresh() does the same and throws when the row
 * cannot be read, refreshAll() re-reads the whole row into the map, and
 * compareAndSet() is a versioned read-modify-write of one key, which is how
 * a renewal claims its period.
 */
export function createDbStore(path, { log = console.warn } = {}) {
  const doc = createJsonDocument({ file: path, log });
  let mem = {};
  // key -> sequence of its newest unflushed write (a delete marks the key
  // absent from `mem`); the sequence tells a waiter whether ITS write landed
  // or only a later one re-dirtied the key.
  const dirty = new Map();
  let seq = 0;
  let chain = Promise.resolve();
  const say = (m) => { try { log(`[mpp-subs] store: ${m}`); } catch { /* logging never throws */ } };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  // One key straight from the row (JSONB path), so a key the other container
  // wrote is seen without reading the whole document.
  async function readKey(key) {
    const r = await stateQuery(`SELECT body -> $2 AS v FROM ${stateDbSchema()}.documents WHERE name = $1`, [doc.name, String(key)]);
    return r.rows[0] ? (r.rows[0].v ?? null) : null;
  }
  const adopt = (key, v) => { if (v === null || v === undefined) delete mem[key]; else mem[key] = v; };
  const _ready = trackStoreReady(doc.load(null).then((body) => {
    const loaded = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    // A write made before the row arrived outranks the row for its key.
    for (const [k, v] of Object.entries(loaded)) if (!dirty.has(k)) mem[k] = v;
  }).catch((e) => { say(`first load failed: ${String(e?.message || e).slice(0, 120)}`); }));

  // One flush per queued step; a step after one that already sent every
  // dirty key finds nothing to do. Never rejects: a waiter reads `dirty`.
  function flushDirty() {
    chain = chain.then(async () => {
      if (!dirty.size) return;
      const sent = new Map(dirty);
      const patch = {}; const drop = [];
      for (const [k] of sent) { if (k in mem) patch[k] = mem[k]; else drop.push(k); }
      const body = await doc.mergeKeys(patch, drop);
      if (body === null) { say(`write of ${sent.size} key(s) failed: ${String(doc.lastError || "").slice(0, 120)}; kept dirty for the next write`); return; }
      for (const [k, n] of sent) if (dirty.get(k) === n) dirty.delete(k);
    }).catch((e) => { say(`write failed: ${String(e?.message || e).slice(0, 120)}`); });
    return chain;
  }
  async function write(key, apply) {
    apply();
    const mine = ++seq;
    dirty.set(key, mine);
    await flushDirty();
    const left = dirty.get(key);
    if (left !== undefined && left <= mine) throw new Error(`subscription store write did not land: ${String(doc.lastError || "database write failed").slice(0, 120)}`);
  }
  return {
    async get(key) {
      if (!dirty.has(key)) {
        try { adopt(key, await readKey(key)); }
        catch (e) { say(`read of one key failed, answering from memory: ${String(e?.message || e).slice(0, 120)}`); }
      }
      return key in mem ? clone(mem[key]) : null;
    },
    async getFresh(key) {
      if (dirty.has(key)) { await flushDirty(); if (dirty.has(key)) throw new Error("subscription store write did not land"); }
      adopt(key, await readKey(key));
      return key in mem ? clone(mem[key]) : null;
    },
    /** Re-read the whole row into the map (keys with a queued write of ours keep it). False when unreadable. */
    async refreshAll() {
      const r = await doc.read();
      if (!r.ok) return false;
      const body = r.exists && r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
      for (const k of Object.keys(mem)) if (!dirty.has(k) && !Object.hasOwn(body, k)) delete mem[k];
      for (const [k, v] of Object.entries(body)) if (!dirty.has(k)) mem[k] = v;
      return true;
    },
    async compareAndSet(key, decide) {
      if (dirty.has(key)) { await flushDirty(); if (dirty.has(key)) throw new Error("subscription store write did not land"); }
      const r = await doc.update((b) => {
        const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
        const next = decide(Object.hasOwn(body, key) ? clone(body[key]) : null);
        if (next == null) return SKIP_UPDATE;
        body[key] = clone(next);
        return body;
      }, { fallback: {} });
      if (!r.ok) throw new Error(`subscription store claim failed: ${String(r.error || "").slice(0, 120)}`);
      const cur = r.body && Object.hasOwn(r.body, key) ? r.body[key] : null;
      if (!dirty.has(key)) adopt(key, cur);
      return { won: r.changed === true, value: clone(cur) };
    },
    put(key, value) { return write(key, () => { mem[key] = clone(value); }); },
    delete(key) { return write(key, () => { delete mem[key]; }); },
    // Synchronous over the map up to the queued write (no await before it),
    // which the next awaited put or delete also waits for.
    async update(key, fn) {
      const change = fn(key in mem ? clone(mem[key]) : null);
      if (change.op === "set") { mem[key] = clone(change.value); dirty.set(key, ++seq); void flushDirty(); }
      else if (change.op === "delete") { delete mem[key]; dirty.set(key, ++seq); void flushDirty(); }
      return change.result;
    },
    _keys: () => Object.keys(mem),
    _snapshot: () => JSON.parse(JSON.stringify(mem)),
    _ready,
    backend: "pg",
    /** Resolves once every queued write has been attempted (tests, shutdown). */
    async flush() { await chain; },
    get lastError() { return doc.lastError; },
  };
}

/** The marker a destroyed access key leaves behind (lowercase address). */
export const KEY_GONE_PREFIX = "a402:keygone:";
/** How long a marker is kept: far past any renewal's lease. */
const KEY_GONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const isKeyRecord = (v) => !!v && typeof v === "object" && typeof v.privateKey === "string";
const keyAddrOf = (v) => String(v?.accessKeyAddress || "").toLowerCase();

/**
 * The store view handed to mppx. mppx 0.17 reads an access key before it
 * signs a renewal and writes it back (retainAccessKey: under the lookup key
 * and under the address) once the transfer is sent, seconds later. A cancel
 * or sweep that destroyed the key in between leaves a marker first
 * (destroyAccessKey), and a private-key record for a marked address is not
 * written: put checks before and after its write (a destroy that ran in
 * between is undone), update after. Every other key passes untouched.
 */
export function guardDestroyedKeys(kv) {
  const gone = async (v) => {
    if (!isKeyRecord(v)) return false;
    const a = keyAddrOf(v);
    return /^0x[0-9a-f]{40}$/.test(a) && !!(await kv.get(`${KEY_GONE_PREFIX}${a}`));
  };
  const view = Object.create(kv);
  view.put = async (key, value) => {
    if (await gone(value)) return;
    await kv.put(key, value);
    if (await gone(value)) await kv.delete(key);
  };
  view.update = async (key, fn) => {
    let wrote = null;
    const result = await kv.update(key, (cur) => {
      const change = fn(cur);
      if (change?.op === "set") wrote = change.value;
      return change;
    });
    if (wrote && (await gone(wrote))) await kv.delete(key);
    return result;
  };
  return view;
}

/** The store for this process: the database when STATE_DATABASE_URL is set, the file otherwise. */
export function createSubscriptionStore(path, { log = console.warn } = {}) {
  return stateDbEnabled() ? createDbStore(path, { log }) : createFileStore(path);
}

// ---------------------------------------------------------------------------
// Challenge binding. Same discipline as checkTempoCredentialBinding in
// mpp-tempo.js, and for the same reason mppx's own docs give: validating a
// credential does NOT prove the challenge was issued by us, so the host must
// check that binding itself, BEFORE anything mutating or anything that costs
// money. Pure, synchronous, never throws. Exported for tests.
//
// One extra rule this needs that the charge gate does not: a subscription
// challenge names an ACCESS KEY, and the whole security of the recurring pull
// rests on that key being OURS. `verifySubscriptionKeyAuthorization` will
// happily fall back to the credential's own echoed accessKey when it is not
// given one (measured: it accepts a signature over any attacker-chosen key),
// so the caller must pass the key it holds the private half of. We bind it here
// and look the private key up by address before charging.
// ---------------------------------------------------------------------------
export function checkSubscriptionBinding(authorizationHeader, { secretKey, realm, now = Date.now() } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  let credential;
  try { credential = Credential.deserialize(authorizationHeader); } catch { return bad("credential does not deserialize"); }
  const ch = credential?.challenge;
  if (!ch || ch.method !== "tempo" || ch.intent !== "subscription") return bad("not a tempo/subscription challenge");
  if (!secretKey) return bad("server has no MPP_SECRET_KEY - cannot verify the challenge binding");
  let verified = false;
  try { verified = Challenge.verify(ch, { secretKey }); } catch { verified = false; }
  if (!verified) return bad("challenge id does not HMAC-verify - not minted by this server");
  if (realm && ch.realm !== realm) return bad(`challenge realm ${JSON.stringify(ch.realm)} is not ours`);
  const exp = Date.parse(ch.expires);
  if (!Number.isFinite(exp) || exp <= now) return bad("challenge expired");
  if (credential?.payload?.type !== "keyAuthorization" || typeof credential?.payload?.signature !== "string") {
    return bad("credential payload is not a tempo subscription keyAuthorization");
  }
  const r = ch.request || {};
  if (String(r.currency || "").toLowerCase() !== envCurrency().toLowerCase()) return bad("challenge currency is not the one this server bills in");
  if (String(r.recipient || "").toLowerCase() !== envRecipient().toLowerCase()) return bad("challenge recipient is not this server's payTo");
  const chainId = Number(r.methodDetails?.chainId ?? r.chainId);
  if (chainId !== TEMPO_MAINNET_CHAIN_ID) return bad(`challenge chainId ${chainId} is not Tempo mainnet`);
  const accessKeyAddress = String(r.methodDetails?.accessKey?.accessKeyAddress || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(accessKeyAddress)) return bad("challenge names no server access key");

  // `meta` does not survive the wire and, more importantly, is NOT what the
  // HMAC covers: Challenge.verify hashes `opaque`, and a challenge whose meta
  // object was rewritten in place still verifies (measured). So the product and
  // target are read back from `opaque`, which IS covered - a buyer cannot point
  // a $3 subscription at a different product or target.
  let meta = null;
  try { meta = JSON.parse(Buffer.from(String(ch.opaque || ""), "base64url").toString("utf8")); } catch { meta = null; }
  if (!meta || typeof meta !== "object") return bad("challenge carries no bound product metadata");
  const product = String(meta.product || "");
  const p = productDefFor(product);
  if (!p) return bad("challenge names no known monitor product");
  const target = String(meta.target || "");
  if (!target) return bad("challenge names no monitor target");

  // The period is bound to the PRODUCT, not chooseable by the buyer: every real
  // product bills 30/day and the rail canary bills in dev_second. This check
  // MUST sit after the product is read back from the HMAC-covered `opaque`
  // above, so the expected period comes from something the buyer cannot rewrite
  // - a buyer still cannot retarget a real subscription onto a shorter period.
  const wantCount = p === CANARY_PRODUCT ? String(CANARY_PERIOD_SECONDS) : String(PERIOD_COUNT);
  const wantUnit = p === CANARY_PRODUCT ? "dev_second" : PERIOD_UNIT;
  if (String(r.periodUnit) !== wantUnit || String(r.periodCount) !== wantCount) {
    return bad(`challenge billing period ${r.periodCount}/${r.periodUnit} is not the one this server bills this product on`);
  }

  // The price binding, exactly as the charge gate does it: a legitimately
  // minted challenge for one product must not buy a dearer one.
  const decimals = envDecimals();
  const expected = usdToBaseUnits(p.price / 100, decimals);
  let amount;
  try { amount = BigInt(String(r.amount)); } catch { return bad("challenge amount is not an integer base-units string"); }
  if (amount < expected) return bad(`challenge amount ${amount} is below this product's price ${expected}`);

  const subExpires = Date.parse(r.subscriptionExpires);
  if (!Number.isFinite(subExpires) || subExpires <= now) return bad("subscription term has already ended");

  return { ok: true, challenge: ch, credential, product, productDef: p, target, email: typeof meta.email === "string" ? meta.email : null, accessKeyAddress: accessKeyAddress.toLowerCase(), amountAtomic: amount, expectedAtomic: expected, subscriptionExpires: new Date(subExpires).toISOString() };
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {string} deps.secretKey     MPP_SECRET_KEY - mints and verifies challenge ids AND manage tokens
 * @param {string} deps.realm         our host, bound into every challenge
 * @param {string} [deps.storePath]
 * @param {object} [deps.validateTarget]  same shape as stripe-subscriptions.js: kind -> normalizer that throws a 4xx
 * @param {(a:object)=>void} [deps.onCharge]   accounting hook, called once per CONFIRMED period transfer
 * @param {function} [deps.activate]  injected activation charge (tests); default settles on-chain via mppx
 * @param {function} [deps.chargePeriod] injected renewal charge (tests); default is mppx's renewSubscription
 * @param {object} [deps.refunds]   the refund ledger calls (recordOwed, voidForServe, reopenHeld, renoteVoid, byEvidence); default src/refund-ledger.js
 * @param {()=>number} [deps.now]
 */
/** Everything an RPC/mppx failure actually carries, for OUR LOG ONLY.
 *
 *  A bare `err.message` is not enough here and the charge rail already taught us
 *  why: mppx and its RPC layer put the real verdict somewhere other than the
 *  message, and a wrapper's default text then reads as the diagnosis. The live
 *  subscription canary's first run failed with ox's placeholder "Missing or
 *  invalid parameters." - which is only what ox prints when a JSON-RPC error
 *  arrives with code -32000 and NO message; the actual reason was in `data`,
 *  and we were discarding it.
 *
 *  Buyer-facing text is unchanged: the caller still gets the generic
 *  "did not settle" message, because an RPC body can quote a node's words.
 */
export function diagnoseError(err, max = 1200) {
  // Every field passes the redactor before it is cut, so a cut never leaves a
  // configured value's head behind: viem's metaMessages quote the request URL
  // (an RPC URL's path or query can carry its key).
  const clip = (v, n) => redactSecrets(String(v)).slice(0, n);
  const seen = new Set();
  const parts = [];
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e !== "object" || seen.has(e)) break;
    seen.add(e);
    const bit = [];
    // Order matters, and the first version got it wrong: viem puts the SERVER's
    // own words in `details` and the whole outbound request in `message`, so
    // leading with the message spent the whole budget on a raw transaction hex
    // and truncated away the one line that says why. Cause first, bulk last.
    if (e.name) bit.push(e.name);
    if (e.code !== undefined) bit.push(`code=${JSON.stringify(e.code)}`);
    if (e.data !== undefined) bit.push(`data=${clip(JSON.stringify(e.data), 300)}`);
    if (e.details) bit.push(`details=${clip(e.details, 300)}`);
    if (e.shortMessage) bit.push(`short=${clip(e.shortMessage, 200)}`);
    if (e.metaMessages) bit.push(`meta=${clip(JSON.stringify(e.metaMessages), 300)}`);
    if (e.status !== undefined) bit.push(`status=${e.status}`);
    // The message can carry a full serialized transaction; keep it, keep it last,
    // and keep it short. Its useful head is the first line.
    if (e.message) bit.push(`msg=${clip(String(e.message).split("\n")[0], 200)}`);
    if (bit.length) parts.push(bit.join(" "));
  }
  const out = redactSecrets(parts.join(" <- ") || String(err));
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/**
 * Build the engine at boot and say how it went, for the mppSubscriptions word
 * on /api/gateway-status: { engine, state } with state on (built), off (not
 * configured: `configured()` is false) or failed (configured, but the
 * installed mppx has no subscription method, or `build()` threw or refused).
 * Never throws; a failure is logged once by `warn`.
 */
export function buildMppSubscriptionsEngine({ configured = mppSubscriptionsConfigured, available = mppSubscriptionMethodAvailable, build, warn = console.warn } = {}) {
  try {
    if (!configured()) return { engine: null, state: "off" };
    if (!available()) {
      warn("[mpp-subs] init failed: the installed mppx has no tempo/subscription method");
      return { engine: null, state: "failed" };
    }
    const engine = build();
    if (engine) return { engine, state: "on" };
    warn("[mpp-subs] init failed: the engine refused to start");
    return { engine: null, state: "failed" };
  } catch (e) {
    warn("[mpp-subs] init failed:", String(e?.message || e).slice(0, 200));
    return { engine: null, state: "failed" };
  }
}

export function createMppSubscriptions({
  secretKey, realm, storePath, validateTarget = {}, onCharge,
  activate: injectedActivate = null, chargePeriod: injectedChargePeriod = null,
  findRenewalOnChain: injectedFindRenewal = null,
  screen = { addresses: screenAddresses, funding: screenFunding },
  refunds = null,
  // A signed receipt per confirmed period (src/receipt-signing.js
  // createSubscriptionReceipt), or null while signing is off; kept on the
  // record as `signedReceipts` (the newest last).
  signPeriod = null,
  now = () => Date.now(), log = console.log,
} = {}) {
  // Fail closed on the inputs the binding rests on. A subscription engine that
  // cannot prove "we minted this challenge for this product at this price" must
  // not exist: its existence is what lets a credential create a paying
  // subscriber with no card and no x402 payment behind it.
  if (!secretKey || !realm) {
    console.error("[mpp-subs] REFUSING to start: secretKey (MPP_SECRET_KEY) and realm are required to bind subscription challenges");
    return null;
  }
  if (!mppSubscriptionMethodAvailable()) {
    console.error("[mpp-subs] REFUSING to start: the installed mppx has no tempo/subscription method");
    return null;
  }
  const recipient = envRecipient();
  const currency = envCurrency();
  const decimals = envDecimals();
  const kv = createSubscriptionStore(storePath || STORE_PATH(), { log });
  // Everything handed to mppx goes through this view: a private-key record for
  // an access key we destroyed is never written back (see guardDestroyedKeys).
  const mppxKv = guardDestroyedKeys(kv);
  const subStore = Tempo.Subscription.fromStore(mppxKv);
  const PERIOD_MS = periodMs();

  // The mppx activation method. `resolve` maps a verified credential to the
  // stable lookup key for its subscription: the payer plus the access key we
  // minted for this offer. A fresh access key per offer means one lookup key
  // per subscription, and mppx finds the private half by address.
  // TEMPO_RPC_URL is honoured when set (same override the charge rail's
  // proven-seller gate uses); otherwise mppx's own mainnet default
  // (https://rpc.tempo.xyz) applies. Built lazily on first charge so a boot
  // never touches viem's transport stack and a bad URL cannot break startup.
  let _client = null;
  async function tempoClient() {
    if (_client) return _client;
    const { createClient, http } = await import("viem");
    const { tempo: tempoChain } = await import("viem/tempo/chains");
    // Always OUR client, never mppx's default: the default is viem's 10 s
    // request timeout, and a sync send that waits for inclusion outlived it on
    // a slow day (canary run 33659899394). Its chain stamps the activation
    // window, never viem's default (see ACTIVATION_VALID_FOR_S).
    _client = createClient({ chain: withRenewalValidity(tempoChain, ACTIVATION_VALID_FOR_S), transport: withSponsorCeiling(http(process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz", { timeout: TEMPO_RPC_TIMEOUT_MS }), { log, kind: "activation" }) });
    return _client;
  }
  const clientOverride = () => ({ getClient: () => tempoClient() });
  // Renewals only: same transport, chain hook stamps the longer validBefore.
  const renewalValidForS = renewalValidForSeconds();
  let _renewalClient = null;
  async function tempoRenewalClient() {
    if (_renewalClient) return _renewalClient;
    const { createClient, http } = await import("viem");
    const { tempo: tempoChain } = await import("viem/tempo/chains");
    _renewalClient = createClient({ chain: withRenewalValidity(tempoChain, renewalValidForS), transport: withSponsorCeiling(http(process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz", { timeout: TEMPO_RPC_TIMEOUT_MS }), { log, kind: "renewal" }) });
    return _renewalClient;
  }

  /**
   * Default chain reader for an unconfirmed renewal. mppx sends a renewal as a
   * Tempo (0x76) transaction whose transferWithMemo is one of `calls[]`, so the
   * transaction's own `input` says nothing about it. Candidates are the
   * currency's TransferWithMemo logs carrying THIS period's memo and its
   * Transfer logs from the payer to our recipient; each candidate is decided by
   * classifyRenewalEvidence (receipt log first, then calls[], then input).
   * Returns {found:true, tx} | {found:false} (every candidate decided, none is
   * this renewal) | {unknown:true} (something could not be decided) | null
   * (the chain could not be read). Only {found:false} may ever lead to a new
   * transfer; the caller waits on anything else.
   */
  async function defaultFindRenewalOnChain({ rec, mppxRec, periodIndex, sinceMs }) {
    try {
      const client = await tempoClient();
      // The chain actions live under viem/actions (the root export has none of them).
      const { parseAbi } = await import("viem");
      const { getBlock, getBlockNumber, getLogs, getTransaction, getTransactionReceipt } = await import("viem/actions");
      // The period amount in BASE UNITS: mppx's record carries request.amount,
      // which its codec already scaled (so "5000000" is $5.00 at 6 decimals),
      // and our record keeps the same figure as amountAtomic. Never re-scale it.
      const rawAmount = String(mppxRec?.amount ?? rec.amountAtomic ?? "");
      if (!/^\d+$/.test(rawAmount)) throw new Error("the period amount is not a base-units integer");
      const amount = BigInt(rawAmount);
      // Without the lookup key and subscription id the memo is someone else's.
      if (!mppxRec?.lookupKey || !rec.mppxSubscriptionId) return { unknown: true, reason: "the renewal memo cannot be derived" };
      const memo = await expectedRenewalMemo({ lookupKey: mppxRec.lookupKey, subscriptionId: rec.mppxSubscriptionId, periodIndex });
      const [transferEvent, memoEvent] = parseAbi([
        "event Transfer(address indexed from, address indexed to, uint256 value)",
        "event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)",
      ]);
      // The scan must reach back past sinceMs: the starting block is checked
      // by its timestamp (block times are not assumed), widened until covered.
      const head = await getBlockNumber(client);
      const tsMs = async (n) => Number((await getBlock(client, { blockNumber: n })).timestamp) * 1000;
      let back = BigInt(Math.max(0, Math.ceil((now() - sinceMs) / 1000)) + 120);
      let fromBlock = 0n;
      for (let i = 0; ; i++) {
        fromBlock = head > back ? head - back : 0n;
        if (fromBlock === 0n || (await tsMs(fromBlock)) <= sinceMs) break;
        if (i >= 20 || back >= RENEWAL_SCAN_MAX_BLOCKS) return { unknown: true, reason: "the attempt's block range could not be located" };
        back *= 2n;
      }
      if (head - fromBlock > RENEWAL_SCAN_MAX_BLOCKS) return { unknown: true, reason: "the attempt is further back than the scan bound" };
      const hashes = new Set();
      const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
      for (let start = fromBlock; start <= head; start += RENEWAL_SCAN_CHUNK_BLOCKS) {
        const end = start + RENEWAL_SCAN_CHUNK_BLOCKS - 1n < head ? start + RENEWAL_SCAN_CHUNK_BLOCKS - 1n : head;
        const range = { address: rec.currency, fromBlock: start, toBlock: end };
        const [withMemo, plain] = await Promise.all([
          getLogs(client, { ...range, event: memoEvent, args: { from: rec.payer, to: recipient, memo } }),
          getLogs(client, { ...range, event: transferEvent, args: { from: rec.payer, to: recipient } }),
        ]);
        for (const l of [...withMemo, ...plain]) {
          if (l.removed || !l.transactionHash || !sameAddr(l.address, rec.currency)) continue;
          if (!sameAddr(l.args?.from, rec.payer) || !sameAddr(l.args?.to, recipient)) continue;
          if ((l.args?.amount ?? l.args?.value) !== amount) continue;
          hashes.add(l.transactionHash);
        }
      }
      let undecided = 0;
      for (const hash of hashes) {
        let receipt = null, tx = null;
        try { receipt = await getTransactionReceipt(client, { hash }); } catch { receipt = null; }
        const want = { currency: rec.currency, payer: rec.payer, recipient, amount, memo };
        let verdict = await classifyRenewalEvidence({ receipt, ...want });
        if (verdict === "fallback") {
          try { tx = await getTransaction(client, { hash }); } catch { tx = null; }
          verdict = await classifyRenewalEvidence({ receipt, tx, ...want });
        }
        if (verdict === "match") return { found: true, tx: hash };
        if (verdict !== "no") undecided++;
      }
      if (undecided) {
        log(`[mpp-subs] ${undecided} candidate transfer(s) for an unconfirmed renewal could not be decided (will wait, not re-charge)`);
        return { unknown: true, reason: "a candidate transfer could not be decided" };
      }
      return { found: false };
    } catch (err) {
      log(`[mpp-subs] chain read for an unconfirmed renewal failed (will wait, not re-charge): ${diagnoseError(err, 300)}`);
      return null;
    }
  }

  // Resolved once at construction: the engine is only ever created when the
  // rollout switch passed, and that switch already requires this account.
  const feePayer = subscriptionFeePayer();

  // mppx 0.12+ returns an ordered group of subscription offers, one per
  // currency; this server bills in one, so the group has one member.
  const [method] = tempoServer.subscription({
    // Every monitor product is priced the same today, and the activation path
    // never reads this default: `verify` works off the CHALLENGE's own request,
    // which we mint per product. It is set anyway so the method is never
    // constructed with an incomplete request shape.
    amount: usdToTokenDecimalString(MONITOR_PRODUCTS["domain-monitor"].price / 100, envDecimals()),
    currencies: [currency], decimals, recipient, chainId: TEMPO_MAINNET_CHAIN_ID,
    periodCount: PERIOD_COUNT, periodUnit: PERIOD_UNIT,
    subscriptionExpires: new Date(Math.floor((Date.now() + SUBSCRIPTION_TERM_MS) / 1000) * 1000),
    store: mppxKv,
    // Makes mppx build the transaction through prepareTransactionRequest, which
    // is the ONLY path that populates gas and fee fields. See subscriptionFeePayer().
    ...(feePayer ? { feePayer, feePayerPolicy: subscriptionFeePayerPolicy() } : {}),
    ...clientOverride(),
    resolve: ({ request, source }) => {
      const ak = String(request?.methodDetails?.accessKey?.accessKeyAddress || "").toLowerCase();
      const payer = String(source?.address || "").toLowerCase();
      if (!ak || !payer) return null;
      return { key: `${payer}|${ak}` };
    },
  });

  // --- house records ---------------------------------------------------------
  // Read through to the store: a subscription is changed on whichever
  // container served the request, and every decision here (activate, cancel,
  // status) must see the other container's last write. Subscriptions are few,
  // so the extra read is cheap; a store that cannot be read falls back to the
  // mirror.
  async function readRec(subId) {
    if (kv.backend === "pg") {
      try { const fresh = await kv.getFresh(REC_KEY(subId)); if (fresh) cache.set(subId, fresh); return fresh || null; }
      catch { /* the mirror answers below */ }
    }
    return (await kv.get(REC_KEY(subId))) || null;
  }
  async function writeRec(rec) {
    const next = { ...rec, updatedAt: new Date(now()).toISOString() };
    await kv.put(REC_KEY(rec.subId), next);
    cache.set(next.subId, next);   // listActive/get are synchronous for the scheduler
    return next;
  }
  /**
   * Create-if-absent: the record is written only when the store holds none
   * under its id (one compare-and-set, so two containers or two concurrent
   * retries of one credential cannot both create it). Resolves { won, value }:
   * the record written, or the one already stored (a cancel stored meanwhile
   * is never overwritten). The first period is booked only by the winner.
   */
  async function writeRecIfAbsent(rec) {
    const next = { ...rec, updatedAt: new Date(now()).toISOString() };
    const r = await kv.compareAndSet(REC_KEY(rec.subId), (cur) => (cur ? null : next));
    const value = r.value || next;
    cache.set(value.subId, value);
    return { won: r.won === true, value };
  }
  /**
   * A write from a copy read before a slow step (a renewal's chain check,
   * signature and send take seconds) keeps a cancel stored meanwhile, by this
   * request or the other container, instead of overwriting the whole record.
   * A requested cancel that meets a period just paid stays "active until the
   * period ends", as cancel() itself decides; anything else stays canceled.
   */
  async function writeRecKeepingCancel(rec, { ownPull = false } = {}) {
    const r = await kv.compareAndSet(REC_KEY(rec.subId), (cur) => {
      // A record the sweep deleted is not written back, and a reduced record
      // takes only the facts of a charge that landed after it was reduced.
      if (!cur) return null;
      if (cur.tombstone) {
        const paid = (rec.lastChargedPeriod ?? 0) > (cur.lastChargedPeriod ?? 0);
        const pending = !!rec.unconfirmedCharge && !cur.unconfirmedCharge && (rec.lastChargedPeriod ?? 0) === (cur.lastChargedPeriod ?? 0);
        if (!paid && !pending) return null;
        return {
          ...cur,
          ...(paid ? { lastChargedPeriod: rec.lastChargedPeriod, lastChargeTx: rec.lastChargeTx || null, lastChargeAt: rec.lastChargeAt || null, unconfirmedCharge: null } : { unconfirmedCharge: rec.unconfirmedCharge }),
          updatedAt: new Date(now()).toISOString(),
        };
      }
      const out = { ...rec, updatedAt: new Date(now()).toISOString() };
      if (cur && cur.cancelAtPeriodEnd && !out.cancelAtPeriodEnd) {
        out.cancelAtPeriodEnd = true; out.canceledAt = cur.canceledAt; out.canceledReason = cur.canceledReason;
      }
      if (cur && cur.status === "canceled" && out.status !== "canceled" && out.status !== "expired") {
        const paidOn = cur.canceledReason === "requested" && !isCanaryProduct(out.product) && out.status === "active" && now() < paidThroughAt(out);
        if (!paidOn) { out.status = "canceled"; out.canceledAt = cur.canceledAt; out.canceledReason = cur.canceledReason; }
      }
      return out;
    });
    if (!r.value) { cache.delete(rec.subId); return { ...rec }; }
    let next = r.value;
    cache.set(rec.subId, next);   // listActive/get are synchronous for the scheduler
    // The write that ends a subscription is also where its key goes.
    if (isEnded(next) && !next.tombstone) {
      await finishEnded(rec.subId, { ownPull });
      next = cache.get(rec.subId) || next;
    }
    return next;
  }
  async function allRecs() {
    // The other container's records (and its cancels) are in the row, not in this map.
    await kv.refreshAll().catch(() => false);
    const out = [];
    for (const k of kv._keys()) if (k.startsWith("a402:sub:")) { const v = await kv.get(k); if (v) out.push(v); }
    return out;
  }

  /** The manage token: a keyed bearer for cancel/status, minted at activation
   *  and handed to the subscriber once. The subscription id alone is NOT enough
   *  (report links carry ids and subscribers are told to share reports), the
   *  same rule the Stripe portal link follows. */
  function manageToken(subId) {
    return createHmac("sha256", secretKey).update(`mpp-sub-manage|${subId}`).digest("base64url");
  }
  function manageTokenOk(subId, token) {
    const want = Buffer.from(manageToken(subId));
    const got = Buffer.from(String(token || ""));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Drop the access keys of offers nobody paid, and report how many are still
   *  open. An offer is dropped only once its challenge is past minting-plus-TTL
   *  (so it can no longer be paid) and no subscription is using its key, which
   *  makes this safe to run in front of every mint. Returns the open count. */
  async function sweepOffers() {
    const snap = kv._snapshot();
    const live = new Set(Object.entries(snap).filter(([k]) => k.startsWith("a402:sub:")).map(([, v]) => String(v.accessKeyAddress || "").toLowerCase()));
    let open = 0;
    // The file store writes the whole document on every delete, and its
    // awaits resolve without ever leaving the microtask queue: a walk over
    // the cap's worth of expired offers held the event loop for over a
    // second. The walk gives the loop a turn once a slice has run for
    // OFFER_SWEEP_SLICE_MS. Every offer it reaches here is past its
    // challenge's life, so nothing a request does in between can pay it.
    let sliceAt = Date.now();
    for (const [key, marker] of Object.entries(snap)) {
      if (Date.now() - sliceAt >= OFFER_SWEEP_SLICE_MS) { await new Promise((r) => setImmediate(r)); sliceAt = Date.now(); }
      // A destroyed key's marker only has to outlive a renewal in flight.
      if (key.startsWith(KEY_GONE_PREFIX)) {
        if (now() - (Date.parse(marker?.at || "") || 0) > KEY_GONE_KEEP_MS) await kv.delete(key);
        continue;
      }
      if (!key.startsWith("a402:offer:")) continue;
      const addr = String(marker?.accessKeyAddress || "").toLowerCase();
      if (live.has(addr)) { await kv.delete(key); continue; }   // paid: the key belongs to a subscription now
      if (now() - Number(marker?.at || 0) < OFFER_SWEEP_AFTER_MS) { open++; continue; }
      // A first payment mppx settled for this offer while no record of ours
      // was written (the process died in between, or the write failed and the
      // buyer never retried): the subscription is rebuilt from the offer and
      // mppx's record, or, when it cannot be, booked owed before the key goes.
      // Neither landing keeps the offer and its key for the next sweep.
      const settled = settledRecordFor(addr, snap);
      if (settled) {
        let outcome = null;
        try { outcome = await recoverSettledOffer(settled, marker, addr); }
        catch (e) { log(`[mpp-subs] offer sweep: settled first payment for ${shortPayer(addr)} not recovered yet: ${String(e?.message || e).slice(0, 160)}`); }
        if (!outcome) continue;
        await kv.delete(key);
        if (outcome === "rebuilt") continue;   // the key bills the rebuilt subscription
        await destroyAccessKey(addr, snap);
        continue;
      }
      await kv.delete(key);
      // Delete the access-key records by MATCHING THEIR CONTENT, never by
      // rebuilding mppx's key names: it stores the same record twice, once by
      // lookup key and once by address, and the address entry's real prefix is
      // `<accessKeyPrefix>address:` - a hand-written prefix here would leave
      // live private-key material on disk while the sweep reported success.
      await destroyAccessKey(addr, snap);
    }
    return open;
  }
  /** Delete OUR private half of one access key, by content match (see the
   *  note in sweepOffers). With it gone the buyer's standing authorization for
   *  that key can never be exercised by anyone. Returns how many records went.
   *  With `mark` (a key a subscription billed with, whose renewal may be in
   *  flight) the address is marked first, so that renewal's late rewrite of
   *  the key is refused (guardDestroyedKeys). An unpaid offer has no renewal
   *  and leaves no marker. */
  async function destroyAccessKey(address, snap = null, { mark = false } = {}) {
    const addr = String(address || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return 0;
    if (mark) await kv.put(`${KEY_GONE_PREFIX}${addr}`, { at: new Date(now()).toISOString() });
    snap = snap || kv._snapshot();
    let n = 0;
    for (const [k2, v2] of Object.entries(snap)) {
      if (v2 && typeof v2 === "object" && v2.privateKey && String(v2.accessKeyAddress || "").toLowerCase() === addr) { await kv.delete(k2); n++; }
    }
    // The offer's marker goes with the key: it carries the binding (and email).
    await dropOfferMarkers(addr, snap);
    return n;
  }
  /** Delete the offer markers naming one access key (an offer that was paid or whose key went). */
  async function dropOfferMarkers(address, snap = kv._snapshot()) {
    const addr = String(address || "").toLowerCase();
    for (const [k, v] of Object.entries(snap)) {
      if (k.startsWith("a402:offer:") && String(v?.accessKeyAddress || "").toLowerCase() === addr && (await kv.get(k))) await kv.delete(k);
    }
  }

  // --- the end of a subscription ----------------------------------------------
  const isEnded = (rec) => !!rec && (rec.status === "canceled" || rec.status === "expired");
  /** Private-key records held for one access key address, in a store snapshot. */
  function heldKeyCount(address, snap = kv._snapshot()) {
    const addr = String(address || "").toLowerCase();
    let n = 0;
    for (const v of Object.values(snap)) if (isKeyRecord(v) && keyAddrOf(v) === addr) n++;
    return n;
  }
  /** When an ended record's subscription ended: the signed expiry, the end of
   *  the paid period for a requested cancel, the cancel time otherwise; never
   *  later than `at`. */
  function endedAtOf(rec, at) {
    const cancel = Date.parse(rec.canceledAt || "");
    let end;
    if (rec.status === "expired") end = Date.parse(rec.subscriptionExpires || "");
    else if (rec.canceledReason === "requested" && !isCanaryProduct(rec.product)) end = Math.max(Number.isFinite(cancel) ? cancel : 0, paidThroughAt(rec));
    else end = cancel;
    return new Date(Number.isFinite(end) && end > 0 && end < at ? end : at).toISOString();
  }
  function tombstoneOf(rec, at) {
    const out = {};
    for (const k of TOMBSTONE_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
    return {
      ...out, tombstone: true,
      endedAt: rec.endedAt || endedAtOf(rec, at),
      keyDestroyedAt: rec.keyDestroyedAt || new Date(at).toISOString(),
      mppxCleared: false,
      updatedAt: new Date(at).toISOString(),
    };
  }
  /** Delete mppx's own entries for an ended subscription (its record, which
   *  carries the buyer's signed authorization, the lookup pointer and any
   *  activation marker), found by content like the key records are. */
  async function clearMppxRecord(tomb, at = now()) {
    const id = tomb.mppxSubscriptionId;
    if (id) {
      for (const [k, v] of Object.entries(kv._snapshot())) {
        if (k.startsWith("a402:")) continue;
        if (v === id || (v && typeof v === "object" && !Array.isArray(v) && v.subscriptionId === id)) await kv.delete(k);
      }
    }
    if (tomb.lookupKey) {
      const marker = `tempo:subscription:activation:${tomb.lookupKey}`;
      if (await kv.get(marker)) await kv.delete(marker);
    }
    const r = await kv.compareAndSet(REC_KEY(tomb.subId), (cur) => (cur?.tombstone && !cur.mppxCleared ? { ...cur, mppxCleared: true, updatedAt: new Date(at).toISOString() } : null));
    if (r.value) cache.set(tomb.subId, r.value);
  }
  /**
   * Finish an ended subscription: destroy our private half of its access key
   * (marked, so a renewal still sending cannot write it back) and reduce the
   * record to TOMBSTONE_FIELDS, deleting mppx's own record with it.
   * Idempotent; does nothing for a record that is not canceled or expired.
   * The key always goes at once. The record is NOT reduced while a renewal
   * is in flight (another caller's claim is live): a charge that lands for
   * a requested cancel keeps the subscriber active through the period it
   * paid for (writeRecKeepingCancel), so that renewal's own write decides,
   * and the sweep reduces whatever is still ended once the claim has run
   * out. Returns { keys, reduced } or null.
   */
  async function finishEnded(subId, { at = now(), ownPull = false } = {}) {
    let rec;
    try { rec = await kv.getFresh(REC_KEY(subId)); } catch { rec = await kv.get(REC_KEY(subId)); }
    if (!isEnded(rec)) return null;
    if (kv.backend === "pg") await kv.refreshAll().catch(() => false);   // the other container's key copies
    const keys = (!rec.keyDestroyedAt || heldKeyCount(rec.accessKeyAddress)) ? await destroyAccessKey(rec.accessKeyAddress, null, { mark: true }) : 0;
    const r = await kv.compareAndSet(REC_KEY(subId), (cur) => {
      if (!isEnded(cur) || cur.tombstone) return null;
      if (!ownPull && cur.chargeClaim && Date.parse(cur.chargeClaim.until) > at) return null;
      return tombstoneOf(cur, at);
    });
    const next = r.value || null;
    if (next) cache.set(subId, next);
    if (next?.tombstone && !next.mppxCleared) await clearMppxRecord(next, at);
    return { keys, reduced: r.won === true };
  }

  /**
   * The ended-subscription sweep (leased, every ENDED_SWEEP_INTERVAL_MS, at
   * most `max` records changed per run). For each record: one whose end only
   * the clock decides (the signed term ran out, or a requested cancel's paid
   * period did) is closed; an ended record is finished (key destroyed, record
   * reduced), which is also how records ended before this sweep existed are
   * brought in; a reduced record older than ENDED_RECORD_KEEP_MS is deleted.
   * A subscription that can still be pulled is never touched. Signs nothing,
   * moves no money. Logs counts only.
   */
  async function sweepEndedUnleased({ max = ENDED_SWEEP_MAX_PER_RUN } = {}) {
    await ready;
    const at = now();
    const out = { closed: 0, reduced: 0, keysDestroyed: 0, deleted: 0, more: false };
    let budget = Math.max(1, Number(max) || ENDED_SWEEP_MAX_PER_RUN);
    for (const rec of await allRecs()) {
      if (!rec || typeof rec.subId !== "string") continue;
      let cur = rec, touched = false;
      if (!isEnded(cur)) {
        // A rail-canary record is closed by its own run or by sweepStaleCanaries.
        if (isCanaryProduct(cur.product)) continue;
        const term = Date.parse(cur.subscriptionExpires);
        if (!(Number.isFinite(term) && at >= term) && !(cur.cancelAtPeriodEnd && at >= paidThroughAt(cur))) continue;
        if (budget <= 0) { out.more = true; break; }
        const r = await kv.compareAndSet(REC_KEY(cur.subId), (c) => {
          if (!c || isEnded(c)) return null;
          const t = Date.parse(c.subscriptionExpires);
          if (Number.isFinite(t) && at >= t) return { ...c, status: "expired", updatedAt: new Date(at).toISOString() };
          if (c.cancelAtPeriodEnd && at >= paidThroughAt(c)) return { ...c, status: "canceled", canceledAt: c.canceledAt || new Date(at).toISOString(), canceledReason: c.canceledReason || "requested", updatedAt: new Date(at).toISOString() };
          return null;
        });
        if (!r.won || !isEnded(r.value)) continue;
        cur = r.value; cache.set(cur.subId, cur); out.closed++; touched = true;
      }
      if (!cur.tombstone || !cur.mppxCleared || heldKeyCount(cur.accessKeyAddress)) {
        if (budget <= 0) { out.more = true; break; }
        const f = await finishEnded(cur.subId, { at });
        if (f) { out.keysDestroyed += f.keys; if (f.reduced) out.reduced++; }
        cur = cache.get(cur.subId) || cur; touched = true;
      }
      const ended = Date.parse(cur.endedAt || "");
      if (cur.tombstone && Number.isFinite(ended) && at - ended >= ENDED_RECORD_KEEP_MS) {
        if (budget <= 0) { out.more = true; break; }
        if (!cur.mppxCleared) await clearMppxRecord(cur, at);
        await kv.delete(REC_KEY(cur.subId));
        cache.delete(cur.subId);
        out.deleted++; touched = true;
      }
      if (touched) budget--;
    }
    if (out.closed || out.reduced || out.keysDestroyed || out.deleted) {
      log(`[mpp-subs] ended-subscription sweep: closed ${out.closed}, reduced ${out.reduced}, key records destroyed ${out.keysDestroyed}, deleted ${out.deleted}${out.more ? " (more next run)" : ""}`);
    }
    return out;
  }
  const sweepEnded = leased("mpp-subscription-ended-sweep", { ttlMs: 10 * 60_000, log }, sweepEndedUnleased);
  /**
   * The renewal retry sweep (RENEWAL RETRIES; leased, every
   * RENEWAL_RETRY_SWEEP_MS, at most `max` pulls per run). Every past_due
   * monitor subscription whose retry time has come is pulled through
   * refreshStatus, the same gate a scheduled run takes: under the
   * subscription's own lease, with the period claimed on the record before
   * anything is signed and an unconfirmed send asked of the chain first, so a
   * second container's sweep, a scheduler run or a canary refresh at the same
   * moment can never pay one period twice. A rail-canary record is left to its
   * own run. Logs counts only.
   */
  async function retryDueRenewalsUnleased({ max = RENEWAL_RETRY_MAX_PER_RUN } = {}) {
    await ready;
    // The other container's writes (a renewal it confirmed, a cancel) reach
    // the mirror before the pick; refreshStatus re-reads each record anyway.
    if (kv.backend === "pg") { try { await refreshMirror(true); } catch { /* refreshStatus re-reads */ } }
    const at = now();
    const due = [...cache.values()].filter((rec) => rec && typeof rec.subId === "string" && rec.status === "past_due" && !rec.tombstone
      && Object.hasOwn(MONITOR_PRODUCTS, String(rec.product)) && !isCanaryProduct(rec.product)
      && !(Date.parse(rec.nextChargeAttemptAt || "") > at))
      .sort((a, b) => (Date.parse(a.nextChargeAttemptAt || "") || 0) - (Date.parse(b.nextChargeAttemptAt || "") || 0));
    const limit = Math.max(1, Number(max) || RENEWAL_RETRY_MAX_PER_RUN);
    const out = { tried: 0, renewed: 0, canceled: 0, pastDue: 0, other: 0, more: due.length > limit };
    for (const rec of due.slice(0, limit)) {
      out.tried++;
      let st = null;
      try { st = await refreshStatus(rec.subId); }
      catch (e) { log(`[mpp-subs] renewal retry of ${rec.subId} failed to run (${String(e?.message || e).slice(0, 120)}); next run tries again`); }
      if (st === "active") out.renewed++;
      else if (st === "canceled") out.canceled++;
      else if (st === "past_due") out.pastDue++;
      else out.other++;
    }
    if (out.tried) log(`[mpp-subs] renewal retry sweep: tried ${out.tried}, renewed ${out.renewed}, canceled ${out.canceled}, still past due ${out.pastDue}${out.more ? " (more next run)" : ""}`);
    return out;
  }
  const retryDueRenewals = leased("mpp-subscription-renewal-retry", { ttlMs: 10 * 60_000, log }, retryDueRenewalsUnleased);
  // The offer sweep also runs on a timer, not only in front of a mint: an
  // offer's marker carries the buyer's email and target, and with no mint
  // after it they would otherwise stay until the next one.
  const sweepOffersLeased = leased("mpp-subscription-offer-sweep", { ttlMs: OFFER_SWEEP_LEASE_TTL_MS, log }, () => sweepOffers());
  let sweepTimer = null, sweepFirst = null, offerTimer = null, offerFirst = null, retryTimer = null;
  /** Start the ended-subscription and offer sweeps' timers (unref'd; the first ended run is held back off the boot path). */
  function start({ intervalMs = ENDED_SWEEP_INTERVAL_MS, firstMs = 2 * 60_000, offerIntervalMs = OFFER_SWEEP_INTERVAL_MS, offerFirstMs = OFFER_SWEEP_FIRST_MS, retryIntervalMs = RENEWAL_RETRY_SWEEP_MS } = {}) {
    if (sweepTimer) return;
    const runRetry = () => { retryDueRenewals().catch((e) => log(`[mpp-subs] renewal retry sweep failed: ${String(e?.message || e).slice(0, 160)}`)); };
    retryTimer = setInterval(runRetry, retryIntervalMs); retryTimer.unref?.();
    const run = () => { sweepEnded().catch((e) => log(`[mpp-subs] ended-subscription sweep failed: ${String(e?.message || e).slice(0, 160)}`)); };
    sweepTimer = setInterval(run, intervalMs); sweepTimer.unref?.();
    sweepFirst = setTimeout(run, firstMs); sweepFirst.unref?.();
    const runOffers = () => { sweepOffersLeased().catch((e) => log(`[mpp-subs] offer sweep failed: ${String(e?.message || e).slice(0, 160)}`)); };
    offerTimer = setInterval(runOffers, offerIntervalMs); offerTimer.unref?.();
    // First offer run shortly after a start, so a deploy does not push it out a full interval.
    offerFirst = setTimeout(runOffers, offerFirstMs); offerFirst.unref?.();
  }
  function stop() {
    if (sweepTimer) clearInterval(sweepTimer);
    if (sweepFirst) clearTimeout(sweepFirst);
    if (offerTimer) clearInterval(offerTimer);
    if (offerFirst) clearTimeout(offerFirst);
    if (retryTimer) clearInterval(retryTimer);
    sweepTimer = null; sweepFirst = null; offerTimer = null; offerFirst = null; retryTimer = null;
  }

  // --- the offer -------------------------------------------------------------
  /** Machine-readable description of what an agent can subscribe to and how.
   *  Free surface: no secret, no store write. */
  function offerInfo(baseUrl = "") {
    return {
      wire: "mpp", method: "tempo", intent: "subscription",
      chainId: TEMPO_MAINNET_CHAIN_ID, currency, decimals, recipient,
      billingPeriod: { periodCount: PERIOD_COUNT, periodUnit: PERIOD_UNIT, seconds: PERIOD_MS / 1000 },
      termMs: SUBSCRIPTION_TERM_MS,
      chargeMode: "pull",
      howItWorks: [
        "POST to the subscribe endpoint with {product, target, email?} and no Authorization header.",
        "You get 402 with a WWW-Authenticate: Payment tempo/subscription challenge.",
        "Sign the challenge's key authorization with your Tempo account and retry with Authorization: Payment <credential>.",
        "The first period settles on-chain during that retry. Later periods are pulled by this server, one transfer per period, up to the amount and expiry you signed.",
      ],
      products: Object.entries(MONITOR_PRODUCTS).map(([key, p]) => ({
        product: key, label: p.label, kind: p.kind,
        priceUsdPerPeriod: p.price / 100,
        amountAtomic: String(usdToBaseUnits(p.price / 100, decimals)),
        inputField: p.inputField, inputLabel: p.inputLabel, blurb: p.blurb,
        subscribe: baseUrl ? `${baseUrl}/api/mpp/monitors/subscribe` : undefined,
      })),
    };
  }

  /** Mint the 402 challenge for one product + target. Validates the target
   *  BEFORE minting, for the same reason the card path does: a recurring
   *  authorization against a target we cannot watch is a subscription we would
   *  bill and never serve. Returns the WWW-Authenticate value. */
  async function mintOffer({ product, target, email, canary = false }) {
    await ready;
    // The canary product is mintable ONLY when the caller proved the heartbeat
    // token; server.js is what establishes that, and it must pass it here.
    // Without the flag this resolver behaves exactly as it did: real products
    // only, so nothing an outside buyer can ask for changes.
    const p = canary && isCanaryProduct(product) ? CANARY_PRODUCT
      : Object.hasOwn(MONITOR_PRODUCTS, String(product)) ? MONITOR_PRODUCTS[product] : null;
    if (!p) { const e = new Error("Unknown monitor product"); e.statusCode = 400; throw e; }
    let t = String(target ?? "").trim();
    if (!t) { const e = new Error(`Please provide ${p.inputLabel}.`); e.statusCode = 400; throw e; }
    if (t.length > 200) { const e = new Error("Input is too long."); e.statusCode = 400; throw e; }
    // A canary target is a label, not a thing to watch: there is no validator
    // for kind "canary", so this is belt and braces.
    const v = p === CANARY_PRODUCT ? null : validateTarget[p.kind];
    if (typeof v === "function") {
      // NEVER relay an upstream body to a buyer: only a message we minted
      // ourselves (buyerSafe) is shown, same rule as the card path.
      try { const norm = await v(t); if (typeof norm === "string" && norm.trim()) t = norm.trim().slice(0, 200); }
      catch (err) {
        const e = new Error(err?.buyerSafe ? String(err.message).slice(0, 200) : `We could not validate ${p.inputLabel}. Check it and try again.`);
        e.statusCode = err?.statusCode && err.statusCode < 500 ? err.statusCode : 400;
        throw e;
      }
    }
    const mail = typeof email === "string" && email.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? email.trim() : null;
    const nowMs = now();

    // A FRESH server-owned access key per offer. Its address rides in the
    // challenge, the buyer's signature scopes their delegation to it, and it is
    // what makes each subscription a distinct lookup key.
    const open = await sweepOffers();
    if (open >= MAX_OPEN_OFFERS) {
      const e = new Error("Too many subscription offers are open right now. Please try again shortly.");
      e.statusCode = 503; throw e;
    }
    const offerNonce = randomBytes(12).toString("hex");
    const ak = await subStore.getOrCreateAccessKey(`offer:${offerNonce}`);
    // The binding rides on the marker too, so a payment that settles with no
    // record of ours can be rebuilt by the sweep after the challenge expires.
    await kv.put(OFFER_KEY(offerNonce), { at: nowMs, accessKeyAddress: ak.accessKeyAddress, product: String(product), target: t, email: mail });

    // Whole seconds only: mppx rejects a subscriptionExpires that is not
    // representable as whole seconds (measured), because the key authorization
    // commits to a Unix-seconds expiry.
    const expiresAt = new Date(Math.floor((nowMs + CHALLENGE_TTL_MS) / 1000) * 1000);
    const termEnd = new Date(Math.floor((nowMs + SUBSCRIPTION_TERM_MS) / 1000) * 1000);

    // Built through mppx's OWN builder, never hand-assembled: the schema turns
    // the decimal amount into base units, DROPS `decimals`, and moves chainId +
    // accessKey under methodDetails. Two live incidents on the charge rail came
    // from getting exactly this wrong by hand.
    const challenge = Challenge.fromMethod(Tempo.Methods.subscription, {
      realm,
      expires: expiresAt,
      secretKey,
      description: `${p.label}: ${t}`.slice(0, 200),
      // Bound into the HMAC via `opaque` (see checkSubscriptionBinding).
      meta: { product: String(product), target: t, ...(mail ? { email: mail } : {}) },
      request: {
        amount: usdToTokenDecimalString(p.price / 100, decimals),
        accessKey: { accessKeyAddress: ak.accessKeyAddress, keyType: ak.keyType },
        chainId: TEMPO_MAINNET_CHAIN_ID,
        currency, decimals,
        // dev_second periods for the canary so a renewal is due within a CI
        // run; every real product signs the 30-day period.
        ...(p === CANARY_PRODUCT
          ? { periodCount: CANARY_PERIOD_SECONDS, periodUnit: "dev_second" }
          : { periodCount: PERIOD_COUNT, periodUnit: PERIOD_UNIT }),
        recipient,
        subscriptionExpires: termEnd,
      },
    });
    return { header: Challenge.serialize(challenge), challenge, product: String(product), target: t, email: mail, accessKeyAddress: ak.accessKeyAddress };
  }

  // --- payer screen ----------------------------------------------------------
  // Counted like the x402 payer screen counts (src/x402-payer-screen.js):
  // screened, refused, and payments sent while no list was loaded.
  const screenCounts = { screened: 0, refused: 0, servedUnscreened: 0, lastRefusedAt: 0, lastUnscreenedAt: 0 };
  let unscreenedLoggedAt = 0;
  const payerScreenView = () => ({
    screened: screenCounts.screened, refused: screenCounts.refused, servedUnscreened: screenCounts.servedUnscreened,
    lastRefusedAt: screenCounts.lastRefusedAt ? new Date(screenCounts.lastRefusedAt).toISOString() : null,
    lastUnscreenedAt: screenCounts.lastUnscreenedAt ? new Date(screenCounts.lastUnscreenedAt).toISOString() : null,
  });
  /**
   * The paying wallet's verdict before a payment is sent: null when it
   * passes, { reason: "listed" } (on the list) or { reason: "funded" } (the
   * one-hop funding check refused it). The exact match is a Set lookup. The
   * funding check answers from its per-payer cache when it holds a verdict;
   * a cold one reads the transfer feed inside its own deadline
   * (SANCTIONS_ONE_HOP_DEADLINE_MS, default 2.5 s, at most 10 s), and a read
   * that fails or times out passes. Both run before anything is signed, so
   * the read takes nothing from a transaction's validity window, which is
   * stamped when the transaction is prepared. With no list loaded the
   * payment proceeds: counted, logged once a minute.
   */
  async function screenPayer(payer, phase) {
    let v;
    try { v = screen.addresses([payer]); } catch { v = { ok: false, reason: "unavailable" }; }
    if (!v.ok && v.reason === "listed") {
      screenCounts.screened++; screenCounts.refused++; screenCounts.lastRefusedAt = Date.now();
      log(`[sanctions-screen] subscription payer ${maskAddress(payer)} refused ${phase}; nothing sent`);
      return { reason: "listed" };
    }
    if (v.ok) screenCounts.screened++;
    else {
      screenCounts.servedUnscreened++; screenCounts.lastUnscreenedAt = Date.now();
      if (Date.now() - unscreenedLoggedAt >= 60_000) {
        unscreenedLoggedAt = Date.now();
        log("[sanctions-screen] subscription payer screen: no list loaded, sending subscription payments unscreened");
      }
    }
    let f;
    try { f = await screen.funding([payer], { now: now() }); } catch { f = { ok: true }; }
    if (f && f.ok === false) {
      screenCounts.refused++; screenCounts.lastRefusedAt = Date.now();
      log(`[sanctions-screen] subscription payer ${maskAddress(payer)} refused ${phase} (funding check); nothing sent`);
      return { reason: "funded" };
    }
    return null;
  }

  // --- activation ------------------------------------------------------------
  /** Default activation: hand the credential to mppx's subscription method,
   *  which verifies the key authorization, recovers the payer, installs the
   *  access key and settles period 0 on-chain, then persists its own record.
   *  Injected in tests so the whole path is provable offline. */
  async function defaultActivate(authorizationHeader) {
    const receipt = await Method.broadcastCredential([method], authorizationHeader);
    return { receipt };
  }

  /** The answer to a first payment that settled with no subscription
   *  recorded. `settledNotRecorded` lets the route relay this message (every
   *  other 5xx text stays ours). A retry is accepted only while the challenge
   *  is still valid; after that the debt booked for the payment stands. */
  function firstPaymentNotRecordedError(booked) {
    const e = new Error(booked
      ? "The first subscription payment settled, but the subscription could not be recorded. Send this same request again before the payment challenge expires to receive the subscription; after that, the payment is refunded to the paying wallet."
      : "The first subscription payment settled, but the subscription could not be recorded. Send this same request again before the payment challenge expires to receive the subscription; after that, the payment is restored as a subscription or refunded to the paying wallet.");
    e.statusCode = 500; e.settledNotRecorded = true;
    return e;
  }

  /**
   * Turn a signed subscription credential into a paying subscriber.
   * Order is non-negotiable: BINDING first (pure, offline), then the access key
   * must be one we hold, then the key authorization is verified against OUR
   * key, and only then does anything settle.
   */
  async function activateFromCredential(authorizationHeader) {
    await ready;
    const b = checkSubscriptionBinding(authorizationHeader, { secretKey, realm, now: now() });
    if (!b.ok) { const e = new Error(b.reason); e.statusCode = 402; e.binding = true; throw e; }

    // The access key named in OUR challenge must be one we actually hold. This
    // is belt-and-braces (the HMAC already proves we minted it) but it is also
    // the thing that makes a replayed old challenge harmless: no stored key, no
    // charge.
    const stored = await subStore.getAccessKeyByAddress(b.accessKeyAddress);
    if (!stored?.privateKey) { const e = new Error("this server no longer holds the access key named in the challenge"); e.statusCode = 402; e.binding = true; throw e; }

    // Recover the payer from the signature and check the delegation is scoped
    // to OUR key, OUR token, OUR recipient, this amount and this period. Passing
    // `accessKey` explicitly matters: without it mppx falls back to the
    // credential's own echoed key and accepts a signature over anything.
    let verified;
    try {
      verified = Tempo.Subscription.verifySubscriptionKeyAuthorization({
        accessKey: { accessKeyAddress: stored.accessKeyAddress, keyType: stored.keyType },
        // mppx 0.9.3 binds the key authorization to the server-issued challenge:
        // the buyer signs the 32-byte challenge id as a witness and verify
        // recomputes it from `challengeId`. Omitting it throws on 0.9.3 ("challenge
        // id must encode 32 bytes") for EVERY credential; 0.9.2 ignores the field.
        // A buyer on mppx <= 0.9.2 signs no witness and is refused by a 0.9.3
        // server - the spec's intent (an authorization cannot be replayed against
        // another challenge), and the reason the bump needs the live canary.
        challengeId: b.challenge.id,
        chainId: TEMPO_MAINNET_CHAIN_ID,
        payload: b.credential.payload,
        request: b.challenge.request,
      });
    } catch (err) {
      const e = new Error(`key authorization did not verify: ${String(err?.message || err).slice(0, 160)}`);
      e.statusCode = 402; e.binding = true; throw e;
    }
    const payer = String(verified?.source?.address || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(payer)) { const e = new Error("key authorization carries no recoverable payer"); e.statusCode = 402; e.binding = true; throw e; }

    const lookupKey = `${payer}|${b.accessKeyAddress}`;
    const already = await subStore.getByKey(lookupKey);
    if (already) {
      // A replayed credential must never charge twice. mppx's own activation
      // lock covers the concurrent case; this covers the sequential one and
      // gives the caller their existing subscription back instead of a second.
      const existing = await findBySubscriptionId(already.subscriptionId);
      if (existing) return { ...publicView(existing), replay: true };
      // mppx records a subscription only once its first payment settled, so
      // its record without ours is a paid activation whose own record was
      // never written (a store failure or a restart in between). Activating
      // again would be refused by mppx as a used credential and answered as
      // "nothing was charged"; the buyer paid, so our record is rebuilt from
      // mppx's and the subscription is handed back.
      if (already.subscriptionId) {
        let r;
        try { r = await rebuildFromSettled(already, { b, payer, lookupKey }); }
        catch (err) {
          // The rebuild reopened any debt it voided; one is booked here when
          // none was (the first attempt died before answering).
          log(`[mpp-subs] rebuilding a settled first payment failed: ${diagnoseError(err, 300)}`);
          const booked = await oweFirstPayment({ product: b.product, payer, priceUsd: b.productDef.price / 100, tx: already.reference || null, lookupKey, why: "its record was not written" });
          // Another retry of this payment that rebuilt it while this one
          // failed served the buyer: the debt just booked is voided.
          const served = booked ? await voidIfServed(already.subscriptionId, already.reference || null, lookupKey) : null;
          if (served) return { ...publicView(served), replay: true };
          throw firstPaymentNotRecordedError(booked);
        }
        if (r.refused) {
          const e = new Error("A refund of this first subscription payment is already under way. Request a fresh challenge to subscribe again.");
          e.statusCode = 409; throw e;
        }
        if (!r.w.won) return { ...publicView(r.w.value), replay: true };
        return { ...publicView(r.w.value), manageToken: manageToken(r.w.value.subId), replay: true };
      }
    }

    // The payer screen, before anything is sent. A refused wallet gets the
    // per-call Tempo rail's answer; the offer's key is dropped at once, so the
    // authorization just signed for it can never be used.
    if (await screenPayer(payer, "before the first payment")) {
      await destroyAccessKey(b.accessKeyAddress);
      const e = new Error(TEMPO_SCREEN_REFUSED_DETAIL);
      e.statusCode = 402; e.screenRejected = true; throw e;
    }

    const doActivate = injectedActivate || defaultActivate;
    let receipt = null;
    try {
      const r = await doActivate(authorizationHeader, { binding: b, payer, accessKey: stored, lookupKey });
      receipt = r?.receipt || null;
    } catch (err) {
      // Never relay an upstream body: mppx errors are its own text, but a
      // transport failure can carry an RPC response, so it is truncated and
      // never re-served verbatim as a hint. Full text goes to our log only.
      log(`[mpp-subs] activation failed for ${b.product}: ${diagnoseError(err)}`);
      const e = new Error("The first subscription payment did not settle. Nothing was charged; request a fresh challenge and try again.");
      e.statusCode = 402;
      throw e;
    }

    // mppx wrote its own record during activation; read it back so OUR record
    // mirrors ITS billing anchor and period counter. mppx is the authority on
    // what has been charged, and duplicating that arithmetic is how the two
    // silently disagree.
    // From here on the first period has settled: a failure books it owed
    // (once, keyed on its settlement) before the buyer is answered, so a
    // buyer who does not retry is refunded. A retry that rebuilds the
    // subscription voids that debt (rebuildFromSettled).
    let mppxRec = null, rec, w;
    try {
      mppxRec = await subStore.getByKey(lookupKey);
      if (!mppxRec) throw new Error("subscription did not persist after settlement");
      rec = houseRecordFrom(mppxRec, { b, payer, lookupKey, receipt });
      rec = withPeriodReceipt(rec, rec.lastChargedPeriod, rec.lastChargeTx);
      // Created only when absent: a retry of this credential that rebuilt the
      // record while this activation was settling already booked the period.
      w = await writeRecIfAbsent(rec);
    } catch (err) {
      log(`[mpp-subs] first payment settled for ${b.product} but no record was written: ${diagnoseError(err, 300)}`);
      let stored = null;
      try { stored = mppxRec ? await findBySubscriptionId(mppxRec.subscriptionId) : null; } catch { stored = null; }
      if (stored) return { ...publicView(stored), replay: true };
      const tx = receipt?.reference || mppxRec?.reference || null;
      const booked = await oweFirstPayment({ product: b.product, payer, priceUsd: b.productDef.price / 100, tx, lookupKey, why: "its record was not written" });
      // A retry of this credential that rebuilt the record between the read
      // above and the booking was served: the debt just booked is voided.
      if (booked && mppxRec) {
        const served = await voidIfServed(mppxRec.subscriptionId, tx, lookupKey);
        if (served) return { ...publicView(served), replay: true };
      }
      throw firstPaymentNotRecordedError(booked);
    }
    const subId = rec.subId;
    // Paid: the offer's marker has done its job (its key bills the subscription).
    try { await dropOfferMarkers(b.accessKeyAddress); } catch { /* the offer sweep drops it */ }
    if (w.won) {
      bookCharge(w.value, w.value.lastChargedPeriod, w.value.lastChargeTx);
      log(`[mpp-subs] activated ${subId} (${rec.product} -> ${rec.target}) payer=${shortPayer(payer)} tx=${rec.lastChargeTx || "?"}`);
    }
    return { ...publicView(w.value), manageToken: manageToken(subId), receipt: receiptHeader(receipt), replay: false };
  }

  /** Our subscription record for a settled mppx record: the scheduler-facing
   *  fields from the binding, the billing anchor and period counter from mppx
   *  (the authority on what has been charged). */
  function houseRecordFrom(mppxRec, { b, payer, lookupKey, receipt }) {
    const subId = `${SUB_PREFIX}${mppxRec.subscriptionId}`;
    return {
      subId,
      // The scheduler-facing shape (same fields the Stripe records carry).
      status: "active", product: b.product, target: b.target, email: b.email,
      customer: null, createdAt: new Date(now()).toISOString(),
      // MPP specifics.
      rail: "mpp-tempo", wire: "mpp-tempo-subscription",
      mppxSubscriptionId: mppxRec.subscriptionId, lookupKey,
      payer, accessKeyAddress: b.accessKeyAddress,
      currency, chainId: TEMPO_MAINNET_CHAIN_ID,
      amountAtomic: String(mppxRec.amount), priceUsd: b.productDef.price / 100,
      periodCount: String(mppxRec.periodCount), periodUnit: String(mppxRec.periodUnit),
      billingAnchor: mppxRec.billingAnchor, lastChargedPeriod: mppxRec.lastChargedPeriod ?? 0,
      subscriptionExpires: mppxRec.subscriptionExpires || b.subscriptionExpires,
      lastChargeTx: receipt?.reference || mppxRec.reference || null,
      lastChargeAt: new Date(now()).toISOString(),
      chargeFailures: 0, firstFailedAt: null, nextChargeAttemptAt: null, lastChargeError: null,
      cancelAtPeriodEnd: false, canceledAt: null, canceledReason: null,
      // Marks a rail-proof subscription. Two consequences: its settlements are
      // booked as our own money (never external demand), and it is the only
      // kind of subscription whose owner may drive refreshStatus on demand.
      canary: isCanaryProduct(b.product),
    };
  }

  // The record with one confirmed period's signed receipt kept on it: only a
  // period whose transfer is confirmed (named by its transaction hash), signed
  // once per period. Never throws: the record is returned as it was.
  function withPeriodReceipt(rec, periodIndex, tx, at = now()) {
    if (typeof signPeriod !== "function" || typeof tx !== "string" || !tx) return rec;
    try {
      const r = signPeriod({
        rail: "mpp-subscription", network: `eip155:${rec.chainId || TEMPO_MAINNET_CHAIN_ID}`, payer: rec.payer || null,
        subscription: rec.subId, product: rec.product, target: rec.target,
        period: periodIndex == null ? null : String(periodIndex), settlement: tx, priceUsd: rec.priceUsd, paidAt: at,
      });
      return r && typeof r.receipt === "string" ? { ...rec, signedReceipts: appendPeriodReceipt(rec.signedReceipts, r) } : rec;
    } catch { return rec; }
  }
  function receiptHeader(receipt) {
    if (!receipt) return null;
    try { return Receipt.serialize(receipt); } catch { return null; }
  }
  function bookCharge(rec, periodIndex, tx) {
    if (typeof onCharge !== "function") return;
    try { onCharge({ subId: rec.subId, product: rec.product, priceUsd: rec.priceUsd, payer: rec.payer, tx: tx || null, periodIndex, synthetic: !!rec.canary, currency: rec.currency, chainId: rec.chainId }); }
    catch { /* accounting never breaks billing */ }
  }

  async function findBySubscriptionId(mppxId) {
    return readRec(`${SUB_PREFIX}${mppxId}`);
  }

  // --- a settled first payment with no record of ours --------------------------
  // The refund ledger, read on first use (an injected one in tests).
  let _ledger = refunds;
  async function ledger() {
    if (_ledger) return _ledger;
    const m = await import("./refund-ledger.js");
    _ledger = { recordOwed: m.recordRefundOwed, voidForServe: m.voidOwedForServe, reopenHeld: m.reopenHeldClaim, renoteVoid: m.renoteVoidRefund, byEvidence: (ev) => m.refundByEvidenceFresh(ev) };
    return _ledger;
  }
  const REBUILD_HELD_NOTE = "mpp subscription rebuilt from its settled first payment";
  const REBUILD_SERVED_NOTE = "its subscription was handed back";
  /** The evidence a first payment's debt is keyed on: its settlement reference, else its lookup key. */
  const firstPaymentEvidence = (tx, lookupKey) => (typeof tx === "string" && tx.trim() ? tx.trim() : `mpp-sub-activation:${lookupKey}`);
  const firstPaymentEvidences = (tx, lookupKey) => [...new Set([firstPaymentEvidence(tx, lookupKey), firstPaymentEvidence(null, lookupKey)])];
  /** A debt a rebuild voided and has not yet finished: the void APPENDS its
   *  note to the owed one, so the held row's note ends with it (and a served
   *  rebuild's note goes on past it). */
  const isRebuildHeld = (row) => !!row && row.status === "void" && typeof row.note === "string"
    && (row.note === REBUILD_HELD_NOTE || row.note.endsWith(`; ${REBUILD_HELD_NOTE}`));
  /** Book a settled first payment that has no subscription as owed, once.
   *  Resolves true when the ledger holds a row for it (this one or earlier). */
  async function oweFirstPayment({ product, payer, priceUsd, tx, lookupKey, why }) {
    const evidence = firstPaymentEvidence(tx, lookupKey);
    try {
      const L = await ledger();
      await L.recordOwed({ slug: String(product || "mpp-subscription"), network: "tempo", payer, priceUsd, tx: evidence, httpStatus: 500, synthetic: isCanaryProduct(product), wire: "mpp-tempo-subscription", note: `first subscription payment settled; ${why}` });
      if (await L.byEvidence(evidence)) {
        log(`[mpp-subs] first payment booked owed (${why}) payer=${shortPayer(payer)} evidence=${evidence.slice(0, 80)}`);
        return true;
      }
    } catch (e) { log(`[mpp-subs] owed booking failed: ${String(e?.message || e).slice(0, 160)}`); }
    log(`[mpp-subs] first payment NOT booked owed (${why}) payer=${shortPayer(payer)} evidence=${evidence.slice(0, 80)}`);
    return false;
  }
  /** Owe again a debt a rebuild voided and did not finish. True when the row
   *  is owed (or being sent, or paid) afterwards, false while it is still held. */
  async function reopenRebuildHeld(evidence, why) {
    const L = await ledger();
    const row = await L.byEvidence(evidence);
    if (!isRebuildHeld(row)) return !!row && row.status !== "void";
    const base = row.note === REBUILD_HELD_NOTE ? "first subscription payment settled" : row.note.slice(0, -(`; ${REBUILD_HELD_NOTE}`).length);
    try { await L.reopenHeld(evidence, { held: row.note, httpStatus: 500, note: `${base}; ${why}` }); } catch { /* read back below */ }
    const after = await L.byEvidence(evidence);
    const owed = !!after && after.status !== "void";
    log(`[mpp-subs] first-payment debt ${owed ? "reopened" : "NOT reopened"} (${why}) evidence=${evidence.slice(0, 80)}`);
    return owed;
  }
  /** Void every owed debt for a first payment whose subscription is ours
   *  (served), with the note a finished rebuild leaves. Never throws. */
  async function voidServedDebts(tx, lookupKey, why) {
    try {
      const L = await ledger();
      for (const ev of firstPaymentEvidences(tx, lookupKey)) {
        if (await L.voidForServe(ev, `${REBUILD_HELD_NOTE}; ${REBUILD_SERVED_NOTE}`)) log(`[mpp-subs] first-payment debt voided (${why}) evidence=${ev.slice(0, 80)}`);
      }
    } catch (e) { log(`[mpp-subs] voiding a served first payment's debt failed (${why}): ${String(e?.message || e).slice(0, 160)}`); }
  }
  /** After booking a first payment owed: when our record for it exists (a
   *  concurrent retry rebuilt and served it), the debt is voided and that
   *  record is returned; else null. */
  async function voidIfServed(subscriptionId, tx, lookupKey) {
    if (!subscriptionId) return null;
    let served = null;
    try { served = await findBySubscriptionId(subscriptionId); } catch { served = null; }
    if (!served) return null;
    await voidServedDebts(tx, lookupKey, "served by a concurrent retry");
    return served;
  }
  async function reopenFirstPaymentDebts(voided, why) {
    for (const ev of voided) { try { await reopenRebuildHeld(ev, why); } catch (e) { log(`[mpp-subs] reopen failed for ${ev.slice(0, 80)}: ${String(e?.message || e).slice(0, 160)}`); } }
  }
  /**
   * Hand back the subscription a settled first payment bought, from mppx's
   * record. A debt booked for that payment is voided FIRST, so the buyer is
   * never both served and refunded; a debt already being sent or paid
   * refuses the rebuild ({ refused: true }). A record write that fails
   * reopens what was voided. Created only when absent: a concurrent retry
   * (or the activation still writing it) that got there first keeps its
   * record and its booking, and this call books nothing. A served rebuild
   * renotes the voided debt, so a void row still carrying the held note
   * means a rebuild that did not finish (recoverSettledOffer reopens it).
   */
  async function rebuildFromSettled(mppxRec, { b, payer, lookupKey }) {
    const L = await ledger();
    const voided = [];
    for (const ev of firstPaymentEvidences(mppxRec.reference, lookupKey)) {
      if (await L.voidForServe(ev, REBUILD_HELD_NOTE)) { voided.push(ev); continue; }
      const row = await L.byEvidence(ev);
      if (row && row.status !== "void") {
        await reopenFirstPaymentDebts(voided, "a refund of this first payment is under way");
        return { refused: true };
      }
    }
    let rebuilt = houseRecordFrom(mppxRec, { b, payer, lookupKey, receipt: null });
    rebuilt = withPeriodReceipt(rebuilt, rebuilt.lastChargedPeriod, rebuilt.lastChargeTx);
    if (mppxRec.canceledAt) { rebuilt.status = "canceled"; rebuilt.canceledAt = String(mppxRec.canceledAt); }
    let w;
    try { w = await writeRecIfAbsent(rebuilt); }
    catch (e) { await reopenFirstPaymentDebts(voided, "rebuilding its subscription record failed"); throw e; }
    for (const ev of voided) {
      try { const row = await L.byEvidence(ev); if (isRebuildHeld(row)) await L.renoteVoid(ev, row.note, `${row.note}; ${REBUILD_SERVED_NOTE}`); }
      catch { /* the record exists, so the offer sweep never reaches this row */ }
    }
    // A debt booked after the voids above and before the write (an
    // activation of this payment whose own record write failed, booking
    // while this rebuild wrote) is voided now that the record is ours: the
    // buyer is served, never served and refunded. A booking that lands after
    // this read finds the record and voids itself (voidIfServed).
    if (w.won) await voidServedDebts(mppxRec.reference, lookupKey, "booked while its subscription was rebuilt");
    try { await dropOfferMarkers(b.accessKeyAddress); } catch { /* the offer sweep drops it */ }
    if (w.won) {
      bookCharge(w.value, w.value.lastChargedPeriod, w.value.lastChargeTx);
      log(`[mpp-subs] rebuilt ${rebuilt.subId} from its settled first payment (${rebuilt.product} -> ${rebuilt.target}) payer=${shortPayer(payer)} tx=${rebuilt.lastChargeTx || "?"}`);
    }
    return { w };
  }
  /** mppx's record of a settled subscription for one access key, in a store snapshot (matched by content). */
  function settledRecordFor(address, snap) {
    const suffix = `|${String(address || "").toLowerCase()}`;
    for (const [k, v] of Object.entries(snap)) {
      if (k.startsWith("a402:") || !v || typeof v !== "object" || Array.isArray(v) || v.privateKey) continue;
      if (typeof v.subscriptionId === "string" && typeof v.lookupKey === "string" && v.lookupKey.toLowerCase().endsWith(suffix)) return v;
    }
    return null;
  }
  /**
   * An expired offer whose first payment settled with no record of ours.
   * The ledger is read FIRST: any row for the payment (owed, sending, paid,
   * or a void a rebuild left held) means the buyer was answered, or a
   * rebuild began, so the debt stands (a held one is owed again) and the
   * key goes: a subscription the buyer was told is refunded is never
   * rebuilt behind them. With no row (the process died before answering),
   * the subscription is rebuilt from the offer only when the offer names an
   * email to deliver to (and to carry the manage link); otherwise the
   * payment is booked owed. Returns "rebuilt", "owed", or null when nothing
   * landed (the sweep keeps the offer and its key and tries again).
   */
  async function recoverSettledOffer(mppxRec, marker, address) {
    const lookupKey = String(mppxRec.lookupKey);
    const payer = lookupKey.split("|")[0].toLowerCase();
    const productDef = productDefFor(marker?.product);
    const L = await ledger();
    const rows = [];
    for (const ev of firstPaymentEvidences(mppxRec.reference, lookupKey)) { const row = await L.byEvidence(ev); if (row) rows.push([ev, row]); }
    if (rows.length) {
      for (const [ev, row] of rows) {
        if (isRebuildHeld(row) && !(await reopenRebuildHeld(ev, "its rebuild did not finish before the offer expired"))) return null;
      }
      return "owed";
    }
    const target = typeof marker?.target === "string" ? marker.target : "";
    const email = typeof marker?.email === "string" && marker.email.trim() ? marker.email : null;
    if (productDef && target && email && /^0x[0-9a-f]{40}$/.test(payer)) {
      const b = { product: String(marker.product), productDef, target, email, accessKeyAddress: address, subscriptionExpires: mppxRec.subscriptionExpires };
      const r = await rebuildFromSettled(mppxRec, { b, payer, lookupKey });
      return r.refused ? "owed" : "rebuilt";
    }
    const atomic = Number(mppxRec.amount);
    const priceUsd = productDef ? productDef.price / 100 : (Number.isFinite(atomic) ? atomic / 10 ** decimals : 0);
    return (await oweFirstPayment({ product: marker?.product || null, payer, priceUsd, tx: mppxRec.reference, lookupKey, why: "found by the offer sweep" })) ? "owed" : null;
  }

  // --- period accounting -----------------------------------------------------
  /** Which period the clock says we are in. Anchored on mppx's own
   *  billingAnchor and the period length mppx computed, so this cannot drift
   *  from what the buyer signed. */
  function currentPeriodIndex(rec, at = now()) {
    const anchor = Date.parse(rec.billingAnchor);
    if (!Number.isFinite(anchor)) return 0;
    const len = periodMs(rec.periodCount || PERIOD_COUNT, rec.periodUnit || PERIOD_UNIT);
    return Math.max(0, Math.floor((at - anchor) / len));
  }
  /** The instant the period we have actually been PAID for runs out. */
  function paidThroughAt(rec) {
    const anchor = Date.parse(rec.billingAnchor);
    const len = periodMs(rec.periodCount || PERIOD_COUNT, rec.periodUnit || PERIOD_UNIT);
    return Number.isFinite(anchor) ? anchor + ((rec.lastChargedPeriod ?? 0) + 1) * len : 0;
  }

  const inFlight = new Set();

  /** Default period charge: mppx's own background biller. It reads its record,
   *  works out the due period itself, signs the transferWithMemo with the
   *  delegated access key and broadcasts it to a Tempo RPC. Returns null when
   *  mppx says nothing is due. */
  async function defaultChargePeriod(rec) {
    assertSigningAllowed("a subscription renewal");
    const result = await tempoServer.renewSubscription({
      subscriptionId: rec.mppxSubscriptionId,
      store: mppxKv,
      recipient,
      // The sponsor has to be passed HERE TOO. `renewSubscription` is a
      // standalone entry point: it calls createContext on its OWN parameters
      // rather than reusing the one the method was built with, so a fee payer
      // configured on `tempoServer.subscription(...)` does not reach it. Without
      // this the renewal takes mppx's unsponsored path and is signed with a zero
      // gas price - the live canary activated fine and then failed every renewal
      // with the same `-32000 gas price is less than basefee` the activation leg
      // had already been fixed for.
      ...(feePayer ? { feePayer, feePayerPolicy: subscriptionFeePayerPolicy() } : {}),
      getClient: () => tempoRenewalClient(),
    });
    return result ? { reference: result.receipt?.reference || result.subscription?.reference || null } : null;
  }

  /**
   * THE GATE. The scheduler calls this before every paid run, exactly as it
   * calls the Stripe path's refreshStatus. It is also where a due period is
   * pulled, so "is this subscriber paid up" and "charge them if not" are the
   * same question answered once, and there is no window where a report is
   * produced for a period nobody paid for.
   *
   * Returns "active" | "past_due" | "canceled" | "expired", or null for unknown.
   */
  async function refreshStatus(subId) {
    await ready;
    const rec = await readRec(subId);
    if (!rec) return null;
    const at = now();
    const first = await decide(rec, at);
    if (first.status !== undefined) return first.status;
    if (inFlight.has(subId)) return rec.status === "active" ? "past_due" : rec.status;

    // The same guard across containers: with a state database the pull for
    // this subscription runs under a lease, so two containers overlapping in
    // a deploy never sign the same renewal. When another holder has it (or
    // the database could not say) this call answers as it does for a pull
    // already in flight here, and signs nothing. Without a database the
    // lease is held trivially.
    //
    // Inside the lease the record is read again from the store (the other
    // container may have charged this period, or the subscriber cancelled
    // there, after the read above), the decision is made again on that copy,
    // and the attempt is claimed on the record itself: a versioned write that
    // only succeeds while the period is still unpaid and no claim for this
    // period and attempt exists. Only the claimer signs.
    const held = await withLease(`mpp-sub-renewal:${subId}`, { ttlMs: RENEWAL_LEASE_TTL_MS, log }, async (lease) => {
      let fresh;
      try { fresh = await kv.getFresh(REC_KEY(subId)); }
      catch (e) { log(`[mpp-subs] ${subId}: could not re-read the record before a renewal (${String(e?.message || e).slice(0, 120)}); nothing signed`); return rec.status === "active" ? "past_due" : rec.status; }
      if (!fresh) return null;
      if (fresh.status !== rec.status || fresh.cancelAtPeriodEnd !== rec.cancelAtPeriodEnd) cache.set(subId, fresh);
      const again = await decide(fresh, at);
      if (again.status !== undefined) return again.status;
      const due = again.due;
      // The claim is live while a pull runs and is cleared when it ends; one
      // left by a container that died mid-pull expires with the lease's TTL
      // (a send that may have landed is covered by unconfirmedCharge, which
      // asks the chain before any second signature).
      const token = randomBytes(8).toString("hex");
      let claim;
      try {
        claim = await kv.compareAndSet(REC_KEY(subId), (cur) => {
          if (!cur || cur.status === "canceled" || cur.status === "expired" || cur.cancelAtPeriodEnd) return null;
          if ((cur.lastChargedPeriod ?? 0) >= due) return null;
          const c = cur.chargeClaim;
          if (c && Date.parse(c.until) > at) return null;
          return { ...cur, chargeClaim: { period: due, token, by: leaseOwnerId(), until: new Date(at + RENEWAL_LEASE_TTL_MS).toISOString() } };
        });
      } catch (e) {
        log(`[mpp-subs] ${subId}: renewal claim failed (${String(e?.message || e).slice(0, 120)}); nothing signed`);
        return fresh.status === "active" ? "past_due" : fresh.status;
      }
      if (!claim.won) {
        const seen = claim.value || fresh;
        cache.set(subId, seen);
        if ((seen.lastChargedPeriod ?? 0) >= due) return "active";
        log(`[mpp-subs] ${subId}: a pull for period ${due} is already claimed; nothing signed here`);
        return seen.status === "active" ? "past_due" : seen.status;
      }
      // Fencing: pull() checks the lease right before it signs, so a renewal
      // whose lease was lost (another container may hold it now) signs
      // nothing; the claim above already keeps a second container from
      // pulling the same period.
      try { return await pull(claim.value, subId, due, at, () => lease.stillHeld()); }
      finally {
        await kv.compareAndSet(REC_KEY(subId), (cur) => (cur?.chargeClaim?.token === token ? { ...cur, chargeClaim: null } : null))
          .then((r) => { if (r.value) cache.set(subId, r.value); })
          .catch((e) => log(`[mpp-subs] ${subId}: clearing the renewal claim failed (${String(e?.message || e).slice(0, 120)}); it expires on its own`));
      }
    });
    if (!held.ran) return rec.status === "active" ? "past_due" : rec.status;
    return held.result;
  }
  /**
   * The status decision for one record at `at`: { status } when the answer
   * needs no charge (after any status write it implies), or { due } when a
   * period is owed and may be pulled.
   */
  async function decide(rec, at) {
    if (rec.status === "canceled" || rec.status === "expired") return { status: rec.status };
    // The standing authorization has a hard end. Past it no pull can succeed,
    // so stop pretending otherwise.
    const term = Date.parse(rec.subscriptionExpires);
    if (Number.isFinite(term) && at >= term) { await writeRecKeepingCancel({ ...rec, status: "expired" }); return { status: "expired" }; }
    const due = currentPeriodIndex(rec, at);
    if (due <= (rec.lastChargedPeriod ?? 0)) {
      if (rec.status !== "active") await writeRecKeepingCancel({ ...rec, status: "active" });
      return { status: "active" };
    }
    // A new period is due.
    if (rec.cancelAtPeriodEnd) {
      await writeRecKeepingCancel({ ...rec, status: "canceled", canceledAt: rec.canceledAt || new Date(at).toISOString(), canceledReason: rec.canceledReason || "requested" });
      return { status: "canceled" };
    }
    if (rec.nextChargeAttemptAt && at < Date.parse(rec.nextChargeAttemptAt)) return { status: rec.status === "active" ? "past_due" : rec.status };
    return { due };
  }
  async function pull(rec, subId, due, at, stillHeld = () => true) {
    inFlight.add(subId);
    try {
      // CHAIN TRUTH FIRST. A previous pull for this period died in the send
      // phase; whether it landed is a fact on the chain, and only that fact
      // decides between "record it" and "sign again".
      if (rec.unconfirmedCharge && rec.unconfirmedCharge.periodIndex === due) {
        const mppxRec = await subStore.get(rec.mppxSubscriptionId);
        const find = injectedFindRenewal || defaultFindRenewalOnChain;
        const verdict = await find({ rec, mppxRec, periodIndex: due, sinceMs: Date.parse(rec.unconfirmedCharge.at) - UNCONFIRMED_LOOKBACK_MS });
        // Only an explicit {found:false} may lead to a new transfer: null (unreadable),
        // {unknown:true} (undecidable) or any other shape waits and signs nothing.
        const decided = !!verdict && !verdict.unknown && ((verdict.found === true && typeof verdict.tx === "string" && verdict.tx !== "") || verdict.found === false);
        if (!decided) {
          const next = { ...rec, status: rec.status === "active" ? "past_due" : rec.status, nextChargeAttemptAt: new Date(at + TRANSIENT_CHARGE_BACKOFF_MS).toISOString() };
          await writeRecKeepingCancel(next, { ownPull: true });
          log(`[mpp-subs] ${subId}: unconfirmed period ${due} and the chain ${verdict === null ? "is unreadable" : `could not decide (${verdict?.reason || "unknown"})`} - waiting, not re-charging`);
          return next.status;
        }
        if (verdict.found === true) {
          if (mppxRec && (mppxRec.lastChargedPeriod ?? 0) < due) {
            await subStore.put({ ...mppxRec, lastChargedPeriod: due, reference: verdict.tx, timestamp: new Date(at).toISOString(), inFlightPeriod: undefined, inFlightAttempt: undefined, inFlightReference: undefined, inFlightStartedAt: undefined });
          }
          const next = withPeriodReceipt({
            ...rec, status: "active", lastChargedPeriod: due, lastChargeTx: verdict.tx, lastChargeAt: new Date(at).toISOString(),
            chargeFailures: 0, firstFailedAt: null, nextChargeAttemptAt: null, lastChargeError: null, unconfirmedCharge: null,
          }, due, verdict.tx, at);
          await writeRecKeepingCancel(next, { ownPull: true });
          bookCharge(next, due, verdict.tx);
          log(`[mpp-subs] reconciled ${subId} period ${due} from the chain: the send that timed out had landed, tx=${verdict.tx} - not charged twice`);
          return "active";
        }
        // Not on chain YET is not "never landed": until its validBefore has
        // passed, the timed-out transaction can still be included. Wait.
        const settleableUntil = Date.parse(rec.unconfirmedCharge.settleableUntil || "") ||
          (Date.parse(rec.unconfirmedCharge.at) + renewalValidForS * 1000 + SETTLEABLE_SLACK_MS);
        if (at < settleableUntil) {
          const next = { ...rec, status: rec.status === "active" ? "past_due" : rec.status, nextChargeAttemptAt: new Date(settleableUntil).toISOString() };
          await writeRecKeepingCancel(next, { ownPull: true });
          log(`[mpp-subs] ${subId}: unconfirmed period ${due} not on chain yet and still settleable - waiting, not re-charging`);
          return next.status;
        }
        rec = { ...rec, unconfirmedCharge: null };
        await writeRecKeepingCancel(rec, { ownPull: true });
        log(`[mpp-subs] ${subId}: the send that timed out for period ${due} never landed - charging now`);
      }
      // The payer screen, before this period is signed. A wallet refused now
      // is not charged and the subscription ends here: the write below is an
      // ending write, so the key is destroyed and the record reduced with it.
      if (await screenPayer(rec.payer, "before a renewal")) {
        await writeRecKeepingCancel({
          ...rec, status: "canceled", canceledAt: new Date(at).toISOString(), canceledReason: SCREEN_ENDED_REASON,
          nextChargeAttemptAt: null,
        }, { ownPull: true });
        log(`[mpp-subs] ${subId}: period ${due} not sent (payer screening); subscription ended, nothing charged`);
        return "canceled";
      }
      if (!stillHeld()) {
        log(`[mpp-subs] ${subId}: the renewal lease was lost before period ${due} was signed; nothing signed`);
        return rec.status === "active" ? "past_due" : rec.status;
      }
      const charge = injectedChargePeriod || defaultChargePeriod;
      const result = await charge(rec, { periodIndex: due });
      // mppx owns the counter; re-read rather than assume, so a partial success
      // (charged but our own write lost) self-corrects on the next tick.
      const mppxRec = await subStore.get(rec.mppxSubscriptionId);
      const charged = mppxRec?.lastChargedPeriod ?? (result ? due : (rec.lastChargedPeriod ?? 0));
      if (charged <= (rec.lastChargedPeriod ?? 0)) throw new Error(result === null ? "renewal reported nothing due while a period is outstanding" : "renewal did not advance the paid period");
      const paid = {
        ...rec, status: "active", lastChargedPeriod: charged,
        billingAnchor: mppxRec?.billingAnchor || rec.billingAnchor,
        lastChargeTx: result?.reference || mppxRec?.reference || null,
        lastChargeAt: new Date(at).toISOString(),
        chargeFailures: 0, firstFailedAt: null, nextChargeAttemptAt: null, lastChargeError: null, unconfirmedCharge: null,
      };
      const next = withPeriodReceipt(paid, charged, paid.lastChargeTx, at);
      await writeRecKeepingCancel(next, { ownPull: true });
      bookCharge(next, charged, next.lastChargeTx);
      log(`[mpp-subs] charged ${subId} period ${charged} tx=${next.lastChargeTx || "?"}`);
      return "active";
    } catch (err) {
      // Fail CLOSED. No confirmed transfer means the subscription is not paid
      // up, and the scheduler will refuse the paid run on the strength of this
      // status alone. The buyer's message never carries the upstream body.
      const failures = (rec.chargeFailures || 0) + 1;
      const firstFailedAt = rec.firstFailedAt || new Date(at).toISOString();
      const transient = isTransientChargeError(err);
      // The bounded schedule (RENEWAL RETRIES): null once a failure lands at
      // or after the end of the grace window, which ends the subscription.
      const nextAt = nextRenewalAttemptAt({ failures, transient, firstFailedAtMs: Date.parse(firstFailedAt), atMs: at });
      const givenUp = nextAt === null;
      const backoff = givenUp ? 0 : nextAt - at;
      const ambiguous = isSendPhaseAmbiguity(err);
      // The transaction was signed before this failure surfaced, so its
      // validBefore is at most now + the window: past that (plus slack) it
      // cannot land, and only then may the chain's silence mean "never sent".
      const settleableUntil = now() + renewalValidForS * 1000 + SETTLEABLE_SLACK_MS;
      const next = {
        ...rec, chargeFailures: failures, firstFailedAt,
        nextChargeAttemptAt: givenUp ? null : new Date(ambiguous ? Math.max(at + backoff, settleableUntil) : at + backoff).toISOString(),
        lastChargeError: String(err?.message || err).slice(0, 200),
        ...(ambiguous ? { unconfirmedCharge: { at: new Date(at).toISOString(), periodIndex: due, settleableUntil: new Date(settleableUntil).toISOString() } } : {}),
        status: givenUp ? "canceled" : "past_due",
        ...(givenUp ? { canceledAt: new Date(at).toISOString(), canceledReason: "unpaid" } : {}),
      };
      await writeRecKeepingCancel(next, { ownPull: true });
      log(`[mpp-subs] period charge failed for ${subId} (attempt ${failures}${givenUp ? ", giving up: every retry in the grace window failed" : `, retry in ${Math.round(backoff / 60000)}m${transient ? " (transient)" : ""}${ambiguous ? ", chain checked before any retry" : ""}`}): ${diagnoseError(err)}`);
      return next.status;
    } finally { inFlight.delete(subId); }
  }

  // --- cancellation ----------------------------------------------------------
  /** The subscriber stops the recurring pull. We honour the period they already
   *  paid for: no further charge is ever attempted, and the subscription stays
   *  active until that period ends. Requires the manage token minted at
   *  activation, which only the subscriber (and their email) ever saw. */
  async function cancel(subId, token) {
    await ready;
    const rec = await readRec(subId);
    if (!rec) { const e = new Error("Unknown subscription"); e.statusCode = 404; throw e; }
    if (!manageTokenOk(subId, token)) { const e = new Error("Not authorized to manage this subscription"); e.statusCode = 403; throw e; }
    if (rec.status === "canceled") return publicView(rec);
    const at = now();
    const endsAt = paidThroughAt(rec);
    // The rail canary's own subscription closes AT ONCE. Honouring the paid
    // period is a promise to a subscriber; the canary is our own money on both
    // ends, and nothing else ever refreshes a canary record (listActive skips
    // its product, and only the canary's own ?refresh=1 pulls it), so "cancel
    // at period end" left canary records reading `active` indefinitely.
    const canaryRec = isCanaryProduct(rec.product);
    let stillPaid = !canaryRec && at < endsAt && rec.status === "active";
    let endsAtNow = endsAt;
    // Decided on the record as it is when written (a renewal on either
    // container may have just paid a period), never on the copy read above.
    const r = await kv.compareAndSet(REC_KEY(subId), (cur) => {
      if (!cur || cur.status === "canceled") return null;
      endsAtNow = paidThroughAt(cur);
      stillPaid = !canaryRec && at < endsAtNow && cur.status === "active";
      return {
        ...cur, cancelAtPeriodEnd: true,
        canceledAt: new Date(at).toISOString(), canceledReason: "requested",
        status: stillPaid ? "active" : "canceled",
        updatedAt: new Date(at).toISOString(),
      };
    });
    const next = r.value || rec;
    cache.set(subId, next);   // listActive/get are synchronous for the scheduler
    // Once a cancel is stored no later period is ever pulled (the claim and
    // the status decision both refuse it), so our private half of the access
    // key goes now, also while the paid period runs on: the subscriber's
    // standing authorization is inert from this moment. A record that closed
    // at once is reduced in the same step; one still in its paid period is
    // reduced by the sweep when that period ends.
    if (isEnded(next)) await finishEnded(subId, { at });
    else if (next.cancelAtPeriodEnd) await destroyAccessKey(next.accessKeyAddress || rec.accessKeyAddress, null, { mark: true });
    if (r.won) log(`[mpp-subs] canceled ${subId} (${stillPaid ? `active until ${new Date(endsAtNow).toISOString()}` : "immediately"})`);
    return publicView(cache.get(subId) || next);
  }

  /** Close every rail-canary subscription a canary run failed to close itself
   *  (a crashed run, a refused cancel, or a record from before cancel() closed
   *  canary records at once). CANARY ONLY: the product is read from the STORED
   *  record and must be the canary product; a real subscriber is never
   *  touched, whatever its age or status. A record younger than `olderThanMs`
   *  may belong to a run still in flight, so it is left alone. Writes status
   *  only: no money moves and nothing is signed. Returns what it closed, with
   *  each record's access key address so the burner can revoke it on-chain. */
  async function sweepStaleCanaries({ olderThanMs = CANARY_SWEEP_AFTER_MS } = {}) {
    await ready;
    const at = now();
    const swept = [];
    let skippedYoung = 0;
    for (const rec of await allRecs()) {
      if (!isCanaryProduct(rec.product)) continue;
      if (rec.status === "canceled" || rec.status === "expired") continue;
      const born = Date.parse(rec.createdAt || rec.billingAnchor || "");
      if (Number.isFinite(born) && at - born < olderThanMs) { skippedYoung++; continue; }
      const r = await kv.compareAndSet(REC_KEY(rec.subId), (cur) => (cur && cur.status !== "canceled" && cur.status !== "expired" && isCanaryProduct(cur.product)
        ? { ...cur, status: "canceled", cancelAtPeriodEnd: true, canceledAt: cur.canceledAt || new Date(at).toISOString(), canceledReason: cur.canceledReason || "canary-sweep", updatedAt: new Date(at).toISOString() }
        : null));
      if (r.value) cache.set(rec.subId, r.value);
      if (!r.won) continue;
      const keysDestroyed = await destroyAccessKey(rec.accessKeyAddress, null, { mark: true });
      await finishEnded(rec.subId, { at });
      swept.push({ subId: rec.subId, accessKeyAddress: rec.accessKeyAddress || null, keysDestroyed });
    }
    if (swept.length) log(`[mpp-subs] canary sweep closed ${swept.length} stale rail-canary subscription(s)`);
    return { swept, skippedYoung };
  }

  // --- read surfaces ---------------------------------------------------------
  function publicView(rec) {
    return {
      subId: rec.subId, status: rec.status, product: rec.product, target: rec.target,
      label: productDefFor(rec.product)?.label || "monitor",
      priceUsdPerPeriod: rec.priceUsd, currency: rec.currency, chainId: rec.chainId,
      payer: rec.payer, rail: rec.rail,
      billingAnchor: rec.billingAnchor, periodSeconds: periodMs(rec.periodCount, rec.periodUnit) / 1000,
      lastChargedPeriod: rec.lastChargedPeriod, paidThrough: new Date(paidThroughAt(rec)).toISOString(),
      subscriptionExpires: rec.subscriptionExpires,
      cancelAtPeriodEnd: !!rec.cancelAtPeriodEnd, canceledAt: rec.canceledAt || null,
      // Why it ended, when it has: requested, unpaid, payer-not-accepted (with
      // the refusal text the first payment would have been answered with).
      canceledReason: rec.canceledReason || null,
      ...(rec.canceledReason === SCREEN_ENDED_REASON ? { notice: TEMPO_SCREEN_REFUSED_DETAIL } : {}),
      lastChargeAt: rec.lastChargeAt || null, lastChargeTx: rec.lastChargeTx || null,
      // Each confirmed period's signed receipt (the newest last), with the
      // period statement its answer digest covers.
      signedReceipts: publicReceipts(rec),
      // Deliberately NOT exposed: chargeFailures/lastChargeError text on the
      // public view (operator surface only) - it can quote a node's words.
    };
  }

  /** Is this subscription id one of ours? Lets server.js route refreshStatus
   *  and get() to the right engine without a lookup in both. */
  const isMine = (subId) => typeof subId === "string" && subId.startsWith(SUB_PREFIX);
  /** Is this one of the rail canary's own subscriptions? Read from the STORED
   *  record, never from a caller's word, so nothing a request says can turn a
   *  real subscriber into a canary one. */
  function isCanarySub(subId) {
    const rec = cache.get(subId);
    return !!(rec && (rec.canary || isCanaryProduct(rec.product)));
  }

  // Synchronous mirrors for the scheduler, which calls listActive()/get()
  // synchronously (the Stripe engine holds its store in memory too). Kept warm
  // by every write; refreshStatus stays the async authority.
  let cache = new Map();
  function warmSync() {
    const snap = kv._snapshot();
    cache = new Map(Object.entries(snap).filter(([k]) => k.startsWith("a402:sub:")).map(([, v]) => [v.subId, v]));
    return cache;
  }
  async function warm() {
    const recs = await allRecs();
    cache = new Map(recs.map((r) => [r.subId, r]));
    return cache;
  }
  warmSync();   // no boot window with an invisible subscriber
  // With a state database the row arrives after construction: the server
  // awaits every store's first load before it listens (trackStoreReady), and
  // every async entry point here awaits it too, so no pull or activation
  // runs against an empty map.
  const ready = kv._ready.then(() => { warmSync(); });
  // The scheduler reads listActive() synchronously; with a database the
  // other container's activations and cancels reach it through a background
  // re-read of the row at most every 30 s (refreshStatus re-reads each record
  // before any charge whatever this mirror says).
  let mirrorAt = Date.now(), mirroring = null;
  function refreshMirror(force = false) {
    if (kv.backend !== "pg" || mirroring || (!force && Date.now() - mirrorAt < 30_000)) return mirroring;
    mirroring = kv.refreshAll().then((okRead) => { if (okRead) { warmSync(); mirrorAt = Date.now(); } return okRead; })
      .catch(() => false).finally(() => { mirroring = null; });
    return mirroring;
  }
  function listActive(kind) {
    refreshMirror();
    const out = [];
    for (const rec of cache.values()) {
      const p = MONITOR_PRODUCTS[rec.product];
      if (!p) continue;
      if (kind && p.kind !== kind) continue;
      // Only an active record is listed. One whose paid period has run out
      // while its stored status still reads active IS listed: renewals are
      // pulled lazily, from the scheduler's stillActive gate (refreshStatus)
      // before a paid run, and the scheduler only reaches a listed record, so
      // leaving it out would leave its next period unpulled for good. A paid
      // run is made only once that pull confirms (otherwise the gate answers
      // past_due); the free checks run meanwhile.
      if (rec.status !== "active") continue;
      // Two cheap exclusions the stored status cannot express on its own,
      // because only refreshStatus rewrites it and a subscription with no paid
      // run pending would never be refreshed: a cancellation whose paid period
      // has now run out, and a standing authorization past its own expiry.
      if (rec.cancelAtPeriodEnd && now() >= paidThroughAt(rec)) continue;
      const term = Date.parse(rec.subscriptionExpires);
      if (Number.isFinite(term) && now() >= term) continue;
      out.push(rec);
    }
    return out;
  }
  const get = (subId) => cache.get(subId) || null;
  // The record as the store holds it now, for a buyer-facing read: a
  // subscription activated or cancelled on the other container moments ago
  // is not in this container's mirror until its next re-read. Falls back to
  // the mirror if the store cannot be read.
  async function getFresh(subId) {
    if (!isMine(subId)) return null;
    if (kv.backend !== "pg") return get(subId);
    try {
      const fresh = await kv.getFresh(REC_KEY(subId));
      if (fresh) cache.set(subId, fresh); else cache.delete(subId);
      return fresh || null;
    } catch { return get(subId); }
  }

  /** The subscriptionRenewals word, read from the mirror (re-read in the
   *  background like listActive). */
  function renewalsStatus({ full = false, env = process.env, at = now() } = {}) {
    refreshMirror();
    return renewalsWord([...cache.values()], { hours: renewalUnconfirmedAlertHours(env), at, full });
  }

  async function status() {
    await warm();
    return {
      enabled: true, recipient, currency, chainId: TEMPO_MAINNET_CHAIN_ID,
      periodSeconds: PERIOD_MS / 1000,
      renewals: renewalsWord([...cache.values()], { hours: renewalUnconfirmedAlertHours(), at: now(), full: true }),
      payerScreen: payerScreenView(),
      subs: [...cache.values()].map((rec) => ({
        ...publicView(rec),
        email: rec.email ? `${rec.email.slice(0, 2)}***` : null,
        chargeFailures: rec.chargeFailures || 0, lastChargeError: rec.lastChargeError || null,
        nextChargeAttemptAt: rec.nextChargeAttemptAt || null,
        unconfirmedChargeAt: rec.unconfirmedCharge?.at || null,
        accessKeyAddress: rec.accessKeyAddress,
        // A reduced record of an ended subscription: when it ended (it is
        // deleted ENDED_RECORD_KEEP_MS later) and that its key is gone.
        ...(rec.tombstone ? { reduced: true, endedAt: rec.endedAt || null, keyDestroyedAt: rec.keyDestroyedAt || null } : {}),
      })),
    };
  }

  return {
    offerInfo, mintOffer, activateFromCredential, refreshStatus, cancel, isCanarySub, sweepStaleCanaries,
    sweepEnded, retryDueRenewals, _retryDueRenewalsUnleased: retryDueRenewalsUnleased, sweepOffers: sweepOffersLeased, _sweepOffers: sweepOffers, start, stop, _sweepEndedUnleased: sweepEndedUnleased, _finishEnded: finishEnded, payerScreenView,
    listActive, get, getFresh, isMine, status, renewalsStatus, warm, warmSync, refreshMirror, manageToken, manageTokenOk, publicView,
    ready: () => ready, flush: () => kv.flush(),
    _store: kv, _subStore: subStore, _method: method,
    _feePayer: feePayer, _feePayerPolicy: feePayer ? subscriptionFeePayerPolicy() : null,
    _client: tempoClient, _renewalClient: tempoRenewalClient, _renewalValidForS: renewalValidForS, _activationValidForS: ACTIVATION_VALID_FOR_S,
    _currentPeriodIndex: currentPeriodIndex, _paidThroughAt: paidThroughAt, _readRec: readRec, _writeRec: writeRec,
  };
}
