// Decide's specialized planners (services/decide/harness*.js): the registry
// and its one-seam rule, the base plan kept when the router says base, the
// router threshold and fallbacks, seller neutrality, each planner's seam,
// no stage repeated (nothing is executed or paid), field-named step
// references at run time, and the synthetic suite run plan-only.
// Offline: stub planner model, lexical retrieval, no network.
//
//   node scripts/test-decide-harness.js

import { buildDecision, BasePlanner, SEAMS, runPlan, RESUME_STAGE, selectFallbacks } from "../services/decide/planner.js";
import { defineHarness, makeRegistry, ownSeams } from "../services/decide/harness.js";
import { HARNESSES, harnessById, chainIdentifiers, checkChainParams, seriesRange, mediaFormat, refFor, addressFamily } from "../services/decide/harnesses.js";
import { planMetrics, worseThan, routerModel, routerPrompt, planShape, PLANNER_VERSION } from "../services/decide/harness-router.js";
import { resolveStepRefs } from "../src/decide/step-refs.js";
import { validateParams } from "../src/decide/params.js";
import { decideConfig } from "../src/decide/config.js";
import { loadSuite, evaluateSuite, evaluateTask, stubModel, suiteIndex } from "./decide-evolve.mjs";

delete process.env.OPENROUTER_API_KEY; delete process.env.DECIDE_OPENROUTER_API_KEY;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const cfg = decideConfig({});
const suite = loadSuite();
const taskOf = (id) => structuredClone(suite.tasks.find((t) => t.id === id));
const NOW = Date.now();
const depsFor = (task, over = {}) => ({ index: suiteIndex(suite, NOW), embed: async () => { throw new Error("offline"); }, llm: stubModel(task), cfg, now: NOW, deadline: Date.now() + 60_000, ...over });
const input = (t) => ({ task: t.task, constraints: {}, depth: t.depth || "plan" });
const strip = (d) => JSON.stringify({ ...d, decisionId: null, harness: null, plannerVersion: null });
const orderOf = (d) => d.plan.map((p) => [p.purpose, p.tool.id, ...p.fallbacks.map((f) => f.id)]);

// ---- registry: one seam each, frozen, base-only ranking ----
{
  ok(HARNESSES.length === 5 && new Set(HARNESSES.map((h) => h.id)).size === 5, `five planners registered (${HARNESSES.map((h) => `${h.id}:${h.seam}`).join(", ")})`);
  ok(HARNESSES.every((h) => SEAMS.includes(h.seam) && ownSeams(h.Harness).join() === h.seam), "each planner's only own method is its declared seam");
  ok(HARNESSES.every((h) => h.designLesson.length > 80 && h.routingLesson.length > 80 && h.cluster.description && h.cluster.classifier), "each planner carries a cluster description, classifier, design lesson and routing lesson");
  ok(HARNESSES.every((h) => Object.isFrozen(h.Harness.prototype) && Object.getPrototypeOf(h.Harness.prototype) === BasePlanner.prototype) && Object.isFrozen(BasePlanner.prototype), "planner prototypes are frozen and extend the base directly");
  ok(["chained-lookups:dependencyWiring", "onchain-identifiers:paramsFill", "market-series:decompose", "research-sources:decompose", "media-pipeline:decompose"].every((x) => HARNESSES.some((h) => `${h.id}:${h.seam}` === x)), "the five planners override wiring, params fill and decomposition as declared");
  const spec = { id: "probe", seam: "decompose", override: (b, ...a) => b(...a), cluster: { description: "a probe cluster for registry tests", classifier: "is this a probe task for the registry?", appliesTo: () => true }, designLesson: "x".repeat(50), routingLesson: "y".repeat(50) };
  let threw = null;
  try { defineHarness({ ...spec, seam: "rank" }); } catch (e) { threw = e; }
  ok(threw && /seam must be one of/.test(threw.message), "a planner cannot declare scoring or ranking as its seam");
  const h = defineHarness(spec);
  threw = null;
  try { Object.defineProperty(h.Harness.prototype, "backupPolicy", { value: () => ({ count: 0 }) }); } catch (e) { threw = e; }
  ok(threw instanceof TypeError, "a second override cannot be added to a defined planner");
  class Sneaky extends BasePlanner { decompose(c) { return super.decompose(c); } backupPolicy() { return { count: 1 }; } }
  threw = null;
  try { makeRegistry([{ ...h, id: "sneaky", Harness: Sneaky }]); } catch (e) { threw = e; }
  ok(threw && /overrides decompose, backupPolicy/.test(threw.message), "the registry refuses a planner overriding more than one seam");
  threw = null;
  try { BasePlanner.prototype.decompose = () => null; } catch (e) { threw = e; }
  ok(threw instanceof TypeError || BasePlanner.prototype.decompose.toString().includes("decomposePrompt"), "the base planner's seams cannot be replaced at run time");
  ok(Object.keys(RESUME_STAGE).join() === SEAMS.join(), "every seam names the stage a re-plan resumes from");
}

