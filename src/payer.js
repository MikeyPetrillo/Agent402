/**
 * Extract the verified payer wallet address from the x402 payment header.
 * The payment middleware has already verified the signature before any
 * route handler runs, so the `from` address here is cryptographically bound
 * to the payment — the wallet IS the account.
 *
 * We read ONLY `payload.payload.authorization.from` — the exact field the
 * EIP-3009 transferWithAuthorization signature the middleware verified covers.
 * Loose fallbacks (top-level `from`, `permit.owner`, etc.) are deliberately
 * NOT accepted: an unsigned field there could attribute a verified payment to a
 * different wallet, letting a caller act under a victim's memory namespace.
 */
// EVM 0x+40hex (normalized lowercase), Solana base58 (case-sensitive),
// Stellar G+55 base32, Algorand base32 (58 chars, case-sensitive) — anything
// else is not a wallet we can attribute.
export function normalizePayerAddress(from) {
  if (typeof from !== "string" || !from) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(from)) return from.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(from)) return from; // Solana base58
  if (/^G[A-Z2-7]{55}$/.test(from)) return from; // Stellar ed25519 public key
  if (/^[A-Z2-7]{58}$/.test(from)) return from; // Algorand ed25519 public key — NEVER lowercase
  return null;
}

/**
 * Fallback attribution from the facilitator's settle receipt: the x402 v2
 * SettleResponse carries `payer` — the wallet the facilitator VERIFIED and
 * settled from — on every chain, including the SVM and Stellar schemes whose
 * request payloads don't carry an EIP-3009 authorization.from. Telemetry and
 * sales attribution only: memory identity keeps payerFromRequest, whose
 * signature binding is what the namespace security model relies on.
 */
export function payerFromPaymentResponse(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const receipt = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
    return normalizePayerAddress(receipt?.payer);
  } catch {
    return null;
  }
}

/**
 * The payment header the MIDDLEWARE will actually settle from.
 *
 * This ordering is a security boundary, not a style choice. @x402/express
 * resolves `payment-signature` FIRST and falls back to `x-payment`
 * (node_modules/@x402/express/dist/esm/index.mjs), and @x402/core puts
 * `PAYMENT-SIGNATURE` on the wire. Reading them in the opposite order lets a
 * request that carries BOTH be settled from one header and attributed from the
 * other — and the second copy is never signature-checked by anything.
 *
 * Concretely, the inverted order allowed: pay with your own valid
 * PAYMENT-SIGNATURE, add `X-Payment: base64({"payload":{"authorization":
 * {"from":"<victim>"}}})`, and every consumer of payerFromRequest believes the
 * victim paid. Memory namespaces are wallet-keyed ("payment = identity"), so
 * that was a namespace takeover for the price of one call, plus poisoned
 * revenue attribution and refund-ledger rows.
 *
 * Every consumer MUST use this helper. The first sweep fixed three modules and
 * asserted "all three" in this comment — there were FIVE decoding sites, and
 * the two it missed were the worst ones: route-execute's buyerPaymentNetwork
 * decodes the header to choose which chain we spend FROM, so an unsigned
 * x-payment could name a hot wallet that had nothing to do with the payment.
 * Counting the call sites before claiming completeness is the lesson.
 */
export function paymentHeaderOf(req) {
  try {
    return (req?.header?.("payment-signature") || req?.header?.("x-payment")) || null;
  } catch { return null; }
}

export function payerFromRequest(req) {
  // Read exactly what the middleware settles from — see paymentHeaderOf().
  const header = paymentHeaderOf(req);
  if (!header) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const from = payload?.payload?.authorization?.from || null;
    if (typeof from !== "string") return null;
    // EVM ONLY, deliberately: this `from` is covered by the EIP-3009 signature
    // the facilitator verifies before settlement, so it can carry memory
    // identity. Non-EVM schemes (AVM/SVM/Stellar) don't sign an
    // authorization.from — accepting one here would let a buyer mint a
    // signature-free namespace. Their attribution path is
    // payerFromPaymentResponse (the facilitator-verified settle receipt).
    if (/^0x[0-9a-fA-F]{40}$/.test(from)) return from.toLowerCase();
    return null;
  } catch {
    return null;
  }
}
