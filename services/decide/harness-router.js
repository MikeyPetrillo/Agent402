// The harness router. The base plan is built first (it is the base run; it
// is never built twice and nothing here executes a step or pays a seller).
// Then one small model call sees the task, the base plan's shape and its
// failure signals, and the registered clusters with their routing lessons,
// and answers { harness: id | "base", confidence }. Only a pick at or above
// the threshold re-plans, and only from the stage its seam starts in: a
// wiring or params planner reuses the base's steps, retrieval and judged
// fits. The re-plan replaces the base only when it is not worse on any
// objective signal (gaps, runnable steps, params misfit, unresolved
// references, partial). Anything else, an error included, keeps the base.

import { validateParams } from "../../src/decide/params.js";
import { upstreamCosts } from "../../src/upstream-costs.js";
import { RESUME_STAGE, STEP_REF_N, isPlaceholder, runPlan } from "./base-planner.js";
import { HARNESSES, refFor } from "./harnesses.js";

export const PLANNER_VERSION = "oo-1";

// Time a re-plan needs before it is worth starting, by seam (ms).
const NEEDS_MS = { decompose: 7000, judgePrompt: 5000, backupPolicy: 300, paramsFill: 3000, dependencyWiring: 100 };

const runnableTool = (t) => !!t && (t.firstParty || (t.callDirectly !== true && Number.isFinite(t.executeViaAgent402Usd)));

/** Objective, model-free measures of a plan. Lower is better for every count
 *  except runnableSteps. */
export function planMetrics(d, rows = []) {
  const plan = Array.isArray(d?.plan) ? d.plan : [];
  const rowOf = (q) => rows[plan.indexOf(q)] || null;
  let paramsMisfit = 0, unresolvedRefs = 0, linkableOpen = 0;
  for (const p of plan) {
    const t = p.tool || {};
    const params = t.exampleParams || {};
    if (!validateParams(t.inputSchema || {}, params).ok) paramsMisfit++;
    paramsMisfit += (t.exampleParamsNeedInput || []).length;
    for (const [name, v] of Object.entries(params)) {
      const m = typeof v === "string" ? STEP_REF_N.exec(v) : null;
      if (m) {
        const n = Number(m[1]);
        const src = plan.find((q) => q.step === n);
        // A reference must name an earlier step the step depends on.
        if (!src || n >= p.step || !(p.dependsOn || []).includes(n)) unresolvedRefs++;
        continue;
      }
      if (isPlaceholder(v) && plan.some((q) => q.step < p.step && refFor(rowOf(q), q.step, name))) linkableOpen++;
    }
  }
  return {
    steps: plan.length,
    gaps: (d?.gaps || []).length,
    runnableSteps: plan.filter((p) => [p.tool, ...(p.fallbacks || [])].some(runnableTool)).length,
    paramsMisfit, unresolvedRefs, linkableOpen,
    partial: !!d?.partial, judged: d?.judged !== false,
  };
}

/** The ways `cand` is worse than `base`; empty when it is not worse. */
export function worseThan(cand, base) {
  const why = [];
  if (cand.gaps > base.gaps) why.push("more gaps");
  if (cand.runnableSteps < base.runnableSteps) why.push("fewer runnable steps");
  if (cand.paramsMisfit > base.paramsMisfit) why.push("more params misfit");
  if (cand.unresolvedRefs > base.unresolvedRefs) why.push("more unresolved references");
  if (cand.linkableOpen > base.linkableOpen) why.push("more unlinked values");
  if (cand.partial && !base.partial) why.push("partial");
  if (!cand.judged && base.judged) why.push("not judged");
  return why;
}

/** What the router sees of the base plan: its shape and failure signals.
 *  Tools are named by our own slug or as an outside tool, never by the text
 *  a seller wrote. */
export function planShape(d, metrics = planMetrics(d)) {
  const collapsed = metrics.steps === 1 && (d.notes || []).some((n) => /one step|whole task/.test(n));
  return {
    steps: (d.plan || []).map((p) => ({
      step: p.step, purpose: String(p.purpose || "").slice(0, 160), dependsOn: p.dependsOn || [],
      tool: p.tool?.firstParty ? p.tool.slug : "outside tool",
      params: Object.fromEntries(Object.entries(p.tool?.exampleParams || {}).map(([k, v]) => [k, typeof v === "string" && STEP_REF_N.test(v) ? "from an earlier step" : isPlaceholder(v) ? "missing" : "given"])),
    })),
    signals: { gaps: metrics.gaps, collapsedToOneStep: collapsed, paramsMisfit: metrics.paramsMisfit, unresolvedRefs: metrics.unresolvedRefs, unlinkedValues: metrics.linkableOpen, partial: metrics.partial },
  };
}

