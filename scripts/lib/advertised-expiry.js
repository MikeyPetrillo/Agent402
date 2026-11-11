// The live-catalog guard's rule for ADVERTISED ids (scripts/test-gateway-model-ids.js,
// rule 5d): a model id a tier lists by name, or GET /v1/models prints, is one a
// caller reads and sends verbatim. When the upstream stamps it with an
// expiration date inside the warning window, the id needs a decided successor
// before that day: a RETIRING_MODELS entry dated on or before the upstream
// date. Without one the id is a finding. Pure, so the offline suite grades it
// on stub catalogs (scripts/test-model-drift-redaction.js).

const expiryOf = (m) => m?.expiration_date || m?.deprecation_date || null;
const dayStart = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);

/** Every id a caller can read off a tier list: each concrete prefix (a family
 *  prefix ends in "/" and names no id) and every exact id /v1/models prints. */
export function advertisedIds(tiers, listedIds = []) {
  const out = new Set();
  for (const tier of Object.values(tiers || {})) for (const p of tier?.prefixes || []) if (!p.endsWith("/")) out.add(p);
  for (const id of listedIds) if (typeof id === "string" && id.includes("/") && !id.endsWith("*")) out.add(id);
  return out;
}

/** Advertised ids whose upstream date falls before `now + windowMs`, each as
 *  `{ id, expires, covered, successor }`. `covered` is true when `retiring`
 *  carries the id with a successor that takes over on or before that date. */
export function advertisedExpiring({ models, advertised, retiring = {}, now = Date.now(), windowMs = 14 * 86_400_000 }) {
  const out = [];
  for (const m of models || []) {
    const expires = expiryOf(m);
    if (!advertised.has(m.id) || !expires) continue;
    const at = Date.parse(expires);
    if (!Number.isFinite(at) || at >= now + windowMs) continue;
    const entry = Object.hasOwn(retiring, m.id) ? retiring[m.id] : null;
    const covered = !!entry?.use && Number.isFinite(dayStart(entry.until)) && dayStart(entry.until) <= dayStart(expires);
    out.push({ id: m.id, expires, covered, successor: entry?.use || null });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
