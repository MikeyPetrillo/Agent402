// Free email alert probes (src/free-alerts.js): one adapter per alert kind,
// mapping a kit's free probe onto the engine's { ids, items } shape. Each
// item's `id` MUST be drawn from the same key space as `ids`, because the
// engine lists only the items whose id is in the fresh-id set; a mismatched
// id yields a change email that lists nothing.
//
// The filing alert promises "a 10-K, 10-Q or 8-K", so its probe asks EDGAR for
// exactly those forms: a Form 4, 144, S-8 or 13G never triggers it.
export const FILING_ALERT_FORMS = Object.freeze(["10-K", "10-Q", "8-K"]);

/**
 * @param {object} deps kit probes (injected so the adapters test offline)
 */
export function makeFreeAlertProbes({ probeInsider, probeFilings, resolveManager, latest13f, probeDomain, probeRecalls }) {
  const probes = {
    insider: async (t) => {
      const r = await probeInsider({ ticker: t, days: 90, limit: 40 });
      return { ids: r.ids, items: (r.filings || []).map((f) => ({ id: f.accessionNumber, label: `${(f.displayNames || []).join(", ") || "Form 4"} · filed ${f.filedDate}`, url: f.url })) };
    },
    filing: async (t) => {
      const r = await probeFilings(t, { forms: [...FILING_ALERT_FORMS] });
      // probeCompanyFilings returns { accession, form, filed } rows and
      // `keys` = "<accession>|<FORM>"; the item id is built the same way.
      return {
        ids: r.keys || r.ids,
        items: (r.filings || []).map((f) => ({ id: `${f.accession}|${String(f.form || "").toUpperCase()}`, label: `${f.form} · filed ${f.filed}`, url: f.url })),
      };
    },
    fund: async (t) => {
      const m = /^\d{1,10}$/.test(t) ? await resolveManager({ cik: t }) : await resolveManager({ name: t });
      const l = m?.cik ? await latest13f({ cik: m.cik }) : null;
      return { ids: l?.accessionNumber ? [l.accessionNumber] : [], items: l ? [{ id: l.accessionNumber, label: `13F for the period ended ${l.reportDate} · filed ${l.filedDate}` }] : [] };
    },
    domain: async (t) => {
      const r = await probeDomain(t);
      return { ids: [r.fingerprint], items: [{ id: r.fingerprint, label: `Security posture changed on ${t}` }] };
    },
    recall: async (t) => {
      const r = await probeRecalls(t);
      return { ids: r.ids, items: (r.items || []).map((x) => ({ id: x.recallNumber, label: `${x.classification || "Recall"} · ${String(x.product || "").slice(0, 90)}` })) };
    },
  };
  // A probe whose id space changes carries a new `version`; the engine then
  // re-baselines an alert silently instead of mailing every id the old
  // baseline did not hold. The filing probe narrowed to three forms on
  // 2026-10-02, so a baseline taken before it holds other forms.
  probes.filing.version = "forms:" + FILING_ALERT_FORMS.join(",");
  return probes;
}
