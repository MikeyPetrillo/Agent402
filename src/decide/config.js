// Every tunable of the decision product in one place, read from env as JSON
// overrides so a value can change (or be A/B tested) without a code change.
// DECIDE_CONFIG='{"prices":{"quick":0.004}}' merges over the defaults.
//
// The main app reads prices and the credit/fee policy from here too (it
// imports this file), so the 402 a buyer pays and the plan the service builds
// agree by construction.

export const DEFAULTS = Object.freeze({
  // The catalog lists the default depth (plan), so a request that names no
  // depth pays exactly the listed price.
  prices: { quick: 0.003, plan: 0.01, full: 0.03 },
  // Score weights. There is deliberately NO first-party term.
  weights: { fit: 0.45, reliability: 0.2, price: 0.15, schema: 0.1, freshness: 0.1 },
  // A third-party row is recommendable only with a live 402 seen this recently.
  liveWithinHours: 168,
  freshnessHalfLifeHours: 72,
  maxSteps: 6,
  fallbacksPerStep: 3,
  candidatesPerStep: 24,
  // Whole-request budgets (ms). Past them the best partial plan is returned.
  budgetMs: { quick: 8000, plan: 18000, full: 26000 },
  llmTimeoutMs: 12000,
  cacheTtlMs: 10 * 60_000,
  credit: { percentOfFee: 100, ttlHours: 24 },
  routingFeePct: 5,
  // Execution ceilings. The daily global ceiling is shared: one payer may use at
  // most perPayerDayShare of it, and one outside seller may receive at most
  // perSellerDayUsd a day, so no single actor can exhaust it for everyone.
  execute: { perCallMaxUsd: 3, perWalletHourUsd: 10, globalDayUsd: 100, perPayerDayShare: 0.1, perSellerDayUsd: 20, stepTimeoutMs: 45000, externalStepTimeoutMs: 60000, runDeadlineMs: 240000, maxParallelSteps: 3 },
  // Fit judging: "jev" asks the judgment model first and falls back to the
  // models below; "llm" uses the models only.
  judge: "jev",
  // With judge "jev": a written parameter value scored below this is
  // replaced by a placeholder (required) or dropped (optional).
  paramCheckMin: 0.3,
  // Model used to decompose tasks, fill params and (as fallback) judge fit.
  model: "google/gemini-3.1-flash-lite",
  modelFallback: "anthropic/claude-haiku-4.5",
  // Specialized planners (services/decide/harnesses.js). After the base plan,
  // one router call may pick one to re-plan; a pick below minConfidence, or
  // a re-plan that is worse on objective signals, keeps the base plan.
  // routerModel "" asks the cheaper of the two models above; a value must be
  // one of them. router "off" serves the base plan with no router call.
  harness: { router: "on", minConfidence: 0.7, routerModel: "", routerTimeoutMs: 3000 },
});

function merge(a, b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!Object.hasOwn(a, k)) continue; // unknown keys are ignored, never injected
    out[k] = a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(a[k], v) : (typeof v === typeof a[k] ? v : a[k]);
  }
  return out;
}

let cached = null, cachedRaw = null;
export function decideConfig(env = process.env) {
  const raw = env.DECIDE_CONFIG || "";
  if (cached && raw === cachedRaw) return cached;
  let over = {};
  try { over = raw ? JSON.parse(raw) : {}; } catch { console.warn("[decide] DECIDE_CONFIG is not valid JSON; using defaults"); }
  cached = merge(DEFAULTS, over);
  cachedRaw = raw;
  return cached;
}

export const DEPTHS = ["quick", "plan", "full"];
export function priceForDepth(depth, cfg = decideConfig()) {
  const d = DEPTHS.includes(depth) ? depth : "plan";
  const p = Number(cfg.prices[d]);
  return Number.isFinite(p) && p > 0 ? p : DEFAULTS.prices[d];
}
