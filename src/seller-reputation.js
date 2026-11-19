// Seller reputation: what our own observations say about an outside seller.
//
// Every figure here is something this server measured itself, from two
// sources and nothing else:
//   1. the seller index's crawl (src/x402-index.js): whether the seller's own
//      documents answered, whether its paid route answered an unpaid request
//      with a 402 and how long that took, and whether the price that 402 asks
//      matches the price the seller's own documents list;
//   2. the router's own paid calls to the seller (src/x402-buyer.js,
//      src/tempo-buyer.js): did a purchase settle and answer, or was it a
//      delivery failure the router struck.
// Each is a measurement of the SELLER, not of its buyers. No score here reads
// a payment count, a buyer count or a settlement total, so our own wallets,
// router purchases and test traffic can never stand in for buyer evidence,
// and a seller's private net settlement figure is not part of the record at
// all. The router's paid calls count only as delivery observations, and only
// for a request that is not ours (our canaries, our own wallets, a heartbeat
// probe) on a server that runs the production crawl (src/crawl-switch.js).
//
// A score is published only over a sample large enough to mean something
// (MIN_SAMPLES); below it the metric reads "not-enough-data" with the sample
// it has. Every metric names its method, window, sample size and when it was
// last measured.
//
// Computed off the request path: a leased pass (REPUTATION_INTERVAL_MS, one
// replica at a time) walks the index once, folds each seller's newest crawl
// and paywall reading into a compact per-day record, and stores the whole
// record as one state document. Every replica reads that document; a lookup
// reads one seller's record (O(window days)), never the index.
import { createJsonDocument } from "./json-document.js";
import { leased } from "./state-db.js";
import { contained } from "./contained-turn.js";
import { currentRequestScope } from "./request-timing.js";
import { priceToMicroUsd } from "./price-usd.js";
import { registerMemoryStore } from "./memory-stores.js";
import { repoUrl } from "./repo-link.js";

/** The method document (the project wiki). */
export const REPUTATION_METHOD_URL = repoUrl("wiki/Seller-Reputation");

export const REPUTATION_DOC = "seller-reputation";
export const DELIVERY_DOC = "seller-delivery-outcomes";
export const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
// The smallest sample each metric is scored on.
export const MIN_SAMPLES = Object.freeze({
  manifestUptime: 10,
  paywallUptime: 5,
  responsiveness: 5,
  priceHonesty: 3,
  delivery: 5,
  toolDelivery: 5,
});
// A paywall answer at or under this many milliseconds counts as responsive.
export const RESPONSIVE_MS = 2000;
// The overall score's weights, renormalized over the components that are
// scored. It is published only when both uptime components are scored.
export const OVERALL_WEIGHTS = Object.freeze({
  paywallUptime: 0.3,
  delivery: 0.25,
  manifestUptime: 0.2,
  priceHonesty: 0.15,
  responsiveness: 0.1,
});
// A live price within this share of the listed one reads as a match (a
// rounding of the same figure, never a different price).
export const PRICE_MATCH_TOLERANCE = 0.01;
const LATENCY_KEEP = 30;          // newest paywall latencies per seller
const MAX_ROUTES_PER_ORIGIN = 64; // delivery routes kept per seller
const PENDING_MAX_ORIGINS = 500;  // unflushed delivery origins per process

const envInt = (name, dflt, min = 0) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
};
export const MAX_SELLERS = () => envInt("SELLER_REPUTATION_MAX_SELLERS", 8000, 1);
export const MAX_DELIVERY_ORIGINS = () => envInt("SELLER_REPUTATION_MAX_DELIVERY_ORIGINS", 4000, 1);
export const REPUTATION_INTERVAL_MS = () => envInt("SELLER_REPUTATION_INTERVAL_MS", 3_600_000, 1000);
export const REPUTATION_FIRST_MS = () => envInt("SELLER_REPUTATION_FIRST_MS", 600_000, 0);
export const DELIVERY_FLUSH_MS = () => envInt("SELLER_REPUTATION_FLUSH_MS", 60_000, 1000);
// Sellers folded per event-loop turn in the pass.
const PASS_STEP = 200;

