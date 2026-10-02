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
