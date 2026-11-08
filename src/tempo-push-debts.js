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
// A PULL transaction that landed on chain after its request was answered 402
// (src/mpp-tempo.js watchLateTempoLanding): booked through notClaimed.
export const PULL_LANDED_AFTER_402_NOTE = "pull landed after its 402";
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
      const created = await recordOwed({ ...b, httpStatus: 402, note: info.cls === "landed-after-402" ? PULL_LANDED_AFTER_402_NOTE : PUSH_FINALIZE_REFUSED_NOTE });
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
//
// The sweep pages through EVERY row created before the cutoff (a hold's
// createdAt is never after its resolvedAt), oldest first, by createdAt
// window with a cursor that persists across ticks, at most
// PUSH_HELD_SWEEP_ROWS_PER_TICK rows a tick; a window that fills its page is
// halved until it does not, so no row is skipped however many share a
// range. At the cutoff the cursor starts over. The same walk notes owed rows
// left unpaid past OWED_ESCALATE_DAYS (an error line, at most once a day).
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
/** Rows one page of the walk reads, and rows one tick reads at most. */
export const PUSH_HELD_SWEEP_PAGE = 500;
export const PUSH_HELD_SWEEP_ROWS_PER_TICK = 5000;
/** An owed row unpaid this long is named in the pass's escalation line:
 *  OWED_ESCALATE_DAYS (default 7, 1 to 365). */
export function owedEscalateMs(env = process.env) {
  const d = Number(env.OWED_ESCALATE_DAYS);
  return (Number.isFinite(d) && d >= 1 && d <= 365 ? d : 7) * 86_400_000;
}

/** The ledger read the walk uses: rows created in [from, to), at most
 *  `limit`, each the full row (note, resolvedAt) for a void Tempo one. */
export function ledgerHeldPage(ledger) {
  return ({ from, to, limit }) => ledger.refundsCreatedBetween(from, to, { limit }).map((r) => (r?.status === "void" && r.network === "tempo" ? (ledger.refundByEvidence(r.evidence) || r) : r));
}

