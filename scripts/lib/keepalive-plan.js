// Route selection, spend caps and the burner low-water figure for the Bazaar
// keep-alive passes. Pure functions over /api/pricing rows. The one import is
// the server's own lasting-effect list (src/lasting-effect-slugs.js, itself
// import-free), so the heartbeat can run the CLI (scripts/keepalive-plan.js)
// without an install.
//
// Three passes read this:
//   - the scheduled pass above the weekly keep-alive's per-route ceiling
//     (.github/workflows/bazaar-keepalive-tail.yml), every route priced above
//     KEEPALIVE_CEILING_USD that is not an exempt kind;
//   - the deploy job's one buy of each route whose fixed price changed
//     (scripts/keepalive-plan.js changed, from deploy.yml), same exempt kinds;
//   - the heartbeat's burner low-water mark, one above-ceiling pass plus a
//     margin (burnerLowWaterUsd).
//
// Money is counted in integer micro-USD: a sum of float dollars drifts.
import { hasLastingEffect } from "../../src/lasting-effect-slugs.js";

/** The weekly keep-alive's per-route ceiling (bazaar-keepalive.yml's
 *  max_price_usd default). The scheduled tail pass buys what is above it. */
export const KEEPALIVE_CEILING_USD = 0.10;

/** "$0.010", "0.5", 0.5 -> 500000 (micro-USD); unreadable -> 0. */
export function usdMicros(price) {
  const n = typeof price === "number" ? price : Number(String(price ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : 0;
}

export const microsToUsd = (m) => Math.round(m) / 1e6;

/** Why a route is never bought by these passes, or null. A quoted route's list
 *  price is a floor (its 402 asks what the input costs); a model-priced route's
 *  price follows the model a caller names; a route whose effect outlives the
 *  answer (the server's list, src/lasting-effect-slugs.js: it spends our own
 *  wallet, buys from an outside seller, or writes something lasting, such as
 *  the route-execute tiers, seller-payability, the flight tools, attest and
 *  the memory writers) is never bought by a scheduled pass (the route-execute
 *  tiers have their own request, scripts/mint-bazaar-rows.js --expensive).
 *  A row that carries the server's flags is read by them too. */
export function exemptKind(row) {
  if (!row || typeof row !== "object") return "unreadable";
  if (row.quoted === true) return "quoted";
  if (row.pricedByModel === true) return "model-priced";
  if (typeof row.slug === "string" && /^route-execute(-|$)/.test(row.slug)) return "route-execute";
  if (hasLastingEffect(row.slug) || row.lastingEffect === true || row.spendsOwnWallet === true || row.paysThirdPartySeller === true) return "lasting-effect";
  return null;
}

// A slug outside this shape is not bought: the plan's slug list goes into a
// workflow output and an env value, so it carries only kebab-case names.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const rowsOf = (pricing) => (Array.isArray(pricing) ? pricing : pricing?.endpoints || pricing?.tools || [])
  .filter((r) => r && typeof r === "object" && SLUG_RE.test(String(r.slug)));

/** The scheduled tail pass: every fixed-price route priced above the ceiling,
 *  exempt kinds left out, cheapest first. */
export function aboveCeilingRoutes(pricing, { ceilingUsd = KEEPALIVE_CEILING_USD } = {}) {
  const ceiling = usdMicros(ceilingUsd);
  return rowsOf(pricing)
    .filter((r) => typeof r.path === "string")
    .map((r) => ({ slug: r.slug, path: r.path, method: String(r.method || "GET").toUpperCase(), micros: usdMicros(r.price), exempt: exemptKind(r) }))
    .filter((r) => r.micros > ceiling && !r.exempt)
    .sort((a, b) => a.micros - b.micros || a.slug.localeCompare(b.slug));
}

/** Total list price of a set of routes, in micro-USD. */
export const passMicros = (routes) => routes.reduce((s, r) => s + (r.micros || 0), 0);

/** Whether a whole pass may start: its estimate must be at or under the cap.
 *  A cap that is not a positive number refuses everything. */
export function spendCapVerdict(routes, capUsd) {
  const est = passMicros(routes);
  const cap = usdMicros(capUsd);
  const ok = cap > 0 && est <= cap;
  return { ok, estUsd: microsToUsd(est), capUsd: microsToUsd(cap), reason: ok ? null : cap > 0 ? "estimate over the cap" : "no cap set" };
}

/** The most routes one deploy's price-change buy takes (deploy.yml passes
 *  MAX_ROUTES): a deploy that changes more prices than this is a repricing,
 *  bought by a hand pass, not inside the deploy job. */
export const PRICE_CHANGE_MAX_ROUTES = 25;

/** Whether a set of routes is within a route-count cap; a cap that is not a
 *  positive integer refuses everything. */
export function routeCountVerdict(routes, maxRoutes) {
  const max = Number(maxRoutes);
  const ok = Number.isInteger(max) && max > 0 && routes.length <= max;
  return { ok, reason: ok ? null : "over the route-count cap" };
}

/** slug -> { path, micros, exempt } of the live catalog, the snapshot the
 *  deploy job takes before it ships a build. */
export function priceSnapshot(pricing) {
  const out = {};
  for (const r of rowsOf(pricing)) {
    out[r.slug] = { path: r.path, method: String(r.method || "GET").toUpperCase(), micros: usdMicros(r.price), exempt: exemptKind(r) };
  }
  return out;
}

/** Routes whose fixed price differs between two snapshots: present in both,
 *  not an exempt kind in the new one, both prices readable. A new route is not
 *  a price change (the register pass lists it), nor is a removed one. */
export function changedPriceRoutes(before, after) {
  const out = [];
  for (const [slug, now] of Object.entries(after || {})) {
    const was = before?.[slug];
    if (!was || now.exempt || !(now.micros > 0) || !(was.micros > 0)) continue;
    if (was.micros !== now.micros) out.push({ slug, path: now.path, method: now.method, micros: now.micros, beforeMicros: was.micros });
  }
  return out.sort((a, b) => a.micros - b.micros || a.slug.localeCompare(b.slug));
}

/** The margin over one pass: a quarter of it, never under MIN_MARGIN_USD
 *  (the rest of the burner's scheduled buying between top-ups). */
export const MARGIN_FRACTION = 0.25;
export const MIN_MARGIN_USD = 5;

/** The burner's low-water mark: one full above-ceiling pass plus the margin,
 *  rounded up to a whole dollar. Never below `floorUsd` (the repo variable the
 *  alarm read before). */
export function burnerLowWaterUsd(passUsd, { marginFraction = MARGIN_FRACTION, minMarginUsd = MIN_MARGIN_USD, floorUsd = 0 } = {}) {
  const pass = Math.max(0, Number(passUsd) || 0);
  const margin = Math.max(minMarginUsd, pass * marginFraction);
  // Round in cents first so 20.000000001 does not become 21.
  const derived = Math.ceil(Math.round((pass + margin) * 100) / 100);
  return Math.max(derived, Number(floorUsd) || 0);
}
