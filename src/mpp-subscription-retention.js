// How long an ENDED MPP monitor subscription's reduced record is kept, and
// how often the sweep that deletes it runs. A module of its own so /privacy
// prints the figures the engine (src/mpp-subscriptions.js) runs with, without
// loading the payment stack.
//
// WHY 30 DAYS. The reduced record is what answers a question about the last
// charge: the subscriber's manage link shows it, and a refund is checked
// against its last transaction. The last charge bought one billing period,
// which is 30 days, so the record stays for one more period after the end.
// Everything the code itself reads from an ended record is far shorter: a
// renewal whose send timed out is settled against the chain within minutes,
// and a destroyed key's marker is kept 7 days. The sales ledger, not this
// record, is the lasting record of each payment.
const DAY_MS = 86_400_000;

/** An ended subscription's reduced record is deleted this long after the end. */
export const ENDED_RECORD_KEEP_MS = 30 * DAY_MS;
/** The sweep that reduces and deletes ended records runs this often. */
export const ENDED_SWEEP_INTERVAL_MS = 15 * 60_000;
/** Records one sweep run changes at most; the rest wait for the next run. */
export const ENDED_SWEEP_MAX_PER_RUN = 25;

/** The figures /privacy prints. */
export function endedRecordRetentionPublic() {
  return { keepDays: Math.round(ENDED_RECORD_KEEP_MS / DAY_MS), sweepMinutes: Math.round(ENDED_SWEEP_INTERVAL_MS / 60_000) };
}

// UNPAID OFFERS. Each unpaid 402 for a subscription persists a marker (the
// email and subject asked for) and a signing key. The challenge is payable for
// CHALLENGE_TTL_MS; the offer sweep drops an offer OFFER_SWEEP_AFTER_MS after
// its mint, and runs on a timer every OFFER_SWEEP_INTERVAL_MS (first run
// OFFER_SWEEP_FIRST_MS after a start) as well as in front of every mint, under
// a lease of OFFER_SWEEP_LEASE_TTL_MS. The worst case (offerWorstCaseMs) adds
// the first run after a restart and a dead container's lease to the sweep
// delay and one interval; /privacy prints OFFER_DELETED_WITHIN_MS, a ceiling
// with slack above that worst case for the sweep's own time.
/** How long a minted subscribe challenge stays payable. */
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** An unpaid offer is swept this long after its mint (past the challenge's life). */
export const OFFER_SWEEP_AFTER_MS = 2 * CHALLENGE_TTL_MS;
/** How often the offer sweep also runs on its own timer. */
export const OFFER_SWEEP_INTERVAL_MS = 10 * 60_000;
/** The timer's first run after a start. */
export const OFFER_SWEEP_FIRST_MS = 60_000;
/** The offer sweep's lease (a container that dies holding it blocks others this long). */
export const OFFER_SWEEP_LEASE_TTL_MS = 5 * 60_000;
/** The ceiling /privacy prints for an unpaid offer's deletion. */
export const OFFER_DELETED_WITHIN_MS = 60 * 60_000;
/** Sweep delay + one interval + the first run after a restart + a dead holder's lease. */
export function offerWorstCaseMs() {
  return OFFER_SWEEP_AFTER_MS + OFFER_SWEEP_INTERVAL_MS + OFFER_SWEEP_FIRST_MS + OFFER_SWEEP_LEASE_TTL_MS;
}

/** The unpaid-offer figures /privacy prints: payable for and swept every (minutes), and the deletion ceiling in words. */
export function offerRetentionPublic() {
  const min = (ms) => Math.ceil(ms / 60_000);
  const hours = OFFER_DELETED_WITHIN_MS / 3_600_000;
  const deletedWithin = hours === 1 ? "an hour" : Number.isInteger(hours) ? `${hours} hours` : `${min(OFFER_DELETED_WITHIN_MS)} minutes`;
  return { payableMinutes: min(CHALLENGE_TTL_MS), sweepMinutes: min(OFFER_SWEEP_INTERVAL_MS), deletedWithin };
}
