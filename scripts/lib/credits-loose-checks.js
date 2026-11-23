// For a credits suite that is not about the purchase checks: the daily
// purchase limit and the per-buyer and per-source counts (src/credits-sales.js)
// are set wide, so a suite that buys many packs for one buyer tests what it
// names. The checks themselves are tested in scripts/test-credits-purchase-checks.js,
// with thresholds that suite sets.
export const LOOSE_CREDITS_ENV = {
  CREDITS_DAILY_MAX_USD: "1000",
  CREDITS_BUYER_HOUR_MAX: "100000",
  CREDITS_BUYER_DAY_MAX: "100000",
  CREDITS_SOURCE_HOUR_MAX: "100000",
  CREDITS_SOURCE_DAY_MAX: "100000",
  CREDITS_FAILED_MAX: "100000",
};
export function looseCreditsChecks() { Object.assign(process.env, LOOSE_CREDITS_ENV); }
looseCreditsChecks();
