// Direct inference upstream (src/gateway-direct-upstream.js) on the chat wire
// (src/tools/llm-gateway-kit.js). Two stubs on 127.0.0.1 (port 0): the direct
// upstream, reached through DIRECT_UPSTREAM_URL, and OpenRouter, reached by
// rewriting the kit's fixed OpenRouter URL onto the second stub. Pins:
//   - off by default: no request ever reaches the direct stub;
//   - a listed model goes there first, with provider.zdr true, max_tokens set,
//     the mapped id, and no OpenRouter-only field; an unlisted model never does;
//   - a request with tools, response_format, an image or reasoning stays on OpenRouter;
//   - each failure (429, 402, 503, 500, timeout, a 200 with a late error after
//     leading whitespace, a 200 without a cost, non-JSON, an error first stream
//     frame) falls back to OpenRouter exactly once and meters exactly once;
//   - the upstream's billing fields never reach the buyer, plain or streamed;
//   - DIRECT_UPSTREAM_SHARE 0 sends nothing, 50 splits within tolerance (seeded);
//   - a booted server answers /__operator/direct-upstream.json only with the
//     operator token, and /privacy carries the sentence only while configured.
// Offline: no network, no real keys, no spend.
//
//   node scripts/test-direct-upstream.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ownStoreEnv } from "./lib/own-stores.js";
import { getFreePort } from "./lib/free-port.js";

delete process.env.UPSTREAM_COSTS_JSON;
delete process.env.UPSTREAM_COSTS_FILE;
for (const k of Object.keys(process.env)) if (k.startsWith("DIRECT_UPSTREAM_")) delete process.env[k];
process.env.OPENROUTER_API_KEY = "test-key";
process.env.GATEWAY_METERED_BILLING = "on";

const U = await import("../src/upstream-costs.js");
const K = await import("../src/tools/llm-gateway-kit.js");
const D = await import("../src/gateway-direct-upstream.js");
const P = await import("../src/posthog.js");

// The format example's placeholder rows, plus rows for the two families this
// suite routes, each reusing a placeholder row object (no number typed here).
const example = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
const placeholder = example.models.find(([p]) => p === "openai/")[1];
U.setUpstreamCostsForTest({ ...example, models: [...example.models, ["deepseek/", placeholder], ["qwen/", placeholder]] });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// ---- stubs -------------------------------------------------------------------
function stub() {
  const s = { hits: [], plan: null };
  s.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      s.hits.push({ url: req.url, headers: req.headers, body });
      try { await (s.plan || defaultOk)(req, res, body); } catch { try { res.destroy(); } catch { /* gone */ } }
    });
  });
  return s;
}
const answer = (model, extra = {}) => ({ id: "cmpl-1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, ...extra });
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
const OR_COST = 0.000321;
const DIRECT_MICRO = 123;
const defaultOk = (req, res, body) => json(res, 200, answer(body?.model, { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: OR_COST, cost_details: { upstream_inference_cost: OR_COST } } }));
const sse = (res, frames) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const f of frames) res.write(`data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`); res.end(); };

const direct = stub(), or = stub();
await new Promise((r) => direct.server.listen(0, "127.0.0.1", r));
await new Promise((r) => or.server.listen(0, "127.0.0.1", r));
const DIRECT_PORT = direct.server.address().port;
const OR_PORT = or.server.address().port;
const DIRECT_BASE = `http://127.0.0.1:${DIRECT_PORT}/v1`;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://openrouter.ai/api/v1/chat/completions")) return realFetch(`http://127.0.0.1:${OR_PORT}/api/v1/chat/completions`, init);
  if (u.startsWith(`http://127.0.0.1:${DIRECT_PORT}/`) || u.startsWith(`http://127.0.0.1:${OR_PORT}/`)) return realFetch(url, init);
  throw new Error(`test: unexpected outbound fetch to ${u.slice(0, 60)}`);
};

const spend = [];
P.setMeterSpendSinkForTest((source, usd) => spend.push({ source, usd }));

