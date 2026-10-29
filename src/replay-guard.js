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
 * the same server) when REDIS_URL is configured and reachable. FAILS OPEN to
 * the original per-process Map/Set on any Redis absence or failure - this is
 * the opposite fail-direction from shared-limit.js's rate limiter, and
 * deliberately so: that limiter protects a metered FREE-TIER budget, where
 * failing open means unmetered free access (a direct loss). This guard is
 * documented defense-in-depth on top of a chain-enforced guarantee that holds
 * with or without it, so degrading to "exactly today's per-process guarantee"
 * during a Redis blip is strictly better than refusing every paid call over
 * an optimization layer going dark.
 */
import { createHash } from "node:crypto";
import { paymentHeaderOf } from "./payer.js";
import { getSharedRedisClient } from "./shared-limit.js";

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
 * Prefers the network-scoped EIP-3009 nonce — the exact value the on-chain
 * `transferWithAuthorization` consumes — so a re-encoded-but-equivalent
 * authorization still maps to one identity. Falls back to hashing the raw
 * credential for schemes whose nonce we can't parse (e.g. an SVM signed
 * transaction), where the header bytes themselves are the single-use artifact.
 */
export function paymentReplayKey(req) {
  const cred =
    paymentHeaderOf(req);   // middleware order — see src/payer.js
  if (!cred || typeof cred !== "string") return null;
  try {
    const p = JSON.parse(Buffer.from(cred, "base64").toString("utf-8"));
    const nonce = p?.payload?.authorization?.nonce;
    const network = p?.network || p?.payload?.network || "?";
    if (typeof nonce === "string" && nonce) {
      return "n:" + createHash("sha256").update(`${network}:${nonce.toLowerCase()}`).digest("hex");
    }
  } catch {
    /* not base64 JSON, or no parseable nonce — fall through to raw identity */
  }
  return "c:" + createHash("sha256").update(cred).digest("hex");
}

/**
 * Replay guard. Redis-backed (shared across replicas) when configured and
 * reachable; otherwise the original per-process fallback below. `consumed`
 * maps a settled nonce → the time it settled; `inFlight` is the set of nonces
 * whose gated call is currently mid-settle. All three methods are now async
 * (a Redis round trip on the common path) - the server.js call site already
 * runs inside an async middleware.
 *
 * Bounded: entries expire after `ttlMs` (well past any realistic authorization
 * validity window) and total LOCAL consumed entries are capped at `maxEntries`
 * with FIFO eviction (Redis expires its own keys via TTL, no separate cap
 * needed). Eviction is always safe — once a nonce has settled on-chain it
 * is permanently dead there, so forgetting it cannot enable a replay
 * (the facilitator would reject it anyway); this guard only makes the rejection
 * earlier and cheaper.
 */
export function createReplayGuard({ ttlMs = 60 * 60 * 1000, maxEntries = 50_000, inflightTtlSeconds = INFLIGHT_TTL_SECONDS, renewMs = INFLIGHT_RENEW_MS, maxHoldMs = MAX_HOLD_MS } = {}) {
  // Local (per-process) fallback state — used whenever Redis is unset or a
  // call to it fails, so a single replica or a Redis outage degrades to
  // exactly the pre-Redis guarantee, never to zero protection.
  const consumed = new Map(); // key -> settledAt (ms)
  const inFlight = new Set();
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  // key -> interval renewing this process's Redis claim on it.
  const renewers = new Map();
  function startRenew(key) {
    stopRenew(key);
    const until = Date.now() + maxHoldMs;
    const t = setInterval(async () => {
      if (Date.now() >= until) { stopRenew(key); return; }
      try {
        const c = await getSharedRedisClient();
        if (c) await c.expire(REDIS_PREFIX + "f:" + key, inflightTtlSeconds);
      } catch { /* the next tick retries */ }
    }, renewMs);
    t.unref?.();
    renewers.set(key, t);
  }
  function stopRenew(key) {
    const t = renewers.get(key);
    if (t) { clearInterval(t); renewers.delete(key); }
  }

  // Prune expired local consumed entries. Keys are inserted in non-decreasing
  // settle time (each key is consumed at most once, always with the current
  // clock), so the oldest sit at the head of the Map and we can stop at the
  // first live one.
  function pruneLocal(now) {
    const cutoff = now - ttlMs;
    for (const [k, at] of consumed) {
      if (at < cutoff) consumed.delete(k);
      else break;
    }
  }

  return {
    /**
     * Claim the nonce for this in-flight call. Returns:
     *   "ok"       — first use; caller proceeds to the paywall
     *   "inflight" — an identical authorization is mid-settle (concurrent replay)
     *   "consumed" — this authorization already settled (sequential replay)
     */
    async begin(key, now = Date.now()) {
      const c = await getSharedRedisClient();
      if (c) {
        try {
          if (await c.get(REDIS_PREFIX + "c:" + key)) return "consumed";
          // SET NX is the atomic claim: two replicas racing this same key
          // cannot both receive a non-null reply, which is exactly the
          // property inFlight.add() gave for free within one process.
          const claimed = await c.set(REDIS_PREFIX + "f:" + key, String(now), { NX: true, EX: inflightTtlSeconds });
          if (!claimed) return "inflight";
          startRenew(key);
          return "ok";
        } catch (e) {
          console.error("[replay-guard] redis begin failed, falling back to local state:", e.message);
          // fall through to the local path below
        }
      }
      pruneLocal(now);
      if (consumed.has(key)) return "consumed";
      if (inFlight.has(key)) return "inflight";
      inFlight.add(key);
      return "ok";
    },
    /** Mark the nonce consumed — call only when the gated call was granted (200). */
    async settle(key, now = Date.now()) {
      stopRenew(key);
      const c = await getSharedRedisClient();
      if (c) {
        try {
          await c.del(REDIS_PREFIX + "f:" + key);
          await c.set(REDIS_PREFIX + "c:" + key, String(now), { EX: ttlSeconds });
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
      consumed.set(key, now);
    },
    /** Release the nonce — call when the gated call was NOT granted, so a
     *  legitimate retry of the still-valid authorization can proceed. */
    async release(key) {
      stopRenew(key);
      const c = await getSharedRedisClient();
      if (c) {
        try {
          await c.del(REDIS_PREFIX + "f:" + key);
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