// The delivery metric's label, on every surface that shows it. It is an
// observation of the seller's answers to those purchases, never a count of
// buyers, sales or settlements, and nothing that qualifies or ranks a seller
// for the router reads it.
export const DELIVERY_LABEL = "measured from purchases Agent402's router made for buyers";

export const METHODS = Object.freeze({
  manifestUptime: "each pass records the seller's newest crawl, if newer than the last one recorded: 1 when its own documents answered with routes, 0 when the seller's host answered with an error or nothing usable; a read that failed on our side (our time limit, resolver or size limit), a robots.txt exclusion and a registry-only record are left out",
  paywallUptime: "each pass records the newest unpaid probe of the seller's cheapest paid route, if newer than the last one recorded: 1 when it answered 402, 0 for any other status; a probe that read no status or a malformed-request answer (400, 415, 422) is left out",
  responsiveness: `time from our unpaid paywall probe to the seller's response headers, measured from this server; the score is the share of probes answered within ${RESPONSIVE_MS} ms, beside the median`,
  priceHonesty: "routes whose 402 we read live in the window and whose own documents list a price: the share where the price the 402 asks matches the listed price",
  delivery: `${DELIVERY_LABEL}: 1 when the seller answered 200 after taking the payment, 0 when the router recorded a delivery failure (a 5xx after payment, or a 4xx the seller or the chain shows was charged); a caller's own input error, and calls made for our own probes, canaries and wallets, are left out`,
});
export const REPUTATION_LEGEND = `Measured by this server from its own crawl and paid calls, over a rolling ${WINDOW_DAYS}-day window. A metric is scored (0 to 1) only when its sample reaches minSampleSize; below that it reads not-enough-data. No metric counts payments or buyers: router purchases, our own wallets and test traffic are never buyer evidence, and settlement counts are not part of this record. Each metric's method field states how it is measured.`;

const dayOf = (ms) => Math.floor(Number(ms) / DAY_MS);
const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
const round3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- the fold
// A per-day series is one flat array [day, ok, n, day, ok, n, ...], newest
// last: small integers only, so 8000 sellers stay a few megabytes.
function addBucket(series, day, ok) {
  const s = Array.isArray(series) ? series : [];
  const i = s.length - 3;
  if (i >= 0 && s[i] === day) { s[i + 1] += ok ? 1 : 0; s[i + 2] += 1; }
  else s.push(day, ok ? 1 : 0, 1);
  return s;
}
function pruneSeries(series, now) {
  if (!Array.isArray(series) || !series.length) return [];
  const from = dayOf(now) - WINDOW_DAYS + 1;
  let k = 0;
  while (k < series.length && series[k] < from) k += 3;
  return k ? series.slice(k) : series;
}
/** { ok, n, lastDay } over the window. */
export function seriesTotals(series, now = Date.now()) {
  const from = dayOf(now) - WINDOW_DAYS + 1;
  let ok = 0, n = 0, lastDay = null;
  if (Array.isArray(series)) {
    for (let i = 0; i + 2 < series.length; i += 3) {
      if (series[i] < from) continue;
      ok += Number(series[i + 1]) || 0;
      n += Number(series[i + 2]) || 0;
      lastDay = series[i];
    }
  }
  return { ok, n, lastDay };
}

