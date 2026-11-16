// The background read-back of owed card refunds (src/human-checkout.js).
// A buyer's poll retries an owed refund a bounded number of times; a refund
// made by hand in the Stripe dashboard after that would leave the record owed
// for good. This pass reads each owed record's payment back from Stripe (its
// refunds and its charge, never a new refund) and records the refund when the
// charge is fully refunded. The figures live here so /changelog can print
// them without loading the checkout module.

/** The pass's first run after a start. */
export const READBACK_FIRST_MS = 5 * 60_000;
/** How often the pass runs after that. */
export const READBACK_INTERVAL_MS = 30 * 60_000;
/** Owed records read back per pass. */
export const READBACK_MAX_PER_PASS = 20;
/** How long one record's Stripe read is waited for. */
export const READBACK_CALL_TIMEOUT_MS = 15_000;
/** The pass's lease: longer than a full pass of timed-out reads. */
export const READBACK_LEASE_TTL_MS = 10 * 60_000;
