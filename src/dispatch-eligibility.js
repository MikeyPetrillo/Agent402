// Router dispatch eligibility, labelled: the ONE rule that decides whether the
// Smart Order Router will buy from a listed seller, exposed on
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
import { baseUnprovenAllowanceUsd } from "./base-unproven.js";
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
  settlement_required: "on Base the router pays sellers with on-chain settlement history above the floor from enough distinct payers; a seller below it is tried only under the small unproven ceiling when its verdict carries unprovenTier",
  settlement_self_funded: "on Base the router counts only settlement the seller did not fund itself: a payment made with USDC that the wallet it pays had sent the payer earlier is the seller's own money coming home and does not count, and without those payments this seller's history is below the floor; payments made with the payers' own money still count",
  settlement_checked_at_pay_time: "on this chain proven-ness is read from the chain at pay time (recent inbound USDC to the seller's own payTo); a thin history may still be tried under the small unproven allowance",
  price_unknown: "no seller price is known for this route, and the router never spends against an unknown price",
  url_template: "the route is an unsubstituted path template; the router never spends against it",
  gateway_rail_unsupported: "the seller's accept on this chain is signed under Circle Gateway's EIP-712 domain (extra.name \"GatewayWalletBatched\", extra.verifyingContract the GatewayWallet), not under the token's own, and settles through a batch facilitator - a deliberate, working rail that this router's stock x402 signer cannot produce a credential for; nothing for the seller to fix, and it becomes eligible the day the router speaks the rail",
  usdc_domain_mismatch: "the seller's USDC accept on this chain advertises an EIP-712 domain name that is not the token's own (Base USDC signs under \"USD Coin\"; Monad, Celo and Sei USDC under \"USDC\"), so a stock x402 buyer - this router included - signs an authorization the facilitator refuses and nothing settles; the seller has to fix the accept before anyone can pay it",
  delivery_failing: "the last time this router paid this seller on this chain the call did not deliver (a 5xx answer carrying no settle receipt, or no answer at all before the timeout), so it is skipped until that memo expires or a call to it succeeds. Settlement history is evidence about the past; this is what happened the last time someone actually paid",
  eligible: "the router will buy from this seller",
  local_catalog: "this host's own tool; no external payment is involved",
});
const REASON_PRECEDENCE = ["crawl_failed", "network_unknown", "no_supported_route", "url_template", "price_unknown", "usdc_domain_mismatch", "gateway_rail_unsupported", "delivery_failing", "settlement_self_funded", "settlement_required"];
// `detail` values a settlement_required verdict can carry beyond the gate's
// own sentence. Documented in the legend under routerDispatchDetail.
export const DISPATCH_DETAILS = Object.freeze({
  evidence_payto_mismatch: "the settlement history that clears the floor for this origin was measured at a wallet its own 402 does not ask to be paid at; each wallet's history counts only where that wallet is paid, so it does not count for this origin",
  evidence_payto_unverified: "the settlement history that clears the floor for this origin was measured at a specific wallet and the origin's own Base payTo could not be read, so it does not count until the live 402 names that wallet",
  evidence_payto_shared: "the wallet this origin's 402 asks to be paid at is listed by this host as a settlement contract shared by many sellers, so that wallet's own settlement history is credited to none of them; only settlement measured on this origin's own URLs counts toward the floor",
});

const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null);

/**
 * SETTLEMENT EVIDENCE COUNTS ONLY WHERE THE MONEY WOULD GO (2026-09-03), ONE
 * WALLET AT A TIME (2026-09-28).
 *
 * The x402 leaderboard groups origins by payTo: every origin whose registry
 * listing names wallet W sits in W's row and, until 2026-09-03, inherited W's
 * whole settlement count. Naming a wallet is a claim anyone can write into a
 * listing, so a fresh origin could name a heavily-paid third-party wallet,
 * clear the Base floor on that wallet's history, and then serve a live 402
 * that asks to be paid somewhere else.
 *
 * So every figure an origin is credited with is kept against the wallet it
 * was measured at (src/evidence-binding.js), and the gate asks one question of
 * the address the origin's live 402 asks us to pay: does THAT wallet's own
 * evidence clear the floor? The 2026-09-03 form checked the live address
 * against the UNION of the credited wallets beside a MAX of their counts,
 * which let an origin credited with a busy wallet clear the floor and then be
 * paid at any other wallet it had been credited with, however thin that
 * wallet's own history. "Unreadable live payTo" is not a match either.
 *
 * @param {object} o.evidence   { byWallet: Map(wallet -> { settled, payers }) }
 *                              (undefined/null = no binding information: the
 *                              gate result stands as before)
 * @param {string|null} o.livePayTo  the Base address the origin's own 402
 *                              asks to be paid at (live probe at resolve
 *                              time; the crawled advertised address at label
 *                              time); null = unreadable
 * @returns {{ bound, ok, verdict, payTos }} payTos = the wallets whose own evidence clears
 */