/** The seller's newest crawl as a sample: 1, 0, or null (not the seller's answer). */
export function crawlOutcome(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.robotsBlocked) return null;
  if (entry.error) return entry.errorOurs ? null : 0;
  if (entry.originResponded === false) return 0;
  // A record seeded from a registry listing without a read of the origin.
  if (entry.source === "bazaar-fallback" && entry.originResponded !== true) return null;
  return 1;
}
/** The newest paywall verdict as a sample: { ok, ms } or null when it read no verdict. */
export function paywallOutcome(pw) {
  if (!pw || typeof pw !== "object") return null;
  if (pw.unknown === true || pw.ok === null || pw.ok === undefined) return null;
  if (pw.ok === false && !(Number(pw.status) > 0)) return null;
  const ms = Number(pw.ms);
  return { ok: pw.ok === true, ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null };
}
/** Does a live price match the listed one? Both in micro-USD. */
export function priceMatches(live, listed) {
  if (!(live > 0) || !(listed > 0)) return false;
  if (live === listed) return true;
  return Math.abs(live - listed) / listed <= PRICE_MATCH_TOLERANCE;
}
/** When a row's 402 was last read, or 0. */
export function liveReadAt(t) {
  return Math.max(Number(t?.quoteObservedAt) || 0, Number(t?.networksVerifiedAt) || 0);
}
/** One row's price reading: { live, listed, at, matches } or null when it has none in the window. */
export function rowPriceReading(t, now = Date.now()) {
  if (!t || typeof t !== "object" || t.quoteRetiredAt) return null;
  const at = liveReadAt(t);
  if (!(at > 0) || now - at > WINDOW_DAYS * DAY_MS) return null;
  const listed = priceToMicroUsd(t.originDeclaredPrice);
  const live = priceToMicroUsd(t.price);
  if (!(listed > 0) || !(live > 0)) return null;
  return { live, listed, at, matches: priceMatches(live, listed) };
}
/** [read, matched, newestAt] over a seller's rows, or null when none was read. */
export function priceSnapshot(tools, now = Date.now()) {
  let read = 0, matched = 0, newest = 0;
  for (const t of Array.isArray(tools) ? tools : []) {
    const r = rowPriceReading(t, now);
    if (!r) continue;
    read++;
    if (r.matches) matched++;
    if (r.at > newest) newest = r.at;
  }
  return read ? [read, matched, newest] : null;
}

/**
 * Fold one index entry into its reputation record (a new record when `rec`
 * is empty). Pure apart from mutating `rec`; returns it.
 * Record: f first observed, s last seen in the index, lc/lp the newest crawl
 * and paywall timestamps recorded, c/p per-day crawl and paywall series,
 * l [day, ms, ...] newest paywall latencies, q the price snapshot.
 */
export function foldEntry(rec, entry, now = Date.now()) {
  const r = rec && typeof rec === "object" ? rec : { f: now, lc: 0, lp: 0, c: [], p: [], l: [] };
  r.s = now;
  const fetchedAt = Number(entry?.fetchedAt);
  if (fetchedAt > (Number(r.lc) || 0)) {
    r.lc = fetchedAt;
    const o = crawlOutcome(entry);
    if (o !== null) r.c = addBucket(r.c, dayOf(fetchedAt), o === 1);
  }
  const pw = entry?.paywall;
  const at = Number(pw?.at);
  if (at > (Number(r.lp) || 0)) {
    r.lp = at;
    const o = paywallOutcome(pw);
    if (o) {
      r.p = addBucket(r.p, dayOf(at), o.ok);
      if (o.ms !== null) {
        const l = Array.isArray(r.l) ? r.l : [];
        l.push(dayOf(at), o.ms);
        r.l = l.length > LATENCY_KEEP * 2 ? l.slice(l.length - LATENCY_KEEP * 2) : l;
      }
    }
  }
  const q = priceSnapshot(entry?.tools, now);
  if (q) r.q = q; else delete r.q;
  r.c = pruneSeries(r.c, now);
  r.p = pruneSeries(r.p, now);
  if (Array.isArray(r.l)) {
    const from = dayOf(now) - WINDOW_DAYS + 1;
    let k = 0;
    while (k < r.l.length && r.l[k] < from) k += 2;
    if (k) r.l = r.l.slice(k);
  }
  return r;
}

/** Keep the records of sellers seen in the window, at most `max`, newest seen first. */
export function pruneSellers(sellers, now = Date.now(), max = MAX_SELLERS()) {
  const out = {};
  const live = Object.entries(sellers || {}).filter(([, r]) => r && now - (Number(r.s) || 0) <= WINDOW_DAYS * DAY_MS);
  live.sort((a, b) => (Number(b[1].s) || 0) - (Number(a[1].s) || 0));
  for (const [o, r] of live.slice(0, max)) out[o] = r;
  return out;
}

