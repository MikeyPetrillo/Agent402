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
  { reason: "unclassified", means: "It decoded and still matched nothing, in a way this server has no name for. The refusal lists the field NAMES received so you can compare them yourself, and we would like to hear about it: an unclassified refusal is as likely to be our defect as yours." },
  { reason: "facilitator-quota", means: "The payment verified and the call ran, then the facilitator for that network refused to settle it under a billing quota on this server's own account. Nothing was charged and nothing is wrong with your wallet. Ask the route for a fresh 402 without paying and pay on another network it lists." },
]);

/**
 * A facilitator refusing to SETTLE for a quota or billing reason on OUR
 * account: PayAI's `free_tier_exhausted`, the Algorand facilitator's
 * `subcent_quota_exceeded` (its monthly allowance of sponsored sub-cent
 * settlements for our payTo), a prepaid-credits wall. Such a refusal says
 * nothing about the buyer's wallet - but the call behind it was served and
 * never charged, so it is NOT free to ignore. ONE definition: payments.js logs
 * with it, the 402 body below names it, and the settle breaker words its 429
 * with it. Only the one refusal whose offer is actually withdrawn from the
 * next 402 (src/avm-sponsorship.js isWithdrawnSubcentRefusal) is kept off a
 * buyer's count; every other billing refusal still counts in both breakers
 * and the composite guard, because their bounds are all that stop it looping.
 */
export const FACILITATOR_BILLING_REFUSAL = /free_tier_exhausted|subcent_quota_exceeded|quota[_ ]exceeded|payment[_ ]required.*credit/i;
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

    const scheme = payload.scheme ?? payload.accepted?.scheme;
    const network = payload.network ?? payload.accepted?.network;
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
      `This payment decoded but matched no requirement on this route, and the mismatch is not one this server recognises. ` +
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
