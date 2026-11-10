// The "from" price of a route quoted per request: the smallest amount its 402
// can ask. One reading for every surface that prints it (/api/pricing,
// /openapi.json, llms-full.txt, the tool pages): the published range's floor
// (def.quoteRange.minUsd, set in server.js from the tool's own quoteMinUsd or,
// for a tool that declares none, its list price). A tool whose list price is
// not its cheapest quote (decide lists its default depth; the quick depth
// costs less) therefore reads the same floor everywhere.

const listUsd = (tool) => Number(String(tool?.price ?? "").replace(/[^0-9.]/g, "")) || 0;

/** The floor of a quoted tool's range in USD; a tool without a range reads its list price. */
export function fromUsdOf(tool) {
  const min = Number(tool?.quoteRange?.minUsd);
  return Number.isFinite(min) && min > 0 ? min : listUsd(tool);
}

/** The floor as the catalog prints prices: the list price string itself when
 *  that is the floor, else "$" and the amount with at least three decimals. */
export function fromPriceLabel(tool) {
  const min = fromUsdOf(tool);
  if (min === listUsd(tool)) return String(tool?.price ?? "");
  const [whole, frac = ""] = String(Number(min.toFixed(6))).split(".");
  return `$${whole}.${frac.padEnd(3, "0")}`;
}
