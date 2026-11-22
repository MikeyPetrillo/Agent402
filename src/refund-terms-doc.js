// The refund terms document (/.well-known/agent402-refund-terms.json): what
// this server does with a buyer's money when a paid call does not deliver,
// per rail, as data a buyer's agent reads before it pays.
//
// Nothing here is typed as a table of claims. Every field is read from the
// module that runs the behavior:
//   - per rail: the settleAfterAnswer, hangupForgiveness and
//     refundOnChargedFailure cells of the conformance rows (src/conformance.js
//     conformanceRails), which are computed from the mounted gates and their
//     switches; `chargedOnErrorAnswer` is derived from settleAfterAnswer;
//   - hang-up forgiveness: hangupForgivenessConfig() (HANGUP_FORGIVE) and the
//     routes it never forgives (src/lasting-effect-slugs.js);
//   - the refund ledger: the families the refund run sends on, the families
//     whose repayment is itself proven, the late-landing watches
//     (src/refund-terms.js, which scripts/test-conformance.js holds to
//     scripts/refund-run.js);
//   - credits: the debit-on-200 rule and the refund route, offered only while
//     CREDITS_SALES is on (the route answers only then, src/server.js);
//   - card reports: the automatic refund on a failed generation, while card
//     checkout is on (humanCheckoutEnabled);
//   - the clauses: the sentences /terms prints (refundClauses).
// No budget size, cap, rate or balance is published: the rules say whether
// and how, never how much this server can absorb.
// scripts/test-refund-terms-doc.js flips each switch and checks the field
// moves with it, and holds the families to the refund run's own sender.
import { REFUND_TERMS_PATH } from "./refund-terms-path.js";
import { conformanceRails, repaymentFamilyOf, CONFORMANCE_PATH } from "./conformance.js";
import { refundClauses, REPAYMENT_FAMILIES, OUTBOUND_PROOF_FAMILIES, LATE_LANDING_FAMILIES } from "./refund-terms.js";
import { hangupForgivenessConfig, LASTING_EFFECT_SLUG_LIST } from "./hangup-forgiveness.js";
import { creditsSalesEnabled, TERMS_VERSION } from "./credits-sales.js";
import { humanCheckoutEnabled } from "./human-checkout.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
import { OWED_REPAID } from "./tempo-push-debts.js";

export { REFUND_TERMS_PATH };
export const REFUND_TERMS_VERSION = 1;

/** true (taken before the route runs), false (an error answer is left unsettled), null (nothing is charged on this rail),
 *  from a row's settleAfterAnswer cell. */
function chargedOnErrorAnswer(cell) {
  if (!cell || cell.supported === null) return null;
  return cell.supported !== true;
}

/** One rail's money rules, from its conformance row. */
export function refundRailRow(r) {
  const f = r.features;
  return {
    id: r.id,
    protocol: r.protocol,
    network: r.network,
    offered: r.offered,
    chargedOnErrorAnswer: chargedOnErrorAnswer(f.settleAfterAnswer),
    repaymentFamily: r.network ? repaymentFamilyOf(r.network) : null,
    settleAfterAnswer: f.settleAfterAnswer,
    hangupForgiveness: f.hangupForgiveness,
    refundOnChargedFailure: f.refundOnChargedFailure,
  };
}

