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
 * Pure, offline, no network — unit-testable in isolation.
 */
import { createHash } from "node:crypto";

/**
 * Stable replay identity for the x402 payment credential on this request, or
 * null when there is nothing to guard (no payment header — a proof-of-work
 * call, an unpaid discovery crawl, or a marketplace-bridged request that
 * already settled elsewhere).
 *
 * Prefers the network-scoped EIP-3009 nonce — the exact value the on-chain
 * `transferWithAuthorization` consumes — so a re-encoded-but-equivalent
 * authorization still maps to one identity. Falls back to hashing the raw
 * credential for schemes whose nonce we can't parse (e.g. an SVM signed
 * transaction), where the header bytes themselves are the single-use artifact.
 */
export function paymentReplayKey(req) {
  const cred =
    (req.header && (req.header("x-payment") || req.header("payment-signature"))) || null;
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
 * In-memory replay guard. `consumed` maps a settled nonce → the time it settled;
 * `inFlight` is the set of nonces whose gated call is currently mid-settle.
 *
 * Bounded: entries expire after `ttlMs` (well past any realistic authorization
 * validity window) and total consumed entries are capped at `maxEntries` with
 * FIFO eviction. Eviction is always safe — once a nonce has settled on-chain it
 * is permanently dead there, so forgetting it in memory cannot enable a replay
 * (the facilitator would reject it anyway); this guard only makes the rejection
 * earlier and cheaper.
 */
export function createReplayGuard({ ttlMs = 60 * 60 * 1000, maxEntries = 50_000 } = {}) {
  const consumed = new Map(); // key -> settledAt (ms)
  const inFlight = new Set();

  // Prune expired consumed entries. Keys are inserted in non-decreasing settle
  // time (each key is consumed at most once, always with the current clock), so
  // the oldest sit at the head of the Map and we can stop at the first live one.
  function prune(now) {
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
    begin(key, now = Date.now()) {
      prune(now);
      if (consumed.has(key)) return "consumed";
      if (inFlight.has(key)) return "inflight";
      inFlight.add(key);
      return "ok";
    },
    /** Mark the nonce consumed — call only when the gated call was granted (200). */
    settle(key, now = Date.now()) {
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
    release(key) {
      inFlight.delete(key);
    },
    /** Introspection for tests / stats. */
    _state() {
      return { consumed: consumed.size, inFlight: inFlight.size };
    },
  };
}
