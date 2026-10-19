// Decide execute runs a plan in dependency order: steps whose dependsOn are
// all finished run at once (up to execute.maxParallelSteps), a dependent
// waits, a failed step skips only the steps that need its output, and every
// step draws on one run budget that a step reserves before it starts.
// Offline: a ledger file, stub catalog handlers held open by gates, a stub
// external router.
//
//   node scripts/test-decide-execute-parallel.js

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecideLedger } from "../src/decide/ledger.js";
import { makeExecuteHandler, planSchedule, makeSpendPool, maxParallelSteps } from "../src/tools/decide-kit.js";
import { abortInFlightComposites, __resetDrainForTest } from "../src/drain-abort.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const clock = 1_800_000_000_000;
const now = () => clock;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settleSoon = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

const tool = (id, over = {}) => ({ id, slug: id, name: id, seller: "agent402", firstParty: true, endpoint: `https://agent402.tools/api/${id}`, method: "POST", priceUsd: 0.01, inputSchema: { type: "object", properties: { q: { type: "string" } } }, exampleParams: { q: id }, ...over });
const ext = (id, seller, over = {}) => tool(id, { firstParty: false, seller, endpoint: `https://${seller}/x`, priceUsd: 0.01, ...over });

// A gate: a handler waits on it, so the test decides when each step finishes.
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }

// A catalog whose handlers record start/finish order and how many run at once.
function harness() {
  const log = [];
  const gates = {};
  let inFlight = 0, peak = 0;
  const behave = {};
  const def = (slug) => ({ slug, route: `POST /api/${slug}`, price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => {
    inFlight++; peak = Math.max(peak, inFlight);
    log.push(`start ${slug}`);
    try {
      if (gates[slug]) await gates[slug].p;
      if (behave[slug] === "fail") throw Object.assign(new Error(`${slug} broke`), { statusCode: 502 });
      if (behave[slug] === "hang") await new Promise(() => {});
      return { q: `${slug}:${p.q}`, value: `${slug}:${p.q}` };
    } finally { inFlight--; log.push(`end ${slug}`); }
  } });
  const routerLog = [];
  let routerInFlight = 0, routerPeak = 0;
  const routerGates = {};
  const catalog = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((s) => [s, def(s)]));
  catalog.rx = { slug: "route-execute-pro", route: "POST /api/route/execute-pro", handler: async (input) => {
    routerInFlight++; routerPeak = Math.max(routerPeak, routerInFlight);
    routerLog.push(`start ${input.target}`);
    try {
      if (routerGates[input.target]) await routerGates[input.target].p;
      return { result: { from: input.target }, receipt: { underlyingPriceUsd: 0.009 } };
    } finally { routerInFlight--; routerLog.push(`end ${input.target}`); }
  } };
  return { catalog, log, gates, behave, routerLog, routerGates, peak: () => peak, routerPeak: () => routerPeak };
}

