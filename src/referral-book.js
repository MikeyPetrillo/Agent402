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
// refused. What stays is exactly what still needs an answer. While an entry is
// open it also carries the tool's answer and the payment (bounded in size and
// count), so a restart can still deliver to a buyer who was charged; they go
// with the entry. A sweep (at boot
// and on a leased timer, startReferralBookSweep) reads every open entry
// against the chain (src/referral-chain.js): an authorization the chain has
// PAID (the receipt proves the transfer, chainVerdict) is booked as a sale,
// once, and kept as charged-undelivered; one whose nonce was spent without
// paying us, or that expired unused, is closed with nothing booked; one that
// cannot be read stays for the next pass.
//
// Bounded: at most MAX_ENTRIES; past it the oldest closed-out entry is
// dropped first, and an open one only with an error line. Nothing here is
// public: the operator route reads it, and no status word does.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { chainVerdict } from "./referral-chain.js";

export const REFERRAL_BOOK_DOC = "referral-settlements";
export const MAX_ENTRIES = 2000;
/** Open entries that may carry their answer (each at most the gate's stored-answer size). */
export const MAX_STORED_ANSWERS = 300;
/** A charged-undelivered entry is kept this long for the operator, then dropped. */
export const KEEP_CHARGED_MS = 30 * 24 * 3600_000;
/** An authorization is read as expired this long after its validBefore (host clock slack). */
export const EXPIRY_SLACK_MS = 120_000;
const OPEN = new Set(["intent", "in-doubt"]);

// With a state database the document is a row. Without one it is a file:
// REFERRAL_BOOK_FILE, else under /data when that volume exists, else under the
// system temp directory (as the other file stores do), so the book survives a
// restart in every mode.
const defaultFile = () => (process.env.REFERRAL_BOOK_FILE || join(existsSync("/data") ? "/data" : tmpdir(), "agent402-referral-settlements.json"));

