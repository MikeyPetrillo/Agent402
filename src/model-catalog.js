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
// A stated context window above this is not plausible and is not read.
const MAX_CONTEXT_TOKENS = 100_000_000;

let state = null; // { ids: Set<string>, ctx: Map<string, number>, at }
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
    const rows = Array.isArray(j?.data) ? j.data : [];
    const ids = rows.map((m) => String(m?.id || "").toLowerCase()).filter(Boolean);
    if (ids.length < MIN_ENTRIES) throw new Error(`implausible list (${ids.length} entries)`);
    // Each id's context window in tokens, where the list states a plausible one.
    const ctx = new Map();
    for (const m of rows) {
      const id = String(m?.id || "").toLowerCase();
      const n = Number(m?.context_length);
      if (id && Number.isInteger(n) && n > 0 && n <= MAX_CONTEXT_TOKENS) ctx.set(id, n);
    }
    state = { ids: new Set(ids), ctx, at: now };
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

/** Test seam: `ids` is a list of ids, `ctx` an optional { id: tokens } map. */
export function _setModelCatalogForTest(ids, at = Date.now(), ctx = {}) {
  state = ids ? { ids: new Set(ids.map((x) => String(x).toLowerCase())), ctx: new Map(Object.entries(ctx).map(([k, v]) => [k.toLowerCase(), v])), at } : null;
  lastMissRead = 0; lastFailedAt = 0;
}

const fresh = (now) => !!state && now - state.at < MAX_AGE_MS;
/** True only when a fresh live list carries this exact id (case folded). */
export function isListedModel(id, now = Date.now()) {
  return fresh(now) && state.ids.has(String(id || "").toLowerCase());
}
/** The context window (tokens) the fresh live list states for an id, judged
 *  by its base id when it carries a ":variant"; null when unknown. */
export function contextTokensOf(id, now = Date.now()) {
  if (!fresh(now)) return null;
  const s = String(id || "").toLowerCase();
  const base = s.includes(":") ? s.slice(0, s.indexOf(":")) : s;
  return state.ctx.get(s) ?? state.ctx.get(base) ?? null;
}
/** Ids on the fresh list (no ":variant" ids) whose stated window is at least
 *  `minTokens` and that `keep(id)` admits, as { id, contextTokens }; empty
 *  with no fresh list. */
export function listedModelsWithContext(minTokens, keep = () => true, now = Date.now()) {
  if (!fresh(now)) return [];
  const out = [];
  for (const [id, n] of state.ctx) if (n >= minTokens && !id.includes(":") && keep(id)) out.push({ id, contextTokens: n });
  return out;
}

const tokens = (id) => new Set(id.split(/[-/.:_]/).filter(Boolean));
// Edit distance, the closeness of two ids. Both loops run at most
// DISTANCE_MAX_CHARS times, whatever the caller's id length.
const DISTANCE_MAX_CHARS = 120;
function distance(a, b) {
  const n = Math.min(String(a).length, DISTANCE_MAX_CHARS);
  const m = Math.min(String(b).length, DISTANCE_MAX_CHARS);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}
const MAX_ECHO = 200;

// The id with every digit-hyphen-digit read as a dotted version ("v4-1" as
// "v4.1"), so a caller who hyphenated a version is ranked against the id it
// most likely meant. Linear: one character class and a lookahead.
const dotted = (id) => id.replace(/(\d)-(?=\d)/g, "$1.");
/** At most this many machine-readable suggestions ride on a refusal. */
export const MAX_SUGGESTIONS = 3;

/**
 * The refusal for a canonical model id the fresh live list does not carry,
 * or null (listed, or no fresh list to judge by): `{ message, suggestions }`
 * with `suggestions` the closest ids first (at most MAX_SUGGESTIONS). A
 * ":variant" suffix is judged by its base id. `suggest(id)` keeps only ids
 * the caller's route serves; up to five, closest first, are named in the
 * message.
 */
export function unknownModelVerdict(model, { now = Date.now(), suggest = () => true, refreshOnMiss = true } = {}) {
  if (!fresh(now)) return null;
  const id = String(model || "").toLowerCase();
  if (!id) return null;
  const base = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  if (state.ids.has(base) || state.ids.has(id)) return null;
  if (refreshOnMiss && now - lastMissRead >= MISS_REFRESH_MS && now - lastFailedAt >= REFRESH_MS) { lastMissRead = now; readOnce().catch(() => {}); }
  const vendor = base.includes("/") ? base.slice(0, base.indexOf("/") + 1) : "";
  const want = tokens(base.slice(vendor.length));
  const near = vendor ? [...state.ids].filter((x) => x.startsWith(vendor) && !x.includes(":") && suggest(x)) : [];
  // Closest first: edit distance (to the id as sent, or to it with its
  // hyphenated versions dotted, whichever is nearer), then shared name parts.
  const alt = base.length <= DISTANCE_MAX_CHARS ? dotted(base) : base;
  const scored = near.map((x) => ({ x, d: alt === base ? distance(base, x) : Math.min(distance(base, x), distance(alt, x)), n: [...tokens(x.slice(vendor.length))].filter((w) => want.has(w)).length }))
    .sort((a, b) => a.d - b.d || b.n - a.n || a.x.localeCompare(b.x));
  const list = scored.slice(0, 5).map((s) => s.x);
  const shown = String(model).length > MAX_ECHO ? `${String(model).slice(0, MAX_ECHO)}…` : String(model);
  const message = `Model "${shown}" is not a chat model id the upstream serves, so this request cannot be served and was not priced.` +
    (list.length ? ` Ids this route serves from ${vendor.slice(0, -1)} include: ${list.join(", ")}.` : "") +
    " GET /v1/models lists what this route serves. Nothing was charged.";
  return { message, suggestions: list.slice(0, MAX_SUGGESTIONS) };
}

/** The refusal message alone (unknownModelVerdict), or null. */
export function unknownModelRefusal(model, opts = {}) {
  return unknownModelVerdict(model, opts)?.message ?? null;
}
