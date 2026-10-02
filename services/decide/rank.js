// Candidate scoring. NEUTRAL: the inputs are the row's price, schema quality,
// freshness and observed reliability, plus the judged fit for the step. The
// row's `firstParty` and `seller` fields are never read here - the neutrality
// test proves two rows differing only in those fields score identically.

export const FEEDBACK_SWING = 0.1;

/** Beta(1,1)-smoothed success rate from OUR observations, blended with the
 *  crawler's health, then nudged by buyer reports by at most FEEDBACK_SWING. */
export function reliabilityScore(stats, health) {
  const s = Number(stats?.successes) || 0, f = Number(stats?.failures) || 0;
  const observed = (s + 1) / (s + f + 2);
  const weight = Math.min(1, (s + f) / 20); // trust observations as they accumulate
  const prior = Number.isFinite(health) ? health : 0.7;
  const fs = Number(stats?.fbSuccesses) || 0, ff = Number(stats?.fbFailures) || 0;
  const nudge = FEEDBACK_SWING * (2 * ((fs + 1) / (fs + ff + 2)) - 1) * Math.min(1, (fs + ff) / 10);
  const v = observed * weight + prior * (1 - weight) + nudge;
  return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
}

export function priceScore(priceUsd, refPriceUsd) {
  const ref = refPriceUsd > 0 ? refPriceUsd : 0.01;
  return Math.round((1 / (1 + priceUsd / ref)) * 1000) / 1000;
}

/** With `windowHours`, freshness is a pass mark: 1 for any row with a live
 *  proof inside the window, 0 otherwise. Our own tools are stamped live at
 *  every export and outside rows only when a probe runs, so a decaying score
 *  would favour the first party by construction; inside the window every row
 *  is equally fresh. */
export function freshnessScore(lastLiveAt, now, halfLifeHours, windowHours = null) {
  if (!Number.isFinite(lastLiveAt) || lastLiveAt <= 0) return 0;
  if (Number.isFinite(windowHours) && windowHours > 0) return now - lastLiveAt <= windowHours * 3_600_000 ? 1 : 0;
  const hours = Math.max(0, (now - lastLiveAt) / 3_600_000);
  return Math.round(Math.pow(0.5, hours / halfLifeHours) * 1000) / 1000;
}

function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return 0.01;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Score candidates for one step.
 * @param cands [{ row, fit }]  fit in 0..1
 * @param ctx { reliability: (toolId) => stats|null, weights, now, halfLifeHours }
 */
export function scoreCandidates(cands, { reliability = () => null, weights, now = Date.now(), halfLifeHours = 72, liveWithinHours = null }) {
  const ref = median(cands.map((c) => c.row.priceUsd));
  return cands.map(({ row, fit }) => {
    const parts = {
      fit: Math.max(0, Math.min(1, Number(fit) || 0)),
      reliability: reliabilityScore(reliability(row.id), row.health),
      price: priceScore(row.priceUsd, ref),
      schema: Number(row.schemaQuality) || 0,
      freshness: freshnessScore(row.lastLiveAt, now, halfLifeHours, liveWithinHours),
    };
    let total = 0;
    for (const [k, w] of Object.entries(weights)) total += (Number(w) || 0) * (parts[k] ?? 0);
    return { row, fit: parts.fit, parts, score: Math.round(total * 10000) / 10000 };
  }).sort((a, b) => b.score - a.score || a.row.priceUsd - b.row.priceUsd || (a.row.id < b.row.id ? -1 : 1));
}
