#!/usr/bin/env node
// A streamed chat completion that ends with no answer (every frame reasoning,
// then a length or refusal ending) is a 502 before any byte, which no wire
// settles; a streamed answer with content is relayed as before.
//
// The chat wire holds the 200 until the first frame that carries an answer
// (`holdUntilAnswer` in streamOpenRouterTo). Part 1 drives the relay and the
// chat handler offline with a stubbed upstream: the empty endings, the bytes
// and the first-content timing of a stream with content against the relay
// without the hold, a stream cut after content, the credits meter put back.
// Part 2 boots a PAID server (scripts/lib/paid-wires-rig.js) and buys one
// empty stream and one stream with content on every wire the rig carries
// (x402 exact on Base, Solana, Algorand and Stellar, the MPP evm wire, a Tempo
// pull credential): the empty one is answered 502 with no settle attempted,
// the one with content 200 and settled once. A credits hold on an empty
// stream is returned (scripts/test-credits.js).
//
// Through the CDN proxy (a request with a synchronous deadline) a held stream
// commits once the window is down to its tail, so a long reasoning phase is
// delivered and charged as before the hold. Our own stream limit cutting a
// held stream is a timeout, not an empty answer. The Messages and Responses
// streams hold the same way, each with its own frame format.
//
//   node scripts/test-stream-empty-answer.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import { EventEmitter } from "node:events";
process.env.OPENROUTER_API_KEY = "test-key";
delete process.env.OPENROUTER_FLEX;

const K = await import("../src/tools/llm-gateway-kit.js");
const { streamOpenRouterTo, LLM_GATEWAY_TOOLS, EMPTY_LENGTH_MESSAGE, STREAM_DROPPED_FRAME, chatDeltaHasAnswer } = K;

let pass = 0, failed = 0, rig = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const settle = async (fn) => { try { return { out: await fn() }; } catch (e) { return { err: e }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const reasoning = (t) => frame({ id: "g", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: t, reasoning_details: [{ type: "reasoning.text", text: t }] } }] });
const content = (t) => frame({ id: "g", model: "m", choices: [{ index: 0, delta: { content: t } }] });
const finish = (r, native) => frame({ id: "g", model: "m", choices: [{ index: 0, delta: {}, finish_reason: r, ...(native ? { native_finish_reason: native } : {}) }] });
const usage = (cost = 0.01) => frame({ id: "g", model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 64, cost } });
const DONE = "data: [DONE]\n\n";
const EMPTY_LENGTH = [reasoning("Let me think"), reasoning(" about it"), finish("length"), usage(), DONE];
const WITH_CONTENT = [reasoning("Let me think"), reasoning(" about it"), content("The"), content(" answer"), finish("stop"), usage(), DONE];

