// Arc settlements Circle left unresolved, booked until they are.
//
// Circle's /settle can answer `settlement_pending`: the payment is recorded on
// its side and its outcome was not known inside the wait window. The client
// (src/circle-facilitator.js) polls /status for a bounded time first; a payment
// still pending after that is refused to the buyer (nothing is served), and
// its authorization stays claimed (src/settlement-claims.js), so the same
// signed payment cannot be resent and served while it is unresolved. It may
// still land, and then the buyer was charged for nothing. So it is booked
// here, keyed by the AUTHORIZATION it carries (network, payer, nonce), with
// Circle's paymentId to ask about it, and a reconcile pass reads its final
// state:
//
//   completed -> unless that tx was served after all (a sale recorded for it,
//                or another request holding its settlement claim), the charge
//                happened and nothing was served: it becomes an owed refund
//                keyed by the settlement tx, repaid only after on-chain proof
//                (src/payment-verify.js). The entry is dropped only once the
//                refund ledger holds that row.
//   failed    -> nothing was charged, nothing is owed; dropped.
//   pending   -> kept, next asked after a growing backoff.
//   unreadable (Circle has no answer, or keeps answering 404) -> kept with a
//                backoff; after UNREADABLE_LIMIT reads, or past MAX_AGE_MS, it
//                moves to `unresolved`: never polled again and never dropped,
//                and alarmStatus() reads "unresolved" until an operator
//                resolves it, so it pages (/api/gateway-status circlePending).
//
// Each pass asks the entries whose next check is due, oldest first, at most
// maxChecks of them and within maxPassMs, so a stuck entry can never starve a
// newer one. The book is bounded (MAX_ENTRIES); near the bound the alarm word
// is "near_capacity", at it "full" (a new entry is refused rather than
// silently replacing an old one, and the refusal is logged; "full" clears once
// the book is below the bound again). The alarm word is read from the shared
// store, so every replica reports the same word. An operator resolves an
// unresolved entry with resolve() (/__operator/circle-pending, token-authed).
//
// Stored in the state database when one is configured, in the file otherwise
// (src/json-document.js). The reconcile pass runs under a lease that covers
// its whole time budget, so two containers never resolve one entry at once.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";
import { recordRefundOwed, refundByEvidenceFresh } from "./refund-ledger.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;

export const MAX_ENTRIES = 2000;
export const NEAR_CAPACITY = 0.8;
export const UNREADABLE_LIMIT = 12;
export const MAX_AGE_MS = 7 * 24 * 3600_000;
export const FIRST_CHECK_MS = 60_000;
export const MAX_BACKOFF_MS = 6 * 3600_000;
/** Worst-case pass length; the reconcile lease must outlast it. */
export const MAX_PASS_MS = 4 * 60_000;
/** The lease: the pass budget, plus one status call that started inside it
 *  (15 s at most), plus margin. */
export const RECONCILE_LEASE_MS = MAX_PASS_MS + 2 * 60_000;