let seq = 0;
function setup(plan, { ledgerWrap = (l) => l, runStopSignal, runBudgetMs = () => null } = {}) {
  const ledger = openDecideLedger(join(mkdtempSync(join(tmpdir(), "decide-par-")), "l.db"));
  const id = `dp${++seq}`;
  ledger.saveDecision({ decisionId: id, depth: "plan", priceUsd: 0.02, payer: "0xp", plan: plan.map((p) => ({ purpose: `step ${p.step}`, fallbacks: [], ...p })), costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled(id);
  const h = harness();
  const exec = makeExecuteHandler({ ledger: ledgerWrap(ledger), getCatalog: () => h.catalog, now, runBudgetMs, spendingWalletStatus: async () => ({ status: "ok" }), ...(runStopSignal ? { runStopSignal } : {}) });
  const run = (body = {}) => exec({ decisionId: id, maxBudgetUsd: 0.05, ...body }, { headers: {}, ip: `192.0.2.${seq % 250}`, __meteredQuoteUsd: body.maxBudgetUsd ?? 0.05 });
  return { ledger, h, run };
}

// ---- the schedule read from a plan ----
{
  const lin = planSchedule([{ step: 1, dependsOn: [] }, { step: 2, dependsOn: [1] }, { step: 3, dependsOn: [2] }]);
  ok(lin.parallel && JSON.stringify(lin.deps) === "[[],[0],[1]]", `a linear plan is a chain (${JSON.stringify(lin.deps)})`);
  const fan = planSchedule([{ step: 1, dependsOn: [] }, { step: 2, dependsOn: [] }, { step: 3, dependsOn: ["1", 2] }]);
  ok(fan.parallel && JSON.stringify(fan.deps) === "[[],[],[0,1]]", "independent steps share no edge; a step waits for every step it lists");
  const ref = planSchedule([{ step: 1, dependsOn: [] }, { step: 2, dependsOn: [], tool: { exampleParams: { q: "{{step 1}}" } } }]);
  ok(JSON.stringify(ref.deps) === "[[],[0]]", "a {{step N}} in a step's params makes it wait for step N even when dependsOn leaves it out");
  const callerRef = planSchedule([{ step: 1, dependsOn: [] }, { step: 2, dependsOn: [], tool: { exampleParams: { q: "x" } } }], { 2: { q: "{{step 1}}" } });
  ok(JSON.stringify(callerRef.deps) === "[[],[0]]", "...and so does one in the caller's params for the step");
  const fwdRef = planSchedule([{ step: 1, dependsOn: [], tool: { exampleParams: { q: "{{step 2}}" } } }, { step: 2, dependsOn: [] }]);
  ok(fwdRef.parallel && JSON.stringify(fwdRef.deps) === "[[],[]]", "a reference to a later step adds no edge (it never resolves, as before)");
  const cycle = planSchedule([{ step: 1, dependsOn: [2] }, { step: 2, dependsOn: [1] }]);
  ok(!cycle.parallel && /not an earlier step/.test(cycle.why) && JSON.stringify(cycle.deps) === "[[],[0]]", `a cycle falls back to plan order (${cycle.why})`);
  const unknown = planSchedule([{ step: 1, dependsOn: [] }, { step: 2, dependsOn: [9] }]);
  ok(!unknown.parallel, "an unknown step id falls back to plan order");
  ok(!planSchedule([{ step: 1, dependsOn: [1] }]).parallel, "a step that depends on itself falls back to plan order");
  ok(!planSchedule([{ step: 1, dependsOn: [] }, { step: 1, dependsOn: [] }]).parallel, "repeated step numbers fall back to plan order");
  ok(!planSchedule([{ step: 1 }, { step: 2, dependsOn: [] }]).parallel, "a step with no dependsOn list falls back to plan order");
  const W = (slug, extra = {}) => ({ dependsOn: [], tool: { slug, exampleParams: {} }, ...extra });
  const wr = planSchedule([{ step: 1, ...W("memory-write") }, { step: 2, ...W("memory-read") }, { step: 3, ...W("dns-lookup") }]);
  ok(wr.parallel && JSON.stringify(wr.deps) === "[[],[0],[0]]", `a step that leaves state behind runs before every later step (${JSON.stringify(wr.deps)})`);
  const rw = planSchedule([{ step: 1, ...W("memory-read") }, { step: 2, ...W("dns-lookup") }, { step: 3, ...W("memory-write") }, { step: 4, ...W("memory-read") }]);
  ok(JSON.stringify(rw.deps) === "[[],[],[0,1],[2]]", `...and after every earlier step (${JSON.stringify(rw.deps)})`);
  const fb = planSchedule([{ step: 1, ...W("dns-lookup", { fallbacks: [{ slug: "memory-incr" }] }) }, { step: 2, ...W("memory-read") }]);
  ok(JSON.stringify(fb.deps) === "[[],[0]]", "a fallback that leaves state behind makes its step a barrier too");
  const reads = planSchedule([{ step: 1, ...W("memory-read") }, { step: 2, ...W("memory-read") }]);
  ok(JSON.stringify(reads.deps) === "[[],[]]", "two steps that only read still run at once");
  ok(maxParallelSteps({ execute: { maxParallelSteps: 3 } }) === 3 && maxParallelSteps({ execute: {} }) === 3 && maxParallelSteps({ execute: { maxParallelSteps: 0 } }) === 3 && maxParallelSteps({ execute: { maxParallelSteps: 99 } }) === 8, "the cap defaults to 3 and is clamped to 1..8");
}

// ---- the pool: check and reserve in one step ----
{
  const pool = makeSpendPool(0.015);
  const a = pool.tryReserve(0.01), b = pool.tryReserve(0.01);
  ok(a && a.amount === 0.01 && b === "wait", "a second step that fits only once the first gives back waits, it does not pass too");
  pool.commit(a, 0.01);
  ok(pool.tryReserve(0.01) === null && pool.spent === 0.01, "once the first spent, the second can never fit and is refused");
  const p2 = makeSpendPool(0.02);
  const x = p2.tryReserve(0.01);
  let got = null;
  const waiting = p2.reserve(0.015, undefined, () => null).then((r) => { got = r; });
  await settleSoon();
  ok(got === null, "a waiter waits while the sibling's reservation is open");
  p2.release(x);
  await waiting;
  ok(got && got.amount === 0.015 && p2.reserved === 0.015, "...and takes the headroom the sibling gave back");
}

// ---- independent steps overlap; results stay in plan order ----
{
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }, { step: 3, tool: tool("c"), dependsOn: [] }]);
  for (const s of ["a", "b", "c"]) h.gates[s] = gate();
  const p = run();
  await settleSoon();
  ok(h.peak() === 3 && h.log.join() === "start a,start b,start c", `three independent steps are in flight together (${h.log.join()})`);
  h.gates.c.open(); await settleSoon(); h.gates.a.open(); await settleSoon(); h.gates.b.open();
  const out = await p;
  ok(out.status === "complete" && out.steps.map((s) => s.step).join() === "1,2,3" && out.steps.every((s) => s.status === "ok"), "results come back in plan order whatever order steps finished in");
  ok(out.spentUsd === 0.03, `the run spent each step once (${out.spentUsd})`);
}

