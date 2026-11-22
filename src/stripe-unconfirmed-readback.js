// The background read-back of card captures whose outcome Stripe did not
// confirm (src/mpp-stripe.js settleStripeCredential: `unconfirmed`). Each one
// answered its buyer 402 and was booked in the refund ledger as an owed card
// row (unconfirmedCaptureDebt: wire mpp-stripe, keyed on the PaymentIntent
// when Stripe named one, else on the request, with the challenge id in the
// note). This pass reads each such row's PaymentIntent back from Stripe
// (paymentIntents.retrieve, or a search on the mpp_challenge_id metadata mppx
// writes; never a create, a capture, a cancel or a refund) and closes what
// Stripe settles:
//   - succeeded, and a sale is booked under that PaymentIntent (the earlier
//     request a replayed capture named was served): voided, nothing is owed;
//   - succeeded, no sale: the buyer was charged and not served; the row stays
//     owed for the refund, its note now saying Stripe confirmed the charge
//     (and naming the PaymentIntent), so it leaves this pass;
//   - canceled, or requires_payment_method (the attempt failed): voided;
//   - no PaymentIntent carries the challenge id, an hour or more after the
//     row was booked (search reads lag behind writes by about a minute):
//     voided, nothing was made;
//   - anything else (processing, requires_capture, requires_action, a read
//     that failed or ran out): left as it is and read again on a later pass.
// So a human handles only the refunds Stripe confirmed and what stays unknown.
// At most READBACK_MAX_PER_PASS rows per pass, those read longest ago first,
// each read waited for READBACK_CALL_TIMEOUT_MS; the pass runs under a lease.

/** The pass's first run after a start, and how often it runs after that. */
export const UNCONFIRMED_READBACK_FIRST_MS = 2 * 60_000;
export const UNCONFIRMED_READBACK_INTERVAL_MS = 10 * 60_000;
/** Rows read per pass. */
export const UNCONFIRMED_READBACK_MAX_PER_PASS = 20;
/** How long one Stripe read is waited for. */
export const UNCONFIRMED_READBACK_CALL_TIMEOUT_MS = 10_000;
/** A row is first read once it is this old (Stripe finishes a capture it was still processing). */
export const UNCONFIRMED_READBACK_MIN_AGE_MS = 2 * 60_000;
/** A challenge id no PaymentIntent carries is read as "nothing was made" only past this age. */
export const UNCONFIRMED_READBACK_ABSENT_AFTER_MS = 60 * 60_000;
/** Longer than a full pass of reads that all run out. */
export const UNCONFIRMED_READBACK_LEASE_TTL_MS = 10 * 60_000;
export const UNCONFIRMED_READBACK_LEASE = "stripe-unconfirmed-readback";

/** The note unconfirmedCaptureDebt writes starts so; a row this pass closed or renoted no longer does. */
const UNCONFIRMED_NOTE = /^card capture unconfirmed\b/;
const PI_ID = /^pi_[A-Za-z0-9_]{1,200}$/;
const CHALLENGE_IN_NOTE = /mpp_challenge_id=([A-Za-z0-9_-]{1,120})(?:$|[^A-Za-z0-9_-])/;
const VOIDED_STATES = new Set(["canceled", "requires_payment_method"]);

/** Is this refund-ledger row an unconfirmed card capture this pass reads? */
export function isUnconfirmedCardRow(row) {
  return !!row && row.status === "owed" && row.wire === "mpp-stripe" && UNCONFIRMED_NOTE.test(String(row.note || ""));
}

function bounded(p, ms) {
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ms); timer.unref?.(); });
  return Promise.race([Promise.resolve(p).then((v) => ({ v }), (e) => ({ e })), late]).finally(() => clearTimeout(timer));
}

/**
 * Create the read-back. `client` is a Stripe client (paymentIntents.retrieve
 * and .search); `listOwed()` the owed refund rows; `voidRow(row, note)` and
 * `renoteRow(row, from, to)` the ledger's guarded changes (true when the row
 * moved; a Promise of it in database mode); `saleStands(piId)` whether a sale
 * is booked under that PaymentIntent.
 */
