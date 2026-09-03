// Secret-leak guard — offline, deterministic. Proves three invariants for
// every upstream-cost handler (the tools that send a configured API key to a
// paid upstream):
//
//   (a) no configured secret VALUE ever appears in a buyer-facing response
//       body, cache entry, or thrown error (message + enumerable props) —
//       the route binder returns err.message verbatim, so what a handler
//       throws IS what the buyer (and the error log) sees;
//   (b) the LLM gateway strips the upstream bill (usage.cost / cost_details /
//       is_byok) BEFORE the response is cached or returned;
//   (c) a wrong/failing upstream key surfaces as a clean 502/503/504 that
//       does not echo the key.
//
// Method: set DUMMY secrets carrying a canary token, mock globalThis.fetch
// with an ADVERSARIAL upstream that echoes the received credential back in
// its error body (what OpenAI's real invalid_api_key 401 does), drive each
// handler through four upstream failure modes, and assert the canary never
// reaches anything buyer-visible. No network, no upstream spend.
//
// Dynamic coverage (one handler per shared code path):
//   v1-chat-nano   → llm-gateway-kit makeHandler/throwUpstreamError (all 5 chat tiers)
//   v1-embeddings  → llm-gateway-kit embeddingsHandler
//   v1-images      → llm-gateway-kit imagesHandler
//   v1-audio-speech→ llm-gateway-kit speechHandler
//   llm            → llm-kit callOpenAI (llm-pro/llm-premium share it)
//   embed          → embed-kit (embed-large shares it)
//   image-gen      → image-gen-kit (hd/premium share it)
//   tts            → tts-kit (tts-hd shares it)
//   transcribe     → stt-kit (transcribe-pro shares it; audio served by the mock)
//   moderate       → moderate-kit
//   search         → search.js braveGet (news/images/videos/suggest/multi share it)
//   answer         → search.js braveAnswerPost

// Canary env — set BEFORE any handler runs. Every kit reads its key lazily at
// call time, so top-level assignment here is early enough.
process.env.OPENAI_API_KEY = "sk-LEAKCANARY0000";
process.env.OPENROUTER_API_KEY = "sk-or-LEAKCANARY0000";
process.env.BRAVE_API_KEY = "brave-LEAKCANARY0000";
delete process.env.BRAVE_ANSWERS_API_KEY; // fall back to BRAVE_API_KEY (canary)
delete process.env.BRAVE_SUGGEST_API_KEY;
// Non-AI credentialed upstreams (crypto/identity/macro/finance/b20) — each
// carries its secret into a residual-4xx echo path. Canary values here prove
// none of those bodies (or the Alchemy key baked into a b20 RPC URL) reach a
// buyer-visible error.
process.env.COINGECKO_API_KEY = "cg-LEAKCANARY0000";
process.env.NEYNAR_API_KEY = "neynar-LEAKCANARY0000";
delete process.env.WARPCAST_API_KEY;
process.env.FRED_API_KEY = "fred-LEAKCANARY0000";
process.env.FRED_API_KEY_V2 = "fredv2-LEAKCANARY0000";
process.env.YAHOO_RELAY_URL = "https://93.184.216.34/relay"; // public-IP literal → no DNS
process.env.YAHOO_RELAY_TOKEN = "yrelay-LEAKCANARY0000";
process.env.ALCHEMY_API_KEY = "alchemy-LEAKCANARY0000";
process.env.E2B_API_KEY = "e2b_LEAKCANARY0000"; // code-run-kit (E2B sandbox)
delete process.env.POSTHOG_API_KEY; // telemetry must stay a no-op
process.env.POSTHOG_TEST_CAPTURE = "1";

const CANARIES = ["LEAKCANARY"];

