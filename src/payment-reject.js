// Why a payment was refused, said out loud.
//
// @x402/express answers every rejected payment with a bare `res.status(402)
// .json({})` - the reason is discarded inside the middleware and never reaches
// us or the buyer. Our only hooks (onVerifyFailure / onAfterVerify) fire at the
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

/** Decode a base64(url) JSON header. Null on anything unreadable. */
function decodeB64Json(value) {
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

/** The advertised accepts, from our own PAYMENT-REQUIRED header. */
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
        return { reason: "requirements-mismatch", retry: "rebuild-payment", fields: differing.slice(0, 6),
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
export function unclassifiedPaymentShape(paymentHeader, { maxChars = 110 } = {}) {
  try {
    const payload = decodeB64Json(paymentHeader);
    if (!payload) return null;
    const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : []);
    return `p:${keys(payload).join(",")}|a:${keys(payload.accepted).join(",")}|z:${keys(payload.payload?.authorization).join(",")}`.slice(0, maxChars);
  } catch { return null; }
}
