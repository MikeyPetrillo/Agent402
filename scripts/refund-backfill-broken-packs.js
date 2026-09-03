// CLI over src/refund-backfill.js, for running inside the prod container.
// The dispatch path is .github/workflows/refund-backfill.yml, which calls the
// same logic through POST /__operator/refunds/backfill - one implementation,
// so the two cannot drift.
//
//   node scripts/refund-backfill-broken-packs.js          # dry run
//   node scripts/refund-backfill-broken-packs.js --write  # mint the debts
//
// RECORDS ONLY. scripts/refund-run.js is still the only thing that pays.
import { backfillBrokenPackRefunds } from "../src/refund-backfill.js";

const write = process.argv.includes("--write");
const r = backfillBrokenPackRefunds({ write });

console.log(`${r.settlements} external settlement(s) of a non-delivering pack between ${r.window.from} and ${r.window.until}`);
console.log(`total owed: $${r.owedUsd.toFixed(4)}`);
for (const [payer, v] of Object.entries(r.byPayer).sort((a, b) => b[1].usd - a[1].usd)) {
  console.log(`  ${payer} (${v.network || "?"}): ${v.settlements} settlement(s), $${v.usd.toFixed(4)}`);
}
if (r.skippedNoTx) console.log(`${r.skippedNoTx} row(s) carry no settle tx and were skipped (nothing to verify on-chain)`);
if (!write) { console.log("\nDRY RUN - nothing recorded. Re-run with --write to mint these debts."); process.exit(0); }
console.log(`minted ${r.minted} new debt(s), ${r.alreadyRecorded} already recorded`);