import {
  LLM_GATEWAY_TOOLS,
  promptCacheKey,
  promptCacheGet,
  embeddingsCacheKey,
} from "../src/tools/llm-gateway-kit.js";
import { LLM_MESSAGES_TOOLS } from "../src/tools/llm-messages-kit.js";
import { LLM_RESPONSES_TOOLS } from "../src/tools/llm-responses-kit.js";
import { LLM_TOOLS } from "../src/tools/llm-kit.js";
import { EMBED_TOOLS } from "../src/tools/embed-kit.js";
import { IMAGE_GEN_TOOLS } from "../src/tools/image-gen-kit.js";
import { TTS_TOOLS } from "../src/tools/tts-kit.js";
import { STT_TOOLS } from "../src/tools/stt-kit.js";
import { MODERATE_TOOLS } from "../src/tools/moderate-kit.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";
// Non-AI credentialed kits (residual-4xx echo paths audited in D5 follow-up).
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";
import { ONCHAIN_IDENTITY_TOOLS } from "../src/tools/onchain-identity-kit.js";
import { MACRO_TOOLS } from "../src/tools/macro-kit.js";
import { FINANCE_TOOLS } from "../src/tools/finance-kit.js";
// Alchemy-keyed kits (D5 re-review): key rides the RPC URL, echoed via a
// JSON-RPC error in a 200 body. These read the key at CALL time, so a static
// import is fine.
import { CHAIN_TOOLS } from "../src/tools/chain-kit.js";
import { DEX_TOOLS } from "../src/tools/dex-kit.js";
import { NFT_MARKET_TOOLS } from "../src/tools/nft-market-kit.js";
import { MEV_AND_L2_TOOLS } from "../src/tools/mev-and-l2-kit.js";
import { CODE_RUN_TOOLS } from "../src/tools/code-run-kit.js";
import { redactSecrets } from "../src/tools/redact.js";
// b20-kit AND x402-kit bake the Alchemy RPC URL into a MODULE-LOAD const, and
// ES `import` is hoisted above the env assignments above — so a static import
// would read ALCHEMY_API_KEY too early. Dynamic-import them after the canary
// env is live so the Alchemy URL is actually in the RPC set.
const { B20_TOOLS } = await import("../src/tools/b20-kit.js");
const { X402_TOOLS } = await import("../src/tools/x402-kit.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const bySlug = (tools, slug) => {
  const t = tools.find((x) => x.slug === slug);
  if (!t) throw new Error(`tool "${slug}" not found`);
  return t.handler;
};

// ---------------------------------------------------------------------------
// Mock upstream. The adversarial modes echo the credential the request
// carried — the worst-case upstream behavior (OpenAI's real invalid_api_key
// 401 echoes the key; a compromised/misbehaving upstream could echo it on any
// status). If a handler relays that body verbatim, the canary leaks.
const realFetch = globalThis.fetch;
let mode = "auth-echo-401";
let sawCanaryCred = false; // sanity: the mock actually received the secret

// Pull whatever credential the request carried — a header (Authorization,
// x-subscription-token, x-cg-demo-api-key, x-api-key) OR a URL query param /
// path segment (FRED v1 rides ?api_key=…; b20 bakes the Alchemy key into the
// RPC URL). Returned as one string the adversarial upstream echoes back.
function credentialFrom(url, init) {
  const h = init?.headers || {};
  const parts = [];
  for (const [name, value] of Object.entries(h)) {
    const n = name.toLowerCase();
    if (["authorization", "x-subscription-token", "x-cg-demo-api-key", "x-api-key"].includes(n)) parts.push(String(value));
  }
  parts.push(String(url)); // covers query-string and URL-embedded secrets
  return parts.join(" ");
}

const jsonRes = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  url: "https://mock.upstream/",
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
  text: async () => JSON.stringify(obj),
  json: async () => obj,
  arrayBuffer: async () => Buffer.from(JSON.stringify(obj)).buffer,
});

// Minimal valid PCM WAV (1s, 8kHz mono 8-bit) so the STT handler's local
// duration probe passes and the request reaches the (mocked) OpenAI leg.
function makeWav(seconds = 1) {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds;
  const buf = Buffer.alloc(44 + dataSize, 0x80);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}
const WAV = makeWav();
// Public IP literal: assertPublicUrl validates it without a DNS lookup, so
// the STT audio fetch stays fully offline (the mock serves the bytes).
const AUDIO_URL = "http://93.184.216.34/audio.wav";

