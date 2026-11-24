// Why a payment was refused, said out loud.
//
// @x402/express answers every rejected payment with a bare `res.status(402)
// .json({})` - the reason is discarded inside the middleware and never reaches
// us or the buyer. (This server then copies the PAYMENT-REQUIRED offer into
// that body, src/payment-required-body.js, so it carries the offer; it still
// carries no reason unless src/verify-hint.js names one.) Our only hooks (onVerifyFailure / onAfterVerify) fire at the
// FACILITATOR stage, so anything refused before that - a header that will not
// decode, a scheme or chain we do not sell on, an amount under the price, an
// expired authorization, a payload built against different requirements - is
// invisible on both sides of the wire.
//
// Measured 2026-08-29: one client (UA "node") sent a payment header to
// /api/render roughly nine times a minute for twelve hours, ~2,100 attempts,
// and was answered `402 {}` every single time. It could not adapt because we
// never told it anything, and we could not diagnose it because `usdc_failed`
// only counts while `verify_failed` only fires past the facilitator - 99% of
// these never get there. Same dead-end class as the 405s on POST-only tools and
// the silent 413s, and the same remedy the MPP path already has in its RFC 9457
// problem documents: name the fault.
//
// PURE and defensive: it reads only the two headers, never throws, and returns
// null whenever it cannot be sure - a wrong reason is worse than no reason, and
// the facilitator's own hint (src/verify-hint.js) is the better answer whenever
// the payment actually reached it.

/** The retry verbs a 402 body carries while the payment's settlement is not
 *  decided: same-payment (a payment not checked, a Gateway batched payment
 *  still settling: send the same payment again), watch-transaction and
 *  check-wallet (a settlement not confirmed: the transfer may still land).
 *  The one list every writer and reader shares (src/gateway-wire.js,
 *  src/verify-hint.js, src/mcp-x402.js isSettlementUndecided): a payment
 *  answered with one of these is never offered for a new signature. */
export const RETRY_SAME_PAYMENT = "same-payment";
export const RETRY_WATCH_TRANSACTION = "watch-transaction";
export const RETRY_CHECK_WALLET = "check-wallet";
export const UNDECIDED_RETRY_VERBS = Object.freeze([RETRY_SAME_PAYMENT, RETRY_WATCH_TRANSACTION, RETRY_CHECK_WALLET]);

/** Decode a base64(url) JSON header. Null on anything unreadable. Shared
 *  with src/payment-required-body.js, so the 402 body mirror reads the header
 *  with the same decoder the classifier uses. */
export function decodeB64Json(value) {
  try {
    const s = String(value || "").trim();
    if (!s) return null;
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8");
    const out = JSON.parse(json);
    return out && typeof out === "object" ? out : null;
  } catch { return null; }
}

const asBig = (v) => { try { return BigInt(String(v)); } catch { return null; } };
/** Two price fields naming the same whole base-unit amount (a number and its string spelling agree). */
const sameInteger = (a, b) => { const x = asBig(a), y = asBig(b); return x != null && y != null && x === y; };

/** The advertised accepts, from our own PAYMENT-REQUIRED header. */
/**
 * Every refusal class this module can emit, with what it means to the person
 * whose client produced it.
 *
 * Published on /x402-test and pinned by a test that scans THIS FILE for
 * `reason: "..."` literals: a class added to the classifier and not documented
 * here fails CI. The page that teaches developers how to debug against us
 * cannot be allowed to drift from the classifier that answers them.
 */
