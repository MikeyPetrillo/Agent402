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
import { usdcDomainVerdict, usdcDomainMismatchDetail } from "./evm-usdc-domain.js";

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
  usdc_domain_mismatch: "the seller's USDC accept on this chain advertises an EIP-712 domain name that is not the token's own (Base USDC signs under \"USD Coin\"; Monad, Celo and Sei USDC under \"USDC\"), so a stock x402 buyer - this router included - signs an authorization the facilitator refuses and nothing settles; the seller has to fix the accept before anyone can pay it",
  delivery_failing: "the last time this router paid this seller on this chain the call did not deliver (a 5xx answer carrying no settle receipt, or no answer at all before the timeout), so it is skipped until that memo expires or a call to it succeeds. Settlement history is evidence about the past; this is what happened the last time someone actually paid",
  eligible: "the router will pay this seller on a buyer's behalf",
  local_catalog: "this host's own tool; no external payment is involved",
});
const REASON_PRECEDENCE = ["crawl_failed", "network_unknown", "no_supported_route", "url_template", "price_unknown", "usdc_domain_mismatch", "delivery_failing", "settlement_required"];
// `detail` values a settlement_required verdict can carry beyond the gate's
// own sentence. Documented in the legend under routerDispatchDetail.
export const DISPATCH_DETAILS = Object.freeze({
  evidence_payto_mismatch: "the settlement history this origin inherits belongs to a wallet its own 402 does not ask to be paid at, so it does not count for this origin",
  evidence_payto_unverified: "the settlement history this origin inherits belongs to a specific wallet and the origin's own Base payTo could not be read, so it does not count until the live 402 names that wallet",
});

const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null);

/**
 * SHARED-WALLET EVIDENCE COUNTS ONLY WHERE THE MONEY WOULD GO (2026-09-03).
 *
 * The x402 leaderboard groups origins by payTo: every origin whose registry
 * listing names wallet W sits in W's row and, until now, inherited W's whole
 * settlement count. Naming a wallet is a claim anyone can write into a
 * listing, so a fresh origin could name a heavily-paid third-party wallet,
 * clear the Base floor on that wallet's history, and then serve a live 402
 * that asks to be paid somewhere else. The chain-join belt (provenPayToMatches)
 * could not see it: it only binds an origin whose OWN advertised address was
 * observed settling, and the attacker's own address had no history at all -
 * "unknown", and unknown does not refuse.
 *
 * So: evidence that reached an origin through a shared-wallet row is BOUND
 * to that row's wallets, and counts for the origin only when the address the
 * origin's live 402 asks us to pay is one of them. An origin whose OWN
 * evidence (the committed seed, or the chain join on its own advertised
 * address) already clears the gate keeps today's behavior - nothing about it
 * was inherited. "Unreadable live payTo" is not a match either: the evidence
 * belongs to a specific wallet, and we cannot confirm this origin is paid at
 * it.
 *
 * @param {object} o.evidence   { payTos: Set|Array of wallets the inherited
 *                              evidence belongs to, ownSettled, ownPayers }
 *                              (undefined/null = no binding information: the
 *                              gate result stands as before)
 * @param {string|null} o.livePayTo  the Base address the origin's own 402
 *                              asks to be paid at (live probe at resolve
 *                              time; the crawled advertised address at label
 *                              time); null = unreadable
 */
export function evidencePayToVerdict({ evidence, livePayTo, minSettled = 50, minPayers = 3 } = {}) {
  if (!evidence || typeof evidence !== "object") return { bound: false, ok: true, verdict: "no_binding_information" };
  const own = meetsRouterGate({ settled: Number(evidence.ownSettled || 0), payers: evidence.ownPayers, minSettled, minPayers });
  if (own.ok) return { bound: false, ok: true, verdict: "own_evidence_clears_the_gate" };
  const payTos = [...(evidence.payTos instanceof Set ? evidence.payTos : Array.isArray(evidence.payTos) ? evidence.payTos : [])].map(evmKey).filter(Boolean);
  const live = evmKey(livePayTo);
  if (!live) return { bound: true, ok: false, verdict: "evidence_payto_unverified", payTos };
  if (!payTos.includes(live)) return { bound: true, ok: false, verdict: "evidence_payto_mismatch", payTos, livePayTo: live };
  return { bound: true, ok: true, verdict: "evidence_payto_match", payTos, livePayTo: live };
}

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
 * @param {object} [o.evidence]       shared-wallet binding for the origin (see evidencePayToVerdict); omit = no binding
 * @param {string|null} [o.livePayTo] the Base address the origin's 402 asks to be paid at, when known
 * @param {object|null} [o.usdcDomain] what the origin's Base USDC accept advertises ({asset, name}, the index's
 *                                     evmDomainByNetwork["eip155:8453"] or the live accept); null/omit = unobserved
 * @param {object|null} [o.deliveryFailing] per spending chain, what happened the last time THIS router paid this
 *                                     seller there and the call did not deliver ({ base: {at, status, ms} }).
 *                                     A chain named here is not eligible whatever its settlement history says,
 *                                     because history is about the past and this is about the last real payment.
 *                                     Omit/null = nothing recorded (the ordinary case).
 */