// ---- the router says base: the plan is the base plan, unchanged ----
{
  const t = taskOf("chained-01");
  t.model.route = { harness: "base", confidence: 0.99 };
  const routed = await buildDecision(input(t), depsFor(t));
  const off = await buildDecision(input(t), depsFor(t, { cfg: decideConfig({ DECIDE_CONFIG: JSON.stringify({ harness: { router: "off" } }) }) }));
  ok(routed.harness.id === "base" && /kept the base/.test(routed.harness.reason) && routed.harness.router.pick === "base", `router base keeps the base (${routed.harness.reason})`);
  ok(strip(routed) === strip(off), "a base pick serves exactly the plan the router-off planner builds");
  ok(off.harness.id === "base" && off.harness.reason === "router off" && !off.harness.router, "router off: no router call, base recorded");
  ok(routed.plannerVersion === PLANNER_VERSION && off.plannerVersion === PLANNER_VERSION, "every decision records the planner version");
  const qd = depsFor(t);
  const quick = await buildDecision({ ...input(t), depth: "quick" }, qd);
  ok(quick.harness.id === "base" && !qd.llm.calls.some((c) => c.stage === "harness_route") && quick.plan.length === 1, "quick depth never routes");
  const noTask = await buildDecision({ task: "count the words in this sentence please", constraints: {}, depth: "plan" }, depsFor({ ...t, model: { decompose: [{ purpose: "count words", query: "count words", dependsOn: [] }], values: {} } }));
  ok(noTask.harness.id === "base" && /no specialized planner applies/.test(noTask.harness.reason), "a task no cluster applies to makes no router call");
}

// ---- threshold and fallback ----
{
  const t = taskOf("chained-01");
  t.model.route = { harness: "chained-lookups", confidence: 0.5 };
  const low = await buildDecision(input(t), depsFor(t));
  ok(low.harness.id === "base" && /threshold/.test(low.harness.reason) && low.harness.router.threshold === 0.7, `a pick below the threshold keeps the base (${low.harness.router.confidence} < ${low.harness.router.threshold})`);
  t.model.route = { harness: "chained-lookups", confidence: 0.9 };
  const high = await buildDecision(input(t), depsFor(t));
  ok(high.harness.id === "chained-lookups" && high.harness.seam === "dependencyWiring", `a confident pick re-plans with that planner (${high.harness.reason})`);
  ok(high.plan[1].tool.slug === "stock-quote" && high.plan[1].tool.exampleParams.symbol === "{{step 1.ticker}}" && low.plan[1].tool.slug === "company-lookup", "the chained planner links symbol to step 1's ticker field; the base, left with a <symbol> placeholder, fell back to a tool that needs no input");
  t.model.route = { harness: "media-pipeline", confidence: 0.99 };
  const notOffered = await buildDecision(input(t), depsFor(t));
  ok(notOffered.harness.id === "base" && /not offered/.test(notOffered.harness.reason), "a planner whose cluster does not apply cannot be picked");
  t.model.route = { harness: "chained-lookups", confidence: "high" };
  const bad = await buildDecision(input(t), depsFor(t));
  ok(bad.harness.id === "base", "an unreadable confidence reads as zero");
  t.model.route = null;
  const none = await buildDecision(input(t), depsFor(t, { llm: { call: async (s, u, o) => (o?.stage === "harness_route" ? null : stubModel(t).call(s, u, o)) } }));
  ok(none.harness.id === "base" && /no answer/.test(none.harness.reason), "a failed router call keeps the base");

  // A planner that throws, and one that makes the plan worse.
  const probe = (id, override) => defineHarness({ id, seam: "dependencyWiring", override, cluster: { description: "probe cluster that applies to every task", classifier: "always applies, for testing only", appliesTo: () => true }, designLesson: "probe ".repeat(10), routingLesson: "probe ".repeat(10) });
  const throws = probe("probe-throws", () => { throw new Error("boom"); });
  const worse = probe("probe-worse", (base, ctx, plan, slots) => { base(ctx, plan, slots); for (const sl of slots) for (const k of Object.keys(sl.target.exampleParams || {})) sl.target.exampleParams[k] = `<${k}>`; });
  for (const [h, re] of [[throws, /failed/], [worse, /worse: .*misfit/]]) {
    t.model.route = { harness: h.id, confidence: 0.95 };
    const d = await buildDecision(input(t), depsFor(t, { harnesses: makeRegistry([h]) }));
    ok(d.harness.id === "base" && re.test(d.harness.reason) && strip(d) === strip(low), `${h.id}: base kept (${d.harness.reason})`);
  }
  const m = { steps: 2, gaps: 0, runnableSteps: 2, paramsMisfit: 0, unresolvedRefs: 0, linkableOpen: 0, partial: false, judged: true };
  ok(!worseThan(m, m).length && worseThan({ ...m, gaps: 1 }, m).includes("more gaps") && worseThan({ ...m, runnableSteps: 1 }, m).includes("fewer runnable steps") && worseThan({ ...m, unresolvedRefs: 1 }, m).length && worseThan({ ...m, partial: true }, m).includes("partial"), "worse = more gaps, fewer runnable steps, more misfit or unresolved references, or partial");
}

