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
//     voids that row BEFORE its handler runs (claimForServe, one statement a
//     refund send's claim cannot interleave with) and is served only if it
//     did, or there was no owed row; a run that is then not served reopens
//     it. Never both served and refunded.
//   - finalize itself was refused (not because the hash was already claimed).
//     Booked as owed, and counted as a charged failure: the buyer paid and got
//     a 402. Our own synthetic traffic is booked (flagged) but not counted.
// Every write is keyed on the transaction hash, so a repeat books nothing new.

/** The clause a "refused before any payment was taken" line carries where a
 *  Tempo push credential can reach the route: its transfer is final before
 *  the call, so such a refusal books the transfer as owed instead. Read by
 *  the MCP connector's slow-call refusal and the HTTP sync windows. */
export const PUSH_EXCEPTION = ", except a Tempo transfer sent before the call, which is recorded as owed";

export const PUSH_INPUT_REFUSED_NOTE = "push unclaimed: input refused";
// A finalize whose answer was lost (a connection dropped after the request
// was sent, or a relay 5xx): the relay may or may not have claimed the hash.
// Booked owed like an input refusal, and voided the same way by a later
// claim that is served.
export const PUSH_FINALIZE_UNANSWERED_NOTE = "push unclaimed: finalize unanswered";
// The notes of a debt whose transfer may still be claimed by a retry.
export const PUSH_CLAIMABLE_NOTES = Object.freeze([PUSH_INPUT_REFUSED_NOTE, PUSH_FINALIZE_UNANSWERED_NOTE]);
export const PUSH_FINALIZE_REFUSED_NOTE = "push unclaimed: finalize refused";
export const PUSH_CLAIMED_NOTE = "claimed on retry";
export const PUSH_SERVED_NOTE = "served";
export const PUSH_HANGUP_AFTER_CLAIM_NOTE = "claimed on retry, then disconnected";
export const PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE = "claimed on retry, then the handler failed";
// The charged_failures table reads status 402 as a settlement rejection (the
// buyer kept their money) and leaves it out of the genuine count. A finalize
// refusal after the relay confirmed the transfer is the opposite: the money
// moved. It is recorded as 502 (the claim failed on our side of the relay).
export const PUSH_FINALIZE_FAILURE_STATUS = 502;

