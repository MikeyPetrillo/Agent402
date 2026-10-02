// Decide phase 4: the feedback loop and reliability stats. Offline.
//
//   node scripts/test-decide-feedback.js

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecideLedger, hashToken } from "../src/decide/ledger.js";
import { makeFeedbackHandler, makeExecuteHandler, sendObservations } from "../src/tools/decide-kit.js";
import { Reliability, WEIGHT } from "../services/decide/reliability.js";
import { scoreCandidates, reliabilityScore, FEEDBACK_SWING } from "../services/decide/rank.js";
import { DEFAULTS } from "../src/decide/config.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const throwsWith = (fn, status, frag, m) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && e.statusCode === status && (!frag || String(e.message).includes(frag)), `${m} (${e ? `${e.statusCode} ${String(e.message).slice(0, 80)}` : "no throw"})`); };

// ---- reliability ----
{
  const r = new Reliability();
  for (let i = 0; i < 10; i++) r.record({ toolId: "t", ok: true, latencyMs: 100 + i * 10, source: "execution", by: `p${i}` });
  const s = r.get("t");
  ok(s.successes > 9 && s.failures === 0 && s.latency_p95_ms >= 180, `execution successes count and set p95 latency (${JSON.stringify(s)})`);
  r.record({ toolId: "u", ok: false, source: "feedback" });
  ok(r.get("u").failures === 0 && r.get("u").fbFailures === 1, "a buyer report is kept apart from our own observations");
  r.record({ toolId: "u", ok: true, latencyMs: 5, source: "feedback" });
  ok(r.get("u").latency_p95_ms === null, "reported latency is not trusted as a measurement");
  ok(!r.record({ toolId: "v", ok: true, source: "rumor" }) && !r.record({ toolId: "x".repeat(65), ok: true }), "unknown sources and malformed ids are refused");
  const before = r.get("t").successes;
  r.record({ toolId: "t", ok: false, source: "execution" });
  ok(r.get("t").successes < before, "counts decay, so old history fades");
  ok(r.takeDirty().length === 2 && r.takeDirty().length === 0, "changed rows are flushed once");
  // Reliability feeds the score, neutrally.
  const row = (id, fp) => ({ id, priceUsd: 0.01, schemaQuality: 0.8, lastLiveAt: 1, health: 0.7, firstParty: fp });
  const rel = new Reliability();
  for (let i = 0; i < 20; i++) rel.record({ toolId: "good", ok: true, latencyMs: 100, source: "execution", by: `p${i}` });
  for (let i = 0; i < 20; i++) rel.record({ toolId: "bad", ok: false, source: "execution", by: `p${i}` });
  const scored = scoreCandidates([{ row: row("bad", true), fit: 0.8 }, { row: row("good", false), fit: 0.8 }], { reliability: (id) => rel.get(id), weights: DEFAULTS.weights, now: 2, halfLifeHours: 72 });
  ok(scored[0].row.id === "good", "observed reliability outranks at equal fit, whoever sells the tool");
}

// ---- a flood of bad reports cannot sink a tool ----
{
  const rel = new Reliability();
  for (let i = 0; i < 500; i++) rel.record({ toolId: "victim", ok: false, source: "feedback", by: `r${i}` });
  const flooded = reliabilityScore(rel.get("victim"), null);
  ok(flooded >= 0.7 - FEEDBACK_SWING - 1e-9, `500 failure reports move an unmeasured tool by at most ${FEEDBACK_SWING} (${flooded})`);
  for (let i = 0; i < 30; i++) rel.record({ toolId: "victim", ok: true, latencyMs: 100, source: "execution", by: `p${i}` });
  ok(reliabilityScore(rel.get("victim"), null) > 0.85, "our own observed successes outweigh the reports");
}

// ---- feedback route ----
const dir = mkdtempSync(join(tmpdir(), "decide-fb-"));
const ledger = openDecideLedger(join(dir, "l.db"));
const tok = "fb_secret-token-for-tests";
const plan = [{ step: 1, tool: { id: "p1" }, fallbacks: [{ id: "f1" }] }, { step: 2, tool: { id: "p2" }, fallbacks: [] }];
ledger.saveDecision({ decisionId: "d1", depth: "plan", priceUsd: 0.02, plan, costViaUsd: 0.01, feedbackHash: hashToken(tok) });
ok(!ledger.feedbackTokenOk("d1", tok), "feedback is refused on a decision whose payment has not settled");
ledger.markDecisionSettled("d1");
ok(ledger.feedbackTokenOk("d1", tok) && !ledger.feedbackTokenOk("d1", tok, { now: Date.now() + 8 * 86_400_000 }), "...accepted once settled, and refused once the decision is over 7 days old");
const sent = [];
process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
const send = async (path, body) => { sent.push([path, body]); return {}; };
const fb = makeFeedbackHandler({ ledger, send });
const flush = () => new Promise((r) => setTimeout(r, 10));

throwsWith(() => fb({ decisionId: "d1", feedbackToken: "wrong", step: 1, outcome: "success" }), 403, "do not match", "a wrong token is refused");
throwsWith(() => fb({ decisionId: "nope", feedbackToken: tok, step: 1, outcome: "success" }), 403, "do not match", "an unknown decision gets the SAME refusal (nothing to enumerate)");
throwsWith(() => fb({ decisionId: "d1", feedbackToken: tok, step: 9, outcome: "success" }), 400, "step", "an unknown step is refused");
throwsWith(() => fb({ decisionId: "d1", feedbackToken: tok, step: 1, outcome: "meh" }), 400, "outcome", "an unknown outcome is refused");
throwsWith(() => fb({ decisionId: "d1", feedbackToken: tok, step: 1, outcome: "success", quality: 9 }), 400, "quality", "quality is 1-5");
throwsWith(() => fb({ decisionId: "d1", feedbackToken: tok, step: 1, outcome: "success", toolId: "someone-else" }), 400, "toolId", "a tool outside the step cannot be rated through it");
ok(sent.length === 0, "no refused report reaches the service");