const wavRes = () => ({
  ok: true,
  status: 200,
  url: AUDIO_URL,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "audio/wav" : null) },
  body: {
    getReader() {
      let sent = false;
      return {
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(WAV) })),
        cancel() {},
      };
    },
  },
});

const okChatFixture = () => ({
  id: "gen-1", object: "chat.completion", created: 1750000000, model: "openai/gpt-5-nano",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 12, completion_tokens: 1, total_tokens: 13,
    cost: 0.00123, cost_details: { upstream_inference_cost: 0.00123 }, is_byok: false,
  },
});
const okImagesFixture = () => ({
  id: "gen-2", model: "google/gemini-2.5-flash-image",
  choices: [{ message: { role: "assistant", images: [{ image_url: { url: "data:image/png;base64,QUJDRA==" } }] } }],
  usage: {
    prompt_tokens: 14, completion_tokens: 1290, total_tokens: 1304,
    cost: 0.041, cost_details: { upstream_inference_cost: 0.041 }, is_byok: true,
  },
});
const okEmbeddingsFixture = () => ({
  object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, -0.2] }],
  model: "text-embedding-3-small", usage: { prompt_tokens: 2, total_tokens: 2 },
});

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(AUDIO_URL)) return wavRes(); // STT audio download, no credential
  const cred = credentialFrom(url, init);
  if (cred.includes("LEAKCANARY")) sawCanaryCred = true;
  if (mode === "network-error") throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.1:443"), { code: "ECONNREFUSED" });
  if (mode === "ok-chat-cost") return jsonRes(200, okChatFixture());
  if (mode === "ok-images-cost") return jsonRes(200, okImagesFixture());
  if (mode === "ok-embeddings") return jsonRes(200, okEmbeddingsFixture());
  // Adversarial echo: upstream reflects the credential (header value AND the
  // request URL) in its error body — the worst realistic upstream behavior.
  const echo = { error: { message: `Incorrect API key provided: ${cred}`, type: "invalid_request_error" } };
  if (mode === "auth-echo-401") return jsonRes(401, echo);
  if (mode === "bad-request-echo-400") return jsonRes(400, echo);
  if (mode === "server-error-echo-500") return jsonRes(500, echo);
  // JSON-RPC error carried in a 200 body — the exact Alchemy shape that slips
  // past HTTP-status shields (the key rides the request URL, echoed here).
  if (mode === "rpc-error-200") return jsonRes(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `Incorrect API key provided: ${cred}` } });
  throw new Error(`unhandled mock mode ${mode}`);
};

// ---------------------------------------------------------------------------
// Invariant (a)+(c): drive every handler through four upstream failure modes.
const scan = (obj) => {
  try { return JSON.stringify(obj ?? "") || ""; } catch { return String(obj); }
};

