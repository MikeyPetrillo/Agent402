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

/** " Nothing was charged." on a route call, "" otherwise: append to a sentence. */
export function notChargedOn(req) {
  return isRouteCall(req) ? ` ${NOT_CHARGED}` : "";
}
