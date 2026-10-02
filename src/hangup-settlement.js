// A buyer whose connection is gone before the first response byte is not
// charged, within a budget: one rule on every rail.
//
// The signal is the ServerResponse "close" event fired while nothing has been
// written (!res.writableFinished && !res.headersSent). Every paid gate (the
// x402 middleware, the MPP evm shim that rides it, the Tempo and Stripe gates)
// buffers writeHead/write/end/flushHeaders until after it settles, so on those
// rails "headers not sent" means both that no byte reached the buyer AND that
// settlement has not been broadcast yet. This hook records that moment on the
// request (req.__a402ClientGoneAt).
//
// Whether that cancels the charge is decided by chargeCancelledForClientGone():
// the buyer left before the first byte AND the request holds a granted
// forgiveness ticket (src/hangup-forgiveness.js). The dispatcher reserves the
// ticket when the handler starts, priced at the charge, against a per-wallet,
// per-IP and service-wide budget that a paid success never resets. Every
// settlement point reads the predicate before it moves money:
//   - x402 (and MPP evm): an onBeforeSettle hook aborts settlement with
//     reason "client_disconnected" before any facilitator call
//     (registerClientGoneSettleHook in src/payments.js);
//   - Tempo pull and Stripe: the gate checks it after the handler and before
//     the broadcast / capture, and answers 499 with nothing spent;
//   - credits: the gate decides when the abandoned response ends, releasing
//     the hold (a stream that already began is settled, as before).
// A request WITHOUT a granted ticket (the budget is spent, the route's effect
// outlives the answer - a memory write, an attestation, a stored verdict, a
// purchase from an outside seller - or the route never reserved one) is
// settled exactly as before this rule existed, and the charge
// the buyer never received is booked as owed (server.js recordHangupDebt).
// So is a Tempo push credential, whose transfer is already on chain before the
// request arrives: the gate finalizes it before the handler, and any answer
// that is not delivered is owed.
//
// The dispatcher also refuses to START a handler for a request whose client
// is already gone (a >= 400, which no rail settles), and a forgiven report
// composite's per-request upstream calls are cut off the moment the buyer
// leaves (src/drain-abort.js clientGoneSignal).
//
// What is left in the refund ledger, besides a run with no ticket, is the one
// window no check can close: a close that lands while the settle, broadcast or
// capture call is itself in flight. A cancelled charge is NOT a debt and
// writes no ledger row.
//
// Mechanism: mounted BEFORE every payment gate, the hook wraps the REAL
// res.end, so each gate's captured "originalEnd" is this wrapper. When a gate
// finally ends a response whose client already left, `onUndelivered` sees the
// request with whatever settlement evidence is on it (PAYMENT-RESPONSE,
// req.tempoSettled, req.stripeSettled, req.creditsChargedOnClose) and decides
// whether it is a debt or a cancelled charge.
//
// Only a close that happened BEFORE any header reached the client counts: a
// stream that was cut part way through was (partly) delivered.

import { hangupForgiven } from "./hangup-forgiveness.js";

export const CLIENT_GONE_TEXT = "The connection closed before the response was ready, so the payment was not settled and nothing was charged.";

/** The error every client-gone refusal carries: a 499 (>= 400 cancels settlement on every rail). */
export function clientGoneError(msg = CLIENT_GONE_TEXT) {
  return Object.assign(new Error(msg), { name: "AbortError", statusCode: 499, clientGone: true });
}

/** True for an error produced by clientGoneError(). */
export function isClientGoneAbort(err) {
  return !!err && typeof err === "object" && err.clientGone === true;
}

/**
 * True when the buyer's connection closed before any byte of the response was
 * sent. Reads the flag the hook sets (own property only: a polluted prototype
 * must not make every request look abandoned and therefore unsettled); where
 * the hook is not mounted (FREE_MODE, a unit app) it falls back to the socket
 * state itself.
 */
export function clientGoneBeforeFirstByte(req) {
  if (!req || typeof req !== "object") return false;
  if (Object.hasOwn(req, "__a402ClientGoneAt") && Number(req.__a402ClientGoneAt) > 0) return true;
  const res = req.res;
  if (!res || typeof res !== "object" || res.headersSent) return false;
  return res.destroyed === true || req.socket?.destroyed === true;
}