export function createHeldClaimSweep({ listVoid = null, listPage = null, oldestCreatedAt = null, reopenHeld, renoteVoid, saleFor = async () => null, journalWaiting = () => 0, now = () => Date.now(), maxAgeMs = pushHeldMaxMs(), log = console.warn, alarm = console.error, pageSize = PUSH_HELD_SWEEP_PAGE, rowsPerTick = PUSH_HELD_SWEEP_ROWS_PER_TICK, owedAgeMs = owedEscalateMs(), escalateEveryMs = 24 * 3600_000 } = {}) {
  const heldFrom = new Map(PUSH_CLAIMABLE_NOTES.map((from) => [`${from}; ${PUSH_CLAIMED_NOTE}`, from]));
  // The walk's cursor (createdAt) and window width, kept across ticks.
  let cursor = 0;
  let width = 0;
  let aged = { n: 0, oldest: null };
  let lastEscalationAt = -Infinity;
  const handle = async (row, cutoff, out) => {
    const from = heldFrom.get(row?.note);
    if (!from || row.network !== "tempo" || typeof row.evidence !== "string") return;
    const at = Number(row.resolvedAt ?? row.resolved_at);
    if (!Number.isFinite(at) || at > cutoff) return;
    let sale = null;
    try { sale = await saleFor(row.evidence); } catch { return; }
    if (sale) {
      if ((await renoteVoid(row.evidence, row.note, `${row.note}; ${PUSH_SERVED_NOTE}`)) === true) out.served++;
      return;
    }
    if ((await reopenHeld(row.evidence, { held: row.note, httpStatus: 500, note: `${from}; ${PUSH_RUN_UNFINISHED_NOTE}` })) === true) {
      out.reopened++;
      log(`[mpp-tempo] push transfer ${row.evidence} was held for a run that never finished; owed again`);
    }
  };
  // One page of the walk: the rows in [cursor, to) for the widest window
  // (from the last width, at most up to the cutoff) whose page is not full.
  const page = async (cutoff, out) => {
    let to = width > 0 ? Math.min(cutoff, cursor + width) : cutoff;
    for (;;) {
      out.reads++;
      const rows = (await listPage({ from: cursor, to, limit: pageSize })) || [];
      if (rows.length < pageSize) {
        // Room to spare: the next window may be wider.
        width = rows.length < pageSize / 4 ? Math.max(1, (to - cursor) * 2) : Math.max(1, to - cursor);
        return { rows, to };
      }
      if (to - cursor <= 1) {
        // One millisecond holds a full page: read all of it.
        out.reads++;
        return { rows: (await listPage({ from: cursor, to, limit: Number.MAX_SAFE_INTEGER })) || [], to };
      }
      to = cursor + Math.floor((to - cursor) / 2);
    }
  };
  return {
    async sweep() {
      const out = { reopened: 0, served: 0, waiting: false, rows: 0, reads: 0, passComplete: false };
      let waiting = 0;
      try { waiting = Number(await journalWaiting()) || 0; } catch { waiting = 1; }
      if (waiting > 0) { out.waiting = true; return out; }
      const t = now();
      const cutoff = t - maxAgeMs;
      if (!listPage) {
        // A caller that hands one list (tests of the row rules).
        let rows = [];
        try { rows = (await listVoid?.()) || []; } catch { return out; }
        for (const row of rows) await handle(row, cutoff, out);
        out.rows = rows.length;
        return out;
      }
      try {
        // A pass starts at the oldest row, not the epoch, so its first pages
        // are not spent halving across empty years.
        if (cursor === 0 && oldestCreatedAt) {
          const first = Number(await oldestCreatedAt());
          if (Number.isFinite(first) && first > 0) cursor = Math.min(first, cutoff);
        }
        while (cursor < cutoff && out.rows < rowsPerTick) {
          // Each page reads a synchronous store: yield between pages so one
          // tick never holds the event loop for the whole walk.
          if (out.reads > 0) await new Promise((r) => setImmediate(r));
          const { rows, to } = await page(cutoff, out);
          for (const row of rows) {
            out.rows++;
            if (row?.status === "owed" && Number(row.createdAt) <= t - owedAgeMs) {
              aged.n++;
              if (aged.oldest == null || Number(row.createdAt) < aged.oldest) aged.oldest = Number(row.createdAt);
            }
            await handle(row, cutoff, out);
          }
          cursor = to;
        }
      } catch { return out; }
      if (cursor >= cutoff) {
        // A full pass: start over, and name owed rows left unpaid too long.
        out.passComplete = true;
        out.owedAged = aged.n;
        if (aged.n > 0 && t - lastEscalationAt >= escalateEveryMs) { lastEscalationAt = t; try { alarm(`[refunds] ${aged.n} owed refund row(s) unpaid past ${Math.round(owedAgeMs / 86_400_000)} day(s), oldest created ${new Date(aged.oldest).toISOString()}; run the refund workflow or resolve them on /__operator/refunds.json`); } catch { /* logging never throws */ } }
        cursor = 0;
        width = 0;
        aged = { n: 0, oldest: null };
      }
      return out;
    },
  };
}

let heldSweepTimer = null;
/** Start the held-claim sweep under its lease (once per process). `saleFor(tx)` reads a
 *  sale by its transaction; the caller passes it so this module never imports the sales ledger. */
export function startTempoHeldClaimSweep({ intervalMs = PUSH_HELD_SWEEP_INTERVAL_MS, saleFor } = {}) {
  if (heldSweepTimer) return null;
  heldSweepTimer = "starting";
  const ready = (async () => {
    const [{ leased }, ledger] = await Promise.all([import("./state-db.js"), import("./refund-ledger.js")]);
    const sweeper = createHeldClaimSweep({
      listPage: ledgerHeldPage(ledger),
      oldestCreatedAt: ledger.oldestRefundCreatedAt,
      reopenHeld: ledger.reopenHeldClaim,
      renoteVoid: ledger.renoteVoidRefund,
      saleFor,
      journalWaiting: () => ledger.refundDeadLetterState().waiting,
    });
    const tick = leased(PUSH_HELD_SWEEP_LEASE, { ttlMs: Math.max(intervalMs, 120_000) }, () => sweeper.sweep());
    heldSweepTimer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (typeof heldSweepTimer.unref === "function") heldSweepTimer.unref();
  })().catch((e) => { heldSweepTimer = null; console.warn(`[mpp-tempo] held-claim sweep did not start: ${String(e?.message || e).slice(0, 120)}`); });
  return ready;
}