// ---------------------------------------------------------------- scoring
function metric(name, { score = null, sampleSize = 0, minSampleSize, lastMeasuredAt = null, extra = {} }) {
  const enough = sampleSize >= minSampleSize && score !== null;
  return {
    status: enough ? "scored" : "not-enough-data",
    score: enough ? round3(score) : null,
    sampleSize,
    minSampleSize,
    windowDays: WINDOW_DAYS,
    lastMeasuredAt,
    ...(enough ? extra : {}),
    method: METHODS[name] || null,
  };
}
const lastDayIso = (day, exact) => (Number(exact) > 0 ? iso(exact) : day == null ? null : iso(day * DAY_MS));
function ratioMetric(name, series, min, now, exactAt = 0) {
  const t = seriesTotals(series, now);
  return metric(name, { score: t.n ? t.ok / t.n : null, sampleSize: t.n, minSampleSize: min, lastMeasuredAt: t.n ? lastDayIso(t.lastDay, exactAt) : null });
}
function latencyMetric(l, now, exactAt = 0) {
  const from = dayOf(now) - WINDOW_DAYS + 1;
  const ms = [];
  let lastDay = null;
  if (Array.isArray(l)) for (let i = 0; i + 1 < l.length; i += 2) if (l[i] >= from && Number.isFinite(l[i + 1])) { ms.push(l[i + 1]); lastDay = l[i]; }
  const sorted = ms.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const fast = ms.filter((x) => x <= RESPONSIVE_MS).length;
  return metric("responsiveness", {
    score: ms.length ? fast / ms.length : null, sampleSize: ms.length, minSampleSize: MIN_SAMPLES.responsiveness,
    lastMeasuredAt: ms.length ? lastDayIso(lastDay, exactAt) : null,
    extra: { medianMs: median, thresholdMs: RESPONSIVE_MS },
  });
}
function priceMetric(q, now) {
  const fresh = Array.isArray(q) && now - (Number(q[2]) || 0) <= WINDOW_DAYS * DAY_MS ? q : null;
  return metric("priceHonesty", {
    score: fresh && fresh[0] ? fresh[1] / fresh[0] : null, sampleSize: fresh ? Number(fresh[0]) || 0 : 0,
    minSampleSize: MIN_SAMPLES.priceHonesty, lastMeasuredAt: fresh ? iso(fresh[2]) : null,
  });
}
/** The overall score: a weighted mean of the scored components, published only
 *  when both uptime components are scored. */
export function overallOf(metrics) {
  const used = Object.keys(OVERALL_WEIGHTS).filter((k) => metrics[k]?.status === "scored");
  const ready = metrics.manifestUptime?.status === "scored" && metrics.paywallUptime?.status === "scored";
  let w = 0, sum = 0;
  for (const k of used) { w += OVERALL_WEIGHTS[k]; sum += OVERALL_WEIGHTS[k] * metrics[k].score; }
  return {
    status: ready ? "scored" : "not-enough-data",
    score: ready && w > 0 ? round3(sum / w) : null,
    components: ready ? used : [],
    weights: OVERALL_WEIGHTS,
    method: "the weighted mean of the scored components, the weights renormalized over those scored; published only when both manifestUptime and paywallUptime are scored",
  };
}

