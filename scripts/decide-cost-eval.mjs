// Serving-cost and quality evaluation for the decide service. NOT in CI: it
// makes real model calls. It talks to the decide service DIRECTLY (token-gated
// internal routes), so it can read each decision's metered cost, which the
// public route never returns.
//
//   DECIDE_URL=http://127.0.0.1:PORT DECIDE_INTERNAL_TOKEN=... \
//     node scripts/decide-cost-eval.mjs --tasks tasks.json --depths quick,plan,full --out out.json [--concurrency 2]
//
// tasks.json: [{ id, task, budget? }]. Run the service with its cache off
// (DECIDE_CONFIG='{"cacheTtlMs":0}') to measure real cost and latency.

import { readFileSync, writeFileSync } from "node:fs";
import { validateParams } from "../src/decide/params.js";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = (process.env.DECIDE_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
const TOKEN = process.env.DECIDE_INTERNAL_TOKEN || "";
const tasks = JSON.parse(readFileSync(arg("--tasks"), "utf8"));
const depths = String(arg("--depths", "plan")).split(",");
const OUT = arg("--out", null);
const CONC = Math.max(1, Number(arg("--concurrency", 2)));

async function post(path, body, timeoutMs = 60_000) {
  const r = await fetch(URL_ + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

function executable(plan) {
  const problems = [];
  for (const s of plan || []) {
    const t = s.tool;
    if (!t?.id) { problems.push(`step ${s.step}: no tool`); continue; }
    const params = t.exampleParams || {};
    if (JSON.stringify(params).includes("<")) problems.push(`step ${s.step}: unfilled placeholder`);
    const v = validateParams(t.inputSchema || {}, params);
    if (!v.ok) problems.push(`step ${s.step}: ${String((v.errors || []).join("; ") || "invalid").slice(0, 80)}`);
  }
  return { ok: problems.length === 0, problems };
}

const pct = (xs, q) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };

const rows = [];
const jobs = [];
for (const depth of depths) for (const t of tasks) jobs.push({ depth, t });
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { depth, t } = jobs[next++];
    const t0 = Date.now();
    let res, cost = null, error = null;
    try {
      res = await post("/internal/decide", { task: t.task, depth, constraints: t.budget ? { maxBudgetUsd: t.budget } : {}, deadlineAt: Date.now() + 40_000 });
      if (res.status === 200) cost = (await post("/internal/decision-cost", { decisionId: res.body.decisionId })).body.cost;
      else error = `${res.status} ${res.body?.error || ""}`.slice(0, 120);
    } catch (e) { error = String(e?.message || e).slice(0, 120); }
    const d = res?.body || {};
    const ex = d.plan ? executable(d.plan) : { ok: false, problems: ["no plan"] };
    const row = {
      id: t.id, depth, task: t.task, status: res?.status || 0, error, ms: Date.now() - t0,
      steps: d.plan?.length || 0, gaps: (d.gaps || []).length, partial: !!d.partial, notes: d.notes || [], confidence: d.confidence ?? null,
      firstPartySteps: (d.plan || []).filter((s) => s.tool?.firstParty).length,
      tools: (d.plan || []).map((s) => s.tool?.slug || s.tool?.id),
      estimatedCostUsd: d.estimatedCostUsd ?? null,
      executable: ex.ok, problems: ex.problems,
      cost: cost ? { modelCalls: cost.modelCalls, modelUsd: cost.modelUsd, modelUsdUnknown: cost.modelUsdUnknown, promptTokens: cost.promptTokens, cachedTokens: cost.cachedTokens, completionTokens: cost.completionTokens, embedTokens: cost.embedTokens, fallbackUsed: cost.fallbackUsed, failedAttempts: cost.failedAttempts, stages: (cost.calls || []).map((c) => `${c.stage}:${c.model}:${c.outcome}`) } : null,
    };
    rows.push(row);
    process.stdout.write(`${depth} ${t.id} ${row.status} ${row.ms}ms $${row.cost?.modelUsd ?? "?"} ${row.executable ? "exec" : "NOT-exec"} ${row.cost?.fallbackUsed ? "FALLBACK" : ""}\n`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const summary = {};
for (const depth of depths) {
  const r = rows.filter((x) => x.depth === depth);
  const okRows = r.filter((x) => x.status === 200);
  const usd = okRows.map((x) => x.cost?.modelUsd).filter(Number.isFinite);
  const fb = okRows.filter((x) => x.cost?.fallbackUsed);
  summary[depth] = {
    n: r.length, ok200: okRows.length, partial: okRows.filter((x) => x.partial).length,
    executable: okRows.filter((x) => x.executable).length,
    msP50: pct(r.map((x) => x.ms), 0.5), msP95: pct(r.map((x) => x.ms), 0.95),
    modelUsdP50: pct(usd, 0.5), modelUsdP95: pct(usd, 0.95), modelUsdMax: pct(usd, 1), modelUsdMean: usd.length ? usd.reduce((a, b) => a + b, 0) / usd.length : null,
    modelCallsMean: okRows.length ? okRows.reduce((a, x) => a + (x.cost?.modelCalls || 0), 0) / okRows.length : null,
    promptTokensP95: pct(okRows.map((x) => x.cost?.promptTokens), 0.95), completionTokensP95: pct(okRows.map((x) => x.cost?.completionTokens), 0.95),
    embedTokensMean: okRows.length ? okRows.reduce((a, x) => a + (x.cost?.embedTokens || 0), 0) / okRows.length : null,
    fallbackRate: okRows.length ? fb.length / okRows.length : null,
    fallbackModelUsdMean: fb.length ? fb.reduce((a, x) => a + (x.cost?.modelUsd || 0), 0) / fb.length : null,
    failedAttemptKinds: Object.entries(okRows.flatMap((x) => x.cost?.failedAttempts || []).reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})),
    gapsRate: okRows.length ? okRows.filter((x) => x.gaps > 0).length / okRows.length : null,
    firstPartyStepShare: (() => { const s = okRows.reduce((a, x) => a + x.steps, 0); return s ? okRows.reduce((a, x) => a + x.firstPartySteps, 0) / s : null; })(),
  };
}
console.log(JSON.stringify(summary, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), url: URL_, depths, summary, rows }, null, 2));
