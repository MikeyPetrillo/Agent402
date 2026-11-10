#!/usr/bin/env node
// One caller mistake or one upstream condition gets the same class of answer
// on every /v1 wire: OpenAI chat completions, Anthropic Messages, OpenAI
// Responses, and Google generateContent where the row applies.
//
// Each row of the tables below is sent to every wire of a booted server and
// read back three ways: the HTTP status, the error body's shape, and the
// tool_call event the route binder records (a 5xx is what the failure monitor
// counts). A caller's mistake is a 4xx everywhere, an upstream failure a 5xx
// everywhere, and nothing at or above 400 is settled (CLAUDE.md, settlement
// ordering). Rows that differ by wire on purpose carry the reason in `differs`.
//
// The pre-payment rows run against a second, PAID boot: a metered request
// that cannot be served (an id the live model list does not carry, an input
// over the model's character cap) is answered 400 in the wire's own error
// shape before any payment gate, so no 402 is issued and the facilitator is
// never asked to verify a credential; a servable request beside each one gets
// its 402 (the live control).
//
// Offline: the model upstream and the live model list are one local stub
// (scripts/lib/openrouter-stub-preload.js refuses to boot without it).
//
//   node scripts/test-llm-wire-parity.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { TIERS, upstreamHttpError, inputTooLargeError, refuseUnlistedMeteredModel } from "../src/tools/llm-gateway-kit.js";
import { MESSAGES_PATH_BY_TIER } from "../src/tools/llm-messages-kit.js";
import { RESPONSES_PATH_BY_TIER } from "../src/tools/llm-responses-kit.js";
import { GEMINI_PATH_BY_TIER } from "../src/tools/llm-gemini-kit.js";
import { PRE_PAYMENT_WIRES, meteredPrePaymentRefusal } from "../src/gateway-prepayment.js";
import { _setModelCatalogForTest } from "../src/model-catalog.js";
import { readFileSync } from "node:fs";
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-llm-wire-parity");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ---- fixtures ---------------------------------------------------------------
const MODEL = "openai/gpt-4o-mini";            // listed, on the base and metered tiers, 128k window
const UNLISTED = "openai/gpt-4o-mnii";         // one transposition away from a listed id
const RETIRED = "google/gemini-2.5-flash";     // retired upstream; its successor serves the call
const NO_SAMPLING = "anthropic/claude-haiku-5.5"; // takes no temperature on any wire
const LISTED = [MODEL, "openai/gpt-4o", "openai/gpt-6-luna", "openai/gpt-4.1", "anthropic/claude-haiku-4.5", NO_SAMPLING, "google/gemini-3.1-flash-lite", "google/gemini-3.5-flash-lite", "deepseek/deepseek-v4-flash"];
for (let i = 0; i < 120; i++) LISTED.push(`filler/model-${i}`); // the live list is read only at a plausible size
const CTX = { [MODEL]: 128_000, "deepseek/deepseek-v4-flash": 1_048_576 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const OVER_CAP_CHARS = 400_000;                // above gpt-4o-mini's 384,000-char metered cap

// ---- the stub upstream ------------------------------------------------------
// The scenario rides in the prompt text as "SCN=<name>"; the path names the wire.
const upstreamCalls = [];
let catalogReads = 0;
const sse = (res, frames) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); for (const f of frames) res.write(f); res.end(); };
const okJson = {
  chat: (b) => ({ id: "gen-c", object: "chat.completion", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000001 } }),
  messages: (b) => ({ id: "msg_x", type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1, cost: 0.000001 } }),
  responses: (b) => ({ id: "resp_x", object: "response", model: b.model, status: "completed", output: [{ id: "msg_x", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, cost: 0.000001 } }),
};
const emptyJson = {
  chat: (b) => ({ id: "gen-c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 64, cost: 0.000001 } }),
  messages: (b) => ({ id: "msg_x", type: "message", role: "assistant", model: b.model, content: [{ type: "thinking", thinking: "hmm" }], stop_reason: "max_tokens", usage: { input_tokens: 3, output_tokens: 64, cost: 0.000001 } }),
  responses: (b) => ({ id: "resp_x", object: "response", model: b.model, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }], usage: { input_tokens: 3, output_tokens: 64, cost: 0.000001 } }),
};
const okFrames = {
  chat: (b) => [`data: ${JSON.stringify({ id: "gen-c", model: b.model, choices: [{ index: 0, delta: { role: "assistant", content: "answer" } }] })}\n\n`, `data: ${JSON.stringify({ id: "gen-c", model: b.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } })}\n\n`, "data: [DONE]\n\n"],
  messages: (b) => [`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: b.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } })}\n\n`, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`],
  responses: (b) => [`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_x", model: b.model, status: "in_progress" } })}\n\n`, `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n`, `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_x", model: b.model, status: "completed", usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`],
};
const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url.startsWith("/api/v1/models")) return catalogReads++, json(200, { data: LISTED.map((id) => ({ id, ...(CTX[id] ? { context_length: CTX[id] } : {}) })) });
    const wire = req.url === "/api/v1/messages" ? "messages" : req.url === "/api/v1/responses" ? "responses" : req.url === "/api/v1/chat/completions" ? "chat" : null;
    if (!wire) return json(404, { error: { message: "not stubbed" } });
    let b = {};
    try { b = JSON.parse(raw); } catch { /* answered as ok below */ }
    const scn = /SCN=([a-z0-9-]+)/.exec(raw)?.[1] || "ok";
    upstreamCalls.push({ wire, scn, model: b.model, stream: b.stream === true });
    switch (scn) {
      case "up4xx": return json(400, { error: { message: "This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens. To learn more: https://example.invalid/docs", code: 400 } });
      case "noimage": return json(404, { error: { message: "No endpoints found that support image input", code: 404 } });
      case "up200err": return json(200, { error: { message: "No endpoints found that support tool use", code: 404 } });
      case "up5xx": return json(500, { error: { message: "internal error", code: 500 } });
      case "drop": return void req.socket.destroy();
      case "empty": return json(200, emptyJson[wire](b));
      default: return b.stream === true ? sse(res, okFrames[wire](b)) : json(200, okJson[wire](b));
    }
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${upstream.address().port}`;

// ---- the wires --------------------------------------------------------------
const part = { // one user turn carrying `text` (and an image when asked), per wire
  chat: (text, image) => (image ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] : text),
  messages: (text, image) => (image ? [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] : text),
  responses: (text, image) => (image ? [{ type: "input_text", text }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] : text),
  gemini: (text, image) => [{ text }, ...(image ? [{ inlineData: { mimeType: "image/png", data: PNG } }] : [])],
};
const WIRES = {
  chat: {
    path: (t) => TIERS[t].route.split(" ")[1], slug: (t) => t,
    body: ({ model = MODEL, text = "hi", image, stream }) => ({ model, messages: [{ role: "user", content: part.chat(text, image) }], max_tokens: 64, ...(stream ? { stream: true } : {}) }),
    // The pre-payment refusal: OpenAI's error object.
    prepayShape: (j, code) => j?.error?.type === "invalid_request_error" && j.error.code === code && typeof j.error.message === "string",
  },
  messages: {
    path: (t) => MESSAGES_PATH_BY_TIER[t], slug: (t) => `${t}-messages`,
    body: ({ model = MODEL, text = "hi", image, stream }) => ({ model, max_tokens: 64, messages: [{ role: "user", content: part.messages(text, image) }], ...(stream ? { stream: true } : {}) }),
    // Anthropic's error envelope.
    prepayShape: (j, code) => j?.type === "error" && j.error?.type === "invalid_request_error" && j.error.code === code && typeof j.error.message === "string",
  },
  responses: {
    path: (t) => RESPONSES_PATH_BY_TIER[t], slug: (t) => `${t}-responses`,
    body: ({ model = MODEL, text = "hi", image, stream }) => ({ model, input: image ? [{ role: "user", content: part.responses(text, image) }] : text, max_output_tokens: 64, ...(stream ? { stream: true } : {}) }),
    prepayShape: (j, code) => j?.error?.type === "invalid_request_error" && j.error.code === code && typeof j.error.message === "string",
  },
  gemini: {
    path: (t) => GEMINI_PATH_BY_TIER[t], slug: (t) => `${t}-gemini`, noStream: true,
    body: ({ model = MODEL, text = "hi", image }) => ({ model, contents: [{ role: "user", parts: part.gemini(text, image) }], generationConfig: { maxOutputTokens: 64 } }),
    // Google's error object: a numeric code and a status word.
    prepayShape: (j, code) => j?.error?.code === 400 && j.error.status === "INVALID_ARGUMENT" && j.error.reason === code && typeof j.error.message === "string",
  },
};
const WIRE_NAMES = Object.keys(WIRES);
// What every wire's route binder answers for a handler refusal or failure:
// the message as a string beside the tool's slug.
const binderShape = (j, slug) => typeof j?.error === "string" && j.error.length > 0 && j.tool === slug;
const klass = (s) => `${Math.floor(s / 100)}xx`;

// ---- the tables -------------------------------------------------------------
// expect: the status class on every wire. differs: { wire: [class, reason] }.
// build(wire, base) returns the body for that wire from its base body.
const without = (keys) => (wire, b) => { const o = { ...b }; for (const k of keys[wire] || []) delete o[k]; return o; };
const BAD_TOOL = { chat: { tools: [{ type: "function" }] }, messages: { tools: [{ description: "no name" }] }, responses: { tools: [{ type: "function" }] }, gemini: { tools: [{ functionDeclarations: [{}] }] } };
const CALLER_ROWS = [
  { id: "unknown model", tier: "v1-chat-metered", expect: "4xx", opts: { model: UNLISTED }, prepay: "unknown_model" },
  { id: "input over the model cap", tier: "v1-chat-metered", expect: "4xx", opts: { text: "x".repeat(OVER_CAP_CHARS) }, prepay: "input_too_large" },
  { id: "retired model with a successor", tier: "v1-chat-metered", expect: "2xx", opts: { model: RETIRED }, servedBySuccessor: true },
  { id: "missing messages", tier: "v1-chat-metered", expect: "4xx", build: without({ chat: ["messages"], messages: ["messages"], responses: ["input"], gemini: ["contents"] }) },
  // The output cap is optional on three wires, where an unreadable value
  // reads the tier default; the Messages API requires max_tokens, and this
  // wire refuses a call without a usable one as that API does.
  { id: "bad max tokens", tier: "v1-chat-metered", expect: "2xx",
    build: (wire, b) => (wire === "gemini" ? { ...b, generationConfig: { maxOutputTokens: -5 } } : wire === "responses" ? { ...b, max_output_tokens: -5 } : { ...b, max_tokens: -5 }),
    differs: { messages: ["4xx", "max_tokens is required by the Messages API"] } },
  { id: "unsupported parameter", tier: "v1-chat-metered", expect: "4xx", opts: { model: NO_SAMPLING },
    build: (wire, b) => (wire === "gemini" ? { ...b, generationConfig: { ...b.generationConfig, temperature: 0.2 } } : { ...b, temperature: 0.2 }) },
  { id: "malformed tool definition", tier: "v1-chat-metered", expect: "4xx", build: (wire, b) => ({ ...b, ...BAD_TOOL[wire] }) },
  { id: "image where the model takes none", tier: "v1-chat-metered", expect: "4xx", opts: { text: "SCN=noimage", image: true }, provider: true },
  { id: "image where the model takes none (flat tier)", tier: "v1-chat", expect: "4xx", opts: { text: "SCN=noimage", image: true }, provider: true },
];
const UPSTREAM_ROWS = [
  { id: "upstream 4xx about the request", scn: "up4xx", expect: "4xx", provider: true },
  { id: "upstream refusal inside a 200 body", scn: "up200err", expect: "4xx", provider: true },
  { id: "upstream 5xx", scn: "up5xx", expect: "5xx" },
  { id: "upstream connection ends with no answer (the timeout branch)", scn: "drop", expect: "5xx" },
  { id: "empty answer", scn: "empty", expect: "5xx" },
  { id: "served", scn: "ok", expect: "2xx" },
];
const STREAM_ROWS = [
  { id: "stream: upstream 4xx about the request", scn: "up4xx", expect: "4xx", provider: true },
  { id: "stream: upstream 5xx", scn: "up5xx", expect: "5xx" },
  { id: "stream: upstream connection ends with no answer", scn: "drop", expect: "5xx" },
  { id: "stream: served", scn: "ok", expect: "2xx" },
];

// ---- one request, read three ways -------------------------------------------
let ipSeq = 0;
async function send(srv, wireName, tier, body, { headers = {}, path } = {}) {
  const w = WIRES[wireName];
  const slug = w.slug(tier);
  const mark = srv.log().length;
  const r = await fetch(`${srv.url}${path || w.path(tier)}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* an SSE body */ }
  // The tool_call event the binder (or the pre-payment recorder) wrote.
  let event = null;
  for (let i = 0; i < 60 && !event; i++) {
    for (const line of srv.log().slice(mark).split("\n")) {
      if (!line.startsWith("[posthog-test] ")) continue;
      let e; try { e = JSON.parse(line.slice(15)); } catch { continue; }
      if (e.event === "tool_call" && e.properties?.slug === slug) event = e.properties;
    }
    if (!event) await sleep(50);
  }
  return { status: r.status, j, text, slug, event, paymentRequired: !!r.headers.get("payment-required"), wwwAuthenticate: !!r.headers.get("www-authenticate") };
}
const cell = (o) => `${o.status}${o.event ? (o.event.status >= 500 ? " failure" : o.event.errored ? " refusal" : " ok") : " unrecorded"}`;

/** Sends `row` to every wire and asserts the row's rule. */
async function runRow(srv, row, { stream = false } = {}) {
  const out = {};
  for (const name of WIRE_NAMES) {
    const w = WIRES[name];
    if (stream && w.noStream) continue;
    const tier = row.tier || "v1-chat-metered";
    const base = w.body({ ...(row.scn ? { text: `SCN=${row.scn}` } : {}), ...(row.opts || {}), stream });
    out[name] = { ...(await send(srv, name, tier, row.build ? row.build(name, base) : base)), want: row.differs?.[name]?.[0] || row.expect };
  }
  const names = Object.keys(out);
  const table = names.map((n) => `${n} ${cell(out[n])}`).join(" | ");
  ok(names.every((n) => klass(out[n].status) === out[n].want), `${row.id}: ${row.expect} on every wire${row.differs ? ` (by design: ${Object.entries(row.differs).map(([n, [c]]) => `${n} ${c}`).join(", ")})` : ""} [${table}]`);
  // Recorded as what it is: a 5xx is a failure the monitor counts, a 4xx a
  // refusal it does not, and each answer has exactly the status it recorded.
  ok(names.every((n) => out[n].event && out[n].event.status === out[n].status && out[n].event.errored === (out[n].status >= 400)), `${row.id}: every wire records the status it answered [${table}]`);
  // Shape: a refusal or failure is the binder's error body, or the wire's own
  // error object on a pre-payment refusal; a provider refusal names itself.
  for (const n of names) {
    const o = out[n];
    if (o.status < 400) continue;
    if (row.prepay) ok(WIRES[n].prepayShape(o.j, row.prepay) && o.j.tool === o.slug && o.event.prePayment === true, `${row.id}: ${n} answers its own error shape, recorded pre-payment (${o.text.slice(0, 160)})`);
    else ok(binderShape(o.j, o.slug), `${row.id}: ${n} answers the route binder's error body (${o.text.slice(0, 120)})`);
    if (row.provider) ok(/The model provider refused this request for /.test(o.j?.error || "") && !/https?:\/\//.test(o.j?.error || ""), `${row.id}: ${n} names the provider refusal and the model, with no upstream link (${String(o.j?.error).slice(0, 120)})`);
  }
  return out;
}

// ---- the shared rules, read directly ----------------------------------------
{
  // One upstream-status rule for every wire's buffered and streamed call.
  const refusal = await upstreamHttpError({ status: 404, text: async () => JSON.stringify({ error: { message: "No endpoints found that support image input" } }) }, MODEL).catch((e) => e);
  ok(refusal?.statusCode === 502 && refusal.upstreamRejected === true && refusal.message.includes(MODEL), "a provider 4xx on a buyer's call is marked upstreamRejected (the binder answers 400) and names the model");
  const down = await upstreamHttpError({ status: 500, text: async () => "" }, MODEL).catch((e) => e);
  ok(down?.statusCode === 502 && !down.upstreamRejected, "a provider 5xx is never marked as the caller's mistake");
  for (const file of ["llm-messages-kit.js", "llm-responses-kit.js"]) {
    const src = readFileSync(new URL(`../src/tools/${file}`, import.meta.url), "utf8");
    ok(!/\bthrowUpstreamError\b/.test(src) && /\bupstreamHttpError\(/.test(src), `${file} reads an upstream status through the shared rule only`);
    ok(/\brefuseUnlistedMeteredModel\(/.test(src), `${file} refuses an unlisted metered id in its own validation`);
  }
  // A tier's attempt bound (maxAttempts) is applied by the chat handler only.
  // That is no drift a buyer can meet while no bounded tier has a Messages,
  // Responses or generateContent route; a tier that gains one must carry its
  // bound to that wire first.
  for (const t of Object.keys(TIERS).filter((x) => Number.isFinite(TIERS[x].maxAttempts))) {
    ok(!MESSAGES_PATH_BY_TIER[t] && !RESPONSES_PATH_BY_TIER[t] && !GEMINI_PATH_BY_TIER[t], `the attempt-bounded tier ${t} is served by the chat wire alone`);
  }
  // The pre-payment check is one function over one table of wires.
  ok(JSON.stringify(Object.keys(PRE_PAYMENT_WIRES).sort()) === JSON.stringify(["v1-chat-metered", "v1-chat-metered-gemini", "v1-chat-metered-messages", "v1-chat-metered-responses"]), "the pre-payment check covers the four metered wires");
  // A miss starts a fresh read of the live list: it goes to the stub.
  process.env.MODEL_CATALOG_URL = `${STUB}/api/v1/models`;
  _setModelCatalogForTest(LISTED, Date.now(), CTX);
  for (const name of WIRE_NAMES) {
    const slug = WIRES[name].slug("v1-chat-metered");
    const r = meteredPrePaymentRefusal(slug, WIRES[name].body({ model: UNLISTED }));
    ok(r?.code === "unknown_model" && r.status === 400 && r.suggestions?.[0] === MODEL, `${name}: the shared check refuses an unlisted id and suggests the closest listed one (${r?.code} ${JSON.stringify(r?.suggestions)})`);
    const big = meteredPrePaymentRefusal(slug, WIRES[name].body({ text: "x".repeat(OVER_CAP_CHARS) }));
    ok(big?.code === "input_too_large" && big.fields.maxInputChars === 384_000 && big.fields.inputChars >= OVER_CAP_CHARS && big.message.includes(WIRES[name].path("v1-chat-metered")), `${name}: the shared check refuses an input over the cap and names this wire's route (${big?.message?.slice(0, 90)})`);
    ok(meteredPrePaymentRefusal(slug, WIRES[name].body({})) === null && meteredPrePaymentRefusal(slug, WIRES[name].body({ model: RETIRED })) === null && meteredPrePaymentRefusal(slug, null) === null, `${name}: a servable body, a retired id with a successor and a non-object pass`);
  }
  ok(meteredPrePaymentRefusal("v1-chat", WIRES.chat.body({ model: UNLISTED })) === null, "a flat route is never judged by the metered check");
  const thrown = (() => { try { refuseUnlistedMeteredModel(TIERS["v1-chat-metered"], UNLISTED); } catch (e) { return e; } return null; })();
  ok(thrown?.statusCode === 400 && thrown.code === "unknown_model" && thrown.suggestions?.[0] === MODEL, "validation throws the same verdict as a 400 with its code and suggestions");
  ok((() => { try { refuseUnlistedMeteredModel(TIERS["v1-chat"], UNLISTED); return true; } catch { return false; } })(), "a flat tier's validation is not judged by the live list");
  ok(inputTooLargeError("v1-chat-metered", MODEL, OVER_CAP_CHARS).message.includes("/v1/metered/chat/completions"), "the size refusal names the chat route unless a wire names its own");
  await sleep(200); // the miss-triggered read has ended
  _setModelCatalogForTest(null);
  delete process.env.MODEL_CATALOG_URL;
}

// ---- boot 1: every row through the route binder (FREE_MODE) -----------------
const PRELOAD = ["--import", "./scripts/lib/openrouter-stub-preload.js"];
const COMMON_ENV = {
  OPENROUTER_STUB_URL: STUB, MODEL_CATALOG_URL: `${STUB}/api/v1/models`, OPENROUTER_API_KEY: "test-key-never-used",
  BASE_URL: "http://agent402.test", TRUST_PROXY_HOPS: "1", SLOW_SYNC_WINDOW_SECONDS: "off", POSTHOG_TEST_CAPTURE: "1",
  X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
  DIRECT_UPSTREAM_URL: "", DIRECT_UPSTREAM_KEY: "", DIRECT_UPSTREAM_MODELS: "", TARGET_URL: "",
};
const catalogRead = async () => { const seen = catalogReads; for (let i = 0; i < 100 && catalogReads === seen; i++) await sleep(50); };
let free;
try {
  free = await bootServer({ args: PRELOAD, stores: "wire-parity-free", env: { ...COMMON_ENV, FREE_MODE: "true" } });
  await catalogRead(); await sleep(300);
  for (const row of CALLER_ROWS) {
    const out = await runRow(free, row);
    if (row.servedBySuccessor) ok(upstreamCalls.filter((c) => c.model === RETIRED).length === 0, `${row.id}: no wire sends the retired id upstream`);
    if (row.prepay) ok(Object.values(out).every((o) => o.j?.error && JSON.stringify(o.j).includes("Nothing was charged")), `${row.id}: every wire says nothing was charged`);
  }
  for (const tier of ["v1-chat-metered", "v1-chat"]) {
    for (const row of UPSTREAM_ROWS) await runRow(free, { ...row, id: `${row.id} (${tier})`, tier });
    for (const row of STREAM_ROWS) await runRow(free, { ...row, id: `${row.id} (${tier})`, tier }, { stream: true });
  }
  // Every wire reached its own upstream path (Gemini is served by the chat path).
  for (const w of ["chat", "messages", "responses"]) ok(upstreamCalls.some((c) => c.wire === w && c.scn === "ok" && !c.stream) && upstreamCalls.some((c) => c.wire === w && c.scn === "ok" && c.stream), `the ${w} wire reached its upstream path, buffered and streamed`);
} catch (e) {
  fail++; console.log(`FAIL - free boot: ${e.message}`);
} finally { await free?.stop(); }

// ---- boot 2: the pre-payment rows against real gates (PAID) -----------------
let verifies = 0;
const fac = createServer((req, res) => {
  req.resume();
  if (req.url === "/verify") verifies++;
  const body = req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }
    : req.url === "/verify" ? { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" } : {};
  res.writeHead(req.url === "/supported" || req.url === "/verify" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((r) => fac.listen(0, "127.0.0.1", r));
let paid;
try {
  paid = await bootServer({ args: PRELOAD, stores: "wire-parity-paid", env: {
    ...COMMON_ENV, FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${fac.address().port}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "wire-parity-test-secret",
    TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "",
  } });
  let ready = false;
  for (let i = 0; i < 160 && !ready; i++) { ready = (await fetch(`${paid.url}/api/search?q=x`)).status === 402; if (!ready) await sleep(250); }
  if (!ready) throw new Error("the x402 gate never answered a 402");
  await sleep(300);
  const M = "v1-chat-metered";
  // A payment built from the route's own 402 offer for a servable body: its
  // signature is not a real one, so the stub facilitator's /verify refuses it.
  const offers = {};
  const paymentHeaderFor = async (name) => {
    if (!offers[name]) {
      const r = await fetch(`${paid.url}${WIRES[name].path(M)}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.78.0.${ipSeq++ & 255}` }, body: JSON.stringify(WIRES[name].body({})) });
      await r.arrayBuffer();
      offers[name] = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
    }
    const offer = offers[name];
    const accepted = (offer.accepts || []).find((a) => a.scheme === "exact") || {};
    const payload = { signature: `0x${"11".repeat(65)}`, authorization: { from: "0x1111111111111111111111111111111111111111", to: accepted.payTo, value: String(accepted.amount ?? accepted.maxAmountRequired ?? "100000"), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: `0x${(ipSeq++).toString(16).padStart(64, "0")}` } };
    return { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, resource: offer.resource, accepted, payload })).toString("base64") };
  };
  const upstreamBefore = upstreamCalls.length;
  for (const name of WIRE_NAMES) {
    const w = WIRES[name];
    // The live control: a servable request is quoted, so the gate is there.
    const quoted = await send(paid, name, M, w.body({}));
    ok(quoted.status === 402 && quoted.paymentRequired, `${name}: a servable metered request gets its 402 quote (${quoted.status})`);
    // A payment for that servable request IS taken to the facilitator.
    const v0 = verifies;
    const attempted = await send(paid, name, M, w.body({}), { headers: await paymentHeaderFor(name) });
    ok(verifies > v0, `${name}: a payment on a servable request reaches the facilitator (${attempted.status}, verify calls ${verifies - v0})`);
    const successor = await send(paid, name, M, w.body({ model: RETIRED }));
    ok(successor.status === 402 && successor.paymentRequired, `${name}: a retired id with a successor is quoted, never refused (${successor.status})`);
    for (const [code, opts] of [["unknown_model", { model: UNLISTED }], ["input_too_large", { text: "x".repeat(OVER_CAP_CHARS) }]]) {
      const before = verifies;
      const r = await send(paid, name, M, w.body(opts));
      ok(r.status === 400 && !r.paymentRequired && !r.wwwAuthenticate, `${name} ${code}: a 400 with no payment requirement issued (${r.status}${r.paymentRequired ? " PAYMENT-REQUIRED" : ""}${r.wwwAuthenticate ? " WWW-Authenticate" : ""})`);
      ok(w.prepayShape(r.j, code) && r.j?.tool === r.slug, `${name} ${code}: the wire's own error shape (${r.text.slice(0, 200)})`);
      ok(r.event?.prePayment === true && r.event.status === 400 && r.event.errored === true, `${name} ${code}: recorded as a pre-payment refusal, not a failure`);
      ok(/Nothing was charged\./.test(r.j?.error?.message || ""), `${name} ${code}: the message says nothing was charged`);
      if (code === "unknown_model") ok(r.j?.suggestions?.[0] === MODEL && r.j?.howToCall?.url?.endsWith(w.path(M)) && JSON.stringify(r.j.howToCall.body).includes(MODEL), `${name}: suggestions closest first, and a howToCall for this wire's route with the suggested id (${JSON.stringify(r.j?.howToCall?.url)})`);
      else ok(r.j?.maxInputChars === 384_000 && r.j?.inputChars >= OVER_CAP_CHARS && r.j?.hint === "trim-input" && r.j.error.message.includes(w.path(M)), `${name}: the cap, the size read and this wire's route (${r.j?.error?.message?.slice(0, 100)})`);
      // With a payment header attached the answer is the same and the
      // facilitator is never asked; the same header on a servable body is.
      const withPay = await send(paid, name, M, w.body(opts), { headers: await paymentHeaderFor(name) });
      ok(withPay.status === 400 && !withPay.paymentRequired && verifies === before, `${name} ${code}: a request carrying a payment is refused the same way and no credential is verified (${withPay.status}, verify calls ${verifies - before})`);
    }
  }
  // The Anthropic SDK path and the Google-shaped path are the same routes.
  const alias = await send(paid, "messages", M, WIRES.messages.body({ model: UNLISTED }), { path: "/v1/metered/v1/messages" });
  ok(alias.status === 400 && !alias.paymentRequired && WIRES.messages.prepayShape(alias.j, "unknown_model"), `the Anthropic SDK path is checked the same way (${alias.status})`);
  const gbody = WIRES.gemini.body({}); delete gbody.model;
  const galias = await send(paid, "gemini", M, gbody, { path: `/v1/metered/v1beta/models/${UNLISTED}:generateContent` });
  ok(galias.status === 400 && !galias.paymentRequired && WIRES.gemini.prepayShape(galias.j, "unknown_model"), `the Google-shaped path's model is checked the same way (${galias.status} ${galias.text.slice(0, 120)})`);
  ok(upstreamCalls.length === upstreamBefore, "no pre-payment row reached the model upstream");
} catch (e) {
  fail++; console.log(`FAIL - paid boot: ${e.message}`);
} finally { await paid?.stop(); fac.close(); upstream.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
