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
