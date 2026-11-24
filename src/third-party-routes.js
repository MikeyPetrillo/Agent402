// Routes that use a buyer's payment to buy from an outside seller with our
// own wallet (route-execute's tiers, seller-payability, decide-execute, and the
// flight routes, which buy each answer from an outside flight data seller).
//
// Prepaid credits and per-call card payments are spent only on Agent402's own
// services, so these routes are sold for a wallet payment only (x402, or MPP
// on a chain): the credits gate and the Stripe card gate refuse them, and the
// card challenge is never offered on them.
//
// The class is derived, not listed by hand: a route is in it when its
// definition says `paysThirdPartySeller: true`, OR when it spends our own
// wallet before settlement (`spendsOwnWallet: true`) and is not one of the
// routes whose spend is a cost of our own service (OWN_SERVICE_SPEND_SLUGS:
// attest pays network gas). So a new kit that spends our wallet is wallet-only
// by default. scripts/test-third-party-routes.js derives the kits from their
// imports (every tool kit that reaches src/external-spend-guard.js) and fails
// a definition there that is outside the class without a stated reason.
// Network gas, or a provider whose service we contract and resell as our own
// under a key (the AI gateway), is not this.
export const OWN_SERVICE_SPEND_SLUGS = Object.freeze(new Set(["attest"]));
export function paysThirdParty(def) {
  if (!def || typeof def !== "object") return false;
  if (def.paysThirdPartySeller === true) return true;
  return def.spendsOwnWallet === true && !OWN_SERVICE_SPEND_SLUGS.has(def.slug);
}