// An upstream that sends `frames`, each after `gapMs` (or [ms, frame] pairs),
// and errors out instead of ending when `cut` is set.
const upstreamOf = (frames, { gapMs = 0, cut = false } = {}) => async (_b, { signal } = {}) => ({ ok: true, status: 200, body: (async function* () {
  for (const f of frames) {
    const [ms, text] = Array.isArray(f) ? f : [gapMs, f];
    if (ms) await sleep(ms);
    // Like a real connection, an abort errors the body mid-read.
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    yield new TextEncoder().encode(text);
  }
  if (cut) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
})() });
const fakeRes = (req = null) => {
  const res = new EventEmitter();
  Object.assign(res, { req, headersSent: false, destroyed: false, writableEnded: false, status: null, out: "", writes: [], t0: Date.now(),
    writeHead(s) { res.headersSent = true; res.status = s; }, flushHeaders() {},
    write(c) { res.writes.push({ at: Date.now() - res.t0, text: String(c) }); res.out += String(c); return true; }, end() { res.writableEnded = true; } });
  return res;
};
const relay = async (frames, opts = {}, hold = true, req = null, extra = {}) => {
  const res = fakeRes(req);
  const r = await settle(() => streamOpenRouterTo({ model: "fake/model", messages: [], stream: true }, res, { fetchUpstream: upstreamOf(frames, opts), timeoutMs: 5000, holdUntilAnswer: hold, ...extra }));
  return { res, err: r.err };
};
const { createMessagesAnswerWatch, EMPTY_MAX_TOKENS_MESSAGE, LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
const { createResponsesAnswerWatch, EMPTY_INCOMPLETE_MESSAGE, LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");
// Messages (Anthropic) and Responses (OpenAI) stream frames.
const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
const MSG = {
  empty: [ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }), ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }), ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } }), ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }), ev("content_block_stop", { index: 0 }), ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 64 } }), ev("message_stop", {})],
  content: [ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }), ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }), ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } }), ev("content_block_stop", { index: 0 }), ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }), ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "The answer" } }), ev("content_block_stop", { index: 1 }), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }), ev("message_stop", {})],
  refusal: [ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "m", content: [] } }), ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }), ev("message_delta", { delta: { stop_reason: "refusal" } }), ev("message_stop", {})],
  tool: [ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "m", content: [] } }), ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t", name: "f", input: {} } }), ev("message_delta", { delta: { stop_reason: "tool_use" } }), ev("message_stop", {})],
};
const RESP = {
  empty: [ev("response.created", { response: { id: "r", model: "m", status: "in_progress" } }), ev("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs" } }), ev("response.reasoning_summary_text.delta", { delta: "Let me think" }), ev("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs" } }), ev("response.incomplete", { response: { id: "r", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 64 } } })],
  content: [ev("response.created", { response: { id: "r", model: "m", status: "in_progress" } }), ev("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs" } }), ev("response.reasoning_summary_text.delta", { delta: "Let me think" }), ev("response.output_item.added", { output_index: 1, item: { type: "message", id: "mg", role: "assistant", content: [] } }), ev("response.content_part.added", { part: { type: "output_text", text: "" } }), ev("response.output_text.delta", { delta: "The answer" }), ev("response.completed", { response: { id: "r", model: "m", status: "completed", usage: { input_tokens: 3, output_tokens: 9 } } })],
  refusal: [ev("response.created", { response: { id: "r", model: "m", status: "in_progress" } }), ev("response.incomplete", { response: { id: "r", model: "m", status: "incomplete", incomplete_details: { reason: "content_filter" } } })],
  tool: [ev("response.created", { response: { id: "r", model: "m", status: "in_progress" } }), ev("response.output_item.added", { output_index: 0, item: { type: "function_call", name: "f", call_id: "c", arguments: "" } }), ev("response.completed", { response: { id: "r", model: "m", status: "completed" } })],
};

