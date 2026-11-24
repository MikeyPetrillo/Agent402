// Settling only what a run spent, on the x402 `upto` scheme.
//
// A handler whose cost is known only after it ran (decide-execute: its budget
// is a ceiling and the outside sellers it buys from set what it spends) puts
// the amount on its result with setActualCharge. The route binder calls
// applyActualCharge before the body is sent: on an `upto` payment the
// settlement override names that amount, so the buyer is charged what was
// spent and never more than the ceiling they signed. An `exact` payment fixed
// its amount at the 402, so nothing is overridden there; the handler books
// the difference as a refund owed instead (see decide-kit's execute handler).
//
// The amount rides the paying request itself when the handler holds it as a
// route call (a step of another answer is handed no request, or runs inside
// runAsStep, and sets none), so no wrapper that copies the answer between the
// handler and the binder can drop it. It also rides the answer as a
// non-enumerable property (never in the buyer's JSON; every answer copier keeps
// it, src/answer-charges.js) for an in-process caller that reads it there. The
// binder removes both before anything else can fail.
import { paymentSchemeOf } from "./payer.js";
import { isRouteCall } from "./not-charged.js";

const REQ_KEY = "__actualChargeUsd";

export function setActualCharge(result, usd, req = null) {
  if (!result || typeof result !== "object" || !(Number(usd) >= 0)) return result;
  Object.defineProperty(result, "__actualChargeUsd", { value: Number(usd), enumerable: false, configurable: true, writable: true });
  if (isRouteCall(req)) {
    try { Object.defineProperty(req, REQ_KEY, { value: Number(usd), enumerable: false, configurable: true, writable: true }); } catch { /* a frozen request keeps the answer's copy */ }
  }
  return result;
}

/** The actual charge a run named (the request's copy first, then the
 *  answer's), with both removed; undefined when none was named. */
function takeActualCharge(result, req) {
  let usd;
  if (req && typeof req === "object" && typeof req[REQ_KEY] !== "undefined") { usd = req[REQ_KEY]; try { delete req[REQ_KEY]; } catch { /* frozen */ } }
  if (result && typeof result === "object" && typeof result.__actualChargeUsd !== "undefined") {
    if (typeof usd === "undefined") usd = result.__actualChargeUsd;
    try { delete result.__actualChargeUsd; } catch { /* frozen */ }
  }
  return usd;
}

/** True when this request's payment lets the server name the settled amount. */
export function chargesActualSpend(req) {
  try { return paymentSchemeOf(req) === "upto"; } catch { return false; }
}

/**
 * Apply a handler's actual charge to an `upto` settlement. Returns the amount
 * set, or null (not upto, no amount, headers already sent, nothing to lower).
 * The amount is never above the quote the buyer authorized and never under
 * the settlement floor ($0.001).
 */
export function applyActualCharge({ result, req, res, setOverrides, log = console.warn }) {
  const named = takeActualCharge(result, req);
  if (typeof named === "undefined") return null;
  const usd = Number(named);
  try {
    if (!chargesActualSpend(req) || res?.headersSent || typeof setOverrides !== "function") return null;
    const quoted = Number(req?.__meteredQuoteUsd);
    const ceiling = Number.isFinite(quoted) && quoted > 0 ? quoted : Infinity;
    const amount = Math.max(0.001, Math.min(usd, ceiling));
    if (!(amount < ceiling)) return null;
    const rounded = Math.ceil(amount * 1e6 - 1e-9) / 1e6;
    setOverrides(res, { amount: `$${rounded.toFixed(6)}` });
    res.setHeader("X-Charged-Usd", rounded.toFixed(6));
    return rounded;
  } catch (e) {
    log(`[actual-charge] not applied (${String(e?.message || e).slice(0, 120)}); settling at the quote`);
    return null;
  }
}
