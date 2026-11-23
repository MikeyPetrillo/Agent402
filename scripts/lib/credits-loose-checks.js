// For a credits suite that is not about the purchase checks: the daily
// purchase limit and the per-buyer, per-source and failed-payment counts of
// the private table (src/credits-guards.js) are set wide, so a suite that buys
// many packs for one buyer tests what it names. The checks themselves are
// tested in scripts/test-credits-purchase-checks.js, from the table that suite
// is given.
import { makeGuardsTable, useGuardsTable } from "./credits-guards-table.js";

const WIDE = 1e6;
export function looseCreditsChecks() {
  process.env.CREDITS_DAILY_MAX_USD = String(WIDE / 1000);
  const t = process.env.CREDITS_GUARDS_JSON ? JSON.parse(process.env.CREDITS_GUARDS_JSON) : makeGuardsTable();
  t.purchase = { ...t.purchase, buyerPerHour: WIDE, buyerPerDay: WIDE, sourcePerHour: WIDE, sourcePerDay: WIDE, failedMax: WIDE };
  useGuardsTable(t);
}
looseCreditsChecks();