// ---- 1. the relay ---------------------------------------------------------------
ok(!chatDeltaHasAnswer({ role: "assistant", content: "", reasoning: "x", reasoning_details: [{}] }) && !chatDeltaHasAnswer({ content: "  \n" }) && chatDeltaHasAnswer({ content: "a" }) && chatDeltaHasAnswer({ tool_calls: [{ index: 0 }] }) && chatDeltaHasAnswer({ images: [{ type: "image_url" }] }) && !chatDeltaHasAnswer({ tool_calls: [] }), "an answer is text, a tool call or any other filled field; reasoning, a role and whitespace are not");
{
  const { res, err } = await relay(EMPTY_LENGTH);
  ok(err?.statusCode === 502 && err.message === EMPTY_LENGTH_MESSAGE && err.emptyAnswer === true && !res.headersSent && res.writes.length === 0, `all reasoning, then length: a 502 before any byte (${err?.statusCode} ${err?.message?.slice(0, 50)}, ${res.writes.length} writes)`);
  const ctl = await relay(EMPTY_LENGTH, {}, false);
  ok(!ctl.err && ctl.res.status === 200 && ctl.res.writableEnded, "CONTROL: without the hold the same stream is a committed 200 (the defect)");
}
{
  const { res, err } = await relay([reasoning("hmm"), finish("content_filter", "refusal"), DONE]);
  ok(err?.statusCode === 502 && /declined the request/.test(err.message) && !res.headersSent, `all reasoning, then a refusal: a 502 (${err?.message?.slice(0, 40)})`);
}
{
  const { res, err } = await relay([reasoning("hmm"), reasoning(" more")], { cut: true });
  ok(err?.statusCode === 502 && /before producing any content/.test(err.message) && !res.headersSent, `reasoning, then the upstream drops: a 502 before any byte (${err?.message})`);
  const ctl = await relay([reasoning("hmm"), reasoning(" more")], { cut: true }, false);
  ok(!ctl.err && ctl.res.status === 200 && ctl.res.out.endsWith(STREAM_DROPPED_FRAME), "CONTROL: without the hold it was a committed 200 ending in the dropped frame");
}
{
  const err1 = (await relay([reasoning("x"), frame({ error: { message: "provider error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }), DONE])).err;
  ok(err1?.statusCode === 502, "reasoning, then an error frame and no content: a 502");
  const err2 = (await relay([reasoning("x"), DONE])).err;
  ok(err2?.statusCode === 502, "reasoning, then [DONE] with no finish reason: a 502");
  const err3 = (await relay([DONE])).err;
  ok(err3?.statusCode === 502 && /any data frame \(no tokens\)/.test(err3.message), "a stream of [DONE] alone is the no-data-frame 502");
}
{
  // A plain stop with nothing said is served, as the buffered path serves it.
  const frames = [frame({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }), finish("stop"), DONE];
  const held = await relay(frames), plain = await relay(frames, {}, false);
  ok(!held.err && held.res.status === 200 && held.res.out === plain.res.out, "an empty plain stop is relayed as before (the buffered path serves it too)");
}
{
  // A stream with content: the same bytes, one 200.
  const held = await relay(WITH_CONTENT), plain = await relay(WITH_CONTENT, {}, false);
  ok(!held.err && held.res.status === 200 && held.res.writableEnded && held.res.out === plain.res.out && held.res.out.includes('"content":" answer"') && !held.res.out.includes('"cost"'), "a stream with content: the same bytes as without the hold, billing fields scrubbed");
  // A tool-call answer commits too.
  const tool = await relay([reasoning("x"), frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "" } }] } }] }), finish("tool_calls"), DONE]);
  ok(!tool.err && tool.res.status === 200, "a tool-call answer after reasoning is relayed");
}
{
  // First content token timing: reasoning for 300 ms, then content.
  const timed = [[0, reasoning("a")], [100, reasoning("b")], [100, reasoning("c")], [100, content("X")], [50, content("Y")], [0, finish("stop")], [0, DONE]];
  const firstContent = (res) => res.writes.find((w) => w.text.includes('"content":"X"'))?.at;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const h = await relay(timed, {}, true), p = await relay(timed, {}, false);
    runs.push([firstContent(h.res), firstContent(p.res)]);
  }
  const worst = Math.max(...runs.map(([h, p]) => h - p));
  ok(runs.every(([h, p]) => Number.isFinite(h) && Number.isFinite(p)) && worst <= 25, `the first content token leaves as fast as without the hold (held vs plain, ms: ${runs.map((r) => r.join("/")).join(", ")})`);
  console.log(`  first content token, ms after the stream opened (held/plain): ${runs.map((r) => r.join("/")).join(", ")}`);
}
{
  // Cut after content: unchanged (committed, ended with the dropped frame).
  const frames = [reasoning("x"), content("par"), content("tial")];
  const held = await relay(frames, { cut: true }), plain = await relay(frames, { cut: true }, false);
  ok(!held.err && held.res.status === 200 && held.res.out === plain.res.out && held.res.out.endsWith(STREAM_DROPPED_FRAME), "a stream cut after content: the same committed 200 and dropped frame as before");
}
{
  // Through the CDN: the synchronous window's tail is PAYMENT_WINDOW_TAIL_MS.
  // A window that leaves 300 ms before its tail, a reasoning phase of 1 s.
  const TAIL = K.PAYMENT_WINDOW_TAIL_MS;
  const long = [[0, reasoning("a")], ...[...Array(9)].map((_, i) => [100, reasoning("r" + i)]), [100, content("The")], [0, content(" answer")], [0, finish("stop")], [0, usage()], [0, DONE]];
  const cdnReq = () => ({ headers: {}, cdnSyncDeadlineMs: Date.now() + TAIL + 300 });
  const firstAt = (res) => res.writes[0]?.at;
  const held = await relay(long, {}, true, cdnReq());
  ok(!held.err && held.res.status === 200 && firstAt(held.res) >= 250 && firstAt(held.res) <= 500 && held.res.out.includes('"content":" answer"') && held.res.writableEnded, `CDN window: a 1 s reasoning phase commits at the window's tail (first byte at ${firstAt(held.res)} ms, window tail at 300 ms) and the answer is delivered`);
  console.log(`  CDN window: first byte at ${firstAt(held.res)} ms with the tail at 300 ms; reasoning phase 1000 ms`);
  // ...and charged once: the credits meter records the served stream's usage.
  const { setUpstreamCostsForTest } = await import("../src/upstream-costs.js");
  setUpstreamCostsForTest({ models: [["fake/", { prompt: 1, completion: 1 }]], meter: { markup: 1.2 } });
  const prevMeter = process.env.GATEWAY_METERED_BILLING;
  process.env.GATEWAY_METERED_BILLING = "on";
  const credReq = { ...cdnReq(), creditsSettled: true, creditsPriceUsd: 0.05 };
  const metered = await relay(long, {}, true, credReq);
  ok(!metered.err && metered.res.status === 200 && Number.isFinite(credReq.__meteredUsageUsd) && credReq.__meteredUsageUsd > 0, `CDN window: the committed stream is metered as a served answer (${credReq.__meteredUsageUsd})`);
  if (prevMeter === undefined) delete process.env.GATEWAY_METERED_BILLING; else process.env.GATEWAY_METERED_BILLING = prevMeter;
  // A quiet upstream: no frame arrives at the tail, the timer commits.
  const quiet = await relay([[0, reasoning("a")], [900, content("late")], [0, finish("stop")], [0, DONE]], {}, true, cdnReq());
  ok(!quiet.err && quiet.res.headersSent && firstAt(quiet.res) >= 250 && firstAt(quiet.res) <= 500, `CDN window: with no frame at the tail, the hold commits on its own timer (first byte at ${firstAt(quiet.res)} ms)`);
  // An empty answer that ends inside the window is still a 502.
  const inside = await relay([[0, reasoning("a")], [50, reasoning("b")], [0, finish("length")], [0, DONE]], {}, true, cdnReq());
  ok(inside.err?.statusCode === 502 && inside.err.emptyAnswer === true && !inside.res.headersSent, "CDN window: an empty answer that ends inside the window is still a 502 before any byte");
  // No CDN deadline: a long hold is not committed early.
  const direct = await relay(long, {}, true, { headers: {} });
  ok(!direct.err && firstAt(direct.res) >= 900, `no CDN deadline: the hold lasts to the first answer frame (first byte at ${firstAt(direct.res)} ms)`);
}
{
  // Our own stream limit cutting a held stream: a timeout, not an empty answer.
  const endless = [[0, reasoning("a")], ...[...Array(50)].map((_, i) => [20, reasoning("r" + i)])];
  const cut = await relay(endless, {}, true, null, { timeoutMs: 200, streamTimeoutMs: 300 });
  ok(cut.err?.statusCode === 502 && cut.err.upstreamTimeout === true && cut.err.emptyAnswer !== true && K.timedOutAttempt(cut.err, Date.now() - 300, 300), `our own stream limit on a held stream is a timeout (upstreamTimeout ${cut.err?.upstreamTimeout}, emptyAnswer ${cut.err?.emptyAnswer})`);
  const dropped = await relay([reasoning("a"), reasoning("b")], { cut: true });
  ok(dropped.err?.statusCode === 502 && dropped.err.emptyAnswer !== true && dropped.err.upstreamTimeout !== true, "a drop after the first frame is neither an empty answer nor a timeout");
}
{
  // The Messages and Responses streams.
  for (const [wire, factory, F, emptyMsg] of [["messages", createMessagesAnswerWatch, MSG, EMPTY_MAX_TOKENS_MESSAGE], ["responses", createResponsesAnswerWatch, RESP, EMPTY_INCOMPLETE_MESSAGE]]) {
    const e = await relay(F.empty, {}, factory);
    ok(e.err?.statusCode === 502 && e.err.message === emptyMsg && e.err.emptyAnswer === true && !e.res.headersSent, `${wire}: all thinking, then the cap: a 502 before any byte (${e.err?.message?.slice(0, 40)})`);
    const ctl = await relay(F.empty, {}, false);
    ok(!ctl.err && ctl.res.status === 200, `${wire} CONTROL: without the hold it was a committed 200`);
    const r = await relay(F.refusal, {}, factory);
    ok(r.err?.statusCode === 502 && /declined the request/.test(r.err.message), `${wire}: an empty refusal is a 502`);
    const held = await relay(F.content, {}, factory), plain = await relay(F.content, {}, false);
    ok(!held.err && held.res.status === 200 && held.res.out === plain.res.out && held.res.out.includes("The answer"), `${wire}: a stream with content is relayed byte for byte as before`);
    const tool = await relay(F.tool, {}, factory);
    ok(!tool.err && tool.res.status === 200, `${wire}: a tool call is an answer`);
  }
}
{
  // A credits stream's metered usage recorded by an empty attempt is put back.
  const { setUpstreamCostsForTest } = await import("../src/upstream-costs.js");
  setUpstreamCostsForTest({ models: [["fake/", { prompt: 1, completion: 1 }]], meter: { markup: 1.2 } });
  const prev = process.env.GATEWAY_METERED_BILLING;
  process.env.GATEWAY_METERED_BILLING = "on";
  const req = { creditsSettled: true, creditsPriceUsd: 0.05, headers: {} };
  const { err } = await relay(EMPTY_LENGTH, {}, true, req);
  ok(err?.statusCode === 502 && !("__meteredUsageUsd" in req), "an empty attempt leaves no metered usage on the request");
  req.__meteredUsageUsd = 0.004;
  await relay(EMPTY_LENGTH, {}, true, req);
  ok(req.__meteredUsageUsd === 0.004, "...and puts back what an earlier attempt recorded");
  const served = await relay(WITH_CONTENT, {}, true, req);
  ok(!served.err && Number.isFinite(req.__meteredUsageUsd) && req.__meteredUsageUsd !== 0.004, "a served stream records its own usage as before");
  if (prev === undefined) delete process.env.GATEWAY_METERED_BILLING; else process.env.GATEWAY_METERED_BILLING = prev;
}

