// Build a decision: task in, a call-ready plan out.
//
//   quick  one step: the single best tool for the whole task, plus fallbacks
//   plan   decomposed steps, each with a primary and fallbacks
//   full   plan + params for every step + compiled prompt + cost/latency
//
// The base planner (base-planner.js) builds every plan.

import { BasePlanner, runPlan } from "./base-planner.js";

export * from "./base-planner.js";

export async function buildDecision(input, deps) {
  return (await runPlan(new BasePlanner(), input, deps)).out;
}
