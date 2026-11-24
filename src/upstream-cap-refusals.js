// The calls this server's own upstream caps refused, counted so the operator
// knows when a cap turns a buyer away.
//
// A cap is a ceiling this server keeps on reads it makes to one upstream (the
// per-registry RDAP day count, the BLS day budget, the Wikipedia suggest
// minute ceiling and queue bound). A call a cap refuses answers 503 before
// anything is sent upstream and before any settle point, so it is never
// charged on a rail that settles after the run; a rail final before the run
// books it owed (a Tempo push transfer) or records it (an AWS payment) the
// way every failed run is. The refusal error carries `capRefusal` (the cap's
// name, CAP_NAMES); the catalog wrapper (withCapRefusalCount, applied once to
// every catalog handler in src/server.js) counts it under that cap and the
// slug that was called. Only refusals count: a cached answer, and a call
// that never reaches the cap, are not reads and are not counted here or by
// the caps themselves.
//
// Read by /__operator/upstream-caps.json (counts per cap and per slug) and
// the public status word `upstreamCaps` on /api/gateway-status: "reached"
// while any cap refused a call within the last hour, else "ok". The status
// Worker and the heartbeat page on "reached" under one issue. This
// process's own counts (production runs one replica); a restart clears them.

export const CAP_NAMES = Object.freeze({
  rdapRegistryDay: "rdap-registry-daily",
  blsDay: "bls-daily",
  suggestRate: "wikipedia-suggest-rate",
});
export const UPSTREAM_CAPS_WINDOW_MS = 60 * 60 * 1000;
const KNOWN = new Set(Object.values(CAP_NAMES));
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SLUGS = 500;

const caps = new Map(); // cap -> { total, lastAt, slugs: Map(slug -> { total, lastAt }) }
let now = () => Date.now();

/** Mark `err` as a refusal by `cap` (returns it). */
export function capRefusal(err, cap) {
  if (err && typeof err === "object" && KNOWN.has(cap)) err.capRefusal = cap;
  return err;
}

/** Count one refusal by `cap` of a call to `slug`. */
export function noteCapRefusal(cap, slug) {
  if (!KNOWN.has(cap)) return false;
  const s = SLUG.test(String(slug || "")) ? String(slug) : "unknown";
  const t = now();
  let c = caps.get(cap);
  if (!c) { c = { total: 0, lastAt: 0, slugs: new Map() }; caps.set(cap, c); }
  c.total++; c.lastAt = t;
  let e = c.slugs.get(s);
  if (!e) {
    if (c.slugs.size >= MAX_SLUGS) { e = c.slugs.get("other") || { total: 0, lastAt: 0 }; c.slugs.set("other", e); }
    else { e = { total: 0, lastAt: 0 }; c.slugs.set(s, e); }
  }
  e.total++; e.lastAt = t;
  return true;
}

/** Wrap a catalog handler so a cap refusal it throws is counted under `slug`. */
export function withCapRefusalCount(slug, handler) {
  if (typeof handler !== "function" || handler.__capCounted) return handler;
  const wrapped = async function capCounted(...args) {
    try { return await handler.apply(this, args); }
    catch (err) {
      if (err && typeof err === "object" && err.capRefusal && !err.__capNoted) {
        try { Object.defineProperty(err, "__capNoted", { value: true }); } catch { /* frozen error */ }
        noteCapRefusal(err.capRefusal, slug);
      }
      throw err;
    }
  };
  Object.defineProperty(wrapped, "__capCounted", { value: true });
  for (const k of Object.keys(handler)) wrapped[k] = handler[k];
  return wrapped;
}

/** "reached" while any cap refused a call within the window, else "ok". */
export function upstreamCapsWord() {
  const t = now();
  for (const c of caps.values()) if (c.lastAt && t - c.lastAt < UPSTREAM_CAPS_WINDOW_MS) return "reached";
  return "ok";
}

/** The operator view: per cap, its total, last refusal and per-slug counts. */
export function upstreamCapRefusals() {
  const out = {};
  for (const name of KNOWN) {
    const c = caps.get(name);
    out[name] = c
      ? { refused: c.total, lastAt: new Date(c.lastAt).toISOString(), bySlug: Object.fromEntries([...c.slugs].map(([s, e]) => [s, { refused: e.total, lastAt: new Date(e.lastAt).toISOString() }])) }
      : { refused: 0, lastAt: null, bySlug: {} };
  }
  return { word: upstreamCapsWord(), windowMinutes: UPSTREAM_CAPS_WINDOW_MS / 60000, sinceBoot: true, caps: out };
}

export const __test = {
  reset() { caps.clear(); now = () => Date.now(); },
  setClock(fn) { now = typeof fn === "function" ? fn : () => Date.now(); },
};
