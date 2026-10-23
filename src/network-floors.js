// Per-chain price floors: the least any call costs on a chain whose settlement
// we may pay for ourselves. Robinhood Chain (eip155:4663) settles through the
// listed facilitators first and through our own relayer when they fail, and
// that relayer pays the chain's gas per settlement; a call priced below that
// would be served at a loss. So every eip155:4663 accept quotes at least the
// floor, and every other chain quotes exactly what it quoted before.
//
// The floor is a PRICE, published in the 402 and on the chain's pages, never
// a cost figure. It is static on purpose: @x402/core re-derives the price on
// the paid retry, so a floor that moved between the 402 and the retry (for
// example one tracking gas) would make the signed amount disagree with the
// quote and the payment would be refused. ROBINHOOD_MIN_PRICE_USD tunes it
// ("0" turns it off); NETWORK_PRICE_FLOORS="caip2=usd,..." sets any other.
//
// No imports: page and guide modules read the floor without loading payments.

export const ROBINHOOD_CAIP2 = "eip155:4663";
export const ROBINHOOD_MIN_PRICE_DEFAULT_USD = 0.006;

/** caip2 -> floor in integer micro-dollars. A malformed or negative entry is
 *  refused loudly (never a floor below what was asked for silently). */
export function networkPriceFloors(env = process.env) {
  const out = new Map();
  for (const pair of String(env.NETWORK_PRICE_FLOORS || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const net = eq > 0 ? pair.slice(0, eq).trim() : "";
    const usd = eq > 0 ? Number(pair.slice(eq + 1)) : NaN;
    if (!net || !Number.isFinite(usd) || usd < 0) { console.warn(`[payments] NETWORK_PRICE_FLOORS entry ignored (malformed or negative): "${pair}"`); continue; }
    if (usd > 0) out.set(net, Math.round(usd * 1e6));
  }
  if (!out.has(ROBINHOOD_CAIP2)) {
    const raw = env.ROBINHOOD_MIN_PRICE_USD;
    const usd = raw === undefined || String(raw).trim() === "" ? ROBINHOOD_MIN_PRICE_DEFAULT_USD : Number(raw);
    if (!Number.isFinite(usd) || usd < 0) console.warn(`[payments] ROBINHOOD_MIN_PRICE_USD ignored (malformed or negative): "${raw}"; using ${ROBINHOOD_MIN_PRICE_DEFAULT_USD}`);
    const use = Number.isFinite(usd) && usd >= 0 ? usd : ROBINHOOD_MIN_PRICE_DEFAULT_USD;
    if (use > 0) out.set(ROBINHOOD_CAIP2, Math.round(use * 1e6));
  }
  return out;
}

/** The floor for one network in USD (0 when it has none). */
export function networkFloorUsd(network, floors = networkPriceFloors()) {
  return (floors.get(network) || 0) / 1e6;
}

/** "$0.001" on a floored network -> "$0.006"; at or above the floor, or on a
 *  network without one, the price is returned unchanged. A price this parser
 *  cannot read is returned unchanged (never a NaN quote). */
export function applyNetworkFloor(price, network, floors = networkPriceFloors()) {
  const floor = floors.get(network);
  if (!floor) return price;
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(String(price));
  if (!m) return price;
  if (Math.round(Number(m[1]) * 1e6) >= floor) return price;
  return "$" + (floor / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
