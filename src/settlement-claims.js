// Which request owns a payment authorization, and which owns a settlement tx.
//
// One signed authorization pays for one answer. A recovered settlement
// (src/settle-onchain-proof.js) serves an answer for a transaction the
// facilitator did not hand back to this request, so it is only safe when the
// transaction is this request's own; a replayed payload must never be served
// twice. These claims make ownership explicit:
//
//   nonce:<network>:<nonce>  taken by the first request to reach settle with
//                            that authorization (onBeforeSettle). While one
//                            request holds it, another request carrying the
//                            same authorization is refused before it calls the
//                            facilitator (402, nothing charged). Held for a
//                            short in-flight TTL, made long when the payment
//                            settles, released when the settle fails and
//                            nothing recovered it, so a legitimate retry of an
//                            unsettled authorization still goes through.
//   nonce:<network>:<signer>:<nonce>
//                            the same claim for a Stellar payment: one per
//                            signed Soroban authorization entry of the payer
//                            (the network consumes each (address, nonce)
//                            once), read from the signed entry itself, so a
//                            re-encoded copy of one payment takes the same
//                            keys.
//   tx:<network>:<tx>        taken by the request that served the
//                            transaction, on a normal settle (onAfterSettle;
//                            on Stellar, ownSettledStellarTx in the settle
//                            itself) or a recovery.
//
// A claim is a SET NX with a TTL on the shared Redis when REDIS_URL is set, so
// two replicas cannot both own one key; without Redis, or when it does not
// answer, the same claim is made in this process.
import { GATEWAY_PENDING_BOOKED } from "./gateway-wire.js";
import { randomUUID } from "node:crypto";
import { getSharedRedisClient } from "./shared-limit.js";
import { settleTxOf, stellarAuthorizationsOf } from "./stellar-confirm.js";

const PREFIX = "settle-claim:";
// Past any handler plus settle; a holder that dies mid-request frees the
// authorization by then.
export const INFLIGHT_TTL_SECONDS = 300;
// Longer than any authorization a buyer can expect us to honor; past it the
// sales ledger still holds every served tx.
export const SETTLED_TTL_SECONDS = 30 * 24 * 3600;
const LOCAL_MAX = 100_000;
// A claim sits on the paid path, so a Redis that stops answering must not hold
// a settle: each command gets this long, then the claim is made in this
// process (the same fallback as no Redis at all).
export const COMMAND_DEADLINE_MS = Number(process.env.SETTLE_CLAIM_DEADLINE_MS) > 0 ? Number(process.env.SETTLE_CLAIM_DEADLINE_MS) : 250;
// The deadline measures Redis, not this process. When the event loop was
// blocked (a GC pause, a synchronous load) the timer fires late, in the timers
// phase that runs BEFORE the poll phase reads a reply that arrived during the
// block. Rejecting there made a claim another replica already holds (SET NX
// answered "no") read as "no answer", and the local fallback then claimed it
// here too: one transfer served by two replicas. So the rejection waits for
// the poll phase (setImmediate), and a timer that fired late re-arms a full
// deadline from now, at most STALL_REARMS times.
const STALL_REARMS = 2;
function within(p) {
  let timer, immediate;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      let rearms = 0;
      const arm = () => {
        const due = Date.now() + COMMAND_DEADLINE_MS;
        timer = setTimeout(() => {
          const late = Date.now() - due;
          if (late > COMMAND_DEADLINE_MS / 2 && rearms < STALL_REARMS) { rearms++; arm(); return; }
          // Not unref'd: an unref'd immediate would wait for the next other
          // event before the check phase ran it.
          immediate = setImmediate(() => reject(new Error(`no answer in ${COMMAND_DEADLINE_MS} ms`)));
        }, COMMAND_DEADLINE_MS);
        timer.unref?.();
      };
      arm();
    }),
  ]).finally(() => { clearTimeout(timer); if (immediate) clearImmediate(immediate); });
}

const local = new Map(); // key -> { holder, until }

function localGet(key, now) {
  const hit = local.get(key);
  if (hit && hit.until > now) return hit;
  if (hit) local.delete(key);
  return null;
}
function localSet(key, holder, ttlSeconds, now) {
  local.delete(key);
  while (local.size >= LOCAL_MAX) {
    const oldest = local.keys().next().value;
    if (oldest === undefined) break;
    local.delete(oldest);
  }
  local.set(key, { holder, until: now + ttlSeconds * 1000 });
}

