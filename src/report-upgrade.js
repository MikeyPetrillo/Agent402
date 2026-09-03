// report-upgrade - the retention loop between the ONE-SHOT report products and
// the RECURRING monitors. A buyer who paid once for a report on a target is the
// best possible subscriber for a monitor on that same target, so the delivered
// report page and the delivery email both offer the matching monitor with the
// target already filled in.
//
// The mapping is DERIVED from MONITOR_PRODUCTS by `kind`, never a hand-written
// table: a new monitor product whose kind matches an existing report kind wires
// itself up, and a report kind with no monitor (research, dossier) simply has
// no offer rather than a broken link. Label and price always come from the
// product table - a hardcoded "$5 a month" in a page or an email would drift
// silently the day pricing changes.
//
// Nothing here creates a Stripe session. The deep link only PREFILLS the
// storefront (see monitorsPage's `prefill`); starting a checkout stays a POST
// the visitor makes themselves.
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

/**
 * The monitor product that watches the same thing a report kind describes.
 * @param {string} kind  a report kind ("domain", "fund", "recall", "insider", "token", "research", ...)
 * @returns {null | { product: string, label: string, kind: string, price: number, priceUsd: string, inputLabel: string, blurb: string }}
 */
// A report kind with no monitor of its own but an obvious recurring cousin on
// the SAME input. The ticker pack is the highest-value one-shot we sell and had
// no follow-on at all; its insider leg is exactly what a holder wants watched.
// dossier: a company dossier reader is best served by the filing watch (2026-08-28)
const KIND_ALIAS = { ticker: "insider", dossier: "filing" };

export function monitorForKind(kind) {
  const k0 = String(kind ?? "").trim();
  const k = KIND_ALIAS[k0] || k0;
  if (!k) return null;
  for (const [product, p] of Object.entries(MONITOR_PRODUCTS)) {
    if (p.kind === k) return { product, label: p.label, kind: p.kind, price: p.price, priceUsd: priceUsd(p.price), inputLabel: p.inputLabel, blurb: p.blurb };
  }
  return null;
}

/** "$5" / "$12.50" - whole dollars stay whole (prices are cents). */
export function priceUsd(cents) {
  const n = Number(cents || 0) / 100;
  return `$${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}`;
}

/**
 * Deep link that PREFILLS the monitors storefront for one product + target.
 * Every component is URL-encoded, so a hostile target cannot escape the query.
 * This is a GET that fills a form - it never creates a checkout session.
 */
export function monitorPrefillUrl(product, target, baseUrl = "") {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const q = new URLSearchParams();
  if (product) q.set("product", String(product));
  const t = String(target ?? "").trim();
  if (t) q.set("target", t.slice(0, 200));
  const qs = q.toString();
  return `${base}/monitors${qs ? `?${qs}` : ""}`;
}

/**
 * Everything the delivered-report surfaces need for one report kind + target,
 * or null when this kind has no monitor. `url` is the prefill deep link (safe
 * in an email); `product`/`target` are what the page POSTs to /api/subscribe.
 */
export function upgradeOffer(kind, target, baseUrl = "") {
  const m = monitorForKind(kind);
  if (!m) return null;
  const t = String(target ?? "").trim().slice(0, 200);
  return { ...m, target: t, url: monitorPrefillUrl(m.product, t, baseUrl) };
}

/**
 * kind -> { product, label, priceUsd } for every monitor, as JSON for a data
 * attribute the report viewer reads (the site CSP drops inline script, so the
 * product table reaches the client as data, not as code).
 */
export function monitorMapJson() {
  const out = {};
  for (const [product, p] of Object.entries(MONITOR_PRODUCTS)) {
    if (!Object.hasOwn(out, p.kind)) out[p.kind] = { product, label: p.label, priceUsd: priceUsd(p.price) };
  }
  // Aliased report kinds (ticker -> insider, dossier -> filing) get the same
  // entry, so the viewer offers what the email offers.
  for (const [alias, kind] of Object.entries(KIND_ALIAS)) if (out[kind] && !Object.hasOwn(out, alias)) out[alias] = out[kind];
  return JSON.stringify(out);
}