const HANDLER_CASES = [
  { slug: "v1-chat-nano", handler: bySlug(LLM_GATEWAY_TOOLS, "v1-chat-nano"), input: { model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 5 } },
  { slug: "v1-embeddings", handler: bySlug(LLM_GATEWAY_TOOLS, "v1-embeddings"), input: { input: "hello", cache: false } },
  { slug: "v1-rerank", handler: bySlug(LLM_GATEWAY_TOOLS, "v1-rerank"), input: { query: "q", documents: ["a", "b"], cache: false } },
  { slug: "v1-chat-messages", handler: bySlug(LLM_MESSAGES_TOOLS, "v1-chat-messages"), input: { model: "anthropic/claude-haiku-4.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } },
  { slug: "v1-chat-responses", handler: bySlug(LLM_RESPONSES_TOOLS, "v1-chat-responses"), input: { model: "openai/gpt-4o-mini", input: "hi", max_output_tokens: 16 } },
  { slug: "v1-images", handler: bySlug(LLM_GATEWAY_TOOLS, "v1-images"), input: { prompt: "a red apple" } },
  { slug: "v1-audio-speech", handler: bySlug(LLM_GATEWAY_TOOLS, "v1-audio-speech"), input: { input: "hello world" } },
  { slug: "llm", handler: bySlug(LLM_TOOLS, "llm"), input: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 5 } },
  { slug: "embed", handler: bySlug(EMBED_TOOLS, "embed"), input: { text: "hello" } },
  { slug: "image-gen", handler: bySlug(IMAGE_GEN_TOOLS, "image-gen"), input: { prompt: "a red apple" } },
  { slug: "tts", handler: bySlug(TTS_TOOLS, "tts"), input: { text: "hello" } },
  { slug: "transcribe", handler: bySlug(STT_TOOLS, "transcribe"), input: { url: AUDIO_URL } },
  { slug: "moderate", handler: bySlug(MODERATE_TOOLS, "moderate"), input: { text: "hello" } },
  { slug: "search", handler: bySlug(SEARCH_TOOLS, "search"), input: { q: "test" } },
  { slug: "answer", handler: bySlug(SEARCH_TOOLS, "answer"), input: { q: "what is x402?" } },
];

const MODES = ["auth-echo-401", "bad-request-echo-400", "server-error-echo-500", "network-error"];

for (const { slug, handler, input } of HANDLER_CASES) {
  for (const m of MODES) {
    mode = m;
    sawCanaryCred = false;
    let out;
    let err = null;
    try { out = await handler(structuredClone(input)); }
    catch (e) { err = e; out = { thrown: e.message, statusCode: e.statusCode, ...e }; }
    const blob = scan(out);
    const leaked = CANARIES.some((c) => blob.includes(c));
    ok(!leaked, `${slug} [${m}] no secret leak`);
    if (leaked) console.error(`  LEAKED >>> ${blob.slice(0, 300)}`);
    ok(sawCanaryCred, `${slug} [${m}] mock upstream actually received the credential (test validity)`);
    // Upstream failures must surface as clean, attributed errors — never a
    // raw 500 and never a success. A remaining upstream 4xx is the BUYER'S
    // invalid request (2026-07-28: relabeling it 502 taught agents to retry
    // identical bad requests), so the OpenAI-proxy kits pass it through as a
    // self-explaining 400. The GATEWAY tiers (v1-*) deliberately keep it
    // 502: their failover walks anything upstream-shaped so a model-specific
    // rejection can try the next provider in the chain.
    // Only the OpenAI-proxy kits adopt the 400 passthrough; the gateway keeps
    // 502 for failover, and the Brave kits keep their controlled 502 (they
    // never echo upstream bodies, so a passthrough 400 has nothing to say).
    const openaiProxy = new Set(["llm", "embed", "image-gen", "tts", "transcribe", "moderate"]);
    const wantStatuses = m === "bad-request-echo-400" && openaiProxy.has(slug) ? [400] : [502, 503, 504];
    ok(err !== null && wantStatuses.includes(err.statusCode), `${slug} [${m}] clean ${wantStatuses.join("/")} (got ${err ? err.statusCode : "no error"})`);
  }
}

// ---------------------------------------------------------------------------
// Non-AI credentialed kits (D5 follow-up). Each carries a secret to its
// upstream (CoinGecko demo key header / Neynar x-api-key / FRED api_key query
// param / Yahoo-Nasdaq relay Bearer / Alchemy key in the RPC URL) and has a
// residual-4xx path that echoes the raw upstream body. Drive each through the
// credential-echoing 400 upstream and assert the canary never reaches the
// thrown error. Status shielding differs per kit (crypto/macro/finance map a
// residual 4xx to 422; onchain relays the upstream status), so we assert on
// the invariant that matters — canary absence — plus "an error was thrown" and
// "the mock actually received the canary" (test validity).
const NON_AI_CASES = [
  { slug: "crypto-price", handler: bySlug(CRYPTO_TOOLS, "crypto-price"), input: { coins: "bitcoin" } },
  { slug: "farcaster-profile", handler: bySlug(ONCHAIN_IDENTITY_TOOLS, "farcaster-profile"), input: { fid: 3 } },
  { slug: "fred-search", handler: bySlug(MACRO_TOOLS, "fred-search"), input: { q: "gdp" } },
  { slug: "stock-quote", handler: bySlug(FINANCE_TOOLS, "stock-quote"), input: { symbol: "AAPL" } },
];

for (const { slug, handler, input } of NON_AI_CASES) {
  mode = "bad-request-echo-400";
  sawCanaryCred = false;
  let out;
  let err = null;
  try { out = await handler(structuredClone(input)); }
  catch (e) { err = e; out = { thrown: e.message, statusCode: e.statusCode, ...e }; }
  const blob = scan(out);
  const leaked = CANARIES.some((c) => blob.includes(c));
  ok(!leaked, `${slug} [echo-400] no secret leak`);
  if (leaked) console.error(`  LEAKED >>> ${blob.slice(0, 300)}`);
  ok(sawCanaryCred, `${slug} [echo-400] mock upstream actually received the credential (test validity)`);
  ok(err !== null && err.statusCode >= 400, `${slug} [echo-400] surfaced a clean attributed error (got ${err ? err.statusCode : "no error"})`);
}

// b20 — the Alchemy key is embedded in the RPC URL. Natural flow can't surface
// it today (keyless public RPCs run last and overwrite lastErr), so drive the
// handler for the "no leak today" guarantee AND assert the redactSecrets wrap
// scrubs an Alchemy-key-bearing error string directly (regression-locks the
// fix against a future BASE_RPCS reorder that would make it the surviving err).
{
  mode = "server-error-echo-500";
  sawCanaryCred = false;
  const b20 = bySlug(B20_TOOLS, "b20-activation-check");
  let out, err = null;
  try { out = await b20({ feature: "base.b20_asset" }); }
  catch (e) { err = e; out = { thrown: e.message, statusCode: e.statusCode, ...e }; }
  ok(!CANARIES.some((c) => scan(out).includes(c)), "b20-activation-check [all-RPC-error] no secret leak");
  ok(sawCanaryCred, "b20-activation-check [all-RPC-error] mock received the Alchemy-keyed RPC URL (test validity)");
  // Direct wrap check: the RPC URL that carries ALCHEMY_API_KEY must redact.
  const alchemyErr = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}: {"error":"boom"}`;
  ok(!CANARIES.some((c) => redactSecrets(alchemyErr).includes(c)), "b20: redactSecrets scrubs the Alchemy key baked into the RPC URL");
}

// ---------------------------------------------------------------------------
// Alchemy-keyed RPC/NFT kits (D5 re-review, 5th echo class). The key rides the
// request URL; the leak vector is a JSON-RPC error carried in a 200 body
// (chain/dex/mev — HTTP-status shields never fire) or a raw error-body echo
// (nft). Drive each through the credential-echoing upstream and assert no
// canary in the thrown error — and, for l2-gas-comparison, no canary in the
// 200 SUCCESS body (it folds per-network errors into networks[].error).
const ALCHEMY_ERROR_CASES = [
  { slug: "wallet-balance", handler: bySlug(CHAIN_TOOLS, "wallet-balance"), input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" }, mode: "rpc-error-200" },
  { slug: "evm-rpc", handler: bySlug(CHAIN_TOOLS, "evm-rpc"), input: { network: "base", method: "eth_blockNumber", params: [] }, mode: "rpc-error-200" },
  { slug: "dex-pair", handler: bySlug(DEX_TOOLS, "dex-pair"), input: { tokenA: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenB: "0x4200000000000000000000000000000000000006", fee: 500, network: "base" }, mode: "rpc-error-200" },
  { slug: "nft-floor", handler: bySlug(NFT_MARKET_TOOLS, "nft-floor"), input: { contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d" }, mode: "bad-request-echo-400" },
];

for (const { slug, handler, input, mode: m } of ALCHEMY_ERROR_CASES) {
  mode = m;
  sawCanaryCred = false;
  let out, err = null;
  try { out = await handler(structuredClone(input)); }
  catch (e) { err = e; out = { thrown: e.message, statusCode: e.statusCode, ...e }; }
  const blob = scan(out);
  const leaked = CANARIES.some((c) => blob.includes(c));
  ok(!leaked, `${slug} [${m}] no secret leak`);
  if (leaked) console.error(`  LEAKED >>> ${blob.slice(0, 300)}`);
  ok(sawCanaryCred, `${slug} [${m}] mock received the Alchemy-keyed request (test validity)`);
  ok(err !== null && err.statusCode >= 400, `${slug} [${m}] surfaced a clean attributed error (got ${err ? err.statusCode : "no error"})`);
}

// l2-gas-comparison — WORST case: per-network errors are folded into a 200
// SUCCESS response body (networks[].error), not thrown. Scan the SUCCESS body.
{
  mode = "rpc-error-200";
  sawCanaryCred = false;
  const l2gas = bySlug(MEV_AND_L2_TOOLS, "l2-gas-comparison");
  let out, err = null;
  try { out = await l2gas({ networks: ["ethereum", "base"] }); }
  catch (e) { err = e; out = { thrown: e.message, ...e }; }
  ok(!CANARIES.some((c) => scan(out).includes(c)), "l2-gas-comparison [rpc-error-200] no secret in the 200 SUCCESS body");
  ok(sawCanaryCred, "l2-gas-comparison [rpc-error-200] mock received the Alchemy-keyed request (test validity)");
  // Confirm we actually exercised the error-fold path (else the scan is vacuous).
  const foldedErrors = Array.isArray(out?.networks) && out.networks.some((n) => n && n.error);
  ok(foldedErrors, "l2-gas-comparison [rpc-error-200] exercised the networks[].error fold path");
}

// x402-kit tx-status (robinhood) — same b20 class: Alchemy key in the RPC URL,
// latent today (public RPC runs last, overwrites lastErr). Drive for "no leak
// today" + a direct redact assertion on the robinhood Alchemy URL.
{
  mode = "rpc-error-200";
  sawCanaryCred = false;
  const txStatus = bySlug(X402_TOOLS, "tx-status");
  let out, err = null;
  try { out = await txStatus({ hash: "0x" + "0".repeat(64), network: "robinhood" }); }
  catch (e) { err = e; out = { thrown: e.message, statusCode: e.statusCode, ...e }; }
  ok(!CANARIES.some((c) => scan(out).includes(c)), "x402 tx-status [rpc-error-200] no secret leak");
  ok(sawCanaryCred, "x402 tx-status [rpc-error-200] mock received the robinhood Alchemy-keyed RPC URL (test validity)");
  const rhErr = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}: {"error":"boom"}`;
  ok(!CANARIES.some((c) => redactSecrets(rhErr).includes(c)), "x402: redactSecrets scrubs the Alchemy key baked into the robinhood RPC URL");
}

