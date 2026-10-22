// Decide instrumentation, offline: the planner version, the text-free plan
// shape, the decision-to-run join on the ledger, the fixed skip codes on each
// attempt, the own-traffic flag, and the operator stats built from them. A
// stub model, a stub embedder, a file ledger in a temp dir.
//
//   node scripts/test-decide-instrumentation.js

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannerVersion } from "../services/decide/llm.js";
import { decide, state } from "../services/decide/server.js";
import { MemoryDecisionStore, makeDecisionCache } from "../services/decide/decision-store.js";
import { ToolIndex } from "../services/decide/tool-index.js";
import { localToolRow } from "../src/decide/tool-rows.js";
import { planShape, shapeKeyOf, toolKey } from "../src/decide/plan-shape.js";
import { SKIP_CODES, skipCodeOf, attemptErrorCode } from "../src/decide/skip-codes.js";
import { aggregateDecideStats } from "../src/decide/stats.js";
import { openDecideLedger } from "../src/decide/ledger.js";
import { DEFAULTS } from "../src/decide/config.js";
import { makeDecideHandler, makeExecuteHandler, SKETCH_PLANNER_VERSION } from "../src/tools/decide-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// ---- 1. planner version ----
{
  const v = plannerVersion(DEFAULTS);
  ok(/^pv_[0-9a-f]{12}$/.test(v) && v === plannerVersion({ ...DEFAULTS }), `a short, stable hash (${v})`);
  ok(plannerVersion({ ...DEFAULTS, model: "other/model" }) !== v, "a different model id is a different version");
  ok(plannerVersion({ ...DEFAULTS, maxSteps: DEFAULTS.maxSteps + 1 }) !== v, "a different decompose template (its step bound) is a different version");
  ok(plannerVersion({ ...DEFAULTS, harness: { ...DEFAULTS.harness, minConfidence: 0.9 } }) !== v, "a different router threshold is a different version");
}

// ---- 2. plan shape ----
{
  const fp = (slug, cat) => ({ id: `id-${slug}`, slug, firstParty: true, category: cat });
  const ext = { id: "ab12cd", slug: "/api/x", firstParty: false, seller: "seller.example" };
  const planA = [
    { step: 1, purpose: "resolve vitalik.eth", tool: fp("ens-resolve", "payments"), dependsOn: [] },
    { step: 2, purpose: "read the balance of 0xabc", tool: ext, dependsOn: [1] },
  ];
  const planB = [
    { step: 1, purpose: "an entirely different task text", tool: fp("ens-resolve", "payments"), dependsOn: [] },
    { step: 2, purpose: "with other words", tool: ext, dependsOn: [1] },
  ];
  const a = planShape(planA, { gaps: ["one"], categories: ["payments", "chain"] });
  const b = planShape(planB, { gaps: ["two"], categories: ["payments", "chain"] });
  ok(a.shapeKey === b.shapeKey && /^[0-9a-f]{16}$/.test(a.shapeKey), "two plans with the same tools, edges and gap count share a shapeKey whatever their text");
  ok(a.stepCount === 2 && a.gapCount === 1 && JSON.stringify(a.edges) === "[[0,1]]" && a.slugs.join() === "ens-resolve,ext:ab12cd" && a.categories.join() === "chain,payments", `fields: steps, gaps, edges as index pairs, sorted keys and categories (${JSON.stringify(a)})`);
  ok(!/vitalik|0xabc|seller\.example|balance/.test(JSON.stringify(a)), "the shape carries no task text, value or seller host");
  ok(toolKey(ext) === "ext:ab12cd" && toolKey(fp("hash")) === "hash", "an outside tool is keyed by its opaque row id, ours by slug");
  ok(planShape(planA, { gaps: ["one"], categories: ["payments", "chain"], collapsedToOneStep: true }).shapeKey !== a.shapeKey
    && planShape(planA, { gaps: ["one"], categories: ["payments", "chain"], judgeFailed: true }).shapeKey !== a.shapeKey, "each flag is part of the key");
  ok(shapeKeyOf(a) === a.shapeKey, "the key is recomputable from the stored fields");
}