// ---- 1b. the chat handler -----------------------------------------------------------
{
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const realFetch = globalThis.fetch;
  const calls = [];
  const run = async (framesFor, input = {}) => {
    calls.length = 0;
    globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push(`${b.model}@${b.service_tier || "default"}`); return upstreamOf(framesFor(b))(); };
    const res = fakeRes();
    const r = await settle(async () => (await nano.handler({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "hi" }], max_tokens: 20, stream: true, ...input })).__sse(res));
    return { res, err: r.err };
  };
  const one = await run(() => EMPTY_LENGTH, { model_fallback: false });
  ok(one.err?.statusCode === 502 && one.err.message === EMPTY_LENGTH_MESSAGE && !one.res.headersSent && calls.length === 1, `chat: an empty stream is a 502 before any byte, and the model's other attempt is skipped as on the buffered path (${calls.join(" > ")})`);
  const walk = await run((b) => (calls.length === 1 ? EMPTY_LENGTH : WITH_CONTENT));
  ok(!walk.err && walk.res.status === 200 && walk.res.out.includes('"content":" answer"') && calls.length === 2 && calls[0].split("@")[0] !== calls[1].split("@")[0], `chat: an empty stream walks to the next model, which serves (${calls.join(" > ")})`);
  const served = await run(() => WITH_CONTENT, { model_fallback: false });
  ok(!served.err && served.res.status === 200 && calls.length === 1, "chat: a stream with content is served by the first attempt");
  globalThis.fetch = realFetch;
}

