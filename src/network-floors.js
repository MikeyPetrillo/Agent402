// Per-chain price floors: the least any call costs on a given chain.
// No chain carries a floor by default: every chain, Robinhood Chain
// (eip155:4663) included, quotes the list price plus its premium.
// NETWORK_PRICE_FLOORS="caip2=usd,..." sets one on any chain, and
// ROBINHOOD_MIN_PRICE_USD sets Robinhood's ("0" or unset: none).
//
// A floor is a PRICE, published in the 402 and on the chain's pages, never
// a cost figure. It is static on purpose: @x402/core re-derives the price on
// the paid retry, so a floor that moved between the 402 and the retry (for
// example one tracking gas) would make the signed amount disagree with the
// quote and the payment would be refused.
//
// Our own Robinhood relayer (src/robinhood-relayer.js) pays the gas of the
// sales it settles, so it takes a sale only when its price is at least
// ROBINHOOD_RELAYER_MIN_PRICE_USD (default ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD; "0" lets it settle any
// price). Under it the listed facilitators alone settle the sale, and a
// refusal from them stands as the buyer's 402.
//
// Its one import is the integer price scaling (src/base-units.js, a leaf): page
// and guide modules read the floor without loading payments.
import { usdToBaseUnits } from "./base-units.js";

/** A dollar amount in integer micro-dollars, scaled as a minted amount is. */
const microOf = (usd) => Number(usdToBaseUnits(usd, 6));

export const ROBINHOOD_CAIP2 = "eip155:4663";
export const ROBINHOOD_MIN_PRICE_DEFAULT_USD = 0;
export const ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD = 0.004;

/** The least price, in USD, a sale must carry for our own Robinhood relayer
 *  to settle it (it pays that sale's gas). Unset or blank: the default; a
 *  malformed or negative value is refused loudly for the default; "0": any
 *  price. */
export function robinhoodRelayerMinPriceUsd(env = process.env) {
  const raw = env.ROBINHOOD_RELAYER_MIN_PRICE_USD;
  if (raw === undefined || String(raw).trim() === "") return ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    console.warn(`[payments] ROBINHOOD_RELAYER_MIN_PRICE_USD ignored (malformed or negative): "${raw}"; using ${ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD}`);
    return ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD;
  }
  return usd;
}

/** The same minimum in the token's base units (USDG has 6 decimals). */
export function robinhoodRelayerMinUnits(env = process.env) {
  return usdToBaseUnits(robinhoodRelayerMinPriceUsd(env), 6);
}

// Our own Ink relayer (the same client, src/robinhood-relayer.js, with its own
// key INK_RELAYER_KEY) pays the gas of the Ink sales it settles, so it takes a
// sale only when its price is at least INK_RELAYER_MIN_PRICE_USD (default
// INK_RELAYER_MIN_PRICE_DEFAULT_USD; "0": any price).
export const INK_CAIP2 = "eip155:57073";
export const INK_RELAYER_MIN_PRICE_DEFAULT_USD = 0.001;

/** The least price, in USD, a sale must carry for our own Ink relayer to
 *  settle it. Same reading rules as the Robinhood minimum. */
export function inkRelayerMinPriceUsd(env = process.env) {
  const raw = env.INK_RELAYER_MIN_PRICE_USD;
  if (raw === undefined || String(raw).trim() === "") return INK_RELAYER_MIN_PRICE_DEFAULT_USD;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    console.warn(`[payments] INK_RELAYER_MIN_PRICE_USD ignored (malformed or negative): "${raw}"; using ${INK_RELAYER_MIN_PRICE_DEFAULT_USD}`);
    return INK_RELAYER_MIN_PRICE_DEFAULT_USD;
  }
  return usd;
}

/** The Ink minimum in USDC base units (6 decimals). */
export function inkRelayerMinUnits(env = process.env) {
  return usdToBaseUnits(inkRelayerMinPriceUsd(env), 6);
}

/** Our own relayer's minimum sale price on `network` (USD), or null for a
 *  network no relayer of ours settles. */
export function ownRelayerMinPriceUsd(network, env = process.env) {
  if (network === ROBINHOOD_CAIP2) return robinhoodRelayerMinPriceUsd(env);
  if (network === INK_CAIP2) return inkRelayerMinPriceUsd(env);
  return null;
}

/** caip2 -> floor in integer micro-dollars. A malformed or negative entry is
 *  refused loudly (never a floor below what was asked for silently). */
export function networkPriceFloors(env = process.env) {
  const out = new Map();
  for (const pair of String(env.NETWORK_PRICE_FLOORS || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const net = eq > 0 ? pair.slice(0, eq).trim() : "";
    const usd = eq > 0 ? Number(pair.slice(eq + 1)) : NaN;
    if (!net || !Number.isFinite(usd) || usd < 0) { console.warn(`[payments] NETWORK_PRICE_FLOORS entry ignored (malformed or negative): "${pair}"`); continue; }
    if (usd > 0) out.set(net, microOf(usd));
  }
  if (!out.has(ROBINHOOD_CAIP2)) {
    const raw = env.ROBINHOOD_MIN_PRICE_USD;
    const usd = raw === undefined || String(raw).trim() === "" ? ROBINHOOD_MIN_PRICE_DEFAULT_USD : Number(raw);
    if (!Number.isFinite(usd) || usd < 0) console.warn(`[payments] ROBINHOOD_MIN_PRICE_USD ignored (malformed or negative): "${raw}"; using ${ROBINHOOD_MIN_PRICE_DEFAULT_USD}`);
    const use = Number.isFinite(usd) && usd >= 0 ? usd : ROBINHOOD_MIN_PRICE_DEFAULT_USD;
    if (use > 0) out.set(ROBINHOOD_CAIP2, microOf(use));
  }
  return out;
}

/** The floor for one network in USD (0 when it has none). */
export function networkFloorUsd(network, floors = networkPriceFloors()) {
  return (floors.get(network) || 0) / 1e6;
}

/** "$0.001" on a network with a $0.006 floor -> "$0.006"; at or above the floor, or on a
 *  network without one, the price is returned unchanged. A price this parser
 *  cannot read is returned unchanged (never a NaN quote). */
export function applyNetworkFloor(price, network, floors = networkPriceFloors()) {
  const floor = floors.get(network);
  if (!floor) return price;
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(String(price));
  if (!m) return price;
  if (microOf(m[1]) >= floor) return price;
  return "$" + (floor / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
