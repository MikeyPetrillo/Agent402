// Router dispatch eligibility, labelled: the ONE rule that decides whether the
// Smart Order Router will pay a listed seller on a buyer's behalf, exposed on
// every public row that could otherwise be over-read.
//
// Why (2026-09-02, from an outside public-facts readout a buyer-agent tooling
// founder wrote at our request): our rows carry `routable` (the last crawl of
// the origin succeeded), `health` (recent crawl outcomes), `networks` (chains
// the crawled 402s advertise), Bazaar counts (a third party's 30-day usage)
// and `executeVia` (which route-execute tier covers the price). A buyer agent
// reads those together as "Agent402 can pay this seller now", which is a
// different claim that only settlement history and a spend wallet on one of
// the seller's chains can make. Measured on the public snapshot that day: 84
// sellers routable with no networks, 946 with networks and health 1 but
// routable false, 816 routable with no visible settlement count, and route
// rows carrying executeVia with no networks in the row. A seller had already
// emailed us confused by exactly this ("listed, routable, healthy" read as
// "ready to be paid").
//
// So: one function, used by the resolver's Base gate AND by the /api/index,
// /api/route and /marketplace projections, so the label can never drift from
// the decision. Five states, in the readout's own hierarchy:
//   listed -> crawl ready -> payment networks known -> settlement observed
//   -> router dispatch eligible.
// The output is a boolean plus a reason string, never a bare boolean.
import { meetsRouterGate } from "./settlement-proof.js";

// Network label -> the spending chain that pays it. Kept in lockstep with
// route-execute's EXTERNAL_CHAIN_BY_NETWORK (pinned by test-dispatch-
// eligibility) but defined here so this module stays import-light.
export const SPEND_CHAIN_BY_NETWORK = Object.freeze({
  "eip155:8453": "base",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
  "solana": "solana",
  "solana-mainnet": "solana",
  "solana-mainnet-beta": "solana",
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "algorand",
  "eip155:4217": "tempo",
});

// Reason vocabulary. Order = precedence when a seller fails on every chain:
// the earliest reason is the one that has to be fixed first.
export const DISPATCH_REASONS = Object.freeze({
  crawl_failed: "the last crawl of this origin did not succeed, so nothing is routed to it",
  network_unknown: "the crawl learned no payment network (the paid route answered something other than a 402 to the unpaid probe), so the router cannot tell which chain to pay on",
  no_supported_route: "the seller advertises no chain this host holds a spending wallet for",
  settlement_required: "on Base the router pays only sellers with on-chain settlement history above the floor from enough distinct payers",
  settlement_checked_at_pay_time: "on this chain proven-ness is read from the chain at pay time (recent inbound USDC to the seller's own payTo); a thin history may still be tried under the small unproven allowance",
  price_unknown: "no seller price is known for this route, and the router never spends against an unknown price",
  url_template: "the route is an unsubstituted path template; the router never spends against it",
  eligible: "the router will pay this seller on a buyer's behalf",
  local_catalog: "this host's own tool; no external payment is involved",
});
const REASON_PRECEDENCE = ["crawl_failed", "network_unknown", "no_supported_route", "url_template", "price_unknown", "settlement_required"];

