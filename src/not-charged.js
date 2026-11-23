// The one sentence a refusal uses to say a call was not charged, and the rule
// for when a handler may print it.
//
// The route binder adds the Tempo push exception to this exact sentence
// (prepayment-refusal.js withPushExceptionText), so a refusal that words the
// claim any other way would read as true to a Tempo push buyer whose transfer
// was final before the call and is recorded as owed.
//
// The sentence is printed on a route call only: a skill-pack step, a decide
// step and a route-execute first-party step run the handler request-less
// (`handler(input)`) inside an answer that is charged, and print the step's
// error there, where the claim would be false.

export const NOT_CHARGED = "Nothing was charged.";

/** True when the handler was called by the route binder (it passes `req`). */
export function isRouteCall(req) {
  return !!(req && typeof req === "object" && req.headers && typeof req.headers === "object");
}

/** `text` with the shared sentence taken out and the spacing closed up: for
 *  an error recorded inside an answer that can itself be charged (a step
 *  error of a decide run), where the claim would describe the wrong call. */
export function withoutChargeClaim(text) {
  return String(text ?? "").split(NOT_CHARGED).map((part) => part.trim()).filter(Boolean).join(" ");
}

/** " Nothing was charged." on a route call, "" otherwise: append to a sentence. */
export function notChargedOn(req) {
  return isRouteCall(req) ? ` ${NOT_CHARGED}` : "";
}

// Any wording of the claim, the shared sentence or a handler's own.
const ANY_CHARGE_CLAIM = /\b(?:not|never) charged\b|\bnothing (?:was|is|has been) charged\b|\bno charge\b|\buncharged\b/i;

/** `text` without each sentence that says nothing was charged, whatever its
 *  wording: for a gate whose payment was taken before the handler ran (the
 *  AWS Marketplace front door, src/aws-marketplace-gate.js), where a handler's
 *  claim would be false and the gate states the payment's state itself. */
export function withoutChargeSentences(text) {
  return String(text ?? "").split(/(?<=[.!?;])\s+/).filter((s) => !ANY_CHARGE_CLAIM.test(s)).join(" ").trim();
}
