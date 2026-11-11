// Refund debts for external buyers charged by packs that could not deliver.
//
// The charged-failure detector mints a debt only when a settle receipt
// succeeds on a NON-200 response. Nine packs answered HTTP 200 with zero
// successful steps for every buyer between 2026-07-08 and 2026-08-31, so the
// refund ledger has no rows for any of them: it was structurally blind to
// exactly the failure we had. This mints what it could not see.
//
// RECORDS ONLY. Nothing here sends money. scripts/refund-run.js remains the
// sole payer - dry-run by default, capped per refund, per payer and per run,
// and it re-derives the inbound payment from the chain before every send and
// fails closed. A wrong row here becomes a HELD row, never a wrong payment.
// (An unsupported chain is held before the row is even claimed, so recording a
// Solana debt cannot strand it in `sending`.)
import { externalSalesForSlugs, salesByTx, salesLedgerRefresh } from "./sales-ledger.js";
import { recordRefundOwed, refundByEvidence, refundLedgerRefresh } from "./refund-ledger.js";

// Total non-delivery only. Packs that returned SOME real work are deliberately
// out: crypto-dossier delivered 5 of its 6 steps, and refunding a partial in
// full would be its own inaccuracy. Widen this only with a reason.
export const NON_DELIVERING_SLUGS = [
  "skill-earnings-deep-dive", "skill-options-analytics", "skill-fixed-income-desk",
  "skill-defi-protocol-scanner", "skill-openapi-audit", "skill-fred-snapshot",
  "skill-competitor-scan", "skill-schema-evolution", "skill-api-investigation",
];
// The packs shipped broken on 2026-07-08 and were fixed on 2026-08-31. A sale
// outside that window is not evidence of this defect.
export const DEFECT_FROM = Date.parse("2026-07-08T00:00:00Z");
export const DEFECT_UNTIL = Date.parse("2026-09-01T00:00:00Z");

export async function backfillBrokenPackRefunds({
  slugs = NON_DELIVERING_SLUGS,
  from = DEFECT_FROM,
  until = DEFECT_UNTIL,
  write = false,
} = {}) {
  const rows = externalSalesForSlugs(slugs, from, until);
  const byPayer = {};
  let owedUsd = 0, minted = 0, already = 0, noTx = 0;

  for (const r of rows) {
    const usd = Number(r.priceUsd) || 0;
    owedUsd += usd;
    const key = r.payer || "unattributed";
    byPayer[key] = byPayer[key] || { settlements: 0, usd: 0, network: r.network || null };
    byPayer[key].settlements++;
    byPayer[key].usd = Math.round((byPayer[key].usd + usd) * 1e6) / 1e6;
    // No settle tx means no idempotency key and nothing for the executor to
    // verify on-chain, so such a row would be unpayable anyway. Counted out
    // loud rather than minted as something unverifiable.
    if (!r.tx) { noTx++; continue; }
    if (!write) continue;
    if (await recordRefundOwed({
      slug: r.slug, network: r.network, payer: r.payer,
      priceUsd: usd, tx: r.tx, httpStatus: 200, synthetic: false,
    })) minted++; else already++;
  }

  return {
    write,
    window: { from: new Date(from).toISOString(), until: new Date(until).toISOString() },
    slugs,
    settlements: rows.length,
    owedUsd: Math.round(owedUsd * 1e6) / 1e6,
    byPayer,
    minted,
    alreadyRecorded: already,
    skippedNoTx: noTx,
  };
}

// Refund debts for sales the operator names by settle transaction.
//
// For a sale that answered 200 and was charged, yet is owed back for a reason
// no detector reads (a defect found afterwards, a pack outside the list
// above). The request names transactions and nothing else: the debt's payer,
// network, slug, price and wire are the sales ledger's own row, so a request
// can neither invent a sale nor redirect or resize one. A transaction that
// matches no sale, an internal sale (ours), or more than one sale is named in
// `skipped` and mints nothing.
//
// RECORDS ONLY, like the pack backfill: scripts/refund-run.js stays the sole
// payer, with its caps and its on-chain proof of the inbound payment. Dry by
// default; idempotent on the settle tx (the refund ledger's evidence key).
export const NAMED_SALES_MAX = 100;
export const NAMED_SALES_NOTE_MIN = 3;
export const NAMED_SALES_NOTE_MAX = 200;
const TX_MAX_CHARS = 200;

function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

export async function backfillNamedSales({ txs, note, write = false } = {}) {
  if (!Array.isArray(txs) || !txs.length) throw badRequest('"txs" must be a non-empty array of settle transaction values');
  if (txs.length > NAMED_SALES_MAX) throw badRequest(`"txs" holds ${txs.length} values, max ${NAMED_SALES_MAX} per request`);
  if (!txs.every((t) => typeof t === "string" && t.trim() && t.trim().length <= TX_MAX_CHARS)) throw badRequest(`every "txs" value must be a non-empty string of at most ${TX_MAX_CHARS} characters`);
  const why = typeof note === "string" ? note.trim() : "";
  if (why.length < NAMED_SALES_NOTE_MIN || why.length > NAMED_SALES_NOTE_MAX) throw badRequest(`"note" is required: a string of ${NAMED_SALES_NOTE_MIN} to ${NAMED_SALES_NOTE_MAX} characters saying why these sales are owed back`);

  // Database mode: both mirrors pull other containers' writes first, so a
  // sale or a debt landed elsewhere moments ago is read. No-ops in file mode.
  await Promise.all([salesLedgerRefresh().catch(() => 0), refundLedgerRefresh().catch(() => 0)]);

  const seen = new Set();
  const byPayer = {};
  const skipped = [];
  let matched = 0, owedUsd = 0, minted = 0, already = 0;
  const skip = (tx, reason) => skipped.push({ tx, reason });

  for (const raw of txs) {
    const tx = raw.trim(); // as given: a base58 signature is case-exact
    if (seen.has(tx)) { skip(tx, "repeated_in_request"); continue; }
    seen.add(tx);
    const sales = salesByTx(tx, { limit: 2 });
    if (!sales.length) { skip(tx, "no_sale"); continue; }
    if (sales.length > 1) { skip(tx, "more_than_one_sale"); continue; }
    const sale = sales[0];
    if (sale.internal) { skip(tx, "internal_sale"); continue; }
    // Nothing the executor could pay: no one to send to, or nothing to send.
    if (!sale.payer) { skip(tx, "no_payer"); continue; }
    if (!(sale.priceUsd > 0)) { skip(tx, "no_amount"); continue; }
    matched++;
    const recorded = !!refundByEvidence(tx);
    let didMint = false;
    if (write && !recorded) {
      didMint = !!(await recordRefundOwed({
        slug: sale.slug, network: sale.network, payer: sale.payer,
        priceUsd: sale.priceUsd, tx, httpStatus: 200, synthetic: false,
        wire: sale.wire, note: why,
      }));
    }
    if (recorded || (write && !didMint)) { already++; continue; }
    if (didMint) minted++;
    // byPayer and owedUsd count what this request mints (write) or would mint (dry).
    owedUsd += sale.priceUsd;
    const p = (byPayer[sale.payer] ||= { settlements: 0, usd: 0, network: sale.network });
    p.settlements++;
    p.usd = Math.round((p.usd + sale.priceUsd) * 1e6) / 1e6;
  }

  return {
    write: !!write,
    note: why,
    requested: txs.length,
    matched,
    wouldMint: write ? 0 : matched - already,
    minted,
    alreadyRecorded: already,
    owedUsd: Math.round(owedUsd * 1e6) / 1e6,
    byPayer,
    skipped,
  };
}