export const REJECTION_REASONS = Object.freeze([
  { reason: "malformed-header", means: "The PAYMENT-SIGNATURE header is not decodable base64 JSON. Usually a hand-built header, or a base64 variant the decoder did not expect." },
  { reason: "version-mismatch", means: "The payload declares one x402Version and the route serves another. An x402 v1 client against a v2 resource is the common case." },
  { reason: "malformed-payload", means: "It decoded, but names no scheme or network. Copy both verbatim from one accepts entry." },
  { reason: "unsupported-scheme", means: "The scheme is not one this route offers. The refusal names the schemes that are." },
  { reason: "unsupported-network", means: "The network is not one this route offers. The refusal names the networks that are." },
  { reason: "missing-accepted", means: "No echoed `accepted` object. Verification deep-equals what you echo against what was advertised, so it has to be there." },
  { reason: "requirements-mismatch", means: "The echoed accepts entry differs from the advertised one. The refusal names WHICH fields differ, which is usually a client that rebuilt the object instead of echoing it." },
  { reason: "amount-below-price", means: "The authorized amount is under the price this route quoted." },
  { reason: "wrong-recipient", means: "The authorization pays an address this route did not advertise." },
  { reason: "authorization-expired", means: "validBefore has already passed. Signing well ahead of sending, or a clock adrift, will do it." },
  { reason: "insufficient-funds", means: "The facilitator simulated the transfer and the paying wallet holds less of the asset than this route's price. Nothing was charged. Fund the wallet, or pay on another network listed in accepts, then sign a new authorization. `needs` on the 402 carries the network, asset and amount (base units) this call asked for." },
  { reason: "no-token-account", means: "The paying wallet has no account for the asset on that network (no USDC token account on Solana, no trustline on Stellar, not opted in on Algorand), so the transfer could not run in the facilitator's simulation. Nothing was charged. Create the account and fund it (on Solana, receiving USDC creates it) or pay on another network listed in accepts; retry is fund-wallet, `needs` carries the network, asset and amount (base units), and Retry-After says when to try again." },
  { reason: "blockhash-expired", means: "A Solana payment whose transaction names a recent blockhash the cluster no longer holds (a Solana transaction lands only for about 60 to 90 seconds after its blockhash), read when the payment was checked or, after a long call, when it was settled. Nothing was charged. Ask for a fresh 402, build the transaction on a fresh blockhash, sign it and send the request again." },
  { reason: "unclassified", means: "It decoded and still matched nothing, in a way this server has no name for. The refusal lists the field NAMES received so you can compare them yourself, and we would like to hear about it: an unclassified refusal is as likely to be our defect as yours." },
  { reason: "not-checked", means: "The payment never got a verdict: this server's verify request to the facilitator did not complete (a connection error or this server's own time limit), the facilitator answered with an HTTP error, or an on-chain signature check could not finish. Nothing was charged and nothing is known to be wrong with the payment. retry is same-payment: send the same payment again after Retry-After, with no new signature, while its authorization is still valid." },
  { reason: "facilitator-quota", means: "The payment verified and the call ran, then the facilitator for that network refused to settle it under a billing quota on this server's own account. Nothing was charged and nothing is wrong with your wallet. Ask the route for a fresh 402 without paying and pay on another network it lists." },
  { reason: "settlement-unconfirmed", means: "The payment's settlement is not confirmed, so the answer was withheld, and the transfer may still land. Two cases. A facilitator broadcast the transfer and answered that it was still pending, and the transaction listed in `transactions` was not confirmed on chain within this server's wait: retry is watch-transaction, and if it lands the amount is booked as owed to the paying wallet and repaid after on-chain proof. Or a settle attempt ended on an answer that does not show whether a transfer was sent (a facilitator's HTTP error, a dropped connection, an unreadable answer, or a failure naming a transaction): retry is watch-transaction when `transactions` names one and check-wallet when none is named, the receipt's errorReason is settlement_unconfirmed, and the payment's own expiry is named when it carries one: `authorizationValidBefore` is the time after which the signed authorization can no longer move money (an EVM authorization's validBefore, or on Solana a time by which the transaction's recent blockhash has expired), `lastValidRound` an Algorand transaction's lastValid round and `expirationLedger` the ledger a Stellar authorization expires at; a new payment is safe once it has passed. `refundStatusUrl` is the free refund lookup for a named EVM transaction. In that second case the hint says whether the payment is recorded for the on-chain read (an EIP-3009 authorization on an EVM chain, or a transaction named on an EVM chain, Solana or Algorand); only then is a transfer that lands booked as owed. Either way, do not sign a new authorization for the same call before that point, or, when none is named, before the paying wallet shows whether the transfer landed: it is a second payment. The same payment sent again, in any encoding, is answered the same way without the call running." },
  { reason: "settlement-compliance-refused", means: "The payment verified, then the settlement provider's compliance check refused to settle it (a sanctioned, blocked or flagged payer or payee, or a failed AML screen), or this server's own sanctions screening refused it before submitting it. No transfer was made and nothing was charged (`charged: false`), and the payment is not sent to another settlement provider. The receipt's errorReason is settle_compliance_refused." },
  { reason: "settled-refund-owed", means: "The transfer this payment authorized landed on chain after an earlier attempt with the same payment was answered unconfirmed, and it was booked as owed to the paying wallet before this settle answered. The call is not served for that transfer: the amount is repaid after on-chain proof, with nothing more for you to send. `transactions` names the transfer and `refundStatusUrl` shows where the repayment stands; the receipt's errorReason is settled_refund_owed. That authorization is spent, so retry is fresh-authorization: sign a new one to make the call." },
]);

// A verify failure that carries no verdict on the payment. Read from the
// failure's own reason text (src/payments.js recordVerifyFailure: a
// facilitator's code, or our summary of what its client threw), first, so
// that words a facilitator's error body happens to contain ("network",
// "balance") are never read as advice about the buyer's payment.
const NOT_CHECKED_UNVERIFIABLE = /(?:^|[_\s])unverifiable\b|_check_failed\b/i;
const NOT_CHECKED_STATUS = /\bfailed \((\d{3})\)|\bHTTP (\d{3})\b|_http_(\d{3})\b/i;
const NOT_CHECKED_TRANSPORT = /\bfetch failed\b|\btimed out\b|\btimeout\b|\babort(?:ed)?\b|\bnetwork_error\b|socket hang up|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_[A-Z_]{1,40})\b|\bfailed \(0\)/i;
/** Retry-After for a payment that was not checked. */
export const NOT_CHECKED_RETRY_AFTER_SECONDS = 5;

