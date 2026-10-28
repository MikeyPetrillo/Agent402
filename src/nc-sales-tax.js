// North Carolina sales tax on prepaid credits spent on digital audio and video.
//
// North Carolina taxes "certain digital property" (G.S. 105-164.4(a)(1)b),
// which includes a "digital audio work" (a fixation of musical, spoken or
// other sounds transferred electronically) and a "digital audiovisual work"
// (G.S. 105-164.3), and excludes an "information service". The catalog's data,
// chat, tool, image and report routes are information services; generated
// speech and video are digital audio and audiovisual works. A credits key is
// bought by card with a billing address, so a call it pays is sourced to that
// address. Prices are tax-included: a call costs the same everywhere, and for
// a key whose billing address is in North Carolina the charge on a taxable
// route is recorded here as gross receipts that include the tax.
//
// The ledger keeps one aggregate per calendar month (UTC): gross receipts and
// calls, in total and by billing ZIP code, so a return can be filed by
// county. The state portion is computed at NC_STATE_RATE; local rates vary by
// county and are applied from the ZIP breakdown when filing.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";

// Routes whose answer is a digital audio or audiovisual work.
export const NC_TAXABLE_SLUGS = Object.freeze({
  "tts-lite": "digital audio work",
  tts: "digital audio work",
  "tts-hd": "digital audio work",
  "v1-audio-speech": "digital audio work",
  dub: "digital audio work",
  "v1-videos": "digital audiovisual work",
});
export const NC_STATE_RATE = 0.0475;

export const ncTaxableKind = (slug) => (Object.hasOwn(NC_TAXABLE_SLUGS, String(slug)) ? NC_TAXABLE_SLUGS[slug] : null);
/** A billing address in North Carolina. */
export function isNcBilling(billing) {
  return !!billing && String(billing.country || "").toUpperCase() === "US" && String(billing.state || "").toUpperCase() === "NC";
}
/** The tax contained in a tax-included amount at `rate`. */
export const taxIncludedPortion = (gross, rate) => (Number(gross) > 0 && rate > 0 ? Number(gross) * rate / (1 + rate) : 0);

const monthOf = (at) => new Date(at).toISOString().slice(0, 7);
const zip5 = (z) => (String(z || "").match(/^\d{5}/) || ["unknown"])[0];

export function createNcTaxLedger({ file = null, now = () => Date.now(), log = null } = {}) {
  const doc = file ? createJsonDocument({ file, log: (m) => log?.(m) }) : null;
  let body = { version: 1, months: {} };
  let ready = Promise.resolve();
  let loaded = false;
  const ensure = () => {
    if (loaded || !doc) return;
    loaded = true;
    if (doc.backend === "pg") ready = trackStoreReady(doc.load(null).then((j) => { if (j && j.months) body = j; }));
    else { const j = doc.loadSync(null); if (j && j.months) body = j; }
  };
  const add = (b, month, zip, micro) => {
    const m = (b.months[month] ||= { grossMicro: 0, calls: 0, byZip: {} });
    m.grossMicro += micro; m.calls += 1;
    const z = (m.byZip[zip] ||= { grossMicro: 0, calls: 0 });
    z.grossMicro += micro; z.calls += 1;
  };
  return {
    /** Record one taxable charge (only call for an NC billing address and a taxable slug). */
    async record({ slug, grossUsd, billing, at = now() }) {
      if (!ncTaxableKind(slug) || !isNcBilling(billing) || !(Number(grossUsd) > 0)) return false;
      ensure(); await ready;
      const micro = Math.round(Number(grossUsd) * 1e6);
      const month = monthOf(at), zip = zip5(billing.postal);
      if (!doc) { add(body, month, zip, micro); return true; }
      const r = await doc.update((b) => {
        const next = b && b.months ? { version: 1, months: JSON.parse(JSON.stringify(b.months)) } : { version: 1, months: {} };
        add(next, month, zip, micro);
        return next;
      }, { fallback: null });
      if (r.ok && r.body) body = r.body;
      else log?.(`[nc-sales-tax] could not record a ${slug} charge of $${grossUsd}; add it to the ${month} return by hand`);
      return r.ok;
    },
    /** Per month: gross receipts (tax included), calls, state tax portion, and gross by ZIP. */
    report() {
      ensure();
      const out = {};
      for (const [month, m] of Object.entries(body.months || {}).sort()) {
        const gross = m.grossMicro / 1e6;
        out[month] = {
          grossReceiptsUsd: Number(gross.toFixed(6)),
          calls: m.calls,
          stateTaxIncludedUsd: Number(taxIncludedPortion(gross, NC_STATE_RATE).toFixed(6)),
          byZip: Object.fromEntries(Object.entries(m.byZip || {}).sort().map(([z, v]) => [z, { grossReceiptsUsd: Number((v.grossMicro / 1e6).toFixed(6)), calls: v.calls }])),
        };
      }
      return out;
    },
    ready: () => { ensure(); return ready; },
  };
}
