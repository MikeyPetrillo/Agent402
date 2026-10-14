#!/usr/bin/env node
// llm-context kit - offline tests with a stubbed globalThis.fetch.
//
//   node scripts/test-llm-context-kit.js
//
// This tool spends the Brave subscription on every call, so the test suite for
// it must never make a real one: the fixture below is shaped like the live
// response (verified 2026-08-22 against api.search.brave.com/res/v1/llm/context
// with our own key), and every assertion here runs against the stub.
//
// What it pins:
//   1. validation 400s happen with ZERO egress (the stub counts calls)
//   2. the documented request shape - endpoint, parameter NAMES, auth header
//   3. output normalization on a real-shaped payload
//   4. markUntrusted is stamped (chunks are third-party web text)
//   5. error mapping: 429/401/403 -> 503, 5xx -> 502, other non-2xx -> 502,
//      a deadline or transport failure -> 503 naming the step, malformed body -> 502, oversized body -> 502, and no
//      upstream body text ever reaches the caller
//   6. no key -> 503 BEFORE any fetch
import { LLM_CONTEXT_TOOLS, __test } from "../src/tools/llm-context-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const tool = LLM_CONTEXT_TOOLS.find((t) => t.slug === "llm-context");
const handler = tool.handler;
const realFetch = globalThis.fetch;
const realKey = process.env.BRAVE_API_KEY;

// --- fetch stub -----------------------------------------------------------
let calls = [];
function stubFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
}
const jsonResponse = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// A live-shaped payload. Two source URLs, one with two snippets, one with a
// blank snippet and a non-string entry (both must be dropped), plus a title
// that only exists in `sources` (the normalizer must fall back to it).
const FIXTURE = {
  grounding: {
    generic: [
      {
        url: "https://www.x402.org/",
        title: "x402: An open standard for internet-native payments",
        snippets: [
          "x402 revives the HTTP 402 Payment Required status code so a server can quote a price.",
          "A client pays per request and retries with a payment header.",
        ],
      },
      {
        url: "https://example.com/rag",
        snippets: ["   ", 42, "Grounding context is returned as extracted passages, not links."],
      },
    ],
    map: [],
  },
  sources: {
    "https://www.x402.org/": { title: "x402", hostname: "www.x402.org", age: [] },
    "https://example.com/rag": { title: "RAG basics", hostname: "example.com", age: [] },
  },
};

// --- 1. shape of the tool object -----------------------------------------
ok(tool.route === "POST /api/llm-context", `route is POST /api/llm-context (${tool.route})`);
ok(tool.price === "$0.02", `price is $0.02 (${tool.price})`);
ok(/untrusted/i.test(tool.description), "description documents the untrusted-content policy");
ok(/data to analyze|DATA to analyze/.test(tool.description), "description says the chunks are data, never instructions");
ok(tool.discovery?.output?.example?.untrustedContent === true, "output example carries untrustedContent");
ok(tool.discovery?.bodyType === "json", "declares a JSON body");

// --- 2. validation 400s, with ZERO egress --------------------------------
process.env.BRAVE_API_KEY = "test-key-llm-context";
stubFetch(() => { throw new Error("validation must never reach the network"); });
for (const [args, label] of [
  [{}, "missing query"],
  [{ query: "   " }, "blank query"],
  [{ query: 42 }, "non-string query"],
  [{ query: "x".repeat(401) }, "query over 400 chars"],
  [{ query: Array.from({ length: 51 }, (_, n) => `w${n}`).join(" ") }, "query over 50 words"],
  [{ query: "ok", maxTokens: 1023 }, "maxTokens under 1024"],
  [{ query: "ok", maxTokens: 32769 }, "maxTokens over 32768"],
  [{ query: "ok", maxTokens: 2048.5 }, "non-integer maxTokens"],
  [{ query: "ok", maxTokens: "lots" }, "non-numeric maxTokens"],
  [{ query: "ok", country: "usa" }, "3-letter country"],
  [{ query: "ok", lang: "e" }, "1-char lang"],
  [{ query: "ok", safesearch: "medium" }, "unknown safesearch value"],
  [{ query: "ok", freshness: "p7" }, "unknown freshness code"],
  [{ query: "ok", freshness: "2026-13-40to2026-12-31" }, "freshness range with an unreal date"],
  [{ query: "ok", freshness: "2026-08-31to2026-08-01" }, "freshness range that ends before it starts"],
]) {
  try { await handler(args); ok(false, `rejects ${label}`); }
  catch (e) { ok(e.statusCode === 400, `rejects ${label} with 400 (got ${e.statusCode}: ${e.message})`); }
}
ok(calls.length === 0, `validation made ZERO upstream calls (${calls.length})`);