export function createTempoPushDebts({ recordOwed, voidOnClaim, voidForServe = null, reopenHeld = () => false, renoteVoid = () => false, renoteOwed, refundByEvidence, promoteToHangup = () => false, restateHandlerFailure = () => false, recordChargedFailure, isSynthetic = () => false, slugOf = () => "unknown" }) {
  // The note a held claim leaves on a claimable row (the void appends
  // PUSH_CLAIMED_NOTE to it); reopenHeld matches it exactly.
  const heldNoteOf = (from) => `${from}; ${PUSH_CLAIMED_NOTE}`;
  const HELD_NOTES = PUSH_CLAIMABLE_NOTES.map(heldNoteOf);
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
    /** Input refused before finalize, or (`info.unanswered`) a finalize whose
     *  answer was lost. True when a debt stands for the hash. */
    async inputRefused(req, info) {
      if (!info?.hash) return false;
      await recordOwed({ ...base(req, info), httpStatus: Number(info.status) || 400, note: info.unanswered === true ? PUSH_FINALIZE_UNANSWERED_NOTE : PUSH_INPUT_REFUSED_NOTE });
      return refundByEvidence(info.hash)?.status === "owed";
    },
    /** Finalize refused. True when a debt stands for the hash. */
    async notClaimed(req, info) {
      if (!info?.hash) return false;
      const b = base(req, info);
      const created = await recordOwed({ ...b, httpStatus: 402, note: PUSH_FINALIZE_REFUSED_NOTE });
      // A claimable row for the same hash becomes this row, once.
      let promoted = false;
      for (const from of PUSH_CLAIMABLE_NOTES) {
        if (created || promoted) break;
        promoted = (await renoteOwed(info.hash, from, PUSH_FINALIZE_REFUSED_NOTE)) === true;
      }
      if ((created || promoted) && !b.synthetic) recordChargedFailure(b.slug, PUSH_FINALIZE_FAILURE_STATUS);
      return refundByEvidence(info.hash)?.status === "owed";
    },
    /** A disconnect debt for a claimed push transfer whose hash already
     *  carries an OWED input-refused row (the corrected retry was claimed,
     *  then the buyer hung up before the first byte). The row becomes the
     *  disconnect it now is, so the refund planner's hang-up holds (lasting
     *  effect, repeat hang-up) read it. A row being sent, paid or void is
     *  never touched. True when the row changed. */
    async hungUp(hash, hangupReason) {
      if (typeof hash !== "string" || !hash) return false;
      for (const from of PUSH_CLAIMABLE_NOTES) {
        if ((await promoteToHangup(hash, { from, hangupReason, append: PUSH_HANGUP_AFTER_CLAIM_NOTE })) === true) return true;
      }
      // The claim was held (the row voided before the handler): owed again.
      for (const from of PUSH_CLAIMABLE_NOTES) {
        if ((await reopenHeld(hash, { held: heldNoteOf(from), httpStatus: 499, hangupReason, note: `${from}; ${PUSH_HANGUP_AFTER_CLAIM_NOTE}` })) === true) return true;
      }
      return false;
    },
    /** A claimed push whose handler then answered >= 400 (not a disconnect)
     *  on a hash that already carries an OWED input-refused row: the row takes
     *  the handler's status and says the retry was claimed and then failed, so
     *  a reviewer reads what happened. Sending, paid or void rows are never
     *  touched. True when the row changed. */
    async handlerFailed(hash, httpStatus) {
      if (typeof hash !== "string" || !hash) return false;
      for (const from of PUSH_CLAIMABLE_NOTES) {
        if ((await restateHandlerFailure(hash, { from, httpStatus, append: PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE })) === true) return true;
      }
      for (const from of PUSH_CLAIMABLE_NOTES) {
        if ((await reopenHeld(hash, { held: heldNoteOf(from), httpStatus, note: `${from}; ${PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE}` })) === true) return true;
      }
      return false;
    },
    /** BEFORE the handler, for a claimed push: may this run serve it? The
     *  transfer's owed debt (if any) is voided first, in one statement that a
     *  refund send's claim cannot interleave with, so the debt is either
     *  voided here (serve) or already being sent or paid (do not serve: the
     *  buyer is refunded). No debt, or one already void: serve. A run that
     *  then does not end in a served 200 reopens the row (hungUp,
     *  handlerFailed). Without voidForServe it answers from the mirror. */
    async claimForServe(req) {
      const hash = Object.hasOwn(req, "mppTempoPushHash") ? req.mppTempoPushHash : null;
      if (!req.tempoSettled || typeof hash !== "string" || !hash) return true;
      if (typeof voidForServe === "function" && (await voidForServe(hash, PUSH_CLAIMED_NOTE)) === true) return true;
      const row = refundByEvidence(hash);
      return !(row && (row.status === "sending" || row.status === "paid"));
    },
    /** At finish: a push credential that was claimed AND served voids its debt. */
    async served(req, res) {
      const hash = Object.hasOwn(req, "mppTempoPushHash") ? req.mppTempoPushHash : null;
      if (!req.tempoSettled || res.statusCode !== 200 || typeof hash !== "string" || !hash) return false;
      const voided = await voidOnClaim(hash, PUSH_CLAIMED_NOTE);
      if (!voided) {
        const row = refundByEvidence(hash);
        // Held before the handler (claimForServe) and now served: say so, so a
        // later reopen (hungUp, handlerFailed) never turns it back to owed.
        if (row && row.status === "void" && HELD_NOTES.includes(row.note)) return (await renoteVoid(hash, row.note, `${row.note}; ${PUSH_SERVED_NOTE}`)) === true;
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

// ---------------------------------------------------------------------------
// The held-claim sweep. claimForServe voids a claimable debt BEFORE its
// handler runs; the run's end then marks it served (served) or owed again
// (hungUp, handlerFailed). A process that dies in between leaves the row void
// with the hold's note forever: a buyer charged and possibly never served,
// with nothing owed. Under a lease, the sweep reopens a row still held past
// the longest a run can take (owed again, with a note that says why), unless
// a sale is booked for the transfer (then it is marked served). It does
// nothing while the refund ledger's journal holds writes waiting to land: a
// served note queued there would otherwise be read as a run that never ended.
// ---------------------------------------------------------------------------
export const PUSH_RUN_UNFINISHED_NOTE = "claimed on retry, then the run never finished";
export const PUSH_HELD_SWEEP_LEASE = "tempo-push-held-sweep";
/** How long a hold may stand before the sweep reads its run as dead:
 *  TEMPO_PUSH_HELD_MAX_MINUTES (default 30; a run is bounded well under it). */
export function pushHeldMaxMs(env = process.env) {
  const m = Number(env.TEMPO_PUSH_HELD_MAX_MINUTES);
  return (Number.isFinite(m) && m >= 5 && m <= 24 * 60 ? m : 30) * 60_000;
}
export const PUSH_HELD_SWEEP_INTERVAL_MS = 5 * 60_000;

export function createHeldClaimSweep({ listVoid, reopenHeld, renoteVoid, saleFor = async () => null, journalWaiting = () => 0, now = () => Date.now(), maxAgeMs = pushHeldMaxMs(), log = console.warn } = {}) {
  const heldFrom = new Map(PUSH_CLAIMABLE_NOTES.map((from) => [`${from}; ${PUSH_CLAIMED_NOTE}`, from]));
  return {
    async sweep() {
      const out = { reopened: 0, served: 0, waiting: false };
      let waiting = 0;
      try { waiting = Number(await journalWaiting()) || 0; } catch { waiting = 1; }
      if (waiting > 0) { out.waiting = true; return out; }
      let rows = [];
      try { rows = (await listVoid()) || []; } catch { return out; }
      const cutoff = now() - maxAgeMs;
      for (const row of rows) {
        const from = heldFrom.get(row?.note);
        if (!from || row.network !== "tempo" || typeof row.evidence !== "string") continue;
        const at = Number(row.resolvedAt ?? row.resolved_at);
        if (!Number.isFinite(at) || at > cutoff) continue;
        let sale = null;
        try { sale = await saleFor(row.evidence); } catch { continue; }
        if (sale) {
          if ((await renoteVoid(row.evidence, row.note, `${row.note}; ${PUSH_SERVED_NOTE}`)) === true) out.served++;
          continue;
        }
        if ((await reopenHeld(row.evidence, { held: row.note, httpStatus: 500, note: `${from}; ${PUSH_RUN_UNFINISHED_NOTE}` })) === true) {
          out.reopened++;
          log(`[mpp-tempo] push transfer ${row.evidence} was held for a run that never finished; owed again`);
        }
      }
      return out;
    },
  };
}

let heldSweepTimer = null;
/** Start the held-claim sweep under its lease (once per process). */
export function startTempoHeldClaimSweep({ intervalMs = PUSH_HELD_SWEEP_INTERVAL_MS } = {}) {
  if (heldSweepTimer) return null;
  heldSweepTimer = "starting";
  const ready = (async () => {
    const [{ leased }, ledger, { saleByTxFresh }] = await Promise.all([import("./state-db.js"), import("./refund-ledger.js"), import("./sales-ledger.js")]);
    const sweeper = createHeldClaimSweep({
      listVoid: () => ledger.listRefunds({ status: "void", limit: 2000 }),
      reopenHeld: ledger.reopenHeldClaim,
      renoteVoid: ledger.renoteVoidRefund,
      saleFor: (tx) => saleByTxFresh(tx),
      journalWaiting: () => ledger.refundDeadLetterState().waiting,
    });
    const tick = leased(PUSH_HELD_SWEEP_LEASE, { ttlMs: Math.max(intervalMs, 120_000) }, () => sweeper.sweep());
    heldSweepTimer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (typeof heldSweepTimer.unref === "function") heldSweepTimer.unref();
  })().catch((e) => { heldSweepTimer = null; console.warn(`[mpp-tempo] held-claim sweep did not start: ${String(e?.message || e).slice(0, 120)}`); });
  return ready;
}
