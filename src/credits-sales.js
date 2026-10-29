// Whether prepaid card credits are on sale, in a leaf module so page renderers
// can state it without importing server.js. Off unless CREDITS_SALES is set;
// existing keys keep spending either way.
export const creditsSalesEnabled = () => /^(1|true|on|yes)$/i.test(String(process.env.CREDITS_SALES || "").trim());

// The terms version a credits checkout records (the date printed on /terms;
// scripts/test-nc-sales-tax.js checks they match).
export const TERMS_VERSION = "2026-10-29";

// The most one buyer may buy in any 24 hours (CREDITS_DAILY_MAX_USD, default
// $1,000), in cents. Read at call time; src/credits.js enforces it.
export const creditsDailyMaxCents = () => {
  const n = Number(process.env.CREDITS_DAILY_MAX_USD);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 1000) * 100);
};

// How every page describes a credits balance: a prepayment for Agent402's own
// services, spent per call, not a deposit or money held for withdrawal.
export function creditsPrepaymentPhrase() {
  return `a prepaid credits balance is a prepayment for Agent402's own services, paid up front and spent per call, not a deposit or money held for withdrawal${creditsSalesEnabled() ? "" : " (credits are no longer sold; keys already issued keep spending)"}`;
}

// The pointer a credits refusal carries. While packs are on sale it is the
// top-up page; while they are not, that page sells nothing, so the answer
// says so and names the paths that do take payment.
export function creditsTopupFields(baseUrl) {
  if (creditsSalesEnabled()) return { topup: `${baseUrl}/credits` };
  return { topup: null, topupNote: "New credits are not on sale; a key already issued keeps working. Pay per call with a wallet over x402 or MPP instead.", pay: `${baseUrl}/api/pricing` };
}