// --- 3. the documented request shape -------------------------------------
{
  stubFetch(() => jsonResponse(FIXTURE));
  await handler({ query: "  x402 payment protocol  ", maxTokens: 2048, country: "US", lang: "EN-GB", safesearch: "strict", freshness: "pw" });
  ok(calls.length === 1, `one upstream call per handler call (${calls.length})`);
  const u = new URL(calls[0].url);
  ok(u.origin + u.pathname === "https://api.search.brave.com/res/v1/llm/context", `hits the documented endpoint (${u.origin + u.pathname})`);
  ok(u.searchParams.get("q") === "x402 payment protocol", "sends the TRIMMED query as q");
  ok(u.searchParams.get("maximum_number_of_tokens") === "2048", "sends maximum_number_of_tokens");
  ok(u.searchParams.get("country") === "us", "sends country lowercased");
  ok(u.searchParams.get("search_lang") === "en-gb", "sends the language as search_lang");
  ok(u.searchParams.get("safesearch") === "strict", "sends safesearch");
  ok(u.searchParams.get("freshness") === "pw", "sends freshness");
  const headers = new Headers(calls[0].init.headers);
  ok(headers.get("x-subscription-token") === "test-key-llm-context", "authenticates with X-Subscription-Token");
  ok(!/authorization/i.test(JSON.stringify(calls[0].init.headers)), "does not send an Authorization header");
  ok(calls[0].init.signal instanceof AbortSignal, "rides an abort signal (timeout budget)");
}

// Optional parameters are OMITTED when not supplied - never sent empty.
{
  stubFetch(() => jsonResponse(FIXTURE));
  await handler({ query: "hello world" });
  const u = new URL(calls[0].url);
  ok(u.searchParams.get("maximum_number_of_tokens") === "4096", "maxTokens defaults to 4096");
  for (const p of ["country", "search_lang", "safesearch", "freshness"]) {
    ok(!u.searchParams.has(p), `omits "${p}" when the caller did not set it`);
  }
  ok(!u.searchParams.has("enable_local") && !u.searchParams.has("goggles"),
    "sends no goggles and no local-recall switch (not part of this tool's contract)");
}

// A documented custom freshness range passes validation and rides through.
{
  stubFetch(() => jsonResponse(FIXTURE));
  await handler({ query: "hello world", freshness: "2026-04-01to2026-07-30" });
  ok(new URL(calls[0].url).searchParams.get("freshness") === "2026-04-01to2026-07-30",
    "accepts the documented YYYY-MM-DDtoYYYY-MM-DD range");
}

// --- 4. output normalization ---------------------------------------------
{
  stubFetch(() => jsonResponse(FIXTURE));
  const out = await handler({ query: "x402 payment protocol" });
  ok(out.query === "x402 payment protocol", "echoes the normalized query");
  ok(out.untrustedContent === true, "stamps untrustedContent on the payload");
  ok(Array.isArray(out.chunks) && out.chunks.length === 3, `flattens snippets into chunks (${out.chunks.length})`);
  ok(out.totalChunks === 3, `totalChunks matches (${out.totalChunks})`);
  ok(out.chunks.every((c) => typeof c.text === "string" && c.text.trim() === c.text), "chunk text is trimmed and non-empty");
  ok(out.chunks[0].url === "https://www.x402.org/", "chunk carries its source URL");
  ok(out.chunks[0].title === "x402: An open standard for internet-native payments", "chunk carries the entry title");
  ok(out.chunks[2].title === "RAG basics", "falls back to the sources[] title when the entry has none");
  ok(out.chunks.every((c) => Number.isInteger(c.tokensApprox) && c.tokensApprox > 0), "every chunk carries a positive tokensApprox");
  ok(out.tokensApprox === out.chunks.reduce((n, c) => n + c.tokensApprox, 0), "tokensApprox is the sum over chunks");
  ok(out.truncated === false, "truncated is false when nothing was cut");
  ok(out.source === "brave-llm-context", `source names the upstream (${out.source})`);
  ok(!Number.isNaN(Date.parse(out.fetchedAt)), `fetchedAt is an ISO timestamp (${out.fetchedAt})`);
  ok(JSON.stringify(out).indexOf('"   "') === -1, "blank and non-string snippets are dropped");
  // Every key the discovery example documents must exist on a real answer -
  // the "answers its own example" rule, checked here without egress.
  for (const k of Object.keys(tool.discovery.output.example)) {
    ok(k in out, `documented output key "${k}" is present`);
  }
}

