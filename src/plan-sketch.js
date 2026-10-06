// Free multi-step plan sketch for /api/find, /api/route and the connector's
// catalog.find (2026-10-06).
//
// A task that names several steps ("get the bitcoin price, then compute RSI")
// is split on explicit sequence words and each step is ranked with the same
// free lexical search find already runs. The sketch costs CPU only: it never
// calls a model, an embedding, a judge or the network, so the free surfaces it
// rides on stay free to serve. The judged plan with parameters filled in is
// the paid decide tool, named here as the upgrade.
//
// Pure module: the caller hands in the step ranker, so this file imports
// nothing that can reach the network (scripts/test-plan-sketch.js pins that).

export const PLAN_MAX_STEPS = 5;
const MIN_STEP_CHARS = 3;

// Sequence markers only. A bare "and" is never a split point: "bitcoin and
// ethereum price" is one step, and guessing otherwise would turn ordinary
// single-tool queries into plans.
const SPLIT_RE = /\s*(?:;|\n|->|→|=>|,?\s*\band then\b|,?\s*\bthen\b|,?\s*\bafter that\b|,?\s*\bafterwards\b|,?\s*\bfinally\b|,?\s*\bnext,)\s*/i;
const NUMBERED_RE = /(?:^|\s)(?:\(?\d{1,2}[.)]|step\s+\d{1,2}:?)\s+/gi;
const LEAD_RE = /^(?:and|first|firstly|also|please|,)\s+/i;

/** Split a task into ordered steps, or [] when it reads as a single step. */
export function splitSteps(query) {
  let q = String(query ?? "").slice(0, 500).trim();
  if (!q) return [];
  // "1. get the price 2. compute rsi" and "step 1: ... step 2: ..." become separators.
  const numbered = q.match(NUMBERED_RE);
  if (numbered && numbered.length >= 2) q = q.replace(NUMBERED_RE, " ; ").trim();
  const parts = q.split(SPLIT_RE)
    .map((p) => p.replace(LEAD_RE, "").replace(/[\s,.;:]+$/g, "").trim())
    .filter((p) => p.length >= MIN_STEP_CHARS && /[a-z]/i.test(p));
  return parts.length >= 2 ? parts : [];
}

const weakMatch = (r, floor) => !r || r.count === 0 || (r.results?.[0]?.score ?? 0) < floor || r.rarestTermCovered === false;

const toolRow = (t) => ({
  slug: t.slug,
  name: t.name,
  route: t.route,
  price: t.price,
  priceUsd: Number.isFinite(t.priceUsd) ? t.priceUsd : null,
  free: !!t.computePayable,
  required: Array.isArray(t.required) ? t.required : [],
  callExample: t.callExample,
});

/**
 * Build a sketch, or null when the task is a single step.
 * @param {string} query
 * @param {{ rank: (task: string) => object, weakScore?: number, upgrade?: object|null }} opts
 *   rank: the free lexical ranker (findTools bound to the catalog, k >= 3).
 *   upgrade: the paid decide pointer, or null when decide is not served here.
 */
export function buildPlanSketch(query, { rank, weakScore = 3, upgrade = null } = {}) {
  const all = splitSteps(query);
  if (!all.length) return null;
  const steps = all.slice(0, PLAN_MAX_STEPS);
  const out = [];
  let costUsd = 0, priced = true;
  for (const [i, task] of steps.entries()) {
    const r = rank(task);
    const top = r?.results?.[0];
    const weak = weakMatch(r, weakScore);
    const row = { step: i + 1, task, match: top ? (weak ? "weak" : "strong") : "none" };
    if (top) {
      row.tool = toolRow(top);
      row.fallbacks = (r.results || []).slice(1, 3).map((t) => ({ slug: t.slug, route: t.route, price: t.price }));
      if (row.tool.priceUsd == null) priced = false; else costUsd += row.tool.free ? 0 : row.tool.priceUsd;
    } else priced = false;
    if (i > 0) row.dependsOn = [i];
    out.push(row);
  }
  const unmatched = out.filter((s) => s.match !== "strong").map((s) => s.step);
  return {
    kind: "sketch",
    builtBy: "keyword match per step; no model, not judged",
    steps: out,
    stepCount: out.length,
    truncated: all.length > steps.length,
    ...(all.length > steps.length ? { maxSteps: PLAN_MAX_STEPS } : {}),
    // List prices of each step's top pick, paid steps only. A free (proof-of-work)
    // step adds nothing; an unpriced or missing step makes the total a floor.
    estimatedCostUsd: Math.round(costUsd * 1e6) / 1e6,
    estimatedCostIsFloor: !priced || unmatched.length > 0,
    ...(unmatched.length ? { weakSteps: unmatched } : {}),
    howToRun: "Call each step's tool in order with your own inputs (callExample shows the shape); a later step's input usually comes from the step before it.",
    ...(upgrade ? { upgrade } : {}),
  };
}
