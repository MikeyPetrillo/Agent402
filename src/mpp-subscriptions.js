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
// BILLING PERIOD HANDLING (the money rules, all fail-closed):
//   - Activation charges period 0 on-chain at subscribe time. No confirmed
//     transfer, no subscriber record: an unpaid activation is simply a 402.
//   - Every later period is pulled by us, lazily, from refreshStatus() - which
//     the scheduler already calls BEFORE every paid run (the exact gate the
//     Stripe path uses). A period whose charge has not confirmed leaves the
//     subscription "past_due", which the scheduler reads as not-active, so no
//     paid report is produced. Free probes and change detection keep running.
//   - A failed charge backs off (1h doubling to 24h) and is retried. If it has
//     not cleared within PAST_DUE_GRACE_MS the subscription is canceled as
//     unpaid and never charged again.
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
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Challenge, Credential, Method, Receipt } from "mppx";
import * as Tempo from "mppx/tempo";
import { tempo as tempoServer } from "mppx/server";
import { privateKeyToAccount } from "viem/accounts";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

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
// How long the standing authorization is good for. The buyer signs this, so it
// is the hard ceiling on how long we could ever pull from them.
export const SUBSCRIPTION_TERM_MS = 365 * 24 * 60 * 60 * 1000;
// How long a minted subscribe challenge stays payable.
export const CHALLENGE_TTL_MS = 10 * 60_000;
// Dunning: a period that never clears within this window ends the subscription.
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const CHARGE_BACKOFF_MS = 60 * 60_000;
export const MAX_CHARGE_BACKOFF_MS = 24 * 60 * 60_000;
// A TRANSIENT charge failure retries in minutes, not an hour. Measured
// 2026-09-02 (tempo-subscription-canary run 33657453172): the renewal's
// transferWithMemo reached rpc.tempo.xyz's eth_estimateGas with its
// `validBefore` two seconds in the past - viem's Tempo chain config stamps
// validBefore = now + 25 s on every request, and that minute our own
// tempo-volume run had the RPC answering in 7-20 s. The transfer never
// existed on chain, nobody was charged, and the next attempt an hour later
// would have succeeded - but an hour of past_due for a slow RPC is the wrong
// price, and for the canary it read as "the pull half of the rail is broken".
// A refused transfer (insufficient funds, revoked key) keeps the hour.
export const TRANSIENT_CHARGE_BACKOFF_MS = 2 * 60_000;
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
// 25 s), so a retry is a NEW transaction that would land beside an earlier one
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
/** How far back the chain is read for an unconfirmed renewal: the expiring nonce means a sent transaction can only land within ~25 s, so a minute either side is generous. */
export const UNCONFIRMED_LOOKBACK_MS = 60_000;
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
// Every unpaid 402 mints and PERSISTS a server-owned access key, so an
// unauthenticated caller can write to the shared /data volume by asking for
// offers it never pays. Bounded two ways: unclaimed offers are swept once their
// challenge can no longer be paid, and minting refuses outright past the cap
// (the disk-fill guard, same posture as the memory namespace byte budget).
export const OFFER_SWEEP_AFTER_MS = 2 * CHALLENGE_TTL_MS;
export const MAX_OPEN_OFFERS = 500;

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
 * receipt's `feeToken`), and gas*price converts to token units at ~1e12: the
 * measured charge tx paid 28 units, i.e. $0.000028. At the live 0.6 gwei basefee
 * this ceiling is worth $0.0036 per transaction, while mppx's untouched
 * `maxTotalFee` still refuses anything over $0.05 however far the gas price
 * moves. Against a $5/mo subscription both are noise.
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
    if (typeof hex !== "string" || !hex.startsWith("0x")) return { status: "unknown", asset: "PathUSD", chain: `eip155:${TEMPO_MAINNET_CHAIN_ID}` };
    const usd = Number(BigInt(hex)) / 1e6;
    // Bucketed, never the number: this rides a PUBLIC surface.
    return { status: usd < low ? "low" : "ok", asset: "PathUSD", chain: `eip155:${TEMPO_MAINNET_CHAIN_ID}` };
  } catch {
    return { status: "unknown", asset: "PathUSD", chain: `eip155:${TEMPO_MAINNET_CHAIN_ID}` };
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
/** Rollout switch. Call-time read, like every other knob in this repo. */
export function mppSubscriptionsEnabled() {
  if (String(process.env.MPP_SUBSCRIPTIONS || "").toLowerCase() === "off") return false;
  if (!(process.env.MPP_SECRET_KEY || "").trim()) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(envRecipient())) return false;
  // No sponsor, no rail. Without a fee payer every subscribe attempt is signed
  // with a zero gas price and refused by the chain, so mounting the routes
  // would advertise a product we provably cannot deliver - the endpoint would
  // 402 forever and the offer would be a lie. See subscriptionFeePayer().
  if (!subscriptionFeePayer()) return false;
  return mppSubscriptionMethodAvailable();
}