/**
 * Claim `key` for `holder`. Returns `{ claimed, holder }`: claimed is true when
 * this holder owns the key (a new claim, or one it already held).
 */
export async function claimSettlementKey(key, holder, { ttlSeconds = SETTLED_TTL_SECONDS, now = Date.now() } = {}) {
  const c = await getSharedRedisClient();
  if (c) {
    try {
      const k = PREFIX + key;
      // A claim this process made while Redis was not answering (still
      // connecting at boot, or past a command deadline) lives only here. It
      // still holds the key: it is written to Redis for the other replicas,
      // and another holder is refused, so one key never has two owners in
      // one process because the backend changed between two claims.
      const mine = localGet(key, now);
      if (mine && mine.holder !== holder) {
        await within(c.set(k, mine.holder, { NX: true, EX: Math.max(1, Math.ceil((mine.until - now) / 1000)) })).catch(() => {});
        return { claimed: false, holder: mine.holder };
      }
      if (await within(c.set(k, holder, { NX: true, EX: ttlSeconds }))) {
        localSet(key, holder, ttlSeconds, now);
        return { claimed: true, holder };
      }
      const owner = await within(c.get(k));
      return { claimed: owner === holder, holder: owner };
    } catch (e) {
      console.error("[settlement-claims] redis claim failed, falling back to local state:", e.message);
    }
  }
  const hit = localGet(key, now);
  if (hit) return { claimed: hit.holder === holder, holder: hit.holder };
  localSet(key, holder, ttlSeconds, now);
  return { claimed: true, holder };
}

/** Keep a key this holder owns for `ttlSeconds` more. No-op for another holder's key. */
export async function extendSettlementKey(key, holder, { ttlSeconds = SETTLED_TTL_SECONDS, now = Date.now() } = {}) {
  const c = await getSharedRedisClient();
  if (c) {
    try {
      const k = PREFIX + key;
      const owner = await within(c.get(k));
      if (owner === null || owner === holder) await within(c.set(k, holder, { EX: ttlSeconds }));
      if (owner === null || owner === holder) localSet(key, holder, ttlSeconds, now);
      return;
    } catch (e) {
      console.error("[settlement-claims] redis extend failed, falling back to local state:", e.message);
    }
  }
  const hit = localGet(key, now);
  if (!hit || hit.holder === holder) localSet(key, holder, ttlSeconds, now);
}

/** Drop a key this holder owns. No-op for another holder's key. */
export async function releaseSettlementKey(key, holder, { now = Date.now() } = {}) {
  const hit = localGet(key, now);
  if (hit && hit.holder === holder) local.delete(key);
  const c = await getSharedRedisClient();
  if (!c) return;
  try {
    const k = PREFIX + key;
    if ((await within(c.get(k))) === holder) await within(c.del(k));
  } catch (e) {
    console.error("[settlement-claims] redis release failed:", e.message);
  }
}

export const nonceClaimKey = (network, nonce) => `nonce:${String(network)}:${String(nonce).toLowerCase()}`;
// A Stellar address is kept as signed (never case-folded); the nonce is an
// int64 in decimal.
export const stellarNonceClaimKey = (network, signer, nonce) => `nonce:${String(network)}:${String(signer)}:${String(nonce)}`;
// EVM tx hashes are hex: lowercasing is exact for them.
export const txClaimKey = (network, tx) => `tx:${String(network)}:${String(tx).toLowerCase()}`;

const STATE = "__a402SettleClaim";
const reqOf = (ctx) => ctx?.transportContext?.request?.adapter?.req;

/** This request's claim state: when its payment was first seen, and its id. */
export function settleClaimStateOf(req) {
  return req && typeof req === "object" && Object.hasOwn(req, STATE) ? req[STATE] : null;
}

function stamp(req) {
  if (!req || typeof req !== "object") return null;
  if (Object.hasOwn(req, STATE)) return req[STATE];
  const s = { seenAt: Date.now(), id: randomUUID(), nonceKey: null, nonceKeys: [] };
  try { Object.defineProperty(req, STATE, { value: s, enumerable: false, configurable: true, writable: true }); } catch { return null; }
  return s;
}

