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

import { rowRateAt } from "../../src/upstream-costs.js";

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

// ---- long-context tiers ---------------------------------------------------
// Some endpoints bill a higher price once a prompt passes a size (the live
// endpoint list carries it as pricing.overrides[{ min_prompt_tokens, prompt,
// completion }]). A private row prices that with its optional `tiers`
// (src/upstream-costs.js); a row without them prices every long prompt at its
// base rate, under what the upstream bills. Both functions below take prices
// per 1M tokens and return names and token counts only.

/** One endpoint's long-context overrides, per 1M tokens: [{ minPromptTokens, prompt, completion }].
 *  A unit an override does not name is NaN (not overridden). */
export function overridesOf(pricing) {
  const list = Array.isArray(pricing?.overrides) ? pricing.overrides : [];
  return list.map((o) => ({ minPromptTokens: Number(o?.min_prompt_tokens), prompt: Number(o?.prompt) * 1e6, completion: Number(o?.completion) * 1e6 }))
    .filter((o) => Number.isFinite(o.minPromptTokens) && o.minPromptTokens > 0 && (Number.isFinite(o.prompt) || Number.isFinite(o.completion)));
}

/**
 * Where a row's tiers fall short of the upstream's long-context prices, for
 * prompts up to `admittedTokens` (the largest prompt the tier serving it can
 * admit). Checked at every upstream threshold, the live price there being the
 * dearest override any endpoint applies at that size; a step function only
 * changes at its thresholds, so that covers every size. Returns at most one
 * finding per unit, at the smallest size it starts:
 * [{ unit, kind: "missing" | "under", aboveTokens }]. "missing": the row has
 * no tiers at all; "under": its tiers do not reach the live price there.
 */
export function longContextGaps(row, overrides, admittedTokens = Infinity) {
  if (!row || !Array.isArray(overrides) || !overrides.length) return [];
  const sizes = [...new Set(overrides.map((o) => o.minPromptTokens))].filter((n) => n <= admittedTokens).sort((a, b) => a - b);
  const out = [];
  for (const unit of ["prompt", "completion"]) {
    for (const n of sizes) {
      const live = Math.max(...overrides.filter((o) => o.minPromptTokens <= n).map((o) => o[unit]).filter(Number.isFinite));
      if (!Number.isFinite(live)) continue;
      const ours = Number(rowRateAt(row, n)?.[unit]);
      if (!(ours >= live - 1e-9)) {
        out.push({ unit, kind: Array.isArray(row.tiers) && row.tiers.length ? "under" : "missing", aboveTokens: n });
        break;
      }
    }
  }
  return out;
}

/** One public line per long-context finding: row key, unit, direction and the
 *  prompt size it starts at. No rate and no percent. */
export function describeLongContext(key, f) {
  return f.kind === "missing"
    ? `${key} ${f.unit}: long-context tier missing, upstream bills more from ${f.aboveTokens} prompt tokens`
    : `${key} ${f.unit}: under at >=${f.aboveTokens} prompt tokens (long-context tier below the upstream price)`;
}
