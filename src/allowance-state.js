// The first-call allowance's state on a request, readable without loading the
// allowance itself (src/first-call-allowance.js imports the revenue and sales
// ledgers). Settlement, idempotency and answer-share code read a grant through
// this module only, so the processes that load them (decide included) do not
// pull the ledgers in. No imports.

export const ALLOWANCE_STATE = "__a402Allowance";

/** The allowance state on a request, or null. Own property only: a polluted
 *  prototype must never make a request look granted (and so unsettled). */
export function allowanceOf(req) {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, ALLOWANCE_STATE)) return null;
  const a = req[ALLOWANCE_STATE];
  return a && typeof a === "object" ? a : null;
}

/** True once settlement of this request was skipped under a grant. */
export function allowanceServed(req) { return allowanceOf(req)?.state === "served"; }