function evmAuthorizationOf(ctx) {
  const network = String(ctx?.requirements?.network || "");
  const nonce = ctx?.paymentPayload?.payload?.authorization?.nonce;
  if (!network.startsWith("eip155:") || typeof nonce !== "string" || !nonce) return null;
  return { network, nonce };
}

/** The claim keys of a Stellar payment's signed entries, or null. */
async function stellarAuthorizationOf(ctx) {
  const network = String(ctx?.requirements?.network || "");
  if (!network.startsWith("stellar:")) return null;
  const entries = await stellarAuthorizationsOf(ctx?.paymentPayload);
  if (!entries) return null;
  return [...new Set(entries.map((e) => stellarNonceClaimKey(network, e.signer, e.nonce)))];
}

/** Every authorization key this request holds. */
function heldKeys(s) {
  return [...new Set([s?.nonceKey, ...(Array.isArray(s?.nonceKeys) ? s.nonceKeys : [])].filter(Boolean))];
}
const extendHeld = async (s) => { for (const k of heldKeys(s)) await extendSettlementKey(k, s.id); };
const releaseHeld = async (s) => { for (const k of heldKeys(s)) await releaseSettlementKey(k, s.id); };

export const DUPLICATE_AUTHORIZATION = "duplicate_authorization";

/**
 * Hooks that stamp a payment when first seen and claim its authorization.
 * Register BEFORE the settle-failure hooks; register the release with
 * registerSettlementClaimRelease AFTER them.
 */
export function registerSettlementClaimHooks(server) {
  server.onBeforeVerify((ctx) => { try { stamp(reqOf(ctx)); } catch { /* never touch a payment */ } });
  server.onBeforeSettle(async (ctx) => {
    let refuse = false;
    try {
      const s = stamp(reqOf(ctx));
      if (!s) return;
      const a = evmAuthorizationOf(ctx);
      const keys = a ? [nonceClaimKey(a.network, a.nonce)] : await stellarAuthorizationOf(ctx);
      if (!keys?.length) return;
      if (!Array.isArray(s.nonceKeys)) s.nonceKeys = [];
      // Every key or none: a request refused on one key gives back the
      // others it took, so a refused request holds nothing.
      for (const key of keys) {
        const r = await claimSettlementKey(key, s.id, { ttlSeconds: INFLIGHT_TTL_SECONDS });
        if (!r.claimed) { refuse = true; break; }
        if (!s.nonceKey) s.nonceKey = key;
        if (!s.nonceKeys.includes(key)) s.nonceKeys.push(key);
      }
      if (refuse) { await releaseHeld(s); s.nonceKey = null; s.nonceKeys = []; }
    } catch { return; /* never touch a payment */ }
    if (refuse) {
      return { abort: true, reason: DUPLICATE_AUTHORIZATION, message: "This payment authorization is already settling or settled for another request. Sign a new payment to retry." };
    }
  });
  server.onAfterSettle(async (ctx) => {
    try {
      const r = ctx?.result;
      if (!r || r.success !== true) return;
      const s = stamp(reqOf(ctx));
      if (s) await extendHeld(s);
      // A Stellar settle claims its own transaction inside the settle
      // (ownSettledStellarTx), where a transaction another request already
      // serves can still be refused; this claim is the EVM one.
      const network = String(r.network || ctx?.requirements?.network || "");
      if (typeof r.transaction === "string" && r.transaction && network.startsWith("eip155:")) {
        await claimSettlementKey(txClaimKey(network, r.transaction), s?.id || `settled:${randomUUID()}`);
      }
    } catch { /* never touch a payment */ }
  });
  return server;
}

/**
 * Runs only when no earlier settle-failure hook recovered the payment: the
 * authorization did not settle for this request, so a retry may use it.
 */
export function registerSettlementClaimRelease(server) {
  server.onSettleFailure(async (ctx) => {
    try {
      const s = settleClaimStateOf(reqOf(ctx));
      if (!s?.nonceKey) return;
      // A settlement the facilitator reports as still PENDING is not a failure
      // that frees the authorization: it may still land. The claim is kept
      // (for as long as a settled one), so the same signed payment cannot be
      // resent and served while its first settlement is unresolved; the
      // pending book (src/circle-pending.js) settles what is owed.
      // The exception: a Circle Gateway batched payment the Gateway pending
      // book holds. That book, not this claim, guards the authorization from
      // here (src/gateway-nanopayments.js resolves a resend against Gateway's
      // transfer record before any verify or settle, and lets one request
      // serve it), so the claim is released for that resend to take.
      const req = reqOf(ctx);
      if (isPendingSettlement(ctx) && req && req[GATEWAY_PENDING_BOOKED] === true) { await releaseHeld(s); return; }
      if (isPendingSettlement(ctx) || namesUnsettledTx(ctx)) { await extendHeld(s); return; }
      // A Stellar failure releases its entries too, even one that names a
      // transaction that may still land: this request's answer is final
      // (a 402) by now, so a resend that takes the entries is the only
      // request that can be served, and it is served only if it confirms a
      // landed transaction it then owns (the tx claim, confirmStellarPayment).
      await releaseHeld(s);
    } catch { /* never touch a payment */ }
  });
  return server;
}

