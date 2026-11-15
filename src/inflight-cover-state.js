// The two facts about the in-flight coverage check (src/inflight-cover.js)
// that another module reads without running the check: its switch, and how an
// admitted run was admitted. Kept apart, with no imports, so a reader (the
// settle breaker, which the decide service reaches through the gateway kit)
// does not load the check's balance readers and the ledgers behind them.

// How an admitted run was admitted, kept on its request (own, non-enumerable):
// "covered" (verify's proof for a first run in flight, or a balance read that
// covers the sum), "trusted" (the wallet's paid record) or "unread" (the
// balance could not be read; inside the small unread allowance).
export const COVER_STATE = Symbol("a402.inflightCoverState");

/** "on" (every paid route), "composite" (the report and media routes only,
 *  with the limits the check had before) or "off". */
export function inflightCoverMode() {
  const v = String(process.env.INFLIGHT_COVER || "").trim().toLowerCase();
  return v === "off" ? "off" : v === "composite" ? "composite" : "on";
}

/** "covered", "trusted", "unread", or null for a request this check did not admit. */
export function coveredRunStateOf(req) {
  return req && typeof req === "object" && Object.hasOwn(req, COVER_STATE) ? req[COVER_STATE] : null;
}
