// Whether prepaid card credits are on sale, in a leaf module so page renderers
// can state it without importing server.js. Off unless CREDITS_SALES is set;
// existing keys keep spending either way.
export const creditsSalesEnabled = () => /^(1|true|on|yes)$/i.test(String(process.env.CREDITS_SALES || "").trim());

// The terms version a credits checkout records (the date printed on /terms;
// scripts/test-nc-sales-tax.js checks they match).
export const TERMS_VERSION = "2026-11-16";

// The most one buyer may buy in any 24 hours (CREDITS_DAILY_MAX_USD, default
// $1,000), in cents. Read at call time; src/credits.js enforces it.
export const creditsDailyMaxCents = () => {
  const n = Number(process.env.CREDITS_DAILY_MAX_USD);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 1000) * 100);
};

// The most one key's balance may hold (CREDITS_BALANCE_MAX_USD, default $100,
// the largest pack), in cents. Every purchase issues a new key and nothing adds
// to a key's balance after it is issued, so the cap is the pack: a pack above it
// is not offered, a checkout for it is refused, and a paid session above it
// (the cap lowered after checkout) is refunded in full with no key issued
// (src/credits.js). Read at call time.
export const creditsBalanceMaxCents = () => {
  const n = Number(process.env.CREDITS_BALANCE_MAX_USD);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 100) * 100);
};

// The date the text /terms and /privacy show only while credits are on sale
// was written. While sales are on, each page prints the later of its own date
// and this one (never a day after today, UTC), and a credits checkout records
// that printed date as the terms version the buyer accepted. With sales off
// the pages keep their own dates.
export const CREDITS_SALES_TERMS_DATE = "2026-11-17";
export function creditsLegalDate(own, today = new Date().toISOString().slice(0, 10)) {
  if (!creditsSalesEnabled()) return own;
  return CREDITS_SALES_TERMS_DATE > own && CREDITS_SALES_TERMS_DATE <= today ? CREDITS_SALES_TERMS_DATE : own;
}
const LEGAL_DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
/** A rendered legal page with its "last updated" date moved to creditsLegalDate. */
export function withCreditsSalesDate(html) {
  return String(html).replace(LEGAL_DATE_LINE, (m, own) => `last updated ${creditsLegalDate(own)}.`);
}
/** The terms version a credits checkout records: the date /terms prints now. */
export const creditsTermsVersion = () => creditsLegalDate(TERMS_VERSION);

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
