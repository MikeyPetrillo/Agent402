// The shape of a plan, with no text in it: how many steps, which tools (our
// slugs, an outside tool by its opaque row id), their categories, the
// dependency edges as index pairs, how many needs went uncovered, and two
// planner flags. Two plans with the same shape share a shapeKey, so outcomes
// can be grouped by shape long after the task text that produced them is
// pruned. Shared by the decide service (paid plans) and the main app (sketch
// runs), so both compute the same key for the same plan.
import { createHash } from "node:crypto";

/** A tool's stable, text-free key: our slug, or an outside row's id. */
export function toolKey(t) {
  if (!t || typeof t !== "object") return "unknown";
  if (t.firstParty) return String(t.slug || t.id || "unknown").slice(0, 120);
  return `ext:${String(t.id || "unknown").slice(0, 64)}`;
}

/**
 * @param plan  the plan's steps ({ step, tool, dependsOn })
 * @param opts  { gaps, categories (per step, in plan order), collapsedToOneStep, judgeFailed }
 * @returns { stepCount, slugs, categories, edges, gapCount, collapsedToOneStep, judgeFailed, shapeKey }
 */
export function planShape(plan, { gaps = [], categories = null, collapsedToOneStep = false, judgeFailed = false } = {}) {
  const steps = Array.isArray(plan) ? plan : [];
  const indexOf = new Map(steps.map((p, i) => [Number(p?.step), i]));
  const edges = [];
  steps.forEach((p, i) => {
    for (const d of Array.isArray(p?.dependsOn) ? p.dependsOn : []) {
      const j = indexOf.get(Number(d));
      if (j !== undefined && j !== i) edges.push([j, i]);
    }
  });
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cats = steps.map((p, i) => String((Array.isArray(categories) ? categories[i] : p?.tool?.category) || "unknown").slice(0, 40));
  const shape = {
    stepCount: steps.length,
    slugs: steps.map((p) => toolKey(p?.tool)).sort(),
    categories: cats.sort(),
    edges,
    gapCount: Array.isArray(gaps) ? gaps.length : Number(gaps) || 0,
    collapsedToOneStep: collapsedToOneStep === true,
    judgeFailed: judgeFailed === true,
  };
  return { ...shape, shapeKey: shapeKeyOf(shape) };
}

/** A short hash over every shape field, in a fixed order. */
export function shapeKeyOf(s) {
  const canon = JSON.stringify([s.stepCount, s.slugs, s.categories, s.edges, s.gapCount, !!s.collapsedToOneStep, !!s.judgeFailed]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}
