// Build a decision: task in, a call-ready plan out.
//
//   quick  one step: the single best tool for the whole task, plus fallbacks
//   plan   decomposed steps, each with a primary and fallbacks
//   full   plan + params for every step + compiled prompt + cost/latency
//
// The base planner (base-planner.js) builds every plan. For plan and full,
// the harness router (harness-router.js) then may re-plan with one
// specialized planner (harnesses.js) and serves it only when it is not worse
// on objective plan signals; by default the base plan is served. The
// decision records plannerVersion and which planner built it.
//
// Everything runs against one deadline. A model call that fails or runs late
// is skipped and the plan is built from retrieval order instead; the result
// says so (partial: true) and its confidence drops. Nothing here waits past
// the deadline, executes a step, or spends a buyer's money.

import { BasePlanner, RESUME_STAGE, runPlan } from "./base-planner.js";
import { HARNESSES } from "./harnesses.js";
import { harnessSettings, routeAfterBase, stamp } from "./harness-router.js";

export * from "./base-planner.js";
export { PLANNER_VERSION } from "./harness-router.js";

/**
 * @param input  parsed { task, constraints, depth }
 * @param deps   runPlan's deps, plus harnesses (a registry; default HARNESSES)
 */
export async function buildDecision(input, deps) {
  const now = deps.now ?? Date.now();
  const deadline = deps.deadline ?? now + deps.cfg.budgetMs[input.depth];
  const d = { ...deps, now, deadline };
  const registry = deps.harnesses || HARNESSES;
  const on = harnessSettings(deps.cfg).on && input.depth !== "quick" && registry.length > 0;
  // The base state before each stage a registered planner re-plans from, so
  // a re-plan never repeats the stages before its seam.
  const snapshotAt = on ? [...new Set(registry.map((h) => RESUME_STAGE[h.seam]).filter((s) => s !== "decompose"))] : [];
  const base = await runPlan(new BasePlanner(), input, d, { snapshotAt });
  if (!on) return stamp(base.out, { id: "base", reason: input.depth === "quick" ? "quick depth plans one step" : "router off" });
  return routeAfterBase({ input, deps: d, base, deadline, registry });
}
