// When a buyer is owed money and how it is repaid: the sentences /terms
// prints (src/terms.js renders each clause's `text` from here) and the
// machine-readable copy the conformance document publishes
// (src/conformance.js refundTerms). One source, so the two cannot drift;
// scripts/test-conformance.js checks every clause renders on /terms word for
// word, and scripts/test-legal-dates.js pins this file with the terms page.
//
// Each clause carries the facts its sentence states as fields, and nothing
// the sentence does not state.
import { SETTLE_FIRST_SENTENCE } from "./settle-first-copy.js";

/** The chain families a repayment is sent on, in the order /terms names them.
 *  Each key is a family scripts/refund-run.js familyOf() sends on. */
export const REPAYMENT_FAMILIES = Object.freeze([
  ["evm", "the EVM chains"],
  ["tempo", "Tempo"],
  ["solana", "Solana"],
  ["stellar", "Stellar"],
  ["algorand", "Algorand"],
]);

/** The families whose repayment is itself confirmed on chain before it is
 *  recorded as paid (scripts/refund-run.js proves these outbound). */
export const OUTBOUND_PROOF_FAMILIES = Object.freeze(["tempo", "solana"]);

/** The families a payment that lands after an error answer is followed on
 *  (src/late-settlements.js on EVM, Solana and Algorand; the Tempo late watch). */
export const LATE_LANDING_FAMILIES = Object.freeze(["evm", "solana", "algorand", "tempo"]);

const names = (keys) => keys.map((k) => REPAYMENT_FAMILIES.find(([f]) => f === k)[1]);
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs.join(""));

/**
 * The clauses, in the order /terms prints them. `gatewayBatched`: the Circle
 * Gateway batched option is offered (src/gateway-nanopayments.js
 * gatewayOfferPublic), which adds its clause and scopes the repayment proof.
 */