/**
 * The not-checked refusal for a verify failure `reason`, or null when the
 * reason may be a verdict. `chain` is the network's name as the buyer reads
 * it ("" for none). Kinds: a check of ours that could not finish
 * (`*_unverifiable`, `*_check_failed`); the facilitator refusing this
 * server's own credentials (HTTP 401/403); the facilitator answering a 5xx,
 * 408 or 429 (named with that status); and our request not completing (a
 * timeout, a DNS or connection error), read only when the text carries no
 * other 4xx status. Pure.
 */
export function notCheckedRefusal(reason, { chain = "" } = {}) {
  const r = String(typeof reason === "string" ? reason : "").slice(0, 2000);
  if (!r) return null;
  const on = typeof chain === "string" && chain ? ` on ${chain}` : "";
  const again = "Nothing was charged. Send the same payment again in a few seconds; it needs no new signature while its authorization is still valid.";
  const out = (why) => ({ reason: "not-checked", retry: RETRY_SAME_PAYMENT, retryAfterSeconds: NOT_CHECKED_RETRY_AFTER_SECONDS, detail: `${why}, so the payment was not checked. ${again}` });
  if (NOT_CHECKED_UNVERIFIABLE.test(r)) return out(`This server could not finish its own on-chain check of the payment's signature${on}`);
  const m = NOT_CHECKED_STATUS.exec(r);
  const status = m ? Number(m[1] || m[2] || m[3]) : 0;
  if (status === 401 || status === 403) return out(`The facilitator${on} refused this server's own credentials (HTTP ${status})`);
  if (status >= 500 || status === 408 || status === 429) return out(`The facilitator${on} answered HTTP ${status} to this server's verify request`);
  // Any other 4xx is the facilitator's definite answer about the request,
  // which can be a verdict on the payment: transport words inside its body
  // ("request timeout ...") never turn it into a request that did not complete.
  if (status >= 400 && status < 500) return null;
  if (NOT_CHECKED_TRANSPORT.test(r)) return out(`This server's verify request to the facilitator${on} did not complete (a connection error or this server's own time limit)`);
  return null;
}

/** The most transactions an unconfirmed-settlement 402 names. */
export const PENDING_REFUSAL_MAX_TXS = 8;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The 402 a buyer gets when a facilitator answered a settle as still pending
 * with a transaction, and no noted transaction was proven on chain within the
 * receipt wait (src/pending-settle.js). The transfer may still land, so this
 * never says the buyer was not charged: it says the transfer is then owed and
 * repaid after on-chain proof, and names each noted transaction so the buyer
 * can watch it. Null when no transaction hash is given.
 */
export function pendingSettleRefusal({ network = null, transactions = [] } = {}) {
  const txs = [];
  for (const t of Array.isArray(transactions) ? transactions : []) {
    const tx = String(t || "").toLowerCase();
    if (TX_HASH.test(tx) && !txs.includes(tx)) txs.push(tx);
    if (txs.length >= PENDING_REFUSAL_MAX_TXS) break;
  }
  if (!txs.length) return null;
  const net = typeof network === "string" && /^[a-z0-9-]{1,32}:[A-Za-z0-9-]{1,64}$/.test(network) ? network : null;
  const one = txs.length === 1;
  return {
    reason: "settlement-unconfirmed",
    retry: RETRY_WATCH_TRANSACTION,
    network: net,
    transactions: txs,
    detail:
      `The facilitator broadcast this payment's transfer, and ${one ? "its transaction was not" : "none of its transactions was"} confirmed on chain within this server's wait, so the answer was withheld. ` +
      "The transfer may still land. If it does, the amount is booked as owed to the paying wallet and repaid after on-chain proof, with nothing more for you to send. " +
      `Watch the transaction${one ? "" : "s"} listed in transactions${net ? ` on ${net}` : ""}. ` +
      "Signing a new authorization for this call is a new payment; it does not start or speed that repayment.",
  };
}

/** A 402 body with the unconfirmed-settlement explanation merged in: its
 *  reason, retry verb, network, transactions and hint replace any earlier
 *  ones, and no `error` sentence stands ahead of the hint (a rail-quota
 *  explanation of the primary's refusal would say nothing was charged). */
