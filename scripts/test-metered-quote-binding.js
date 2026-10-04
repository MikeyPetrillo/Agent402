#!/usr/bin/env node
// The metered gateway's quote must be computed from the SAME object the handler
// is served (src/handler-input.js), and the handler must refuse a body whose
// quote exceeds the price it was gated at.
//
// Found in the 2026-08-26 security review: the quote read `req.body` while the
// dispatcher served `{...req.query, ...req.body}` with params/input/args
// envelopes unwrapped. `{input:{model:"anthropic/claude-opus-5", ...}}` quoted
// the $0.001 floor (the quoter saw no model) and was then served in full.
// Offline: fetch is stubbed and must never be reached on the refused path.
process.env.OPENROUTER_API_KEY ||= "test-key-never-used";
const { handlerInputOf } = await import("../src/handler-input.js");
const { meteredQuoteUsd, LLM_GATEWAY_TOOLS, TIERS } = await import("../src/tools/llm-gateway-kit.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-metered-quote-binding");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const big = "x ".repeat(40_000); // ~80k chars of prompt
const flat = { model: "anthropic/claude-opus-5", messages: [{ role: "user", content: big }], max_tokens: 8192 };
const floor = TIERS["v1-chat-metered"].price;

// 1. handlerInputOf: query merged, envelopes unwrapped, top-level wins, memoized
const req1 = { query: { max_tokens: "8192" }, body: { input: { model: flat.model, messages: flat.messages } } };
const in1 = handlerInputOf(req1);
ok(in1.model === flat.model && Array.isArray(in1.messages) && in1.max_tokens === "8192", "handlerInputOf merges the query string and unwraps an {input:{...}} envelope");
ok(handlerInputOf(req1) === in1, "handlerInputOf is memoized on the request (one construction for every rail and the dispatcher)");
ok(handlerInputOf({ body: { model: "a", params: { model: "b" } } }).model === "a", "top-level fields win over an envelope");
ok(handlerInputOf({ body: { args: { model: "c" } } }).model === "c" && handlerInputOf({ body: { params: { model: "d" } } }).model === "d", "params and args envelopes unwrap too");
ok(Object.keys(handlerInputOf({})).length === 0 && Object.keys(handlerInputOf(null)).length === 0, "no body, no query -> empty input, never a throw");

// 2. the quote of a wrapped body equals the quote of the flat body, never the floor
const qFlat = meteredQuoteUsd(flat);
ok(!qFlat.invalid && qFlat.usd > floor * 10, "the flat Opus body quotes well above the floor");
const qRaw = meteredQuoteUsd({ input: flat });
ok(qRaw.invalid && qRaw.usd === floor, "the RAW wrapped body is unreadable to the quoter (this is the hole: it quotes the floor)");
const qServed = meteredQuoteUsd(handlerInputOf({ body: { input: flat } }));
ok(!qServed.invalid && qServed.usd === qFlat.usd, "quoting handlerInputOf(req) prices the wrapped body exactly like the flat body");
const qQuery = meteredQuoteUsd(handlerInputOf({ query: { model: flat.model, max_tokens: "8192" }, body: { messages: flat.messages } }));
ok(!qQuery.invalid && qQuery.usd === qFlat.usd, "a model/max_tokens smuggled through the query string is priced too");

// 3. the handler belt: a stashed quote below the served body's quote -> 400 before any upstream call
const metered = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered");
ok(!!metered, "found the v1-chat-metered tool");
let fetched = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetched++; throw new Error("SENTINEL upstream reached"); };
try {
  let err = null;
  try { await metered.handler(handlerInputOf({ body: { input: flat } }), { __meteredQuoteUsd: floor, headers: {}, ip: "127.0.0.1", get: () => undefined, header: () => undefined }); } catch (e) { err = e; }
  ok(err && err.statusCode === 400 && /quoted at \$0\.001 but/.test(err.message), "belt: a body quoting above the gated price is refused 400");
  ok(fetched === 0, "belt fires BEFORE any upstream call - nothing spent, nothing charged");
  err = null;
  try { await metered.handler(flat, { __meteredQuoteUsd: qFlat.usd, headers: {}, ip: "127.0.0.1", get: () => undefined, header: () => undefined }); } catch (e) { err = e; }
  ok(err && /SENTINEL|upstream|502|503/.test(String(err.message)) && err.statusCode !== 400, `belt: a body quoting at the gated price passes through to upstream (${err?.message?.slice(0, 60)})`);
  err = null;
  try { await metered.handler(flat, { headers: {}, ip: "127.0.0.1", get: () => undefined, header: () => undefined }); } catch (e) { err = e; }
  ok(err && err.statusCode !== 400, "belt: with no stashed quote (free mode / no gate ran) the handler does not refuse");
} finally { globalThis.fetch = realFetch; }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