const r1 = fb({ decisionId: "d1", feedbackToken: tok, step: 1, outcome: "failure", quality: 2 });
await flush();
ok(r1.ok && r1.toolId === "p1" && !r1.replaced && sent.length === 1 && sent[0][1].observations[0].source === "feedback" && sent[0][1].observations[0].ok === false, "a report is stored and forwarded as a feedback observation on the step's tool");
const r2 = fb({ decisionId: "d1", feedbackToken: tok, step: 1, outcome: "success" });
await flush();
ok(r2.replaced && sent.length === 1, "a second verdict on the same step replaces the first and is not counted again");
fb({ decisionId: "d1", feedbackToken: tok, step: 1, outcome: "success", toolId: "f1" });
ok(ledger.db.prepare("SELECT tool_id FROM feedback WHERE decision_id='d1' AND step=1").get().tool_id === "f1", "a fallback the buyer used can be the rated tool");

// ---- execute sends execution observations; a 4xx is not the tool's fault ----
{
  const obs = [];
  const tool = (id) => ({ id, slug: id, name: id, seller: "agent402", firstParty: true, priceUsd: 0.01, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "x" } });
  const plan2 = [{ step: 1, purpose: "x", tool: tool("bad4"), fallbacks: [tool("bad5"), tool("good")], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d2", depth: "plan", priceUsd: 0.02, plan: plan2, costViaUsd: 0.05 });
  ledger.markDecisionSettled("d2");
  const catalog = {
    bad4: { slug: "bad4", route: "POST /api/bad4", discovery: { bodyType: "json" }, handler: async () => { throw Object.assign(new Error("bad input"), { statusCode: 400 }); } },
    bad5: { slug: "bad5", route: "POST /api/bad5", discovery: { bodyType: "json" }, handler: async () => { throw Object.assign(new Error("upstream down"), { statusCode: 502 }); } },
    good: { slug: "good", route: "POST /api/good", discovery: { bodyType: "json" }, handler: async () => ({ ok: 1 }) },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes("/internal/observations")) obs.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  const exec = makeExecuteHandler({ ledger, getCatalog: () => catalog });
  const out = await exec({ decisionId: "d2" }, { headers: {}, ip: "1.2.3.4" });
  await flush();
  globalThis.fetch = realFetch;
  const list = obs.flatMap((o) => o.observations);
  ok(out.steps[0].tool.slug === "good", "the step ran on the working fallback");
  ok(list.some((o) => o.toolId === "bad5" && o.ok === false) && !list.some((o) => o.toolId === "bad4"), "a 5xx counts against the tool; a 4xx (our request) does not");
  ok(list.some((o) => o.toolId === "good" && o.ok === true && Number.isFinite(o.latencyMs)), "a success is reported with its latency");
}

// ---- observations never touch a paid request ----
{
  let threw = false;
  try { sendObservations([{ toolId: "x", ok: true, source: "execution" }], { send: async () => { throw new Error("service down"); } }); } catch { threw = true; }
  await flush();
  ok(!threw, "a dead decide service cannot fail the request that reports to it");
}

// ---- self-purchase: one counted observation per tool, payer and day ----
{
  const r = new Reliability();
  for (let i = 0; i < 20; i++) r.record({ toolId: "mine", ok: true, source: "execution", by: "p-self", now: 1_800_000_000_000 + i });
  ok(r.get("mine").successes === 1, `20 self-bought runs from one payer in a day count once (${r.get("mine").successes})`);
  for (let i = 0; i < 5; i++) r.record({ toolId: "mine", ok: true, source: "execution", by: `p${i}`, now: 1_800_000_000_000 });
  ok(Math.round(r.get("mine").successes) === 6, "five other payers count five more");
  r.record({ toolId: "mine", ok: true, source: "execution", by: "p-self", now: 1_800_000_000_000 + 86_400_000 });
  ok(r.get("mine").successes > 5.8, "the same payer counts again the next day");
  for (let i = 0; i < 50; i++) r.record({ toolId: "rival", ok: false, source: "feedback", by: "p-attacker", now: 1_800_000_000_000 });
  ok(r.get("rival").fbFailures === 1, "fifty reports from one buyer against a rival count once");
}

// ---- the MCP path shares the HTTP limiter (feedback moves ranking) ----
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
  const wiring = server.slice(server.indexOf("decideFeedback: decideEnabled()"), server.indexOf("decideFeedback: decideEnabled()") + 400);
  ok(/decideFeedbackLimiter\.check\(ctx\.ip/.test(wiring) && /decideFeedback\(args, \{ ip \}\)/.test(mcp), "decide.feedback over MCP is checked against the same per-IP limiter as the HTTP route");
}

// ---- the ledger needs a single writer ----
{
  const { singleWriterTopology } = await import("../src/decide/ledger.js");
  ok(singleWriterTopology({}) && singleWriterTopology({ RATE_LIMIT_REPLICAS: "1" }) && !singleWriterTopology({ RATE_LIMIT_REPLICAS: "2" }), "decide stays off when more than one replica is configured");
  const { readFileSync } = await import("node:fs");
  ok(/if \(!singleWriterTopology\(\)\)/.test(readFileSync(new URL("../src/server.js", import.meta.url), "utf8")), "...and the server consults it before opening the ledger");
}

console.log(`\ntest-decide-feedback: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