export function createReferralBook({ doc = null, file = defaultFile(), now = Date.now, log = console, maxEntries = MAX_ENTRIES } = {}) {
  const store = doc || createJsonDocument({ name: REFERRAL_BOOK_DOC, file, log: () => {} });
  let entries = {};
  // The gate's own hang-up forgiveness records ([time, micro-dollars, key
  // digests]), kept here so a restart does not refill that budget.
  let forgiven = [];
  const absorb = (b) => {
    entries = b && typeof b === "object" && b.entries && typeof b.entries === "object" ? { ...b.entries } : {};
    forgiven = b && typeof b === "object" && Array.isArray(b.forgiven) ? b.forgiven.filter((r) => Array.isArray(r) && r.length === 3) : [];
  };
  try { absorb(store.loadSync(null)); } catch { /* read below */ }
  const ready = Promise.resolve().then(() => store.load(null)).then((b) => { if (b) absorb(b); }).catch(() => {});
  const say = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };

  async function change(fn) {
    const r = await store.update((body) => {
      const cur = body && typeof body === "object" && body.entries && typeof body.entries === "object" ? { ...body.entries } : {};
      const kept = body && typeof body === "object" && Array.isArray(body.forgiven) ? body.forgiven : [];
      const out = fn(cur, kept);
      return out === SKIP_UPDATE ? SKIP_UPDATE : { entries: cur, forgiven: Array.isArray(out) ? out : kept };
    }, { fallback: { entries: {}, forgiven: [] } });
    if (r.ok && r.body) absorb(r.body);
    return !!r.ok;
  }
  function trim(cur) {
    const keys = Object.keys(cur);
    if (keys.length <= maxEntries) return;
    const byAge = keys.sort((a, b) => (cur[a].at || 0) - (cur[b].at || 0));
    for (const k of byAge) {
      if (Object.keys(cur).length <= maxEntries) break;
      if (!OPEN.has(cur[k].state)) delete cur[k];
    }
    for (const k of byAge) {
      if (Object.keys(cur).length <= maxEntries) break;
      say("error", `settlement book is full (${maxEntries}); dropping the oldest open entry ${cur[k]?.state} slug=${cur[k]?.slug} nonce=${cur[k]?.nonce}`);
      delete cur[k];
    }
  }

  return {
    ready,
    /** Write the intent to settle. Resolves true once it is stored. */
    async intent({ key, slug, payer, nonce, amount, validBefore, answer = undefined }) {
      const t = now();
      return change((cur) => {
        const prev = cur[key];
        // The answer rides with the open entry (see the header); at most
        // MAX_STORED_ANSWERS are stored, the rest stay in the gate's memory.
        const stored = Object.values(cur).filter((e) => e.answer && e.key !== key).length;
        const keepAnswer = answer && stored < MAX_STORED_ANSWERS ? answer : (prev?.answer || null);
        cur[key] = { ...(prev || {}), answer: keepAnswer, key, slug: String(slug), payer: String(payer).toLowerCase(), nonce: String(nonce).toLowerCase(), amount: String(amount), validBefore: Number(validBefore) || 0, at: prev?.at || t, state: "intent", intentAt: t, attempts: (prev?.attempts || 0) + 1, tx: prev?.tx || null, saleBooked: prev?.saleBooked === true };
        trim(cur);
      });
    },
    /** Change an entry (`patch` merged), or remove it (`patch` null). */
    async resolve(key, patch) {
      return change((cur) => {
        if (!cur[key]) return SKIP_UPDATE;
        if (patch === null) delete cur[key];
        else cur[key] = { ...cur[key], ...patch, updatedAt: now() };
        return undefined;
      });
    },
    /** Record one forgiven hang-up; records older than `windowMs` are dropped, at most `max` kept. */
    async noteForgiven(record, { windowMs = 24 * 3600_000, max = 2000 } = {}) {
      const t = now();
      return change((_cur, kept) => [...kept.filter((r) => Array.isArray(r) && t - Number(r[0]) < windowMs), record].slice(-max));
    },
    forgiven: () => forgiven.slice(),
    get: (key) => entries[key] || null,
    /** The entries, newest first, without the stored answers and payments (the operator view). */
    list: () => Object.values(entries).sort((a, b) => (b.at || 0) - (a.at || 0)).map(({ answer, ...e }) => ({ ...e, answerStored: !!answer })),
    counts: () => {
      const c = { intent: 0, "in-doubt": 0, "charged-undelivered": 0 };
      for (const e of Object.values(entries)) if (e.state in c) c[e.state]++;
      return c;
    },
    /**
     * Read every open entry against the chain. `chain.state({from, nonce})`
     * is the reader; `bookSale(entry, transaction)` books the sale once and
     * resolves true when a row stands for it. `graceMs` keeps the sweep off an
     * intent whose settle call may still be in flight in this process.
     */
    async sweep({ chain, bookSale, payTo, onUnpaid = () => {}, graceMs = 120_000, max = 50 } = {}) {
      const t = now();
      const out = { read: 0, landed: 0, unpaid: 0, expired: 0, unknown: 0, dropped: 0 };
      try { const b = await store.load(null); if (b) absorb(b); } catch { /* the last body read */ }
      const due = Object.values(entries).filter((e) => (e.state === "in-doubt" || (e.state === "intent" && t - (e.intentAt || e.at || 0) >= graceMs))).slice(0, max);
      for (const e of due) {
        out.read++;
        let s;
        try { s = await chain.state({ from: e.payer, nonce: e.nonce, payTo, amount: e.amount }); } catch { s = { used: null, paid: null, transaction: null, logsRead: false }; }
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
          await this.resolve(e.key, { state: e.state === "intent" ? "in-doubt" : e.state, checks: (e.checks || 0) + 1 });
        }
      }
      // Charged entries the operator has had a month to read.
      for (const e of Object.values(entries)) {
        if (e.state === "charged-undelivered" && t - (e.landedAt || e.updatedAt || e.at || 0) > KEEP_CHARGED_MS) { out.dropped++; await this.resolve(e.key, null); }
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