const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const MAPPED = "deepseek-v4.1-flash";
const ON = { DIRECT_UPSTREAM_URL: DIRECT_BASE, DIRECT_UPSTREAM_KEY: "direct-test-key", DIRECT_UPSTREAM_MODELS: `${MODEL}=${MAPPED},qwen/qwen3.8-27b=qwen3.8-27b`, DIRECT_UPSTREAM_TIMEOUT_MS: "400" };
// A booted server's background price book reads the stubs only.
const BOOT_STUBS = { DIRECT_UPSTREAM_OR_MODELS_URL: `http://127.0.0.1:${OR_PORT}/api/v1/models` };
const setEnv = (vars) => {
  for (const k of Object.keys(process.env)) if (k.startsWith("DIRECT_UPSTREAM_")) delete process.env[k];
  Object.assign(process.env, vars || {});
};
const base = K.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
const metered = K.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered");
ok(!!base && !!metered, "base and metered chat tools found");
const msgs = [{ role: "user", content: "hi" }];
// The cost guard (src/gateway-direct-pricebook.js, its own suite
// scripts/test-direct-upstream-cost-guard.js) reads a price book; this suite
// seeds one where the direct upstream undercuts OpenRouter by a wide factor,
// derived from the tier cap and the placeholder row (no rate typed here).
const PB = await import("../src/gateway-direct-pricebook.js");
const cap = K.TIERS["v1-chat"].maxPrice;
const endpoint = Object.fromEntries(["prompt", "completion"].map((k) => [k, Math.min(cap[k], placeholder[k]) / 2]));
const cheapDirect = Object.fromEntries(["prompt", "completion"].map((k) => [k, endpoint[k] / 10]));
const seedBook = () => { PB._resetDirectPriceBookForTest(); PB._seedDirectPriceBookForTest({ [MODEL]: { direct: cheapDirect, endpoints: [endpoint] }, "qwen/qwen3.8-27b": { direct: cheapDirect, endpoints: [endpoint] } }); };
const reset = () => { direct.hits.length = 0; or.hits.length = 0; direct.plan = null; or.plan = null; spend.length = 0; D._resetDirectUpstreamStatsForTest(); D._resetDirectBreakerForTest(); seedBook(); };
const flush = () => new Promise((r) => setTimeout(r, 30)); // the usage capture is a lazy import off the handler's promise
const gatewaySpend = () => spend.filter((s) => s.source === "gateway");

const fakeRes = () => {
  const r = {
    headersSent: false, chunks: [], ended: false, req: null,
    writeHead(status, headers) { r.headersSent = true; r.status = status; r.headers = headers; },
    flushHeaders() {}, write(c) { r.chunks.push(String(c)); return true; }, end() { r.ended = true; },
    on() {}, once() {}, off() {},
  };
  return r;
};

// ---- config parsing ------------------------------------------------------------
ok(D.directUpstreamConfig({}) === null, "no env: off");
ok(D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_URL: "http://example.com/v1" }) === null, "plain http to a non-loopback host: off");
ok(D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_URL: "https://user:pw@example.com/v1" }) === null, "credentials in the URL: off");
ok(D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_KEY: "" }) === null, "no key: off");
ok(D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_MODELS: "garbage" }) === null, "a model map that does not parse: off");
ok(D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_URL: "https://example.com/v1/" })?.url === "https://example.com/v1/chat/completions", "https base: /chat/completions appended once");
ok(D.directUpstreamConfig(ON).share === 100 && D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_SHARE: "abc" }).share === 0 && D.directUpstreamConfig({ ...ON, DIRECT_UPSTREAM_SHARE: "101" }).share === 0, "share defaults to 100; invalid reads 0");
ok(D.directUpstreamBootWarnings({}).length === 0 && D.directUpstreamBootWarnings({ DIRECT_UPSTREAM_URL: DIRECT_BASE }).some((w) => /KEY/.test(w)), "boot warnings: none unset, the missing names when partly set");
ok(!D.directUpstreamBootWarnings({ ...ON, DIRECT_UPSTREAM_KEY: "secret-value-xyz" }).join(" ").includes("secret-value-xyz"), "boot warnings never print a value");

// ---- off by default ------------------------------------------------------------
setEnv({});
reset();
{
  const out = await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 });
  ok(direct.hits.length === 0 && or.hits.length === 1, "off: nothing reaches the direct stub; OpenRouter serves");
  ok(out.choices?.[0]?.message?.content === "hello", "off: the answer is served");
}

