// The "stale high" half of the live cost-row check (scripts/test-gateway-model-ids.js).
//
// A private MODEL_COST row is graded against the dearest routable live
// endpoint of every servable model it OWNS (the models costFor() resolves to
// that row: its longest matching prefix). A row under that price lets the
// clamp through too many tokens (the guard's rule 4); a row well ABOVE it is
// the other failure: a metered quote priced at the row overcharges, and a
// flat tier whose bound sits under the row refuses a model it could serve.
//
// A catch-all family row ("vendor/") owns cheap and dear models alike, so it
// is graded against the DEAREST of them per unit: it is stale high only when
// it sits above every model it prices, never because one cheap member is far
// under it. A row that owns no servable model is not graded.
//
// Output is the row's key, the unit and the direction only: no rate and no
// percent, because a percent beside a public list price gives the row away
// and the workflow log and its issue are public.

/** Default tolerance: a row more than 15% above its dearest owned endpoint. */
export const STALE_HIGH_TOLERANCE = 0.15;

/** Record one servable model's dearest routable prices (per 1M tokens) under its row. */
export function noteOwnedPrice(owned, key, row, modelId, { prompt, completion }) {
  if (!key || !row) return;
  let e = owned.get(key);
  if (!e) { e = { row, models: new Set(), maxPrompt: -Infinity, maxCompletion: -Infinity }; owned.set(key, e); }
  e.models.add(modelId);
  if (Number.isFinite(prompt)) e.maxPrompt = Math.max(e.maxPrompt, prompt);
  if (Number.isFinite(completion)) e.maxCompletion = Math.max(e.maxCompletion, completion);
}

/**
 * Rows more than `tolerance` above the dearest endpoint of every servable
 * model they own, per unit. Returns [{ key, unit, pct, models }] where pct is
 * a whole percent above that price (null when the dearest owned price is 0).
 */
export function staleHighRows(owned, { tolerance = STALE_HIGH_TOLERANCE } = {}) {
  const out = [];
  for (const [key, e] of owned) {
    for (const [unit, max] of [["prompt", e.maxPrompt], ["completion", e.maxCompletion]]) {
      const row = Number(e.row?.[unit]);
      if (!Number.isFinite(row) || !Number.isFinite(max) || max < 0) continue;
      if (max === 0) { if (row > 0) out.push({ key, unit, pct: null, models: e.models.size }); continue; }
      if (row > max * (1 + tolerance) + 1e-9) out.push({ key, unit, pct: Math.round((row / max - 1) * 100), models: e.models.size });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.unit.localeCompare(b.unit));
}

/** One public line per finding: key, unit and direction, no rate or percent. */
export function describeStaleHigh(f) {
  return `${f.key} ${f.unit}: stale high, above the dearest live endpoint of every servable model it owns (${f.models} model(s))`;
}