// ---- neutrality: same candidates, same order, whichever planner runs ----
{
  // Every planner over the same steps (the stub answers the same steps to
  // every decomposition) and the same fits must order every step's tools
  // identically: no planner reaches scoring, selection or order.
  const t = taskOf("onchain-12");
  t.model.decomposeGuided = t.model.decompose;
  const base = await runPlan(new BasePlanner(), input(t), depsFor(t));
  const orders = [], logs = [];
  for (const h of HARNESSES) {
    const r = await runPlan(new h.Harness(), input(t), depsFor(t));
    orders.push([h.id, orderOf(r.out)]);
    logs.push([h.id, JSON.stringify(r.out._rankingLog)]);
  }
  const want = JSON.stringify(orderOf(base.out));
  ok(orders.every(([, o]) => JSON.stringify(o) === want), `every planner keeps the base's tool order per step (${orders.filter(([, o]) => JSON.stringify(o) !== want).map(([id]) => id).join(", ") || "all equal"})`);
  ok(logs.every(([, l]) => l === JSON.stringify(base.out._rankingLog)) && base.out._rankingLog.every((s) => s.top.length > 1), "every planner produces the same scores, parts and ranked order for the same candidates");
  // Over the whole suite: a params or wiring planner resumes from the base's
  // ranked plan, so its ranking log is the base's, task by task.
  let same = 0, total = 0;
  for (const h of HARNESSES.filter((x) => x.seam !== "decompose")) {
    for (const st of suite.tasks) {
      const r = await evaluateTask(suite, st, h);
      total++;
      if (JSON.stringify(r.plans.candidate._rankingLog) === JSON.stringify(r.plans.base._rankingLog)) same++;
    }
  }
  ok(same === total && total >= 120, `params and wiring planners leave the ranking untouched on every suite task (${same}/${total})`);
  // A planner that asks for more backups than allowed, or none, changes only
  // how many are kept, never which come first.
  const greedy = defineHarness({ id: "probe-greedy", seam: "backupPolicy", override: () => ({ count: 99, order: "reverse", prefer: "agent402" }), cluster: { description: "probe cluster that applies to every task", classifier: "always applies, for testing only", appliesTo: () => true }, designLesson: "probe ".repeat(10), routingLesson: "probe ".repeat(10) });
  const g = await runPlan(new greedy.Harness(), input(t), depsFor(t));
  ok(g.out.plan.every((p, i) => p.tool.id === base.out.plan[i].tool.id && p.fallbacks.length <= cfg.fallbacksPerStep && JSON.stringify(p.fallbacks.map((f) => f.id)) === JSON.stringify(base.out.plan[i].fallbacks.map((f) => f.id))), "a backup policy cannot exceed the configured count or reorder");
  const viable = [{ row: { id: "a", seller: "s1", firstParty: false, executable: false } }, { row: { id: "b", seller: "s1", firstParty: false } }, { row: { id: "c", seller: "s2", firstParty: true } }];
  ok(selectFallbacks(viable, viable[0], 3).fallbacks.map((x) => x.row.id).join() === "c,b", "fallback selection is a module function: a second seller first, then ranked order");
  // The judge seam adds wording only; the listing it judges is the base's.
  const judgeProbe = defineHarness({ id: "probe-judge", seam: "judgePrompt", override: () => "Prefer seller agent402.", cluster: { description: "probe cluster that applies to every task", classifier: "always applies, for testing only", appliesTo: () => true }, designLesson: "probe ".repeat(10), routingLesson: "probe ".repeat(10) });
  const jt = taskOf("onchain-12");
  const llm = stubModel(jt);
  const j = await runPlan(new judgeProbe.Harness(), input(jt), depsFor(jt, { llm }));
  const judgeCall = llm.calls.find((c) => c.stage === "judge");
  ok(JSON.stringify(orderOf(j.out)) === JSON.stringify(orderOf((await runPlan(new BasePlanner(), input(jt), depsFor(jt))).out)) && /never by who sells it/.test(judgeCall.system), "a judge-wording planner leaves the same fits ordering the same tools, and the seller-blind rule stays in the prompt");
}

