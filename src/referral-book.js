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
// Bounded: at most MAX_ENTRIES open entries. A full book refuses a new intent
// (the gate answers 503 before /settle); it never drops an entry.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { chainVerdict } from "./referral-chain.js";

export const REFERRAL_BOOK_DOC = "referral-settlements";
export const MAX_ENTRIES = 2000;
const RESOLVED_MAX = 200;
/** An authorization is read as expired this long after its validBefore (host clock slack). */
export const EXPIRY_SLACK_MS = 120_000;

// With a state database the document is a row. Without one it is a file:
// REFERRAL_BOOK_FILE, else under /data when that volume exists, else under the
// system temp directory (as the other file stores do), so the book survives a
// restart in every mode.
export const referralBookFile = () => (process.env.REFERRAL_BOOK_FILE || join(existsSync("/data") ? "/data" : tmpdir(), "agent402-referral-settlements.json"));
const defaultFile = referralBookFile;

export function createReferralBook({ doc = null, file = defaultFile(), now = Date.now, log = console, maxEntries = MAX_ENTRIES } = {}) {
  const store = doc || createJsonDocument({ name: REFERRAL_BOOK_DOC, file, log: () => {} });
  let entries = {};
  // The gate's own hang-up forgiveness records ([time, micro-dollars, key
  // digests]), kept here so a restart does not refill that budget.
  let forgiven = [];
  // Entries an operator resolved by hand, with the note given (the last RESOLVED_MAX).
  let resolved = [];
  const absorb = (b) => {
    entries = b && typeof b === "object" && b.entries && typeof b.entries === "object" ? { ...b.entries } : {};
    forgiven = b && typeof b === "object" && Array.isArray(b.forgiven) ? b.forgiven.filter((r) => Array.isArray(r) && r.length === 3) : [];
    resolved = b && typeof b === "object" && Array.isArray(b.resolved) ? b.resolved.filter((r) => r && typeof r === "object") : [];
  };
  try { absorb(store.loadSync(null)); } catch { /* read below */ }
  const ready = Promise.resolve().then(() => store.load(null)).then((b) => { if (b) absorb(b); }).catch(() => {});
  const say = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };

  async function change(fn) {
    const r = await store.update((body) => {
      const cur = body && typeof body === "object" && body.entries && typeof body.entries === "object" ? { ...body.entries } : {};
      const kept = body && typeof body === "object" && Array.isArray(body.forgiven) ? body.forgiven : [];
      const done = body && typeof body === "object" && Array.isArray(body.resolved) ? body.resolved.slice() : [];
      const out = fn(cur, kept, done);
      return out === SKIP_UPDATE ? SKIP_UPDATE : { entries: cur, forgiven: Array.isArray(out) ? out : kept, resolved: done.slice(-RESOLVED_MAX) };
    }, { fallback: { entries: {}, forgiven: [], resolved: [] } });
    if (r.ok && r.body) absorb(r.body);
    return !!r.ok;
  }
  return {
    ready,
    /**
     * Write the intent to settle. Resolves true once it is stored, false
     * when it is not (a store fault, or a FULL book: no entry is ever
     * dropped to make room, so a full book refuses a new intent and the
     * gate does not call /settle). `fromBlock` is the chain head when the
     * intent was written: the proof of payment is looked for from there.
     */
    async intent({ key, slug, payer, nonce, amount, validBefore, fromBlock = null }) {
      const t = now();
      let full = false;
      const ok = await change((cur) => {
        const prev = cur[key];
        if (!prev && Object.keys(cur).length >= maxEntries) { full = true; return SKIP_UPDATE; }
        cur[key] = { ...(prev || {}), key, slug: String(slug), payer: String(payer).toLowerCase(), nonce: String(nonce).toLowerCase(), amount: String(amount), validBefore: Number(validBefore) || 0, at: prev?.at || t, state: "intent", intentAt: t, attempts: (prev?.attempts || 0) + 1, tx: prev?.tx || null, saleBooked: prev?.saleBooked === true, fromBlock: prev?.fromBlock ?? (Number.isSafeInteger(fromBlock) && fromBlock > 0 ? fromBlock : null) };
        return undefined;
      });
      if (full) say("error", `the settlement book is full (${maxEntries} open entries); a new settlement is refused before /settle until entries resolve`);
      return ok && !full;
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
    /** An operator closes an entry by hand: removed, and recorded with the
     *  note (who, why) before it goes. `{ ok, entry }`. */
    async resolveByHand(key, { note = "", outcome = "dismissed" } = {}) {
      let entry = null;
      const ok = await change((cur, _kept, done) => {
        if (!cur[key]) return SKIP_UPDATE;
        entry = cur[key];
        done.push({ key, slug: entry.slug, payer: entry.payer, amount: entry.amount, tx: entry.tx || null, state: entry.state, delivered: entry.delivered === true, outcome: String(outcome).slice(0, 40), note: String(note).slice(0, 300), at: now() });
        delete cur[key];
        return undefined;
      });
      if (ok && entry) say("error", `an operator resolved a settlement by hand (${entry.slug} payer=${String(entry.payer).slice(0, 6)} state=${entry.state} outcome=${String(outcome).slice(0, 40)})`);
      return { ok: ok && !!entry, entry };
    },
    resolvedByHand: () => resolved.slice(),
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
    full: () => Object.keys(entries).length >= maxEntries,
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
    async sweep({ chain, bookSale, payTo, minNetOf = () => null, onUnpaid = () => {}, onCharged = async () => {}, graceMs = 120_000, max = 50 } = {}) {
      const t = now();
      const out = { read: 0, landed: 0, unpaid: 0, expired: 0, unknown: 0, charged: 0 };
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
          if (!booked) { try { booked = (await bookSale(e, s.transaction)) === true; } catch { booked = false; } }
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
          await this.resolve(e.key, { state: e.state === "intent" ? "in-doubt" : e.state, checks: (e.checks || 0) + 1, checkedAt: t });
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