/** The reputation record served for one seller (rec and delivery may be absent). */
export function reputationOf({ rec = null, delivery = null, since = null, updatedAt = null, state = "ready", now = Date.now() } = {}) {
  const metrics = {
    manifestUptime: ratioMetric("manifestUptime", rec?.c, MIN_SAMPLES.manifestUptime, now, rec?.lc),
    paywallUptime: ratioMetric("paywallUptime", rec?.p, MIN_SAMPLES.paywallUptime, now, rec?.lp),
    responsiveness: latencyMetric(rec?.l, now, rec?.lp),
    priceHonesty: priceMetric(rec?.q, now),
    delivery: { ...ratioMetric("delivery", delivery?.d, MIN_SAMPLES.delivery, now), label: DELIVERY_LABEL },
  };
  return {
    recordState: state,
    overall: overallOf(metrics),
    metrics,
    age: {
      firstObservedAt: iso(rec?.f),
      observedDays: Number(rec?.f) > 0 ? Math.max(0, Math.floor((now - Number(rec.f)) / DAY_MS)) : 0,
      recordsSince: iso(since),
      note: "when this record first saw the seller in the index; a seller listed before recordsSince reads that date",
    },
    computedAt: iso(updatedAt),
    windowDays: WINDOW_DAYS,
    legend: REPUTATION_LEGEND,
    methodDoc: REPUTATION_METHOD_URL,
  };
}

/** Short labels for the market page's reputation line, in display order. */
export const METRIC_LABELS = Object.freeze({
  manifestUptime: "documents up",
  paywallUptime: "402 up",
  responsiveness: "responsive",
  priceHonesty: "price as listed",
  delivery: `delivered (${DELIVERY_LABEL})`,
});

/** The pathname key a delivery is recorded under. */
export function routeKeyOf(method, url) {
  try {
    const u = new URL(String(url));
    return `${String(method || "GET").toUpperCase()} ${u.pathname.replace(/\/+$/, "") || "/"}`;
  } catch { return null; }
}
/** One tool row's reputation, compact (the method and window are stated once,
 *  in TOOL_REPUTATION_LEGEND): its price reading and the router's delivery on it. */
export function toolReputationOf(t, { routes = null, url = null, now = Date.now() } = {}) {
  const r = rowPriceReading(t, now);
  const at = liveReadAt(t);
  const price = r
    ? { status: r.matches ? "matches" : "differs", listedPrice: r.listed / 1e6, livePrice: r.live / 1e6, measuredAt: iso(r.at) }
    : { status: "not-measured", measuredAt: at > 0 && now - at <= WINDOW_DAYS * DAY_MS ? iso(at) : null };
  const key = url ? routeKeyOf(t?.method, url) : null;
  const series = key && routes && typeof routes === "object" ? routes[key] : null;
  const tot = seriesTotals(series, now);
  const enough = tot.n >= MIN_SAMPLES.toolDelivery;
  return {
    price,
    delivery: {
      label: DELIVERY_LABEL,
      status: enough ? "scored" : "not-enough-data",
      score: enough ? round3(tot.ok / tot.n) : null,
      sampleSize: tot.n,
      lastMeasuredAt: tot.n ? lastDayIso(tot.lastDay, 0) : null,
    },
  };
}
export const TOOL_REPUTATION_LEGEND = `Per route, measured by this server over a rolling ${WINDOW_DAYS}-day window. price: matches or differs compares the price this route's 402 asked on our last live read with the price the seller's own documents list (within ${PRICE_MATCH_TOLERANCE * 100}%); not-measured when no live read in the window has both. delivery, ${DELIVERY_LABEL}: the share of those calls to this route that answered 200 after taking the payment, our own probes, canaries and wallets left out; scored from ${MIN_SAMPLES.toolDelivery} calls, not-enough-data below. Neither counts payments or buyers.`;

// ---------------------------------------------------------------- state
let enabled = false;
let repDocument = null;
let delDocument = null;
let state = { loaded: false, body: null, delivery: null, version: 0, loadedAt: 0 };
let pending = {}; // origin -> { d: series, r: { routeKey: series } }
let pendingOrigins = 0;
let flushTimer = null;
let flushing = null;
let passTimer = null;
let passFirst = null;
let lastPass = { at: 0, sellers: 0, ms: 0, ok: null };