export function withPendingSettleRefusal(body, refusal) {
  if (!refusal || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const { error: _error, reason: _reason, retry: _retry, hint: _hint, network: _network, transactions: _txs, authorizationValidBefore: _vb, lastValidRound: _lvr, expirationLedger: _el, refundStatusUrl: _rs, ...rest } = body;
  return {
    ...rest, reason: refusal.reason, retry: refusal.retry, ...(refusal.network ? { network: refusal.network } : {}),
    ...(Array.isArray(refusal.transactions) ? { transactions: refusal.transactions } : {}),
    ...(refusal.authorizationValidBefore ? { authorizationValidBefore: refusal.authorizationValidBefore } : {}),
    ...(refusal.lastValidRound ? { lastValidRound: refusal.lastValidRound } : {}),
    ...(refusal.expirationLedger ? { expirationLedger: refusal.expirationLedger } : {}),
    ...(refusal.refundStatusUrl ? { refundStatusUrl: refusal.refundStatusUrl } : {}),
    hint: refusal.detail,
  };
}

/** The settle receipt's errorReason once a settle chain ended on an answer
 *  that does not show whether a transfer was sent (src/payments.js
 *  markUnconfirmedStop). Not a billing refusal and not a verdict about the
 *  payment: the settle breaker reads it as not the buyer's
 *  (src/settle-fault.js), and no reader takes it for a refusal made before
 *  sending. */
export const SETTLEMENT_UNCONFIRMED = "settlement_unconfirmed";

/** The errorReason of a settle whose transfer the late-settlement book had
 *  already booked owed (src/settlement-claims.js SETTLED_REFUND_OWED, same
 *  value): charged and owed back, never served, never the buyer's fault
 *  (src/settle-fault.js). */
export const SETTLED_REFUND_OWED = "settled_refund_owed";

/**
 * The 402 body for a settled_refund_owed receipt: the transfer, its refund
 * lookup, and a new authorization to make the call. Never says nothing was
 * charged. Null for any other receipt.
 */
export function settledRefundOwedRefusal(receipt, { origin = null } = {}) {
  if (!receipt || typeof receipt !== "object" || receipt.success !== false || receipt.errorReason !== SETTLED_REFUND_OWED) return null;
  const net = typeof receipt.network === "string" && /^[a-z0-9-]{1,32}:[A-Za-z0-9-]{1,64}$/.test(receipt.network) ? receipt.network : null;
  const tx = railTxOf(net, receipt.transaction);
  const refundStatusUrl = tx ? refundStatusUrlOf(origin, tx) : null;
  return {
    reason: "settled-refund-owed",
    retry: "fresh-authorization",
    network: net,
    ...(tx ? { transactions: [tx] } : {}),
    ...(refundStatusUrl ? { refundStatusUrl } : {}),
    detail:
      "This payment's transfer landed on chain after an earlier attempt with it was answered unconfirmed, and it is booked as owed to the paying wallet, so the call was not served for it. "
      + "The amount is repaid after on-chain proof, with nothing more for you to send"
      + (refundStatusUrl ? "; refundStatusUrl shows where the repayment stands. " : ". ")
      + "That authorization is spent: sign a new one to make the call.",
  };
}

/** The errorReason of a settle ended by a compliance refusal
 *  (src/settle-compliance.js SETTLE_COMPLIANCE_REFUSED, same value). */
export const SETTLE_COMPLIANCE_REFUSED_REASON = "settle_compliance_refused";

/**
 * The 402 body fields for a settle_compliance_refused receipt (decoded
 * PAYMENT-RESPONSE, or its base64 header): refused by the settlement
 * provider's compliance check (or our own sanctions screen, in the receipt's
 * own words), not charged, not sent elsewhere. Null for any other receipt.
 */
export function complianceSettleRefusal(receiptOrHeader) {
  const receipt = typeof receiptOrHeader === "string" ? decodeB64Json(receiptOrHeader) : receiptOrHeader;
  if (!receipt || typeof receipt !== "object" || receipt.success !== false || receipt.errorReason !== SETTLE_COMPLIANCE_REFUSED_REASON) return null;
  const network = typeof receipt.network === "string" && /^[a-z0-9-]{1,32}:[A-Za-z0-9-]{1,64}$/.test(receipt.network) ? receipt.network : null;
  const own = /sanctions screening/.test(String(receipt.errorMessage || ""));
  return {
    reason: "settlement-compliance-refused",
    retry: "do-not-retry",
    charged: false,
    network,
    detail: own
      ? "This server's sanctions screening refused this payment before it was submitted. No transfer was made and nothing was charged, and the payment is not sent to another settlement provider."
      : "The settlement provider's compliance check refused this payment. No transfer was made and nothing was charged, and the payment is not sent to another settlement provider.",
  };
}

/** True for a settle receipt (decoded PAYMENT-RESPONSE) restated as
 *  settlement_unconfirmed: the transfer may still land, so no per-payer
 *  bound counts it against the wallet. */
export function isSettlementUnconfirmedReceipt(receipt) {
  return !!receipt && typeof receipt === "object" && receipt.success === false && receipt.errorReason === SETTLEMENT_UNCONFIRMED;
}

/** An authorization's validBefore (unix seconds) as an ISO time, or null when
 *  it is missing, unreadable or past any date a clock reaches. */
export function validBeforeIso(v) {
  let n;
  const t = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "bigint" ? String(v) : "";
  if (!/^[0-9]{1,20}$/.test(t)) return null;
  try { n = BigInt(t); } catch { return null; }
  if (n <= 0n || n > 10_000_000_000n) return null;
  return new Date(Number(n) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The free refund lookup for one EVM transaction on this server, or null. */
export function refundStatusUrlOf(origin, tx) {
  const o = typeof origin === "string" ? origin.replace(/\/+$/, "") : "";
  return /^https?:\/\/[^\s/?#]+$/.test(o) && typeof tx === "string" && TX_HASH.test(tx) ? `${o}/api/refunds?tx=${tx.toLowerCase()}` : null;
}

/** A transaction id as its rail names it, or null: an EVM hash (0x and 64
 *  hex) and a Stellar hash (64 hex) are case-insensitive and lowercased; a
 *  Solana signature (base58) and an Algorand transaction id (base32) are kept
 *  exactly as written, never case-folded. With no network, only an EVM hash. */
export function railTxOf(network, tx) {
  const t = typeof tx === "string" ? tx.trim() : "";
  if (!t) return null;
  const n = typeof network === "string" ? network : "";
  if (TX_HASH.test(t)) return n && !n.startsWith("eip155:") ? null : t.toLowerCase();
  if (n.startsWith("solana:")) return /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t) ? t : null;
  if (n.startsWith("stellar:")) return /^[0-9a-fA-F]{64}$/.test(t) ? t.toLowerCase() : null;
  if (n.startsWith("algorand:")) return /^[A-Z2-7]{52}$/.test(t) ? t : null;
  return null;
}

/** An Algorand round or Stellar ledger number, or null. */
const roundOf = (v) => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return /^[1-9][0-9]{0,14}$/.test(s) ? Number(s) : null;
};

/**
 * The 402 a buyer gets when the settle chain stopped on an answer that does
 * not show whether a transfer was sent: a fallback's HTTP error, a dropped
 * connection, a time limit, an unreadable answer, a failure naming a
 * transaction (src/payments.js markUnconfirmedStop). The refusal made before
 * sending that opened the chain (a billing quota on this server's account) no
 * longer describes the payment, so this never says nothing was charged and
 * never points at another way to pay. `transactions`: the ones a settle
 * answer named, in the rail's own format (railTxOf). `booked`: the
 * authorization or a named transaction is recorded for the late-settlement
 * read (src/late-settlements.js), the only case in which the owed sentence is
 * said. The payment's own expiry, when it carries one, is named as the point
 * a new payment is safe: `validBefore` (unix seconds: an EIP-3009 or Permit2
 * authorization's, or the time a Solana transaction's recent blockhash has
 * expired by), `lastValidRound` (an Algorand transaction's lastValid round)
 * or `expirationLedger` (the ledger a Stellar payer's signed authorization
 * expires at). With none, the answer makes no time promise: check the paying
 * wallet first. `origin`: this server's public origin, for the refund lookup
 * of a named EVM transaction.
 */
export function unconfirmedSettleRefusal({ network = null, transactions = [], booked = false, validBefore = null, lastValidRound = null, expirationLedger = null, origin = null } = {}) {
  const net = typeof network === "string" && /^[a-z0-9-]{1,32}:[A-Za-z0-9-]{1,64}$/.test(network) ? network : null;
  const txs = [];
  for (const t of Array.isArray(transactions) ? transactions : []) {
    const tx = railTxOf(typeof network === "string" ? network : null, t);
    if (tx && !txs.includes(tx)) txs.push(tx);
    if (txs.length >= PENDING_REFUSAL_MAX_TXS) break;
  }
  const one = txs.length === 1;
  const until = validBeforeIso(validBefore);
  const round = until ? null : roundOf(lastValidRound);
  const ledger = until || round ? null : roundOf(expirationLedger);
  const refundStatusUrl = txs.length ? refundStatusUrlOf(origin, txs[0]) : null;
  const on = net ? ` on ${net}` : "";
  const doNotSign = until
    ? `Do not sign a new authorization for this call before ${until}: until then the signed authorization can still move money, and a second one is a second payment. After that time it can no longer land, and a new payment is safe. `
    : round
      ? `Do not sign a new authorization for this call until ${net || "the network"} has passed round ${round}, the transaction's lastValid round: until then it can still land, and a second one is a second payment. After that round it can no longer land, and a new payment is safe. `
      : ledger
        ? `Do not sign a new authorization for this call until ${net || "the network"} has passed ledger ${ledger}, where the signed authorization expires: until then it can still move money, and a second one is a second payment. After that ledger it can no longer land, and a new payment is safe. `
        : `Check the paying wallet${on} first. Do not sign a new authorization for this call until it shows whether this transfer landed: a second one is a second payment.`;
  const expiry = !!(until || round || ledger);
  return {
    reason: "settlement-unconfirmed",
    retry: txs.length ? RETRY_WATCH_TRANSACTION : RETRY_CHECK_WALLET,
    network: net,
    ...(txs.length ? { transactions: txs } : {}),
    ...(until ? { authorizationValidBefore: until } : {}),
    ...(round ? { lastValidRound: round } : {}),
    ...(ledger ? { expirationLedger: ledger } : {}),
    ...(refundStatusUrl ? { refundStatusUrl } : {}),
    detail:
      "This payment's settlement is not confirmed, so the answer was withheld. "
      + (txs.length
        ? `A settle answer named ${one ? "a transaction" : "transactions"} without showing a completed transfer. `
        : "A settle attempt ended without showing whether the transfer was sent. ")
      + "The transfer may still land. "
      + (booked ? "If it does, the amount is booked as owed to the paying wallet and repaid after on-chain proof, with nothing more for you to send. " : "")
      + doNotSign
      + (txs.length
        ? `${expiry ? "" : " "}Watch the transaction${one ? "" : "s"} listed in transactions${on}${refundStatusUrl ? "; refundStatusUrl shows any repayment recorded for it." : "."}`
        : expiry ? `Check the paying wallet${on} before paying for this call again.` : ""),
  };
}

/** A failed settle receipt restated for a chain that stopped unconfirmed:
 *  payer and network kept, errorReason SETTLEMENT_UNCONFIRMED, the named
 *  transaction (or none). Null when `receipt` is not a failed receipt. */
export function unconfirmedSettleReceipt(receipt, { transaction = null, network = null } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.success !== false) return null;
  const net = typeof receipt.network === "string" && receipt.network ? receipt.network : (typeof network === "string" && network ? network : undefined);
  const tx = railTxOf(net || null, transaction) || "";
  return {
    success: false,
    errorReason: SETTLEMENT_UNCONFIRMED,
    errorMessage: SETTLEMENT_UNCONFIRMED,
    ...(typeof receipt.payer === "string" && receipt.payer ? { payer: receipt.payer } : {}),
    ...(net ? { network: net } : {}),
    transaction: tx,
  };
}

/**
 * A facilitator refusing to SETTLE for a quota or billing reason on OUR
 * account: PayAI's `free_tier_exhausted`, the Algorand facilitator's
 * `subcent_quota_exceeded` (its monthly allowance of sponsored sub-cent
 * settlements for our payTo), a prepaid-credits wall (`insufficient_credits`,
 * or the Celo facilitator's "Out of mainnet settlement funds" when the
 * account balance cannot cover the next settlement), CDP's
 * `payment-method-required` billing gate. Such a refusal says
 * nothing about the buyer's wallet - but the call behind it was served and
 * never charged, so it is NOT free to ignore. ONE definition: payments.js logs
 * with it, the 402 body below names it, and the settle breaker words its 429
 * with it. Only the one refusal whose offer is actually withdrawn from the
 * next 402 (src/avm-sponsorship.js isWithdrawnSubcentRefusal) is kept off a
 * buyer's count; every other billing refusal still counts in both breakers
 * and the composite guard, because their bounds are all that stop it looping.
 */
export const FACILITATOR_BILLING_REFUSAL = /free_tier_exhausted|subcent_quota_exceeded|quota[_ ]exceeded|payment[_ ]required.*credit|insufficient[_ ]credits|payment-method-required|out of (?:mainnet |testnet )?settlement funds/i;
export function isFacilitatorBillingRefusal(text) {
  return FACILITATOR_BILLING_REFUSAL.test(String(text || ""));
}

/** An errorReason that is already a specific verdict about the PAYMENT or the
 *  chain (insufficient_funds, invalid_*, transaction_failed, ..._expired).
 *  Words in its errorMessage - an RPC's "quota exceeded", say - cannot turn
 *  such a verdict into a refusal on our account. Exported so the Algorand
 *  sub-cent gate (src/avm-sponsorship.js) applies the same rule before it
 *  pauses the rail or exempts a refusal. */
const PAYMENT_VERDICT_REASON = /^(insufficient_|invalid_|transaction_)|_expired$/i;
export function isPaymentVerdictReason(reason) {
  return PAYMENT_VERDICT_REASON.test(String(reason || ""));
}

/** A decoded settle receipt (PAYMENT-RESPONSE) that failed on billing grounds:
 *  the errorReason names it, or - only when the reason is generic, as a thrown
 *  non-2xx settle leaves it - the errorMessage does. */
export function isBillingRefusalReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || receipt.success !== false) return false;
  const reason = String(receipt.errorReason || "");
  if (isFacilitatorBillingRefusal(reason)) return true;
  if (isPaymentVerdictReason(reason)) return false;
  return isFacilitatorBillingRefusal(String(receipt.errorMessage || ""));
}

