// The networks a PUBLIC surface names, and the price facts derived from them.
//
// The configured networks (src/payments.js enabledNetworks), minus any gated
// rail that is not in the live offer, and minus Arc unless it is: Arc is
// configured by its key alone and offered only after its facilitator's
// /supported check, so a key without that check never names it. Operator
// views read the full configured list so a dropped rail stays visible there.
//
// Every machine price surface (/api/pricing, openapi x-payment-info,
// llms.txt, the connector's payment.info) reads a chain's settlement premium
// through this module, so on a boot that offers fewer rails they all name
// the same chains: a premium on a chain the boot does not offer is not quoted
// anywhere, and one on an offered chain is quoted everywhere.
import { enabledNetworks, premiumUsdByNetworkName, premiumClause, offeredNetworkNames } from "./payments.js";
import { GATED_RAILS, railKey } from "./rails.js";
import { gatedRailOffered } from "./gated-rails.js";

const GATED_NETWORK_NAMES = new Map([...GATED_RAILS.map((r) => [railKey(r), r.caip2]), ["arc", "eip155:5042"]]);

/** The public network names ("base", "optimism", ...), primary first. Once
 *  the paywall's offer is final, a configured network it dropped (a drop
 *  guard: no facilitator URL, nothing advertises it) is not named either. */
export function publicNetworks(network = process.env.NETWORK || "base") {
  const offered = offeredNetworkNames();
  return enabledNetworks(network).filter((n) => (!GATED_NETWORK_NAMES.has(n) || gatedRailOffered(GATED_NETWORK_NAMES.get(n))) && (!offered || offered.includes(n)));
}

/** The primary network a public surface names (/.well-known/x402
 *  primaryNetwork, /api/pricing payment.network, /api/rails primary): the
 *  configured one while offered, else the first network public surfaces list. */
export function publicPrimaryNetwork(network = process.env.NETWORK || "base") {
  const list = publicNetworks(network);
  return list.includes(network) ? network : (list[0] || network);
}

/** { optimism: 0.001, ... } for the offered chains that carry a premium; {} otherwise. */
export function publicPremiumUsdByNetwork() {
  return premiumUsdByNetworkName(undefined, publicNetworks());
}

/** The premium clause for prose, over the offered chains only; "" when none carries one. */
export function publicPremiumClause() {
  return premiumClause(undefined, publicNetworks());
}