// ---- an internal error in one step closes the run with what siblings spent ----
{
  const finishes = [];
  const wrap = (l) => { const f = l.finishRun.bind(l); l.finishRun = (a) => { finishes.push(a); return f(a); }; return l; };
  const { h, run } = setup([{ step: 1, tool: tool("a"), fallbacks: [null], dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }], { ledgerWrap: wrap });
  h.behave.a = "fail";
  let err = null;
  try { await run(); } catch (e) { err = e; }
  ok(err && !err.statusCode, `the internal error reaches the caller as itself (${err?.message})`);
  const f = finishes.at(-1);
  ok(f && f.status === "failed" && f.spentUsd === 0.01 && f.steps.some((s) => s.step === 2 && s.status === "ok"), `the run is closed as failed with the sibling's spend (${JSON.stringify(f && { status: f.status, spentUsd: f.spentUsd })})`);
}

// ---- the cap bounds a run's fan-out ----
{
  const { h, run } = setup(["a", "b", "c", "d", "e"].map((s, i) => ({ step: i + 1, tool: tool(s), dependsOn: [] })));
  for (const s of ["a", "b", "c", "d", "e"]) h.gates[s] = gate();
  const p = run({ maxBudgetUsd: 0.05 });
  await settleSoon();
  ok(h.peak() === 3 && h.log.join() === "start a,start b,start c", `no more than three steps of one run in flight (${h.log.join()})`);
  h.gates.b.open(); await settleSoon();
  ok(h.log.includes("start d") && !h.log.includes("start e"), "a finished step frees its place for the next ready one, in plan order");
  for (const s of ["a", "c", "d", "e"]) h.gates[s].open();
  const out = await p;
  ok(out.status === "complete" && h.peak() === 3, "all five ran, never more than three at once");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { maxParallelSteps: 1 } });
  const two = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }]);
  await two.run();
  delete process.env.DECIDE_CONFIG;
  ok(two.h.peak() === 1 && two.h.log.join() === "start a,end a,start b,end b", "execute.maxParallelSteps 1 runs one step at a time");
}

