// The scope of a run served on a referral copy of a route (src/referral-gate.js).
//
// A referral copy must not send its buyer to the direct routes: no answer of
// it, success or error, names a direct paid route or tells the buyer to call
// one. The handlers build those hints deep in their validation, where no
// request is in hand, so the gate runs every step that can produce an answer
// (the price, the input checks, the handler) inside this scope, and the code
// that writes a hint asks routeHint() for it: the hint outside the scope, the
// alternative (nothing, by default) inside it. No answer text is rewritten
// after the fact.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();

/** Run `fn` as a referral run: routeHint() answers its alternative inside it. */
export function runAsReferral(fn) {
  return scope.run(true, fn);
}

/** True inside a referral run. */
export function inReferralRun() {
  return scope.getStore() === true;
}

/** A sentence or clause that names a route of this server: `direct` on a
 *  direct route, `referral` (nothing, unless given) inside a referral run. */
export function routeHint(direct, referral = "") {
  return inReferralRun() ? referral : direct;
}
