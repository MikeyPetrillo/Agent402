// What a handler's answer says it costs, carried past every copy of it.
//
// Two figures ride a handler's answer as non-enumerable own properties, so
// they never reach a buyer's JSON: `__actualChargeUsd` (what an upto run
// spent, src/actual-charge.js) and `__meterUpstreamUsd` (the upstream cost a
// metered route settles under its ceiling, src/gateway-meter.js). The route
// binder reads them after every wrapper ran. A wrapper that returns a copy of
// the answer (a spread that adds a mark, a credit or a terms line) would drop
// them, and the buyer would then settle at the full ceiling. Every such copy
// goes through keepAnswerCharges, and scripts/test-answer-charges.js holds
// each handler wrapper in src/ to it.
export const ANSWER_CHARGE_KEYS = Object.freeze(["__actualChargeUsd", "__meterUpstreamUsd"]);

const isObj = (v) => v !== null && typeof v === "object";

/** `to` with the charge figures `from` carries (a figure `to` already holds
 *  is kept). Returns `to`; never throws. */
export function keepAnswerCharges(from, to) {
  if (from === to || !isObj(from) || !isObj(to)) return to;
  for (const k of ANSWER_CHARGE_KEYS) {
    const d = Object.getOwnPropertyDescriptor(from, k);
    if (!d || Object.hasOwn(to, k)) continue;
    try { Object.defineProperty(to, k, { value: d.value, enumerable: false, configurable: true, writable: true }); } catch { /* frozen copy */ }
  }
  return to;
}