/** The period length mppx itself computes from our period fields, in ms. Read
 *  from mppx so our accounting can never drift from the number the buyer's
 *  signature actually committed to. */
export function periodMs(periodCount = PERIOD_COUNT, periodUnit = PERIOD_UNIT) {
  return Tempo.Subscription.toSubscriptionPeriodSeconds({ periodCount: String(periodCount), periodUnit }) * 1000;
}

// ---------------------------------------------------------------------------
// Store. ONE JSON file holds both mppx's own key-value entries (access keys,
// subscription records, activation locks - all under mppx's own prefixes) and
// our house subscriber records under `a402:sub:`. Same atomic tmp+rename and
// merge-on-save discipline as stripe-subscriptions.js. Prod runs one replica,
// so this is single-writer in practice; it is written to survive two anyway.
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
    // Test/ops visibility only. Never used for money decisions. `_snapshot`
    // exists so the engine can warm its synchronous read cache at construction:
    // the file was already read synchronously, and the scheduler calls
    // listActive()/get() synchronously, so there must be no boot window where a
    // paid-up subscriber is invisible.
    _keys: () => Object.keys(mem),
    _snapshot: () => JSON.parse(JSON.stringify(mem)),
  };
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
  const expected = BigInt(Math.round((p.price / 100) * 10 ** decimals));
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
function diagnoseError(err, max = 1200) {
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
    if (e.data !== undefined) bit.push(`data=${JSON.stringify(e.data).slice(0, 300)}`);
    if (e.details) bit.push(`details=${String(e.details).slice(0, 300)}`);
    if (e.shortMessage) bit.push(`short=${String(e.shortMessage).slice(0, 200)}`);
    if (e.metaMessages) bit.push(`meta=${JSON.stringify(e.metaMessages).slice(0, 300)}`);
    if (e.status !== undefined) bit.push(`status=${e.status}`);
    // The message can carry a full serialized transaction; keep it, keep it last,
    // and keep it short. Its useful head is the first line.
    if (e.message) bit.push(`msg=${String(e.message).split("\n")[0].slice(0, 200)}`);
    if (bit.length) parts.push(bit.join(" "));
  }
  const out = parts.join(" <- ") || String(err);
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