const RAIL_FAMILY_NAMES = { algorand: "Algorand", solana: "Solana", stellar: "Stellar" };

/**
 * The 402 a buyer gets when settlement failed on OUR billing quota, said in
 * their terms. Before this the body was `{}` and the settle breaker then
 * blamed their wallet ("Recent payments from this wallet failed to settle") -
 * measured 2026-09-28: one outside buyer served 175 times, refused 325 times,
 * with nothing wrong on their side. Null for every other settle outcome.
 * A settle refusal carries PAYMENT-RESPONSE and no PAYMENT-REQUIRED header,
 * so the 402 body mirror (src/payment-required-body.js) adds no offer to it.
 */
export function classifySettlementRefusal(paymentResponseHeader) {
  const receipt = decodeB64Json(paymentResponseHeader);
  if (!isBillingRefusalReceipt(receipt)) return null;
  const network = typeof receipt.network === "string" && receipt.network ? receipt.network : null;
  const name = network ? (RAIL_FAMILY_NAMES[network.split(":")[0]] || network) : "this network's";
  return { reason: "facilitator-quota", retry: "other-network", network,
    detail: `The ${name} facilitator refused to settle this payment under a billing quota on this server's account, not because of your wallet. Nothing was charged. Request this route again without payment for its current accepts and pay on another network listed there.` };
}