/**
 * True when the charge for this request must NOT be taken: the buyer left
 * before the first byte AND the request holds a granted forgiveness ticket.
 * Without the ticket the rail settles as usual and the charge is booked as
 * owed, so a hang-up is never a free run once the budget is spent.
 */
export function chargeCancelledForClientGone(req) {
  return clientGoneBeforeFirstByte(req) && hangupForgiven(req);
}

/**
 * @param {object} opts
 * @param {(req: any, res: any, kind: "end") => void} opts.onUndelivered
 *        called at most once per request, when the client left before any
 *        byte was sent and a gate then ended the response. The callback
 *        decides whether settlement evidence is present (the residual window)
 *        or the charge was cancelled.
 */
export function createHangupSettlementHook({ onUndelivered }) {
  return function hangupSettlementHook(req, res, next) {
    let closedEarly = false;
    let fired = false;
    const fire = (kind) => {
      if (fired) return;
      fired = true;
      try { onUndelivered(req, res, kind); } catch { /* recording an outcome never breaks serving */ }
    };
    res.once("close", () => {
      if (res.writableFinished) return; // normal completion
      if (res.headersSent) return; // partly delivered (streaming): not this case
      closedEarly = true;
      req.__a402ClientGoneAt = Date.now();
    });
    const realEnd = res.end;
    res.end = function hangupAwareEnd(...args) {
      if (closedEarly) fire("end");
      const out = realEnd.apply(this, args);
      // Node emits no "finish" for a response ended on a socket that is
      // already gone, so the outcome listeners below hear it from here.
      if (closedEarly) runOutcome(res, "undelivered");
      return out;
    };
    next();
  };
}

// ---- The final outcome of a paid response, whether or not the buyer stayed.
//
// A settle-failure bound (the composite guard, the gateway and catalog
// breakers) judges a paid run by the FINAL response: a 200 is settled, a 402
// after the handler ran is a settlement that failed. Node emits no "finish"
// for a response whose client is already gone, though the gate still settles
// (or fails to) and ends it, so these registrations report every outcome
// whether or not the buyer stayed. They run once per response at the first of:
//   - "finish": the ordinary end;
//   - the gate ending the response after the buyer left before the first byte
//     (the hook above, which is mounted before every gate);
//   - "close" after headers went out: a stream or body cut part way, which was
//     settled before its first byte.
// A charge cancelled because the buyer left (a granted forgiveness ticket,
// src/hangup-forgiveness.js) is not a settlement outcome: onSettleOutcome
// skips it, so the forgiveness rule and its own budget stay the only bound on
// it. onResponseEnd runs for it too, for bookkeeping that must always close.
const OUTCOME = Symbol("a402.responseOutcome");

function outcomeState(req, res) {
  if (!res || typeof res.once !== "function") return null;
  if (Object.hasOwn(res, OUTCOME)) return res[OUTCOME];
  const state = { done: false, req, settle: [], always: [] };
  Object.defineProperty(res, OUTCOME, { value: state, enumerable: false });
  res.once("finish", () => runOutcome(res, "finish"));
  res.once("close", () => { if (res.headersSent) runOutcome(res, "close"); });
  return state;
}

function runOutcome(res, via) {
  if (!res || !Object.hasOwn(res, OUTCOME)) return;
  const state = res[OUTCOME];
  if (state.done) return;
  state.done = true;
  const forgiven = via === "undelivered" && chargeCancelledForClientGone(state.req);
  const info = { via, forgiven };
  for (const fn of state.always) { try { fn(info); } catch { /* an outcome listener never breaks serving */ } }
  if (forgiven) return;
  for (const fn of state.settle) { try { fn(info); } catch { /* an outcome listener never breaks serving */ } }
}

/** Run `fn(info)` once when this paid response's settlement is decided, on
 *  "finish" or after the buyer left (see above). Skips a charge cancelled for
 *  a buyer who left inside the forgiveness budget. Returns false when the
 *  response is already decided or there is none to watch. */
export function onSettleOutcome(req, res, fn) {
  const state = outcomeState(req, res);
  if (!state || state.done || typeof fn !== "function") return false;
  state.settle.push(fn);
  return true;
}

/** Run `fn(info)` once when this paid response ends, however it ends,
 *  including a forgiven hang-up (`info.forgiven`). */
export function onResponseEnd(req, res, fn) {
  const state = outcomeState(req, res);
  if (!state || state.done || typeof fn !== "function") return false;
  state.always.push(fn);
  return true;
}