export function createMppSubscriptions({
  secretKey, realm, storePath, validateTarget = {}, onCharge,
  activate: injectedActivate = null, chargePeriod: injectedChargePeriod = null,
  findRenewalOnChain: injectedFindRenewal = null,
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
  const kv = createFileStore(storePath || STORE_PATH());
  const subStore = Tempo.Subscription.fromStore(kv);
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
    // a slow day (canary run 33659899394).
    _client = createClient({ chain: tempoChain, transport: http(process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz", { timeout: TEMPO_RPC_TIMEOUT_MS }) });
    return _client;
  }
  const clientOverride = () => ({ getClient: () => tempoClient() });

  /**
   * Default chain reader for an unconfirmed renewal: Transfer logs on the
   * subscription's currency from the payer to our recipient since the
   * attempt, value equal to the period amount, and the transaction's memo
   * equal to mppx's attribution for THIS subscription and period. Returns
   * {found:true, tx} | {found:false}; null when the chain could not be read
   * (the caller then waits rather than charging - an unreadable chain must
   * never become a second transfer).
   */
  async function defaultFindRenewalOnChain({ rec, mppxRec, periodIndex, sinceMs }) {
    try {
      const client = await tempoClient();
      const { getBlockNumber, getLogs, getTransaction, decodeFunctionData, parseAbi, parseUnits } = await import("viem");
      const head = await getBlockNumber(client);
      const secondsBack = Math.ceil((now() - sinceMs) / 1000) + 120; // Tempo blocks are ~1 s
      const fromBlock = head > BigInt(Math.min(secondsBack, 5000)) ? head - BigInt(Math.min(secondsBack, 5000)) : 0n;
      const amount = parseUnits(String(mppxRec?.amount ?? rec.priceUsd), Number(mppxRec?.decimals ?? decimals));
      const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "function transferWithMemo(address to, uint256 amount, bytes32 memo)"]);
      const logs = await getLogs(client, { address: rec.currency, event: abi[0], args: { from: rec.payer, to: recipient }, fromBlock, toBlock: "latest" });
      const memo = await expectedRenewalMemo({ lookupKey: mppxRec?.lookupKey, subscriptionId: rec.mppxSubscriptionId, periodIndex });
      for (const l of logs) {
        if (l.args?.value !== amount) continue;
        const tx = await getTransaction(client, { hash: l.transactionHash });
        let decoded = null;
        try { decoded = decodeFunctionData({ abi, data: tx.input }); } catch { decoded = null; }
        if (decoded?.functionName === "transferWithMemo" && String(decoded.args?.[2]).toLowerCase() === memo.toLowerCase()) return { found: true, tx: l.transactionHash };
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

  const method = tempoServer.subscription({
    // Every monitor product is priced the same today, and the activation path
    // never reads this default: `verify` works off the CHALLENGE's own request,
    // which we mint per product. It is set anyway so the method is never
    // constructed with an incomplete request shape.
    amount: (MONITOR_PRODUCTS["domain-monitor"].price / 100).toFixed(envDecimals()),
    currency, decimals, recipient, chainId: TEMPO_MAINNET_CHAIN_ID,
    periodCount: PERIOD_COUNT, periodUnit: PERIOD_UNIT,
    subscriptionExpires: new Date(Math.floor((Date.now() + SUBSCRIPTION_TERM_MS) / 1000) * 1000),
    store: kv,
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
  async function readRec(subId) { return (await kv.get(REC_KEY(subId))) || null; }
  async function writeRec(rec) {
    const next = { ...rec, updatedAt: new Date(now()).toISOString() };
    await kv.put(REC_KEY(rec.subId), next);
    cache.set(next.subId, next);   // listActive/get are synchronous for the scheduler
    return next;
  }
  async function allRecs() {
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
    for (const [key, marker] of Object.entries(snap)) {
      if (!key.startsWith("a402:offer:")) continue;
      const addr = String(marker?.accessKeyAddress || "").toLowerCase();
      if (live.has(addr)) { await kv.delete(key); continue; }   // paid: the key belongs to a subscription now
      if (now() - Number(marker?.at || 0) < OFFER_SWEEP_AFTER_MS) { open++; continue; }
      await kv.delete(key);
      // Delete the access-key records by MATCHING THEIR CONTENT, never by
      // rebuilding mppx's key names: it stores the same record twice, once by
      // lookup key and once by address, and the address entry's real prefix is
      // `<accessKeyPrefix>address:` - a hand-written prefix here would leave
      // live private-key material on disk while the sweep reported success.
      for (const [k2, v2] of Object.entries(snap)) {
        if (v2 && typeof v2 === "object" && v2.privateKey && String(v2.accessKeyAddress || "").toLowerCase() === addr) await kv.delete(k2);
      }
    }
    return open;
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
        amountAtomic: String(BigInt(Math.round((p.price / 100) * 10 ** decimals))),
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
    await kv.put(OFFER_KEY(offerNonce), { at: nowMs, accessKeyAddress: ak.accessKeyAddress });

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
        amount: (p.price / 100).toFixed(decimals),
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

  // --- activation ------------------------------------------------------------
  /** Default activation: hand the credential to mppx's subscription method,
   *  which verifies the key authorization, recovers the payer, installs the
   *  access key and settles period 0 on-chain, then persists its own record.
   *  Injected in tests so the whole path is provable offline. */
  async function defaultActivate(authorizationHeader) {
    const receipt = await Method.broadcastCredential([method], authorizationHeader);
    return { receipt };
  }

  /**
   * Turn a signed subscription credential into a paying subscriber.
   * Order is non-negotiable: BINDING first (pure, offline), then the access key
   * must be one we hold, then the key authorization is verified against OUR
   * key, and only then does anything settle.
   */
  async function activateFromCredential(authorizationHeader) {
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
    const mppxRec = await subStore.getByKey(lookupKey);
    if (!mppxRec) { const e = new Error("subscription did not persist after settlement"); e.statusCode = 500; throw e; }

    const subId = `${SUB_PREFIX}${mppxRec.subscriptionId}`;
    const rec = {
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
    await writeRec(rec);
    bookCharge(rec, rec.lastChargedPeriod, rec.lastChargeTx);
    log(`[mpp-subs] activated ${subId} (${rec.product} -> ${rec.target}) payer=${payer} tx=${rec.lastChargeTx || "?"}`);
    return { ...publicView(rec), manageToken: manageToken(subId), receipt: receiptHeader(receipt), replay: false };
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
    const result = await tempoServer.renewSubscription({
      subscriptionId: rec.mppxSubscriptionId,
      store: kv,
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
      ...clientOverride(),
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
    let rec = await readRec(subId);
    if (!rec) return null;
    const at = now();
    if (rec.status === "canceled" || rec.status === "expired") return rec.status;

    // The standing authorization has a hard end. Past it no pull can succeed,
    // so stop pretending otherwise.
    const term = Date.parse(rec.subscriptionExpires);
    if (Number.isFinite(term) && at >= term) { await writeRec({ ...rec, status: "expired" }); return "expired"; }

    const due = currentPeriodIndex(rec, at);
    if (due <= (rec.lastChargedPeriod ?? 0)) {
      if (rec.status !== "active") await writeRec({ ...rec, status: "active" });
      return "active";
    }
    // A new period is due.
    if (rec.cancelAtPeriodEnd) {
      await writeRec({ ...rec, status: "canceled", canceledAt: rec.canceledAt || new Date(at).toISOString(), canceledReason: rec.canceledReason || "requested" });
      return "canceled";
    }
    if (rec.nextChargeAttemptAt && at < Date.parse(rec.nextChargeAttemptAt)) return rec.status === "active" ? "past_due" : rec.status;
    if (inFlight.has(subId)) return rec.status === "active" ? "past_due" : rec.status;

    inFlight.add(subId);
    try {
      // CHAIN TRUTH FIRST. A previous pull for this period died in the send
      // phase; whether it landed is a fact on the chain, and only that fact
      // decides between "record it" and "sign again".
      if (rec.unconfirmedCharge && rec.unconfirmedCharge.periodIndex === due) {
        const mppxRec = await subStore.get(rec.mppxSubscriptionId);
        const find = injectedFindRenewal || defaultFindRenewalOnChain;
        const verdict = await find({ rec, mppxRec, periodIndex: due, sinceMs: Date.parse(rec.unconfirmedCharge.at) - UNCONFIRMED_LOOKBACK_MS });
        if (verdict === null) {
          const next = { ...rec, status: rec.status === "active" ? "past_due" : rec.status, nextChargeAttemptAt: new Date(at + TRANSIENT_CHARGE_BACKOFF_MS).toISOString() };
          await writeRec(next);
          log(`[mpp-subs] ${subId}: unconfirmed period ${due} and the chain is unreadable - waiting, not re-charging`);
          return next.status;
        }
        if (verdict.found) {
          if (mppxRec && (mppxRec.lastChargedPeriod ?? 0) < due) {
            await subStore.put({ ...mppxRec, lastChargedPeriod: due, reference: verdict.tx, timestamp: new Date(at).toISOString(), inFlightPeriod: undefined, inFlightAttempt: undefined, inFlightReference: undefined, inFlightStartedAt: undefined });
          }
          const next = {
            ...rec, status: "active", lastChargedPeriod: due, lastChargeTx: verdict.tx, lastChargeAt: new Date(at).toISOString(),
            chargeFailures: 0, firstFailedAt: null, nextChargeAttemptAt: null, lastChargeError: null, unconfirmedCharge: null,
          };
          await writeRec(next);
          bookCharge(next, due, verdict.tx);
          log(`[mpp-subs] reconciled ${subId} period ${due} from the chain: the send that timed out had landed, tx=${verdict.tx} - not charged twice`);
          return "active";
        }
        rec = { ...rec, unconfirmedCharge: null };
        await writeRec(rec);
        log(`[mpp-subs] ${subId}: the send that timed out for period ${due} never landed - charging now`);
      }
      const charge = injectedChargePeriod || defaultChargePeriod;
      const result = await charge(rec, { periodIndex: due });
      // mppx owns the counter; re-read rather than assume, so a partial success
      // (charged but our own write lost) self-corrects on the next tick.
      const mppxRec = await subStore.get(rec.mppxSubscriptionId);
      const charged = mppxRec?.lastChargedPeriod ?? (result ? due : (rec.lastChargedPeriod ?? 0));
      if (charged <= (rec.lastChargedPeriod ?? 0)) throw new Error(result === null ? "renewal reported nothing due while a period is outstanding" : "renewal did not advance the paid period");
      const next = {
        ...rec, status: "active", lastChargedPeriod: charged,
        billingAnchor: mppxRec?.billingAnchor || rec.billingAnchor,
        lastChargeTx: result?.reference || mppxRec?.reference || null,
        lastChargeAt: new Date(at).toISOString(),
        chargeFailures: 0, firstFailedAt: null, nextChargeAttemptAt: null, lastChargeError: null, unconfirmedCharge: null,
      };
      await writeRec(next);
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
      const backoff = transient
        ? Math.min(TRANSIENT_CHARGE_BACKOFF_MS * failures, CHARGE_BACKOFF_MS)
        : Math.min(CHARGE_BACKOFF_MS * 2 ** (failures - 1), MAX_CHARGE_BACKOFF_MS);
      const givenUp = at - Date.parse(firstFailedAt) >= PAST_DUE_GRACE_MS;
      const ambiguous = isSendPhaseAmbiguity(err);
      const next = {
        ...rec, chargeFailures: failures, firstFailedAt,
        nextChargeAttemptAt: new Date(at + backoff).toISOString(),
        lastChargeError: String(err?.message || err).slice(0, 200),
        ...(ambiguous ? { unconfirmedCharge: { at: new Date(at).toISOString(), periodIndex: due } } : {}),
        status: givenUp ? "canceled" : "past_due",
        ...(givenUp ? { canceledAt: new Date(at).toISOString(), canceledReason: "unpaid" } : {}),
      };
      await writeRec(next);
      log(`[mpp-subs] period charge failed for ${subId} (attempt ${failures}${givenUp ? ", giving up: past the grace window" : `, retry in ${Math.round(backoff / 60000)}m${transient ? " (transient)" : ""}${ambiguous ? ", chain checked before any retry" : ""}`}): ${diagnoseError(err)}`);
      return next.status;
    } finally { inFlight.delete(subId); }
  }

  // --- cancellation ----------------------------------------------------------
  /** The subscriber stops the recurring pull. We honour the period they already
   *  paid for: no further charge is ever attempted, and the subscription stays
   *  active until that period ends. Requires the manage token minted at
   *  activation, which only the subscriber (and their email) ever saw. */
  async function cancel(subId, token) {
    const rec = await readRec(subId);
    if (!rec) { const e = new Error("Unknown subscription"); e.statusCode = 404; throw e; }
    if (!manageTokenOk(subId, token)) { const e = new Error("Not authorized to manage this subscription"); e.statusCode = 403; throw e; }
    if (rec.status === "canceled") return publicView(rec);
    const at = now();
    const endsAt = paidThroughAt(rec);
    const stillPaid = at < endsAt && rec.status === "active";
    const next = {
      ...rec, cancelAtPeriodEnd: true,
      canceledAt: new Date(at).toISOString(), canceledReason: "requested",
      status: stillPaid ? "active" : "canceled",
    };
    await writeRec(next);
    log(`[mpp-subs] canceled ${subId} (${stillPaid ? `active until ${new Date(endsAt).toISOString()}` : "immediately"})`);
    return publicView(next);
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
      lastChargeAt: rec.lastChargeAt || null, lastChargeTx: rec.lastChargeTx || null,
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
  function listActive(kind) {
    const out = [];
    for (const rec of cache.values()) {
      const p = MONITOR_PRODUCTS[rec.product];
      if (!p) continue;
      if (kind && p.kind !== kind) continue;
      // Never list a subscription whose paid period has run out, even if the
      // stored status still says active: refreshStatus is what flips it, and
      // this must not hand the scheduler a sub to work on before then.
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

  async function status() {
    await warm();
    return {
      enabled: true, recipient, currency, chainId: TEMPO_MAINNET_CHAIN_ID,
      periodSeconds: PERIOD_MS / 1000,
      subs: [...cache.values()].map((rec) => ({
        ...publicView(rec),
        email: rec.email ? `${rec.email.slice(0, 2)}***` : null,
        chargeFailures: rec.chargeFailures || 0, lastChargeError: rec.lastChargeError || null,
        nextChargeAttemptAt: rec.nextChargeAttemptAt || null,
        accessKeyAddress: rec.accessKeyAddress,
      })),
    };
  }

  return {
    offerInfo, mintOffer, activateFromCredential, refreshStatus, cancel, isCanarySub,
    listActive, get, isMine, status, warm, warmSync, manageToken, manageTokenOk, publicView,
    _store: kv, _subStore: subStore, _method: method,
    _feePayer: feePayer, _feePayerPolicy: feePayer ? subscriptionFeePayerPolicy() : null,
    _currentPeriodIndex: currentPeriodIndex, _paidThroughAt: paidThroughAt, _readRec: readRec, _writeRec: writeRec,
  };
}