export function evidencePayToVerdict({ evidence, livePayTo, minSettled = 50, minPayers = 3 } = {}) {
  if (!evidence || typeof evidence !== "object") return { bound: false, ok: true, verdict: "no_binding_information" };
  // No evidence skips the binding: every figure the gate reads is kept against
  // a wallet (the committed seed, a count with no wallet, stopped counting on
  // 2026-09-28).
  const byWallet = evidence.byWallet instanceof Map ? evidence.byWallet : new Map();
  const payTos = [];
  for (const [w0, v] of byWallet) {
    const w = evmKey(w0);
    if (w && meetsRouterGate({ settled: Number(v?.settled || 0), payers: v?.payers, minSettled, minPayers }).ok) payTos.push(w);
  }
  const live = evmKey(livePayTo);
  if (!live) return { bound: true, ok: false, verdict: "evidence_payto_unverified", payTos };
  if (!payTos.includes(live)) return { bound: true, ok: false, verdict: "evidence_payto_mismatch", payTos, livePayTo: live };
  return { bound: true, ok: true, verdict: "evidence_payto_match", payTos, livePayTo: live };
}

/** Would the history WITHHELD at a listed shared wallet (plus what is credited
 *  there) have cleared the floor? At the live wallet when it is known, else at
 *  the wallet with the largest withheld history. Label wording only: it never
 *  makes anything eligible. */
function sharedHistoryWouldClear({ evidence, livePayTo, minSettled, minPayers }) {
  return heldHistoryWouldClear(evidence?.withheld, { evidence, livePayTo, minSettled, minPayers });
}
/** Would history NOT credited (withheld at a shared wallet, or disregarded as
 *  self-funded) have cleared the floor, merged with what is credited at the
 *  same wallet? At the live wallet when known, else at any such wallet.
 *  Label wording only: it never makes anything eligible. */
