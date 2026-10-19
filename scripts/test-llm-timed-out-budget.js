// Timed-out attempt budget (timedOutBudget in src/tools/llm-gateway-kit.js)
// across every LLM wire. An attempt our own timer ended may have generated, and
// been billed, upstream; after LLM_MAX_TIMED_OUT_ATTEMPTS (default 2) of them a
// chain walk ends instead of starting another. Pins, through the handlers:
//   - chat, Messages and Responses, plain and streamed;
//   - a stream that sent only keep-alives until its first-frame deadline (the
//     502 streamOpenRouterTo throws, marked upstreamTimeout) counts;
//   - a 504 with no timeout mark counts when it ran out nearly the whole
//     timeout (the elapsed rule), and not when it failed fast;
//   - provider errors with no timeout still walk the whole chain.
// Offline: stub fetch, no network, no keys.
//
//   node scripts/test-llm-timed-out-budget.js
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.OPENROUTER_API_KEY = "test-key";
const { LLM_GATEWAY_TOOLS, UPSTREAM_TIMEOUT_MS, timedOutAttempt } = await import("../src/tools/llm-gateway-kit.js");
const { LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
const { LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-llm-timed-out-budget");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const WIRES = [
  { name: "chat", tool: LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano"), input: (extra) => ({ model: "mistralai/ministral-8b-2512", messages: [{ role: "user", content: "hi" }], max_tokens: 5, ...extra }) },
  { name: "Messages", tool: LLM_MESSAGES_TOOLS.find((t) => t.slug === "v1-chat-nano-messages"), input: (extra) => ({ model: "google/gemini-3.1-flash-lite", max_tokens: 32, messages: [{ role: "user", content: "hi" }], ...extra }) },
  { name: "Responses", tool: LLM_RESPONSES_TOOLS.find((t) => t.slug === "v1-chat-nano-responses"), input: (extra) => ({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64, ...extra }) },
];
for (const w of WIRES) ok(!!w.tool, `${w.name}: nano tool found`);

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

const fakeRes = () => {
  const r = {
    headersSent: false, chunks: [], ended: false, listeners: {},
    writeHead(status, headers) { r.headersSent = true; r.status = status; r.headers = headers; },
    flushHeaders() {}, write(c) { r.chunks.push(String(c)); }, end() { r.ended = true; },
    on(ev, cb) { r.listeners[ev] = cb; }, once(ev, cb) { r.listeners[ev] = cb; }, off() {},
  };
  return r;
};

async function run(w, { stream }) {
  let err = null;
  try {
    const out = await w.tool.handler(w.input(stream ? { stream: true } : {}));
    if (stream) await out.__sse(fakeRes());
  } catch (e) { err = e; }
  return err;
}

// Count upstream attempts under a fetch stub, once with the default budget and
// once with a budget too large to bind, so each assertion compares the walk
// with and without the budget on the same chain.
async function attempts(w, { stream, fetchImpl }) {
  let n = 0;
  globalThis.fetch = async (url, init = {}) => { n++; return fetchImpl(url, init); };
  const err = await run(w, { stream });
  return { n, err };
}
async function budgeted(w, opts) {
  const a = await attempts(w, opts);
  process.env.LLM_MAX_TIMED_OUT_ATTEMPTS = "99";
  const b = await attempts(w, opts);
  delete process.env.LLM_MAX_TIMED_OUT_ATTEMPTS;
  return { capped: a, uncapped: b };
}

const timeoutError = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; return e; };

// ---- plain calls: a connect/read timeout (TimeoutError -> 504 upstreamTimeout) ----
for (const w of WIRES) {
  const { capped, uncapped } = await budgeted(w, { stream: false, fetchImpl: async () => { throw timeoutError(); } });
  ok(uncapped.n > 2, `${w.name} plain: without a binding budget the chain has more than two attempts (${uncapped.n})`);
  ok(capped.n === 2 && capped.err?.statusCode === 504, `${w.name} plain: two timed-out attempts end the walk with a 504 (attempts ${capped.n}, ${capped.err?.statusCode})`);
}

// ---- streams: keep-alives only until the first-frame deadline ----
// The first-frame deadline is STREAM_TIMEOUT_MS (minutes); shrink only the long
// timers so it fires at once. Elapsed time then stays tiny, so only the
// upstreamTimeout mark on the 502 can count these attempts.
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 60_000 ? 20 : ms, ...a);
const keepAliveOnly = async (url, init) => ({
  ok: true, status: 200, headers: { get: () => "text/event-stream" },
  body: {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(": OPENROUTER PROCESSING\n\n");
      await new Promise((resolve) => {
        if (init.signal?.aborted) return resolve();
        init.signal?.addEventListener("abort", resolve, { once: true });
      });
      const e = new Error("This operation was aborted"); e.name = "AbortError"; throw e;
    },
  },
});
for (const w of WIRES) {
  const { capped, uncapped } = await budgeted(w, { stream: true, fetchImpl: keepAliveOnly });
  ok(uncapped.n > 2 && uncapped.err?.statusCode === 502, `${w.name} stream: without a binding budget the chain has more than two attempts (${uncapped.n})`);
  ok(capped.n === 2 && capped.err?.statusCode === 502 && capped.err?.upstreamTimeout === true, `${w.name} stream: two first-frame timeouts end the walk (attempts ${capped.n}, mark ${capped.err?.upstreamTimeout})`);
}
// A stream the provider ends early (no timer fired) is not a timed-out attempt.
{
  const w = WIRES[0];
  const closesEarly = async () => ({ ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(": OPENROUTER PROCESSING\n\n"); } } });
  const { n, err } = await attempts(w, { stream: true, fetchImpl: closesEarly });
  ok(n > 2 && err?.statusCode === 502 && !err?.upstreamTimeout, `stream that closes with no data before any deadline walks the whole chain (attempts ${n})`);
}
globalThis.setTimeout = realSetTimeout;

