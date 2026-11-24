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
// The amount rides a non-enumerable property, so it never reaches the buyer's
// JSON, and it is removed before anything else can fail.
import { paymentSchemeOf } from "./payer.js";

export function setActualCharge(result, usd) {
  if (!result || typeof result !== "object" || !(Number(usd) >= 0)) return result;
  Object.defineProperty(result, "__actualChargeUsd", { value: Number(usd), enumerable: false, configurable: true, writable: true });
  return result;
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
  if (!result || typeof result !== "object" || typeof result.__actualChargeUsd === "undefined") return null;
  const usd = Number(result.__actualChargeUsd);
  delete result.__actualChargeUsd;
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
