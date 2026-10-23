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
    // A Permit2 payment is verified on its permit2Authorization, and the
    // facilitator ignores any `authorization` block riding beside it, so that
    // block's `from` is unsigned there. The payer is then the Permit2 signer,
    // and a request naming a different `authorization.from` has no identity.
    const p2 = payload?.payload?.permit2Authorization;
    const plain = payload?.payload?.authorization?.from;
    let from = plain || null;
    if (p2 && typeof p2 === "object") {
      const p2from = typeof p2.from === "string" ? p2.from : null;
      if (!p2from) return null;
      if (typeof plain === "string" && plain.toLowerCase() !== p2from.toLowerCase()) return null;
      from = p2from;
    }
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

/** x402 `payment-identifier` extension id carried by the payment payload
 *  (@x402/extensions: `extensions["payment-identifier"].info.id`, 16-128 chars
 *  of [A-Za-z0-9_-]). Returned raw; callers bind it to the credential exactly
 *  like an Idempotency-Key header (the id alone proves nothing - it is
 *  client-chosen text on an UNVERIFIED payload at the time it is read). */
export function paymentIdentifierOf(req) {
  const header = paymentHeaderOf(req);
  if (!header) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const id = payload?.extensions?.["payment-identifier"]?.info?.id;
    if (typeof id !== "string" || id.length < 16 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    return id;
  } catch { return null; }
}

/** The single-use identity of an EVM x402 payment: the network it settles on,
 *  the signed payer and the authorization nonce the chain consumes once
 *  (EIP-3009 `authorization.nonce`, or the Permit2 nonce on the `upto`
 *  scheme). Read from the same header the middleware settles from and the
 *  same signed `from` payerFromRequest accepts, so two requests with one
 *  identity carry one signed payment. Null for a non-EVM scheme, an unsigned
 *  payer or a payload without a nonce; callers treat null as "no identity".
 *  The idempotency middleware uses it as the implicit key of a re-sent
 *  payment (src/idempotency.js). */
export function paymentNonceIdentityOf(req) {
  const header = paymentHeaderOf(req);
  if (!header) return null;
  const from = payerFromRequest(req);
  if (!from) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const p2 = payload?.payload?.permit2Authorization;
    const nonce = p2 && typeof p2 === "object" ? p2.nonce : payload?.payload?.authorization?.nonce;
    if (typeof nonce !== "string" || !nonce || nonce.length > 128) return null;
    // v2 carries the network on `accepted`; v1 at the top level (see paymentSchemeOf).
    const network = payload?.accepted?.network ?? payload?.network ?? payload?.payload?.network;
    if (typeof network !== "string" || !network) return null;
    return { network: network.toLowerCase(), from, nonce: nonce.toLowerCase() };
  } catch {
    return null;
  }
}

/** The x402 SCHEME the middleware will settle this request under.
 *
 *  Read from the SAME header @x402/express settles from (paymentHeaderOf), and
 *  from the payload itself, which is the field the middleware dispatches on when
 *  it picks a scheme verifier. So this cannot disagree with what is actually
 *  settled: a payload naming `upto` is verified as `upto` (which requires a
 *  Permit2 signature) or it does not verify at all. That is why reading it off
 *  an as-yet-unverified payload is safe HERE, while reading an identity field
 *  the same way would not be - see payerFromRequest.
 *
 *  THE TWO WIRE VERSIONS PUT IT IN DIFFERENT PLACES, and assuming otherwise
 *  cost a live buy. @x402/core's schemas:
 *    v1: PaymentPayloadV1Schema { x402Version, scheme, network, payload }
 *    v2: PaymentPayloadV2Schema { x402Version, resource?, accepted, payload }
 *  There is NO top-level `scheme` on v2 - it lives on `accepted`, which is a
 *  PaymentRequirementsV2. A v1-only reader returns null for every v2 payment,
 *  which is silent: the caller reads "not this scheme" and does nothing. Pinned
 *  against the INSTALLED @x402/core by test-payer-scheme-shape.js, so a future
 *  bump that moves the field fails CI instead of quietly disabling metering.
 *
 *  Returns lowercase, or null when there is no payment header or it will not
 *  parse. Callers must treat null as "not this scheme", never as a default.
 */
export function paymentSchemeOf(req) {
  const header = paymentHeaderOf(req);
  if (!header) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    // v2 first: a v2 payload has no top-level `scheme`, so order costs nothing
    // and reading `accepted` first states which wire is current.
    const scheme = payload?.accepted?.scheme ?? payload?.scheme;
    return typeof scheme === "string" && scheme ? scheme.toLowerCase() : null;
  } catch {
    return null;
  }
}