/** The route slug a refund row names, from the resource URL the buyer paid. */
function slugOf(resourceUrl) {
  try {
    const p = new URL(String(resourceUrl)).pathname.replace(/\/+$/, "");
    return (p.startsWith("/api/") ? p.slice(5) : p.replace(/^\//, "")).slice(0, 120) || "unknown";
  } catch { return "unknown"; }
}

/** The book's key: the authorization itself, not Circle's id for it. */
export const pendingKey = (network, payer, nonce) => `${String(network)}|${String(payer).toLowerCase()}|${String(nonce).toLowerCase()}`;

const backoff = (checks) => Math.min(FIRST_CHECK_MS * 2 ** Math.max(0, checks), MAX_BACKOFF_MS);

export function createCirclePendingBook({
  file = process.env.CIRCLE_PENDING_FILE || "/data/circle-pending.json",
  recordOwed = recordRefundOwed,
  owedRecorded = async (tx) => !!(await refundByEvidenceFresh(tx)),
  wasServed = async () => false,
  now = () => Date.now(),
  log = console.warn,
  maxEntries = MAX_ENTRIES,
} = {}) {
  let state = { pending: {} };
  const absorb = (s) => { if (s && typeof s === "object" && s.pending && typeof s.pending === "object") state = { pending: { ...s.pending } }; };
  const doc = createJsonDocument({ name: "circle-pending", file, log: () => {} });
  absorb(doc.loadSync(null));
  const ready = trackStoreReady(doc.backend === "pg" ? doc.load(null).then(absorb) : Promise.resolve(), "circle-pending");
  const PG = doc.backend === "pg";

  // Every decision reads the SHARED store first (the row, or the file), never
  // this process's memory alone: two replicas share one book, so one that has
  // never booked anything must still see the other's unresolved entry.
  // An empty store body replaces memory (another replica resolved it all).
  const refresh = async () => {
    try {
      const b = PG ? await doc.load(null) : doc.loadSync(null);
      if (b && typeof b === "object") absorb(b);
      else state = { pending: {} };
    } catch { /* keep the last body read */ }
  };

  // Read-modify-write against the stored body, so two containers booking or
  // resolving at once never drop each other's entries.
  const change = async (fn) => {
    if (!PG) {
      await refresh();
      fn(state.pending);
      await doc.save(state);
      return true;
    }
    const r = await doc.update((b) => {
      const pending = { ...((b && typeof b === "object" && b.pending) || {}) };
      fn(pending);
      return { pending };
    }, { fallback: null });
    if (r.ok) absorb(r.body);
    return !!r.ok;
  };
  const entries = () => Object.values(state.pending);
  const wordOf = (all) => {
    if (all.some((e) => e.state === "unresolved")) return "unresolved";
    if (all.length >= maxEntries) return "full";
    if (all.length >= Math.ceil(maxEntries * NEAR_CAPACITY)) return "near_capacity";
    return "ok";
  };

  return {
    ready,
    refresh,
    /** Book one unresolved settlement under its authorization. */
    async book({ paymentId, payer, network, nonce, amount, resource } = {}) {
      if (typeof paymentId !== "string" || !UUID.test(paymentId)) return false;
      if (!ADDR.test(String(payer || "")) || !B32.test(String(nonce || "")) || !String(network || "").startsWith("eip155:")) return false;
      const key = pendingKey(network, payer, nonce);
      await refresh();
      if (state.pending[key]) return true;
      if (entries().length >= maxEntries) {
        log(`[circle] pending book is full (${maxEntries}); Arc settlement ${paymentId} NOT booked - resolve the unresolved entries`);
        return false;
      }
      const t = now();
      const entry = {
        key, paymentId, payer, network: String(network), nonce: String(nonce).toLowerCase(),
        amount: /^[0-9]{1,30}$/.test(String(amount || "")) ? String(amount) : "0",
        slug: slugOf(resource), at: t, nextCheckAt: t + FIRST_CHECK_MS, checks: 0, unreadable: 0, failures: 0, state: "pending",
      };
      log(`[circle] Arc settlement ${paymentId} still pending; booked for reconcile`);
      return change((p) => { if (!p[key]) p[key] = entry; });
    },
    /** The entries as last read; call refresh() first for the shared view. */
    list() { return entries(); },
    /** One word for /api/gateway-status, from the shared store: ok /
     *  near_capacity / full (at the bound now; clears below it) / unresolved. */
    async alarmStatus() {
      await refresh();
      return wordOf(entries());
    },
    /** Operator view: the unresolved and due counts plus the unresolved
     *  entries' identifiers (no amounts), from the shared store. */
    async operatorView() {
      await refresh();
      const all = entries();
      return {
        status: wordOf(all),
        total: all.length,
        bound: maxEntries,
        unresolved: all.filter((e) => e.state === "unresolved").map((e) => ({ key: e.key, paymentId: e.paymentId, network: e.network, at: e.at, unresolvedAt: e.unresolvedAt || null, checks: e.checks })),
      };
    },
    /**
     * Operator action: settle one entry by hand after checking Circle and the
     * chain. `outcome` is "refunded" (a refund was booked or paid elsewhere),
     * "not_charged" (the transfer never happened) or "retry" (back to pending,
     * checked again now). Requires a note; the caller logs it.
     */
    async resolve(key, { outcome, note } = {}) {
      if (typeof note !== "string" || !note.trim()) return { ok: false, error: "a note saying what was checked is required" };
      if (!["refunded", "not_charged", "retry"].includes(outcome)) return { ok: false, error: "outcome must be refunded, not_charged or retry" };
      await refresh();
      const e = state.pending[String(key || "")];
      if (!e) return { ok: false, error: "no such entry" };
      const ok = await change((p) => {
        if (!p[e.key]) return;
        if (outcome === "retry") p[e.key] = { ...p[e.key], state: "pending", unreadable: 0, failures: 0, nextCheckAt: now() };
        else delete p[e.key];
      });
      log(`[circle] operator resolved Arc pending ${e.paymentId} as ${outcome}: ${note.trim().slice(0, 200)}`);
      return { ok, paymentId: e.paymentId, outcome };
    },
    /**
     * One reconcile pass. `status(paymentId)` answers { status, transaction }
     * or null (unreadable this time). A throw while handling one entry is
     * counted and that entry backs off; the pass continues with the next.
     */
    async reconcile({ status, maxChecks = 50, maxPassMs = MAX_PASS_MS } = {}) {
      const out = { checked: 0, owed: 0, served: 0, failed: 0, pending: 0, unreadable: 0, unresolved: 0, errors: 0 };
      await refresh();
      const started = now();
      const due = entries()
        .filter((e) => e.state === "pending" && (e.nextCheckAt || 0) <= started)
        .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0) || a.at - b.at)
        .slice(0, maxChecks);
      for (const e of due) {
        if (now() - started >= maxPassMs) break;
        out.checked++;
        try {
          await this._one(e, status, out);
        } catch {
          out.errors++;
          const failures = (e.failures || 0) + 1;
          try {
            await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], failures, nextCheckAt: now() + backoff(failures) }; });
          } catch { /* the store itself is failing: the next pass retries */ }
        }
      }
      return out;
    },
    async _one(e, status, out) {
      let s = null;
      try { s = await status(e.paymentId); } catch { s = null; }
      if (s?.status === "completed" && TX.test(String(s.transaction || ""))) {
        if (await wasServed({ tx: s.transaction, network: e.network, nonce: e.nonce, paymentId: e.paymentId })) {
          await change((p) => { delete p[e.key]; });
          out.served++;
          return;
        }
        await recordOwed({
          slug: e.slug, network: e.network, payer: e.payer, priceUsd: Number(e.amount) / 1e6,
          tx: s.transaction, httpStatus: 402, wire: "x402",
          note: "Arc settlement completed after the buyer was refused as pending",
        });
        // Dropped only once the ledger holds the debt (a new row or one
        // already there for this tx); a write that did not land is retried.
        if (await owedRecorded(s.transaction).catch(() => false)) {
          await change((p) => { delete p[e.key]; });
          out.owed++;
        } else {
          await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], nextCheckAt: now() + FIRST_CHECK_MS }; });
          out.pending++;
        }
      } else if (s?.status === "failed") {
        await change((p) => { delete p[e.key]; });
        out.failed++;
      } else {
        const unreadable = s ? e.unreadable : e.unreadable + 1;
        const checks = e.checks + 1;
        const stale = unreadable >= UNREADABLE_LIMIT || now() - e.at >= MAX_AGE_MS;
        await change((p) => {
          if (!p[e.key]) return;
          p[e.key] = { ...p[e.key], checks, unreadable, nextCheckAt: now() + backoff(checks), ...(stale ? { state: "unresolved", unresolvedAt: now() } : {}) };
        });
        if (stale) { out.unresolved++; log(`[circle] Arc settlement ${e.paymentId} unresolved after ${checks} checks; operator action needed`); }
        else if (s) out.pending++;
        else out.unreadable++;
      }
    },
  };
}
