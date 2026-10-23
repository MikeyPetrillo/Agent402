// The Circle Gateway batched option's wire name and what it means for a row,
// dependency-free so the sales ledger, the refund ledger, the proof page and
// the 402 hint can all read it without loading the payment client.
//
// A batched payment is an x402 `exact` payment whose accept names the
// GatewayWalletBatched domain: the buyer signs the same EIP-3009 authorization
// shape, Circle Gateway verifies it and queues it, and the funds are credited
// to the seller's Gateway balance when a batch settles on chain. Nothing moves
// wallet to wallet at settle time, so a row booked under this wire is marked
// as settled off-chain, and its `tx` is Gateway's transaction id, not a chain
// hash.

export const GATEWAY_WIRE = "gateway-batched";
export const GATEWAY_KIND_NAME = "GatewayWalletBatched";
export const SETTLEMENT_PENDING_REASON = "settlement_pending";

/** True for a row booked under the batched wire. */
export function isGatewayWire(wire) {
  return String(wire || "") === GATEWAY_WIRE;
}

/** The settlement kind a row carries: "offchain" for the batched wire, else "onchain". */
export function settlementKindOf(wire) {
  return isGatewayWire(wire) ? "offchain" : "onchain";
}

/** True when a decoded payment payload, or one accept, is the batched kind:
 *  only `accepted.extra.name === "GatewayWalletBatched"` says so. */
export function isGatewayBatchedPayment(payloadOrAccept) {
  const a = payloadOrAccept && typeof payloadOrAccept === "object"
    ? (payloadOrAccept.accepted && typeof payloadOrAccept.accepted === "object" ? payloadOrAccept.accepted : payloadOrAccept)
    : null;
  return !!a && a.extra && typeof a.extra === "object" && a.extra.name === GATEWAY_KIND_NAME;
}

/** The same test on a raw base64 payment header value. */
export function isGatewayBatchedHeader(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return false;
  try { return isGatewayBatchedPayment(JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"))); } catch { return false; }
}

/** The same test on an Express request (the header the paywall settles from). */
export function isGatewayBatchedRequest(req) {
  try { return isGatewayBatchedHeader(req?.header?.("payment-signature") || req?.header?.("x-payment") || null); } catch { return false; }
}

/** Seconds a buyer is asked to wait before resending a payment Gateway is
 *  still settling (the Retry-After on that 402). */
export const PENDING_RETRY_AFTER_SECONDS = 10;

/** What a buyer is told while Gateway has not confirmed a batched payment
 *  (settlement_pending, or a settle answer that never arrived): nothing more
 *  is charged, and the SAME payment
 *  resent after a short wait is served once Gateway reports it settled. Never
 *  a new signature: a second authorization could be a second charge. */
export const SETTLEMENT_PENDING_DETAIL = "Circle Gateway has not confirmed this batched payment yet (it is still settling, or its answer did not arrive), so the answer was withheld. Nothing more is charged for it. Retry the same request with the same payment header after a short wait: once Gateway reports the payment settled, that retry is served without a new charge. Do not sign a new authorization for this request.";

/** What a buyer is told when Gateway reports the batched payment failed:
 *  Gateway charges nothing for a failed transfer, so a fresh one is safe. */
export const SETTLEMENT_FAILED_REASON = "settlement_failed";
export const SETTLEMENT_FAILED_DETAIL = "Circle Gateway reports that this batched payment failed, so Gateway took nothing for it. Sign a fresh authorization to retry.";

/** True for a settle receipt (decoded PAYMENT-RESPONSE) that says Gateway is
 *  still settling the payment: neither served nor refused by the buyer's own
 *  doing, so no breaker counts it against the wallet. */
export function isSettlementPendingReceipt(receipt) {
  return !!receipt && typeof receipt === "object" && receipt.success === false && receipt.errorReason === SETTLEMENT_PENDING_REASON;
}

/** True for the answer to a Circle Gateway batched payment that Gateway is
 *  still settling: the request carried the batched kind AND its receipt says
 *  settlement_pending. (Circle's Arc facilitator answers the same word for a
 *  plain Arc payment, whose resend is refused by its held claim; that answer
 *  is not this one.) */
export function isGatewayPendingAnswer(req, receipt) {
  return isGatewayBatchedRequest(req) && isSettlementPendingReceipt(receipt);
}

/** A settle receipt that says Gateway had not settled the batched payment
 *  inside this server's wait: the answer was withheld, the payment is booked
 *  by its authorization, and the same payment resent later is resolved
 *  against Gateway before anything is verified or settled again. Returns the
 *  402's reason, retry verb and detail, or null. */
export function classifySettlementPending(receipt) {
  if (!isSettlementPendingReceipt(receipt)) return null;
  const network = typeof receipt.network === "string" && receipt.network ? receipt.network : null;
  return { reason: "settlement-pending", retry: "same-payment", network, retryAfterSeconds: PENDING_RETRY_AFTER_SECONDS, detail: SETTLEMENT_PENDING_DETAIL };
}

/** Set on the request (by the Gateway client) when a pending batched payment
 *  was booked in the pending book: from then on that book, not the
 *  settlement claim, guards the authorization (src/settlement-claims.js). */
export const GATEWAY_PENDING_BOOKED = Symbol.for("agent402.gatewayPendingBooked");