// ---- a dependent waits for what it depends on, and only for that ----
{
  const { h, run } = setup([
    { step: 1, tool: tool("a"), dependsOn: [] },
    { step: 2, tool: tool("b"), dependsOn: [] },
    { step: 3, tool: tool("c", { exampleParams: { q: "{{step 1}}" } }), dependsOn: [1] },
  ]);
  h.gates.a = gate(); h.gates.b = gate();
  const p = run();
  await settleSoon();
  ok(h.log.join() === "start a,start b", "the dependent has not started while its dependency runs");
  h.gates.a.open(); await settleSoon();
  ok(h.log.indexOf("start c") > h.log.indexOf("end a") && !h.log.includes("end b"), "it starts once its dependency is done, while an unrelated step still runs");
  h.gates.b.open();
  const out = await p;
  ok(out.steps[2].status === "ok" && out.steps[2].result.value === "c:a:a", `it gets its dependency's output (${JSON.stringify(out.steps[2].result)})`);
}

// ---- a reference to a later step never resolves, even when that step finished first ----
{
  const { h, run } = setup([
    { step: 1, tool: tool("a"), dependsOn: [] },
    { step: 2, tool: tool("c", { exampleParams: { q: "{{step 3}}" } }), dependsOn: [1] },
    { step: 3, tool: tool("b"), dependsOn: [] },
  ]);
  h.gates.a = gate();
  const p = run();
  await settleSoon();
  ok(h.log.includes("end b"), "the later step finished while step 1 still ran");
  h.gates.a.open();
  const out = await p;
  ok(out.steps[1].status === "skipped" && out.steps[1].reason === "needs the output of step 3, which did not run: pass params for this step" && !h.log.includes("start c"), `it reads as it did in plan order: step 3 had not run (${out.steps[1].reason})`);
}

// ---- a failed step skips only its descendants ----
{
  const { h, run } = setup([
    { step: 1, tool: tool("a"), dependsOn: [] },
    { step: 2, tool: tool("b", { exampleParams: { q: "{{step 1}}" } }), dependsOn: [1] },
    { step: 3, tool: tool("c", { exampleParams: { q: "{{step 2}}" } }), dependsOn: [2] },
    { step: 4, tool: tool("d"), dependsOn: [] },
  ]);
  h.behave.a = "fail";
  const out = await run();
  ok(out.status === "partial" && out.steps.map((s) => s.status).join() === "failed,skipped,skipped,ok", `failed, its two descendants skipped, the independent branch ran (${out.steps.map((s) => s.status).join()})`);
  ok(out.steps[1].reason === "needs the output of step 1, which did not run: pass params for this step" && out.steps[2].reason === "needs the output of step 2, which did not run: pass params for this step", "each skip names the step whose output is missing, in the same words as before");
  ok(!h.log.includes("start b") && !h.log.includes("start c"), "no descendant was called");
}

