// The live model list of the metered chat route's upstream, read so a model
// id the upstream does not serve is refused with a 400 BEFORE any payment
// gate, instead of after a verified payment (the handler's upstream call
// would refuse it anyway, uncharged, but the buyer has signed and we have
// verified for nothing, on every retry).
//
// FAILS OPEN: before the first good read, once the last good read is older
// than MAX_AGE_MS, or on an implausibly small list, no id is refused. Our own
// egress being down must never refuse a working model. A miss also starts a
// fresh read (at most one per MISS_REFRESH_MS, none for REFRESH_MS after a
// failed read), so a model the upstream has just listed is served within a
// minute of its first request. The read is not counted in the upstream's
// health lane (a flapping list must not read as chat failing).
// Read in production only, where the route serves with a key
// (modelCatalogWanted); MODEL_CATALOG_URL points it at a stub (tests).
import { OPENROUTER_ATTRIBUTION } from "./openrouter-attribution.js";

const catalogUrl = () => process.env.MODEL_CATALOG_URL || "https://openrouter.ai/api/v1/models";
const MIN_ENTRIES = 100;
const REFRESH_MS = 10 * 60_000;
const MAX_AGE_MS = 30 * 60_000;
const MISS_REFRESH_MS = 60_000;

let state = null; // { ids: Set<string>, at }
let lastMissRead = 0;
let lastFailedAt = 0;
let inflight = null;
// The failure monitor skips a fetch carrying this key (src/tool-failure-monitor.js).
const NO_OUTCOME = Symbol.for("agent402.noOutcome");

/** Whether this process reads the list: a stub URL, or production with a key. */
export function modelCatalogWanted(env = process.env) {
  if (env.MODEL_CATALOG_URL) return true;
  if (!env.OPENROUTER_API_KEY || env.X402_SYNC_ON_START === "false") return false;
  return env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT_NAME === "production" || env.RAILWAY_ENVIRONMENT === "production";
}

/** One read of the live list. Answers true (read), false (unreadable). */
export async function refreshModelCatalog({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const res = await fetchImpl(catalogUrl(), { headers: { ...OPENROUTER_ATTRIBUTION, Accept: "application/json" }, signal: AbortSignal.timeout(15_000), [NO_OUTCOME]: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const ids = Array.isArray(j?.data) ? j.data.map((m) => String(m?.id || "").toLowerCase()).filter(Boolean) : [];
    if (ids.length < MIN_ENTRIES) throw new Error(`implausible list (${ids.length} entries)`);
    state = { ids: new Set(ids), at: now };
    lastFailedAt = 0;
    return true;
  } catch (e) {
    lastFailedAt = now;
    console.warn(`[model-catalog] live model list unreadable (${String(e?.message || e).slice(0, 120)}); unknown ids are not refused before payment until a read succeeds`);
    return false;
  }
}

function readOnce() {
  if (!inflight) inflight = refreshModelCatalog().finally(() => { inflight = null; });
  return inflight;
}

/** Refresh every REFRESH_MS, unref'd. Idempotent. */
let timer = null;
export function startModelCatalogRefresh() {
  if (timer) return;
  readOnce().catch(() => {});
  timer = setInterval(() => { readOnce().catch(() => {}); }, REFRESH_MS);
  timer.unref?.();
}

export function _setModelCatalogForTest(ids, at = Date.now()) { state = ids ? { ids: new Set(ids.map((x) => String(x).toLowerCase())), at } : null; lastMissRead = 0; lastFailedAt = 0; }

const tokens = (id) => new Set(id.split(/[-/.:_]/).filter(Boolean));
// Edit distance, the closeness of two ids (both bounded to 120 characters).
function distance(a, b) {
  a = a.slice(0, 120); b = b.slice(0, 120);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const MAX_ECHO = 200;

/**
 * The refusal for a canonical model id the fresh live list does not carry,
 * or null (listed, or no fresh list to judge by). A ":variant" suffix is
 * judged by its base id. `suggest(id)` keeps only ids the caller's route
 * serves; up to five, closest first, are named.
 */
export function unknownModelRefusal(model, { now = Date.now(), suggest = () => true, refreshOnMiss = true } = {}) {
  if (!state || !(now - state.at < MAX_AGE_MS)) return null;
  const id = String(model || "").toLowerCase();
  if (!id) return null;
  const base = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  if (state.ids.has(base) || state.ids.has(id)) return null;
  if (refreshOnMiss && now - lastMissRead >= MISS_REFRESH_MS && now - lastFailedAt >= REFRESH_MS) { lastMissRead = now; readOnce().catch(() => {}); }
  const vendor = base.includes("/") ? base.slice(0, base.indexOf("/") + 1) : "";
  const want = tokens(base.slice(vendor.length));
  const near = vendor ? [...state.ids].filter((x) => x.startsWith(vendor) && !x.includes(":") && suggest(x)) : [];
  // Closest first: edit distance, then shared name parts.
  const scored = near.map((x) => ({ x, d: distance(base, x), n: [...tokens(x.slice(vendor.length))].filter((w) => want.has(w)).length }))
    .sort((a, b) => a.d - b.d || b.n - a.n || a.x.localeCompare(b.x));
  const list = scored.slice(0, 5).map((s) => s.x);
  const shown = String(model).length > MAX_ECHO ? `${String(model).slice(0, MAX_ECHO)}…` : String(model);
  return `Model "${shown}" is not a chat model id the upstream serves, so this request cannot be served and was not priced.` +
    (list.length ? ` Ids this route serves from ${vendor.slice(0, -1)} include: ${list.join(", ")}.` : "") +
    " GET /v1/models lists what this route serves. Nothing was charged.";
}