// ---- 1+2 through the decide service: version and shape kept, shape kept with no text ----
{
  const NOW = Date.now();
  state.index = new ToolIndex();
  for (const [slug, desc, cat] of [["hash", "sha256 hash of text", "crypto"], ["qr", "QR code image for a URL", "media"]]) {
    state.index.upsert(localToolRow({ route: `POST /api/${slug}`, slug, name: slug, price: "$0.001", category: cat, description: desc, discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] } } }, { now: NOW }));
  }
  state.decisions = new MemoryDecisionStore();
  state.cache = makeDecisionCache(60_000);
  state.loadedRows = 2; state.lastSync = { complete: true };
  state.llm = {
    call: async (_s, _u, { stage } = {}) => {
      if (stage === "decompose" || stage === "decompose_retry") return { steps: [{ purpose: "hash text", query: "sha256 hash", dependsOn: [] }] };
      if (stage === "judge") return { fits: { s1c1: 0.9, s1c2: 0.1, s2c1: 0.2, s2c2: 0.1 } };
      return { params: { 1: { text: "secret words" } } };
    },
  };
  state.jev = { judge: async () => null, choose: async () => null, checkParams: async () => null };
  // Stub the embeddings upstream so the plan is complete (a partial plan is never cached).
  process.env.OPENAI_API_KEY = "stub";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (!String(u).includes("api.openai.com/v1/embeddings")) return realFetch(u, init);
    const input = JSON.parse(init.body).input;
    return { ok: true, status: 200, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: 512 }, (_, k) => ((k + i) % 7) / 7) })), usage: { total_tokens: 5 * input.length } }) };
  };
  const res = await decide({ task: "hash the secret words with sha256", depth: "plan", synthetic: true });
  ok(res.plannerVersion === `${state.plannerVersion}:${res.harness?.id || "base"}` && /^pv_[0-9a-f]{12}:[a-z-]+$/.test(res.plannerVersion), `the service stamps every decision with its boot-time planner version and the harness that built it (${res.plannerVersion})`);
  ok(res.shape?.shapeKey && res.shape.stepCount === res.plan.length && res.shape.categories.includes("crypto"), "the service returns the plan's shape to the main app");
  ok(!("_shapeMeta" in res) && !("_rankingLog" in res), "the planner's internal fields stay internal");
  const kept = await state.decisions.getShape(res.decisionId);
  ok(kept && kept.shapeKey === res.shape.shapeKey && kept.plannerVersion === res.plannerVersion && kept.synthetic === true && kept.depth === "plan", "the shape is kept with the version and the own-traffic flag");
  ok(!/secret|sha256 hash|hash text/.test(JSON.stringify(kept)), "the kept shape holds no task text or parameter value");
  const again = await decide({ task: "hash the secret words with sha256", depth: "plan" });
  globalThis.fetch = realFetch;
  ok(again.cached === true && again.shape.shapeKey === res.shape.shapeKey && (await state.decisions.getShape(again.decisionId))?.synthetic === false, "a cache hit is its own decision with the same shape (and its own flag)");
}

