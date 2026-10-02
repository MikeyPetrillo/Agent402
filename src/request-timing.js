// Per-route server time, split into our own compute and upstream wait, plus
// the in-flight request list the stall log names.
//
// Every request runs inside an AsyncLocalStorage scope; a global fetch wrapper
// adds each outbound call's wall time to the scope it was made in. On finish,
// total = time to response end, upstream = summed outbound wait, compute =
// total - upstream (a floor: overlapping outbound calls make it conservative).
// Samples go into a bounded ring per route key; percentiles are computed on
// read. Route keys are catalog routes or the first two path segments, never
// a query string or a value, and are capped in number.

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();
const RING = 512;
const MAX_KEYS = 300;
const routes = new Map(); // key -> { n, total: Float64Array, upstream: Float64Array, i }
const inflight = new Map(); // id -> { key, at }
let nextId = 1;
// Response counts per minute for the last hour: all requests, 5xx, and the
// paid subset (a payment-bearing request to a priced route) with its 5xx.
const MINUTES = 60;
const minuteBuckets = Array.from({ length: MINUTES }, () => ({ at: 0, total: 0, s5xx: 0, paid: 0, paid5xx: 0 }));
function bucketFor(now) {
  const m = Math.floor(now / 60_000);
  const b = minuteBuckets[m % MINUTES];
  if (b.at !== m) { b.at = m; b.total = 0; b.s5xx = 0; b.paid = 0; b.paid5xx = 0; }
  return b;
}
export function noteResponse(status, paid, now = Date.now(), shed = false) {
  const b = bucketFor(now);
  b.total++; if (status >= 500 && !shed) b.s5xx++;
  if (paid) { b.paid++; if (status >= 500) b.paid5xx++; }
}
/** Response counts over the last `minutes` (default 60). */
export function responseCounts(minutes = 60, now = Date.now()) {
  const m = Math.floor(now / 60_000);
  const out = { total: 0, s5xx: 0, paid: 0, paid5xx: 0 };
  for (const b of minuteBuckets) if (b.at > m - minutes && b.at <= m) { out.total += b.total; out.s5xx += b.s5xx; out.paid += b.paid; out.paid5xx += b.paid5xx; }
  return out;
}
let fetchInstalled = false;

// Catalog routes are RESERVED: they always get their own ring, so a caller
// minting arbitrary paths can fill the free slots but never push a paid route
// into "(other)".
function ringFor(key, reserved = false) {
  let r = routes.get(key);
  if (!r) {
    if (!reserved && routes.size >= MAX_KEYS) key = "(other)";
    r = routes.get(key);
    if (!r) { r = { n: 0, total: new Float64Array(RING), upstream: new Float64Array(RING), i: 0 }; routes.set(key, r); }
  }
  return r;
}

/** Record one finished request. Exported for the offline test. */
export function recordTiming(key, totalMs, upstreamMs, reserved = false) {
  const r = ringFor(key, reserved);
  r.total[r.i] = totalMs;
  r.upstream[r.i] = Math.min(upstreamMs, totalMs);
  r.i = (r.i + 1) % RING;
  r.n++;
}

/** Wrap global fetch so outbound wait is charged to the request that made it. */
export function installRequestTimingFetch() {
  if (fetchInstalled || typeof globalThis.fetch !== "function") return false;
  fetchInstalled = true;
  const orig = globalThis.fetch;
  globalThis.fetch = function timedFetch(...args) {
    const store = als.getStore();
    if (!store) return orig.apply(this, args);
    const t0 = performance.now();
    const p = orig.apply(this, args);
    const done = () => { store.upstreamMs += performance.now() - t0; };
    p.then(done, done);
    return p;
  };
  return true;
}

/** Express middleware. `keyOf(req)` maps a request to its route key. */
export function requestTimingMiddleware(keyOf, isPaid = () => false) {
  return (req, res, next) => {
    const store = { upstreamMs: 0 };
    const t0 = performance.now();
    const id = nextId++;
    let key = "(unknown)", reserved = false;
    try {
      const k = keyOf(req);
      if (k && typeof k === "object") { key = k.key || "(unknown)"; reserved = !!k.reserved; } else key = k || "(unknown)";
    } catch { /* keep default */ }
    inflight.set(id, { key, at: Date.now() });
    let paid = false;
    try { paid = !!isPaid(req); } catch { /* keep false */ }
    const end = () => {
      if (!inflight.delete(id)) return;
      recordTiming(key, performance.now() - t0, store.upstreamMs, reserved);
      noteResponse(res.headersSent ? res.statusCode : 499, paid, Date.now(), !!res.locals?.shed);
    };
    res.on("finish", end);
    res.on("close", end);
    als.run(store, next);
  };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Percentiles per route: total, upstream, compute (ms). Counts only. */
export function routeTimings({ top = 40, minSamples = 1 } = {}) {
  const rows = [];
  for (const [key, r] of routes) {
    const k = Math.min(r.n, RING);
    if (k < minSamples) continue;
    const tot = Array.from(r.total.subarray(0, k)).sort((a, b) => a - b);
    const comp = Array.from(r.total.subarray(0, k), (t, j) => t - r.upstream[j]).sort((a, b) => a - b);
    const up = Array.from(r.upstream.subarray(0, k)).sort((a, b) => a - b);
    rows.push({
      route: key, count: r.n, window: k,
      totalMs: { p50: r1(pct(tot, 0.5)), p95: r1(pct(tot, 0.95)), p99: r1(pct(tot, 0.99)) },
      computeMs: { p50: r1(pct(comp, 0.5)), p95: r1(pct(comp, 0.95)), p99: r1(pct(comp, 0.99)) },
      upstreamMs: { p50: r1(pct(up, 0.5)), p95: r1(pct(up, 0.95)) },
    });
  }
  return rows.sort((a, b) => (b.computeMs.p95 ?? 0) - (a.computeMs.p95 ?? 0)).slice(0, top);
}

/** The oldest in-flight requests (route key + age), for the stall log. */
export function oldestInFlight(n = 3) {
  const now = Date.now();
  return [...inflight.values()].sort((a, b) => a.at - b.at).slice(0, n).map((x) => `${x.key} ${now - x.at}ms`);
}

export function inFlightCount() { return inflight.size; }

/** Test hook. */
export function __resetTimingForTest() { routes.clear(); inflight.clear(); for (const b of minuteBuckets) b.at = 0; }