const repDoc = () => (repDocument ||= createJsonDocument({ name: REPUTATION_DOC, file: process.env.SELLER_REPUTATION_FILE || "/data/seller-reputation.json", log: () => {} }));
const delDoc = () => (delDocument ||= createJsonDocument({ name: DELIVERY_DOC, file: process.env.SELLER_DELIVERY_FILE || "/data/seller-delivery-outcomes.json", log: () => {} }));
const repBody = (b) => (b && typeof b === "object" && b.sellers && typeof b.sellers === "object" ? b : { v: 1, since: null, updatedAt: null, sellers: {} });
const delBody = (b) => (b && typeof b === "object" && b.o && typeof b.o === "object" ? b : { v: 1, o: {} });

registerMemoryStore("seller-reputation", null, {
  note: "seller reputation records and delivery outcomes (bounded by SELLER_REPUTATION_MAX_SELLERS and the window)",
  figure: () => ({ rows: Object.keys(state.body?.sellers || {}).length + Object.keys(state.delivery?.o || {}).length }),
});

/** Is this process recording and computing reputation? */
export function reputationEnabled() { return enabled; }
/** The state lookups read: loaded, the record count and when it was computed. */
export function reputationStatus() {
  return {
    enabled, loaded: state.loaded, sellers: Object.keys(state.body?.sellers || {}).length,
    computedAt: iso(state.body?.updatedAt), since: iso(state.body?.since), lastPass: { ...lastPass, at: iso(lastPass.at) },
  };
}
/** Version of the state a lookup read (bumped on every adopted reload). */
export function reputationVersion() { return state.version; }

function adopt(body, delivery) {
  state = { loaded: true, body: repBody(body), delivery: delBody(delivery), version: state.version + 1, loadedAt: Date.now() };
}

/** Re-read both documents (every replica). */
export async function reloadReputation() {
  const [r, d] = await Promise.all([repDoc().read({ quiet: true }), delDoc().read({ quiet: true })]);
  if (!r?.ok) return { ok: false };
  adopt(r.body, d?.ok ? d.body : state.delivery);
  return { ok: true };
}

/** The served record for one seller key, from this process's loaded state. */
export function sellerReputation(origin, { now = Date.now() } = {}) {
  const st = !enabled && !state.loaded ? "not-measured-here" : state.loaded ? "ready" : "loading";
  return reputationOf({
    rec: state.body?.sellers?.[origin] || null,
    delivery: state.delivery?.o?.[origin] || null,
    since: state.body?.since, updatedAt: state.body?.updatedAt, state: st, now,
  });
}
/** The delivery routes recorded for one seller (for per-tool rows). */
export function sellerDeliveryRoutes(origin) {
  return state.delivery?.o?.[origin]?.r || null;
}

// ---------------------------------------------------------------- delivery
/**
 * One router delivery outcome for an outside seller: ok (settled and answered
 * 200) or not (a struck delivery failure). Recorded only while reputation is
 * enabled (the production crawl runs here), inside a request, and never for a
 * request that is ours (the scope's isOurs, set by the paid handler: a
 * heartbeat probe, a canary, our own wallets). Synchronous; the store write
 * is deferred. Never throws.
 */