// ---- 3+5 the join, through the main app's handlers, on a file ledger ----
const dir = mkdtempSync(join(tmpdir(), "decide-instr-"));
const ledger = openDecideLedger(join(dir, "ledger.db"));
let clock = 1_800_000_000_000;
const now = () => clock;
const mkReq = (payer = "0xabc", extra = {}) => ({ headers: {}, ip: payer, ...extra });
const own = (req) => req?.headers?.["x-own"] === "1";
{
  const realFetch = globalThis.fetch;
  process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
  let sent = null;
  const tool = { id: "a", slug: "a", firstParty: true, priceUsd: 0.01, executeViaAgent402Usd: 0.01, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "x" } };
  globalThis.fetch = async (_u, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ decisionId: "dj1", plan: [{ step: 1, tool, fallbacks: [], dependsOn: [] }], judged: true, gaps: [], estimatedCostViaAgent402Usd: 0.01, plannerVersion: "pv_000000000001", shape: { shapeKey: "abcdabcdabcdabcd", stepCount: 1 } }), { status: 200 }); };
  const decideH = makeDecideHandler({ ledger, now, isOwnTraffic: own });
  const out = await decideH({ task: "do it", depth: "plan" }, mkReq("0xabc", { headers: { "x-own": "1" } }));
  globalThis.fetch = realFetch;
  ok(sent.synthetic === true, "the own-traffic flag is sent to the decide service");
  ok(!("plannerVersion" in out) && !("shape" in out), "the planner version and shape are not part of the buyer's answer");
  const row = ledger.getDecision("dj1");
  ok(row.plannerVersion === "pv_000000000001" && row.shapeKey === "abcdabcdabcdabcd" && row.synthetic === true, "the ledger's decision row carries version, shapeKey and the flag");
  ledger.markDecisionSettled("dj1");

  const catalog = { a: { slug: "a", route: "POST /api/a", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => ({ a: p.q }) } };
  const exec = makeExecuteHandler({ ledger, getCatalog: () => catalog, now, isOwnTraffic: own, runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }) });
  const run = await exec({ decisionId: "dj1", maxBudgetUsd: 0.01 }, mkReq("0xdef"));
  const r = ledger.getRun(run.runId);
  ok(r.decision_id === "dj1" && r.shape_key === "abcdabcdabcdabcd" && r.planner_version === "pv_000000000001", "a run row carries its decision id, shapeKey and planner version");
  ok(Number(r.synthetic) === 1, "a run of an own-traffic decision is own traffic");
  // A sketch run: the shape is computed here, the version names the sketch.
  const cat2 = {
    s1: { slug: "s1", route: "POST /api/s1", price: "$0.001", category: "web", discovery: { bodyType: "json", inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } }, handler: async () => ({ out: "v" }) },
    s2: { slug: "s2", route: "POST /api/s2", price: "$0.001", category: "web", discovery: { bodyType: "json", inputSchema: { properties: { out: { type: "string" } }, required: ["out"] } }, handler: async () => ({ done: true }) },
  };
  const execS = makeExecuteHandler({ ledger, getCatalog: () => cat2, now, isOwnTraffic: own, runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }) });
  const srun = await execS({ steps: ["s1", "s2"], params: { 1: { q: "hello" } } }, mkReq("0x111"));
  const sr = ledger.getRun(srun.runId);
  const sd = ledger.getDecision(srun.decisionId);
  ok(sr.planner_version === SKETCH_PLANNER_VERSION && sd.plannerVersion === SKETCH_PLANNER_VERSION, "a sketch run and its decision record the sketch planner version");
  ok(sr.shape_key && sr.shape_key === sd.shapeKey && sr.shape_key === planShape(sd.plan, { gaps: [] }).shapeKey, "a sketch's shapeKey is the shared rule applied to its plan");
  ok(Number(sr.synthetic) === 0, "an outside caller's run is not own traffic");
}

