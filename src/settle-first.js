// Settle-first: a paid run whose payment is settled BEFORE its upstream work.
//
// Every x402 payment here is settled after its handler answered (CLAUDE.md,
// "x402 settlement ordering"), so a handler run whose settlement then fails is
// upstream spend with nothing paid. For the buyers the settle breaker names
// (src/gateway-settle-breaker.js gatewaySettleFirstDue: a wallet with no paid
// sale on the books, and a wallet or an authorization holding served runs that
// did not settle) the order is reversed on the routes the server arms: the
// payment is settled at the SETTLE POINT, the moment the handler is about to
// make its first paid upstream call, and the run goes on only when the
// settlement succeeded. Nobody is refused by this: a buyer whose payment
// settles is served, exactly once, for exactly what the payment was signed for.
//
// THE SETTLE POINT. The handler's own checks run first, as they always did
// (the breaker consult, input validation, the model and size refusals, a cache
// hit): each ends the call before any payment is taken. The upstream helpers
// (fetchOpenRouter and the kits' direct upstream calls) await
// settleBeforeUpstream() as their first statement; for a request the server
// armed, the first such call settles the payment and every later one awaits
// the same outcome. A request that is not armed pays nothing here: the call is
// a property read. A handler that answers without reaching the point (a cache
// hit) is settled after its answer, as every call is today.
//
// WHAT CAN FOLLOW A SETTLEMENT. Only a failure of ours or of the upstream:
// the settled charge then rides the final response as its PAYMENT-RESPONSE
// receipt (success: true), and the server books it as owed on the refund
// ledger under the class SETTLE_FIRST_FAILED (server.js, the charged-failure
// and hang-up recorders). A buyer who leaves after the settlement is owed the
// same way; a hang-up ticket never forgives a charge already taken
// (src/hangup-settlement.js chargeCancelledForClientGone).
//
// The request's state is an own, non-enumerable property. An upstream helper
// that takes no request argument reads the armed request from the ambient
// reader the server registers (setSettleFirstAmbient: the request's own
// scope). The server disarms the request when its handler ends, so a timer
// or a shared read that inherited that scope can never settle a finished
// request. A process that registers no reader (one that serves no paywall)
// has no ambient request, and every settle point there returns at once.

const STATE = Symbol("a402.settleFirst");
let ambient = null;
/** The server: how a settle point finds the armed request of the call it runs in. */
export function setSettleFirstAmbient(fn) { ambient = typeof fn === "function" ? fn : null; }

/** The refund-ledger class of a charge settled before a run that then failed
 *  or was not delivered: the row's note starts with it. */
export const SETTLE_FIRST_FAILED = "settle-first-failed";
/** The note such a row carries: the class, then how the run ended. */
export function settleFirstFailedNote(status) {
  const st = Number(status);
  return `${SETTLE_FIRST_FAILED}: ${st === 499 ? "answer not delivered" : `answer http ${Number.isInteger(st) ? st : "?"}`}`;
}
/** Is this refund row a settle-first charge whose run failed? */
export function isSettleFirstFailedRefund(row) {
  return typeof row?.note === "string" && row.note.startsWith(SETTLE_FIRST_FAILED);
}

function stateOf(req) {
  return req && typeof req === "object" && Object.hasOwn(req, STATE) ? req[STATE] : null;
}

/** Arm a request: its payment is settled by `run()` at the settle point.
 *  `run` resolves once the payment settled and throws the refusal otherwise.
 *  `reason` is why the run settles first. Returns the state, or null when the
 *  request cannot carry one. */
export function armSettleFirst(req, { run, reason = null } = {}) {
  if (!req || typeof req !== "object" || typeof run !== "function") return null;
  const state = { armed: true, reason, run, promise: null, settled: null, refusal: null };
  try { Object.defineProperty(req, STATE, { value: state, enumerable: false, configurable: true }); } catch { return null; }
  return state;
}

/** The request can no longer start a settlement here (its handler ended). A
 *  settlement already started keeps its outcome. */
export function disarmSettleFirst(req) {
  const s = stateOf(req);
  if (s) s.armed = false;
}

/** Why this request was armed, or null when it was not. */
export function settleFirstReasonOf(req) { return stateOf(req)?.reason ?? null; }
/** True when this request was armed and its settle point was reached. */
export function settleFirstStarted(req) { return !!stateOf(req)?.promise; }

/** Record the settlement this request's settle point made. */
export function markSettledFirst(req, info) {
  const s = stateOf(req);
  if (s && info && typeof info === "object") s.settled = info;
}
/** The settlement made before this request's run (`{ result, requirements,
 *  paymentPayload, at }`), or null. Own state only: a polluted prototype must
 *  never make a request read as paid. */
export function settledFirstOf(req) { return stateOf(req)?.settled ?? null; }

/**
 * THE SETTLE POINT. Awaited by an upstream helper before its paid call. For a
 * request that is not armed it returns undefined at once. For an armed one
 * the first call starts the settlement and every call awaits that one
 * outcome: it resolves when the payment settled, and rejects with the refusal
 * (isSettleFirstRefusal) when it did not, so no upstream call is made.
 */
export function settleBeforeUpstream(req = null) {
  let r = req;
  if (!r && ambient) { try { r = ambient(); } catch { r = null; } }
  const s = stateOf(r);
  if (!s) return undefined;
  if (s.promise) return s.promise;
  if (!s.armed) return undefined;
  s.promise = (async () => s.run())();
  // The refusal is read by the helper that awaits it; a second reader (a
  // later upstream call) reads the same one. Never an unhandled rejection.
  s.promise.catch((e) => { s.refusal = e; });
  return s.promise;
}

/** The error a settle point throws when the payment did not settle: `response`
 *  is the settle-failure answer to send (status, headers, body). */
export function settleFirstRefusal(response, message = "The payment did not settle, so the call was not run.") {
  // Always 402 as an error (a chain walker walks on 502/503/504 only, so no
  // fallback model is tried for a payment that did not settle); the answer
  // to send carries its own status.
  return Object.assign(new Error(message), { statusCode: 402, settleFirstRefused: true, response: response || null });
}
/** True for an error made by settleFirstRefusal(). */
export function isSettleFirstRefusal(err) {
  return !!err && typeof err === "object" && err.settleFirstRefused === true;
}
/** The refusal this request's settle point ended with, or null. A handler may
 *  wrap or replace the error it caught; the server reads it here. */
export function settleFirstRefusalOf(req) {
  const e = stateOf(req)?.refusal;
  return isSettleFirstRefusal(e) ? e : null;
}
