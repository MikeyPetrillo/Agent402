// What "routable" actually requires, written once and derived.
//
// Four surfaces used to say "Only sellers with proven on-chain settlement are
// routable" as an absolute. It stopped being one on 2026-09-02, when the
// unproven Solana tier shipped: a seller whose payTo is under the settlement
// floor but whose chain is readable IS routable, after every proven candidate,
// up to a small per-call ceiling, flagged `sellerProof: "unproven"` on the
// receipt. The tier is env-controlled (SOR_SVM_UNPROVEN_MAX_USD), and it is
// LIVE on the default, so a page that types the absolute is wrong today and a
// page that types the exception would be wrong the day the tier is switched
// off. Derive both from the same function the router reads.
import { svmUnprovenAllowanceAtomic } from "./solana-buyer.js";
import { baseUnprovenAllowanceUsd } from "./base-unproven.js";
import { ROUTE_ORDER, routeTiebreakProse } from "./route-order.js";

/** The unproven-tier ceiling in dollars, or 0 when the tier is disabled. */
export function unprovenAllowanceUsd() {
  return Number(svmUnprovenAllowanceAtomic()) / 1e6;
}

function usd(n) {
  return n < 0.01 ? `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}` : `$${n.toFixed(2)}`;
}

/**
 * One sentence about what a seller must prove to be paid by our router.
 * Reads as an absolute only when the exception is actually switched off.
 */
export function routingProofSentence() {
  const sol = unprovenAllowanceUsd();
  const base = baseUnprovenAllowanceUsd();
  const tiers = [];
  if (base > 0) tiers.push(`${usd(base)} a call on Base`);
  if (sol > 0) tiers.push(`${usd(sol)} a call on Solana`);
  if (!tiers.length) return "Sellers are routable on proven on-chain settlement.";
  return `Sellers are routable on proven on-chain settlement, with one exception: a seller with no settlement history yet is tried only after every proven candidate, capped at ${tiers.join(" and ")}, and flagged unproven on the receipt.`;
}

/**
 * How the router orders candidates, written once. The order is the comparator
 * in routeQuery (src/x402-index.js): lexical match score, then crawl health,
 * then distinct payers measured over the last 30 days, then the cheapest known
 * price; a judgment model (src/tool-judge.js) may then pick one candidate from
 * that shortlist or decline them all, and when it is not consulted the
 * shortlist order stands. Pages used to type three different versions of this
 * ("health then price", "health x price", "match, health, price").
 */
export function routerRankingSentence() {
  return `Candidates are shortlisted by ${ROUTE_ORDER[0].prose}, then ordered ${routeTiebreakProse()}; a judgment model can then pick the one that does the job from that shortlist, or decline them all, and when it is not consulted the shortlist order stands.`;
}