// ---- 4. skip codes ----
{
  ok(SKIP_CODES.length === 10 && ["params_misfit", "needs_input", "ref_unresolved", "call_directly", "seller_refused", "upstream_5xx", "timeout", "budget", "halt", "other"].every((c) => SKIP_CODES.includes(c)), "the ten fixed codes");
  // Every free-text reason the execute handler writes, read back to its code.
  const texts = [
    ["needs address: pass params for this step", "needs_input"],
    ["this seller declares no inputs: pass params for this step", "needs_input"],
    ["needs the output of step 1, which did not run: pass params for this step", "ref_unresolved"],
    ["step 1's output has no address field: pass params for this step", "ref_unresolved"],
    ["params do not fit: q is required", "params_misfit"],
    ["call this tool directly: execute cannot pay it", "call_directly"],
    ["no longer in the catalog", "call_directly"],
    ["priced per request; call it directly", "call_directly"],
    ["a report product; call it directly", "call_directly"],
    ["external execution is not enabled on this host", "call_directly"],
    ["the run's time budget is spent", "timeout"],
    ["over the remaining budget", "budget"],
    ["this seller's daily execution ceiling is reached", "budget"],
    ["outside steps are paused while our spending wallet is topped up", "budget"],
    ["the run was refused before this leg started", "halt"],
    ["the run stopped on an internal error", "halt"],
    ["the run was stopped: draining", "halt"],
    ["the spend ledger is unavailable; this leg was not paid", "other"],
  ];
  for (const [t, c] of texts) ok(skipCodeOf({ skipped: t }) === c, `legacy reason "${t.slice(0, 40)}" reads as ${c}`);
  ok(skipCodeOf({ error: 'External seller "x" failed: Seller refused the payment (HTTP 400)', status: 400 }) === "seller_refused", "a refused payment reads as seller_refused");
  ok(skipCodeOf({ error: "s did not answer within 45 s", status: 504 }) === "timeout" && skipCodeOf({ error: "boom", status: 502 }) === "upstream_5xx" && skipCodeOf({ error: "bad input", status: 400 }) === "params_misfit", "errors: timeout, 5xx, 4xx");
  ok(skipCodeOf({ skipped: "anything", code: "budget" }) === "budget" && skipCodeOf({ skipped: "x", code: "made_up" }) === "other", "a recorded code wins; an unknown one is never passed through");
  ok(attemptErrorCode({ runStopped: true, statusCode: 503 }) === "halt" && attemptErrorCode({}, { sellerRefused: true }) === "seller_refused", "a stopped run is halt, a refusal seller_refused");

  // Codes written by the handler itself, on a live run.
  const catalog = {
    rep: { slug: "rep", route: "POST /api/rep", price: "$0.01", discovery: { bodyType: "json" }, handler: async () => ({}) },
    b5: { slug: "b5", route: "POST /api/b5", price: "$0.01", discovery: { bodyType: "json" }, handler: async () => { throw Object.assign(new Error("upstream down"), { statusCode: 502 }); } },
    ok1: { slug: "ok1", route: "POST /api/ok1", price: "$0.01", discovery: { bodyType: "json" }, handler: async () => ({ fine: true }) },
  };
  const t = (slug, extra = {}) => ({ id: slug, slug, firstParty: true, priceUsd: 0.01, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "v" }, ...extra });
  const plan = [
    { step: 1, purpose: "p1", tool: t("rep"), fallbacks: [t("b5"), t("gone"), t("ok1", { exampleParams: { q: "<q>" } }), t("ok1", { exampleParams: { q: 5 } })], dependsOn: [] },
    { step: 2, purpose: "p2", tool: t("ok1", { exampleParams: { q: "{{step 9}}" } }), fallbacks: [], dependsOn: [] },
  ];
  ledger.saveDecision({ decisionId: "dsk", depth: "plan", priceUsd: 0.02, payer: "0xs", plan, costViaUsd: 0.05, now: clock, plannerVersion: "pv_x", shapeKey: "k1" });
  ledger.markDecisionSettled("dsk");
  const exec = makeExecuteHandler({ ledger, getCatalog: () => catalog, now, isComposite: (s) => s === "rep", runBudgetMs: () => null, spendingWalletStatus: async () => ({ status: "ok" }) });
  const e = await exec({ decisionId: "dsk", maxBudgetUsd: 0.05 }, mkReq("0xs")).catch((x) => x);
  const steps = e?.steps || [];
  const codes = (steps[0]?.attempts || []).map((a) => a.code);
  ok(JSON.stringify(codes) === JSON.stringify(["call_directly", "upstream_5xx", "call_directly", "needs_input", "params_misfit"]), `each attempt carries its code beside its reason (${JSON.stringify(codes)})`);
  ok(steps[1]?.status === "skipped" && steps[1]?.code === "ref_unresolved" && steps[1]?.attempts?.[0]?.code === "ref_unresolved", "a skipped step carries the code of its first input skip");
  ok((steps[0]?.attempts || []).every((a) => typeof (a.skipped ?? a.error) === "string"), "the free-text reason is still there");
  globalThis.__runSteps = steps;
}

