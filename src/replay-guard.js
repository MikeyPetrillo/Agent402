/**
 * Payment-nonce replay guard (M3) — defense-in-depth against Attack II
 * ("replay / insufficient idempotency") from the "Five Attacks on x402
 * Agentic Payment Protocol" analysis.
 *
 * Agent402 already settles-before-grant: the paywall buffers the handler's
 * bytes, settles the payment on-chain, and flushes the response ONLY on settle
 * success. Because an EIP-3009 `transferWithAuthorization` nonce is single-use
 * on-chain, a replayed authorization fails at the facilitator, so the
 * duplicate-grant rate is already 1. This guard is a strictly-earlier, cheaper
 * layer: it rejects a duplicate authorization BEFORE it ever reaches the
 * facilitator, and — crucially — closes the concurrent-replay window the paper
 * exploits (the same authorization fired N times at once, racing the settle) by
 * refusing every duplicate while the first is still in flight.
 *
 * Release-on-failure: the nonce is only marked consumed when the gated call is
 * actually granted (a 200 — which, under settle-before-grant, means the payment
 * settled). If the call is NOT granted (the facilitator rejected settlement, the
 * handler threw, the client aborted), the nonce is released so a legitimate
 * retry of the still-valid authorization can succeed. It never blocks a payer
 * from re-using an authorization the chain hasn't consumed.
 *
 * CROSS-REPLICA (2026-08-16): prod runs multiple replicas (RATE_LIMIT_REPLICAS),
 * and the guard below was per-process only - a concurrent replay landing on
 * TWO DIFFERENT replicas within the same request window was invisible to it
 * (each replica's inFlight Set only sees its own traffic). The chain's own
 * nonce single-use property still prevented a double-CHARGE, but the HANDLER
 * ran twice - for a tool that makes a real paid upstream call, that is a real
 * cost duplication bounded only by how fast an attacker can fire one
 * authorization at two replicas.
 *
 * Now backed by the SAME Redis connection shared-limit.js already maintains
 * (via getSharedRedisClient - one connection per process, not a second one to
 * the same server) when REDIS_URL is configured and reachable. With no shared
 * store configured (one process) the per-process Map/Set is the guarantee. A
 * caller that passes `requireShared` gets "unavailable" whenever a shared
 * store is configured but cannot be reached, and refuses the call before any
 * payment is taken. The x402 dispatcher in server.js, the Tempo gate and the
 * card gate each pass sharedClaimRequired() (src/replay-topology.js): the
 * shared claim is required on a long-running or composite route always, and
 * on every route while another container may be serving (more than one
 * replica, a deploy's overlap window, a drain), because a per-process claim
 * on two containers lets one signed payment run the handler on each and
 * reach the facilitator twice, where only later layers (the chain's nonce,
 * the settlement claims, the sales ledger) keep the second from being served.
 * A lone container past its overlap window serves a fast route on the
 * per-process claim, so a store outage does not stop sales there. A caller
 * that does not pass it falls back to the per-process claim on a Redis
 * failure.
 */
import { createHash } from "node:crypto";
import { paymentHeaderOf } from "./payer.js";
import { getSharedRedisClient, sharedLimitEnabled } from "./shared-limit.js";
import { decodePaymentHeader } from "./payment-header.js";

// The claim's lifetime in Redis without a renewal. A claim is renewed every
// INFLIGHT_RENEW_MS while its call is open (the slow routes run for minutes),
// so a healthy call keeps it until settle()/release(), and a replica that
// dies mid-request without releasing stops renewing and its claim lapses
// within this.
const INFLIGHT_TTL_SECONDS = 120;
export const INFLIGHT_RENEW_MS = 30_000;
// Renewal stops after this long, so a caller that never settles or releases
// cannot hold a nonce (or a timer) forever. Far past any run budget.
const MAX_HOLD_MS = 30 * 60_000;
const REDIS_PREFIX = "replay:";

/**
 * Stable replay identity for the x402 payment credential on this request, or
 * null when there is nothing to guard (no payment header — a proof-of-work
 * call or an unpaid discovery crawl).
 *
 * Prefers the EIP-3009 nonce scoped to its network and its signed payer: the
 * chain consumes a nonce per (token, from), so two wallets that sign the same
 * nonce are two payments, and so are two networks. A re-encoded-but-equivalent
 * authorization still maps to one identity. The network is read where each
 * wire carries it (v2 on `accepted`, v1 at the top level); an EVM payer is
 * lowercased, any other spelling is kept as signed. Falls back to hashing the
 * raw credential for schemes whose nonce we can't parse (e.g. an SVM signed
 * transaction), where the header bytes themselves are the single-use artifact.
 *
 * A nonce key reads "n2:<identity>:<legacy>": <legacy> is the key an earlier
 * build used for the same credential (network as v1 spells it, nonce only).
 * The guard honors claims and consumed marks under that legacy key that an
 * earlier build wrote, and writes its own there tagged, so across a deploy
 * neither build lets the other's in-flight or consumed payment run again
 * (see legacyOf below).
 */
