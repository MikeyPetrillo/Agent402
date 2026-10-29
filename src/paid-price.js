// The USD a request actually paid on its chain, for the books and for refunds.
//
// The accept a buyer signs is priced per network (src/payments.js
// priceForNetwork: list or per-request quote, plus that network's premium,
// raised to its floor), so on a chain with a premium or a floor the amount that
// moved is more than the route's list price. A sale, a hang-up debt or a
// charged-failure debt booked at the list price would understate revenue and
// under-refund the buyer by the difference. This module answers the paid amount:
//
//   1. a metered settle's actual amount (the upto meter's X-Metered-Usd), as is;
//   2. else, on an EVM rail, the amount the buyer SIGNED (EIP-3009
//      authorization.value, which the facilitator verifies equals the
//      requirement), in the rail's stablecoin units;
//   3. else the gated price run through the same priceForNetwork that priced
//      the accept (Solana, Stellar, Algorand carry no readable amount here).
//
// On a network with neither a premium nor a floor every branch answers the
// gated price unchanged, so those rows are exactly what they were.

import { priceForNetwork } from "./payments.js";

// Every EVM rail we offer settles a 6-decimal stablecoin (USDC, USDG).
export const EVM_STABLE_DECIMALS = 6;

const usdString = (n) => "$" + Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const num = (s) => { const v = Number(String(s ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(v) ? v : NaN; };

/** The USD an EVM exact payment signed for, or null when the header carries
 *  no readable EIP-3009 amount for that network. */
export function signedEvmAmountUsd(paymentHeader, caip2, decimals = EVM_STABLE_DECIMALS) {
  if (!paymentHeader || !String(caip2 || "").startsWith("eip155:")) return null;
  try {
    const p = JSON.parse(Buffer.from(String(paymentHeader), "base64").toString("utf8"));
    const net = p?.accepted?.network ?? p?.network ?? null;
    if (net && net !== caip2) return null;
    const v = p?.payload?.authorization?.value;
    if (!/^[0-9]{1,30}$/.test(String(v ?? ""))) return null;
    const usd = Number(BigInt(String(v))) / 10 ** decimals;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch { return null; }
}

/** The USD this request paid. `basePriceUsd` is the gated price (list or the
 *  request's quote); `caip2` the settling network; `meteredUsd` the upto
 *  meter's settled amount when there is one. */
export function paidPriceUsd({ basePriceUsd, caip2 = null, meteredUsd = null, paymentHeader = null, priceFor = priceForNetwork } = {}) {
  const metered = Number(meteredUsd);
  if (Number.isFinite(metered) && metered > 0) return metered;
  const base = Number(basePriceUsd);
  const signed = signedEvmAmountUsd(paymentHeader, caip2);
  if (signed !== null) return signed;
  if (!caip2 || !(base > 0)) return Number.isFinite(base) ? base : 0;
  const priced = num(priceFor(usdString(base), caip2));
  return Number.isFinite(priced) && priced > 0 ? priced : base;
}

/** The network a payment header pays on (v2 `accepted.network`, v1
 *  `network`), lowercased, or null. Read after the gate verified the header,
 *  so it is the network the facilitator verified. */
export function paymentHeaderNetwork(paymentHeader) {
  if (typeof paymentHeader !== "string" || !paymentHeader || paymentHeader.length > 65536) return null;
  try {
    const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
    const network = payload?.accepted?.network ?? payload?.network ?? payload?.payload?.network;
    return typeof network === "string" && network ? network.toLowerCase() : null;
  } catch { return null; }
}

/** What a hang-up forgiveness ticket holds: the charge this request would
 *  settle on its own chain (the signed amount on an EVM rail, else the gated
 *  price through that chain's premium and floor), never the list price. */
export function ticketPriceUsd({ basePriceUsd, paymentHeader = null, priceFor = priceForNetwork } = {}) {
  return paidPriceUsd({ basePriceUsd, caip2: paymentHeaderNetwork(paymentHeader), paymentHeader, priceFor });
}

/** The metered quote the buyer saw on `caip2`: the request's quote through the
 *  same chain premium and floor that priced that accept, so a settled amount
 *  is compared against the ceiling that chain actually offered. */
export function quotedOnNetworkUsd(quoteUsd, caip2, priceFor = priceForNetwork) {
  if (quoteUsd == null || quoteUsd === "") return null;
  const q = Number(quoteUsd);
  if (!Number.isFinite(q)) return null;
  if (q <= 0 || !caip2) return q;
  const priced = num(priceFor(usdString(q), caip2));
  return Number.isFinite(priced) && priced > 0 ? priced : q;
}
