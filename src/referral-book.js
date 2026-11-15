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
/** Slugs the proven record holds at most (one small entry each). */
export const PROVEN_MAX = 500;
/** Booked-payment marks: kept this long, at most this many. */
export const SOLD_KEEP_MS = 3600_000;
export const SOLD_MAX = 2000;
/** Records of refused entries dropped at capacity that are kept at once, and how many the sweep reads a pass. */
export const DROPPED_MAX = 2000;
export const SWEEP_DROPPED_MAX = 25;
/** A dropped record is given up only when BOTH hold: this many reads after its expiry reached no verdict, and this long has passed since that expiry. */
export const DROPPED_GIVE_UP_READS = 5;
export const DROPPED_GIVE_UP_MS = 6 * 3600_000;
/** The wall time one sweep pass gives ALL its chain reads (open entries, then refused ones, then dropped records). */
export const SWEEP_CHAIN_BUDGET_MS = 40_000;

/** Charged, undelivered entries the sweep hands on in one pass (the rest wait for the next). */
export const SWEEP_CHARGED_MAX = 50;
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

export function createReferralBook({ doc = null, file = defaultFile(), now = Date.now, log = console, maxEntries = MAX_ENTRIES, maxPerPayer = PER_PAYER_MAX, maxDropped = DROPPED_MAX } = {}) {
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
  // Slugs with a receipt-proven sale at or above their floor, each with the
  // fingerprint of the settings it was judged against (the gate's record).
  let proven = {};
  // The payments whose sale this gate has booked, by authorization key (the
  // per-payment mark that outlives the entry and the process): { key: { tx, payer, slug, at } }.
  let sold = {};
  // Refused entries dropped at capacity, by key (`dropped`): the few fields a
  // chain read needs ({ key, slug, payer, nonce, amount, validBefore,
  // fromBlock, at }), kept until the authorization can no longer be sent, so
  // a payment the facilitator lands after all is still found by the sweep.
  // At most `maxDropped`; one evicted before its expiry is counted and logged.
  let dropped = {};
  let droppedEarly = 0;
  let droppedUnresolved = 0;
  const lcPayer = (p) => String(p).toLowerCase();
  // (A "refused" entry, kept only so a payment that lands after the
  // facilitator refused it is found, is not the payer's open settlement: it
  // does not count toward the payer's share.)
  const heldBy = (cur, payer) => { const who = lcPayer(payer); let n = 0; for (const k in cur) if (cur[k] && cur[k].payer === who && cur[k].state !== "refused") n++; return n; };
  /** At capacity the oldest "refused" entry goes first (the intent that
   *  drops it leaves a small record, `dropped`). Null when there is none. */
  // A notice for the operator and the status word that dropped records went
  // without a verdict (`kind` "unresolved": given up; "evicted": pushed out
  // at the cap): one record in the hand-resolved list, and at most one of a
  // kind every ten minutes, so a flood of them never crowds that list out.
  const noteDropped = (done, kind, n, t) => {
    const key = `dropped:${kind}`;
    const last = [...done].reverse().find((r) => r && r.key === key);
    if (last && t - (Number(last.at) || 0) < 600_000) return;
    done.push({ key, slug: null, payer: null, amount: null, tx: null, state: "dropped-record", delivered: false, outcome: kind, debt: false, note: `${n} record(s) of refused settles dropped at capacity ${kind === "evicted" ? "were pushed out before a verdict" : "were given up with no verdict"}`, at: t });
  };
  const droppable = (cur) => {
    let pick = null;
    for (const k in cur) { const e = cur[k]; if (e && e.state === "refused" && (!pick || (e.at || 0) < (pick.at || 0))) pick = e; }
    return pick;
  };
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
    proven = b && typeof b === "object" && b.proven && typeof b.proven === "object" && !Array.isArray(b.proven) ? { ...b.proven } : {};
    sold = b && typeof b === "object" && b.sold && typeof b.sold === "object" && !Array.isArray(b.sold) ? { ...b.sold } : {};
    dropped = b && typeof b === "object" && b.dropped && typeof b.dropped === "object" && !Array.isArray(b.dropped) ? { ...b.dropped } : {};
  };
  try { absorb(store.loadSync(null)); } catch { /* read below */ }
  const ready = Promise.resolve().then(() => store.load(null)).then((b) => { if (b) absorb(b); }).catch(() => {});
  const say = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };

  // ONE WRITER AT A TIME per process, and changes asked for together are
  // written together. Every change of this book is a read-modify-write of one
  // document under compare-and-swap; two of this process's own writers must
  // never race each other there (each loser read and wrote the whole document
  // again, and past the retries a paid call was refused). So changes queue:
  // the ones waiting when a write starts are applied, in order, to ONE read
  // of the document and stored by ONE write, and compare-and-swap is left to
  // arbitrate between processes only. Each caller still learns whether the
  // store took the write its change was in. A change given a `deadlineMs`
  // answers false at that deadline: one not yet started is dropped and never
  // applied; one already in a write may still land (only a change that is
  // safe to land unanswered is given a deadline: the intent, which the sweep
  // closes when no settle follows it).
  let queue = [];
  let flushing = null;
  let lastIntentFault = null;
  const writes = { updates: 0, changes: 0, failed: 0, timedOut: 0, bytes: 0, lastOk: true, lastAt: 0 };
  let inFlight = null;
  const FALLBACK = { entries: {}, forgiven: [], resolved: [], retired: [], closed: [], short: {}, proven: {}, sold: {}, dropped: {} };
  const applyBatch = (batch) => (body) => {
    const cur = body && typeof body === "object" && body.entries && typeof body.entries === "object" ? { ...body.entries } : {};
    let kept = body && typeof body === "object" && Array.isArray(body.forgiven) ? body.forgiven : [];
    const done = body && typeof body === "object" && Array.isArray(body.resolved) ? body.resolved.slice() : [];
    const gone = body && typeof body === "object" && Array.isArray(body.retired) ? body.retired.slice() : [];
    const shut = body && typeof body === "object" && Array.isArray(body.closed) ? body.closed.slice() : [];
    const under = body && typeof body === "object" && body.short && typeof body.short === "object" && !Array.isArray(body.short) ? { ...body.short } : {};
    const warm = body && typeof body === "object" && body.proven && typeof body.proven === "object" && !Array.isArray(body.proven) ? { ...body.proven } : {};
    const marks = body && typeof body === "object" && body.sold && typeof body.sold === "object" && !Array.isArray(body.sold) ? { ...body.sold } : {};
    const graves = body && typeof body === "object" && body.dropped && typeof body.dropped === "object" && !Array.isArray(body.dropped) ? { ...body.dropped } : {};
    let any = false;
    for (const item of batch) {
      if (item.dropped) continue;
      item.started = true;
      let out;
      try { out = item.fn(cur, kept, done, gone, shut, under, warm, marks, graves); } catch (e) { item.threw = true; throw e; }
      if (out === SKIP_UPDATE) continue;
      any = true;
      if (Array.isArray(out)) kept = out;
    }
    return any ? { entries: cur, forgiven: kept, resolved: done.slice(-RESOLVED_MAX), retired: gone.slice(-RETIRED_MAX), closed: shut.slice(-CLOSED_MAX), short: under, proven: warm, sold: marks, dropped: graves } : SKIP_UPDATE;
  };
  async function flush() {
    try {
      while (queue.length) {
        const batch = queue;
        queue = [];
        // The write now in flight: a deadline missed by a change in it, or by
        // one waiting behind it, is counted once for this write.
        const write = { missed: false };
        inFlight = write;
        for (const item of batch) item.write = write;
        let r;
        try { r = await store.update(applyBatch(batch), { fallback: FALLBACK }); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
        // A change that threw fails only itself: the rest of its batch goes back in the queue, in order.
        if (!r.ok && batch.length > 1 && batch.some((b) => b.threw)) {
          for (const item of batch.filter((b) => b.threw)) { if (item.timer) clearTimeout(item.timer); item.resolve(false); }
          queue = [...batch.filter((b) => !b.threw), ...queue];
          continue;
        }
        writes.updates++;
        writes.changes += batch.length;
        writes.lastOk = !!r.ok;
        writes.lastAt = now();
        if (!r.ok) writes.failed++;
        if (r.ok && r.changed !== false) { try { writes.bytes += JSON.stringify(r.body ?? null).length; } catch { /* a count only */ } }
        if (r.ok && r.body) absorb(r.body);
        for (const item of batch) { if (item.timer) clearTimeout(item.timer); item.resolve(!!r.ok && !item.dropped); }
      }
    } finally { inFlight = null; flushing = null; if (queue.length) flushing = Promise.resolve().then(flush); }
  }
  // A change's deadline passed: one not yet started is dropped; the miss is
  // counted once per write (the write it is in, else the one it waits behind).
  function missedDeadline(item) {
    if (!item.started) item.dropped = true;
    const w = item.write || inFlight;
    if (w) { if (w.missed) return; w.missed = true; }
    writes.timedOut++;
  }
  function change(fn, { deadlineMs = 0 } = {}) {
    return new Promise((resolve) => {
      const item = { fn, resolve, dropped: false, started: false, timer: null };
      if (deadlineMs > 0) {
        item.timer = setTimeout(() => { missedDeadline(item); resolve(false); }, deadlineMs);
        item.timer.unref?.();
      }
      queue.push(item);
      if (!flushing) flushing = Promise.resolve().then(flush);
    });
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
    async intent({ key, slug, payer, nonce, amount, validBefore, fromBlock = null, deadlineMs = 0 }) {
      const t = now();
      let full = false, payerFull = false, dropped = null;
      let early = 0, expiredOut = 0;
      const ok = await change((cur, _kept, doneList, gone, _shut, _under, _warm, _marks, graves) => {
        const prev = cur[key];
        dropped = null;
        early = 0;
        expiredOut = 0;
        let spared = null;
        if (!prev && heldBy(cur, payer) >= maxPerPayer) { payerFull = true; return SKIP_UPDATE; }
        if (!prev && Object.keys(cur).length >= maxEntries) {
          const spare = droppable(cur);
          if (spare) {
            spared = { key: spare.key, entry: spare };
            // Dropped to make room, and remembered: what a chain read of it needs.
            graves[spare.key] = { key: spare.key, slug: spare.slug, payer: spare.payer, nonce: spare.nonce, amount: spare.amount, validBefore: spare.validBefore, fromBlock: spare.fromBlock ?? null, at: t };
            delete cur[spare.key];
            const ks = Object.keys(graves);
            if (ks.length > maxDropped) for (const k of ks.sort((a, b) => (graves[a].at || 0) - (graves[b].at || 0)).slice(0, ks.length - maxDropped)) { if (t <= (Number(graves[k].validBefore) || 0) * 1000 + EXPIRY_SLACK_MS) early++; else expiredOut++; delete graves[k]; }
          }
        }
        if (!prev && Object.keys(cur).length >= maxEntries) {
          const stuck = retirable(cur, t);
          // (Refused as full: nothing of this intent stands, the dropped record of its key included.)
          if (!stuck) { full = true; if (spared) { cur[spared.key] = spared.entry; delete graves[spared.key]; } return SKIP_UPDATE; }
          gone.push({ key: stuck.key, slug: stuck.slug, payer: stuck.payer, amount: stuck.amount, tx: stuck.tx || null, state: stuck.state, checks: stuck.checks || 0, openedAt: stuck.at || null, at: t });
          delete cur[stuck.key];
          dropped = stuck;
        }
        // (An entry written again for a payment is no longer a dropped one.)
        if (graves[key]) delete graves[key];
        if (early || expiredOut) noteDropped(doneList, "evicted", early + expiredOut, t);
        cur[key] = { ...(prev || {}), key, slug: String(slug), payer: String(payer).toLowerCase(), nonce: String(nonce).toLowerCase(), amount: String(amount), validBefore: Number(validBefore) || 0, at: prev?.at || t, state: "intent", intentAt: t, attempts: (prev?.attempts || 0) + 1, tx: prev?.tx || null, saleBooked: prev?.saleBooked === true, fromBlock: prev?.fromBlock ?? (Number.isSafeInteger(fromBlock) && fromBlock > 0 ? fromBlock : null) };
        return undefined;
      }, { deadlineMs });
      if (ok && dropped) say("error", `the settlement book was at capacity (${maxEntries}): the oldest in-doubt entry whose authorization has expired was retired to the operator record (${dropped.slug} payer=${String(dropped.payer).slice(0, 6)} tx=${dropped.tx || "none read"})`);
      if (payerFull) say("error", `one payer holds its whole share of the settlement book (${maxPerPayer} open entries, payer=${String(payer).slice(0, 6)}); its new settlement is refused before /settle until its entries resolve`);
      if (full) say("error", `the settlement book is full (${maxEntries} open entries, none may be retired); a new settlement is refused before /settle until entries resolve`);
      // (An expired record evicted before any read reached a verdict is counted with the unresolved ones.)
      if (ok && expiredOut) droppedUnresolved += expiredOut;
      if (ok && early) { droppedEarly += early; say("error", `${early} record(s) of refused settles dropped at capacity were themselves dropped before their authorization expired (more than ${maxDropped} at once): a payment that lands late for one of them would not be found`); }
      lastIntentFault = ok ? (full ? "full" : payerFull ? "payer" : null) : "store";
      return ok && !full && !payerFull;
    },
    /** Why the last intent was not stored: "store" (the store did not take
     *  the write), "full", "payer" (that payer's share is spent), or null. */
    intentFault: () => lastIntentFault,
    /** Change an entry (`patch` merged), or remove it (`patch` null).
     *  Resolves true only when the store answered AND the change stands: a
     *  patch on an entry that is not there is false; a removal of one that is
     *  already gone is true. A caller that must know (the delivered mark, a
     *  closing write) reads the result. */
    async resolve(key, patch, { unless = null } = {}) {
      let ran = false, found = false;
      const ok = await change((cur) => {
        ran = true;
        found = false;
        if (!cur[key]) return SKIP_UPDATE;
        // `unless(entry)`: the change is not made (and answers false) when the
        // entry AS THE STORE HAS IT NOW says so: the one place two processes'
        // decisions about one entry (deliver it, or owe it back) are settled.
        if (typeof unless === "function" && unless(cur[key]) === true) return SKIP_UPDATE;
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
    /** The refused entries dropped at capacity that are still remembered,
     *  and how many such records were themselves dropped early since boot. */
    droppedRefused: () => ({ count: Object.keys(dropped).length, evictedEarly: droppedEarly, unresolved: droppedUnresolved, records: Object.values(dropped) }),
    /** One sale whose receipt paid this merchant less than the rate map
     *  expects (or, with `product`, one payment whose receipt names another
     *  product id than the slug's: `{ configured, received }`), counted once
     *  per transaction under its slug:
     *  `{ count, deep, expected, received, gross, tx, firstAt, at }` (`deep`
     *  counts the ones the gate calls far under). Kept until the map admits
     *  the amount or an operator clears it (clearShort). */
    async noteShort(slug, { expected, received, gross, tx, deep = false, product = null } = {}) {
      const t = now();
      return change((_cur, _kept, _done, _gone, _shut, under) => {
        const prev = under[slug] && typeof under[slug] === "object" ? under[slug] : null;
        const txs = Array.isArray(prev?.txs) ? prev.txs : [];
        if (txs.includes(tx)) return SKIP_UPDATE;
        // A product note carries no amounts: it keeps the slug's short-net figures as they stand.
        const amounts = product ? { count: prev?.count || 0, deep: prev?.deep || 0, expected: String(prev?.expected ?? "0"), received: String(prev?.received ?? "0"), gross: String(prev?.gross ?? gross) } : { count: (prev?.count || 0) + 1, deep: (prev?.deep || 0) + (deep ? 1 : 0), expected: String(expected), received: String(received), gross: String(gross) };
        under[slug] = { ...amounts, tx: String(tx), txs: [...txs, String(tx)].slice(-50), firstAt: prev?.firstAt || t, at: t, ...(product || prev?.product ? { product: product || prev.product } : {}) };
        return undefined;
      });
    },
    /** An operator has read a kind of operator record ("retired", "closed"):
     *  recorded with the note; the status word stops naming the records that
     *  were there at that time (ackAt). */
    async noteAck(kind, note) {
      return change((_cur, _kept, done) => { done.push({ key: `ack:${kind}`, slug: null, payer: null, amount: null, tx: null, state: "ack", delivered: true, outcome: "acknowledged", debt: false, note: String(note).slice(0, 300), at: now() }); return undefined; });
    },
    /** When that kind was last acknowledged (0 when never, or when the note has left the record). */
    ackAt: (kind) => resolved.reduce((m, r) => (r && r.key === `ack:${kind}` && Number(r.at) > m ? Number(r.at) : m), 0),
    /** Record a hand note that has no entry of its own (a stop cleared
     *  where the book held no record of it). */
    async resolveNote({ slug, outcome, note }) {
      return change((_cur, _kept, done) => { done.push({ key: `short:${slug}`, slug, payer: null, amount: null, tx: null, state: "short-net", delivered: true, outcome: String(outcome).slice(0, 40), debt: false, note: String(note).slice(0, 300), at: now() }); return undefined; });
    },
    /** A slug has a receipt-proven sale at or above its floor, judged
     *  against the settings `fingerprint` stands for. One small record per
     *  slug (at most PROVEN_MAX of them), so a restart does not make every
     *  slug cold again. A build that does not know this field reads the
     *  document without it and writes it back without it: the slugs are then
     *  cold once, nothing else changes. */
    async noteProven(slug, fingerprint) {
      if (proven[slug]?.fp === fingerprint) return true;
      return change((_cur, _kept, _done, _gone, _shut, _under, warm) => {
        if (warm[slug]?.fp === fingerprint) return SKIP_UPDATE;
        if (!warm[slug] && Object.keys(warm).length >= PROVEN_MAX) return SKIP_UPDATE;
        warm[slug] = { fp: String(fingerprint), at: now() };
        return undefined;
      });
    },
    /** This payment's sale is booked: the mark that outlives its entry and
     *  this process, so a second payment settled in the same transaction is
     *  told apart from it after a restart. Kept SOLD_KEEP_MS (a transaction
     *  that settles two payments does so within minutes), at most SOLD_MAX. */
    async noteSold(key, { tx, payer, slug } = {}) {
      const t = now();
      return change((_cur, _kept, _done, _gone, _shut, _under, _warm, marks) => {
        for (const k of Object.keys(marks)) if (t - (Number(marks[k]?.at) || 0) > SOLD_KEEP_MS) delete marks[k];
        const keys = Object.keys(marks);
        if (keys.length >= SOLD_MAX) for (const k of keys.sort((a, b) => (marks[a].at || 0) - (marks[b].at || 0)).slice(0, keys.length - SOLD_MAX + 1)) delete marks[k];
        marks[key] = { tx: String(tx), payer: String(payer).toLowerCase(), slug: String(slug), at: t };
        return undefined;
      });
    },
    /** The booked-payment marks: `{ key: { tx, payer, slug, at } }`. */
    soldMarks: () => ({ ...sold }),
    /** The proven record, by slug: `{ slug: { fp, at } }`. */
    provenSlugs: () => ({ ...proven }),
    /** A slug is cold again (its own stop, or an operator's clear). */
    async clearProven(slug) {
      if (!proven[slug]) return true;
      return change((_cur, _kept, _done, _gone, _shut, _under, warm) => { if (!warm[slug]) return SKIP_UPDATE; delete warm[slug]; return undefined; });
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
        // A settle success whose receipt was READ IN FULL and does not prove
        // the sale (`unproven`): this server's settings or the contract's
        // shape, never the payer's doing, so it holds no payer of its own
        // (`own: false`); with money moved it counts toward the many-payer hold.
        else if (e.state === "in-doubt" && e.unproven === true) out.push({ key: k, payer: e.payer, state: e.state, scope: "payer", own: false, unproven: true, moved: e.moved === true, at: Number(e.unprovenAt) || 0 });
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
    /** The store's write counters since boot (operator read, tests): updates
     *  sent, changes they carried, failed updates, bytes written, and whether
     *  the last one stood. */
    writeStats: () => ({ ...writes }),
    /** True when the last write the store was sent stood (true before any). */
    lastWriteOk: () => writes.lastOk,
    /** One small write, to learn whether the store takes writes now. */
    async ping({ deadlineMs = 0 } = {}) { return change(() => undefined, { deadlineMs }); },
    /** The entries, newest first (the operator view). An entry holds no answer and no payment. */
    list: () => Object.values(entries).sort((a, b) => (b.at || 0) - (a.at || 0)).map(({ answer, payment, ...e }) => ({ ...e })),
    size: () => Object.keys(entries).length,
    /** At capacity with no entry that may be retired: nobody's new settlement can be recorded. */
    // (A refused entry is room: the next intent drops the oldest one first.)
    full: () => Object.keys(entries).length >= maxEntries && !droppable(entries) && !retirable(entries, now()),
    /** True when a new settlement for this payer can be recorded: its own
     *  share is not spent, and the book has (or can make) room. */
    roomFor(payer) {
      if (heldBy(entries, payer) >= maxPerPayer) return false;
      return Object.keys(entries).length < maxEntries || !!droppable(entries) || !!retirable(entries, now());
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
    async sweep({ chain, bookSale, payTo, minNetOf = () => null, productIdOf = () => null, onUnpaid = () => {}, onCharged = async () => {}, onUnrecognized = () => {}, onHeld = () => {}, onSendUnconfirmed = null, unrecognizedMax = UNRECOGNIZED_READS_MAX, graceMs = 120_000, max = 50, maxCharged = SWEEP_CHARGED_MAX, chainBudgetMs = SWEEP_CHAIN_BUDGET_MS } = {}) {
      const t = now();
      // "Read and nothing changed" marks (the check count and time of each
      // entry read this pass) are written ONCE, at the end of the pass, not
      // once per entry: a pass over 50 open entries is then one write of the
      // document for them, not 50.
      const marks = [];
      const mark = (key, patch) => { marks.push({ key, patch }); if (entries[key]) entries[key] = { ...entries[key], ...patch }; };
      const out = { read: 0, landed: 0, unpaid: 0, expired: 0, unknown: 0, charged: 0, unrecognized: 0 };
      try { const b = await store.load(null); if (b) absorb(b); } catch { /* the last body read */ }
      // ONE WALL BUDGET for every chain read of the pass (`chainBudgetMs`): no
      // read starts once it is spent, so a chain that does not answer holds
      // the pass for one read's own timeout past it, never for every entry's.
      // What is read first: entries charged already are handed on before any
      // read (below, and again at the end for the ones this pass finds); then
      // in-doubt and intent entries; then refused ones; then dropped records.
      const started = Date.now();
      const budgetSpent = () => Date.now() - started >= chainBudgetMs;
      const handed = new Set();
      const self = this;
      // A charged entry is closed only by its delivery or by a refund owed
      // the gate writes for it (onCharged); never dropped here. Each is read
      // again as it stands now. One that carries the delivered mark was
      // served: its closing write did not land, and is made again here; it is
      // never handed on as undelivered.
      // At most `maxCharged` a pass, the ones charged longest ago first.
      async function handCharged() {
      const chargedKeys = Object.keys(entries).filter((k) => entries[k] && entries[k].state === "charged-undelivered").sort((a, b) => (entries[a].landedAt || entries[a].at || 0) - (entries[b].landedAt || entries[b].at || 0));
      for (const key of chargedKeys) {
        const e = entries[key];
        if (!e || e.state !== "charged-undelivered" || handed.has(key)) continue;
        handed.add(key);
        // A send that may still be going out is left to its own end.
        if (e.delivered === true && Number(e.sendingUntil) > t) continue;
        // The delivered mark with its send bound past and the entry still here:
        // the send was never confirmed to this book (the process that made it
        // ended, or its closing write did not land). The caller says which
        // (onSendUnconfirmed: true = it handled the entry); with no caller the
        // entry is closed as served, as before.
        if (e.delivered === true) {
          let handled = false;
          if (typeof onSendUnconfirmed === "function") { try { handled = (await onSendUnconfirmed(e)) === true; } catch { handled = true; } }
          if (!handled) await self.resolve(key, null);
          continue;
        }
        // A request (in this process or another one on the same book) settled
        // it moments ago and is about to send its answer: left to that request.
        if (Number(e.inCallUntil) > t) continue;
        if (out.charged >= Math.max(1, maxCharged)) { out.chargedLeft = (out.chargedLeft || 0) + 1; continue; }
        out.charged++;
        try { await onCharged(e); } catch { /* the next pass asks again */ }
      }
      }
      await handCharged();
      const leastRecent = (a, b) => (a.checkedAt || 0) - (b.checkedAt || 0) || (a.at || 0) - (b.at || 0);
      const open = Object.values(entries);
      const due = [
        ...open.filter((e) => e.state === "in-doubt" || (e.state === "intent" && t - (e.intentAt || e.at || 0) >= graceMs)).sort(leastRecent),
        ...open.filter((e) => e.state === "refused").sort(leastRecent),
      ].slice(0, max);
      for (const snapshot of due) {
        if (budgetSpent()) { out.unread = (out.unread || 0) + 1; continue; }
        // The entry as it stands NOW: an earlier step of this pass, or a
        // request, may have changed or closed it since the list was made.
        const e = entries[snapshot.key];
        if (!e || (e.state !== "in-doubt" && e.state !== "intent" && e.state !== "refused")) continue;
        out.read++;
        let s;
        try { s = await chain.state({ from: e.payer, nonce: e.nonce, payTo, amount: e.amount, fromBlock: e.fromBlock, minNet: minNetOf(e), productId: productIdOf(e) }); } catch { s = { used: null, paid: null, transaction: null, complete: false }; }
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
          // And a receipt that shows the BUYER'S OWN TRANSFER into the split
          // contract (`moved`): that buyer paid, so the entry is never closed
          // by itself; it stays for the operator and for the refund the gate
          // writes for it (onHeld).
          const keep = read && (s.routedToUs === true || e.noAutoClose === true || s.moved === true || (e.unproven === true && e.moved === true));
          if (keep) {
            if (e.routedToUs !== true && s.routedToUs === true) say("error", `a spent authorization's transaction was routed to THIS merchant by the split contract, and the receipt is not one the proof rule accepts (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${String(s.transaction).toLowerCase()}: ${String(s.why || "").slice(0, 120)}); kept open for an operator, never closed by itself`);
            mark(e.key, { state: e.state === "intent" || e.state === "refused" ? "in-doubt" : e.state, checks: (e.checks || 0) + 1, checkedAt: t, seenTx: String(s.transaction).toLowerCase(), ...(s.routedToUs === true ? { routedToUs: true } : {}), why: String(s.why || "").slice(0, 160) });
            try { onHeld(e, s); } catch { /* the caller's note only */ }
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
              if (!now_ || (now_.state !== "in-doubt" && now_.state !== "intent" && now_.state !== "refused")) return SKIP_UPDATE;
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
          // (A refused entry whose authorization can no longer be sent and
          // that the chain still cannot settle either way is in doubt from here.)
          mark(e.key, { state: e.state === "intent" || (e.state === "refused" && unsendable) ? "in-doubt" : e.state, checks: (e.checks || 0) + 1, checkedAt: t, ...(full ? { unrecognizedReads: reads, seenTx: String(s.transaction).toLowerCase() } : {}) });
        }
      }
      if (marks.length) {
        await change((cur) => {
          let any = false;
          for (const { key, patch } of marks) {
            const c = cur[key];
            // Only an entry still open as it was read: a request may have changed or closed it meanwhile.
            if (!c || (c.state !== "in-doubt" && c.state !== "intent" && c.state !== "refused")) continue;
            cur[key] = { ...c, ...patch, updatedAt: t };
            any = true;
          }
          return any ? undefined : SKIP_UPDATE;
        });
      }
      // The refused entries dropped at capacity: each is read like an open
      // one until its authorization can no longer be sent. A payment that
      // landed after all is written back as an entry, charged and
      // undelivered (the loop below hands it on); the rest are forgotten on a verdict.
      {
        // Read order: earliest expiry first (among records already expired,
        // the least recently read first). At most SWEEP_DROPPED_MAX a pass,
        // and no read starts after `droppedBudgetMs` of the pass: a chain
        // that does not answer never holds up the rest of it. A record is
        // forgotten on a verdict (spent without paying us, expired unused, or
        // spent with nothing found by a complete search after expiry); a read
        // that reaches none keeps it, and it is given up only when BOTH
        // DROPPED_GIVE_UP_READS reads after its expiry reached no verdict and
        // DROPPED_GIVE_UP_MS has passed since that expiry: then a line names
        // it, it is counted, and a notice for the status word is recorded.
        const expiredAt = (g) => (Number(g.validBefore) || 0) * 1000 + EXPIRY_SLACK_MS;
        const all = Object.values(dropped).sort((a, b) => {
          const ea = t > expiredAt(a), eb = t > expiredAt(b);
          if (ea !== eb) return ea ? -1 : 1;
          return ea ? (a.checkedAt || 0) - (b.checkedAt || 0) || (Number(a.validBefore) || 0) - (Number(b.validBefore) || 0) : (Number(a.validBefore) || 0) - (Number(b.validBefore) || 0) || (a.checkedAt || 0) - (b.checkedAt || 0);
        });
        const graveNow = all.slice(0, SWEEP_DROPPED_MAX);
        const forget = [], seen = [], back = [], late = [], giveUp = [];
        let readNow = 0;
        for (const g of graveNow) {
          if (budgetSpent()) break;
          readNow++;
          let st;
          try { st = await chain.state({ from: g.payer, nonce: g.nonce, payTo, amount: g.amount, fromBlock: g.fromBlock, minNet: minNetOf(g), productId: productIdOf(g) }); } catch { st = { used: null, paid: null, transaction: null, complete: false }; }
          const verdict = chainVerdict(st, { validBeforeMs: (Number(g.validBefore) || 0) * 1000, nowMs: t, slackMs: EXPIRY_SLACK_MS });
          if (verdict === "paid") {
            let booked = false;
            try { booked = (await bookSale(g, st.transaction, st.net ?? null)) === true; } catch { booked = false; }
            back.push({ g, tx: st.transaction, booked });
            out.landed++;
            say("error", `CHARGED-BUT-NOT-SERVED: a refused settle whose entry was dropped at capacity landed on chain (${g.slug} payer=${String(g.payer).slice(0, 6)} tx=${st.transaction})${booked ? ", sale booked" : ", sale NOT booked"}`);
          } else if (verdict === "unpaid" || verdict === "expired-unused") forget.push(g.key);
          else if (t > expiredAt(g)) { if ((Number(g.lateReads) || 0) + 1 >= DROPPED_GIVE_UP_READS && t > (Number(g.validBefore) || 0) * 1000 + DROPPED_GIVE_UP_MS) giveUp.push(g); else late.push(g.key); }
          else seen.push(g.key);
        }
        out.droppedUnread = Math.max(0, all.length - readNow);
        if (forget.length || seen.length || back.length || late.length || giveUp.length) {
          let gaveUp = [];
          const wrote = await change((cur, _kept, done, _gone, _shut, _under, _warm, _marks, graves) => {
            gaveUp = [];
            for (const k of forget) delete graves[k];
            for (const g of giveUp) if (graves[g.key]) { delete graves[g.key]; gaveUp.push(g); }
            if (gaveUp.length) noteDropped(done, "unresolved", gaveUp.length, t);
            for (const k of seen) if (graves[k]) graves[k] = { ...graves[k], checkedAt: t };
            for (const k of late) if (graves[k]) graves[k] = { ...graves[k], checkedAt: t, lateReads: (Number(graves[k].lateReads) || 0) + 1 };
            for (const { g, tx, booked } of back) {
              if (!graves[g.key]) continue;
              delete graves[g.key];
              if (!cur[g.key]) cur[g.key] = { key: g.key, slug: g.slug, payer: g.payer, nonce: g.nonce, amount: g.amount, validBefore: g.validBefore, fromBlock: g.fromBlock ?? null, at: g.at || t, state: "charged-undelivered", tx, saleBooked: booked, landedAt: t, updatedAt: t };
            }
            return undefined;
          });
          // Counted and logged once, when the write that removed the record stood.
          if (wrote) for (const g of gaveUp) {
            droppedUnresolved++;
            say("error", `a refused settle dropped at capacity could not be read to a verdict in ${DROPPED_GIVE_UP_READS} or more reads over ${Math.round(DROPPED_GIVE_UP_MS / 3600_000)} hours after its authorization's expiry (no answer, or a search that was not complete): its record is given up (${g.slug} payer=${String(g.payer).slice(0, 6)} nonce=${String(g.nonce).slice(0, 10)} amount=${g.amount}); if a payment landed for it, it was not found`);
          }
        }
      }
      // A booked-payment mark is kept SOLD_KEEP_MS: removed here once older,
      // so it does not wait for the next sale to be pruned.
      if (Object.values(sold).some((m) => t - (Number(m?.at) || 0) > SOLD_KEEP_MS)) {
        await change((_cur, _kept, _done, _gone, _shut, _under, _warm, marksNow) => {
          let any = false;
          for (const k of Object.keys(marksNow)) if (t - (Number(marksNow[k]?.at) || 0) > SOLD_KEEP_MS) { delete marksNow[k]; any = true; }
          return any ? undefined : SKIP_UPDATE;
        });
      }
      // A refund-owed mark is kept until its authorization can no longer be sent again.
      for (const key of Object.keys(entries)) {
        const e = entries[key];
        if (e && e.state === "refund-owed" && t > (Number(e.validBefore) || 0) * 1000 + EXPIRY_SLACK_MS) await this.resolve(key, null);
      }
      // The entries this pass found charged (the ones charged before it were handed on first).
      await handCharged();
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
