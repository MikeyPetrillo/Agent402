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
// OFFER_SWEEP_FIRST_MS after a start) as well as in front of every mint, so an
// unpaid offer's data is gone within OFFER_SWEEP_AFTER_MS + one interval.
/** How long a minted subscribe challenge stays payable. */
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** An unpaid offer is swept this long after its mint (past the challenge's life). */
export const OFFER_SWEEP_AFTER_MS = 2 * CHALLENGE_TTL_MS;
/** How often the offer sweep also runs on its own timer. */
export const OFFER_SWEEP_INTERVAL_MS = 10 * 60_000;
/** The timer's first run after a start. */
export const OFFER_SWEEP_FIRST_MS = 60_000;

/** The unpaid-offer figures /privacy prints: payable for, swept every, deleted within (minutes). */
export function offerRetentionPublic() {
  const min = (ms) => Math.ceil(ms / 60_000);
  return { payableMinutes: min(CHALLENGE_TTL_MS), sweepMinutes: min(OFFER_SWEEP_INTERVAL_MS), deletedWithinMinutes: min(OFFER_SWEEP_AFTER_MS + OFFER_SWEEP_INTERVAL_MS) };
}