{
  // The Messages and Responses handlers: an empty stream is a 502 before any
  // byte and skips the model's other attempt; one with content is served.
  const realFetch = globalThis.fetch;
  for (const [wire, tool, input, F, emptyMsg] of [
    ["messages", LLM_MESSAGES_TOOLS.find((t) => t.slug === "v1-chat-nano-messages"), { messages: [{ role: "user", content: "hi" }], max_tokens: 20 }, MSG, EMPTY_MAX_TOKENS_MESSAGE],
    ["responses", LLM_RESPONSES_TOOLS.find((t) => t.slug === "v1-chat-nano-responses"), { input: "hi", max_output_tokens: 20 }, RESP, EMPTY_INCOMPLETE_MESSAGE],
  ]) {
    const calls = [];
    const run = async (framesFor, extra = {}) => {
      calls.length = 0;
      globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push(`${b.model}@${b.service_tier || "default"}`); return upstreamOf(framesFor(b))(); };
      const res = fakeRes();
      const r = await settle(async () => (await tool.handler({ model: "openai/gpt-6-luna", stream: true, ...input, ...extra })).__sse(res));
      return { res, err: r.err };
    };
    const one = await run(() => F.empty, { model_fallback: false });
    ok(one.err?.statusCode === 502 && one.err.message === emptyMsg && !one.res.headersSent && calls.length === 1, `${wire} handler: an empty stream is a 502 before any byte, the model's other attempt skipped (${calls.join(" > ")})`);
    const walk = await run(() => (calls.length === 1 ? F.empty : F.content));
    ok(!walk.err && walk.res.status === 200 && walk.res.out.includes("The answer") && calls.length === 2, `${wire} handler: an empty stream walks to the next model, which serves (${calls.join(" > ")})`);
  }
  globalThis.fetch = realFetch;
}