export function paymentReplayKey(req) {
  const cred =
    paymentHeaderOf(req);   // middleware order — see src/payer.js
  if (!cred || typeof cred !== "string") return null;
  try {
    const p = decodePaymentHeader(cred);
    const auth = p?.payload?.authorization;
    const nonce = auth?.nonce;
    if (typeof nonce === "string" && nonce) {
      const n = nonce.toLowerCase();
      const network = p?.accepted?.network || p?.network || p?.payload?.network || "?";
      const rawFrom = typeof auth?.from === "string" ? auth.from.trim() : "";
      const from = /^0x[0-9a-fA-F]{40}$/.test(rawFrom) ? rawFrom.toLowerCase() : rawFrom;
      const id = createHash("sha256").update(`${network}\n${from}\n${n}`).digest("hex");
      const legacyNetwork = p?.network || p?.payload?.network || "?";
      const legacy = createHash("sha256").update(`${legacyNetwork}:${n}`).digest("hex");
      return `n2:${id}:${legacy}`;
    }
  } catch {
    /* not base64 JSON, or no parseable nonce — fall through to raw identity */
  }
  return "c:" + createHash("sha256").update(cred).digest("hex");
}

// A key's Redis name and, for a nonce key, the name an earlier build used for
// the same credential. An earlier build's entries hold a bare timestamp; ours
// at the legacy name hold LEGACY_TAG + our own name, so we skip another
// payer's tagged entry there and honor an untagged one (it may be this very
// payment, claimed or consumed by the earlier build).
const LEGACY_TAG = "v2|";
function namesOf(key) {
  const m = /^n2:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(String(key));
  if (!m) return { primary: String(key), legacy: null };
  return { primary: `n2:${m[1]}`, legacy: `n:${m[2]}` };
}
const isLegacyEntry = (v) => v != null && !String(v).startsWith(LEGACY_TAG);

// A settled payment's consumed mark is kept this long (the chain refuses its
// nonce after that, so the mark need not outlive it). /privacy and the
// dataHandling list on /.well-known/x402 quote it.
export const SETTLED_HOLD_MS = 60 * 60_000;
/** The settled hold in words for those surfaces ("an hour", "2 hours", "30 minutes"). */
export function settledHoldText() {
  const hours = SETTLED_HOLD_MS / 3_600_000;
  if (Number.isInteger(hours) && hours >= 1) return hours === 1 ? "an hour" : `${hours} hours`;
  return `${Math.round(SETTLED_HOLD_MS / 60_000)} minutes`;
}
// A consumed mark is kept at least this long past the authorization's own
// validBefore (clock skew between us, the facilitator and the chain).
export const CONSUMED_VALIDITY_MARGIN_MS = 10 * 60_000;
// A validBefore further out than this is read as this far out: an
// authorization signed to stay valid for a century is held for a century.
const MAX_VALIDITY_HOLD_MS = 100 * 365 * 24 * 3600_000;

/**
 * When the signed authorization on this request stops being settleable, in
 * ms since the epoch, or null when the credential names no EIP-3009
 * validBefore (an SVM transaction, a Stellar or Algorand payment). A granted
 * request's consumed mark is held until at least then (plus a margin): a
 * hang-up inside the forgiveness budget is granted (the 200 default status)
 * without being settled, and the buyer was told it was free, so the same
 * authorization must not settle on a re-send while the chain would still
 * accept it.
 */
export function paymentValidBeforeMs(req) {
  const cred = paymentHeaderOf(req);
  if (!cred || typeof cred !== "string") return null;
  try {
    const p = decodePaymentHeader(cred);
    const raw = p?.payload?.authorization?.validBefore;
    const sec = typeof raw === "string" && /^\d{1,20}$/.test(raw.trim()) ? Number(raw.trim()) : (Number.isSafeInteger(raw) ? raw : NaN);
    return Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, Date.now() + MAX_VALIDITY_HOLD_MS) : null;
  } catch {
    return null;
  }
}

/**
 * Replay guard. Redis-backed (shared across replicas) when configured and
 * reachable; otherwise the original per-process fallback below. `consumed`
 * maps a settled nonce → the time it settled; `inFlight` is the set of nonces
 * whose gated call is currently mid-settle. All three methods are now async
 * (a Redis round trip on the common path) - the server.js call site already
 * runs inside an async middleware.
 *
 * Bounded: entries expire after `ttlMs`, or at the authorization's own
 * validBefore plus CONSUMED_VALIDITY_MARGIN_MS when the caller passes it and
 * it is later. The validBefore hold matters for a GRANTED request that was not
 * settled (a hang-up inside the forgiveness budget: the buyer was told it was
 * free): its nonce is still live on chain, so only this mark stops a re-send
 * from settling it. Total LOCAL consumed entries are capped at `maxEntries`
 * with FIFO eviction (Redis expires its own keys via TTL, no separate cap
 * needed). For a settled nonce eviction is safe (the chain refuses it); for an
 * unsettled granted one it is not, which is one reason the paid x402 path
 * requires the shared store whenever one is configured (server.js).
 */
