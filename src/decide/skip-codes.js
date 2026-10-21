// Fixed codes for why a step's tool was skipped or failed in a decide run
// (POST /api/decide/execute). Each attempt carries one beside its free-text
// reason; skipCodeOf reads one back, from the text for runs recorded before.

/** Fixed codes for why a tool of a step was not run or did not answer, kept
 *  beside the free-text reason on every attempt (and on a skipped step), so
 *  outcomes can be counted without reading the text. */
export const SKIP_CODES = Object.freeze(["params_misfit", "needs_input", "ref_unresolved", "call_directly", "seller_refused", "upstream_5xx", "timeout", "budget", "halt", "other"]);

/** The code for a tool call that threw: a refused seller, a timeout, a run
 *  stopped on our side, a 4xx (our request did not fit), a 5xx upstream. */
export function attemptErrorCode(e, { sellerRefused = false, timedOut = false } = {}) {
  if (sellerRefused) return "seller_refused";
  if (e?.runStopped) return "halt";
  const status = Number(e?.statusCode) || 500;
  if (timedOut || (status === 504 && /did not answer within/.test(String(e?.message || "")))) return "timeout";
  if (status >= 400 && status < 500) return "params_misfit";
  if (status >= 500) return "upstream_5xx";
  return "other";
}

/** The code of a recorded attempt or step: its own, else read from its text
 *  (runs recorded before codes existed). Always one of SKIP_CODES. */
export function skipCodeOf(a) {
  if (a && SKIP_CODES.includes(a.code)) return a.code;
  const t = String(a?.skipped || a?.reason || a?.error || "");
  if (a?.error !== undefined && !a?.skipped) {
    if (/refused the payment|rejected the paid retry|Seller .* failed/i.test(t)) return "seller_refused";
    if (/^the run was stopped/.test(t)) return "halt";
    return attemptErrorCode({ statusCode: a.status, message: t });
  }
  if (/^params do not fit/.test(t)) return "params_misfit";
  if (/^needs the output of step|^step \d+'s output/.test(t)) return "ref_unresolved";
  if (/^needs |declares no inputs/.test(t)) return "needs_input";
  if (/call (this tool|it|them) directly|no longer in the catalog|not enabled on this host|cannot dispatch|has no internal handler|bodyType|per-request|report product/.test(t)) return "call_directly";
  if (/time budget is spent|did not answer within/.test(t)) return "timeout";
  if (/over the remaining budget|daily execution ceiling|spending wallet is topped up/.test(t)) return "budget";
  if (/^the run (was|stopped)/.test(t)) return "halt";
  return "other";
}
