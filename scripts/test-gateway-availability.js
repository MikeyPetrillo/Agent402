#!/usr/bin/env node
// Availability failover on the LLM gateway (offline, stubbed upstream).
//
// 2026-10-06 14:00-14:11Z: both hosts of deepseek/deepseek-chat stalled. A
// buyer's tool-using agent on the metered tier got 14 "Upstream rate-limited"
// 503s and then 147 "No endpoints found that support tool use" 502s. None were
// charged, and none were served.
//
// What is pinned, on every wire (chat, Messages, Responses):
//  - when the requested model has no available host, its same-family successor
//    (AVAILABILITY_SUCCESSORS) serves, and the reply names the swap in
//    agent402_model_substituted;
//  - model_fallback:false keeps only the requested model and returns the error;
//    a non-boolean model_fallback is a 400;
//  - a rate-limited attempt is retried on the SAME model before anything else,
//    and a request that recovers on retry is not substituted;
//  - a model with no successor and no fallbacks still fails as before;
//  - the successor never goes upstream carrying the opt-out field.
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-gateway-availability");
process.env.OPENROUTER_API_KEY = "test-key";
const { LLM_GATEWAY_TOOLS, AVAILABILITY_SUCCESSORS, failoverChain, retryRateLimited } = await import("../src/tools/llm-gateway-kit.js");
const { LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
const { LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const rejects = async (fn, re, m) => { try { await fn(); ok(false, `${m} (resolved)`); } catch (e) { ok(re.test(String(e?.message)) , `${m}${re.test(String(e?.message)) ? "" : ` (got ${e?.statusCode} ${e?.message})`}`); } };

const REQ = "deepseek/deepseek-chat";
const SUCC = AVAILABILITY_SUCCESSORS[REQ];
ok(SUCC === "deepseek/deepseek-v4-flash", "deepseek-chat names its successor");

// ---- the chain itself
ok(JSON.stringify(failoverChain(REQ, "v1-chat-metered")) === JSON.stringify([REQ, SUCC]), "metered chain: requested model, then its successor");
ok(JSON.stringify(failoverChain(REQ, "v1-chat-metered", { fallback: false })) === JSON.stringify([REQ]), "model_fallback:false keeps only the requested model");
ok(failoverChain(REQ, "v1-chat-nano")[1] !== SUCC, "a tier that does not serve the successor never adds it");
ok(JSON.stringify(failoverChain("anthropic/claude-sonnet-5", "v1-chat-metered")) === JSON.stringify(["anthropic/claude-sonnet-5"]), "a model with no successor keeps its old chain");

// ---- retryRateLimited, in isolation
{
  let n = 0;
  const out = await retryRateLimited(async () => { n++; if (n < 3) throw Object.assign(new Error("Upstream rate-limited - retry shortly"), { statusCode: 503 }); return "served"; }, { sleep: async () => {} });
  ok(out === "served" && n === 3, "a rate-limited attempt is retried twice and then serves");
  n = 0;
  await rejects(() => retryRateLimited(async () => { n++; throw Object.assign(new Error("Upstream error: boom"), { statusCode: 502 }); }, { sleep: async () => {} }), /boom/, "a non-rate-limit error is not retried");
  ok(n === 1, "...exactly one attempt");
  n = 0;
  await rejects(() => retryRateLimited(async () => { n++; throw Object.assign(new Error("Upstream rate-limited - retry shortly"), { statusCode: 503 }); }, { sleep: async () => {}, canRetry: () => false }), /rate-limited/, "canRetry:false (stream bytes sent) stops the retry");
  ok(n === 1, "...exactly one attempt");
}

// ---- stub upstream: per-model behaviour, every request recorded
const fakeReq = { header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000009" } } })).toString("base64") : undefined) };
let behaviour = {}; // model -> array of "noendpoints" | "429" | "ok", consumed in order, last repeats
let seen = [];
const chatReply = (model) => ({ id: "gen-a", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00001 } });
const msgReply = (model) => ({ id: "gen-m", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 } });
const respReply = (model) => ({ id: "resp_a", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cost: 0.00001 } });
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  seen.push({ url: String(url), model: b.model, body: b });
  const queue = behaviour[b.model] || ["ok"];
  const step = queue.length > 1 ? queue.shift() : queue[0];
  if (step === "noendpoints") return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'No endpoints found that support tool use. Try disabling "exec".', code: 404 } }) };
  if (step === "429") return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "rate limited", code: 429 } }) };
  const u = String(url);
  const reply = u.includes("/messages") ? msgReply(b.model) : u.includes("/responses") ? respReply(b.model) : chatReply(b.model);
  return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
};

const tools = [{ type: "function", function: { name: "exec", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }];
const chat = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered");
const messages = LLM_MESSAGES_TOOLS.find((t) => t.slug === "v1-chat-metered-messages");
const responses = LLM_RESPONSES_TOOLS.find((t) => t.slug === "v1-chat-metered-responses");
const wires = [
  ["chat", (extra) => chat.handler({ model: REQ, max_tokens: 32, messages: [{ role: "user", content: "hi" }], tools, ...extra }, fakeReq)],
  ["messages", (extra) => messages.handler({ model: REQ, max_tokens: 32, messages: [{ role: "user", content: "hi" }], ...extra }, fakeReq)],
  ["responses", (extra) => responses.handler({ model: REQ, max_output_tokens: 32, input: "hi", ...extra }, fakeReq)],
];

for (const [wire, call] of wires) {
  // 1. the outage: every attempt at the requested model finds no endpoint
  behaviour = { [REQ]: ["noendpoints"] }; seen = [];
  const out = await call({});
  const sub = out?.agent402_model_substituted;
  ok(out?.model === SUCC, `${wire}: the outage is served by ${SUCC}`);
  ok(sub && sub.requested === REQ && sub.served === SUCC && /no available upstream host/.test(sub.reason), `${wire}: the reply names the swap and why`);
  ok(seen[0]?.model === REQ && seen.at(-1)?.model === SUCC, `${wire}: the requested model was tried first`);
  ok(seen.every((s) => !("model_fallback" in s.body)), `${wire}: model_fallback never goes upstream`);

  // 2. opted out: the error, no substitute
  behaviour = { [REQ]: ["noendpoints"] }; seen = [];
  await rejects(() => call({ model_fallback: false }), /No endpoints found/, `${wire}: model_fallback:false returns the upstream error`);
  ok(seen.every((s) => s.model === REQ), `${wire}: ...and never calls the successor`);

  // 3. a rate limit that clears on retry: the requested model serves, no swap
  behaviour = { [REQ]: ["429", "ok"] }; seen = [];
  const rl = await call({});
  ok(rl?.model === REQ && !rl?.agent402_model_substituted, `${wire}: a rate limit that clears on retry is served by the requested model`);
  ok(seen.length === 2 && seen.every((s) => s.model === REQ), `${wire}: ...after exactly one retry on the same model`);

  // 4. a bad opt-out value is refused before any upstream call
  seen = [];
  await rejects(() => call({ model_fallback: "no" }), /model_fallback/, `${wire}: a non-boolean model_fallback is a 400`);
  ok(seen.length === 0, `${wire}: ...with no upstream call`);
}

// ---- a model with no successor still fails as before
behaviour = { "anthropic/claude-sonnet-5": ["noendpoints"] }; seen = [];
await rejects(() => chat.handler({ model: "anthropic/claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }, fakeReq), /No endpoints found/, "a model with no successor returns the upstream error");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
