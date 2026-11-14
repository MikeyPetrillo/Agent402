// Which payment RAILS actually moved money.
//
// NOT to be confused with src/rails.js, which owns the settlement CHAINS we
// advertise (Base, Solana, Algorand…). The word is overloaded: a `rail` here
// is the GATE that accepted a served call — `usdc` and `marketplace` are
// purchases, while `pow` (proof-of-work), `trial` and `heartbeat` served the
// call for FREE.
//
// Both kinds are recorded everywhere, deliberately: the free-tier funnel is
// measured by comparing proof-of-work challenges ISSUED against pow calls
// SERVED, so dropping the free rows would delete that metric.
//
// THE TRAP THIS CLOSES. A free call still carries the tool's LIST price —
// that is the honest answer to "what would this have cost", and the free-tier
// subsidy metric needs it. So any count or sum filtered only on `synthetic`
// silently counts free traffic as revenue. `synthetic` does NOT mean free: it
// means OUR OWN traffic (canary, heartbeat probes). Proof-of-work is genuine
// external demand that happens to cost nothing, so it is correctly
// synthetic=false — which is precisely why the naive filter lets it through.
//
// Measured 2026-08-06 over 7 days: 385 external PAID settles against 388 free
// proof-of-work ones. Three saved dashboards filtering on `synthetic` alone
// read slightly over 2x reality, and the same mistake was made live while
// investigating a traffic spike, using the same filter, before it was caught.
//
// This set was ALREADY the convention, spelled out by hand in nine SQL queries
// in sales-ledger.js and in the settled-revenue dashboard. Naming it once
// means a new paying rail cannot be added to some readers and forgotten in
// others - the failure mode where revenue quietly stops being counted.
// "card" = Stripe Checkout (one-shot reports) and paid subscription invoices
// (src/human-checkout.js / stripe-subscriptions.js -> recordSale rail "card");
// "credits" = prepaid card credits DEBITED per call (src/credits.js); the pack
// purchase itself is booked on the non-paying rail "card-prepaid" so a $20 pack
// is counted once (when spent), never twice (caught 2026-08-22). Both are real
// money from others - without them here the human front door was invisible to
// /revenue.
export const PAYING_RAILS = Object.freeze(["usdc", "marketplace", "card", "credits"]);

/** Did money actually move on this rail? Free tiers (pow/trial/heartbeat) are false. */
export function isPaidRail(rail) {
  return PAYING_RAILS.includes(String(rail || ""));
}

/** The same set as a SQL list, so the queries cannot drift from the code. */
export const PAYING_RAILS_SQL = `(${PAYING_RAILS.map((r) => `'${r}'`).join(",")})`;

// Rails that are booked but never shown. A "referral" row (src/referral-gate.js)
// is a sale settled through a referral network's split contract: its
// price_usd is the NET that reached us and its quote_usd the gross the buyer
// paid, so a reader that sums price_usd as revenue or as a buyer's spend
// would misstate both, and the difference is the commission, which is
// nobody's to read. Every reader of the sales table either filters on
// PAYING_RAILS (which never holds a private rail), on a wire of its own, or
// on PUBLIC_RAIL_SQL below; the buyer's own receipts and usage read these
// rows at the gross (BUYER_AMOUNT_SQL). scripts/test-referral-gate.js reads every
// SELECT in src/sales-ledger.js against this rule.
export const PRIVATE_RAILS = Object.freeze(["referral"]);
export function isPrivateRail(rail) {
  return PRIVATE_RAILS.includes(String(rail || ""));
}
/** A WHERE clause term that leaves the private rails out. */
export const PUBLIC_RAIL_SQL = `rail NOT IN (${PRIVATE_RAILS.map((r) => `'${r}'`).join(",")})`;
/** The rails a buyer's own purchase history holds: the paying ones and the private ones. */
export const BUYER_RAILS_SQL = `(${[...PAYING_RAILS, ...PRIVATE_RAILS].map((r) => `'${r}'`).join(",")})`;
/** What the buyer paid on a row: the gross on a private rail, the price otherwise. */
export const BUYER_AMOUNT_SQL = `(CASE WHEN rail IN (${PRIVATE_RAILS.map((r) => `'${r}'`).join(",")}) THEN COALESCE(quote_usd, price_usd) ELSE price_usd END)`;
