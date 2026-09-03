// The vendor's post-submit confirmation poll, bounded and observable.
//
// @x402/stellar's settle() polls getTransaction `requirements.maxTimeoutSeconds`
// times (default 60; our x402 server advertises 300 on every route) with a
// 1 s sleep between attempts - so a transaction the RPC never reports lands
// the facilitator in a poll that only OUR settle timeout ends, and the log
// shows nothing between "submitted" and "timed out". This wraps the scheme's
// pollForTransaction to (1) cap the attempts (Stellar closes a ledger every
// ~5 s; a submitted tx is either in the next two ledgers or it is not
// coming), (2) hand the tx hash to the caller so a timeout response can carry
// it, and (3) log attempts and elapsed time. Separate module: unit-testable
// without index.js's top-level secret requirement.
export function installPollClamp(schemeProto, { maxAttempts = 8, log = console.log, onHash = () => {} } = {}) {
  if (!schemeProto || typeof schemeProto.pollForTransaction !== "function") return false;
  const original = schemeProto.pollForTransaction;
  const cap = Number(maxAttempts) > 0 ? Math.floor(Number(maxAttempts)) : 8;
  schemeProto.pollForTransaction = async function clampedPoll(server, txHash, maxPollAttempts, delayMs) {
    const asked = Number(maxPollAttempts);
    const attempts = Number.isFinite(asked) && asked > 0 ? Math.min(asked, cap) : cap;
    try { onHash(txHash); } catch { /* observer never breaks the poll */ }
    const t0 = Date.now();
    log(`[settle-poll] submitted ${String(txHash).slice(0, 12)}... polling up to ${attempts} attempt(s)${asked > attempts ? ` (caller asked ${asked})` : ""}`);
    const out = await original.call(this, server, txHash, attempts, delayMs);
    log(`[settle-poll] ${String(txHash).slice(0, 12)}... ${out?.success ? "SUCCESS" : "not confirmed"} after ${Date.now() - t0}ms`);
    return out;
  };
  return true;
}