export function routerPrompt(task, shape, offered) {
  return {
    system: `You route a planning task to a specialized planner or keep the base planner. The base plan is already built; a specialized planner re-plans one part of it. Pick a planner only when the task clearly belongs to its cluster AND the base plan shows a problem that planner fixes, or the task's shape is one the base is known to plan poorly. When unsure, answer "base". Return JSON: {"harness":"<id or base>","confidence":<0 to 1>}.`,
    user: `Task: ${task}\nBase plan: ${JSON.stringify(shape)}\nPlanners: ${JSON.stringify(offered.map((h) => ({ id: h.id, cluster: h.cluster.description, question: h.cluster.classifier, lesson: h.routingLesson })))}`,
  };
}

/** The admitted decide model the router asks: the cheaper of the configured
 *  pair by the private cost table, else the primary. */
export function routerModel(cfg, table = safeTable()) {
  const pinned = String(cfg.harness?.routerModel || "").trim();
  const admitted = [cfg.model, cfg.modelFallback].filter(Boolean);
  if (pinned && admitted.includes(pinned)) return pinned;
  const rows = Array.isArray(table?.models) ? table.models : [];
  const rateOf = (m) => {
    const hit = rows.filter((r) => Array.isArray(r) && typeof r[0] === "string" && m.startsWith(r[0])).sort((a, b) => b[0].length - a[0].length)[0];
    const r = hit?.[1];
    return r && Number.isFinite(r.prompt) && Number.isFinite(r.completion) ? r.prompt * 4 + r.completion : Infinity;
  };
  return [...admitted].sort((a, b) => rateOf(a) - rateOf(b))[0] || cfg.model;
}
function safeTable() { try { return upstreamCosts(); } catch { return null; } }

export function harnessSettings(cfg) {
  const h = cfg.harness || {};
  const t = Number(h.minConfidence);
  return { on: h.router !== "off", minConfidence: Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.7, timeoutMs: Math.max(500, Number(h.routerTimeoutMs) || 3000) };
}

/**
 * Route after the base run. `base` is { out, snapshots } from runPlan.
 * Returns the decision to serve, stamped with plannerVersion and harness.
 */
export async function routeAfterBase({ input, deps, base, deadline, registry = HARNESSES }) {
  const { cfg, llm, meter = null } = deps;
  const settings = harnessSettings(cfg);
  const left = () => deadline - Date.now();
  const keep = (reason, router = null) => stamp(base.out, { id: "base", ...(router ? { router } : {}), reason });
  const metrics = planMetrics(base.out, base.rows);
  const signals = { ...metrics };
  const offered = registry.filter((h) => { try { return !!h.cluster.appliesTo(input.task, signals); } catch { return false; } });
  if (!offered.length) return keep("no specialized planner applies");
  if (left() < 1500) return keep("no time left to route");
  const rp = routerPrompt(input.task, planShape(base.out, metrics), offered);
  const model = routerModel(cfg);
  const timeoutMs = Math.min(settings.timeoutMs, Math.max(500, left() - 1000));
  let answer = null;
  try { answer = await within(llm.call(rp.system, rp.user, { maxTokens: 60, timeoutMs, meter, stage: "harness_route", only: [model] }), timeoutMs + 250); } catch { answer = null; }
  const pick = typeof answer?.harness === "string" ? answer.harness.trim() : null;
  const confidence = Number.isFinite(Number(answer?.confidence)) ? Math.max(0, Math.min(1, Number(answer.confidence))) : 0;
  const router = { offered: offered.map((h) => h.id), pick: pick || null, confidence, threshold: settings.minConfidence };
  if (!pick) return keep("router gave no answer", router);
  if (pick === "base") return keep("router kept the base", router);
  const h = offered.find((x) => x.id === pick);
  if (!h) return keep("router named a planner that was not offered", router);
  if (confidence < settings.minConfidence) return keep("router below the confidence threshold", router);
  if (left() < NEEDS_MS[h.seam]) return keep("no time left to re-plan", router);
  const stage = RESUME_STAGE[h.seam];
  const state = stage === "decompose" ? null : base.snapshots[stage];
  if (stage !== "decompose" && !state) return keep("no base state to re-plan from", router);
  let alt;
  try {
    alt = await runPlan(new h.Harness(), input, { ...deps, deadline }, state ? { resume: { stage, state } } : {});
  } catch (e) {
    // The exception stays in the service log; the answer names the outcome only.
    console.warn(`[decide] specialized planner ${h.id} failed: ${String(e?.message || e).slice(0, 200)}`);
    return keep("specialized planner failed", router);
  }
  const altMetrics = planMetrics(alt.out, alt.rows);
  const worse = worseThan(altMetrics, metrics);
  if (!alt.out.plan?.length || worse.length) return keep(`specialized plan was worse: ${worse.join(", ") || "empty"}`, router);
  // One decision: the re-plan keeps the base's id.
  return stamp({ ...alt.out, decisionId: base.out.decisionId }, { id: h.id, seam: h.seam, router, reason: "router pick, not worse than the base" });
}

export function stamp(out, harness) {
  return { ...out, plannerVersion: PLANNER_VERSION, harness };
}

function within(promise, ms) {
  let t;
  return Promise.race([Promise.resolve(promise).catch(() => null), new Promise((r) => { t = setTimeout(() => r(null), Math.max(0, ms)); })]).finally(() => clearTimeout(t));
}