// ---- eligible model goes direct ------------------------------------------------
setEnv(ON);
reset();
direct.plan = (req, res, body) => json(res, 200, answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO, request_id: "r1" } }), { "x-vendor-charged-micro": String(DIRECT_MICRO) });
{
  const out = await metered.handler({ model: MODEL, messages: msgs, max_tokens: 64, temperature: 0.2, zdr: false });
  await flush();
  const h = direct.hits[0];
  ok(direct.hits.length === 1 && or.hits.length === 0, "on: a listed model is served by the direct stub alone");
  ok(h?.body?.provider?.zdr === true && Object.keys(h.body.provider).length === 1, "the direct body carries provider: { zdr: true } and nothing else under provider");
  ok(Number.isInteger(h?.body?.max_tokens) && h.body.max_tokens > 0 && h.body.max_tokens <= 64, "the direct body carries the clamped max_tokens");
  ok(h?.body?.model === MAPPED && h.body.temperature === 0.2, "the direct body names the mapped id and keeps an allowed parameter");
  ok(["user", "session_id", "plugins", "usage", "cache_control", "transforms", "service_tier", "zdr"].every((k) => !(k in (h?.body || {}))), "no OpenRouter-only field reaches the direct upstream");
  ok(h?.headers?.authorization === "Bearer direct-test-key", "the direct key rides as a bearer header");
  ok(out.model === MODEL, "the buyer sees the model id it asked for, not the upstream's");
  ok(!Object.keys(out).some((k) => k.startsWith("x_")) && !JSON.stringify(out).includes("charged_micro"), "no vendor extension field reaches the buyer");
  ok(!("cost" in (out.usage || {})) && out.usage?.prompt_tokens === 3, "usage.cost is stripped; token counts stay");
  ok(out.__meterUpstreamUsd === DIRECT_MICRO / 1e6, "metered: the meter reads the upstream's own reported cost");
  ok(gatewaySpend().length === 1 && gatewaySpend()[0].usd === DIRECT_MICRO / 1e6, "the spend meter recorded exactly one call, at the direct cost");
}
// The header alone also carries the cost.
reset();
direct.plan = (req, res, body) => json(res, 200, answer(body.model), { "x-vendor-charged-micro": "77" });
{
  const out = await metered.handler({ model: MODEL, messages: msgs, max_tokens: 64 });
  ok(direct.hits.length === 1 && or.hits.length === 0 && out.__meterUpstreamUsd === 77 / 1e6, "a cost in the charged-micro header alone is read");
}

// ---- unlisted model and refused features ----------------------------------------
reset();
await base.handler({ model: "deepseek/deepseek-chat", messages: msgs, max_tokens: 32 });
ok(direct.hits.length === 0 && or.hits.length === 1, "an unlisted model never reaches the direct stub");
for (const [label, extra] of [
  ["tools", { tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }] }],
  ["response_format", { response_format: { type: "json_object" } }],
  ["an image", { messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }],
  ["logprobs", { logprobs: true }],
]) {
  reset();
  let threw = null;
  try { await base.handler({ model: MODEL, messages: msgs, max_tokens: 32, ...extra }); } catch (e) { threw = e; }
  ok(direct.hits.length === 0 && (threw || or.hits.length === 1), `a request with ${label} stays off the direct upstream${threw ? ` (refused before any call: ${threw.statusCode})` : ""}`);
}
{
  const plan = D.directBodyFrom({ model: MODEL, messages: msgs, max_tokens: 10, reasoning: { effort: "low" } }, MAPPED);
  ok(!plan.body && /reasoning/.test(plan.reason), "a reasoning object is not forwarded (the attempt stays on OpenRouter)");
  const tool = D.directBodyFrom({ model: MODEL, messages: [{ role: "tool", content: "x", tool_call_id: "1" }], max_tokens: 10 }, MAPPED);
  ok(!tool.body, "a tool-role message is not forwarded");
  const nomax = D.directBodyFrom({ model: MODEL, messages: msgs }, MAPPED);
  ok(!nomax.body, "an attempt without max_tokens is not forwarded");
}