export function refundTermsFullDocument(baseUrl = "", { freeMode = false, rails = conformanceRails() } = {}) {
  const hang = hangupForgivenessConfig();
  const gatewayBatched = !!gatewayOfferPublic();
  const credits = rails.find((r) => r.id === "credits");
  const checkout = rails.find((r) => r.id === "card:checkout");
  const onSale = creditsSalesEnabled();
  return {
    document: "agent402-refund-terms",
    version: REFUND_TERMS_VERSION,
    url: `${baseUrl}${REFUND_TERMS_PATH}`,
    generatedAt: new Date().toISOString(),
    freeMode: !!freeMode,
    terms: `${baseUrl}/terms`,
    termsVersion: TERMS_VERSION,
    governs: "The terms of service govern; this document states the same rules as data, computed from the serving code.",
    conformance: `${baseUrl}${CONFORMANCE_PATH}`,
    legend: {
      chargedOnErrorAnswer: "false: an answer of 400 or above is not charged on this rail (x402, MPP evm, a Tempo pull, a card capture, credits). Some calls are paid before they run; a failed one can be retried free with the same payment, or is refunded. true: the payment is taken before the route runs (a Tempo push transfer, a card checkout), so a failed call is repaid as refundOnChargedFailure says; null: nothing is charged on this rail",
      offered: "true while this server accepts payment on the rail",
    },
    rules: {
      x402Ordering: {
        settlesOnlyBelow: 400,
        note: "The x402 paywall runs the route first and settles only an answer below 400; any other answer cancels settlement, so the buyer is not charged.",
      },
      hangupForgiveness: {
        enabled: hang.enabled,
        budgeted: true,
        note: hang.enabled
          ? `On x402, MPP evm, a Tempo pull, a card capture and credits, a buyer whose connection closes before the first answer byte is not charged, within a per-wallet, per-address and service-wide budget; past the budget the charge stands and the undelivered answer is recorded as owed and reviewed before it is repaid: after on-chain proof, or, for a card capture or a credits debit, by hand (a refund to the card, or re-crediting the key). A Tempo push transfer is final before the call, so its undelivered answer is ${OWED_REPAID}.`
          : `Off on this server: a charge whose answer was not delivered is ${OWED_REPAID}, as the refund ledger below says.`,
        neverForgivenSlugs: LASTING_EFFECT_SLUG_LIST.slice(),
        neverForgivenAlso: "any route that spends this server's own wallet or buys from an outside seller: its effect outlives the answer, so it is settled and, when the answer was not delivered, reviewed before any repayment",
      },
      refundLedger: {
        recordsOwedOn: ["charged-but-failed", "connection-closed-after-settlement", "late-landing", "final-before-call"],
        repaidTo: "paying-wallet",
        repaidOn: "the-chain-it-paid-on",
        repaymentFamilies: REPAYMENT_FAMILIES.map(([f]) => f),
        paymentProvenOnChainBeforeSend: true,
        repaymentProvenOn: OUTBOUND_PROOF_FAMILIES.slice(),
        lateLandingWatchedOn: LATE_LANDING_FAMILIES.slice(),
        screenedBeforeSend: true,
        batched: true,
        startedByHand: true,
        instant: false,
        ...(gatewayBatched ? { gatewayBatched: "a Gateway batched payment settled for a request never served is proven in Gateway's records before it is repaid" } : {}),
        owedWord: { surface: `${baseUrl}/api/gateway-status`, field: "refundsOwed", owed: "owed", note: "reads owed once any debt has waited past a short grace, until it is repaid" },
      },
      credits: {
        offered: !!credits?.offered,
        onSale: onSale,
        debitedOnlyOnFinal200: true,
        holdReleasedOtherwise: true,
        refundOnRequest: onSale
          ? { method: "POST", url: `${baseUrl}/api/credits/refund`, auth: "Authorization: Bearer a402_<key>", returns: "the whole unspent balance to the card that bought the key; the key is disabled" }
          : null,
        ...(onSale ? {} : { note: "Credits are not on sale, so the refund-on-request route is not served; a key already issued is still debited only on a final 200." }),
      },
      cardReport: {
        offered: !!checkout?.offered,
        refundedAutomaticallyOnFailedGeneration: true,
        refundedTo: "the-card",
      },
    },
    rails: rails.map(refundRailRow),
    clauses: refundClauses({ gatewayBatched }),
  };
}

// Built once per window, like the conformance document (the gates are fixed
// once the server listens); src/server.js drops it when the server listens.
export const REFUND_TERMS_CACHE_MS = 60_000;
let cache = null;
export function resetRefundTermsCache() { cache = null; }
export function refundTermsFullDocumentCached(baseUrl = "", { freeMode = false, now = Date.now() } = {}) {
  const key = `${baseUrl}|${!!freeMode}`;
  if (cache && cache.key === key && now - cache.at >= 0 && now - cache.at < REFUND_TERMS_CACHE_MS) return cache.value;
  const value = refundTermsFullDocument(baseUrl, { freeMode });
  cache = { key, at: now, value };
  return value;
}
