// The per-call band prose calls "most tools". One named constant every page
// and machine surface reads, so the sentence is typed once; the served
// catalog is checked against it (scripts/test-docs-truth.js), so the band
// moves when the catalog does rather than outliving a repricing.
export const TYPICAL_PRICE_RANGE = Object.freeze({
  minUsd: 0.001,
  maxUsd: 0.02,
  text: "$0.001 to $0.02",
});

/** Share of the priced tools whose flat price sits inside the band: the
 *  claim "most tools" makes, measured. Prices are catalog strings ("$0.004")
 *  or numbers; a quoted or unparseable price is not counted. */
export function typicalPriceShare(prices, range = TYPICAL_PRICE_RANGE) {
  let priced = 0, inside = 0;
  for (const p of prices) {
    const n = typeof p === "number" ? p : Number(String(p ?? "").replace(/^\$/, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    priced++;
    if (n >= range.minUsd && n <= range.maxUsd) inside++;
  }
  return priced ? inside / priced : 0;
}