// ---- 6. stats aggregation ----
{
  const DAY = 86_400_000;
  const t0 = 1_900_000_000_000;
  const rows = {
    decisions: [
      { id: "d1", createdAt: t0 - 1 * DAY, depth: "plan", payer: "0xbuyer1", settled: true, plannerVersion: "pv_a", shapeKey: "s1", synthetic: false },
      { id: "d2", createdAt: t0 - 2 * DAY, depth: "quick", payer: "0xbuyer2", settled: false, plannerVersion: "pv_a", shapeKey: "s2", synthetic: false },
      { id: "d3", createdAt: t0 - 10 * DAY, depth: "plan", payer: "0xbuyer1", settled: true, plannerVersion: "pv_b", shapeKey: "s1", synthetic: false },
      { id: "d4", createdAt: t0 - 1 * DAY, depth: "full", payer: "0xours", settled: true, plannerVersion: "pv_a", shapeKey: "s1", synthetic: false },
      { id: "d5", createdAt: t0 - 1 * DAY, depth: "plan", payer: "0xprobe", settled: true, plannerVersion: "pv_a", shapeKey: "s1", synthetic: true },
      { id: "d6", createdAt: t0 - 40 * DAY, depth: "plan", payer: "0xold", settled: true, plannerVersion: "pv_a", shapeKey: "s1", synthetic: false },
    ],
    runs: [
      { id: "r1", decisionId: "d1", payer: "0xbuyer1", status: "complete", createdAt: t0 - 1 * DAY, plannerVersion: "pv_a", shapeKey: "s1", synthetic: false, steps: [{ status: "ok", attempts: [{ skipped: "over the remaining budget" }] }] },
      { id: "r2", decisionId: "d3", payer: "0xbuyer1", status: "failed", createdAt: t0 - 10 * DAY, plannerVersion: "pv_b", shapeKey: "s1", synthetic: false, steps: globalThis.__runSteps },
      { id: "r3", decisionId: "d4", payer: "0xours", status: "partial", createdAt: t0 - 1 * DAY, plannerVersion: "pv_a", shapeKey: "s1", synthetic: false, steps: [{ status: "skipped", reason: "the run was stopped (x) before this step started", attempts: [] }] },
    ],
  };
  const st = aggregateDecideStats(rows, { now: t0, isOurs: (r) => r.synthetic === true || r.payer === "0xours" });
  const w7 = st.windows["7d"], w30 = st.windows["30d"];
  ok(w7.external.decisions.made === 2 && w7.external.decisions.settled === 1 && w30.external.decisions.made === 3, `decisions by window, outside buyers (7d ${w7.external.decisions.made}, 30d ${w30.external.decisions.made}); a row past 30 days is out`);
  ok(w7.ours.decisions.made === 2 && w7.ours.executions.runs === 1, "own wallets and signed probes are counted apart");
  ok(w30.external.distinctPayers.decisions === 1 && w30.external.distinctPayers.runs === 1, "distinct payers: settled decisions and runs");
  ok(w30.external.executions.runs === 2 && w30.external.executions.byStatus.complete === 1 && w30.external.executions.byStatus.failed === 1, "executions by outcome");
  ok(w30.external.skipCodes.budget === 1 && w30.external.skipCodes.call_directly === 2 && w30.external.skipCodes.upstream_5xx === 1 && w30.external.skipCodes.ref_unresolved === 1, `skip-code counts (${JSON.stringify(w30.external.skipCodes)})`);
  ok(w7.ours.skipCodes.halt === 1, "a step skipped before it started counts as halt");
  const s1 = w30.external.shapes.listed.find((x) => x.shapeKey === "s1");
  ok(s1 && s1.decisions === 2 && s1.runs === 2 && s1.complete === 1 && s1.successRate === 0.5, `per shape: counts and success rate (${JSON.stringify(s1)})`);
  const pa = w30.external.plannerVersions.listed.find((x) => x.plannerVersion === "pv_a");
  const pb = w30.external.plannerVersions.listed.find((x) => x.plannerVersion === "pv_b");
  ok(pa?.successRate === 1 && pb?.successRate === 0, "per planner version success rate");
  const flat = JSON.stringify(st);
  ok(!/0xbuyer|0xours|0xprobe|0xold|"d1"|"r1"/.test(flat), "aggregates only: no payer and no decision or run id in the output");
}

// ---- 6 on the ledger: statsRows ----
{
  const rows = ledger.statsRows(0);
  const d = rows.decisions.find((x) => x.id === "dj1");
  const r = rows.runs.find((x) => x.decisionId === "dj1");
  ok(d && d.shapeKey === "abcdabcdabcdabcd" && d.synthetic === true && d.settled === true && !("plan" in d), "statsRows: decisions with version, shape and flag, no plan");
  ok(r && r.shapeKey === "abcdabcdabcdabcd" && Array.isArray(r.steps) && !("spent_micro" in r), "statsRows: runs with their steps and join fields");
}

console.log(`\ntest-decide-instrumentation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
