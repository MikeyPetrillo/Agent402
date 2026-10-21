#!/usr/bin/env node
// Offline evolution tooling for Decide's specialized planners
// (services/decide/harnesses.js). Given a task suite (JSON: a synthetic tool
// index and tasks, each with a cluster, the planner-model answers to stub and
// checkers), it builds the base plan and a candidate planner's plan for each
// task PLAN-ONLY, the same way the router does (a params or wiring planner
// resumes from the base's state), and reports objective plan measures: gaps,
// runnable steps, params misfit, unresolved references, unlinked values, and
// the task's own checks.
//
// Nothing is executed and nothing is paid: every planner-model call is
// answered by the suite's stub, retrieval is lexical over the suite's own
// index, and no network call is made.
//
//   node scripts/decide-evolve.mjs                         every planner on its own cluster
//   node scripts/decide-evolve.mjs --harness market-series one planner
//   node scripts/decide-evolve.mjs --all-clusters          every planner on every task
//   node scripts/decide-evolve.mjs --suite path.json --json
//
// Exit code 1 when a planner is worse than the base on a task of its own
// cluster, so a candidate planner can be gated on it.

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BasePlanner, RESUME_STAGE, runPlan } from "../services/decide/base-planner.js";
import { HARNESSES } from "../services/decide/harnesses.js";
import { planMetrics, worseThan } from "../services/decide/harness-router.js";
import { ToolIndex } from "../services/decide/tool-index.js";
import { localToolRow } from "../src/decide/tool-rows.js";
import { decideConfig } from "../src/decide/config.js";

export const DEFAULT_SUITE = new URL("./fixtures/decide-suite.json", import.meta.url);

export function loadSuite(path = DEFAULT_SUITE) {
  const suite = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(suite?.tools) || !Array.isArray(suite?.tasks)) throw new Error("a suite has tools and tasks");
  return suite;
}

/** The suite's tools as first-party rows in a fresh index. */
export function suiteIndex(suite, now) {
  const idx = new ToolIndex();
  for (const t of suite.tools) {
    const row = localToolRow({
      route: `POST /api/${t.slug}`, slug: t.slug, name: t.slug, price: t.price || "$0.01", description: t.description,
      discovery: { inputSchema: { properties: t.props, required: t.required || [] }, output: { example: Object.fromEntries((t.outputFields || []).map((f) => [f, "x"])) } },
    }, { now });
    idx.upsert(row);
  }
  return idx;
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "its", "their", "then", "into", "over", "each", "all", "get", "use", "via", "show", "list", "find", "out", "per", "one", "two", "last", "past"]);
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const words = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));

/** A deterministic stand-in for the fit judge: shared words between the
 *  step and the tool's description. The whole-task candidate never wins, so
 *  the decomposition is what is measured. */
export function stubFit(stepText, description) {
  const a = words(stepText), b = words(description);
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  return shared === 0 ? 0.05 : Math.min(0.95, 0.3 + 0.2 * shared);
}

const GUIDED = /^This is a (market-data|research|media) /;

/** The planner model for one task, answered from the suite. */
export function stubModel(task) {
  const calls = [];
  const answer = (system, user, opts = {}) => {
    const stage = opts.stage || "";
    if (stage === "decompose" || stage === "decompose_retry") {
      const steps = GUIDED.test(system) && task.model.decomposeGuided ? task.model.decomposeGuided : task.model.decompose;
      return steps ? { steps } : null;
    }
    const listing = JSON.parse((/<listings>(.*)<\/listings>/s.exec(user) || [])[1] || "[]");
    if (stage === "judge") {
      const fits = {};
      for (const s of listing) for (const c of s.candidates) fits[c.key] = /^the ENTIRE task/.test(s.purpose) ? 0.2 : stubFit(s.purpose, c.description);
      return { fits };
    }
    if (stage === "params") {
      const params = {};
      const v = task.model.values || {};
      for (const e of listing) {
        const out = {};
        for (const name of Object.keys(e.inputSchema?.properties || {})) {
          const val = v[`${e.name}.${name}`] ?? v[name];
          if (val !== undefined) out[name] = val;
          else if ((e.inputSchema.required || []).includes(name)) out[name] = `<${name}>`;
        }
        params[e.key] = out;
      }
      return { params };
    }
    if (stage === "harness_route") return task.model.route || { harness: task.cluster, confidence: 0.9 };
    return null;
  };
  return { calls, call: async (system, user, opts) => { calls.push({ stage: opts?.stage, system, user }); return answer(system, user, opts); } };
}