// ---- the elapsed rule: an unmarked 504 that ran out the timeout counts ----
{
  ok(timedOutAttempt({ statusCode: 504 }, 0, 1000, 950) === true && timedOutAttempt({ statusCode: 504 }, 0, 1000, 900) === false, "elapsed rule: a 504 counts from 95% of the timeout");
  ok(timedOutAttempt({ statusCode: 502 }, 0, 1000, 5000) === false, "elapsed rule: an unmarked 502 never counts, however long it took");
  ok(timedOutAttempt({ statusCode: 502, upstreamTimeout: true }, 0, 1000, 1) === true, "a marked attempt counts at once");
  const w = WIRES[0];
  let offset = 0;
  Date.now = () => realNow() + offset;
  // A network failure (504, no mark) after the whole timeout elapsed.
  const slowFail = async () => { offset += UPSTREAM_TIMEOUT_MS; throw new TypeError("fetch failed"); };
  const slow = await budgeted(w, { stream: false, fetchImpl: slowFail });
  ok(slow.uncapped.n > 2, `elapsed rule: without a binding budget the chain has more than two attempts (${slow.uncapped.n})`);
  ok(slow.capped.n === 2 && slow.capped.err?.statusCode === 504 && !slow.capped.err?.upstreamTimeout, `elapsed rule: two unmarked 504s that ran out the timeout end the walk (attempts ${slow.capped.n})`);
  const fast = await attempts(w, { stream: false, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  ok(fast.n > 2, `elapsed rule: a 504 that failed fast does not count (attempts ${fast.n})`);
  Date.now = realNow;
}

// ---- provider errors (no generation) walk the whole chain ----
for (const w of WIRES) {
  const { n, err } = await attempts(w, { stream: false, fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => null }, text: async () => "{}" }) });
  ok(n > 2 && err?.statusCode === 502, `${w.name}: provider 502s still walk the whole chain (attempts ${n})`);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
