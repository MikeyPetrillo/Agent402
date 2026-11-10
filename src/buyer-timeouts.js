// The buyer's own timeout for each seller request, in a module of its own so
// a caller can read it without loading the buyer (and the ledgers it imports).

/** payX402's timeout for each seller request when the caller gives none. */
export const PAY_X402_TIMEOUT_MS = 20000;

/** The least of a call's time budget a seller request is started with: under
 *  it the unpaid request is not made, no payment is signed, and a credential
 *  already sent is not sent again. */
export const PAY_X402_MIN_LEG_MS = 3000;
