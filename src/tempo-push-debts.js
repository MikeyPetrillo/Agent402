// Debts for Tempo PUSH transfers that reached us but were not claimed for the
// request they were sent for (src/mpp-tempo.js createTempoGate calls these).
//
// A push credential names a transfer the buyer already sent. The relay
// confirms it pays the challenge; finalize then claims the hash for this
// request. Two ways it can end unclaimed with the money at our recipient:
//   - the input check refused the body BEFORE finalize. The hash is still
//     claimable, so the buyer may present the same credential again with a
//     corrected body; until then (and forever, if they never do) we hold their
//     money for nothing, so it is booked as owed at refusal. A later claim
//     that is SERVED (final 200) voids that row: never both served and
//     refunded.
//   - finalize itself was refused (not because the hash was already claimed).
//     Booked as owed, and counted as a charged failure: the buyer paid and got
//     a 402. Our own synthetic traffic is booked (flagged) but not counted.
// Every write is keyed on the transaction hash, so a repeat books nothing new.

export const PUSH_INPUT_REFUSED_NOTE = "push unclaimed: input refused";
export const PUSH_FINALIZE_REFUSED_NOTE = "push unclaimed: finalize refused";
export const PUSH_CLAIMED_NOTE = "claimed on retry";
export const PUSH_HANGUP_AFTER_CLAIM_NOTE = "claimed on retry, then disconnected";
export const PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE = "claimed on retry, then the handler failed";
// The charged_failures table reads status 402 as a settlement rejection (the
// buyer kept their money) and leaves it out of the genuine count. A finalize
// refusal after the relay confirmed the transfer is the opposite: the money
// moved. It is recorded as 502 (the claim failed on our side of the relay).
export const PUSH_FINALIZE_FAILURE_STATUS = 502;

export function createTempoPushDebts({ recordOwed, voidOnClaim, renoteOwed, refundByEvidence, promoteToHangup = () => false, restateHandlerFailure = () => false, recordChargedFailure, isSynthetic = () => false, slugOf = () => "unknown" }) {
  const base = (req, { hash, payer, amountUsd }) => ({
    slug: slugOf(req) || "unknown",
    network: "tempo",
    payer: payer || null,
    priceUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
    tx: hash,
    synthetic: !!isSynthetic(req),
    wire: "mpp-tempo",
  });
  return {
    /** Input refused before finalize. True when a debt stands for the hash. */
    inputRefused(req, info) {
      if (!info?.hash) return false;
      recordOwed({ ...base(req, info), httpStatus: Number(info.status) || 400, note: PUSH_INPUT_REFUSED_NOTE });
      return refundByEvidence(info.hash)?.status === "owed";
    },
    /** Finalize refused. True when a debt stands for the hash. */
    notClaimed(req, info) {
      if (!info?.hash) return false;
      const b = base(req, info);
      const created = recordOwed({ ...b, httpStatus: 402, note: PUSH_FINALIZE_REFUSED_NOTE });
      // An input-refused row for the same hash becomes this row, once.
      const promoted = !created && renoteOwed(info.hash, PUSH_INPUT_REFUSED_NOTE, PUSH_FINALIZE_REFUSED_NOTE);
      if ((created || promoted) && !b.synthetic) recordChargedFailure(b.slug, PUSH_FINALIZE_FAILURE_STATUS);
      return refundByEvidence(info.hash)?.status === "owed";
    },
    /** A disconnect debt for a claimed push transfer whose hash already
     *  carries an OWED input-refused row (the corrected retry was claimed,
     *  then the buyer hung up before the first byte). The row becomes the
     *  disconnect it now is, so the refund planner's hang-up holds (lasting
     *  effect, repeat hang-up) read it. A row being sent, paid or void is
     *  never touched. True when the row changed. */
    hungUp(hash, hangupReason) {
      if (typeof hash !== "string" || !hash) return false;
      return promoteToHangup(hash, { from: PUSH_INPUT_REFUSED_NOTE, hangupReason, append: PUSH_HANGUP_AFTER_CLAIM_NOTE }) === true;
    },
    /** A claimed push whose handler then answered >= 400 (not a disconnect)
     *  on a hash that already carries an OWED input-refused row: the row takes
     *  the handler's status and says the retry was claimed and then failed, so
     *  a reviewer reads what happened. Sending, paid or void rows are never
     *  touched. True when the row changed. */
    handlerFailed(hash, httpStatus) {
      if (typeof hash !== "string" || !hash) return false;
      return restateHandlerFailure(hash, { from: PUSH_INPUT_REFUSED_NOTE, httpStatus, append: PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE }) === true;
    },
    /** At finish: a push credential that was claimed AND served voids its debt. */
    served(req, res) {
      const hash = Object.hasOwn(req, "mppTempoPushHash") ? req.mppTempoPushHash : null;
      if (!req.tempoSettled || res.statusCode !== 200 || typeof hash !== "string" || !hash) return false;
      const voided = voidOnClaim(hash, PUSH_CLAIMED_NOTE);
      if (!voided) {
        const row = refundByEvidence(hash);
        if (row && (row.status === "sending" || row.status === "paid")) console.error(`[mpp-tempo] REFUNDED-AND-SERVED: push transfer ${hash} was claimed and served while its debt was already ${row.status}; review refund #${row.id}`);
      }
      return voided;
    },
  };
}

// A Tempo push credential's sender is read from the chain BESIDE the handler
// (src/mpp-tempo.js sets req.mppTempoLedgerPayerRead, a promise that always
// resolves, bounded at PUSH_SENDER_WAIT_MS). A booking that names the payer
// runs once that read has settled; everything else, the handler included,
// never waits on it. Own properties only.
export function tempoLedgerPayerPending(req) {
  return !!req && Object.hasOwn(req, "mppTempoLedgerPayerRead")
    && !(Object.hasOwn(req, "mppTempoLedgerPayerReadDone") && req.mppTempoLedgerPayerReadDone === true)
    && typeof req.mppTempoLedgerPayerRead?.then === "function";
}
/** Run `fn` now when no sender read is pending, else once it settles. */
export function whenTempoLedgerPayerKnown(req, label, fn) {
  if (!tempoLedgerPayerPending(req)) return fn();
  const run = () => { try { fn(); } catch (e) { console.error(`[${label}] deferred booking failed: ${e?.message || e}`); } };
  req.mppTempoLedgerPayerRead.then(run, run);
  return undefined;
}