/** The scheme and network a decoded x402 payment names, as the paywall
 *  matches it: a v2 payment's `accepted` block (the requirement the payer
 *  signed against) when it carries one, else the top level (v1, or a v2
 *  payload with no accepted block). A top-level field beside an accepted
 *  block is never read. Pure. */
export function x402PaymentOffer(payload) {
  if (!payload || typeof payload !== "object") return { scheme: undefined, network: undefined };
  const acc = payload.accepted;
  const signed = Number(payload.x402Version) !== 1 && acc && typeof acc === "object" && !Array.isArray(acc) ? acc : null;
  return signed ? { scheme: signed.scheme, network: signed.network } : { scheme: payload.scheme, network: payload.network };
}

export function advertisedAccepts(paymentRequiredHeader) {
  const env = decodeB64Json(paymentRequiredHeader);
  const accepts = env && Array.isArray(env.accepts) ? env.accepts : [];
  return { accepts, x402Version: env?.x402Version ?? null };
}

/**
 * @returns {{reason:string, detail:string, retry:string}|null}
 */
export function classifyPaymentRejection({ paymentHeader, paymentRequiredHeader, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!paymentHeader) return null;
    const payload = decodeB64Json(paymentHeader);
    if (!payload) {
      return { reason: "malformed-header", retry: "rebuild-payment",
        detail: "The payment header is not decodable base64 JSON. Build it from this 402's PAYMENT-REQUIRED header with an x402 client." };
    }
    const { accepts, x402Version } = advertisedAccepts(paymentRequiredHeader);
    if (!accepts.length) return null; // nothing to compare against - stay quiet

    // A version the payload states and we do not serve is the single most
    // likely cause of a payload that looks fine and matches nothing.
    if (payload.x402Version != null && x402Version != null && Number(payload.x402Version) !== Number(x402Version)) {
      return { reason: "version-mismatch", retry: "upgrade-client",
        detail: `This payment declares x402Version ${payload.x402Version}; this resource serves x402Version ${x402Version}. Upgrade the x402 client.` };
    }

    const { scheme, network } = x402PaymentOffer(payload);
    if (!scheme || !network) {
      return { reason: "malformed-payload", retry: "rebuild-payment",
        detail: "The payment payload names no scheme/network. Copy them verbatim from one accepts entry in PAYMENT-REQUIRED." };
    }
    const schemes = [...new Set(accepts.map((a) => a?.scheme).filter(Boolean))];
    const networks = [...new Set(accepts.map((a) => a?.network).filter(Boolean))];
    if (!schemes.includes(scheme)) {
      return { reason: "unsupported-scheme", retry: "choose-offered-option",
        detail: `Scheme ${JSON.stringify(scheme)} is not offered on this route. Offered: ${schemes.join(", ")}.` };
    }
    if (!networks.includes(network)) {
      return { reason: "unsupported-network", retry: "choose-offered-option",
        detail: `Network ${JSON.stringify(network)} is not offered on this route. Offered: ${networks.join(", ")}.` };
    }

    const match = accepts.find((a) => a?.scheme === scheme && a?.network === network);
    const auth = payload.payload?.authorization;

    if (auth?.validBefore != null) {
      const vb = Number(auth.validBefore);
      if (Number.isFinite(vb) && vb > 0 && vb < nowSec) {
        return { reason: "authorization-expired", retry: "fresh-authorization",
          detail: `The authorization expired at ${new Date(vb * 1000).toISOString()} (now ${new Date(nowSec * 1000).toISOString()}). Sign a new one against a fresh 402.` };
      }
    }
    if (match?.amount != null && auth?.value != null) {
      const want = asBig(match.amount), got = asBig(auth.value);
      if (want != null && got != null && got < want) {
        return { reason: "amount-below-price", retry: "match-quoted-amount",
          detail: `The authorization pays ${got} but this route quotes ${want} on ${network}. Pay the amount in the accepts entry.` };
      }
    }
    if (match?.payTo && auth?.to && String(auth.to).toLowerCase() !== String(match.payTo).toLowerCase()) {
      return { reason: "wrong-recipient", retry: "rebuild-payment",
        detail: `The authorization pays ${auth.to}; this route settles to ${match.payTo}. Use the payTo from the accepts entry.` };
    }
    // x402 v2 matches the requirements the payload ECHOES BACK against the
    // ones the server just advertised. A payload that omits `accepted`
    // entirely therefore matches nothing and is refused before the facilitator
    // is ever asked - silently, because the vendor answers a bare 402. This is
    // the shape the /api/render loop was in on 2026-08-30: every field correct,
    // no `accepted`, 402 forever, and the first version of this classifier said
    // nothing because it only inspected `accepted` when it was present.
    if (!payload.accepted && match) {
      return { reason: "missing-accepted", retry: "rebuild-payment",
        detail: "The payment carries no `accepted` block. x402 matches the requirements a payment echoes back against the ones this route advertised, so a payload without it matches nothing. Copy the chosen accepts entry from this response's PAYMENT-REQUIRED header verbatim into `accepted`." };
    }
    // The payload echoes the requirements it was built against; ours are
    // rebuilt per request, so a stale or hand-made copy matches nothing and the
    // vendor refuses it with no explanation at all.
    if (payload.accepted && match) {
      // The comparison is a UNION of both key sets, not a walk of ours. x402
      // deep-equals the echoed entry against the advertised one, so a payload
      // carrying an EXTRA field its client added is refused just as surely as
      // one with a wrong value - and a one-directional walk of `match`'s keys
      // cannot see that, which is why this classifier stayed silent on a live
      // client for its first two revisions. Reproduced against prod: an
      // `accepted` with one surplus key gets a bare 402.
      const keys = [...new Set([...Object.keys(match), ...Object.keys(payload.accepted)])];
      const differing = keys.filter((k) => JSON.stringify(match[k]) !== JSON.stringify(payload.accepted[k]));
      if (differing.length) {
        // A surplus v1 `maxAmountRequired` beside `amount` is annotated with
        // whether it AGREES with the v2 price: `(=amount)` means the same
        // price said twice (the translator should have dropped it - a fault
        // of ours if it still refuses), `(!=amount)` a real disagreement.
        // Without this the telemetry of 2026-09-03 could not say which of the
        // two the retrying render buyer was, and those need opposite fixes.
        const annotated = differing.map((k) => (k === "maxAmountRequired" && match.maxAmountRequired === undefined && payload.accepted.amount !== undefined)
          ? `${k}(${sameInteger(payload.accepted.maxAmountRequired, payload.accepted.amount) ? "=" : "!="}amount)`
          : k);
        return { reason: "requirements-mismatch", retry: "rebuild-payment", fields: annotated.slice(0, 6),
          // The FULL echoed key list, not just the diff. Knowing only which
          // key differed was not enough to fix the live buyer: `maxAmountRequired`
          // could be a v1 REPLACEMENT for `amount` or a surplus alias sitting
          // beside it, and those need opposite handling. Names only.
          acceptedKeys: Object.keys(payload.accepted).sort().slice(0, 12),
          detail: `The requirements echoed with this payment differ from what this route advertises. Differing or unexpected field(s): ${differing.slice(0, 6).join(", ")}. x402 compares the echoed entry to the advertised one exactly, so an extra field fails as surely as a wrong value - copy one accepts entry from THIS response's PAYMENT-REQUIRED header verbatim, adding nothing.` };
      }
    }
    return null; // shape is sound - the facilitator's own hint is the better answer
  } catch { return null; }
}

