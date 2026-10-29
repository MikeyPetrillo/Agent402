// Which payment rail a request PRESENTED, read once for telemetry. The gates
// rewrite and strip payment headers as they accept a credential (the MPP shim
// turns `Authorization: Payment` into PAYMENT-SIGNATURE, the Tempo, Stripe and
// credits gates delete the x402 headers), so a header read after the handler
// would misfile an MPP call as x402. The flags each gate sets are read first.
// Telemetry only: this never decides access or price.
export const RAILS = ["x402", "mpp-evm", "mpp-tempo", "mpp-stripe", "mpp", "credits", "pow"];

export function railOf(req) {
  if (!req) return null;
  if (req.mppTempoCredential) return "mpp-tempo";
  if (req.mppStripeCredential) return "mpp-stripe";
  if (req.mppCredential) return "mpp-evm";
  if ((Object.hasOwn(req, "creditsSettling") && req.creditsSettling === true) || (Object.hasOwn(req, "creditsSettled") && req.creditsSettled === true)) return "credits";
  const h = req.headers || {};
  // A Payment credential no gate recognised (malformed, another realm's).
  if (/^Payment\s/i.test(String(h.authorization || ""))) return "mpp";
  if (h["payment-signature"] || h["x-payment"]) return "x402";
  if (h["x-pow-solution"]) return "pow";
  return null;
}

// The rail a FINISHED catalog call was served on, for the failure monitor
// (src/tool-failure-monitor.js). The free rails are read only from the
// response headers the proof-of-work and trial gates set when they accept a
// call, never from a request header, so a caller cannot move a paid outcome
// onto the free lane; a solution header the gate did not accept is "none".
export function outcomeRailOf(req, res) {
  const accepted = (name) => { try { return res?.getHeader?.(name) === "true"; } catch { return false; } };
  if (accepted("X-Trial-Accepted")) return "trial";
  if (accepted("X-Pow-Accepted")) return "pow";
  const r = railOf(req);
  return r && r !== "pow" ? r : "none";
}
