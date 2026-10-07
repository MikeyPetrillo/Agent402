// Gateway and model-kit failure handling (offline, stubbed fetch):
//   - a stream chain walk stops once the buyer's connection closed (499),
//     on the chat, Messages and Responses wires;
//   - a flex attempt gets no same-model rate-limit retry delays (its own
//     fallback is the default attempt right after it); default attempts keep them;
//   - an EVM authorization bounds each attempt: too little settleable life left
//     means no new attempt (504, not charged), otherwise the per-attempt
//     timeout is cut to fit; with no EVM authorization nothing changes;
//   - an unusable upstream 200 (no message, no content array, an empty
//     content_filter incomplete, no embeddings, no image, no choice) is a 502,
//     while an empty end_turn / stop stays a 200;
//   - an OpenAI account-level billing refusal is a 502, not the buyer's 400.
//
//   node scripts/test-gateway-resilience.js
import { EventEmitter } from "node:events";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "sk-test-not-real";
delete process.env.OPENROUTER_FLEX;

const G = await import("../src/tools/llm-gateway-kit.js");
const { LLM_GATEWAY_TOOLS, flexEligible, retryRateLimited, rateLimitDelaysFor, paymentWindowTimeoutMs, PAYMENT_WINDOW_MIN_START_MS, PAYMENT_WINDOW_TAIL_MS } = G;
const { makeMessagesHandler } = await import("../src/tools/llm-messages-kit.js");
const { makeResponsesHandler } = await import("../src/tools/llm-responses-kit.js");
const { LLM_TOOLS } = await import("../src/tools/llm-kit.js");
const { EMBED_TOOLS } = await import("../src/tools/embed-kit.js");
const { MODERATE_TOOLS } = await import("../src/tools/moderate-kit.js");
const { IMAGE_GEN_TOOLS } = await import("../src/tools/image-gen-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const settle = async (fn) => { try { return { out: await fn() }; } catch (e) { return { err: e }; } };
const tool = (slug) => LLM_GATEWAY_TOOLS.find((t) => t.slug === slug);
const nano = tool("v1-chat-nano");
const FLEX_MODEL = "openai/gpt-6-luna";
const ONE = { model: FLEX_MODEL, model_fallback: false };
const realFetch = globalThis.fetch;

const fakeRes = () => {
  const res = new EventEmitter();
  Object.assign(res, { headersSent: false, destroyed: false, writableEnded: false, writes: 0,
    writeHead() { res.headersSent = true; }, flushHeaders() {}, write() { res.writes++; }, end() { res.writableEnded = true; } });
  return res;
};
const sseBody = (frame) => (async function* () { yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`); yield Buffer.from("data: [DONE]\n\n"); })();
// A request carrying an EVM authorization that expires `secs` from now.
const evmReq = (secs) => {
  const v = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300 },
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), value: "1000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + secs), nonce: "0x" + "01".repeat(32) } } })).toString("base64");
  return { ip: "203.0.113.5", headers: { "payment-signature": v }, header: (n) => (String(n).toLowerCase() === "payment-signature" ? v : undefined) };
};
// Records every AbortSignal.timeout / setTimeout duration at or above 1 s.
const recordTimeouts = () => {
  const seen = [];
  const at = AbortSignal.timeout, st = globalThis.setTimeout;
  AbortSignal.timeout = (ms) => { seen.push(ms); return at.call(AbortSignal, ms); };
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) seen.push(ms); return st(fn, ms, ...a); };
  return { seen, restore() { AbortSignal.timeout = at; globalThis.setTimeout = st; } };
};

const chatOk = (b, content = "OK") => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "g", model: b.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }) });
const msgOk = (b, content = [{ type: "text", text: "OK" }], stop = "end_turn") => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "m", type: "message", role: "assistant", model: b.model, content, stop_reason: stop, usage: { input_tokens: 3, output_tokens: 1 } }) });
const respOk = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "r", object: "response", status: "completed", model: b.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 3, output_tokens: 1 } }) });
const limited = () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }) });

const wires = [
  { name: "chat", run: (input, req) => nano.handler({ ...input, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }, req), okBody: chatOk, frame: { choices: [{ delta: { content: "tokens" } }] } },
  { name: "messages", run: (input, req) => makeMessagesHandler("v1-chat-nano")({ ...input, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }, req), okBody: msgOk, frame: { type: "content_block_delta", delta: { type: "text_delta", text: "tokens" } } },
  { name: "responses", run: (input, req) => makeResponsesHandler("v1-chat-nano")({ ...input, input: "hi", max_output_tokens: 20 }, req), okBody: respOk, frame: { type: "response.output_text.delta", delta: "tokens" } },
];

ok(flexEligible(FLEX_MODEL), `${FLEX_MODEL} is flex-first, so one link gives [flex, default] attempts`);

// ---- 1. a closed connection ends the stream walk -------------------------
for (const w of wires) {
  {
    const res = fakeRes(); const calls = [];
    globalThis.fetch = async (url, init) => {
      const b = JSON.parse(init.body); calls.push(b.service_tier || "default");
      if (calls.length === 1) {
        setTimeout(() => res.emit("close"), 20);
        return await new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      return { ok: true, status: 200, body: sseBody(w.frame) };
    };
    const r = await w.run({ stream: true, ...ONE });
    const { err } = await settle(() => r.__sse(res));
    ok(calls.length === 1 && err?.statusCode === 499 && res.writes === 0, `${w.name} stream: the buyer hung up during the first attempt -> no second attempt, 499 (calls ${calls.join(",")}, ${err?.statusCode})`);
  }
  {
    const res = fakeRes(); res.destroyed = true; const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(1); return { ok: true, status: 200, body: sseBody(w.frame) }; };
    const r = await w.run({ stream: true, ...ONE });
    const { err } = await settle(() => r.__sse(res));
    ok(calls.length === 0 && err?.statusCode === 499, `${w.name} stream: a connection already closed starts no attempt (499)`);
  }
  {
    // Control: a normal stream is unchanged.
    const res = fakeRes(); const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(1); return { ok: true, status: 200, body: sseBody(w.frame) }; };
    const r = await w.run({ stream: true, ...ONE });
    const { err } = await settle(() => r.__sse(res));
    ok(!err && calls.length === 1 && res.headersSent && res.writableEnded && res.writes > 0, `${w.name} stream control: one attempt, streamed and ended`);
  }
  {
    // Control: a 5xx on the flex attempt still walks to the default attempt.
    const res = fakeRes(); const calls = [];
    globalThis.fetch = async (url, init) => {
      const b = JSON.parse(init.body); calls.push(b.service_tier || "default");
      if (b.service_tier === "flex") return { ok: false, status: 503, text: async () => "flex capacity" };
      return { ok: true, status: 200, body: sseBody(w.frame) };
    };
    const r = await w.run({ stream: true, ...ONE });
    const { err } = await settle(() => r.__sse(res));
    ok(!err && calls.join(",") === "flex,default" && res.writableEnded, `${w.name} stream control: flex failure walks to default (${calls.join(",")})`);
  }
}

// ---- 2. flex attempts take no same-model rate-limit retry delays -----------
{
  ok(JSON.stringify(rateLimitDelaysFor(true)) === "[]" && rateLimitDelaysFor(false) === undefined, "rateLimitDelaysFor: none on flex, the default schedule otherwise");
  let n = 0; const slept = [];
  const e = await settle(() => retryRateLimited(async () => { n++; throw Object.assign(new Error("Upstream rate-limited - retry shortly"), { statusCode: 503 }); }, { delays: rateLimitDelaysFor(true), sleep: async (ms) => { slept.push(ms); } }));
  ok(n === 1 && slept.length === 0 && e.err?.statusCode === 503, "a rate-limited flex attempt is not retried in place");
  n = 0;
  await settle(() => retryRateLimited(async () => { n++; throw Object.assign(new Error("Upstream rate-limited - retry shortly"), { statusCode: 503 }); }, { delays: rateLimitDelaysFor(false), sleep: async (ms) => { slept.push(ms); } }));
  ok(n === 3 && slept.length === 2, "a rate-limited default attempt keeps its two retries");
}
for (const w of wires) {
  const calls = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push(b.service_tier || "default"); return limited(); };
  const { err } = await settle(() => w.run({ ...ONE }));
  const flexCalls = calls.filter((c) => c === "flex").length, defCalls = calls.filter((c) => c === "default").length;
  ok(flexCalls === 1 && defCalls === 3 && err?.statusCode === 503, `${w.name}: all-429 -> flex tried once, default three times, then 503 (flex ${flexCalls}, default ${defCalls})`);
  const res = fakeRes(); calls.length = 0;
  const r = await w.run({ stream: true, ...ONE });
  const s = await settle(() => r.__sse(res));
  ok(calls.filter((c) => c === "flex").length === 1 && calls.filter((c) => c === "default").length === 3 && s.err?.statusCode === 503, `${w.name} stream: same retry shape (${calls.join(",")})`);
}

// ---- 5. the buyer's EVM authorization bounds every attempt -----------------
{
  ok(paymentWindowTimeoutMs(null, 90_000) === 90_000 && paymentWindowTimeoutMs({ header: () => undefined }, 90_000) === 90_000, "no EVM authorization: the per-attempt timeout is unchanged");
  const t = paymentWindowTimeoutMs(evmReq(66), 90_000);
  ok(t > 50_000 - PAYMENT_WINDOW_TAIL_MS - 2_000 && t <= 60_000 - PAYMENT_WINDOW_TAIL_MS, `a 66 s authorization (60 s settleable) cuts the timeout to fit (${t} ms)`);
  ok(paymentWindowTimeoutMs(evmReq(300), 90_000) === 90_000, "a stock 300 s authorization leaves the 90 s timeout alone");
  const shortReq = evmReq(6 + PAYMENT_WINDOW_MIN_START_MS / 1000 - 2);
  const first = paymentWindowTimeoutMs(shortReq, 90_000);
  ok(first > 0 && first < PAYMENT_WINDOW_MIN_START_MS, `a short window still lets the first attempt start (${first} ms)`);
  const { err } = await settle(async () => paymentWindowTimeoutMs(shortReq, 90_000));
  ok(err?.statusCode === 504 && /payment window/.test(err.message) && /not charged/.test(err.message), "a further attempt in a short window: a 504 that says it was not charged");
  const { err: none } = await settle(async () => paymentWindowTimeoutMs(evmReq(6 + PAYMENT_WINDOW_TAIL_MS / 1000 - 1), 90_000));
  ok(none?.statusCode === 504, "no usable window at all: a 504 before any attempt");
}
// A stream that has started is not cut short by a payment-window timeout.
{
  const { streamOpenRouterTo } = G;
  const enc = new TextEncoder();
  globalThis.fetch = async (url, init) => new Response(new ReadableStream({ async start(c) {
    // Like a real connection, an abort errors the body mid-read.
    init?.signal?.addEventListener("abort", () => { try { c.error(Object.assign(new Error("aborted"), { name: "AbortError" })); } catch {} });
    c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`));
    await new Promise((r) => setTimeout(r, 200));
    if (init?.signal?.aborted) return;
    c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "b" } }] })}\n\ndata: [DONE]\n\n`));
    c.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const res = fakeRes();
  const write0 = res.write; res.write = (chunk) => { res.__last = (res.__last || "") + String(chunk); return write0(chunk); };
  const { err } = await settle(() => streamOpenRouterTo({ model: "x/y", messages: [] }, res, { timeoutMs: 80 }));
  ok(!err && res.writableEnded && res.writes >= 2 && res.__last?.includes("b"), `a committed stream runs past a short pre-commit timeout to its end (writes ${res.writes}, ${err?.message || "ok"})`);
  globalThis.fetch = async (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const res2 = fakeRes();
  const { err: slow } = await settle(() => streamOpenRouterTo({ model: "x/y", messages: [] }, res2, { timeoutMs: 80 }));
  ok(slow && !res2.headersSent, "CONTROL: before the first frame the short timeout still applies, uncharged");
}
for (const w of wires) {
  {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(1); return w.okBody(JSON.parse(init.body)); };
    const { err } = await settle(() => w.run({ ...ONE }, evmReq(10)));
    ok(calls.length === 0 && err?.statusCode === 504, `${w.name}: an authorization with under 15 s of settleable life starts no attempt (504, ${calls.length} calls)`);
    const res = fakeRes(); calls.length = 0;
    const r = await w.run({ stream: true, ...ONE }, evmReq(10));
    const s = await settle(() => r.__sse(res));
    ok(calls.length === 0 && s.err?.statusCode === 504 && !res.headersSent, `${w.name} stream: the same, before any byte`);
  }
  {
    const rec = recordTimeouts(); const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(1); return w.okBody(JSON.parse(init.body)); };
    const { out, err } = await settle(() => w.run({ ...ONE }, evmReq(66)));
    rec.restore();
    ok(!err && out && rec.seen.some((ms) => ms < 60_000 && ms > 40_000) && !rec.seen.includes(90_000), `${w.name}: a 66 s authorization serves with the attempt timeout cut below 60 s (${rec.seen.join(",")})`);
  }
  {
    const rec = recordTimeouts();
    globalThis.fetch = async (url, init) => w.okBody(JSON.parse(init.body));
    const { err } = await settle(() => w.run({ ...ONE }));
    rec.restore();
    ok(!err && rec.seen.includes(90_000), `${w.name} control: with no EVM authorization the 90 s timeout is used`);
  }
  {
    const rec = recordTimeouts(); const res = fakeRes();
    globalThis.fetch = async () => ({ ok: true, status: 200, body: sseBody(w.frame) });
    const r = await w.run({ stream: true, ...ONE }, evmReq(66));
    const { err } = await settle(() => r.__sse(res));
    rec.restore();
    ok(!err && rec.seen[0] < 60_000 && rec.seen[0] > 40_000, `${w.name} stream: the wait for the first frame is cut below 60 s; once the answer started it runs to the usual limit (${rec.seen.join(",")})`);
  }
}
{
  const speech = tool("v1-audio-speech");
  const calls = [];
  globalThis.fetch = async () => { calls.push(1); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  const { err } = await settle(() => speech.handler({ input: "hello" }, evmReq(10)));
  ok(calls.length === 0 && err?.statusCode === 504, "speech: too little settleable life starts no attempt (504)");
  const rec = recordTimeouts();
  const a = await settle(() => speech.handler({ input: "hello" }, evmReq(66)));
  const cut = rec.seen.slice(); rec.seen.length = 0;
  const b = await settle(() => speech.handler({ input: "hello" }));
  rec.restore();
  ok(a.out?.__binary && cut.some((ms) => ms < 60_000 && ms > 40_000) && !cut.includes(60_000), `speech: a 66 s authorization cuts the 60 s timeout (${cut.join(",")})`);
  ok(b.out?.__binary && rec.seen.includes(60_000), "speech control: no EVM authorization keeps the 60 s timeout");
}

// ---- 4. unusable 200s ------------------------------------------------------
{
  for (const [label, body] of [["no choices", { id: "g" }], ["choices []", { id: "g", choices: [] }], ["choice without message", { id: "g", choices: [{ index: 0, finish_reason: "stop" }] }]]) {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body).service_tier || "default"); return { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
    const { err } = await settle(() => nano.handler({ ...ONE, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }));
    ok(err?.statusCode === 502 && calls.join(",") === "flex,default", `chat: ${label} is a walkable 502 (${calls.join(",")}, ${err?.statusCode})`);
  }
  globalThis.fetch = async (url, init) => chatOk(JSON.parse(init.body), "");
  const { out, err } = await settle(() => nano.handler({ ...ONE, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }));
  ok(!err && out?.choices?.[0]?.message?.content === "", "chat control: stop with empty content is still a 200 (a tool-loop end)");
}
{
  const run = makeMessagesHandler("v1-chat-nano");
  for (const [label, body] of [["no content", { id: "m", type: "message", stop_reason: "end_turn" }], ["content not an array", { id: "m", type: "message", content: "OK", stop_reason: "end_turn" }]]) {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(1); return { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
    const { err } = await settle(() => run({ ...ONE, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }));
    ok(err?.statusCode === 502 && calls.length === 2, `messages: ${label} is a walkable 502 (${calls.length} calls)`);
  }
  globalThis.fetch = async (url, init) => msgOk(JSON.parse(init.body), []);
  const { out, err } = await settle(() => run({ ...ONE, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }));
  ok(!err && Array.isArray(out?.content) && out.content.length === 0, "messages control: end_turn with an empty content array is still a 200");
}
{
  const run = makeResponsesHandler("v1-chat-nano");
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(1); return { ok: true, status: 200, text: async () => JSON.stringify({ id: "r", object: "response", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }) }; };
  const { err } = await settle(() => run({ ...ONE, input: "hi", max_output_tokens: 20 }));
  ok(err?.statusCode === 502 && /safety filter/.test(err.message) && calls.length === 1, `responses: an empty content_filter incomplete is the empty-refusal 502, and the same model is not paid twice (${calls.length} calls)`);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "r", object: "response", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] }) });
  const p = await settle(() => run({ ...ONE, input: "hi", max_output_tokens: 20 }));
  ok(!p.err && p.out?.status === "incomplete", "responses control: a content_filter incomplete that said something is returned as is");
}
{
  const emb = tool("v1-embeddings");
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }) });
  const { err } = await settle(() => emb.handler({ model: "text-embedding-3-small", input: "hi" }));
  ok(err?.statusCode === 502, `/v1/embeddings: an empty data array is a 502 (${err?.statusCode})`);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }) });
  const c = await settle(() => emb.handler({ model: "text-embedding-3-small", input: "hi" }));
  ok(!c.err && c.out?.data?.length === 1, "/v1/embeddings control: a vector is served");
}

// ---- 3 + 4. the direct OpenAI kits -----------------------------------------
const J = (o, status = 200) => async () => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const kits = [
  ["llm", () => LLM_TOOLS.find((t) => t.slug === "llm").handler({ messages: [{ role: "user", content: "hi" }] })],
  ["embed", () => EMBED_TOOLS[0].handler({ text: "hi" })],
  ["moderate", () => MODERATE_TOOLS[0].handler({ text: "hi" })],
  ["image-gen", () => IMAGE_GEN_TOOLS.find((t) => t.slug === "image-gen").handler({ prompt: "a boat" })],
];
for (const [name, call] of kits) {
  for (const code of ["billing_hard_limit_reached", "billing_not_active", "account_deactivated"]) {
    globalThis.fetch = J({ error: { code, message: `Account says ${code}`, type: "invalid_request_error" } }, 400);
    const { err } = await settle(call);
    ok(err?.statusCode === 502 && err.message === "OpenAI upstream unavailable", `${name}: OpenAI 400 ${code} is a 502 with no provider text (${err?.statusCode} ${err?.message})`);
  }
  globalThis.fetch = J({ error: { code: "invalid_value", message: "Invalid value for temperature", type: "invalid_request_error" } }, 400);
  const { err } = await settle(call);
  ok(err?.statusCode === 400 && /Invalid value/.test(err.message), `${name} control: a request-shaped 400 stays a self-explaining 400`);
}
{
  globalThis.fetch = J({ id: "c", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } });
  const a = await settle(kits[0][1]);
  ok(a.err?.statusCode === 502, `llm: no choice is a 502 (${a.err?.statusCode})`);
  globalThis.fetch = J({ id: "c", model: "gpt-4o-mini", choices: [{ message: { role: "assistant", content: null, refusal: "I can't help with that." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } });
  const b = await settle(kits[0][1]);
  ok(b.out?.choices?.[0]?.message?.refusal === "I can't help with that." && b.out.choices[0].message.content === "", "llm: a refusal with empty content is passed through as `refusal`");
  globalThis.fetch = J({ id: "c", model: "gpt-4o-mini", choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const c = await settle(kits[0][1]);
  ok(c.out?.choices?.[0]?.message?.content === "Hi" && !("refusal" in c.out.choices[0].message), "llm control: a normal answer has no refusal field");
}
{
  globalThis.fetch = J({ data: [], usage: { total_tokens: 1 } });
  const a = await settle(kits[1][1]);
  ok(a.err?.statusCode === 502, `embed: an empty embedding is a 502 (${a.err?.statusCode})`);
  globalThis.fetch = J({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { total_tokens: 1 } });
  const b = await settle(kits[1][1]);
  ok(b.out?.dimensions === 3 && b.out.embedding.length === 3, "embed control: a vector is served with its dimensions");
}
{
  globalThis.fetch = J({ data: [{}], usage: { output_tokens: 10 } });
  const a = await settle(kits[3][1]);
  ok(a.err?.statusCode === 502 && /no image/.test(a.err.message), `image-gen: a body with no b64_json is a 502 (${a.err?.statusCode})`);
  globalThis.fetch = J({ data: [{ b64_json: "iVBORw0KGgo=" }], usage: { output_tokens: 10 } });
  const b = await settle(kits[3][1]);
  ok(b.out?.image === "iVBORw0KGgo=", "image-gen control: an image is served");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