// ---- budget: two steps in flight cannot both pass on headroom for one ----
{
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }]);
  h.gates.a = gate(); h.gates.b = gate();
  const p = run({ maxBudgetUsd: 0.015 });
  await settleSoon();
  ok(h.log.join() === "start a", `with room for one, the second step does not start while the first holds the budget (${h.log.join()})`);
  h.gates.a.open(); h.gates.b.open();
  const out = await p;
  ok(out.spentUsd <= 0.015 && out.steps[0].status === "ok" && out.steps[1].status === "failed" && out.steps[1].attempts[0].skipped === "over the remaining budget", `the step that would pass the budget is refused (${out.spentUsd}, ${JSON.stringify(out.steps[1].attempts)})`);
  ok(!h.log.includes("start b"), "...and never called");
}
{
  // The holder fails and gives its reservation back: the waiter then runs.
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }]);
  h.gates.a = gate(); h.behave.a = "fail";
  const p = run({ maxBudgetUsd: 0.015 });
  await settleSoon();
  ok(!h.log.includes("start b"), "the waiter waits on the first step's reservation");
  h.gates.a.open();
  const out = await p;
  ok(out.steps[0].status === "failed" && out.steps[1].status === "ok" && out.spentUsd === 0.01, "a reservation given back lets the waiting step run");
}
{
  // Outside legs reserve their worst case (fee included): two whose worst
  // cases do not both fit never pay at once, and the spend stays in budget.
  const { h, run } = setup([{ step: 1, tool: ext("e1", "s1.example"), dependsOn: [] }, { step: 2, tool: ext("e2", "s2.example"), dependsOn: [] }]);
  h.routerGates["https://s1.example/x"] = gate();
  const p = run({ maxBudgetUsd: 0.022 });
  await settleSoon();
  ok(h.routerLog.join() === "start https://s1.example/x", `the second leg waits while the first holds its worst case (${h.routerLog.join()})`);
  h.routerGates["https://s1.example/x"].open();
  const out = await p;
  ok(h.routerPeak() === 1 && out.steps.every((s) => s.status === "ok") && out.spentUsd <= 0.022, `both paid one after the other, spend inside the budget (${out.spentUsd})`);
}
{
  // Two legs to one seller in one run go one at a time even with room for both.
  const { h, run } = setup([{ step: 1, tool: ext("e1", "same.example"), dependsOn: [] }, { step: 2, tool: ext("e2", "same.example", { endpoint: "https://same.example/y" }), dependsOn: [] }, { step: 3, tool: ext("e3", "other.example"), dependsOn: [] }]);
  h.routerGates["https://same.example/x"] = gate();
  const p = run({ maxBudgetUsd: 0.2 });
  await settleSoon();
  ok(h.routerLog.slice(0, 2).join() === "start https://same.example/x,start https://other.example/x" && !h.routerLog.includes("start https://same.example/y"), `one leg per seller in flight; another seller's leg runs alongside (${h.routerLog.join()})`);
  h.routerGates["https://same.example/x"].open();
  const out = await p;
  ok(out.status === "complete" && h.routerLog.indexOf("start https://same.example/y") > h.routerLog.indexOf("end https://same.example/x"), "all three paid; the seller's second leg started after its first ended");
}

// ---- the spend ledger failing while a sibling is in flight skips the leg, it does not refuse the run ----
{
  const flaky = (l) => new Proxy(l, { get(t, k) { const v = t[k]; if (k === "holdSellerSpend") return async () => { throw new Error("ledger down"); }; return typeof v === "function" ? v.bind(t) : v; } });
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: ext("e2", "s2.example"), dependsOn: [] }, { step: 3, tool: tool("b"), dependsOn: [1] }], { ledgerWrap: flaky });
  h.gates.a = gate();
  const p = run();
  await settleSoon();
  h.gates.a.open();
  const out = await p;
  ok(out.status === "partial" && out.steps[0].status === "ok" && out.steps[1].attempts[0].skipped === "the spend ledger is unavailable; this leg was not paid", "with a step of ours in flight the leg is skipped and the run answers");
  ok(out.steps[2].status === "ok" && h.log.includes("start b"), `...and the rest of the plan still runs (${out.steps[2].status} ${out.steps[2].reason || ""})`);
  const solo = setup([{ step: 1, tool: ext("e1", "s1.example"), dependsOn: [] }, { step: 2, tool: tool("a"), dependsOn: [1] }], { ledgerWrap: flaky });
  const e = await solo.run().catch((x) => x);
  ok(e?.statusCode === 503 && !solo.h.log.includes("start a"), `with nothing spent or in flight the run is refused 503 and no other step starts (${e?.statusCode})`);
}

// ---- deadline: every step in flight is cut off at the run's deadline ----
{
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }, { step: 3, tool: tool("c"), dependsOn: [1] }], { runBudgetMs: () => 5400 });
  h.behave.a = "hang"; h.behave.b = "hang";
  const t0 = Date.now();
  const e = await run().catch((x) => x);
  const took = Date.now() - t0;
  ok(h.peak() === 2 && took < 8000, `both hanging steps ran at once and the run ended at its deadline (${took} ms, not twice it)`);
  const steps = e?.steps || [];
  ok(steps[0]?.attempts?.[0]?.status === 504 && steps[1]?.attempts?.[0]?.status === 504, "each in-flight step was cut off by the deadline");
  ok(steps[2]?.attempts?.[0]?.skipped === "the run's time budget is spent" && !h.log.includes("start c"), "the dependent reports the time budget, never called");
}

