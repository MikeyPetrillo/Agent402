// Does this request carry a way to pay? An x402 payment (PAYMENT-SIGNATURE or
// X-PAYMENT), an MPP credential (Authorization: Payment ...), a prepaid
// credits key (Authorization: Bearer a402_...) or a proof-of-work solution.
// Presence only: nothing here verifies or spends it.
//
// The gateway's pre-paywall cache serves a byte-identical repeat of an
// already-paid call free, but only to a request that carries one of these:
// the repeat's payment is never settled, and an unpaid request (a crawler, a
// discovery validator, anyone) gets the route's 402 instead of someone
// else's paid answer.
export function carriesPaymentAttempt(req) {
  const h = (n) => { try { return String(req?.header?.(n) || req?.headers?.[n] || ""); } catch { return ""; } };
  if (h("payment-signature") || h("x-payment") || h("x-pow-solution")) return true;
  const auth = h("authorization");
  return /^Payment\s/i.test(auth) || /^Bearer a402_/.test(auth);
}