// ---- each failure falls back once and bills once --------------------------------
const TRIGGERS = [
  ["429", (req, res) => json(res, 429, { error: { message: "capacity", type: "rate_limit", code: "capacity" } }, { "retry-after": "1" })],
  ["402", (req, res) => json(res, 402, { error: { message: "insufficient quota", type: "insufficient_quota", code: "insufficient_quota" } })],
  ["503", (req, res) => json(res, 503, { error: { message: "no qualifying worker", type: "unavailable", code: "unavailable" } })],
  ["500", (req, res) => json(res, 500, { error: { message: "boom", type: "server_error" } })],
  ["a timeout", (req, res, body) => setTimeout(() => { try { json(res, 200, answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO } })); } catch { /* aborted */ } }, 1500)],
  ["a 200 with a late error after leading whitespace", (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("   \n  \n"); setTimeout(() => res.end(JSON.stringify({ error: { message: "worker lost", type: "server_error", param: null, code: "worker_lost" } })), 20); }],
  ["a 200 with a late error beside partial output", (req, res, body) => { res.writeHead(200, { "content-type": "application/json" }); res.write("  \n"); res.end(JSON.stringify({ ...answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO } }), error: { message: "worker lost mid-answer", type: "server_error", param: null, code: "worker_lost" } })); }],
  ["a 200 without a cost", (req, res, body) => json(res, 200, answer(body.model))],
  ["a 200 with a negative cost", (req, res, body) => json(res, 200, answer(body.model, { x_vendor: { charged_micro: -5 } }))],
  ["a non-JSON 200", (req, res) => json(res, 200, "<html>gateway</html>")],
  ["a connection reset", (req, res) => res.destroy()],
];
for (const [label, plan] of TRIGGERS) {
  reset();
  direct.plan = plan;
  let out = null, err = null;
  try { out = await metered.handler({ model: MODEL, messages: msgs, max_tokens: 64 }); } catch (e) { err = e; }
  await flush();
  ok(!err && direct.hits.length === 1 && or.hits.length === 1, `${label}: one direct attempt, then OpenRouter exactly once${err ? ` (threw ${err.statusCode} ${err.message})` : ""}`);
  ok(out?.__meterUpstreamUsd === OR_COST && gatewaySpend().length === 1 && gatewaySpend()[0].usd === OR_COST, `${label}: metered once, at OpenRouter's cost`);
  ok(out && !JSON.stringify(out).includes("cost_details") && !("cost" in (out.usage || {})), `${label}: OpenRouter's billing fields are stripped as before`);
}
// An empty direct answer (a safety refusal or a spent output cap) is a direct
// failure: the SAME model is then tried on OpenRouter, never skipped for
// another model. An OpenRouter empty answer still skips the model's other attempts.
for (const [label, finish, completion] of [["an empty refusal", "content_filter", 0], ["an empty length answer", "length", 32]]) {
  reset();
  direct.plan = (req, res, body) => json(res, 200, { id: "c", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: completion, total_tokens: 3 + completion }, x_vendor: { charged_micro: DIRECT_MICRO } });
  let out = null, err = null;
  try { out = await metered.handler({ model: MODEL, messages: msgs, max_tokens: 32 }); } catch (e) { err = e; }
  await flush();
  ok(!err && direct.hits.length === 1 && or.hits.length === 1 && or.hits[0]?.body?.model === MODEL && out?.model === MODEL, `${label} from the direct upstream falls to the same model on OpenRouter (OpenRouter saw ${or.hits[0]?.body?.model}, served ${out?.model})`);
  ok(gatewaySpend().length === 1 && gatewaySpend()[0].usd === OR_COST, `${label} from the direct upstream: metered once, at OpenRouter's cost`);
}
{
  reset();
  setEnv({});
  or.plan = (req, res, body) => json(res, 200, { id: "c", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3, cost: OR_COST } });
  try { await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 }); } catch { /* every link empty */ }
  ok(or.hits.filter((h) => h.body?.model === MODEL).length === 1, "an OpenRouter empty refusal still skips the model's remaining attempts");
  setEnv(ON);
}
// A timeout counts in the timed-out-attempt budget: with a budget of 1 the walk ends there.
{
  reset();
  process.env.LLM_MAX_TIMED_OUT_ATTEMPTS = "1";
  direct.plan = TRIGGERS.find(([l]) => l === "a timeout")[1];
  let err = null;
  try { await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 }); } catch (e) { err = e; }
  ok(err?.statusCode === 504 && or.hits.length === 0, "a direct timeout counts in LLM_MAX_TIMED_OUT_ATTEMPTS (budget 1: no further attempt)");
  delete process.env.LLM_MAX_TIMED_OUT_ATTEMPTS;
}

