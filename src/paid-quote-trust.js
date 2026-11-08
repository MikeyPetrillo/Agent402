// Paid-quote trust: a client address that has just paid is not held to the
// unpaid-quote limiters.
//
// A stock x402 client fetches an unpaid quote before every paid call, so the
// metered gateway's unpaid-quote limiter (METERED_UNPAID_QUOTES_PER_MIN in
// src/unpaid-quote-budget.js) capped a paying buyer near that many PAID calls a
// minute. A client address whose call ended in a final 200 that settled on any
// rail (an x402 settle receipt on any chain, an MPP or Tempo receipt, a card
// capture, a credits debit) is trusted for PAID_QUOTE_TRUST_MS after that call;
// each new paid 200 slides the window. While trusted, its unpaid quotes are not
// counted by the metered limiter nor by the unpaid price-check budget.
//
// What does NOT trust an address: a free call (proof of work, the trial, a
// first-call allowance grant whose settle was skipped, a forgiven hang-up), a
// 4xx or 5xx, an idempotent replay (nothing settled), or FREE_MODE. The caller
// (server.js) marks only from the settlement-outcome hook
// (src/hangup-settlement.js onSettleOutcome), which runs on the FINAL response,
// never on handler status before settlement.
//
// The key is the unpaid budget's client key (`clientKeyOf`: the address, an
// IPv6 /64 as one; from Cloudflare's shared Worker egress address, the address
// plus the User-Agent token), so one paying Worker never trusts every Worker.
//
// Storage: the process keeps its own bounded map (at most `keyCap` addresses,
// least recently marked dropped first, entries expire with their window), and
// writes each mark through to the shared store (src/shared-limits.js, a flag
// with the window's expiry, keyed by a digest of the address, never the
// address). Another replica reads the shared flag only on the refusal path, so
// an unpaid quote costs no store round trip; a negative answer is held briefly
// so a flood of refused quotes cannot become a flood of store reads. A store
// that does not answer reads as not trusted: the limiters then limit normally.
//
// Counts leave this module bucketed (`stats`), never an address.
import { createHash } from "node:crypto";
import { shared as sharedStore } from "./shared-limits.js";
import { allowanceServed } from "./allowance-state.js";

export const PAID_QUOTE_TRUST_MINUTES = 10;
export const PAID_QUOTE_TRUST_MS = PAID_QUOTE_TRUST_MINUTES * 60_000;
export const PAID_QUOTE_TRUST_KEY_CAP = 20_000;
// How long a "not trusted" answer from the shared store is held per address.
export const PAID_QUOTE_TRUST_NEGATIVE_MS = 5_000;
const STORE_NAME = "paid-quote-trust";

/** Bucket a count so the operator view never carries an exact figure. */
export function trustBucket(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v === 0) return "0";
  if (v < 10) return "1-9";
  if (v < 100) return "10-99";
  if (v < 1000) return "100-999";
  return "1000+";
}

const digest = (key) => createHash("sha256").update(String(key)).digest("hex").slice(0, 32);

/**
 * @param {object} [o]
 * @param {object} [o.store]   the shared store (flagSet/flagGet as in src/shared-limits.js); null for none
 * @param {number} [o.windowMs]
 * @param {number} [o.keyCap]
 * @param {number} [o.negativeMs]
 * @param {() => number} [o.now]
 */
export function createPaidQuoteTrust({ store = sharedStore, windowMs = PAID_QUOTE_TRUST_MS, keyCap = PAID_QUOTE_TRUST_KEY_CAP, negativeMs = PAID_QUOTE_TRUST_NEGATIVE_MS, now = Date.now } = {}) {
  const local = new Map(); // key -> until (ms), least recently marked first
  const negative = new Map(); // key -> until (ms): the store said "not trusted"
  let marks = 0;

  const sweep = (map, t) => { for (const [k, until] of map) if (until <= t) map.delete(k); };
  const bound = (map, t) => {
    if (map.size <= keyCap) return;
    sweep(map, t);
    while (map.size > keyCap) map.delete(map.keys().next().value);
  };

  /** Trust `key` for the window from now (a paid 200 just settled). */
  function mark(key, t = now()) {
    if (!key) return;
    const until = t + windowMs;
    local.delete(key);
    local.set(key, until);
    negative.delete(key);
    bound(local, t);
    marks += 1;
    // Best-effort and never awaited: a store that does not answer leaves the
    // trust on this process only.
    try { void Promise.resolve(store?.flagSet?.(STORE_NAME, digest(key), until, { now: t })).catch(() => {}); } catch { /* never break a response */ }
  }

  /** This process's own record only: synchronous, no store read. */
  function trustedLocal(key, t = now()) {
    if (!key) return false;
    const until = local.get(key);
    if (!until) return false;
    if (until <= t) { local.delete(key); return false; }
    return true;
  }

  /** This process's record, else the shared store's. Resolves false when the
   *  store does not answer. Never rejects. */
  async function trusted(key, t = now()) {
    if (!key) return false;
    if (trustedLocal(key, t)) return true;
    const held = negative.get(key);
    if (held && held > t) return false;
    if (!store?.flagGet) return false;
    let until = 0;
    try {
      const r = await store.flagGet(STORE_NAME, digest(key), { now: t });
      until = r?.ok ? Number(r.until) || 0 : 0;
    } catch { until = 0; }
    if (until > t) {
      local.delete(key);
      local.set(key, Math.min(until, t + windowMs));
      bound(local, t);
      return true;
    }
    negative.delete(key);
    negative.set(key, t + negativeMs);
    bound(negative, t);
    return false;
  }

  /** Bucketed counts only, never a key. */
  function stats(t = now()) {
    sweep(local, t);
    return {
      windowMinutes: Math.round(windowMs / 60_000),
      trustedAddressesThisReplica: trustBucket(local.size),
      marksSinceBoot: trustBucket(marks),
      shared: Boolean(store?.flagGet) && store?.mode === "redis",
    };
  }

  return { mark, trusted, trustedLocal, stats, _size: () => local.size };
}

/** True when this final response proves a payment settled or was debited.
 *  Read in the settlement-outcome hook, after the gate decided. */
export function paidAndSettled(req, res, { settleReceipt = null } = {}) {
  try {
    if (!res || res.statusCode !== 200) return false;
    if (String(res.getHeader?.("X-Replayed-Answer") ?? "") === "1") return false;
    if (allowanceServed(req)) return false;
    if (req?.creditsSettled === true) return true;
    if (req?.tempoSettled === true || req?.stripeSettled === true) return true;
    if (res.getHeader?.("Payment-Receipt")) return true;
    const h = settleReceipt || res.getHeader?.("PAYMENT-RESPONSE") || res.getHeader?.("X-PAYMENT-RESPONSE");
    if (typeof h !== "string" || !h) return false;
    try { return JSON.parse(Buffer.from(h, "base64").toString("utf-8"))?.success === true; } catch { return false; }
  } catch { return false; }
}