// Drop a legacy-name entry only when it is this payment's own tagged one.
async function delIfTagged(c, name, tag) {
  if ((await c.get(REDIS_PREFIX + name)) === tag) await c.del(REDIS_PREFIX + name);
}

export function createReplayGuard({ ttlMs = SETTLED_HOLD_MS, maxEntries = 50_000, inflightTtlSeconds = INFLIGHT_TTL_SECONDS, renewMs = INFLIGHT_RENEW_MS, maxHoldMs = MAX_HOLD_MS } = {}) {
  // Local (per-process) fallback state — used whenever Redis is unset or a
  // call to it fails (unless the caller requires the shared store), so a
  // single replica keeps its full guarantee and a Redis outage degrades to a
  // per-replica one, never to zero protection.
  const consumed = new Map(); // key -> expiresAt (ms): settledAt + ttlMs, or later for a long-lived authorization
  const inFlight = new Set();
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  // key -> interval renewing this process's Redis claim on it.
  const renewers = new Map();
  function startRenew(key, legacyHeld = false) {
    stopRenew(key);
    const until = Date.now() + maxHoldMs;
    const { primary, legacy } = namesOf(key);
    const t = setInterval(async () => {
      if (Date.now() >= until) { stopRenew(key); return; }
      try {
        const c = await getSharedRedisClient();
        if (c) {
          await c.expire(REDIS_PREFIX + "f:" + primary, inflightTtlSeconds);
          if (legacyHeld && legacy) await c.expire(REDIS_PREFIX + "f:" + legacy, inflightTtlSeconds);
        }
      } catch { /* the next tick retries */ }
    }, renewMs);
    t.unref?.();
    renewers.set(key, t);
  }
  function stopRenew(key) {
    const t = renewers.get(key);
    if (t) { clearInterval(t); renewers.delete(key); }
  }

  // Prune expired local consumed entries from the head (insertion order).
  // An entry held past its authorization's validBefore can sit at the head
  // longer than the ones behind it, so pruning stops there and a lookup
  // also checks the entry it reads (isConsumedLocal).
  function pruneLocal(now) {
    for (const [k, until] of consumed) {
      if (until <= now) consumed.delete(k);
      else break;
    }
  }
  function isConsumedLocal(key, now) {
    const until = consumed.get(key);
    if (until === undefined) return false;
    if (until <= now) { consumed.delete(key); return false; }
    return true;
  }
  // How long a consumed mark is held: ttlMs, or until the authorization's
  // validBefore plus a margin when that is later.
  function holdMsOf(now, validBeforeMs) {
    const v = Number(validBeforeMs);
    return Number.isFinite(v) && v > 0 ? Math.max(ttlMs, v + CONSUMED_VALIDITY_MARGIN_MS - now) : ttlMs;
  }

  return {
    /**
     * Claim the nonce for this in-flight call. Returns:
     *   "ok"       — first use; caller proceeds to the paywall
     *   "inflight" — an identical authorization is mid-settle (concurrent replay)
     *   "consumed" — this authorization already settled (sequential replay)
     *   "unavailable": only with `requireShared`; a shared store is
     *                   configured and did not answer; the caller refuses
     */
    async begin(key, now = Date.now(), { requireShared = false } = {}) {
      const c = await getSharedRedisClient();
      if (!c && requireShared && sharedLimitEnabled()) return "unavailable";
      if (c) {
        const { primary, legacy } = namesOf(key);
        const tag = LEGACY_TAG + primary;
        let claimedPrimary = false;
        let legacyHeld = false;
        try {
          if (await c.get(REDIS_PREFIX + "c:" + primary)) return "consumed";
          if (legacy && isLegacyEntry(await c.get(REDIS_PREFIX + "c:" + legacy))) return "consumed";
          // SET NX is the atomic claim: two replicas racing this same key
          // cannot both receive a non-null reply, which is exactly the
          // property inFlight.add() gave for free within one process.
          const claimed = await c.set(REDIS_PREFIX + "f:" + primary, String(now), { NX: true, EX: inflightTtlSeconds });
          if (!claimed) return "inflight";
          claimedPrimary = true;
          const back = async (verdict) => { await c.del(REDIS_PREFIX + "f:" + primary); if (legacyHeld) await delIfTagged(c, "f:" + legacy, tag); return verdict; };
          if (legacy) {
            // An earlier build's claim on this credential is honored; another
            // payer's tagged claim there is not ours to wait on.
            legacyHeld = Boolean(await c.set(REDIS_PREFIX + "f:" + legacy, tag, { NX: true, EX: inflightTtlSeconds }));
            if (!legacyHeld && isLegacyEntry(await c.get(REDIS_PREFIX + "f:" + legacy))) return back("inflight");
          }
          // Read the consumed mark again under the claim: a settle writes its
          // mark before it drops its claim, so a settle that finished between
          // the first read and the claim is seen here.
          if (await c.get(REDIS_PREFIX + "c:" + primary)) return back("consumed");
          if (legacy && isLegacyEntry(await c.get(REDIS_PREFIX + "c:" + legacy))) return back("consumed");
          startRenew(key, legacyHeld);
          return "ok";
        } catch (e) {
          // A claim this call took before the store failed is dropped (best
          // effort), so the buyer's retry is not refused as in flight for the
          // claim's whole life on a payment that was never used.
          if (claimedPrimary) {
            try { await c.del(REDIS_PREFIX + "f:" + primary); } catch { /* expires with its TTL */ }
            if (legacyHeld) { try { await delIfTagged(c, "f:" + legacy, tag); } catch { /* expires with its TTL */ } }
          }
          if (requireShared) {
            console.error("[replay-guard] redis begin failed; refusing a route that requires the shared store:", e.message);
            return "unavailable";
          }
          console.error("[replay-guard] redis begin failed, falling back to local state:", e.message);
          // fall through to the local path below
        }
      }
      pruneLocal(now);
      if (isConsumedLocal(key, now)) return "consumed";
      if (inFlight.has(key)) return "inflight";
      inFlight.add(key);
      return "ok";
    },
    /** Mark the nonce consumed: call only when the gated call was granted
     *  (200). `validBeforeMs` (paymentValidBeforeMs) holds the mark until the
     *  authorization itself expires when that is later than ttlMs. Pass it
     *  only for a grant that was NOT settled (a forgiven hang-up, a first-call
     *  allowance): a settled authorization is spent on chain, and holding
     *  every settled mark to a far validBefore keeps one long-lived key per
     *  paid call. */
    async settle(key, now = Date.now(), { validBeforeMs = null } = {}) {
      stopRenew(key);
      const holdMs = holdMsOf(now, validBeforeMs);
      const c = await getSharedRedisClient();
      if (c) {
        try {
          // Consumed mark FIRST, then the claim is dropped: at every moment
          // one of the two exists, so a begin() racing this settle reads
          // "consumed" or fails its SET NX ("inflight"). Dropping the claim
          // first left a gap in which a re-sent authorization was claimed
          // "ok" and reached the paywall again.
          const { primary, legacy } = namesOf(key);
          const ex = Math.max(ttlSeconds, Math.ceil(holdMs / 1000));
          await c.set(REDIS_PREFIX + "c:" + primary, String(now), { EX: ex });
          // An earlier build still running reads any entry at the legacy name
          // as consumed. Tagged, so this build reads it as another payer's;
          // an earlier build's own mark there is never overwritten.
          if (legacy) await c.set(REDIS_PREFIX + "c:" + legacy, LEGACY_TAG + primary, { NX: true, EX: ex });
          await c.del(REDIS_PREFIX + "f:" + primary);
          if (legacy) await delIfTagged(c, "f:" + legacy, LEGACY_TAG + primary);
          return;
        } catch (e) {
          console.error("[replay-guard] redis settle failed, falling back to local state:", e.message);
        }
      }
      inFlight.delete(key);
      while (consumed.size >= maxEntries) {
        const oldest = consumed.keys().next().value;
        if (oldest === undefined) break;
        consumed.delete(oldest);
      }
      consumed.delete(key);
      consumed.set(key, now + holdMs);
    },
    /** Release the nonce — call when the gated call was NOT granted, so a
     *  legitimate retry of the still-valid authorization can proceed. */
    async release(key) {
      stopRenew(key);
      const c = await getSharedRedisClient();
      if (c) {
        try {
          const { primary, legacy } = namesOf(key);
          await c.del(REDIS_PREFIX + "f:" + primary);
          if (legacy) await delIfTagged(c, "f:" + legacy, LEGACY_TAG + primary);
          return;
        } catch (e) {
          console.error("[replay-guard] redis release failed, falling back to local state:", e.message);
        }
      }
      inFlight.delete(key);
    },
    /** Introspection for tests / stats — LOCAL fallback state only; Redis
     *  state is shared and has no single-process notion of "size". */
    _state() {
      return { consumed: consumed.size, inFlight: inFlight.size, renewing: renewers.size };
    },
  };
}
