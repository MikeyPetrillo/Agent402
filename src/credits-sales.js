// Whether prepaid card credits are on sale, in a leaf module so page renderers
// can state it without importing server.js. Off unless CREDITS_SALES is set;
// existing keys keep spending either way.
export const creditsSalesEnabled = () => /^(1|true|on|yes)$/i.test(String(process.env.CREDITS_SALES || "").trim());

// The terms version a credits checkout records (the date printed on /terms;
// scripts/test-nc-sales-tax.js checks they match).
export const TERMS_VERSION = "2026-11-19";

// The most one buyer may buy in any 24 hours (CREDITS_DAILY_MAX_USD, default
// $1,000), in cents. Read at call time; src/credits.js enforces it.
export const creditsDailyMaxCents = () => {
  const n = Number(process.env.CREDITS_DAILY_MAX_USD);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 1000) * 100);
};

// The most one key's balance may hold (CREDITS_BALANCE_MAX_USD, default $100,
// the largest pack), in cents. A purchase issues a new key holding one pack; a
// top-up from the balance page adds a pack to it. A pack above the cap is not
// offered and a checkout for it is refused; a top-up the balance has no room
// for is refused before payment, with the room stated; a paid session above
// it (the cap lowered, or another top-up landed, after checkout) is refunded
// in full and adds nothing (src/credits.js). Read at call time.
export const creditsBalanceMaxCents = () => {
  const n = Number(process.env.CREDITS_BALANCE_MAX_USD);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 100) * 100);
};

// The date the text /terms and /privacy show only while credits are on sale
// was written. While sales are on, each page prints the later of its own date
// and this one (never a day after today, UTC), and a credits checkout records
// that printed date as the terms version the buyer accepted. With sales off
// the pages keep their own dates.
export const CREDITS_SALES_TERMS_DATE = "2026-11-18";
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

// How copy names a credits key a caller may hold: while packs are on sale
// any key ("a prepaid credits key"); while they are not, only one already
// issued.
export function creditsKeyQualifier() { return creditsSalesEnabled() ? "" : " already issued"; }

// The pointer a credits refusal carries. While packs are on sale it is the
// top-up page; while they are not, that page sells nothing, so the answer
// says so and names the paths that do take payment.
export function creditsTopupFields(baseUrl) {
  if (creditsSalesEnabled()) return { topup: `${baseUrl}/credits` };
  return { topup: null, topupNote: "New credits are not on sale; a key already issued keeps working. Pay per call with a wallet over x402 or MPP instead.", pay: `${baseUrl}/api/pricing` };
}