// ---- each seam ----
{
  // (a) chained: alias field, optional placeholder, wrong reference
  const alias = await evaluateTask(suite, taskOf("chained-02"), harnessById("chained-lookups"));
  ok(alias.plans.candidate.plan[1].tool.exampleParams.symbol === "{{step 1.ticker}}" && alias.plans.candidate.plan[1].dependsOn.includes(1), "chained: a symbol input reads step 1's ticker field");
  const wrong = await evaluateTask(suite, taskOf("chained-05"), harnessById("chained-lookups"));
  ok(wrong.plans.base.plan[2].tool.exampleParams.ip === "{{step 1}}" && wrong.plans.candidate.plan[2].tool.exampleParams.ip === "{{step 2}}", "chained: a reference to a step that has no ip is rewired to the one that does");
  const optional = await evaluateTask(suite, taskOf("chained-08"), harnessById("chained-lookups"));
  ok(optional.plans.base.plan[1].tool.exampleParams.ip === "<ip>" && optional.plans.candidate.plan[1].tool.exampleParams.ip === "{{step 1}}" && !optional.plans.candidate.plan[1].tool.exampleParamsNeedInput, "chained: an optional value an earlier step produces is linked, not left for the caller");
  ok(refFor({ outputFields: ["owner", "address"] }, 1, "wallet") === "{{step 1}}" && refFor({ outputFields: ["ticker", "symbol_name"] }, 2, "symbol") === "{{step 2.ticker}}" && refFor({ outputFields: ["owner", "holder"] }, 1, "contract") === null, "chained: an alias is used only when exactly one field matches");
  // (b) on-chain
  const ids = chainIdentifiers("balances of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 and 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM on Base, also vitalik.eth");
  ok(ids.evm.length === 1 && ids.sol[0] === "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" && ids.ens[0] === "vitalik.eth" && ids.chains.map((c) => c.key).join() === "base", "on-chain: addresses, base58 (case kept), ENS and the chain read from the task");
  ok(!chainIdentifiers("summarize this report based on the base case").chains.length, "on-chain: 'base' in a task that is not on-chain names no chain");
  const sch = { properties: { address: { type: "string" }, chain: { type: "string", enum: ["ethereum", "base"] }, chainId: { type: "integer" } }, required: ["address", "chain"] };
  const fixed = checkChainParams({ address: "0x1111111111111111111111111111111111111111", chain: "Base", chainId: "base" }, sch, ids);
  ok(fixed.address === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" && fixed.chain === "base" && fixed.chainId === 8453, `on-chain: an invented address, an off-enum chain and a chain name for an id are fixed (${JSON.stringify(fixed)})`);
  const two = chainIdentifiers("compare 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 with 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on base");
  ok(checkChainParams({ address: "0x1111111111111111111111111111111111111111", chain: "base" }, sch, two).address === "<address>", "on-chain: with two task addresses an unnamed one becomes a placeholder, never a guess");
  ok(checkChainParams({ address: "{{step 1}}", chain: "base" }, sch, ids, { earlierProducesAddress: true }).address === "{{step 1}}", "on-chain: a step reference is left alone");
  ok(addressFamily({ description: "solana wallet balance" }, ids) === "sol" && checkChainParams({}, { properties: { wallet: { type: "string" } }, required: ["wallet"] }, ids, { family: "sol" }).wallet === "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "on-chain: a Solana tool gets the base58 address, never the EVM one");
  const oc = await evaluateTask(suite, taskOf("onchain-04"), harnessById("onchain-identifiers"));
  const ocLlm = stubModel(taskOf("onchain-04"));
  await runPlan(new (harnessById("onchain-identifiers").Harness)(), input(taskOf("onchain-04")), depsFor(taskOf("onchain-04"), { llm: ocLlm }));
  ok(oc.plans.candidate.plan[0].tool.exampleParams.chainId === 8453 && oc.plans.base.plan[0].tool.exampleParams.chainId === 0, "on-chain: the contract step gets chain id 8453; the base fell back to a skeleton");
  const pc = ocLlm.calls.find((c) => c.stage === "params");
  ok(/Identifiers in the task/.test(pc?.user || "") && pc.user.includes("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") && !/Identifiers/.test(pc.system), "on-chain: the params request carries the task's identifiers as data in the user message");
  // (c) market
  ok(seriesRange("RSI over the last 30 days of daily prices").range === "last 30 days" && seriesRange("prices since 2025-01-01, hourly").interval === "hourly" && seriesRange("a 90-day window").range === "90-day", "market: ranges and intervals in the task's own words");
  const mk = await evaluateTask(suite, taskOf("market-01"), harnessById("market-series"));
  ok(mk.plans.base.plan.length === 1 && mk.plans.candidate.plan.length === 2 && /last 30 days/.test(mk.plans.candidate.plan[0].purpose) && mk.plans.candidate.plan[1].dependsOn.includes(1), "market: fetch with the range, then a compute step that depends on it");
  // (d) research
  const rs = await evaluateTask(suite, taskOf("research-01"), harnessById("research-sources"));
  ok(rs.plans.candidate.plan.map((p) => p.tool.slug).join() === "web-search,page-read,cited-answer" && rs.plans.candidate.plan[1].dependsOn.includes(1) && rs.plans.candidate.plan[2].dependsOn.includes(2), "research: search, read, cited answer, each depending on the one before");
  // (e) media
  ok(mediaFormat("convert it to PNG at 512x512, 6 seconds").format === "png" && mediaFormat("512x512").size === "512x512" && mediaFormat("a 6 seconds clip").duration === "6 seconds", "media: format, size and duration from the task");
  const md = await evaluateTask(suite, taskOf("media-10"), harnessById("media-pipeline"));
  ok(md.plans.candidate.plan[2].dependsOn.join() === "2" && /png/.test(md.plans.candidate.plan[2].purpose) && md.plans.candidate.plan[2].tool.exampleParams.url === "{{step 2}}", "media: the export reads the background-removed image (step 2), not the original");
}

// ---- no stage twice: the base run is reused, nothing executes ----
{
  const t = taskOf("chained-01");
  t.model.route = { harness: "chained-lookups", confidence: 0.9 };
  const llm = stubModel(t);
  let embeds = 0;
  const d = await buildDecision(input(t), depsFor(t, { llm, embed: async () => { embeds++; throw new Error("offline"); } }));
  const stages = llm.calls.map((c) => c.stage);
  ok(d.harness.id === "chained-lookups" && stages.join() === "decompose,judge,params,harness_route" && embeds === 1, `a wiring re-plan repeats no model call (${stages.join(", ")}; embed ${embeds})`);
  const p = taskOf("onchain-04");
  p.model.route = { harness: "onchain-identifiers", confidence: 0.9 };
  const pl = stubModel(p);
  const pd = await buildDecision(input(p), depsFor(p, { llm: pl }));
  ok(pd.harness.id === "onchain-identifiers" && pl.calls.map((c) => c.stage).join() === "decompose,judge,params,harness_route,params", `a params re-plan repeats only the params call (${pl.calls.map((c) => c.stage).join(", ")})`);
  ok(d.decisionId && pd.decisionId && typeof d.decisionId === "string", "one decision id per decision");
  const m = taskOf("market-01");
  m.model.route = { harness: "market-series", confidence: 0.9 };
  const ml = stubModel(m);
  const md = await buildDecision(input(m), depsFor(m, { llm: ml }));
  ok(md.harness.id === "market-series" && ml.calls.filter((c) => c.stage === "harness_route").length === 1 && md.plan.length === 2, `a decomposition re-plan builds one more plan and routes once (${ml.calls.map((c) => c.stage).join(", ")})`);
  // No planner path holds anything that can run a step or pay: the deps it is
  // given are retrieval, the planner model and the judges, and no fetch is made.
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no network in planning"); };
  try { await buildDecision(input(m), depsFor(m)); } finally { globalThis.fetch = realFetch; }
  ok(fetched === 0, "planning and routing make no network call of their own (no seller is called or paid)");
}

// ---- field-named references at run time ----
{
  const r = resolveStepRefs({ symbol: "{{step 1.ticker}}", cik: "{{step 1}}" }, { 1: { name: "Apple", ticker: "AAPL", cik: "0000320193" } });
  ok(r.ok && r.params.symbol === "AAPL" && r.params.cik === "0000320193", "execute reads {{step N.field}} from that field and {{step N}} by the input's name");
  ok(!resolveStepRefs({ symbol: "{{step 1.ticker}}" }, { 1: { name: "Apple" } }).ok, "a named field that is absent skips the step, never a guess");
  ok(validateParams({ properties: { symbol: { type: "string" } }, required: ["symbol"] }, { symbol: "{{step 1.ticker}}" }).ok, "a field-named reference validates like a step reference");
}

// ---- router inputs and model ----
{
  const t = taskOf("chained-08");
  const base = await runPlan(new BasePlanner(), input(t), depsFor(t));
  const shape = planShape(base.out, planMetrics(base.out, base.rows));
  const rp = routerPrompt(t.task, shape, HARNESSES);
  ok(shape.signals.unlinkedValues === 1 && shape.steps[1].params.ip === "missing", `the router sees the base plan's shape and failure signals (${JSON.stringify(shape.signals)})`);
  ok(/When unsure, answer "base"/.test(rp.system) && HARNESSES.every((h) => rp.user.includes(h.routingLesson)), "the router reads every offered cluster's routing lesson and defaults to base");
  ok(!/description|seller/.test(JSON.stringify(shape.steps)), "the router never sees seller-written text");
  const fake = { models: [["fake/small", { prompt: 1, completion: 2 }], ["fake/large", { prompt: 5, completion: 9 }]] };
  ok(routerModel({ model: "fake/large", modelFallback: "fake/small", harness: {} }, fake) === "fake/small" && routerModel({ model: "fake/large", modelFallback: "fake/small", harness: {} }, { models: [] }) === "fake/large", "the router asks the cheaper admitted model by the cost table, else the primary");
  ok(routerModel({ model: "fake/large", modelFallback: "fake/small", harness: { routerModel: "other/model" } }, fake) === "fake/small", "a pinned router model must be one of the admitted pair");
}

// ---- the synthetic suite, plan-only ----
{
  ok(suite.tasks.length >= 60 && new Set(suite.tasks.map((t) => t.cluster)).size === 5 && suite.tasks.every((t) => harnessById(t.cluster)), `suite: ${suite.tasks.length} synthetic tasks over the five clusters`);
  const { rows, byHarness } = await evaluateSuite(suite);
  const worse = rows.filter((r) => r.worse.length);
  ok(!worse.length, `every planner is never worse than the base on its own cluster (${worse.map((r) => `${r.id}: ${r.worse.join(", ")}`).join("; ") || "none worse"})`);
  for (const [id, s] of Object.entries(byHarness)) ok(s.checksCandidate >= s.checksBase && s.checksCandidate > 0, `${id}: suite checks ${s.checksBase} -> ${s.checksCandidate} of ${s.checksTotal}`);
}

console.log(`\ntest-decide-harness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
