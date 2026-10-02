// The order /api/route applies to candidates, in ONE place.
//
// routeQuery (src/x402-index.js) sorts by match score, then its `tiebreak`
// comparator: crawl health, distinct payers over the last 30 days as the
// Bazaar measures them (skipped for a local row with no measurement), cheapest
// known price, the Bazaar's curated flag, shorter slug. Two surfaces describe
// that order - every result's `why.tiebreaks` and the prose sentence
// (routerRankingSentence, src/routing-proof.js) - and both read this list, so
// neither can name an order the sort does not apply. A leaf module: no imports,
// so the index and the prose can both depend on it.
//
// test-route-order.js pins this list against the comparator's own source, so a
// step added to or moved in the sort without a change here fails CI.
export const ROUTE_ORDER = Object.freeze([
  { key: "score", label: "score", prose: "how well they match the task" },
  { key: "health", label: "health", prose: "crawl health" },
  { key: "bazaarPayers30d", label: "distinct payers, last 30 days (Bazaar)", prose: "distinct payers over the last 30 days" },
  { key: "price", label: "cheapest known price", prose: "price" },
  { key: "bazaarCurated", label: "curated (Bazaar)", prose: "a discovery listing's curated flag" },
  { key: "slugLength", label: "shorter slug", prose: "slug length, shorter first" },
]);

/** "by A, by B and by C" over the tiebreak steps (everything after score). */
export function routeTiebreakProse() {
  const xs = ROUTE_ORDER.slice(1).map((o) => `by ${o.prose}`);
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** The labels in sort order, as `why.tiebreaks` publishes them. */
export function routeTiebreakLabels() {
  return ROUTE_ORDER.map((o) => o.label);
}
