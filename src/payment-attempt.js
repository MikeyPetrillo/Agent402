// Does this request carry a way to pay? An x402 payment (PAYMENT-SIGNATURE or
// X-PAYMENT), an MPP credential (Authorization: Payment ...), a prepaid
// credits key (Authorization: Bearer a402_...) or a proof-of-work solution.
// Shape only: nothing here verifies or spends it.
//
// A payment header has to DECODE to be one: base64 JSON naming a scheme and
// an offered network (x402 v1 top level, v2 under `accepted`; the same read
// as the refusal classifier in src/payment-reject.js), or a Payment
// credential whose JSON carries a challenge and a payload. Bytes that do not
// decode are not a payment attempt, so a junk header buys neither an exemption
// from the unpaid-quote limiters nor an already-paid answer from the gateway
// cache (the two readers of this module); such a request is counted and
// answered as unpaid.
//
// The gateway's pre-paywall cache serves a byte-identical repeat of an
// already-paid call free, but only to a request that carries one of these:
// the repeat's payment is never settled, and an unpaid request (a crawler, a
// discovery validator, anyone) gets the route's 402 instead of someone
// else's paid answer.
import { decodeB64Json } from "./payment-reject.js";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_MAINNET_LEGACY_CAIP2 } from "./avm-network.js";

// CAIP-2: namespace:reference (the legacy Algorand reference ends in "=").
const CAIP2 = /^[a-z0-9]{3,8}:[A-Za-z0-9._=-]{1,64}$/;
let offeredNetworks = null;

/** The x402 network ids this server sells on, registered at boot. Until one
 *  is registered (unit tests, a leaf import) any well-formed id counts. A
 *  network with a second spelling on the wire (the Algorand genesis-hash id
 *  the paywall folds to its CAIP-2 form, src/x402-v1-accepts.js) is
 *  registered under both, so a payment header carrying the other spelling
 *  reads as the attempt it is everywhere this module is consulted. */
export function registerOfferedNetworks(ids) {
  const list = Array.isArray(ids) ? ids.filter((n) => typeof n === "string" && CAIP2.test(n)) : [];
  if (list.includes(ALGORAND_MAINNET_CAIP2)) list.push(ALGORAND_MAINNET_LEGACY_CAIP2);
  offeredNetworks = list.length ? new Set(list) : null;
}

/** The network a decodable x402 payment header names, when it is an offered
 *  one; null for anything else (undecodable, no scheme, no network, a
 *  network this server does not sell on). */
export function x402PaymentNetwork(value) {
  const p = decodeB64Json(value);
  if (!p) return null;
  const scheme = p.scheme ?? p.accepted?.scheme;
  const network = p.network ?? p.accepted?.network;
  if (typeof scheme !== "string" || !scheme || typeof network !== "string" || !CAIP2.test(network)) return null;
  if (offeredNetworks && !offeredNetworks.has(network)) return null;
  return network;
}
export function decodesAsX402Payment(value) {
  return x402PaymentNetwork(value) !== null;
}

/** `Authorization: Payment <base64url JSON>` whose JSON is shaped like an MPP
 *  credential: a challenge object naming its method, and a payload. */
export function decodesAsMppCredential(authorization) {
  const m = /^Payment\s+(\S+)\s*$/i.exec(String(authorization || ""));
  if (!m) return false;
  const c = decodeB64Json(m[1]);
  return !!c && c.challenge && typeof c.challenge === "object" && !Array.isArray(c.challenge)
    && typeof c.challenge.method === "string" && c.challenge.method !== "" && c.payload !== undefined;
}

export function carriesPaymentAttempt(req) {
  const h = (n) => { try { return String(req?.header?.(n) || req?.headers?.[n] || ""); } catch { return ""; } };
  if (decodesAsX402Payment(h("payment-signature")) || decodesAsX402Payment(h("x-payment")) || h("x-pow-solution")) return true;
  const auth = h("authorization");
  return decodesAsMppCredential(auth) || /^Bearer a402_/.test(auth);
}