// ---- drain: an abort cancels the steps in flight and names the ones that never ran ----
{
  __resetDrainForTest();
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }, { step: 3, tool: tool("c"), dependsOn: [] }, { step: 4, tool: tool("d"), dependsOn: [1] }]);
  h.gates.a = gate(); h.behave.b = "hang";
  const p = run().catch((x) => x);
  await settleSoon();
  h.gates.a.open(); await settleSoon();
  // Step 1 is done; steps 2 (hung) and 3 (c, finished at once) ran; step 4 may have started.
  const before = h.log.slice();
  abortInFlightComposites("draining");
  const out = await p;
  __resetDrainForTest();
  ok(out && out.status === "partial", `the run answers with what finished (${out?.status || out?.message})`);
  const s2 = out?.steps?.[1];
  ok(s2?.status === "failed" && /the run was stopped/.test(s2.attempts[0].error) && s2.attempts[0].toolFault === false, "the hung step in flight was canceled, and not counted against its tool");
  ok(before.join().includes("start d") ? out.steps[3].status === "ok" : out.steps[3].status === "skipped", "the dependent either finished before the drain or is reported");
}
{
  __resetDrainForTest();
  const ctl = new AbortController();
  const { h, run } = setup([{ step: 1, tool: tool("a"), dependsOn: [] }, { step: 2, tool: tool("b"), dependsOn: [] }, { step: 3, tool: tool("c"), dependsOn: [1] }], { runStopSignal: () => ctl.signal });
  h.behave.a = "hang"; h.behave.b = "hang";
  const p = run().catch((x) => x);
  await settleSoon();
  ctl.abort(Object.assign(new Error("draining"), { name: "AbortError" }));
  const e = await p;
  ok(e?.statusCode === 503, `a run stopped before any step finished is a 503, never charged (${e?.statusCode})`);
  ok(e?.steps?.[2]?.status === "skipped" && /stopped .*before this step started/.test(e.steps[2].reason) && !h.log.includes("start c"), `the step that never started says so (${e?.steps?.[2]?.reason})`);
}

// ---- a linear plan runs exactly as before: one step at a time, in order ----
{
  const plan = [
    { step: 1, tool: tool("a"), dependsOn: [] },
    { step: 2, tool: tool("b", { exampleParams: { q: "{{step 1}}" } }), dependsOn: [1] },
    { step: 3, tool: ext("e3", "s3.example"), fallbacks: [tool("c")], dependsOn: [2] },
    { step: 4, tool: tool("d"), dependsOn: [3] },
  ];
  const one = setup(plan);
  const out = await one.run({ maxBudgetUsd: 0.035 });
  ok(one.h.peak() === 1 && one.h.log.join() === "start a,end a,start b,end b", `one step at a time, in plan order (${one.h.log.join()})`);
  const norm = (o) => JSON.stringify({ ...o, runId: 0, decisionId: 0, leftoverCredit: o.leftoverCredit && { ...o.leftoverCredit, token: 0, expiresAt: 0 }, steps: o.steps.map((s) => ({ ...s, latencyMs: 0 })) });
  ok(out.status === "partial" && out.spentUsd === 0.02945 && out.steps.map((s) => s.status).join() === "ok,ok,ok,failed" && out.steps[3].attempts[0].skipped === "over the remaining budget", `the same outcome as the sequential loop: the budget runs out on step 4 (${out.spentUsd})`);
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { maxParallelSteps: 1 } });
  const seqRun = setup(plan);
  const out1 = await seqRun.run({ maxBudgetUsd: 0.035 });
  delete process.env.DECIDE_CONFIG;
  ok(norm(out) === norm(out1), `the answer matches a run with one step at a time${norm(out) === norm(out1) ? "" : `\n${norm(out)}\n${norm(out1)}`}`);
}

console.log(`\ntest-decide-execute-parallel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