export function createUnconfirmedCardReadback({ client, listOwed, voidRow, renoteRow, saleStands = () => false, now = () => Date.now(), log = console.warn,
  maxPerPass = UNCONFIRMED_READBACK_MAX_PER_PASS, callTimeoutMs = UNCONFIRMED_READBACK_CALL_TIMEOUT_MS,
  minAgeMs = UNCONFIRMED_READBACK_MIN_AGE_MS, absentAfterMs = UNCONFIRMED_READBACK_ABSENT_AFTER_MS } = {}) {
  const lastReadAt = new Map(); // evidence -> when this pass last read it
  const opts = { timeout: callTimeoutMs, maxNetworkRetries: 0 };

  async function lookup(row) {
    if (PI_ID.test(String(row.evidence))) {
      const r = await bounded(client.paymentIntents.retrieve(row.evidence, {}, opts), callTimeoutMs);
      return r.v ? { pi: r.v } : { failed: true };
    }
    const id = CHALLENGE_IN_NOTE.exec(String(row.note || ""))?.[1];
    if (!id) return { unreadable: true };
    const r = await bounded(client.paymentIntents.search({ query: `metadata['mpp_challenge_id']:'${id}'`, limit: 2 }, opts), callTimeoutMs);
    if (!r.v) return { failed: true };
    const found = Array.isArray(r.v.data) ? r.v.data : [];
    if (found.length > 1) return { unreadable: true }; // one challenge, one key: two is not ours to settle
    return found.length ? { pi: found[0] } : { absent: id };
  }

  async function pass({ max = maxPerPass } = {}) {
    const t = now();
    let rows = [];
    try { rows = (await listOwed()) || []; } catch { return { checked: 0, voided: 0, charged: 0, unknown: 0, failed: 1 }; }
    const due = rows.filter((r) => isUnconfirmedCardRow(r) && t - Number(r.createdAt || 0) >= minAgeMs)
      .sort((a, b) => (lastReadAt.get(a.evidence) || 0) - (lastReadAt.get(b.evidence) || 0) || Number(a.id) - Number(b.id));
    const out = { checked: 0, voided: 0, charged: 0, unknown: 0, failed: 0 };
    for (const row of due.slice(0, Math.max(0, max))) {
      out.checked++;
      lastReadAt.set(row.evidence, now());
      const found = await lookup(row);
      if (found.failed) { out.failed++; continue; }
      const age = t - Number(row.createdAt || 0);
      if (found.absent) {
        if (age < absentAfterMs) { out.unknown++; continue; }
        if (await voidRow(row, `card capture read back: no Stripe PaymentIntent carries mpp_challenge_id=${found.absent}, nothing was charged`)) out.voided++;
        continue;
      }
      const pi = found.pi;
      const piId = PI_ID.test(String(pi?.id)) ? pi.id : null;
      if (!piId) { out.unknown++; continue; }
      if (VOIDED_STATES.has(pi.status)) {
        if (await voidRow(row, `card capture read back: Stripe shows ${piId} ${pi.status}, nothing was charged`)) out.voided++;
        continue;
      }
      if (pi.status !== "succeeded") { out.unknown++; continue; }
      let served = false;
      try { served = (await saleStands(piId)) === true; } catch { out.failed++; continue; }
      if (served) {
        if (await voidRow(row, `card capture read back: Stripe shows ${piId} succeeded and the request it paid was served and booked as a sale`)) out.voided++;
        continue;
      }
      const to = `card capture confirmed charged: Stripe shows ${piId} succeeded and the buyer was answered 402; refund owed`;
      if (await renoteRow(row, row.note, to)) out.charged++;
    }
    for (const k of lastReadAt.keys()) if (!rows.some((r) => r.evidence === k && isUnconfirmedCardRow(r))) lastReadAt.delete(k);
    if (out.voided || out.charged || out.failed) log(`[mpp-stripe] unconfirmed capture read-back: ${out.checked} read, ${out.voided} voided, ${out.charged} confirmed charged (refund owed), ${out.unknown} still unknown, ${out.failed} reads failed`);
    return out;
  }
  return { pass, _lastReadAt: lastReadAt };
}

let timer = null;
/** Start the pass under its lease, once per process (unref'd; the first run is held back off the boot path). */
export function startUnconfirmedCardReadback(readback, { intervalMs = UNCONFIRMED_READBACK_INTERVAL_MS, firstMs = UNCONFIRMED_READBACK_FIRST_MS } = {}) {
  if (timer || !readback || typeof readback.pass !== "function") return null;
  timer = "starting";
  return (async () => {
    const [{ leased }, { contained }] = await Promise.all([import("./state-db.js"), import("./contained-turn.js")]);
    const tick = leased(UNCONFIRMED_READBACK_LEASE, { ttlMs: UNCONFIRMED_READBACK_LEASE_TTL_MS }, () => readback.pass());
    const run = contained(UNCONFIRMED_READBACK_LEASE, () => tick().catch(() => {}));
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    const first = setTimeout(run, firstMs);
    first.unref?.();
  })().catch((e) => { timer = null; console.warn(`[mpp-stripe] unconfirmed capture read-back did not start: ${String(e?.message || e).slice(0, 120)}`); });
}
