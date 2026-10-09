// A plan built from the slugs of a free plan sketch (src/plan-sketch.js), in
// the same shape the paid decide service returns, so POST /api/decide/execute
// runs it through the one execute path: same budget, ceilings, step chaining,
// run records and feedback. Pure: the caller hands in the catalog and the rule
// that says which tools execute may not run.
//
// Params: step 1 carries a placeholder for each required field (the caller
// passes them); a later step whose tool has exactly one required field takes
// it from the step before ("{{step N}}", resolved at run time by the same
// rules a judged plan uses). Anything else is a placeholder the run reports as
// "pass params for this step" instead of guessing.
import { localToolRow } from "./tool-rows.js";
import { skeletonParams } from "./params.js";

export const SKETCH_MIN_STEPS = 2;
export const SKETCH_MAX_STEPS = 5;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

const slugOf = (raw) => {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    if (typeof raw.slug === "string") return raw.slug.trim();
    if (raw.tool && typeof raw.tool.slug === "string") return raw.tool.slug.trim();
  }
  return "";
};

const bySlug = (catalog) => new Map(Object.values(catalog || {}).filter((d) => d && typeof d.slug === "string").map((d) => [d.slug, d]));

const listPrice = (def) => {
  const n = Number(String(def?.price ?? "").replace(/^\$/, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** The list prices of the named steps that exist, summed: what a sketch run
 *  is quoted at before the handler has checked each step. */
export function sketchListPriceUsd(steps, catalog) {
  if (!Array.isArray(steps)) return 0;
  const map = bySlug(catalog);
  let sum = 0;
  for (const raw of steps.slice(0, SKETCH_MAX_STEPS)) {
    const def = map.get(slugOf(raw));
    if (def) sum += listPrice(def);
  }
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * @param steps slugs in order (strings, or sketch step objects)
 * @param opts { catalog, refuse: (def) => reason|null, baseUrl }
 * @returns { ok: true, plan, costUsd } or { ok: false, error }
 */
export function sketchPlan(steps, { catalog, refuse = () => null, baseUrl = "https://agent402.tools" } = {}) {
  if (!Array.isArray(steps) || steps.length < SKETCH_MIN_STEPS || steps.length > SKETCH_MAX_STEPS) {
    return { ok: false, error: `"steps" must list ${SKETCH_MIN_STEPS} to ${SKETCH_MAX_STEPS} tool slugs in order` };
  }
  const map = bySlug(catalog);
  const plan = [];
  let cost = 0;
  for (const [i, raw] of steps.entries()) {
    const n = i + 1;
    const slug = slugOf(raw);
    if (!SLUG_RE.test(slug)) return { ok: false, error: `step ${n}: a tool slug is required` };
    const def = map.get(slug);
    if (!def) return { ok: false, error: `step ${n}: no tool "${slug}" in this catalog` };
    const why = refuse(def);
    if (why) return { ok: false, error: `step ${n} (${slug}): ${why}` };
    const row = localToolRow(def, { baseUrl });
    if (!row) return { ok: false, error: `step ${n} (${slug}): this tool cannot be run through execute; call it directly` };
    const required = Array.isArray(row.inputSchema?.required) ? row.inputSchema.required : [];
    const params = skeletonParams(row.inputSchema);
    if (n > 1 && required.length === 1) params[required[0]] = `{{step ${n - 1}}}`;
    row.exampleParams = params;
    plan.push({ step: n, purpose: row.name, tool: row, fallbacks: [], dependsOn: n > 1 ? [n - 1] : [], source: "sketch" });
    cost += row.priceUsd;
  }
  return { ok: true, plan, costUsd: Math.round(cost * 1e6) / 1e6 };
}