// ---- the direct breaker ----------------------------------------------------------
// Consecutive failed direct attempts open it: no call goes direct while open
// (no added latency, no timed-out attempt spent), the public word reads
// degraded, and after the open period one trial closes it on success.
{
  setEnv({ ...ON, DIRECT_UPSTREAM_BREAKER_FAILS: "2", DIRECT_UPSTREAM_BREAKER_OPEN_MS: "60000" });
  reset();
  const PBk = await import("../src/gateway-direct-pricebook.js");
  let now = Date.now();
  D._setDirectBreakerNowForTest(() => now);
  direct.plan = (req, res) => json(res, 503, { error: { message: "no qualifying worker" } });
  for (let i = 0; i < 2; i++) await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 });
  ok(direct.hits.length === 2 && or.hits.length === 2 && D.directBreakerState().open, "two consecutive direct failures open the breaker");
  ok(PBk.directUpstreamWord() === "degraded" && JSON.stringify(PBk.directUpstreamStatus()) === '{"status":"degraded"}' && PBk.directUpstreamStatus({ full: true }).reason === "breaker_open", "open: the public word is degraded, the reason only on the operator read");
  D._resetDirectUpstreamStatsForTest();
  await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 });
  ok(direct.hits.length === 2 && or.hits.length === 3 && D.directUpstreamReport().skipped.breaker_open === 1, "open: the next call skips the direct upstream (a breaker_open skip)");
  now += 60_001;
  await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 });
  ok(direct.hits.length === 3 && D.directBreakerState().open, "after the open period one trial goes direct; it fails and the breaker stays open");
  await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 });
  ok(direct.hits.length === 3, "the failed trial reopens it: the next call skips direct");
  now += 60_001;
  direct.plan = (req, res, body) => json(res, 200, answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO } }));
  await base.handler({ model: MODEL, messages: msgs, max_tokens: 32 });
  ok(direct.hits.length === 4 && !D.directBreakerState().open && PBk.directUpstreamWord() === "ok", "a successful trial closes it and the word reads ok");
  // A buyer who hung up is not the upstream failing.
  D.noteDirectOutcome(false, "client_gone");
  ok(D.directBreakerState().fails === 0, "a client that went away does not count");
  D._setDirectBreakerNowForTest(null);
  setEnv(ON);
}

