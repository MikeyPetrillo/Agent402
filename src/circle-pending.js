// Arc settlements Circle left unresolved, booked by paymentId until they are.
//
// Circle's /settle can answer `settlement_pending`: the payment is recorded on
// its side and its outcome was not known inside the wait window. The client
// (src/circle-facilitator.js) polls /status for a bounded time first; a payment
// still pending after that is refused to the buyer (nothing is served), which
// is right only if it never lands. It may land later, and then the buyer was
// charged for nothing. So the payment is booked here, keyed by Circle's
// paymentId, and a reconcile pass reads its final state:
//
//   completed -> the charge happened and nothing was served: it becomes an
//                owed refund in the refund ledger, keyed by the settlement tx,
//                so the refund runner repays it only after on-chain proof
//                (src/payment-verify.js), exactly like any charged failure;
//   failed    -> nothing was charged, nothing is owed; the entry is dropped;
//   pending   -> kept for the next pass.
//
// A retry by the buyer is a new authorization (a new paymentId), so each
// charge is booked once and repaid at most once (the ledger dedupes by tx).
//
// Stored in the state database when one is configured, in the file otherwise
// (src/json-document.js). The reconcile pass runs under a lease, so two
// containers never resolve the same entry at once.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";
import { recordRefundOwed } from "./refund-ledger.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

/** The route slug a refund row names, from the resource URL the buyer paid. */
function slugOf(resourceUrl) {
  try {
    const p = new URL(String(resourceUrl)).pathname.replace(/\/+$/, "");
    return (p.startsWith("/api/") ? p.slice(5) : p.replace(/^\//, "")).slice(0, 120) || "unknown";
  } catch { return "unknown"; }
}

export function createCirclePendingBook({
  file = process.env.CIRCLE_PENDING_FILE || "/data/circle-pending.json",
  recordOwed = recordRefundOwed,
  now = () => Date.now(),
  log = console.warn,
} = {}) {
  let state = { pending: {} };
  const absorb = (s) => { if (s && typeof s === "object" && s.pending && typeof s.pending === "object") state = { pending: { ...s.pending } }; };
  const doc = createJsonDocument({ name: "circle-pending", file, log: () => {} });
  absorb(doc.loadSync(null));
  const ready = trackStoreReady(doc.backend === "pg" ? doc.load(null).then(absorb) : Promise.resolve(), "circle-pending");
  const PG = doc.backend === "pg";

  // Read-modify-write against the stored body, so two containers booking or
  // resolving at once never drop each other's entries.
  const change = async (fn) => {
    if (!PG) { fn(state.pending); await doc.save(state); return true; }
    const r = await doc.update((b) => {
      const pending = { ...((b && typeof b === "object" && b.pending) || {}) };
      fn(pending);
      return { pending };
    }, { fallback: null });
    if (r.ok) absorb(r.body);
    return !!r.ok;
  };

  return {
    ready,
    /** Book one unresolved settlement. Ignores anything without a valid paymentId. */
    async book({ paymentId, payer, network, amount, resource } = {}) {
      if (typeof paymentId !== "string" || !UUID.test(paymentId)) return false;
      const entry = {
        paymentId,
        payer: ADDR.test(String(payer || "")) ? payer : null,
        network: String(network || ""),
        amount: /^[0-9]{1,30}$/.test(String(amount || "")) ? String(amount) : "0",
        slug: slugOf(resource),
        at: now(),
      };
      log(`[circle] Arc settlement ${paymentId} still pending; booked for reconcile`);
      return change((p) => { if (!p[paymentId]) p[paymentId] = entry; });
    },
    list() { return Object.values(state.pending); },
    /**
     * One reconcile pass. `status(paymentId)` answers { status, transaction }
     * or null (unreadable: try again next pass).
     */
    async reconcile({ status, maxChecks = 50 } = {}) {
      const out = { checked: 0, owed: 0, failed: 0, pending: 0 };
      if (PG) { const r = await doc.load(null).catch(() => null); absorb(r); }
      for (const e of this.list().slice(0, maxChecks)) {
        out.checked++;
        let s = null;
        try { s = await status(e.paymentId); } catch { s = null; }
        if (s?.status === "completed" && TX.test(String(s.transaction || ""))) {
          await recordOwed({
            slug: e.slug, network: e.network, payer: e.payer, priceUsd: Number(e.amount) / 1e6,
            tx: s.transaction, httpStatus: 402, wire: "x402",
            note: "Arc settlement completed after the buyer was refused as pending",
          });
          await change((p) => { delete p[e.paymentId]; });
          out.owed++;
        } else if (s?.status === "failed") {
          await change((p) => { delete p[e.paymentId]; });
          out.failed++;
        } else {
          out.pending++;
        }
      }
      return out;
    },
  };
}