export function refundClauses({ gatewayBatched = false } = {}) {
  const clauses = [
    {
      id: "settle-after-success",
      section: "Payments",
      text: `An x402 payment on our own routes settles only after your call returns a successful response; if the call returns an error, the payment is not settled and you are not charged. ${SETTLE_FIRST_SENTENCE}`,
      appliesTo: ["x402"],
      chargedOnError: false,
      owed: false,
    },
    {
      id: "final-before-call",
      section: "Payments",
      text: "Some payments are final before the call runs, such as an MPP payment sent as a Tempo transfer; if that call then fails, or if your connection closes after a payment has settled and before the response is delivered, we record the amount as owed back to the paying wallet, and repay it as described under refunds below.",
      appliesTo: ["mpp-tempo-push", "connection-closed-after-settlement"],
      owed: true,
      repaidTo: "paying-wallet",
    },
    {
      id: "late-landing",
      section: "Payments",
      text: "If an x402 payment on an EVM chain, Solana or Algorand whose failed settlement named its transaction, or a Tempo transaction, lands on chain after we answered the call with an error, we record the amount as owed back to the paying wallet and repay it the same way.",
      appliesTo: LATE_LANDING_FAMILIES.slice(),
      owed: true,
      repaidTo: "paying-wallet",
    },
    {
      id: "unconfirmed-eip3009",
      section: "Payments",
      text: "If an x402 payment signed as an EIP-3009 authorization on an EVM chain is answered settlement-unconfirmed (its settlement ended without showing whether the transfer was sent), that answer says when the payment was recorded for an on-chain check (it says so only then); when it was and its transfer then lands on chain, we record the amount as owed back to the paying wallet and repay it the same way.",
      appliesTo: ["x402-evm-eip3009-unconfirmed"],
      owed: true,
      repaidTo: "paying-wallet",
    },
    {
      id: "owed-not-served",
      section: "Payments",
      text: "A payment whose transfer is owed back this way is not used for a call: if the same payment is sent again, or an attempt with it settles that same transfer, the call is not served for it, the answer names the transfer and says it is owed, and the amount stays owed to the paying wallet and is repaid as described under refunds below; a new payment makes the call.",
      appliesTo: ["x402-owed-transfer-resent"],
      owed: true,
      repaidTo: "paying-wallet",
    },
    {
      id: "finality",
      section: "Payments",
      text: "Micropayments are per call and, once settled on-chain, are final and non-refundable except as described in these terms or where required by law.",
      owed: false,
    },
  ];
  if (gatewayBatched) {
    clauses.push({
      id: "gateway-pending",
      section: "Circle Gateway batched payments",
      text: "If Gateway settles one after its request was answered pending and the request is never served, we record the amount as owed and repay it on chain after confirming it in Gateway's records.",
      appliesTo: ["x402-gateway-batched"],
      owed: true,
      repaidTo: "paying-wallet",
    });
  }
  clauses.push(
    {
      id: "ordinary-failure",
      section: "Refunds on-chain",
      text: `Because an x402 payment settles only after a call succeeds, the ordinary failure case costs nothing and needs no refund. ${SETTLE_FIRST_SENTENCE}`.trim(),
      owed: false,
    },
    {
      id: "charged-but-failed",
      section: "Refunds on-chain",
      text: "Where a defect on our side means you were charged for something that did not deliver, we record the amount as owed and repay the wallet that paid, on the chain it paid on.",
      owed: true,
      repaidTo: "paying-wallet",
      repaidOn: "the-chain-it-paid-on",
    },
    {
      id: "repayment-process",
      section: "Refunds on-chain",
      text: `Repayment is not instant: we review the amounts owed and send them in batches, and we check larger amounts by hand before they are sent. Each batch is started and approved by hand, and it sends the repayment on every chain we accept payment on: ${andList(names(REPAYMENT_FAMILIES.map(([f]) => f)))}.`,
      instant: false,
      batched: true,
      startedByHand: true,
      families: REPAYMENT_FAMILIES.map(([f]) => f),
    },
    {
      id: "repayment-proof",
      section: "Refunds on-chain",
      text: `Before a repayment is sent we confirm on that chain that your payment reached us${gatewayBatched ? " (for a Circle Gateway batched payment, in Gateway's records)" : ""}; on ${andList(names(OUTBOUND_PROOF_FAMILIES))} we also confirm the repayment itself before recording it as paid.`,
      paymentProvenBeforeSend: true,
      repaymentProvenOn: OUTBOUND_PROOF_FAMILIES.slice(),
    },
    {
      id: "connection-closed-review",
      section: "Refunds on-chain",
      text: "An amount owed because a connection closed is reviewed before it is repaid, and is not repaid when the call's effect outlives the response and was delivered (a memory write, or a purchase we made from another seller for you).",
      reviewedBeforeRepaid: true,
      notRepaidWhenEffectDelivered: true,
    },
    {
      id: "unidentified-payer",
      section: "Refunds on-chain",
      text: "A payment whose paying wallet cannot be identified from its own settlement cannot be repaid.",
      repaid: false,
    },
    {
      id: "sanctions-before-repayment",
      section: "Refunds on-chain",
      text: "Before a repayment is sent we check the receiving address against the published sanctions lists; we do not send to a listed address, and a repayment waits while that check cannot be made.",
      screenedBeforeSend: true,
    },
    {
      id: "rights-by-law",
      section: "Refunds on-chain",
      text: "None of this reduces a right you have by law.",
    },
    {
      id: "card-report",
      section: "By card",
      text: "A report is generated only against a paid, Stripe-verified session, once; if generation fails, the charge is refunded automatically.",
      appliesTo: ["card-checkout"],
      refundedAutomatically: true,
      refundedTo: "the-card",
    },
  );
  return clauses;
}

/** The text of the clause `id` (throws on an unknown id, so a renamed clause
 *  fails the page render in every test that draws /terms). */
export function refundClauseText(id, opts) {
  const c = refundClauses(opts).find((x) => x.id === id);
  if (!c) throw new Error(`unknown refund clause: ${id}`);
  return c.text;
}