// ---- 2. every wire of a booted paid server ------------------------------------------
{
  const { bootPaidWires, WIRES } = await import("./lib/paid-wires-rig.js");
  rig = await bootPaidWires({ label: "stream-empty-answer" });
  const ROUTES = [
    ["chat", { method: "POST", path: "/v1/chat/completions", body: { model: "openai/gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true, model_fallback: false } }, EMPTY_LENGTH, WITH_CONTENT, '"content":" answer"'],
    ["messages", { method: "POST", path: "/v1/messages", body: { model: "openai/gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true, model_fallback: false } }, MSG.empty, MSG.content, "The answer"],
    ["responses", { method: "POST", path: "/v1/responses", body: { model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64, stream: true, model_fallback: false } }, RESP.empty, RESP.content, "The answer"],
  ];
  try {
    for (const [route, ROUTE, emptyFrames, contentFrames, mark] of ROUTES) {
      for (const wire of WIRES) {
        const w = await rig.wallet(wire);
        const price = await rig.priceOf(w, ROUTE);
        rig.fund(w, price * 10n);
        const before = rig.accounts.get(w.id)?.balance;
        rig.st.llmStreamFrames = () => emptyFrames;
        const c0 = rig.st.completions;
        const empty = await rig.pay(w, ROUTE);
        const o1 = rig.outcomesOf(w);
        ok(empty.status === 502 && rig.st.completions > c0 && !empty.text.includes("data:") && o1.attempts === 0 && rig.accounts.get(w.id)?.balance === before, `${route} on ${wire}: an empty streamed answer is answered ${empty.status}, never settled (settle ${JSON.stringify(o1)})`);
        rig.st.llmStreamFrames = () => contentFrames;
        const good = await rig.pay(w, ROUTE);
        const o2 = rig.outcomesOf(w);
        ok(good.status === 200 && good.text.includes(mark) && o2.settled === 1 && rig.accounts.get(w.id)?.balance === before - price, `${route} on ${wire}: a streamed answer with content is 200 and settled once (settle ${JSON.stringify(o2)})`);
      }
    }
  } catch (e) { ok(false, `paid wires: ${e?.stack || e}`); for (const l of rig.log().split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); }
  finally { await rig.stop(); }
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