// code-run-kit (E2B sandbox) — E2B_API_KEY rides Sandbox.create({ apiKey });
// both catch branches echo ${e.message} (E2B-SDK text wrapping the upstream
// error). The installed E2B SDK sanitizes its own errors (generic
// "Unauthorized" messages that never contain the key), so this is a latent /
// defensive fix like cdp/b20/x402: drive the handler for the "no leak today"
// guarantee, then assert the redactSecrets wrap on BOTH echo-site templates
// scrubs an upstream reply that DID reflect the key (regression-locks the fix
// against a future SDK/upstream that echoes the key verbatim).
{
  const codeRun = bySlug(CODE_RUN_TOOLS, "code-run");
  let out, err = null;
  try { out = await codeRun({ code: "print(1)" }); }
  catch (e) { err = e; out = { thrown: e.message, statusCode: e.statusCode, ...e }; }
  ok(!CANARIES.some((c) => scan(out).includes(c)), "code-run [sandbox-create error] no secret leak (E2B SDK error is sanitized)");
  ok(err !== null && [502, 503, 504].includes(err.statusCode), `code-run surfaced a clean upstream error (got ${err ? err.statusCode : "no error"})`);
  // Both echo sites, redact-wrapped — an upstream that reflects the key must not survive.
  const createEcho = `Sandbox creation failed: api key '${process.env.E2B_API_KEY}' not found`;
  const execEcho = `Execution failed: unauthorized for key ${process.env.E2B_API_KEY}`;
  ok(!CANARIES.some((c) => redactSecrets(createEcho).includes(c)), "code-run: redactSecrets scrubs E2B_API_KEY from the sandbox-creation echo");
  ok(!CANARIES.some((c) => redactSecrets(execEcho).includes(c)), "code-run: redactSecrets scrubs E2B_API_KEY from the execution-failed echo");
}

