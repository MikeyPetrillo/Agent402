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
export function payerFromRequest(req) {
  const header = req.header("payment-signature");
  if (!header) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const from = payload?.payload?.authorization?.from || null;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}
