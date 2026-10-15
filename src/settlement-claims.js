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
//   tx:<network>:<tx>        taken by the request that served the
//                            transaction, on a normal settle (onAfterSettle)
//                            or a recovery.
//
// A claim is a SET NX with a TTL on the shared Redis when REDIS_URL is set, so
// two replicas cannot both own one key; without Redis, or when it does not
// answer, the same claim is made in this process.
import { randomUUID } from "node:crypto";
import { getSharedRedisClient } from "./shared-limit.js";

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
function within(p) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${COMMAND_DEADLINE_MS} ms`)), COMMAND_DEADLINE_MS); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
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
  const s = { seenAt: Date.now(), id: randomUUID(), nonceKey: null };
  try { Object.defineProperty(req, STATE, { value: s, enumerable: false, configurable: true, writable: true }); } catch { return null; }
  return s;
}

function evmAuthorizationOf(ctx) {
  const network = String(ctx?.requirements?.network || "");
  const nonce = ctx?.paymentPayload?.payload?.authorization?.nonce;
  if (!network.startsWith("eip155:") || typeof nonce !== "string" || !nonce) return null;
  return { network, nonce };
}

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
      const a = evmAuthorizationOf(ctx);
      if (!s || !a) return;
      const key = nonceClaimKey(a.network, a.nonce);
      const r = await claimSettlementKey(key, s.id, { ttlSeconds: INFLIGHT_TTL_SECONDS });
      if (r.claimed) s.nonceKey = key;
      else refuse = true;
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
      if (s?.nonceKey) await extendSettlementKey(s.nonceKey, s.id);
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
      if (s?.nonceKey) await releaseSettlementKey(s.nonceKey, s.id);
    } catch { /* never touch a payment */ }
  });
  return server;
}

/** Test-only. */
export function __resetSettlementClaims() { local.clear(); }