/** The task's own checks against a plan: { passed, failed: [why] }. */
export function checkPlan(d, checks = {}) {
  const failed = [];
  const step = (n) => (d.plan || []).find((p) => p.step === n);
  if (Number.isInteger(checks.minSteps) && (d.plan || []).length < checks.minSteps) failed.push(`fewer than ${checks.minSteps} steps`);
  if (checks.noGaps && (d.gaps || []).length) failed.push("has gaps");
  for (const [a, b] of checks.dependsOn || []) if (!(step(a)?.dependsOn || []).includes(b)) failed.push(`step ${a} does not depend on step ${b}`);
  for (const c of checks.paramEquals || []) {
    const got = step(c.step)?.tool?.exampleParams?.[c.name];
    if (JSON.stringify(got) !== JSON.stringify(c.value)) failed.push(`step ${c.step} ${c.name} is ${JSON.stringify(got)}, not ${JSON.stringify(c.value)}`);
  }
  for (const c of checks.queryIncludes || []) {
    const p = step(c.step);
    if (!p || !String(p.purpose || "").toLowerCase().includes(String(c.text).toLowerCase())) failed.push(`step ${c.step} purpose lacks "${c.text}"`);
  }
  for (const c of checks.toolIs || []) if (step(c.step)?.tool?.slug !== c.slug) failed.push(`step ${c.step} tool is ${step(c.step)?.tool?.slug}, not ${c.slug}`);
  const total = (checks.minSteps ? 1 : 0) + (checks.noGaps ? 1 : 0) + ["dependsOn", "paramEquals", "queryIncludes", "toolIs"].reduce((a, k) => a + (checks[k] || []).length, 0);
  return { passed: total - failed.length, total, failed };
}

/** Base and candidate plans for one task, plan-only. */
export async function evaluateTask(suite, task, harness, { now = Date.now(), cfg = decideConfig({}) } = {}) {
  const index = suiteIndex(suite, now);
  const llm = stubModel(task);
  const deps = { index, embed: async () => { throw new Error("offline"); }, llm, cfg, now, deadline: Date.now() + 60_000 };
  const input = { task: task.task, constraints: {}, depth: task.depth || "plan" };
  const stage = RESUME_STAGE[harness.seam];
  const base = await runPlan(new BasePlanner(), input, deps, { snapshotAt: stage === "decompose" ? [] : [stage] });
  const cand = await runPlan(new harness.Harness(), input, deps, stage === "decompose" ? {} : { resume: { stage, state: base.snapshots[stage] } });
  const bm = planMetrics(base.out, base.rows), cm = planMetrics(cand.out, cand.rows);
  return {
    id: task.id, cluster: task.cluster, harness: harness.id,
    base: { ...bm, checks: checkPlan(base.out, task.checks) },
    candidate: { ...cm, checks: checkPlan(cand.out, task.checks) },
    worse: worseThan(cm, bm),
    plans: { base: base.out, candidate: cand.out },
  };
}

export async function evaluateSuite(suite, { harnesses = HARNESSES, allClusters = false } = {}) {
  const rows = [];
  for (const h of harnesses) {
    for (const t of suite.tasks) {
      if (!allClusters && t.cluster !== h.id) continue;
      rows.push(await evaluateTask(suite, t, h));
    }
  }
  const byHarness = {};
  for (const r of rows) {
    const s = (byHarness[r.harness] ||= { tasks: 0, worse: 0, checksBase: 0, checksCandidate: 0, checksTotal: 0, gapsBase: 0, gapsCandidate: 0, misfitBase: 0, misfitCandidate: 0, unlinkedBase: 0, unlinkedCandidate: 0 });
    s.tasks++;
    if (r.worse.length && r.cluster === r.harness) s.worse++;
    s.checksBase += r.base.checks.passed; s.checksCandidate += r.candidate.checks.passed; s.checksTotal += r.base.checks.total;
    s.gapsBase += r.base.gaps; s.gapsCandidate += r.candidate.gaps;
    s.misfitBase += r.base.paramsMisfit; s.misfitCandidate += r.candidate.paramsMisfit;
    s.unlinkedBase += r.base.linkableOpen; s.unlinkedCandidate += r.candidate.linkableOpen;
  }
  return { rows, byHarness };
}

const isMain = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; } })();
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const suite = loadSuite(arg("--suite") || DEFAULT_SUITE);
  const only = arg("--harness");
  const harnesses = only ? HARNESSES.filter((h) => h.id === only) : HARNESSES;
  if (!harnesses.length) { console.error(`no planner "${only}"; registered: ${HARNESSES.map((h) => h.id).join(", ")}`); process.exit(2); }
  const { rows, byHarness } = await evaluateSuite(suite, { harnesses, allClusters: process.argv.includes("--all-clusters") });
  if (process.argv.includes("--json")) console.log(JSON.stringify({ byHarness, rows: rows.map(({ plans, ...r }) => r) }, null, 2));
  else {
    for (const r of rows) {
      const tag = r.worse.length ? `WORSE (${r.worse.join(", ")})` : "not worse";
      console.log(`${r.harness.padEnd(20)} ${r.id.padEnd(14)} ${tag.padEnd(12)} checks ${r.base.checks.passed}/${r.base.checks.total} -> ${r.candidate.checks.passed}/${r.candidate.checks.total}`);
    }
    for (const [id, s] of Object.entries(byHarness)) console.log(`${id}: ${s.tasks} tasks, worse on own cluster ${s.worse}, checks ${s.checksBase} -> ${s.checksCandidate} of ${s.checksTotal}, gaps ${s.gapsBase} -> ${s.gapsCandidate}, misfit ${s.misfitBase} -> ${s.misfitCandidate}, unlinked ${s.unlinkedBase} -> ${s.unlinkedCandidate}`);
  }
  process.exit(Object.values(byHarness).some((s) => s.worse > 0) ? 1 : 0);
}