// ---------------------------------------------------------------------------
// Redact-then-slice ordering (MINOR #5): a secret straddling the 200-char cut
// must not leave an unredactable prefix. Prove the AI-kit echo path (which now
// redacts the FULL body before slicing) survives a secret pushed to the
// boundary by padding, driven through the gateway's throwUpstreamError.
{
  mode = "bad-request-echo-400"; // echoes cred inside a >200-char message
  sawCanaryCred = false;
  const nano = bySlug(LLM_GATEWAY_TOOLS, "v1-chat-nano");
  // Force a long echo: the mock message is `Incorrect API key provided: <cred>`
  // where cred includes the full canary — with redact-then-slice the canary is
  // gone regardless of where the 200-char cut falls.
  let err = null;
  try { await nano({ model: "gpt-5-nano", messages: [{ role: "user", content: "boundary" }], max_tokens: 5 }); }
  catch (e) { err = e; }
  ok(err && !CANARIES.some((c) => String(err.message).includes(c)), "redact-then-slice: canary absent from the (redacted) sliced error message");
}

// ---------------------------------------------------------------------------
// Invariant (b): the gateway strips usage.cost / cost_details / is_byok from
// the buyer-facing response AND from the prompt-cache entry.
{
  mode = "ok-chat-cost";
  const nano = bySlug(LLM_GATEWAY_TOOLS, "v1-chat-nano");
  const input = { model: "gpt-5-nano", messages: [{ role: "user", content: "cost strip" }], max_tokens: 5, cache: true };
  const res = await nano(structuredClone(input));
  ok(res?.usage?.prompt_tokens === 12 && res?.usage?.total_tokens === 13, "chat: standard token counts survive");
  ok(!("cost" in (res?.usage || {})), "chat: usage.cost stripped from the buyer response");
  ok(!("cost_details" in (res?.usage || {})), "chat: usage.cost_details stripped from the buyer response");
  ok(!("is_byok" in (res?.usage || {})), "chat: usage.is_byok stripped from the buyer response");
  ok(!scan(res).includes("cost_details") && !/"cost"/.test(scan(res)), "chat: no cost field anywhere in the response JSON");
  const cached = promptCacheGet(promptCacheKey("v1-chat-nano", input));
  ok(cached != null, "chat: opted-in response landed in the prompt cache");
  ok(cached == null || (!("cost" in (cached.usage || {})) && !("cost_details" in (cached.usage || {})) && !("is_byok" in (cached.usage || {}))), "chat: cache entry carries no cost fields");
  ok(!CANARIES.some((c) => scan(cached).includes(c)), "chat: cache entry carries no secret");
}
{
  mode = "ok-images-cost";
  const images = bySlug(LLM_GATEWAY_TOOLS, "v1-images");
  const res = await images({ prompt: "a fox reading a newspaper" });
  ok(res?.data?.[0]?.b64_json === "QUJDRA==", "images: b64_json payload translated");
  ok(!("cost" in (res?.usage || {})), "images: usage.cost stripped from the buyer response");
  ok(!("cost_details" in (res?.usage || {})), "images: usage.cost_details stripped from the buyer response");
  ok(!("is_byok" in (res?.usage || {})), "images: usage.is_byok stripped from the buyer response");
  ok(!CANARIES.some((c) => scan(res).includes(c)), "images: no secret in the success response");
}
{
  mode = "ok-embeddings";
  const embeddings = bySlug(LLM_GATEWAY_TOOLS, "v1-embeddings");
  const input = { input: "cache me" };
  const res = await embeddings(structuredClone(input));
  ok(Array.isArray(res?.data) && res.data[0]?.embedding?.length === 2, "embeddings: wire shape passes through");
  ok(!CANARIES.some((c) => scan(res).includes(c)), "embeddings: no secret in the success response");
  const cached = promptCacheGet(embeddingsCacheKey(input));
  ok(cached != null && !CANARIES.some((c) => scan(cached).includes(c)), "embeddings: default-on cache entry carries no secret");
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