function heldHistoryWouldClear(heldSet, { evidence, livePayTo, minSettled, minPayers, liveOnly = false }) {
  const held = heldSet?.byWallet;
  if (!(held instanceof Map) || !held.size) return false;
  const live = evmKey(livePayTo);
  if (liveOnly && !live) return false;
  const candidates = live ? (held.has(live) ? [live] : []) : [...held.keys()];
  for (const w of candidates) {
    const h = held.get(w) || {};
    const own = evidence.byWallet instanceof Map ? evidence.byWallet.get(w) : null;
    const payers = [h.payers, own?.payers].filter((p) => p !== undefined && p !== null).map(Number);
    if (meetsRouterGate({ settled: Math.max(Number(h.settled) || 0, Number(own?.settled) || 0), payers: payers.length ? Math.max(...payers) : undefined, minSettled, minPayers }).ok) return true;
  }
  return false;
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
export function dispatchEligibility({ routable, networks = [], settled = 0, payers, priceUsd, urlTemplate = false, spendChains = ["base"], minSettled = 50, minPayers = 3, local = false, evidence, livePayTo = null, usdcDomain = null, deliveryFailing = null, unprovenMaxUsd = baseUnprovenAllowanceUsd() } = {}) {
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
      // Two different ineligibilities, not one: a name the token does not sign
      // under is the seller's to fix, while Circle's Gateway rail is ours to
      // learn. Both are "we cannot route a payment here today"; only the first
      // is a defect, and a label that conflates them sends a working seller
      // chasing a bug it does not have.
      if (domain.verdict === "gateway_batched") { byChain[c] = { eligible: false, reason: "gateway_rail_unsupported", detail: usdcDomainMismatchDetail(domain), advertisedName: domain.advertisedName, verifyingContract: domain.verifyingContract }; continue; }
      if (domain.verdict === "wrong_domain") { byChain[c] = { eligible: false, reason: "usdc_domain_mismatch", detail: usdcDomainMismatchDetail(domain), advertisedName: domain.advertisedName, expectedName: domain.expectedName }; continue; }
      const gate = meetsRouterGate({ settled: basis.settled, payers, minSettled, minPayers });
      byChain[c] = gate.ok ? { eligible: true, reason: "eligible" } : { eligible: false, reason: "settlement_required", detail: gate.reason };
      // A wallet listed as shared credits nobody with its own history. Say so
      // rather than let "below the settlement floor" read as "never paid", but
      // only when that withheld history would have cleared the floor at the
      // wallet this origin's 402 names (the largest one when unknown).
      if (!gate.ok && sharedHistoryWouldClear({ evidence, livePayTo, minSettled, minPayers })) byChain[c].detail = "evidence_payto_shared";
      // Self-funded payments do not count. When they are what stands between
      // this seller and the floor, the reason says so.
      if (!gate.ok && heldHistoryWouldClear(evidence?.selfFunded, { evidence, livePayTo, minSettled, minPayers })) byChain[c] = { eligible: false, reason: "settlement_self_funded", detail: gate.reason };
      // Evidence counts only where the money goes: a gate cleared on a
      // wallet's history needs the origin's own 402 to pay THAT wallet, and
      // that wallet's own evidence has to clear the floor.
      if (gate.ok && evidence !== undefined && evidence !== null) {
        const v = evidencePayToVerdict({ evidence, livePayTo, minSettled, minPayers });
        if (v.bound && !v.ok) {
          const selfFunded = v.verdict === "evidence_payto_mismatch" && heldHistoryWouldClear(evidence?.selfFunded, { evidence, livePayTo, minSettled, minPayers, liveOnly: true });
          byChain[c] = selfFunded
            ? { eligible: false, reason: "settlement_self_funded", detail: v.verdict }
            : { eligible: false, reason: "settlement_required", detail: v.verdict === "evidence_payto_mismatch" && sharedHistoryWouldClear({ evidence, livePayTo, minSettled, minPayers }) ? "evidence_payto_shared" : v.verdict };
        }
      }
      // UNPROVEN TIER (src/base-unproven.js): below the floor and nothing
      // else wrong, at a price within the ceiling. Still not eligible - the
      // router tries it only after every proven candidate - but the row says
      // it can be tried, so a new seller reads the truth about its listing.
      // A detail naming a wallet problem (shared, mismatched, unverified)
      // is something else wrong, and so is a self-funded history.
      const b = byChain[c];
      if (b.reason === "settlement_required" && !Object.hasOwn(DISPATCH_DETAILS, b.detail || "") && unprovenMaxUsd > 0 && Number(priceUsd) > 0 && Number(priceUsd) <= unprovenMaxUsd) {
        b.unprovenTier = true;
        b.unprovenMaxUsd = unprovenMaxUsd;
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

/**
 * The public legend, served beside the fields so a reader never has to guess what `routable` means.
 *
 * `spendChains` = the chains THIS host holds a spending wallet for. The legend names them because
 * `routerDispatchByChain` is keyed by exactly that set: a chain a seller advertises and this host cannot
 * pay on (Polygon, Arbitrum, X Layer, Nano, ...) is absent from the map, not judged by it. An outside
 * reader measured the index (2026-09-17) and read that absence as the router ignoring four of a
 * seller's five declared chains; the map was right and the legend had never said what its keys were.
 */
export function dispatchLegend({ spendChains = ["base"] } = {}) {
  const chains = Array.isArray(spendChains) && spendChains.length ? spendChains.map(String) : ["base"];
  return {
    routerSpendChains: chains,
    corrections: "every field here is a reading of public data (the seller's own manifest and 402 challenges, and on-chain settlements) taken at the scan time shown, so it can be stale or, where wallets fold to the wrong operator, wrong. A seller who believes a row misreads them can write to mike@agent402.tools and we will re-scan and correct or withdraw it. Listing is free and unreviewed, and so is delisting: an origin that stops serving x402 drops out on its own.",
    routerDispatchByChain: `one entry per chain this host holds a spending wallet for (${chains.join(", ")}) that the seller also advertises, each with the router's verdict there. A chain missing from this map is one this host cannot pay on at all, whatever the seller's networks list says; it is never an eligibility verdict about that chain. A seller advertising only chains outside that set reads routerDispatchReason no_supported_route.`,
    routable: "the last crawl of this origin succeeded (manifest, OpenAPI or a live 402 was read). It is crawl readiness, never a promise that the router will pay the seller.",
    health: "a score from the last crawl outcomes of this origin; 1 = every recent crawl succeeded.",
    networks: "chains the seller's own 402 challenges advertise; empty means the crawl could not learn any.",
    paymentNetworksKnown: "true when at least one payment network was learned from the seller's 402s.",
    networksInferred: "present and true on a route row that observed no accepts of its own and inherited the chains its seller advertises elsewhere (other routes, or the Bazaar's settled view); the router still pins the chain from the live 402 before it signs.",
    routerDispatchEligible: "true when this host's Smart Order Router will buy from the seller right now as a PROVEN seller on at least one chain it holds a spending wallet for. A row that is false here can still be paid through the Base unproven tier, after every proven candidate: such a row carries executeViaCallableNow: true and executeViaLane: \"unproven\".",
    routerDispatchReason: DISPATCH_REASONS,
    "routerDispatchByChain.base.unprovenTier": "present and true on a Base verdict of settlement_required when the floor is the only thing in the way and this route's price is within unprovenMaxUsd: the router may still pay the seller, but only after every proven seller for the task, only at the wallet its own live 402 names, never above that ceiling, and flagged unproven on the buyer's receipt. Absent when the ceiling is switched off.",
    "routerDispatchReason.settlement_self_funded": "measured from the chain by this host: the wallet's own outbound USDC transfers are read beside its inbound payments, in chain order. USDC the wallet sent a payer is set against that payer's later payments to it, first in first out, until it is spent: that much of those payments is self-funded, and a payment at least half covered this way does not count as a settlement. Money a payer sends the wallet that is too large to count as a call pays that back first, and a later transfer returning it covers nothing. A transfer the seller makes to a payer that fits inside that payer's own earlier payments not yet refunded is a refund: the refunded payments, newest first, are not counted at all, neither as settlements nor as self-funded, and only what is left over covers later payments, up to its own amount. Third-party counts of the same wallet include the same payments, so they are reduced by the payments found self-funded and by the payers that paid only with the wallet's own money, over the days those counts cover; where more than half of the dollars a wallet received were self-funded, they are not counted at all.",
    evmDomainByNetwork: "the EIP-712 domain (asset + extra.name) each of the seller's EVM accepts advertised on its 402; the router label refuses a Base accept whose name is not the token's own (usdc_domain_mismatch) because no stock x402 signature under it can verify.",
    routerDispatchDetail: { ...DISPATCH_DETAILS, _note: "settlement_required may carry one of these in routerDispatchByChain.base.detail beside the gate's own sentence; settlement history is kept per wallet and counts for an origin only when the wallet its own 402 asks to be paid at clears the floor on that wallet's own history, which the router checks live before it signs and again on the payment it signs; a wallet this host lists as a settlement contract shared by many sellers credits its own history to none of them" },
    executeVia: "present only on a row the router will pay right now: the route-execute tier (and price) that runs it. Its absence on a priced row is deliberate.",
    executeViaWhenEligible: "the route-execute tier this row WOULD run under once its seller is dispatch-eligible; not callable through the router today.",
    executeViaCallableNow: "true on rows carrying executeVia, false on rows carrying executeViaWhenEligible. A buyer agent should key on this, never on the presence of a tier name. A row in the Base unproven tier is callable now too and carries executeViaLane: \"unproven\" (tried after every proven seller for the task, within routerDispatchByChain.base.unprovenMaxUsd).",
    executeViaLane: "\"unproven\" when the row is dispatched through the Base unproven tier rather than as a proven seller.",
    "routerDispatchReason.delivery_failing": "this host paid this seller on this chain and the call did not deliver, so we stopped routing to them until the memo expires or a call succeeds. The verdict is published because it is a statement about what WE do; the underlying observation (the status they answered, how long it took) is deliberately NOT published, because that is a specific adverse claim about a named third party and every other figure on these pages is a count or a gate verdict. A seller who wants to know what we saw can ask us.",
  };
}