/** The spending chains a seller's advertised networks map to (deduped, ordered by first appearance). */
export function spendChainsOf(networks = []) {
  const out = [];
  for (const n of Array.isArray(networks) ? networks : []) {
    const c = SPEND_CHAIN_BY_NETWORK[String(n || "").toLowerCase()] || SPEND_CHAIN_BY_NETWORK[String(n || "")];
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Decide, per spending chain and overall.
 *
 * @param {object} o
 * @param {boolean} o.routable        the last crawl of the origin succeeded
 * @param {string[]} o.networks       chains the seller's 402s advertise (CAIP-2 or bare labels)
 * @param {number} o.settled          settled calls observed for the origin (Base evidence)
 * @param {number|undefined} o.payers distinct payers observed (undefined = no breadth evidence)
 * @param {number|null} [o.priceUsd]  row-level: the known price, null/0 = unknown
 * @param {boolean} [o.urlTemplate]   row-level: an unsubstituted path template
 * @param {string[]} o.spendChains    chains THIS host holds a spending wallet for
 * @param {number} o.minSettled, o.minPayers  the Base gate's floors
 * @param {boolean} [o.local]         this host's own catalog row
 */
export function dispatchEligibility({ routable, networks = [], settled = 0, payers, priceUsd, urlTemplate = false, spendChains = ["base"], minSettled = 50, minPayers = 3, local = false } = {}) {
  if (local) return { eligible: true, reason: "local_catalog", chains: {} };
  const byChain = {};
  const advertised = spendChainsOf(networks);
  const have = advertised.filter((c) => spendChains.includes(c));
  const basis = { settled: Number(settled || 0), ...(payers !== undefined && payers !== null ? { payers: Number(payers) } : {}), minSettled, minPayers };
  if (!routable) {
    for (const c of have) byChain[c] = { eligible: false, reason: "crawl_failed" };
    return { eligible: false, reason: "crawl_failed", chains: byChain, basis };
  }
  if (!advertised.length && !(Array.isArray(networks) && networks.length)) {
    return { eligible: false, reason: "network_unknown", chains: byChain, basis };
  }
  if (!have.length) {
    return { eligible: false, reason: "no_supported_route", chains: byChain, basis };
  }
  const rowBlock = urlTemplate ? "url_template" : (priceUsd !== undefined && !(Number(priceUsd) > 0) ? "price_unknown" : null);
  for (const c of have) {
    if (rowBlock) { byChain[c] = { eligible: false, reason: rowBlock }; continue; }
    if (c === "base") {
      const gate = meetsRouterGate({ settled: basis.settled, payers, minSettled, minPayers });
      byChain[c] = gate.ok ? { eligible: true, reason: "eligible" } : { eligible: false, reason: "settlement_required", detail: gate.reason };
    } else {
      // solana / algorand / tempo: the router TRIES these; proven-ness is a
      // chain read at pay time, which a static row cannot pre-decide.
      byChain[c] = { eligible: true, reason: "settlement_checked_at_pay_time" };
    }
  }
  const firstEligible = have.find((c) => byChain[c]?.eligible);
  if (firstEligible) return { eligible: true, reason: byChain[firstEligible].reason, chain: firstEligible, chains: byChain, basis };
  const reasons = have.map((c) => byChain[c]?.reason).filter(Boolean);
  const reason = REASON_PRECEDENCE.find((r) => reasons.includes(r)) || reasons[0] || "settlement_required";
  return { eligible: false, reason, chains: byChain, basis };
}

/** The public legend, served beside the fields so a reader never has to guess what `routable` means. */
export function dispatchLegend() {
  return {
    routable: "the last crawl of this origin succeeded (manifest, OpenAPI or a live 402 was read). It is crawl readiness, never a promise that the router will pay the seller.",
    health: "a score from the last crawl outcomes of this origin; 1 = every recent crawl succeeded.",
    networks: "chains the seller's own 402 challenges advertise; empty means the crawl could not learn any.",
    paymentNetworksKnown: "true when at least one payment network was learned from the seller's 402s.",
    networksInferred: "present and true on a route row that observed no accepts of its own and inherited the chains its seller advertises elsewhere (other routes, or the Bazaar's settled view); the router still pins the chain from the live 402 before it signs.",
    routerDispatchEligible: "true when this host's Smart Order Router will pay the seller on a buyer's behalf right now on at least one chain it holds a spending wallet for.",
    routerDispatchReason: DISPATCH_REASONS,
    executeVia: "present only on a row the router will pay right now: the route-execute tier (and price) that runs it. Its absence on a priced row is deliberate.",
    executeViaWhenEligible: "the route-execute tier this row WOULD run under once its seller is dispatch-eligible; not callable through the router today.",
    executeViaCallableNow: "true on rows carrying executeVia, false on rows carrying executeViaWhenEligible. A buyer agent should key on this, never on the presence of a tier name.",
  };
}
