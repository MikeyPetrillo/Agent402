// The durable record of referral settlements that are not finished
// (src/referral-gate.js): one state document, written BEFORE the facilitator
// is asked to settle and resolved after.
//
// WHY. The gate settles after the handler, by a call that can take most of a
// minute. A process that stops in that call (a crash, a deploy's kill) leaves
// a payment that may have moved with no sale booked and no line logged; an
// answer the facilitator never gave leaves the same question open. Each
// settle is therefore an entry here first:
//
//   intent              written before /settle; the call is in flight
//   in-doubt            the call ended without saying whether the payment moved
//   charged-undelivered the payment moved and the buyer has not received the answer
//
// and the entry is removed when the call ends settled and delivered, or
// refused, or (charged and no longer deliverable) once a refund owed is
// recorded for it. What stays is exactly what still needs an answer. The
// tool's answer itself is stored apart (src/referral-answers.js), so a write
// here is small. A sweep (at boot
// and on a leased timer, startReferralBookSweep) reads every open entry
// against the chain (src/referral-chain.js): an authorization the chain has
// PAID (the receipt proves the transfer, chainVerdict) is booked as a sale,
// once, and kept as charged-undelivered; one whose nonce was spent without
// paying us (proven from a complete read of the range since the intent), or
// that expired unused, is closed with nothing booked; one that cannot be
// read stays for the next pass.
//
// Bounded: at most MAX_ENTRIES open entries, and at most PER_PAYER_MAX of
// them for one payer, so one payer's open settlements are that payer's own
// share and never decide whether another payer is served. At capacity the
// oldest in-doubt entry whose authorization can no longer be sent is RETIRED
// to make room: recorded (the last RETIRED_MAX, with an error line) for the
// operator, never silently dropped. A charged, owed or still-sendable entry
// is never retired; with none to retire a full book refuses a new intent
// (the gate answers 503 before /settle).
//
// AN END FOR A RECEIPT THAT IS NOT OURS. A spent authorization whose
// transaction was found, and whose receipt was read in full and is not a
// shape the proof rule recognizes, can never be proven either way. Once its
// authorization can no longer be sent (validBefore plus the clock slack) and
// the sweep has read that receipt in full UNRECOGNIZED_READS_MAX times, the
// entry is closed to an operator record (`closedUnrecognized`, the last
// CLOSED_MAX, an error line each): no sale is booked and no refund is written
// for it. A receipt the rule proves is booked the moment it is read, so one
// that IS ours never reaches this end. And a receipt whose routed event
// names OUR merchant id is never counted or closed, whatever else the rule
// finds wrong with it (a payout address or an amount that differs from this
// server's settings): the buyer paid our merchant, so the entry stays open
// for an operator. A close is recoverable: `reopenClosed` puts a record back
// as an open entry that is never closed by itself again.
//
// A SEND IN FLIGHT. The delivered mark carries `sendingUntil`: while that
// time has not passed the answer may still be going out, and the sweep does
// not close the entry (the send's own end closes it, or takes the mark back).
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { chainVerdict } from "./referral-chain.js";

export const REFERRAL_BOOK_DOC = "referral-settlements";
export const MAX_ENTRIES = 2000;
export const PER_PAYER_MAX = 40;
const RESOLVED_MAX = 200;
const RETIRED_MAX = 500;
const CLOSED_MAX = 500;
/** Full readings of an unrecognized receipt before the entry is closed to the operator record. */
export const UNRECOGNIZED_READS_MAX = 5;
const TX = /^0x[0-9a-fA-F]{64}$/;
/** An authorization is read as expired this long after its validBefore (host clock slack). */
export const EXPIRY_SLACK_MS = 120_000;

// With a state database the document is a row. Without one it is a file:
// REFERRAL_BOOK_FILE, else under /data when that volume exists, else under the
// system temp directory (as the other file stores do), so the book survives a
// restart in every mode.
export const referralBookFile = () => (process.env.REFERRAL_BOOK_FILE || join(existsSync("/data") ? "/data" : tmpdir(), "agent402-referral-settlements.json"));
const defaultFile = referralBookFile;

