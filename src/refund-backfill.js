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
import { externalSalesForSlugs } from "./sales-ledger.js";
import { recordRefundOwed } from "./refund-ledger.js";

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

export function backfillBrokenPackRefunds({
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
    if (recordRefundOwed({
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
