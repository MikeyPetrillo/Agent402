// Router benchmarks: what this server measured about the outside sellers its
// router bought from, beside the sellers it indexed and did not buy from.
//
// Built only from records this server already holds (src/seller-reputation.js):
// each seller's crawl, paywall, answer-time and live-price readings, and the
// delivery outcomes of purchases the router made for buyers. Nothing is bought,
// probed or fetched to make it.
//
// AGGREGATES ONLY. No seller is named and no figure describes one seller: a
// statistic is published only when at least MIN_COHORT_SELLERS sellers are
// scored on it, otherwise it reads not-enough-data. No field is a count of
// payments, purchases, buyers or settlements: a sample is used to compute a
// share and is never printed, and the only counts are sellers scored.
//
// Two cohorts over the rolling window:
//   routed     sellers with at least one recorded router delivery outcome
//   notRouted  indexed sellers with none
// Per cohort and metric: how many sellers are scored, and the median and
// quartiles of their scores (the same 0 to 1 scores /api/reputation serves).
// The delivery block is the routed cohort's own outcome: the pooled share of
// recorded purchases the seller answered 200 after taking the payment, and the
// distribution of per-seller delivery scores.
import {
  WINDOW_DAYS, MIN_SAMPLES, DELIVERY_LABEL, REPUTATION_METHOD_URL,
  reputationOf, seriesTotals, reputationSnapshot,
} from "./seller-reputation.js";

export const ROUTER_BENCHMARKS_PATH = "/api/router-benchmarks";
/** The fewest scored sellers a published statistic rests on. */
export const MIN_COHORT_SELLERS = 5;
/** The metrics compared across the two cohorts, in display order. */
export const COHORT_METRICS = Object.freeze(["manifestUptime", "paywallUptime", "responsiveness", "priceMatchesListing"]);
export const COHORTS = Object.freeze({
  routed: "sellers with at least one recorded router delivery outcome in the window",
  notRouted: "indexed sellers with no recorded router delivery outcome in the window",
});
export const ROUTER_BENCHMARKS_LEGEND = `Measured by this server over a rolling ${WINDOW_DAYS}-day window, from its own crawl and from purchases its router made for buyers. Aggregates only: no seller is named, a statistic is published only when at least ${MIN_COHORT_SELLERS} sellers are scored on it, and no field counts payments, purchases, buyers or settlements. A seller is scored on a metric only past that metric's minimum sample, as on /api/reputation. A difference between the cohorts is a measured difference, not a cause: the router buys from sellers that passed its own checks.`;
const CACHE_MS = 10 * 60_000;
// Sellers folded per event-loop turn.
const STEP = 250;

const round3 = (x) => Math.round(x * 1000) / 1000;
/** The value at quantile q (0 to 1) of an ascending array, by the nearest rank at or below. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
}
/** { status, sellersScored, median, p25, p75 } for a list of 0 to 1 scores. */
export function distribution(scores, min = MIN_COHORT_SELLERS) {
  const s = scores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length < min) return { status: "not-enough-data", sellersScored: null, median: null, p25: null, p75: null, minSellers: min };
  return { status: "measured", sellersScored: s.length, median: round3(quantile(s, 0.5)), p25: round3(quantile(s, 0.25)), p75: round3(quantile(s, 0.75)), minSellers: min };
}

const emptyCohort = () => Object.fromEntries(COHORT_METRICS.map((m) => [m, []]));

/**
 * The benchmark document from a snapshot of the reputation records
 * ({ sellers, delivery, ourSideDays, state, updatedAt }). Async only to give
 * the loop a turn every STEP sellers; it reads nothing but its argument.
 */