export function dispatchEligibility({ routable, networks = [], settled = 0, payers, priceUsd, urlTemplate = false, spendChains = ["base"], minSettled = 50, minPayers = 3, local = false, evidence, livePayTo = null, usdcDomain = null, deliveryFailing = null } = {}) {
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
    // What happened the last time we actually paid this seller on this chain
    // outranks every static signal: a seller whose paid calls 5xx keeps its
    // settlement history, its health score and its Bazaar counts, and all
    // three are true and all three are about a service that no longer
    // delivers. Checked before the settlement gate on Base and before the
    // pay-time verdict on every other chain, so no path can label it callable.
    const failing = deliveryFailing && typeof deliveryFailing === "object" ? deliveryFailing[c] : null;
    // THE VERDICT IS PUBLIC, THE EVIDENCE IS NOT (the operator, 2026-09-11).
    // `delivery_failing` is a statement about what WE will do - the same
    // category as settlement_required, and the same thing every other row on
    // these pages publishes. The DETAIL behind it (they answered HTTP 500
    // after 120 seconds) is a specific adverse claim about a named third
    // party, which is a category nothing else we publish is in. It reads back
    // through the operator surface instead: /__operator/router-delivery.json.
    // So the input carries the observation, and the output never echoes it.
    if (failing) { byChain[c] = { eligible: false, reason: "delivery_failing" }; continue; }
    if (c === "base") {
      // A Base accept advertising the wrong EIP-712 domain name is unpayable by
      // every stock buyer, whatever its history says (the history predates the
      // change, or belongs to a wallet paid over another path): refuse before
      // the settlement gate, and say which name the token actually signs under.
      // Only a POSITIVE mismatch on the chain's own USDC contract refuses;
      // unobserved, another asset or no name is unknown and decides nothing.
      const domain = usdcDomain ? usdcDomainVerdict(usdcDomain, "eip155:8453") : { verdict: "unknown" };
      if (domain.verdict === "wrong_domain") { byChain[c] = { eligible: false, reason: "usdc_domain_mismatch", detail: usdcDomainMismatchDetail(domain), advertisedName: domain.advertisedName, expectedName: domain.expectedName }; continue; }
      const gate = meetsRouterGate({ settled: basis.settled, payers, minSettled, minPayers });
      byChain[c] = gate.ok ? { eligible: true, reason: "eligible" } : { eligible: false, reason: "settlement_required", detail: gate.reason };
      // Inherited (shared-wallet) evidence counts only where the money goes:
      // a gate cleared on a wallet's history needs the origin's own 402 to
      // pay THAT wallet. Own evidence clearing the gate skips this entirely.
      if (gate.ok && evidence !== undefined && evidence !== null) {
        const v = evidencePayToVerdict({ evidence, livePayTo, minSettled, minPayers });
        if (v.bound && !v.ok) byChain[c] = { eligible: false, reason: "settlement_required", detail: v.verdict };
      }
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
    evmDomainByNetwork: "the EIP-712 domain (asset + extra.name) each of the seller's EVM accepts advertised on its 402; the router label refuses a Base accept whose name is not the token's own (usdc_domain_mismatch) because no stock x402 signature under it can verify.",
    routerDispatchDetail: { ...DISPATCH_DETAILS, _note: "settlement_required may carry one of these in routerDispatchByChain.base.detail beside the gate's own sentence; settlement history inherited through a shared payTo counts for an origin only when the origin's own 402 pays that wallet, which the router checks live before it signs" },
    executeVia: "present only on a row the router will pay right now: the route-execute tier (and price) that runs it. Its absence on a priced row is deliberate.",
    executeViaWhenEligible: "the route-execute tier this row WOULD run under once its seller is dispatch-eligible; not callable through the router today.",
    executeViaCallableNow: "true on rows carrying executeVia, false on rows carrying executeViaWhenEligible. A buyer agent should key on this, never on the presence of a tier name.",
    "routerDispatchReason.delivery_failing": "this host paid this seller on this chain and the call did not deliver, so we stopped routing to them until the memo expires or a call succeeds. The verdict is published because it is a statement about what WE do; the underlying observation (the status they answered, how long it took) is deliberately NOT published, because that is a specific adverse claim about a named third party and every other figure on these pages is a count or a gate verdict. A seller who wants to know what we saw can ask us.",
  };
}