export function noteSellerDeliveryOutcome(origin, { ok, method = "GET", url = null, now = Date.now() } = {}) {
  try {
    if (!enabled || typeof origin !== "string" || !/^https?:\/\//i.test(origin)) return false;
    const scope = currentRequestScope();
    if (!scope) return false;
    if (typeof scope.isOurs === "function" && scope.isOurs()) return false;
    let p = pending[origin];
    if (!p) {
      if (pendingOrigins >= PENDING_MAX_ORIGINS) return false;
      p = pending[origin] = { d: [], r: {} };
      pendingOrigins++;
    }
    const day = dayOf(now);
    p.d = addBucket(p.d, day, !!ok);
    const key = url ? routeKeyOf(method, url) : null;
    if (key && (p.r[key] || Object.keys(p.r).length < MAX_ROUTES_PER_ORIGIN)) p.r[key] = addBucket(p.r[key], day, !!ok);
    startFlushTimer();
    return true;
  } catch { return false; }
}

function mergeSeries(into, add) {
  let s = Array.isArray(into) ? into.slice() : [];
  for (let i = 0; i + 2 < (add || []).length; i += 3) {
    const day = add[i];
    const j = s.findIndex((x, k) => k % 3 === 0 && x === day);
    if (j >= 0) { s[j + 1] += add[i + 1]; s[j + 2] += add[i + 2]; }
    else s.push(day, add[i + 1], add[i + 2]);
  }
  // Keep day order (a merge may land an older day after a newer one).
  const rows = [];
  for (let i = 0; i + 2 < s.length; i += 3) rows.push([s[i], s[i + 1], s[i + 2]]);
  rows.sort((a, b) => a[0] - b[0]);
  s = rows.flat();
  return s;
}
/** Merge pending delivery increments into a stored body (pure; for the flush and tests). */
export function mergeDelivery(body, add, now = Date.now()) {
  const b = delBody(body);
  for (const [origin, p] of Object.entries(add || {})) {
    const cur = b.o[origin] || { d: [], r: {} };
    cur.d = pruneSeries(mergeSeries(cur.d, p.d), now);
    cur.r = cur.r && typeof cur.r === "object" ? cur.r : {};
    for (const [k, s] of Object.entries(p.r || {})) {
      if (!cur.r[k] && Object.keys(cur.r).length >= MAX_ROUTES_PER_ORIGIN) continue;
      cur.r[k] = pruneSeries(mergeSeries(cur.r[k], s), now);
    }
    cur.at = now;
    b.o[origin] = cur;
  }
  // Drop sellers with nothing in the window, then keep the most recent.
  const rows = Object.entries(b.o).filter(([, v]) => {
    v.d = pruneSeries(v.d, now);
    for (const k of Object.keys(v.r || {})) { v.r[k] = pruneSeries(v.r[k], now); if (!v.r[k].length) delete v.r[k]; }
    return v.d.length > 0;
  });
  rows.sort((a, b2) => (Number(b2[1].at) || 0) - (Number(a[1].at) || 0));
  b.o = Object.fromEntries(rows.slice(0, MAX_DELIVERY_ORIGINS()));
  return b;
}

/** Fold this process's pending delivery outcomes into the shared document. Never throws. */
export async function flushDeliveryOutcomes({ now = Date.now() } = {}) {
  if (flushing) return flushing;
  const batch = pending;
  if (!Object.keys(batch).length) return { ok: true, flushed: false };
  pending = {}; pendingOrigins = 0;
  flushing = (async () => {
    try {
      const r = await delDoc().update((b) => mergeDelivery(b, batch, now), { fallback: null });
      if (!r?.ok) { restorePending(batch); return { ok: false }; }
      state = { ...state, delivery: delBody(r.body), version: state.version + 1 };
      return { ok: true, flushed: true };
    } catch {
      restorePending(batch);
      return { ok: false };
    } finally { flushing = null; }
  })();
  return flushing;
}
function restorePending(batch) {
  for (const [origin, p] of Object.entries(batch)) {
    const cur = pending[origin];
    if (!cur) {
      if (pendingOrigins >= PENDING_MAX_ORIGINS) continue;
      pending[origin] = p; pendingOrigins++;
      continue;
    }
    cur.d = mergeSeries(cur.d, p.d);
    for (const [k, s] of Object.entries(p.r || {})) cur.r[k] = mergeSeries(cur.r[k], s);
  }
}
function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(contained("seller-reputation-flush", () => flushDeliveryOutcomes()), DELIVERY_FLUSH_MS());
  flushTimer.unref?.();
}

// ---------------------------------------------------------------- the pass
const turn = () => new Promise((r) => setImmediate(r));

/**
 * Fold every index entry into the stored record and save it. `entries` is a
 * function returning an iterable of [sellerKey, entry]. Runs in steps of
 * PASS_STEP sellers per event-loop turn.
 */