export async function computeRouterBenchmarks(snap, { now = Date.now(), yieldTurn = () => new Promise((r) => setImmediate(r)) } = {}) {
  const sellers = snap?.sellers || {}, deliveries = snap?.delivery || {};
  const scores = { routed: emptyCohort(), notRouted: emptyCohort() };
  const medianMs = { routed: [], notRouted: [] };
  const perSellerDelivery = [];
  let pooledOk = 0, pooledN = 0, contributing = 0;
  const origins = new Set([...Object.keys(sellers), ...Object.keys(deliveries)]);
  let i = 0;
  for (const origin of origins) {
    if (++i % STEP === 0) await yieldTurn();
    const delivery = deliveries[origin] || null;
    const t = delivery ? seriesTotals(delivery.d, now) : { ok: 0, n: 0 };
    const cohort = t.n > 0 ? "routed" : "notRouted";
    const rep = reputationOf({ rec: sellers[origin] || null, delivery, now, ourSideDays: snap?.ourSideDays || [] });
    for (const m of COHORT_METRICS) {
      const r = rep.metrics[m];
      if (r?.status !== "scored") continue;
      scores[cohort][m].push(r.score);
      if (m === "responsiveness" && Number.isFinite(r.medianMs)) medianMs[cohort].push(r.medianMs);
    }
    if (t.n > 0) {
      pooledOk += t.ok; pooledN += t.n; contributing++;
      if (rep.metrics.delivery?.status === "scored") perSellerDelivery.push(rep.metrics.delivery.score);
    }
  }
  const cohorts = {};
  for (const [name, definition] of Object.entries(COHORTS)) {
    const metrics = {};
    for (const m of COHORT_METRICS) {
      const d = distribution(scores[name][m]);
      if (m === "responsiveness") {
        const ms = medianMs[name].slice().sort((a, b) => a - b);
        d.medianOfMedianMs = d.status === "measured" && ms.length >= MIN_COHORT_SELLERS ? quantile(ms, 0.5) : null;
      }
      metrics[m] = d;
    }
    cohorts[name] = { definition, metrics };
  }
  const comparison = {};
  for (const m of COHORT_METRICS) {
    const a = cohorts.routed.metrics[m], b = cohorts.notRouted.metrics[m];
    const both = a.status === "measured" && b.status === "measured";
    comparison[m] = { status: both ? "measured" : "not-enough-data", routedMedian: both ? a.median : null, notRoutedMedian: both ? b.median : null, difference: both ? round3(a.median - b.median) : null };
  }
  const pooled = contributing >= MIN_COHORT_SELLERS && pooledN > 0;
  return {
    benchmark: "router-outcomes",
    recordState: snap?.state || "loading",
    windowDays: WINDOW_DAYS,
    computedAt: new Date(now).toISOString(),
    recordsComputedAt: Number(snap?.updatedAt) > 0 ? new Date(Number(snap.updatedAt)).toISOString() : null,
    minCohortSellers: MIN_COHORT_SELLERS,
    delivery: {
      label: DELIVERY_LABEL,
      // Purchases answered 200 after payment, over every recorded purchase in the cohort.
      pooledShare: { status: pooled ? "measured" : "not-enough-data", share: pooled ? round3(pooledOk / pooledN) : null, minSellers: MIN_COHORT_SELLERS },
      // Sellers scored on delivery (each past its own minimum sample).
      perSeller: { ...distribution(perSellerDelivery), minSamplePerSeller: MIN_SAMPLES.delivery },
    },
    cohorts,
    comparison,
    legend: ROUTER_BENCHMARKS_LEGEND,
    methodDoc: REPUTATION_METHOD_URL,
    sellerRecords: "/api/reputation?seller=<host>",
  };
}

let cached = null; // { version, at, doc }
let building = null;
/** The served document: computed once per loaded record version, kept CACHE_MS. */
export async function routerBenchmarks({ now = Date.now() } = {}) {
  const snap = reputationSnapshot();
  if (cached && cached.version === snap.version && now - cached.at < CACHE_MS) return cached.doc;
  if (!building) {
    building = computeRouterBenchmarks(snap, { now })
      .then((doc) => { cached = { version: snap.version, at: now, doc }; return doc; })
      .finally(() => { building = null; });
  }
  return building;
}
/** Tests only: forget the kept document. */
export function __resetRouterBenchmarksForTest() { cached = null; building = null; }