// An empty grounding array is a normal answer, not an error (Brave's own
// guidance: handle empty grounding.generic gracefully).
{
  stubFetch(() => jsonResponse({ grounding: { generic: [] }, sources: {} }));
  const out = await handler({ query: "a query with no matches at all" });
  ok(out.totalChunks === 0 && out.chunks.length === 0, "empty grounding returns zero chunks, not an error");
  ok(out.untrustedContent === true, "empty answer is still marked untrusted");
}

// Junk upstream shapes must not throw - they normalize to an empty answer.
{
  for (const junk of [{}, { grounding: null }, { grounding: { generic: "nope" } }, { grounding: { generic: [null, 7] } }]) {
    stubFetch(() => jsonResponse(junk));
    const out = await handler({ query: "junk shape probe" });
    ok(out.totalChunks === 0, `unexpected upstream shape normalizes to 0 chunks (${JSON.stringify(junk).slice(0, 40)})`);
  }
}

// Caps: a huge snippet is cut, and truncated is reported honestly.
{
  const huge = { grounding: { generic: [{ url: "https://e.com/x", title: "T", snippets: ["z".repeat(__test.MAX_CHUNK_CHARS + 5000)] }] }, sources: {} };
  stubFetch(() => jsonResponse(huge));
  const out = await handler({ query: "huge snippet probe" });
  ok(out.chunks[0].text.length === __test.MAX_CHUNK_CHARS, `over-long chunk is cut at ${__test.MAX_CHUNK_CHARS} chars (${out.chunks[0].text.length})`);
  ok(out.truncated === true, "truncated is reported when a chunk was cut");
}
{
  const many = {
    grounding: { generic: [{ url: "https://e.com/x", title: "T", snippets: Array.from({ length: __test.MAX_CHUNKS + 50 }, (_, n) => `snippet ${n}`) }] },
    sources: {},
  };
  stubFetch(() => jsonResponse(many));
  const out = await handler({ query: "many chunks probe" });
  ok(out.chunks.length === __test.MAX_CHUNKS, `chunk count is capped at ${__test.MAX_CHUNKS} (${out.chunks.length})`);
  ok(out.truncated === true, "truncated is reported when chunks were dropped");
}

// --- 5. error mapping. No upstream body text may ever reach the caller. ---
const SECRET = "UPSTREAM-BODY-DO-NOT-RELAY";
async function expectError(responder, wantStatus, label, extra) {
  stubFetch(responder);
  try {
    await handler({ query: "error mapping probe" });
    ok(false, `${label} -> ${wantStatus}`);
  } catch (e) {
    ok(e.statusCode === wantStatus, `${label} -> ${wantStatus} (got ${e.statusCode}: ${e.message})`);
    ok(!e.message.includes(SECRET), `${label} does not relay the upstream body`);
    if (extra) ok(extra(e), `${label}: ${extra.label || "message check"}`);
  }
}
await expectError(() => jsonResponse(SECRET, 429), 503, "429 rate limit",
  Object.assign((e) => /retry/i.test(e.message), { label: "carries a retry hint" }));
await expectError(() => jsonResponse(SECRET, 401), 503, "401 unauthorized",
  Object.assign((e) => /not configured/i.test(e.message), { label: 'reads as "not configured"' }));
await expectError(() => jsonResponse(SECRET, 403), 503, "403 forbidden",
  Object.assign((e) => /not configured/i.test(e.message), { label: 'reads as "not configured"' }));
await expectError(() => jsonResponse(SECRET, 500), 502, "500 upstream error");
await expectError(() => jsonResponse(SECRET, 503), 502, "503 upstream error");
await expectError(() => jsonResponse(SECRET, 422), 502, "422 upstream rejection");
await expectError(() => jsonResponse(`not json ${SECRET}`, 200), 502, "malformed 200 body");
await expectError(() => { const e = new Error("The operation was aborted"); e.name = "TimeoutError"; throw e; }, 503, "upstream deadline (503 naming the upstream and the step)");
await expectError(() => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }, 503, "transport failure (503 unreachable)");
// Oversized body: bigger than the 4 MB cap, streamed through the reader.
await expectError(() => jsonResponse(JSON.stringify({ pad: "y".repeat(5 * 1024 * 1024) })), 502, "oversized upstream body");

// --- 6. no key -> 503 BEFORE any fetch -----------------------------------
{
  delete process.env.BRAVE_API_KEY;
  stubFetch(() => { throw new Error("must not fetch without a key"); });
  try {
    await handler({ query: "unconfigured probe" });
    ok(false, "no key -> 503");
  } catch (e) {
    ok(e.statusCode === 503, `no key -> 503 (got ${e.statusCode})`);
    ok(/not configured/i.test(e.message), "no-key error says the deployment is not configured");
  }
  ok(calls.length === 0, `no-key path made ZERO upstream calls (${calls.length})`);
}

globalThis.fetch = realFetch;
if (realKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = realKey;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
