// RFC 9457 Problem Details for MPP failures.
//
// The Payment HTTP auth scheme says a failed credential is answered with a
// 402 that carries a FRESH `WWW-Authenticate: Payment` challenge and an
// `application/problem+json` body whose `type` is one of the
// paymentauth.org/problems/* URIs (mppx's own server does exactly this via
// PaymentError.toProblemDetails()). Until 2026-08-19 our gates fell through
// to the plain x402 402 (`{}` body) on a bad MPP credential and answered a
// replay with a 409 JSON blob - correct headers, wrong body: an MPP client
// learned nothing about WHY, and a spec-following one could not even tell
// the 402 was a rejection rather than a first ask.
//
// Two delivery paths, because our gates have two shapes:
//   - FALL-THROUGH (evm shim, tempo binding/validate): the gate rejects and
//     calls next(); @x402/express then emits the 402 whose headers the
//     outbound hooks enrich with fresh challenges. markMppProblem() patches
//     res.send for THIS request so that 402's body becomes the problem
//     document instead of the paywall's own body. The 402 body mirror
//     (src/payment-required-body.js) is mounted before every gate, so the
//     send it wraps is the mirror's: the problem document goes out with the
//     offer from the PAYMENT-REQUIRED header merged in after its members, and
//     no `error` (the detail is the explanation). Nothing else about the
//     response changes.
//   - DIRECT (tempo replay / post-handler settle failure): the gate answers
//     itself; sendMppProblem() writes the 402 + problem body and the outbound
//     tempo hook still appends a fresh tempo challenge at writeHead.
//
// The type catalogue mirrors mppx/dist/Errors.js (titles + hints verbatim
// where mppx defines them) so clients that switch on `type` see the same
// vocabulary from us as from a native mppx server.
export const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";
const BASE = "https://paymentauth.org/problems/";
const WALLET_HINT = "Use a supported wallet to pay for this resource using one of the supported payment methods returned in the WWW-Authenticate header. See https://mpp.dev/tools/wallet.md";

export const MPP_PROBLEM_KINDS = Object.freeze({
  "payment-required": { title: "Payment Required", hint: WALLET_HINT },
  "malformed-credential": { title: "Malformed Credential", hint: "Use a supported wallet to construct valid credentials for one of the supported payment methods returned in the WWW-Authenticate header. See https://mpp.dev/tools/wallet.md" },
  "invalid-challenge": { title: "Invalid Challenge" },
  "verification-failed": { title: "Verification Failed" },
  "payment-expired": { title: "Payment Expired" },
  "payment-insufficient": { title: "Payment Insufficient" },
  "method-unsupported": { title: "Method Unsupported", hint: WALLET_HINT },
  "invalid-payload": { title: "Invalid Payload" },
  // mppx's InternalPaymentError type. Used with status 503 when the payment
  // relay could not be reached BEFORE anything was validated: nothing was
  // charged and the same request can simply be retried.
  "internal-payment-error": { title: "Internal Payment Error" },
});

/** Build a problem document. `detail` is shown to the buyer - keep it about
 *  the credential, never about our internals (no secrets, no stack). `hint`
 *  overrides the kind's default hint with a specific next step. */
export function mppProblem(kind, detail, { status = 402, details, hint } = {}) {
  const k = MPP_PROBLEM_KINDS[kind];
  if (!k) throw new Error(`unknown MPP problem kind ${kind}`);
  const doc = { type: `${BASE}${kind}`, title: k.title, status, detail: String(detail || k.title) };
  if (details && typeof details === "object" && Object.keys(details).length) doc.details = details;
  const h = typeof hint === "string" && hint ? hint : k.hint;
  if (h) doc.hint = h;
  return doc;
}

const PATCHED = Symbol("agent402.mppProblemPatched");

/** FALL-THROUGH path: remember the rejection on the request and make sure the
 *  402 that @x402/express is about to emit carries it as problem+json. Safe to
 *  call more than once (the latest problem wins); a 200 or any non-402 status
 *  is never touched. */
export function markMppProblem(req, res, problem) {
  req.mppProblem = problem;
  if (res[PATCHED]) return;
  res[PATCHED] = true;
  const origSend = res.send;
  res.send = function mppProblemSend(body) {
    if (res.statusCode === 402 && req.mppProblem && !res.headersSent) {
      res.setHeader("Content-Type", PROBLEM_CONTENT_TYPE);
      return origSend.call(this, JSON.stringify({ ...req.mppProblem, status: 402 }));
    }
    return origSend.call(this, body);
  };
}

/** DIRECT path: answer now. */
export function sendMppProblem(res, problem) {
  res.status(problem.status || 402);
  res.setHeader("Content-Type", PROBLEM_CONTENT_TYPE);
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify(problem));
}
