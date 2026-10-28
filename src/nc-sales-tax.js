// North Carolina sales tax on card-funded sales of digital audio and video.
//
// North Carolina taxes "certain digital property" (G.S. 105-164.4(a)(1)b),
// which includes a "digital audio work" (a fixation of musical, spoken or
// other sounds transferred electronically) and a "digital audiovisual work"
// (G.S. 105-164.3), and excludes an "information service". The catalog's data,
// chat, tool, image and report routes are information services; generated
// speech and video are digital audio and audiovisual works.
//
// A card-funded sale has a billing address: a credits key keeps the one its
// pack was bought with, and a per-call card payment carries its own. Prices
// are tax-included and the same everywhere (G.S. 105-164.7(2) allows this
// when a statement says the price includes the tax; the terms, the checkout
// and each taxable tool's page say so). Wallet payments carry no address and
// are not sourced here.
//
// The report is built from the sales ledger, which every server shares, so
// it holds every replica's sales and survives restarts: per calendar month
// (UTC), the gross receipts (tax included) and calls on taxable routes billed
// to a North Carolina address, in total and by billing ZIP code. The tax in
// a tax-included amount is gross x r / (1 + r) at the combined state and
// county rate r of the buyer's county, applied from the ZIP breakdown when
// filing.

// Routes whose answer is a digital audio or audiovisual work.
export const NC_TAXABLE_SLUGS = Object.freeze({
  "tts-lite": "digital audio work",
  tts: "digital audio work",
  "tts-hd": "digital audio work",
  "v1-audio-speech": "digital audio work",
  dub: "digital audio work",
  "v1-videos": "digital audiovisual work",
});

export const ncTaxableKind = (slug) => (Object.hasOwn(NC_TAXABLE_SLUGS, String(slug)) ? NC_TAXABLE_SLUGS[slug] : null);
/** A billing address in North Carolina. */
export function isNcBilling(billing) {
  return !!billing && String(billing.country || "").toUpperCase() === "US" && String(billing.state || "").toUpperCase() === "NC";
}
/** The tax contained in a tax-included amount at the combined rate `rate`. */
export const taxIncludedPortion = (gross, rate) => (Number(gross) > 0 && rate > 0 ? Number(gross) * rate / (1 + rate) : 0);

const monthOf = (ts) => new Date(ts).toISOString().slice(0, 7);
const zip5 = (z) => (String(z || "").match(/^\d{5}/) || ["unknown"])[0];
/** UTC month bounds [start, end) for "YYYY-MM". */
export function monthBounds(month) {
  const [y, m] = String(month).split("-").map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}

/**
 * Build the report from ledger rows ({ ts, slug, priceUsd, payer, tx }).
 * A row with a credits key id as payer and no tx is a credits charge; a row
 * whose tx is a PaymentIntent (pi_...) is a per-call card payment.
 *   billingForKey(keyId)      -> the key's billing address or null
 *   billingForPayment(piId)   -> the payment's billing address or null (may be async)
 */
export async function ncTaxReport(rows, { billingForKey, billingForPayment }) {
  const months = {};
  const add = (month, zip, gross, source) => {
    const m = (months[month] ||= { grossReceiptsUsd: 0, calls: 0, bySource: { credits: 0, card: 0 }, byZip: {} });
    m.grossReceiptsUsd += gross; m.calls += 1; m.bySource[source] += 1;
    const z = (m.byZip[zip] ||= { grossReceiptsUsd: 0, calls: 0 });
    z.grossReceiptsUsd += gross; z.calls += 1;
  };
  let unknownAddress = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!ncTaxableKind(r?.slug) || !(Number(r.priceUsd) > 0)) continue;
    const tx = typeof r.tx === "string" ? r.tx : "";
    let billing = null, source = null;
    if (!tx && typeof r.payer === "string" && r.payer) { source = "credits"; billing = billingForKey(r.payer); }
    else if (/^pi_/.test(tx)) { source = "card"; billing = await billingForPayment(tx); }
    else continue; // a wallet payment: no billing address
    if (!billing) { unknownAddress++; continue; }
    if (!isNcBilling(billing)) continue;
    add(monthOf(r.ts), zip5(billing.postal), Number(r.priceUsd), source);
  }
  const round = (x) => Number(x.toFixed(6));
  for (const m of Object.values(months)) {
    m.grossReceiptsUsd = round(m.grossReceiptsUsd);
    m.byZip = Object.fromEntries(Object.entries(m.byZip).sort().map(([z, v]) => [z, { grossReceiptsUsd: round(v.grossReceiptsUsd), calls: v.calls }]));
  }
  return { months, cardFundedSalesWithoutAddress: unknownAddress };
}
