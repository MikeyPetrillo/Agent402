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
// refused. What stays is exactly what still needs an answer. A sweep (at boot
// and on a leased timer, startReferralBookSweep) reads every open entry
// against the chain (src/referral-chain.js): an authorization the chain has
// used is booked as a sale, once, and kept as charged-undelivered; one that
// expired unused is closed; one that cannot be read stays for the next pass.
//
// Bounded: at most MAX_ENTRIES; past it the oldest closed-out entry is
// dropped first, and an open one only with an error line. Nothing here is
// public: the operator route reads it, and no status word does.
import { existsSync } from "node:fs";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";

export const REFERRAL_BOOK_DOC = "referral-settlements";
export const MAX_ENTRIES = 2000;
/** A charged-undelivered entry is kept this long for the operator, then dropped. */
export const KEEP_CHARGED_MS = 30 * 24 * 3600_000;
/** An authorization is read as expired this long after its validBefore (host clock slack). */
export const EXPIRY_SLACK_MS = 120_000;
const OPEN = new Set(["intent", "in-doubt"]);

const defaultFile = () => (process.env.REFERRAL_BOOK_FILE || (existsSync("/data") ? "/data/referral-settlements.json" : null));

export function createReferralBook({ doc = null, file = defaultFile(), now = Date.now, log = console, maxEntries = MAX_ENTRIES } = {}) {
  const store = doc || createJsonDocument({ name: REFERRAL_BOOK_DOC, file, log: () => {} });
  let entries = {};
  const absorb = (b) => { entries = b && typeof b === "object" && b.entries && typeof b.entries === "object" ? { ...b.entries } : {}; };
  try { absorb(store.loadSync(null)); } catch { /* read below */ }
  const ready = Promise.resolve().then(() => store.load(null)).then((b) => { if (b) absorb(b); }).catch(() => {});
  const say = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };

  async function change(fn) {
    const r = await store.update((body) => {
      const cur = body && typeof body === "object" && body.entries && typeof body.entries === "object" ? { ...body.entries } : {};
      const out = fn(cur);
      return out === SKIP_UPDATE ? SKIP_UPDATE : { entries: cur };
    }, { fallback: { entries: {} } });
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
    async intent({ key, slug, payer, nonce, amount, validBefore }) {
      const t = now();
      return change((cur) => {
        const prev = cur[key];
        cur[key] = { ...(prev || {}), key, slug: String(slug), payer: String(payer).toLowerCase(), nonce: String(nonce).toLowerCase(), amount: String(amount), validBefore: Number(validBefore) || 0, at: prev?.at || t, state: "intent", intentAt: t, attempts: (prev?.attempts || 0) + 1, tx: prev?.tx || null, saleBooked: prev?.saleBooked === true };
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
    get: (key) => entries[key] || null,
    list: () => Object.values(entries).sort((a, b) => (b.at || 0) - (a.at || 0)),
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
    async sweep({ chain, bookSale, graceMs = 120_000, max = 50 } = {}) {
      const t = now();
      const out = { read: 0, landed: 0, expired: 0, unknown: 0, dropped: 0 };
      try { const b = await store.load(null); if (b) absorb(b); } catch { /* the last body read */ }
      const due = Object.values(entries).filter((e) => (e.state === "in-doubt" || (e.state === "intent" && t - (e.intentAt || e.at || 0) >= graceMs))).slice(0, max);
      for (const e of due) {
        out.read++;
        let s;
        try { s = await chain.state({ from: e.payer, nonce: e.nonce }); } catch { s = { used: null, transaction: null }; }
        if (s.used === true) {
          let booked = e.saleBooked === true;
          if (!booked) { try { booked = (await bookSale(e, s.transaction)) === true; } catch { booked = false; } }
          out.landed++;
          say("error", `CHARGED-BUT-NOT-SERVED: a settlement left open landed on chain (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${s.transaction || "not found"})${booked ? ", sale booked" : ", sale NOT booked"}`);
          await this.resolve(e.key, { state: "charged-undelivered", tx: s.transaction || e.tx || null, saleBooked: booked, landedAt: t });
        } else if (s.used === false && e.validBefore > 0 && t > e.validBefore * 1000 + EXPIRY_SLACK_MS) {
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
