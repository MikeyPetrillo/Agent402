// The named source a card sale arrived from, for the operator's count of card
// sales by source.
//
// A visit that lands with `utm_source=<name>` carries that name in the card
// checkout request (the storefront scripts read it from the page address);
// the checkout session keeps it in its metadata and the sales ledger stores it
// on the sale (the `source` column). Only a name on the list below is kept:
// anything else in the request, the session or a queued write is dropped, so
// the column holds a fixed word and never text a visitor typed. No public
// reader of the ledger selects it.
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Sources a sale may be booked under. Adding one is a one-line change here. */
export const KNOWN_SALE_SOURCES = Object.freeze(["ask402"]);
const KNOWN = new Set(KNOWN_SALE_SOURCES);

/** A source safe to store: a listed name in the strict shape, else null. */
export function cleanSaleSource(v) {
  return typeof v === "string" && SOURCE_RE.test(v) && KNOWN.has(v) ? v : null;
}