export function createReferralBook({ doc = null, file = defaultFile(), now = Date.now, log = console, maxEntries = MAX_ENTRIES, maxPerPayer = PER_PAYER_MAX } = {}) {
  const store = doc || createJsonDocument({ name: REFERRAL_BOOK_DOC, file, log: () => {} });
  let entries = {};
  // The gate's own hang-up forgiveness records ([time, micro-dollars, key
  // digests]), kept here so a restart does not refill that budget.
  let forgiven = [];
  // Entries an operator resolved by hand, with the note given (the last RESOLVED_MAX).
  let resolved = [];
  // Entries retired at capacity (the last RETIRED_MAX), for the operator.
  let retired = [];
  // Entries closed because their receipt, read in full, is not ours (the last CLOSED_MAX).
  let closed = [];
  // Sales whose receipt paid this merchant less than the rate map expects, by slug (the gate's record).
  let short = {};
  const lcPayer = (p) => String(p).toLowerCase();
  const heldBy = (cur, payer) => { const who = lcPayer(payer); let n = 0; for (const k in cur) if (cur[k] && cur[k].payer === who) n++; return n; };
  /** The oldest entry that may be retired at capacity: in doubt, and its
   *  authorization past its expiry (plus the clock slack), so no settle of it
   *  can still be sent. Null when there is none. */
  const retirable = (cur, t) => {
    let pick = null;
    for (const k in cur) {
      const e = cur[k];
      if (!e || e.state !== "in-doubt") continue;
      if (t <= (Number(e.validBefore) || 0) * 1000 + EXPIRY_SLACK_MS) continue;
      if (!pick || (e.at || 0) < (pick.at || 0)) pick = e;
    }
    return pick;
  };
  const absorb = (b) => {
    entries = b && typeof b === "object" && b.entries && typeof b.entries === "object" ? { ...b.entries } : {};
    forgiven = b && typeof b === "object" && Array.isArray(b.forgiven) ? b.forgiven.filter((r) => Array.isArray(r) && r.length === 3) : [];
    resolved = b && typeof b === "object" && Array.isArray(b.resolved) ? b.resolved.filter((r) => r && typeof r === "object") : [];
    retired = b && typeof b === "object" && Array.isArray(b.retired) ? b.retired.filter((r) => r && typeof r === "object") : [];
    closed = b && typeof b === "object" && Array.isArray(b.closed) ? b.closed.filter((r) => r && typeof r === "object") : [];
    short = b && typeof b === "object" && b.short && typeof b.short === "object" && !Array.isArray(b.short) ? { ...b.short } : {};
  };
  try { absorb(store.loadSync(null)); } catch { /* read below */ }
  const ready = Promise.resolve().then(() => store.load(null)).then((b) => { if (b) absorb(b); }).catch(() => {});
  const say = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };

  async function change(fn) {
    const r = await store.update((body) => {
      const cur = body && typeof body === "object" && body.entries && typeof body.entries === "object" ? { ...body.entries } : {};
      const kept = body && typeof body === "object" && Array.isArray(body.forgiven) ? body.forgiven : [];
      const done = body && typeof body === "object" && Array.isArray(body.resolved) ? body.resolved.slice() : [];
      const gone = body && typeof body === "object" && Array.isArray(body.retired) ? body.retired.slice() : [];
      const shut = body && typeof body === "object" && Array.isArray(body.closed) ? body.closed.slice() : [];
      const under = body && typeof body === "object" && body.short && typeof body.short === "object" && !Array.isArray(body.short) ? { ...body.short } : {};
      const out = fn(cur, kept, done, gone, shut, under);
      return out === SKIP_UPDATE ? SKIP_UPDATE : { entries: cur, forgiven: Array.isArray(out) ? out : kept, resolved: done.slice(-RESOLVED_MAX), retired: gone.slice(-RETIRED_MAX), closed: shut.slice(-CLOSED_MAX), short: under };
    }, { fallback: { entries: {}, forgiven: [], resolved: [], retired: [], closed: [], short: {} } });
    if (r.ok && r.body) absorb(r.body);
    return !!r.ok;
  }
  return {
    ready,
    /**
     * Write the intent to settle. Resolves true once it is stored, false
     * when it is not (a store fault, the payer's own share of the book
     * spent, or a book at capacity with no entry that may be retired: the
     * gate then does not call /settle). `fromBlock` is the chain head when the
     * intent was written: the proof of payment is looked for from there.
     */
    async intent({ key, slug, payer, nonce, amount, validBefore, fromBlock = null }) {
      const t = now();
      let full = false, payerFull = false, dropped = null;
      const ok = await change((cur, _kept, _done, gone) => {
        const prev = cur[key];
        dropped = null;
        if (!prev && heldBy(cur, payer) >= maxPerPayer) { payerFull = true; return SKIP_UPDATE; }
        if (!prev && Object.keys(cur).length >= maxEntries) {
          const stuck = retirable(cur, t);
          if (!stuck) { full = true; return SKIP_UPDATE; }
          gone.push({ key: stuck.key, slug: stuck.slug, payer: stuck.payer, amount: stuck.amount, tx: stuck.tx || null, state: stuck.state, checks: stuck.checks || 0, openedAt: stuck.at || null, at: t });
          delete cur[stuck.key];
          dropped = stuck;
        }
        cur[key] = { ...(prev || {}), key, slug: String(slug), payer: String(payer).toLowerCase(), nonce: String(nonce).toLowerCase(), amount: String(amount), validBefore: Number(validBefore) || 0, at: prev?.at || t, state: "intent", intentAt: t, attempts: (prev?.attempts || 0) + 1, tx: prev?.tx || null, saleBooked: prev?.saleBooked === true, fromBlock: prev?.fromBlock ?? (Number.isSafeInteger(fromBlock) && fromBlock > 0 ? fromBlock : null) };
        return undefined;
      });
      if (ok && dropped) say("error", `the settlement book was at capacity (${maxEntries}): the oldest in-doubt entry whose authorization has expired was retired to the operator record (${dropped.slug} payer=${String(dropped.payer).slice(0, 6)} tx=${dropped.tx || "none read"})`);
      if (payerFull) say("error", `one payer holds its whole share of the settlement book (${maxPerPayer} open entries, payer=${String(payer).slice(0, 6)}); its new settlement is refused before /settle until its entries resolve`);
      if (full) say("error", `the settlement book is full (${maxEntries} open entries, none may be retired); a new settlement is refused before /settle until entries resolve`);
      return ok && !full && !payerFull;
    },
    /** Change an entry (`patch` merged), or remove it (`patch` null).
     *  Resolves true only when the store answered AND the change stands: a
     *  patch on an entry that is not there is false; a removal of one that is
     *  already gone is true. A caller that must know (the delivered mark, a
     *  closing write) reads the result. */
    async resolve(key, patch) {
      let ran = false, found = false;
      const ok = await change((cur) => {
        ran = true;
        if (!cur[key]) return SKIP_UPDATE;
        found = true;
        if (patch === null) delete cur[key];
        else cur[key] = { ...cur[key], ...patch, updatedAt: now() };
        return undefined;
      });
      return ok && ran && (found || patch === null);
    },
    /** An operator closes an entry by hand: recorded with the outcome and
     *  the note (who, why), then removed, or, with `patch`, kept as patched
     *  (the refund-owed mark an owed entry keeps until its authorization
     *  expires). `debt` says whether a refund debt was written for it; `was`
     *  is the state it was resolved from, when the caller changed it since.
     *  `{ ok, entry }` (the entry as it stood). */
    async resolveByHand(key, { note = "", outcome = "dismissed", patch = null, debt = false, was = null } = {}) {
      let entry = null;
      const ok = await change((cur, _kept, done) => {
        if (!cur[key]) return SKIP_UPDATE;
        entry = cur[key];
        done.push({ key, slug: entry.slug, payer: entry.payer, amount: entry.amount, tx: entry.tx || null, state: typeof was === "string" && was ? was : entry.state, delivered: entry.delivered === true, outcome: String(outcome).slice(0, 40), debt: debt === true, note: String(note).slice(0, 300), at: now() });
        if (patch && typeof patch === "object") cur[key] = { ...entry, ...patch, updatedAt: now() };
        else delete cur[key];
        return undefined;
      });
      if (ok && entry) say("error", `an operator resolved a settlement by hand (${entry.slug} payer=${String(entry.payer).slice(0, 6)} state=${entry.state} outcome=${String(outcome).slice(0, 40)})`);
      return { ok: ok && !!entry, entry };
    },
    resolvedByHand: () => resolved.slice(),
    /** Entries retired at capacity, oldest first. */
    retiredAtCapacity: () => retired.slice(),
    /** One sale whose receipt paid this merchant less than the rate map
     *  expects, counted once per transaction under its slug:
     *  `{ count, deep, expected, received, gross, tx, firstAt, at }` (`deep`
     *  counts the ones the gate calls far under). Kept until the map admits
     *  the amount or an operator clears it (clearShort). */
    async noteShort(slug, { expected, received, gross, tx, deep = false } = {}) {
      const t = now();
      return change((_cur, _kept, _done, _gone, _shut, under) => {
        const prev = under[slug] && typeof under[slug] === "object" ? under[slug] : null;
        const txs = Array.isArray(prev?.txs) ? prev.txs : [];
        if (txs.includes(tx)) return SKIP_UPDATE;
        under[slug] = { count: (prev?.count || 0) + 1, deep: (prev?.deep || 0) + (deep ? 1 : 0), expected: String(expected), received: String(received), gross: String(gross), tx: String(tx), txs: [...txs, String(tx)].slice(-50), firstAt: prev?.firstAt || t, at: t };
        return undefined;
      });
    },
    /** The short-net record, by slug. */
    shortSales: () => ({ ...short }),
    /** Remove a slug's short-net record (the map admits the amount now, or an
     *  operator cleared it: then recorded with the note). */
    async clearShort(slug, { note = null } = {}) {
      let had = null;
      const ok = await change((_cur, _kept, done, _gone, _shut, under) => {
        had = under[slug] || null;
        if (!had) return SKIP_UPDATE;
        delete under[slug];
        if (note !== null) done.push({ key: `short:${slug}`, slug, payer: null, amount: had.gross, tx: had.tx, state: "short-net", delivered: true, outcome: "short-net-cleared", debt: false, note: String(note).slice(0, 300), at: now() });
        return undefined;
      });
      return ok && !!had;
    },
    /** Entries closed because their receipt, read in full, is not ours, oldest first. */
    closedUnrecognized: () => closed.slice(),
    /** An operator puts a closed record back as an open in-doubt entry (a
     *  close that was wrong): removed from the record, recorded with the
     *  note, and never closed by itself again (`noAutoClose`). `{ ok, entry }`. */
    async reopenClosed(key, { note = "" } = {}) {
      let entry = null, taken = false;
      const ok = await change((cur, _kept, done, _gone, list) => {
        entry = null; taken = false;
        const i = list.findIndex((r) => r && r.key === key);
        if (i < 0) return SKIP_UPDATE;
        if (cur[key]) { taken = true; return SKIP_UPDATE; }
        const r = list[i];
        entry = { key, slug: String(r.slug), payer: String(r.payer).toLowerCase(), nonce: String(r.nonce || "").toLowerCase(), amount: String(r.amount), validBefore: Number(r.validBefore) || 0, at: r.openedAt || now(), state: "in-doubt", attempts: 1, tx: null, seenTx: r.tx || null, saleBooked: false, fromBlock: r.fromBlock ?? null, ...(r.hangup ? { hangup: r.hangup } : {}), noAutoClose: true, reopenedAt: now(), why: r.why || null };
        cur[key] = entry;
        list.splice(i, 1);
        done.push({ key, slug: entry.slug, payer: entry.payer, amount: entry.amount, tx: entry.seenTx, state: "closed-unrecognized", delivered: false, outcome: "reopened", debt: false, note: String(note).slice(0, 300), at: now() });
        return undefined;
      });
      if (ok && entry) say("error", `an operator reopened a settlement closed as unrecognized (${entry.slug} payer=${String(entry.payer).slice(0, 6)} tx=${entry.seenTx || "none"})`);
      return { ok: ok && !!entry && !taken, entry };
    },
    /** The open entries that say this server's own bookkeeping is wrong: a
     *  contradicted one, or an unconfirmed one flagged because its receipt
     *  cannot be read. `[{ key, payer, state, scope }]`: a flagged
     *  unconfirmed entry is "route"; a contradicted one is "route" only when
     *  the gate wrote that scope on it, "payer" otherwise. */
    faults() {
      const out = [];
      for (const k in entries) {
        const e = entries[k];
        if (!e) continue;
        if (e.state === "contradicted" || (e.state === "unconfirmed" && e.flagged === true)) out.push({ key: k, payer: e.payer, state: e.state, scope: e.state === "unconfirmed" || e.scope === "route" ? "route" : "payer", moved: e.state === "contradicted" && e.moved === true, at: Number(e.contradictedAt) || 0 });
      }
      return out;
    },
    /** Record one forgiven hang-up; records older than `windowMs` are dropped, at most `max` kept. */
    async noteForgiven(record, { windowMs = 24 * 3600_000, max = 2000 } = {}) {
      const t = now();
      return change((_cur, kept) => [...kept.filter((r) => Array.isArray(r) && t - Number(r[0]) < windowMs), record].slice(-max));
    },
    forgiven: () => forgiven.slice(),
    get: (key) => entries[key] || null,
    /** The entries, newest first (the operator view). An entry holds no answer and no payment. */
    list: () => Object.values(entries).sort((a, b) => (b.at || 0) - (a.at || 0)).map(({ answer, payment, ...e }) => ({ ...e })),
    size: () => Object.keys(entries).length,
    /** At capacity with no entry that may be retired: nobody's new settlement can be recorded. */
    full: () => Object.keys(entries).length >= maxEntries && !retirable(entries, now()),
    /** True when a new settlement for this payer can be recorded: its own
     *  share is not spent, and the book has (or can make) room. */
    roomFor(payer) {
      if (heldBy(entries, payer) >= maxPerPayer) return false;
      return Object.keys(entries).length < maxEntries || !!retirable(entries, now());
    },
    counts: () => {
      const c = { intent: 0, "in-doubt": 0, "charged-undelivered": 0, unconfirmed: 0, contradicted: 0, "refund-owed": 0, delivering: 0 };
      for (const e of Object.values(entries)) if (e.state in c) c[e.state]++;
      return c;
    },
    /**
     * Read the open entries against the chain. `chain.state(...)` is the
     * reader; `bookSale(entry, transaction)` books the sale once and resolves
     * true when a row stands for it; `onCharged(entry)` is asked about every
     * charged-undelivered entry (the gate owes it an answer or a refund).
     * `graceMs` keeps the sweep off an intent whose settle call may still be
     * in flight in this process. At most `max` entries are read a pass, the
     * ones read least recently first, so every open entry is reached in turn.
     */
    async sweep({ chain, bookSale, payTo, minNetOf = () => null, onUnpaid = () => {}, onCharged = async () => {}, onUnrecognized = () => {}, unrecognizedMax = UNRECOGNIZED_READS_MAX, graceMs = 120_000, max = 50 } = {}) {
      const t = now();
      const out = { read: 0, landed: 0, unpaid: 0, expired: 0, unknown: 0, charged: 0, unrecognized: 0 };
      try { const b = await store.load(null); if (b) absorb(b); } catch { /* the last body read */ }
      const due = Object.values(entries)
        .filter((e) => (e.state === "in-doubt" || (e.state === "intent" && t - (e.intentAt || e.at || 0) >= graceMs)))
        .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0) || (a.at || 0) - (b.at || 0))
        .slice(0, max);
      for (const snapshot of due) {
        // The entry as it stands NOW: an earlier step of this pass, or a
        // request, may have changed or closed it since the list was made.
        const e = entries[snapshot.key];
        if (!e || (e.state !== "in-doubt" && e.state !== "intent")) continue;
        out.read++;
        let s;
        try { s = await chain.state({ from: e.payer, nonce: e.nonce, payTo, amount: e.amount, fromBlock: e.fromBlock, minNet: minNetOf(e) }); } catch { s = { used: null, paid: null, transaction: null, complete: false }; }
        const verdict = chainVerdict(s, { validBeforeMs: (Number(e.validBefore) || 0) * 1000, nowMs: t, slackMs: EXPIRY_SLACK_MS });
        if (verdict === "paid") {
          // The receipt proves the transfer: the only reading that books a sale.
          let booked = e.saleBooked === true;
          if (!booked) { try { booked = (await bookSale(e, s.transaction, s.net ?? null)) === true; } catch { booked = false; } }
          out.landed++;
          say("error", `CHARGED-BUT-NOT-SERVED: a settlement left open landed on chain (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${s.transaction})${booked ? ", sale booked" : ", sale NOT booked"}`);
          await this.resolve(e.key, { state: "charged-undelivered", tx: s.transaction, saleBooked: booked, landedAt: t });
        } else if (verdict === "unpaid") {
          // The nonce was spent without paying us: closed as not paid, nothing booked.
          out.unpaid++;
          say("error", `an authorization left open was spent on chain WITHOUT paying this route (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${s.transaction || "none of ours"}); closed as not paid, nothing booked`);
          try { onUnpaid(e); } catch { /* counting only */ }
          await this.resolve(e.key, null);
        } else if (verdict === "expired-unused") {
          out.expired++;
          await this.resolve(e.key, null);
        } else {
          out.unknown++;
          // The transaction that spent the nonce was found and its receipt
          // read in full, and it is not a shape the rule recognizes: counted,
          // and past the bound (with the authorization no longer sendable)
          // closed to the operator record. Never a sale, never a refund.
          const read = s?.used === true && s.paid === null && TX.test(String(s.transaction || "")) && s.receiptRead === true;
          // Routed to OUR merchant by the contract's own event, or put back by
          // an operator: never counted, never closed here.
          const keep = read && (s.routedToUs === true || e.noAutoClose === true);
          if (keep) {
            if (e.routedToUs !== true && s.routedToUs === true) say("error", `a spent authorization's transaction was routed to THIS merchant by the split contract, and the receipt is not one the proof rule accepts (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${String(s.transaction).toLowerCase()}: ${String(s.why || "").slice(0, 120)}); kept open for an operator, never closed by itself`);
            await this.resolve(e.key, { state: e.state === "intent" ? "in-doubt" : e.state, checks: (e.checks || 0) + 1, checkedAt: t, seenTx: String(s.transaction).toLowerCase(), ...(s.routedToUs === true ? { routedToUs: true } : {}), why: String(s.why || "").slice(0, 160) });
            continue;
          }
          const full = read;
          const reads = (e.unrecognizedReads || 0) + (full ? 1 : 0);
          const unsendable = t > (Number(e.validBefore) || 0) * 1000 + EXPIRY_SLACK_MS;
          if (full && unsendable && reads >= Math.max(1, unrecognizedMax)) {
            let shut = false;
            const tx = String(s.transaction).toLowerCase();
            const why = String(s.why || "a receipt shape the proof rule does not recognize").slice(0, 160);
            const done = await change((cur, _kept, _done, _gone, list) => {
              const now_ = cur[e.key];
              shut = false;
              if (!now_ || (now_.state !== "in-doubt" && now_.state !== "intent")) return SKIP_UPDATE;
              list.push({ key: e.key, slug: now_.slug, payer: now_.payer, nonce: now_.nonce, amount: now_.amount, validBefore: now_.validBefore, fromBlock: now_.fromBlock ?? null, hangup: now_.hangup || null, tx, state: now_.state, reads, why, openedAt: now_.at || null, at: t });
              delete cur[e.key];
              shut = true;
              return undefined;
            });
            if (done && shut) {
              out.unrecognized++;
              say("error", `a spent authorization's transaction is NOT a payment this route recognizes after ${reads} full readings of its receipt (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${tx}: ${why}); closed to the operator record, nothing booked, no refund written`);
              try { onUnrecognized(e, tx); } catch { /* counting only */ }
              continue;
            }
          }
          await this.resolve(e.key, { state: e.state === "intent" ? "in-doubt" : e.state, checks: (e.checks || 0) + 1, checkedAt: t, ...(full ? { unrecognizedReads: reads, seenTx: String(s.transaction).toLowerCase() } : {}) });
        }
      }
      // A refund-owed mark is kept until its authorization can no longer be sent again.
      for (const key of Object.keys(entries)) {
        const e = entries[key];
        if (e && e.state === "refund-owed" && t > (Number(e.validBefore) || 0) * 1000 + EXPIRY_SLACK_MS) await this.resolve(key, null);
      }
      // A charged entry is closed only by its delivery or by a refund owed
      // the gate writes for it (onCharged); never dropped here. Each is read
      // again as it stands now. One that carries the delivered mark was
      // served: its closing write did not land, and is made again here; it is
      // never handed on as undelivered.
      for (const key of Object.keys(entries)) {
        const e = entries[key];
        if (!e || e.state !== "charged-undelivered") continue;
        // A send that may still be going out is left to its own end.
        if (e.delivered === true && Number(e.sendingUntil) > t) continue;
        if (e.delivered === true) { await this.resolve(key, null); continue; }
        out.charged++;
        try { await onCharged(e); } catch { /* the next pass asks again */ }
      }
      return out;
    },
  };
}

export const REFERRAL_BOOK_SWEEP_MS = 60_000;
const SWEEP_LEASE = "referral-settle-sweep";
let sweepTimer = null;
/** Run the sweep once now and then under its lease every minute, once per process. */
export function startReferralBookSweep({ sweepOnce, intervalMs = REFERRAL_BOOK_SWEEP_MS } = {}) {
  if (sweepTimer || typeof sweepOnce !== "function") return null;
  sweepTimer = "starting";
  return (async () => {
    const [{ leased }, { contained }] = await Promise.all([import("./state-db.js"), import("./contained-turn.js")]);
    const tick = leased(SWEEP_LEASE, { ttlMs: Math.max(intervalMs * 2, 120_000) }, () => sweepOnce());
    tick().catch(() => {});
    sweepTimer = setInterval(contained(SWEEP_LEASE, () => tick().catch(() => {})), intervalMs);
    sweepTimer.unref?.();
  })().catch((e) => { sweepTimer = null; console.warn(`[referral] settlement sweep did not start: ${String(e?.message || e).slice(0, 120)}`); });
}
