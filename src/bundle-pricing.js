// Price of a multi-unit bundle product (src/tools/bundle-kit.js), derived from
// the catalog the same way a skill pack is (scripts/pack-prices.js): the sum
// of the tools the bundle buys for each unit (a site, a company, a coin),
// times the number of units, minus the same bundle discount, rounded up to
// $0.001, never below the settlement floor.
//
//   price(units) = max(floor, ceil_to_$0.001(units * sum(leg prices) * (1 - discount)))
//
// A leg's price is read from the leg tool's own catalog entry, never typed
// here, so a repriced leg reprices every bundle that runs it.
// scripts/test-bundle-products.js checks the discount and floor against the
// pack rule's own constants, so the two rules cannot drift apart.

export const BUNDLE_DISCOUNT = 0.10;
export const BUNDLE_FLOOR_USD = 0.001;

export const priceUsdOf = (p) => {
  const n = Number(String(p ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
export const ceilMilli = (usd) => Math.ceil(usd * 1000 - 1e-9) / 1000;

/** The catalog price of one unit's legs, before the discount. `priceOf(slug)`
 *  returns the leg tool's price string (or number). */
export function unitPartsUsd(legSlugs, priceOf) {
  return legSlugs.reduce((sum, slug) => sum + priceUsdOf(priceOf(slug)), 0);
}

/** The bundle's price in USD for `units` units. */
export function bundlePriceUsd(units, legSlugs, priceOf, { discount = BUNDLE_DISCOUNT, floor = BUNDLE_FLOOR_USD } = {}) {
  const n = Math.max(1, Math.floor(Number(units) || 0));
  return Math.max(floor, ceilMilli(n * unitPartsUsd(legSlugs, priceOf) * (1 - discount)));
}

/** "$0.123" spelling of a whole-milli-dollar price (no trailing zeros). */
export function usdText(usd) {
  return `$${Number(usd).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
}