/**
 * The SHAPE of a payment we refused but could NOT classify - key names only.
 *
 * Written after three revisions of the classifier each reproduced the symptom
 * of a live 402 loop and none turned out to be the client's actual payload
 * (version skew, then a missing `accepted`, then a surplus field). Guessing
 * shapes one at a time is the wrong method; this reports what the payload
 * actually looked like, so the next unclassified refusal answers itself
 * instead of costing another deploy.
 *
 * NEVER a value: no signature, no nonce, no from/to, no amount. Key names
 * only, sorted and bounded. A payment header is a credential, and the point
 * here is diagnosis, not capture.
 *
 * @returns {string|null} e.g. "p:network,payload,scheme|a:amount,asset|z:from,to"
 */
/**
 * The same shape, written for the PERSON whose client is failing.
 *
 * `unclassifiedPaymentShape` exists for our telemetry and is deliberately
 * terse. This is its twin for the 402 body: when a payment decodes but matches
 * nothing and none of the named classes fit, the buyer used to get an
 * unadorned 402 - silence from the one system that can see exactly what they
 * sent. A developer cannot debug against silence, and an unclassified refusal
 * is as likely to be OUR defect as theirs, so the message says that and asks
 * them to tell us.
 *
 * KEY NAMES ONLY, the same rule as the shape: no signature, no nonce, no
 * addresses, no amounts. A payment header is a credential.
 */