// ---- streams ------------------------------------------------------------------
reset();
direct.plan = (req, res, body) => sse(res, [
  { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] },
  { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
  { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: DIRECT_MICRO / 1e6 }, x_vendor: { charged_micro: DIRECT_MICRO } },
  "[DONE]",
]);
{
  const out = await base.handler({ model: MODEL, messages: msgs, max_tokens: 32, stream: true });
  const res = fakeRes();
  await out.__sse(res);
  await flush();
  const text = res.chunks.join("");
  const h = direct.hits[0];
  ok(direct.hits.length === 1 && or.hits.length === 0 && res.status === 200, "stream: a listed model streams from the direct stub");
  ok(h?.body?.stream === true && h.body.stream_options?.include_usage === true && h.body.provider?.zdr === true && Number.isInteger(h.body.max_tokens), "stream: the direct body asks for usage, carries zdr and max_tokens");
  ok(text.includes("hel") && text.includes("[DONE]"), "stream: the answer frames reach the buyer");
  ok(!text.includes("x_vendor") && !text.includes("charged_micro") && !/"cost"/.test(text), "stream: no billing field reaches the buyer");
  ok(!text.includes(`"model":"${MAPPED}"`) && text.includes(`"model":"${MODEL}"`), "stream: frames name the buyer's model id");
  ok(gatewaySpend().length === 1 && gatewaySpend()[0].usd === DIRECT_MICRO / 1e6, "stream: metered once, at the direct cost");
}
// The charge in a frame of its own, before or after a usage frame that has no
// cost: stripped from the buyer's stream and metered once, at that charge.
for (const [label, order] of [["before", ["charge", "usage"]], ["after", ["usage", "charge"]]]) {
  reset();
  direct.plan = (req, res, body) => {
    const frames = [{ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }];
    for (const k of order) frames.push(k === "charge" ? { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], x_vendor: { charged_micro: DIRECT_MICRO } } : { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    sse(res, [...frames, "[DONE]"]);
  };
  const out = await base.handler({ model: MODEL, messages: msgs, max_tokens: 32, stream: true });
  const res = fakeRes();
  await out.__sse(res);
  await flush();
  const text = res.chunks.join("");
  ok(text.includes("hello") && !text.includes("x_vendor") && !text.includes("charged_micro") && !/"cost"/.test(text), `stream, charge frame ${label} the usage frame: no billing field reaches the buyer`);
  ok(gatewaySpend().length === 1 && gatewaySpend()[0].usd === DIRECT_MICRO / 1e6, `stream, charge frame ${label} the usage frame: metered once, at the direct charge (${JSON.stringify(gatewaySpend())})`);
  ok(!D.directUpstreamReport().anomalies.stream_no_cost, `stream, charge frame ${label} the usage frame: not counted as a stream without a cost`);
}
{
  reset();
  direct.plan = (req, res, body) => sse(res, [
    { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] },
    { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    "[DONE]",
  ]);
  const out = await base.handler({ model: MODEL, messages: msgs, max_tokens: 32, stream: true });
  const res = fakeRes();
  await out.__sse(res);
  await flush();
  ok(D.directUpstreamReport().anomalies.stream_no_cost === 1 && !gatewaySpend().some((x) => typeof x.usd === "number" && x.usd > 0), "stream with no charge anywhere: the usage frame is still reported once, as a stream without a cost");
}
for (const [label, plan] of [
  ["503", (req, res) => json(res, 503, { error: { message: "no qualifying worker" } })],
  ["an error first frame", (req, res) => sse(res, [{ error: { message: "capacity", code: "capacity" } }])],
  ["a timeout", (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": keep-alive\n\n"); }],
]) {
  reset();
  direct.plan = plan;
  or.plan = (req, res, body) => sse(res, [
    { id: "g1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "fallback" }, finish_reason: "stop" }] },
    { id: "g1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: OR_COST, is_byok: false } },
    "[DONE]",
  ]);
  const out = await base.handler({ model: MODEL, messages: msgs, max_tokens: 32, stream: true });
  const res = fakeRes();
  let err = null;
  try { await out.__sse(res); } catch (e) { err = e; }
  await flush();
  const text = res.chunks.join("");
  ok(!err && direct.hits.length === 1 && or.hits.length === 1 && text.includes("fallback"), `stream ${label}: falls back to OpenRouter exactly once${err ? ` (threw ${err.statusCode} ${err.message})` : ""}`);
  ok(!text.includes("capacity") && !/"cost"/.test(text) && !text.includes("is_byok"), `stream ${label}: nothing from the failed attempt or the bill reaches the buyer`);
  ok(gatewaySpend().length === 1 && gatewaySpend()[0].usd === OR_COST, `stream ${label}: metered once, at OpenRouter's cost`);
}

// ---- the A/B share ---------------------------------------------------------------
direct.plan = (req, res, body) => json(res, 200, answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO } }));
setEnv({ ...ON, DIRECT_UPSTREAM_SHARE: "0" });
reset();
for (let i = 0; i < 20; i++) await base.handler({ model: MODEL, messages: msgs, max_tokens: 16 });
ok(direct.hits.length === 0 && or.hits.length === 20, "share 0: nothing is sent to the direct upstream");
ok(D.directUpstreamReport().skipped.share === 20, "share 0: each skip is counted");
setEnv({ ...ON, DIRECT_UPSTREAM_SHARE: "50" });
reset();
// reset() clears the plan: the direct stub answers at its own (lower) cost, so
// the measured backstop never trips during the split.
direct.plan = (req, res, body) => json(res, 200, answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO } }));
let seed = 42;
D._setDirectUpstreamRngForTest(() => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; });
const N = 200;
for (let i = 0; i < N; i++) await base.handler({ model: MODEL, messages: msgs, max_tokens: 16 });
D._setDirectUpstreamRngForTest(null);
ok(direct.hits.length + or.hits.length === N, "share 50: every call answered by exactly one upstream");
ok(direct.hits.length >= N * 0.4 && direct.hits.length <= N * 0.6, `share 50: the split is within 40-60% (direct ${direct.hits.length} of ${N})`);
{
  const r = D.directUpstreamReport();
  ok(r.upstreams.direct.ok === direct.hits.length && r.upstreams.openrouter.ok === or.hits.length && r.upstreams.direct.latencyMs.p50 !== null && r.upstreams.openrouter.latencyMs.p90 !== null, "the A/B report counts each upstream and carries p50/p90 latency");
  ok(!JSON.stringify(r).includes("127.0.0.1") && !JSON.stringify(r).includes("direct-test-key"), "the A/B report carries no URL or key");
}

