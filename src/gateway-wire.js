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

/** A settle receipt that says Gateway had not confirmed the batched payment
 *  inside this server's wait: the answer was withheld and nothing is counted
 *  as charged here. Returns the 402's reason, retry verb and detail, or null. */
export function classifySettlementPending(receipt) {
  if (!receipt || typeof receipt !== "object" || receipt.success !== false) return null;
  if (receipt.errorReason !== SETTLEMENT_PENDING_REASON) return null;
  const network = typeof receipt.network === "string" && receipt.network ? receipt.network : null;
  return {
    reason: "settlement-pending", retry: "fresh-authorization", network,
    detail: "Circle Gateway accepted the batched authorization but had not confirmed it inside this server's wait, so the answer was withheld and no charge is counted for it here. The authorization is booked for reconciliation: if Gateway settles it later, the amount is repaid as an owed refund. Sign a fresh authorization to retry, or pay the same route's plain accept.",
  };
}