/** The settle failed only in the sense that its outcome is not known yet. */
export const SETTLEMENT_PENDING = "settlement_pending";
export function isPendingSettlement(ctx) {
  const reasons = [ctx?.error?.errorReason, ctx?.result?.errorReason, ctx?.error?.reason];
  return reasons.some((r) => r === SETTLEMENT_PENDING);
}

/**
 * A failed settle that still names a transaction (the primary's answer, or a
 * fallback's that stopped the chain, src/payments.js noteLateTx) may land
 * later: the late-settlement book reads it (src/late-settlements.js). Its
 * authorization stays claimed like a pending one, so a resend cannot be
 * served while that transaction is unresolved.
 */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
export function namesUnsettledTx(ctx) {
  // An authorization booked after an ambiguous failure (src/robinhood-outage.js)
  // is unresolved the same way: whatever transaction uses it may still land.
  return TX_HASH.test(String(ctx?.__a402LateTx?.transaction || "")) || TX_HASH.test(String(ctx?.error?.transaction || "")) || !!ctx?.__a402LateAuth?.nonce;
}

/**
 * A settlement a settle-failure hook recovered fires no afterSettle hook, so
 * its transaction is claimed here for this request, as afterSettle does for
 * the primary's. Returns true when another holder already has that
 * transaction (a request that served it, or the late-settlement book that
 * booked it owed): the recovery must not serve it.
 */
export async function recoveredTxHeldElsewhere(ctx, result) {
  try {
    const network = String(result?.network || ctx?.requirements?.network || "");
    const tx = result?.transaction;
    if (typeof tx !== "string" || !tx || !network.startsWith("eip155:")) return false;
    const s = stamp(reqOf(ctx));
    const r = await claimSettlementKey(txClaimKey(network, tx), s?.id || `settled:${randomUUID()}`);
    if (r.claimed && s) await extendHeld(s);
    return !r.claimed;
  } catch { return false; /* never touch a payment */ }
}

/** Is a settlement tx already claimed by a request that served it? Claims the
 *  tx for `holder` when nobody holds it, so nothing can serve it afterwards. */
export async function txServedElsewhere(network, tx, holder) {
  const r = await claimSettlementKey(txClaimKey(network, tx), holder);
  return !r.claimed;
}

export const TX_SERVED_ELSEWHERE = "transaction_served_elsewhere";

/**
 * A Stellar settle that succeeded claims its transaction for this request
 * (`claimTx(tx)` resolves true when this request owns it). A transaction
 * another request already holds was confirmed and served for that request
 * (a resend whose settle failed and whose confirmation found this one), so
 * this request is answered as a failed settle instead of a second answer for
 * one payment. A claim store that throws leaves the sale standing: the
 * per-entry claim taken before settle is the primary guard, and a store
 * that does not answer falls back to this process (claimSettlementKey).
 */
export async function ownSettledStellarTx(res, { network, claimTx, log = console.warn } = {}) {
  const tx = res && res.success === true ? settleTxOf(res) : null;
  if (!tx || typeof claimTx !== "function") return res;
  let owned = true;
  try { owned = (await claimTx(tx)) !== false; } catch { owned = true; }
  if (owned) return res;
  log(`[settlement-claims] stellar transaction ${tx} settled but another request already serves it; not answering twice for one payment`);
  return {
    success: false,
    errorReason: TX_SERVED_ELSEWHERE,
    errorMessage: "This payment's transaction already answered another request.",
    network: res.network || network,
    ...(res.payer ? { payer: res.payer } : {}),
    transaction: "",
  };
}

/** Test-only. */
export function __resetSettlementClaims() { local.clear(); }
