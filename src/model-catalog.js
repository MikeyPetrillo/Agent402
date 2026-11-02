// The live model list of the metered chat route's upstream, read so a model
// id the upstream does not serve is refused with a 400 BEFORE any payment
// gate, instead of after a verified payment (the handler's upstream call
// would refuse it anyway, uncharged, but the buyer has signed and we have
// verified for nothing, on every retry).
//
// FAILS OPEN: before the first good read, after a failed read once the last
// good one is stale, or on an implausibly small list, no id is refused. Our
// own egress being down must never refuse a working model.
// MODEL_CATALOG_URL points the read elsewhere (a test stub).
const catalogUrl = () => process.env.MODEL_CATALOG_URL || "https://openrouter.ai/api/v1/models";
const MIN_ENTRIES = 100;
const REFRESH_MS = 60 * 60_000;
const MAX_AGE_MS = 3 * 60 * 60_000;

let state = null; // { ids: Set<string>, at }

/** One read of the live list. Answers true (read), false (unreadable). */
export async function refreshModelCatalog({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const res = await fetchImpl(catalogUrl(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const ids = Array.isArray(j?.data) ? j.data.map((m) => String(m?.id || "").toLowerCase()).filter(Boolean) : [];
    if (ids.length < MIN_ENTRIES) throw new Error(`implausible list (${ids.length} entries)`);
    state = { ids: new Set(ids), at: now };
    return true;
  } catch (e) {
    console.warn(`[model-catalog] live model list unreadable (${String(e?.message || e).slice(0, 120)}); unknown ids are not refused before payment until a read succeeds`);
    return false;
  }
}

/** Hourly refresh, unref'd. Idempotent. */
let timer = null;
export function startModelCatalogRefresh() {
  if (timer) return;
  refreshModelCatalog().catch(() => {});
  timer = setInterval(() => { refreshModelCatalog().catch(() => {}); }, REFRESH_MS);
  timer.unref?.();
}

export function _setModelCatalogForTest(ids, at = Date.now()) { state = ids ? { ids: new Set(ids.map((x) => String(x).toLowerCase())), at } : null; }

/**
 * The refusal for a canonical model id the fresh live list does not carry,
 * naming up to five listed ids from the same vendor, or null (listed, or no
 * fresh list to judge by). A ":variant" suffix is judged by its base id.
 */
export function unknownModelRefusal(model, { now = Date.now() } = {}) {
  if (!state || !(now - state.at < MAX_AGE_MS)) return null;
  const id = String(model || "").toLowerCase();
  if (!id) return null;
  const base = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  if (state.ids.has(base) || state.ids.has(id)) return null;
  const vendor = base.includes("/") ? base.slice(0, base.indexOf("/") + 1) : "";
  const near = vendor ? [...state.ids].filter((x) => x.startsWith(vendor) && !x.includes(":")).sort() : [];
  const pick = near.filter((x) => { const a = base.split(/[-/.]/); return x.split(/[-/.]/).filter((w) => a.includes(w)).length >= 2; });
  const list = (pick.length ? pick : near).slice(0, 5);
  return `Model "${model}" is not a model id the upstream serves, so this request cannot be served and was not priced.` +
    (list.length ? ` Listed ${vendor.slice(0, -1)} ids include: ${list.join(", ")}.` : "") +
    " GET /v1/models lists what this route serves. Nothing was charged.";
}