export function unclassifiedPaymentHint({ paymentHeader, paymentRequiredHeader, reportUrl = "https://agent402.tools/x402-test" } = {}) {
  const payload = decodeB64Json(paymentHeader);
  if (!payload) return null;
  const { accepts } = advertisedAccepts(paymentRequiredHeader);
  if (!accepts.length) return null;
  const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : []);
  const parts = [];
  const top = keys(payload);
  if (top.length) parts.push(`top level: ${top.join(", ")}`);
  const acc = keys(payload.accepted);
  if (acc.length) parts.push(`accepted: ${acc.join(", ")}`);
  const auth = keys(payload.payload?.authorization);
  if (auth.length) parts.push(`authorization: ${auth.join(", ")}`);
  if (!parts.length) return null;
  const wanted = keys(accepts[0]).filter((k) => k !== "extra" && k !== "outputSchema");
  return {
    reason: "unclassified",
    retry: "compare-with-requirements",
    detail:
      `This payment decoded but matched no requirement on this route, and the mismatch is not one this server recognizes. ` +
      `Field NAMES received (values are never echoed) - ${parts.join("; ")}. ` +
      `One accepts entry in PAYMENT-REQUIRED carries ${wanted.join(", ")}; every field but extra must match it exactly. ` +
      `If it looks correct to you then the fault may be ours, and we would rather hear about it: ${reportUrl}`,
  };
}

export function unclassifiedPaymentShape(paymentHeader, { maxChars = 110 } = {}) {
  try {
    const payload = decodeB64Json(paymentHeader);
    if (!payload) return null;
    const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : []);
    return `p:${keys(payload).join(",")}|a:${keys(payload.accepted).join(",")}|z:${keys(payload.payload?.authorization).join(",")}`.slice(0, maxChars);
  } catch { return null; }
}
