// Routes that use a buyer's payment to buy from an outside seller with our
// own wallet (route-execute's tiers, seller-payability, decide-execute, and the
// flight routes, which buy each answer from an outside flight data seller).
//
// Prepaid credits and per-call card payments are spent only on Agent402's own
// services, so these routes are sold for a wallet payment only (x402, or MPP
// on a chain): the credits gate and the Stripe card gate refuse them, and the
// card challenge is never offered on them. A route opts in with
// `paysThirdPartySeller: true` on its catalog definition. Network gas, or a
// provider whose service we contract and resell as our own under a key (for
// example attest or the AI gateway), is not this.
export function paysThirdParty(def) {
  return !!def && def.paysThirdPartySeller === true;
}