// ---- booted: operator view and privacy page -------------------------------------
setEnv({});
const PORT = await getFreePort();
const TOKEN = "direct-upstream-test-operator-token-0123456789";
async function boot(extraEnv) {
  const log = [];
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...ownStoreEnv("direct-upstream"), PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", AGENT402_OPERATOR_TOKEN: TOKEN, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await realFetch(`${url}/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  return { child, url, up, log };
}
const stop = async (b) => { b.child.kill("SIGTERM"); await new Promise((r) => { b.child.once("exit", r); setTimeout(r, 5000); }); };
{
  const b = await boot({ ...ON, ...BOOT_STUBS, DIRECT_UPSTREAM_SINCE: "2026-01-01" });
  try {
    ok(b.up, "server booted with the direct upstream configured");
    const anon = await realFetch(`${b.url}/__operator/direct-upstream.json`);
    const wrong = await realFetch(`${b.url}/__operator/direct-upstream.json`, { headers: { Authorization: "Bearer not-the-token-0123456789-abcdef" } });
    ok(anon.status === 404 && wrong.status === 404, "the operator view answers 404 without the operator token");
    const r = await realFetch(`${b.url}/__operator/direct-upstream.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json().catch(() => ({}));
    ok(r.status === 200 && j.configured === true && j.upstreams?.direct && /no-store/.test(r.headers.get("cache-control") || ""), "with the token: the report, never cached");
    const html = await (await realFetch(`${b.url}/privacy`)).text();
    ok(html.includes("direct inference provider") && html.includes("Zero data retention is requested on every such call") && html.includes("calls to listed models") && !/open-weight/i.test(html), "/privacy carries the sentence while configured, naming listed models (the switch takes any id)");
    ok(!b.log.join("").includes("direct-test-key"), "the boot log never prints the key");
  } finally { await stop(b); }
}
{
  const b = await boot({});
  try {
    const html = await (await realFetch(`${b.url}/privacy`)).text();
    ok(b.up && !html.includes("direct inference provider"), "/privacy leaves the sentence out while unconfigured");
    const r = await realFetch(`${b.url}/__operator/direct-upstream.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ok((await r.json()).configured === false, "the operator view reads configured false while off");
  } finally { await stop(b); }
}
// The printed date: the later of the page's own and DIRECT_UPSTREAM_SINCE, only while configured and once reached.
{
  const page = "x last updated 2026-11-05. y";
  ok(D.withDirectUpstreamDate(page, {}, "2027-01-01") === page, "date: unconfigured, the page's own date");
  ok(D.withDirectUpstreamDate(page, { ...ON, DIRECT_UPSTREAM_SINCE: "2026-12-01" }, "2027-01-01").includes("2026-12-01"), "date: configured and reached, the later SINCE prints");
  ok(D.withDirectUpstreamDate(page, { ...ON, DIRECT_UPSTREAM_SINCE: "2026-12-01" }, "2026-11-20") === page, "date: SINCE after today keeps the page's own");
  ok(D.withDirectUpstreamDate(page, { ...ON, DIRECT_UPSTREAM_SINCE: "2026-02-30" }, "2027-01-01") === page, "date: an invalid SINCE keeps the page's own");
}

direct.server.close(); or.server.close();
globalThis.fetch = realFetch;
// Streams that repeat usage on every chunk and carry the charge only on the
// last frame are metered at that charge, once (and the last usage, not the
// first, is what reports when no charge ever arrives).
{
  const runScrub = (frames) => {
    const calls = [];
    const sc = K.createSseUsageScrubber({ vendorKeys: true, onUsage: (u, c) => calls.push({ tok: u?.completion_tokens, cost: c }) });
    for (const f of frames) sc.push(`data: ${JSON.stringify(f)}\n\n`);
    sc.flush();
    return calls;
  };
  const chunk = (t) => ({ choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: t } });
  const d = runScrub([chunk(1), chunk(2), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, x_vendor: { charged_micro: 4321 } }]);
  ok(d.length === 1 && d[0].tok === 5 && Math.abs(d[0].cost - 0.004321) < 1e-12, `usage on every chunk, charge on the last frame: metered once at that charge (${JSON.stringify(d)})`);
  const e = runScrub([chunk(1), chunk(3)]);
  ok(e.length === 1 && e[0].tok === 3 && e[0].cost === null, `usage on every chunk with no charge: the last usage reports, uncharged (${JSON.stringify(e)})`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