export async function reputationPassUnleased({ entries, now = Date.now() } = {}) {
  const t0 = Date.now();
  const r = await repDoc().read({ quiet: true });
  if (!r?.ok) { lastPass = { at: now, sellers: 0, ms: Date.now() - t0, ok: false }; return { ok: false, reason: "store-unread" }; }
  const body = repBody(r.body);
  if (!body.since) body.since = now;
  const list = [];
  for (const row of (typeof entries === "function" ? entries() : []) || []) list.push(row);
  let n = 0;
  for (const [origin, entry] of list) {
    if (typeof origin !== "string" || !entry || typeof entry !== "object") continue;
    body.sellers[origin] = foldEntry(body.sellers[origin], entry, now);
    if (++n % PASS_STEP === 0) await turn();
  }
  body.sellers = pruneSellers(body.sellers, now);
  body.updatedAt = now;
  body.v = 1;
  // Serialized a step of sellers per turn (a few megabytes in all), so the
  // write never holds the loop for the whole body.
  const pieces = [`{"v":1,"since":${JSON.stringify(body.since)},"updatedAt":${JSON.stringify(now)},"sellers":{`];
  let first = true, k = 0;
  for (const [origin, rec] of Object.entries(body.sellers)) {
    pieces.push(`${first ? "" : ","}${JSON.stringify(origin)}:${JSON.stringify(rec)}`);
    first = false;
    if (++k % PASS_STEP === 0) await turn();
  }
  pieces.push("}}");
  const out = { v: 1, since: body.since, updatedAt: now, sellers: body.sellers };
  const saved = await repDoc().saveSerialized(out, pieces);
  const d = await delDoc().read({ quiet: true });
  if (saved) adopt(out, d?.ok ? d.body : state.delivery);
  lastPass = { at: now, sellers: n, ms: Date.now() - t0, ok: !!saved };
  return { ok: !!saved, sellers: n };
}

/**
 * Start recording and the scheduled pass. `entries` lists the index (see
 * reputationPassUnleased). Off unless `enabled` (server.js passes the
 * production crawl switch and SELLER_REPUTATION).
 */
export function startSellerReputation({ entries, enabled: on = false, ready = () => true } = {}) {
  enabled = !!on;
  if (!enabled) return false;
  const pass = leased("seller-reputation-pass", { ttlMs: 10 * 60_000 }, (opts) => reputationPassUnleased({ entries, ...(opts || {}) }));
  // A pass over an index still loading would record only the part loaded, so
  // it waits for the index; a replica that does not hold the lease re-reads
  // what the holder stored.
  const tick = async () => {
    if (!ready()) return { skipped: "index-loading" };
    const r = await pass();
    if (r && r.skipped) await reloadReputation();
    return r;
  };
  // Every replica reads the stored record at once, so a lookup answers from
  // the last pass right after a deploy.
  void reloadReputation().catch(() => {});
  const firstMs = REPUTATION_FIRST_MS();
  const retryMs = Math.min(30_000, Math.max(250, firstMs));
  const first = async () => {
    const r = await tick();
    if (r && r.skipped === "index-loading") { passFirst = setTimeout(contained("seller-reputation-pass", first), retryMs); passFirst.unref?.(); }
  };
  passFirst = setTimeout(contained("seller-reputation-pass", first), firstMs);
  passFirst.unref?.();
  passTimer = setInterval(contained("seller-reputation-pass", tick), REPUTATION_INTERVAL_MS());
  passTimer.unref?.();
  return true;
}
export function stopSellerReputation() {
  if (passFirst) clearTimeout(passFirst);
  if (passTimer) clearInterval(passTimer);
  if (flushTimer) clearInterval(flushTimer);
  passFirst = passTimer = flushTimer = null;
}

/** Tests only. */
export function __setReputationEnabledForTest(on) { enabled = !!on; }
export function __adoptReputationForTest(body, delivery = null) { adopt(body, delivery); }
export function __resetReputationForTest() {
  stopSellerReputation();
  enabled = false; pending = {}; pendingOrigins = 0; flushing = null;
  state = { loaded: false, body: null, delivery: null, version: 0, loadedAt: 0 };
  repDocument = null; delDocument = null;
}
export function __pendingDeliveryForTest() { return pending; }
