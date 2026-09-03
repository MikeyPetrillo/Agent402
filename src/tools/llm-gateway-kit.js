// LLM gateway — OpenAI-compatible pay-per-call inference over x402.
//
// Unlike llm-kit (a custom JSON tool), these routes live at the OpenAI wire
// paths and speak the full chat/completions format, so ANY existing agent or
// SDK adopts the gateway by changing base_url — no integration work. That is
// the distribution mechanism behind the top x402 earners: agents pay per
// reasoning turn, in loops, not per occasional tool call.
//
//   POST /v1/chat/completions          $0.02  — budget/mid models
//   POST /v1/auto/chat/completions     $0.01  — eval-ranked routing, no model needed
//   POST /v1/pro/chat/completions      $0.10  — mid-frontier models
//   POST /v1/premium/chat/completions  $0.50  — frontier models
//   GET  /v1/models                    free   — served by server.js from TIERS
//
// Upstream: OpenRouter (one key, hundreds of models). x402 settles BEFORE the
// handler runs, so the buyer's USDC always arrives before a single upstream
// token is spent — no credit risk beyond one in-flight call. Env-gated:
// missing OPENROUTER_API_KEY → 503 at call time, not boot failure.
//
// Pricing is deterministic by design (flat per tier), matching the project's
// predictability brand: model allowlists + input/output caps keep worst-case
// upstream cost well under the x402 price. Streaming (stream: true) is
// supported: max_tokens is clamped before the upstream call, so the provider
// stops the stream at the cap and worst-case cost stays under the price
// regardless of settlement timing. (Under @x402/express v2.16 settlement runs
// AFTER the handler and only for a <400 response — a streamed 200 settles once
// the stream finishes.) Streamed responses are not idempotency-replayable (the
// cache hooks res.json only).

import { METER_MARKUP, METER_FLOOR_USD, METER_MIN_SETTLE_USD, setMeterSentinel } from "../gateway-meter.js";
import { createHash, createHmac } from "node:crypto";
// Static import (not agent-kit's lazy pattern): validateRequest must stay
// synchronous because promptCacheKey — called from the pre-paywall cache
// middleware — normalizes through it.
import { countTokens, setMergeCacheSize } from "gpt-tokenizer/model/gpt-4o";
// gpt-tokenizer memoises BPE merges per pre-token chunk, keyed by the chunk
// STRING, default cap 100k entries. With bounded pieces (below) every piece of
// buyer text is a chunk, ~50 KB retained each: an unauthenticated caller could
// park gigabytes in that cache one prompt at a time. 2,000 entries bounds it
// near 100 MB and costs nothing on real traffic (repeats are rare and cheap).
setMergeCacheSize(2000);
// cl100k tokenizer for the embeddings margin clamp — all three supported
// embeddings models bill cl100k input tokens, not o200k. Static import for
// the same reason as above: embeddingsCacheKey (pre-paywall) must stay sync.
import { countTokens as countEmbeddingTokens, setMergeCacheSize as setEmbeddingMergeCacheSize } from "gpt-tokenizer/model/text-embedding-3-small";
setEmbeddingMergeCacheSize(2000); // separate encoder instance, same retention hazard
import { redactSecrets } from "./redact.js";
import { payerFromRequest, paymentHeaderOf } from "../payer.js";

const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ---------------------------------------------------------------------------
// Stealth (cloaked) model listings - models a lab runs on OpenRouter under a
// pseudonym while it collects real traffic. TWO properties follow from that,
// and both are load-bearing here:
//
//   1. They are FREE (prompt/completion priced at 0 upstream) because the
//      provider is paid in DATA: prompts and completions are logged and used
//      by the lab. That is a disclosure obligation, not a footnote - the tier
//      description says it plainly and `zdr:true` is REFUSED (we cannot honour
//      zero-data-retention on a model whose whole deal is retention).
//   2. They VANISH without notice when the lab unmasks the model. So the id
//      must never be able to fail CI (scripts/test-gateway-model-ids.js treats
//      STEALTH_MODEL_IDS as a loud warning, not a failure) and must never
//      surface to a buyer as a 500.
//
// Vanish tolerance is two layers:
//   • OX_ALPHA_ENABLED=off - synchronous operator kill switch, read when the
//     catalog is built (server.js), same shape as OPENROUTER_TTS_ENABLED. The
//     tier disappears from the catalog entirely on the next boot: no route, no
//     402, no /v1/models entry, no /api/pricing row.
//   • probeOxAlphaAvailability() - a single non-blocking boot read of the live
//     OpenRouter catalog. If the id is GONE it logs loudly, drops the model
//     from GET /v1/models, and makes the tier answer 503 before any upstream
//     round-trip. @x402/express settles only a <400 response, so that 503 is
//     never charged. It FAILS OPEN on an unreadable catalog (the boot
//     /supported guard's lesson: our own egress being down is
//     indistinguishable from an upstream deletion, and wiping a working tier
//     on it would be self-inflicted).
export const OX_MODEL = "stealth/ox-alpha";
export const OX_ROUTE = "/v1/ox/chat/completions";
/** Ids the live-catalog CI guard must tolerate losing. */
export const STEALTH_MODEL_IDS = Object.freeze([OX_MODEL]);
const OX_MODELS_CATALOG_URL = "https://openrouter.ai/api/v1/models";
const OX_ENABLED = () => String(process.env.OX_ALPHA_ENABLED || "on").toLowerCase() !== "off";
// Set true ONLY by a successful catalog read that did not list the id. An
// unreadable catalog never sets it (fail open).
let oxUpstreamMissing = false;
export function oxAlphaAvailable() { return OX_ENABLED() && !oxUpstreamMissing; }
export function _setOxUpstreamMissingForTest(v) { oxUpstreamMissing = !!v; oxPricing = null; }

// --- upstream-price proof, for the free-trial exception -------------------
// The trial path is otherwise limited to pure-CPU routes so a free call can
// never give away upstream money. Offering a metered /v1 route there is only
// safe while we can PROVE the upstream bill is $0 - and a stealth listing can
// be repriced without notice, so this must FAIL CLOSED in every direction:
//
//   • before the first successful probe            -> false
//   • probe errored / catalog unreadable           -> false once stale
//   • the record is gone from the catalog          -> false (cleared)
//   • pricing is anything other than "0" / "0"     -> false
//
// Only the most recent SUCCESSFUL read counts, and it must still be FRESH.
// The probe runs hourly, so the default window tolerates two consecutive
// failures before the trial switches itself off; a sustained outage closes it.
// The comparison is on the RAW strings OpenRouter returns ("0"), then on the
// parsed number, so neither "0.0000001" nor a non-numeric value can read as free.
const OX_PRICING_MAX_AGE_MS = () => Number(process.env.OX_PRICING_MAX_AGE_MS) || 3 * 60 * 60_000; // call-time read
let oxPricing = null; // { prompt, completion, checkedAt } from the last successful read, or null

/** Last-seen upstream pricing for the stealth model: {prompt, completion,
 *  checkedAt} as reported by OpenRouter, or null when never read / the record
 *  is gone. For operator surfaces - it explains WHY the trial is or is not
 *  being offered. Never an assertion of freeness on its own; use
 *  oxUpstreamIsFree() for that. */
/** Test seam: set the last-seen pricing directly, so a guard can prove the
 *  freeness check fails closed without reaching the network. */
export const __oxTest = { setPricing(v) { oxPricing = v; } };

export function oxUpstreamPricing() {
  return oxPricing ? { ...oxPricing } : null;
}

/** True ONLY when the last successful catalog read saw stealth/ox-alpha priced
 *  at exactly 0 prompt AND 0 completion, and that reading is still fresh.
 *  False on any error, any missing record, any non-zero price, and before the
 *  first successful probe. */
export function oxUpstreamIsFree() {
  if (!oxPricing) return false;
  if (!(Date.now() - oxPricing.checkedAt < OX_PRICING_MAX_AGE_MS())) return false;
  const zero = (v) => (typeof v === "string" || typeof v === "number") && String(v).trim() !== "" && Number(v) === 0;
  return zero(oxPricing.prompt) && zero(oxPricing.completion);
}

/** One-shot boot probe: is the stealth id still listed upstream? Returns true
 *  (live), false (gone - tier disabled in-process) or null (unreadable - left
 *  as-is). `fetchImpl` is the test seam. */
export async function probeOxAlphaAvailability({ fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const res = await f(OX_MODELS_CATALOG_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // A catalog that shrinks below the floor is a READ FAILURE, not a verdict
    // (same rule as the CI guard) - refuse to delist on it.
    if (!Array.isArray(j?.data) || j.data.length < 100) throw new Error(`implausible catalog (${j?.data?.length} entries)`);
    const record = j.data.find((m) => m?.id === OX_MODEL) || null;
    const live = !!record;
    oxUpstreamMissing = !live;
    // Price proof rides the SAME read - no second network call. A successful
    // read is the only thing that may set it, and a missing record clears it.
    oxPricing = record
      ? { prompt: record.pricing?.prompt, completion: record.pricing?.completion, checkedAt: Date.now() }
      : null;
    if (!live) {
      console.warn(
        `WARNING: ${OX_MODEL} is GONE from the live OpenRouter catalog. ${OX_ROUTE} now answers 503 ` +
        "before any upstream call (a >=400 cancels settlement, so no buyer is charged) and the model is " +
        "dropped from GET /v1/models. This is the EXPECTED end of a stealth listing: set OX_ALPHA_ENABLED=off " +
        "to remove the route from the catalog on the next boot, or repoint the tier at the unmasked model id."
      );
    }
    return live;
  } catch (e) {
    console.warn(
      `WARNING: could not verify ${OX_MODEL} against the live OpenRouter catalog ` +
      `(${String(e?.message || e).slice(0, 140)}) - leaving ${OX_ROUTE} exactly as it is (fail open).`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto tier — eval-ranked model routing. The buyer sends messages and NO
// model; the gateway classifies the prompt and serves it with the top-ranked
// budget model for that task type. The classification is lexical-signal only
// and the ranking is a fixed, human-curated table distilled from public evals
// (LMArena + OpenRouter usage rankings for sub-$1/M models) — updated by code
// review, never at runtime — so the routing decision is fully deterministic:
// no LLM in the routing path, identical requests always route identically.
//
// Each list doubles as the tier's failover chain: a provider error walks down
// the ranking, and every list contains openai/gpt-4o-mini — the model the
// daily paid canary proves alive.
//
// The `quality` knob picks the BAND (fast / balanced / best); all three stay
// inside the flat $0.01 price — a per-request price can't exist under x402's
// fixed per-route quote, so quality trades latency/depth, never what the
// buyer pays. Worst-case upstream at the auto caps (~4k tokens in / 1024
// out): fast tops out at gemini-2.5-flash-lite (~$0.0008, 12x headroom),
// balanced at deepseek-chat (~$0.0022, >4x), best at gemini-2.5-flash
// (~$0.0038, ~2.6x) — the thinnest band is documented, deliberate, still >2x.
//
// 2026-08-04 refresh (live-verified against openrouter.ai/api/v1/models):
// google/gemini-2.0-flash-001 and -lite are GONE from OpenRouter — the old
// fast band led every category with a dead model, so every fast-routed call
// burned a failed upstream round-trip before failing over. Replaced with
// gemini-2.5-flash-lite ($0.10/$0.40). openai/gpt-5.6-luna entered at
// $0.10/$0.60 (July 2026 price cut) — frontier-lab efficiency at 4o-mini
// prices, 1M context — and takes the balanced/best slots the dead model and
// age had left weakest. Every list still ends in openai/gpt-4o-mini.
export const AUTO_QUALITIES = ["fast", "balanced", "best"];
export const AUTO_RANKINGS = {
  // fast — cheapest/snappiest serving; right for high-frequency loop turns.
  fast: {
    code: ["google/gemini-2.5-flash-lite", "qwen/qwen-2.5-coder-32b-instruct", "openai/gpt-4o-mini"],
    reasoning: ["google/gemini-2.5-flash-lite", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
    long: ["google/gemini-2.5-flash-lite", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
    general: ["google/gemini-2.5-flash-lite", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
  },
  // balanced — the default band. deepseek-chat keeps the code head (proven,
  // cheap); gpt-5.6-luna leads the rest (1M ctx covers `long` natively).
  balanced: {
    code: ["deepseek/deepseek-chat", "openai/gpt-5.6-luna", "openai/gpt-4o-mini"],
    reasoning: ["openai/gpt-5.6-luna", "deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    long: ["openai/gpt-5.6-luna", "google/gemini-2.5-flash-lite", "openai/gpt-4o-mini"],
    general: ["openai/gpt-5.6-luna", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
  },
  // best — strongest models that still clear the price with ≥2.5x headroom.
  best: {
    code: ["openai/gpt-5.6-luna", "deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    reasoning: ["google/gemini-2.5-flash", "openai/gpt-5.6-luna", "openai/gpt-4o-mini"],
    long: ["google/gemini-2.5-flash", "openai/gpt-5.6-luna", "openai/gpt-4o-mini"],
    general: ["google/gemini-2.5-flash", "openai/gpt-5.6-luna", "openai/gpt-4o-mini"],
  },
};

// Explicit code/reasoning signals outrank raw length, so a long code review
// routes to a code model, not a long-context generalist. Keywords are chosen
// to be rare in plain prose (no bare "class"/"let"); a misclassification is
// benign — every ranked model is a competent generalist — but determinism is
// the contract, so the signal lists only ever change by code review.
const CODE_RE = /```|\bfunction\s*\(|\bdef\s+\w+\s*\(|\bimport\s+[\w{.]|\bconsole\.log\b|\bTraceback\b|\bstack trace\b|\bregex\b|\brefactor\b|\bunit test\b|\bcompile error\b|\btypescript\b|\bjavascript\b|\bpython\b|\bSELECT\b[\s\S]{0,120}\bFROM\b/i;
const REASONING_RE = /[∑∫√π≠≤≥]|\bprove\b|\btheorem\b|\bderive\b|\bcalculate\b|\bsolve\b|\bequation\b|\bintegral\b|\bprobability\b|\bhow many\b|\bstep[ -]by[ -]step\b|\blogic puzzle\b|\briddle\b/i;
const LONG_CHARS = 8000;

/** Deterministic prompt classifier for the auto tier. Tolerates malformed
 *  messages (returns "general") - validateRequest raises the real 400 right
 *  after, so garbage never reaches the upstream anyway. */
export function classifyPrompt(messages) {
  let text = "";
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (typeof m?.content === "string") text += m.content + "\n";
      else if (Array.isArray(m?.content)) {
        for (const b of m.content) if (b?.type === "text" && typeof b.text === "string") text += b.text + "\n";
      }
    }
  }
  if (CODE_RE.test(text)) return "code";
  if (REASONING_RE.test(text)) return "reasoning";
  if (text.length > LONG_CHARS) return "long";
  return "general";
}

// Tier → OpenRouter model-id prefixes, input char budget, output token cap.
// Caps chosen so worst-case upstream cost stays well below the x402 price
// (budget models run ~$0.15-0.60/M tokens; 2048 output + 32k input tops out
// around $0.003 - a $0.02 price leaves >6x headroom).
//
// `maxPrice` (USD per 1M tokens, {prompt, completion}) rides to OpenRouter as
// provider.max_price - a HARD upstream price filter. These are CATASTROPHE
// BOUNDS, not tight budgets: each sits ~1.5-2x above the priciest allowlisted
// model's list price, so they never affect normal serving. What they block is
// the silent failure mode where one of a model's providers charges multiples
// of list (or a provider reprices) - OpenRouter then refuses that provider
// instead of us quietly eating the margin. A model with NO provider under the
// bound errors upstream, which the failover chain already treats as walkable.
export const TIERS = {
  // Nano tier - priced for agent LOOPS, not occasional calls. The x402
  // leaderboard's top earner does ~800k inference calls/day at sub-cent
  // average prices; the $0.02 base tier is priced out of that traffic.
  // Caps keep worst-case upstream (~3k tokens in / 768 out on ~$0.10-0.40/M
  // models) around $0.0006 - >5x headroom under the $0.003 price, same
  // discipline as the other tiers. Listed FIRST so tierFor()'s
  // self-correcting 400s and /v1/models lead with the cheapest home.
  "v1-chat-nano": {
    defaultModel: "openai/gpt-5.6-luna", // gpt-4.1-nano retires 2026-10-23 (OpenAI deprecations, read 2026-08-28); luna is its named successor. served when the caller names no model (2026-08-28: 82 refusals in 30 days for a missing "model")
    route: "POST /v1/nano/chat/completions",
    price: 0.003,
    priceSort: true, // cheapest provider under max_price (budget tier: price IS the product)
    reasoningDefault: "lowest", // see REASONING_MODELS: minimal/low effort unless the buyer asks
    maxInputChars: 12_000,
    maxTokens: 768,
    maxPrice: { prompt: 0.5, completion: 1.5 }, // priciest allowlisted: deepseek-chat ~$0.27/$1.10
    // Server-chosen upstream failover, tried in order when the requested
    // model's provider errors. The terminal entry is deliberately gpt-4o-mini:
    // the daily canary proves it alive every morning, and at the nano caps its
    // worst case (~$0.0009) stays ~3x under the price. Fallback models bypass
    // the tier allowlist (server-chosen, caps still enforced by the body).
    fallbacks: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    prefixes: [
      // gpt-4.1-nano retired here 2026-09-02 ahead of OpenAI's 2026-10-23 removal; gpt-5.6-luna is its named successor and the tier default.
      "openai/gpt-5-nano",
      // gpt-5.6-luna: $0.10/$0.60 after OpenAI's 2026-07-30 cut — frontier-lab
      // efficiency in the nano price class (live-verified 2026-08-04).
      "openai/gpt-5.6-luna",
      // gemini-2.0-flash-lite was removed here 2026-08-04: the model is gone
      // from OpenRouter entirely (verified against the live models list).
      "google/gemini-2.5-flash-lite",
      "meta-llama/llama-3.2-1b-instruct", "meta-llama/llama-3.2-3b-instruct",
      // ministral-3b/8b were renamed upstream to the -2512 ids (the bare ids
      // 404 at OpenRouter; live-verified 2026-08-19). Listed with the live id so
      // /v1/models never advertises a name the upstream no longer serves.
      "mistralai/ministral-3b-2512", "mistralai/ministral-8b-2512",
      "qwen/qwen-2.5-7b-instruct",
      "deepseek/deepseek-chat",
      "poolside/laguna-xs-2.1", "poolside/laguna-s-2.1", // $0.06-0.09/$0.12-0.18
    ],
  },
  "v1-chat": {
    defaultModel: "openai/gpt-4o-mini", // served when the caller names no model (2026-08-28: 82 refusals in 30 days for a missing "model")
    reasoningDefault: "lowest", // budget tier: lowest non-none effort on default-on reasoning models
    route: "POST /v1/chat/completions",
    price: 0.02,
    maxInputChars: 32_000,
    maxTokens: 2048,
    maxPrice: { prompt: 2.5, completion: 8 }, // family prefixes reach mistral-large ~$2/$6, qwen-max ~$1.6/$6.4
    prefixes: [
      // gpt-5-nano is admitted on base as well (a nano model on a pricier tier is
      // harmless), the way gpt-4.1-nano was until its 2026-10-23 retirement.
      "openai/gpt-4o-mini", "openai/gpt-4.1-mini", "openai/gpt-5-nano",
      // gpt-5.6-terra was admitted here when it listed at $1/$6. It lists at
      // $2/$12 today (live 2026-08-28), OVER this tier's completion bound, so
      // `provider.max_price` refused every non-flex attempt and each call burnt
      // a wasted round trip; with OPENROUTER_FLEX=off it was unservable. Kept
      // off the base tier rather than raising the bound, which is the belt that
      // catches a model repriced upward: a buyer naming it now gets a
      // self-explaining 400 instead of a silent failover.
      "anthropic/claude-haiku", "anthropic/claude-3-haiku", // claude-3.5-haiku left OpenRouter (live-verified 2026-08-19)
      // gemini-flash (bare) and gemini-2.0-flash left OpenRouter (live-verified
      // 2026-08-19, scripts/test-gateway-model-ids.js); 2.5 + 3.x remain.
      "google/gemini-2.5-flash",
      "google/gemini-3.1-flash-lite", "google/gemini-3.5-flash-lite", // $0.25/$1.50, $0.30/$2.50
      "deepseek/", "meta-llama/", "mistralai/", "qwen/",
    ],
  },
  "v1-chat-pro": {
    defaultModel: "openai/gpt-4o", // served when the caller names no model (2026-08-28: 82 refusals in 30 days for a missing "model")
    reasoningDefault: "low", // real reasoning, but never medium/high by default under a 4k cap
    route: "POST /v1/pro/chat/completions",
    price: 0.10,
    maxInputChars: 48_000,
    maxTokens: 4096,
    maxPrice: { prompt: 6, completion: 20 }, // priciest allowlisted: grok ~$3/$15 (claude sonnet 5 is $2/$10, permanent as of 2026-08-10)
    // Server tools (see SERVER_TOOL_POLICY): pro is the CHEAPEST tier that can
    // absorb a bounded agent loop. One Exa search is $0.007 - on the $0.02
    // base tier two of them are the entire 70% margin budget with nothing left
    // for tokens, so the budget tiers refuse server tools outright and the 400
    // names this route. One step here bounds the loop at $0.007 of execution
    // and two model turns; worst case is priced by serverToolWorstCase and
    // clamped like every other cost.
    serverTools: {
      maxSteps: 1,
      tools: {
        "openrouter:web_search": { max_uses: 1, max_results: 3, max_characters: 800 },
        "openrouter:web_fetch": { max_uses: 1, max_content_tokens: 1200 },
        "openrouter:datetime": { max_uses: 1 },
      },
    },
    prefixes: [
      "openai/gpt-4o", "openai/gpt-4.1",
      // claude-sonnet prefix covers claude-sonnet-5, $2/$10 — see MODEL_COST
      // below for the pricing-history note.
      "anthropic/claude-sonnet", // covers claude-sonnet-4.x and -5; 3.5/3.7-sonnet left OpenRouter (2026-08-19)
      "google/gemini-2.5-pro", // bare gemini-pro left OpenRouter (2026-08-19)
      "google/gemini-3.1-pro", "google/gemini-3.5-flash", "google/gemini-3.6-flash", // $2/$12, $1.5/$9, $1.5/$7.5
      "x-ai/grok",
    ],
  },
  "v1-chat-premium": {
    defaultModel: "anthropic/claude-opus-5", // served when the caller names no model (2026-08-28: 82 refusals in 30 days for a missing "model")
    reasoningDefault: "model", // premium buyers bought depth; 8k cap leaves room for the model default
    route: "POST /v1/premium/chat/completions",
    price: 0.50,
    // Raised from 64k -> 200k chars (2026-08-11) for genuine long-context use
    // (a 10-K, a research paper, a large diff) - safe to raise on its own
    // because maxInputChars is a separate, simpler guard from the real
    // margin protection: clampToMargin() below computes worst-case upstream
    // cost from the ACTUAL input size on every call and shrinks max_tokens
    // (or rejects outright below MIN_OUT_TOKENS) to stay within price*MARGIN,
    // independent of this cap's value. Raising it only lets more requests
    // reach that already-robust math, never bypasses it. A model whose real
    // context window is smaller than 200k chars just fails upstream and the
    // chain below tries the next one - never a buyer charge (settlement is
    // post-handler, and a <400 response is required to settle).
    //
    // NOT REACHABLE past ~90k chars ON THIS FLAT TIER: server.js's global
    // `app.use(express.json({ limit: "100kb" }))` runs before this route and
    // rejects a bigger body with a 413 first (confirmed live - a 60k-char
    // input passes both layers, 150k/250k both 413 identically at the outer
    // layer regardless of this cap). The METERED routes are different: server.js
    // mounts `express.json({ limit: "1mb" })` on /v1/metered AHEAD of the global
    // parser (2026-08-27; body-parser sets req._body and the global one skips
    // an already-parsed request, so there is no second pass), because a metered
    // body is priced from its size - a 110 KB agent-host turn is a bigger
    // quote, never an unpriced cost. A flat $0.50 tier has no such bound, so
    // this one keeps the global limit on purpose.
    maxInputChars: 200_000,
    maxTokens: 8192,
    // A tier whose default model REASONS before it speaks (claude-opus-5) needs
    // room before the first visible token: on the Responses wire a hardcoded
    // 1,024 was consumed entirely by reasoning and our own documented example
    // answered 502 (2026-09-02 audit). Same lever the ox tier already had.
    defaultMaxTokens: 4_096,
    maxPrice: { prompt: 20, completion: 100 }, // priciest allowlisted: claude opus ~$15/$75
    // Server tools (see SERVER_TOOL_POLICY): the $0.50 price buys two search
    // steps and richer results. The clamp still decides per request - premium
    // models are the priciest per token, so a long prompt PLUS a tool loop is
    // refused pre-spend rather than served at a loss.
    serverTools: {
      maxSteps: 2,
      tools: {
        "openrouter:web_search": { max_uses: 2, max_results: 4, max_characters: 1000 },
        "openrouter:web_fetch": { max_uses: 2, max_content_tokens: 2000 },
        "openrouter:datetime": { max_uses: 1 },
      },
    },
    prefixes: [
      // gpt-5.6-sol needs its own entry: prefix matching is boundary-aware
      // ("openai/gpt-5" matches gpt-5-*, not gpt-5.6-*). claude-opus covers
      // claude-opus-5 ($5/$25) and claude-opus-5-fast ($10/$50).
      // openai/o4 (the never-released flagship prefix) retired 2026-09-02 ahead of its
      // 2026-10-23 removal: o4-mini stays by its own id, gpt-5.6-terra is the successor.
      "openai/gpt-5", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/o3", "openai/o4-mini",
      "anthropic/claude-opus",
    ],
  },
  // Auto tier - model chosen server-side (see AUTO_RANKINGS above). Listed
  // LAST so tierFor() keeps resolving explicit models to their existing home
  // tiers: the auto prefixes deliberately overlap the nano/base allowlists
  // (an explicit ranked model is honored here at the auto caps), and listing
  // this tier first would hijack those models' self-correcting 400s.
  "v1-chat-auto": {
    reasoningDefault: "lowest",
    route: "POST /v1/auto/chat/completions",
    price: 0.01,
    maxInputChars: 16_000,
    maxTokens: 1024,
    maxPrice: { prompt: 0.6, completion: 3 }, // priciest ranked: gemini-2.5-flash ~$0.30/$2.50
    router: true,
    priceSort: true, // budget router: cheapest provider under the cap
    fallbacks: ["openai/gpt-4o-mini"],
    prefixes: [...new Set(Object.values(AUTO_RANKINGS).flatMap((byCategory) => Object.values(byCategory).flat()))],
  },
  // Grounded tier - the auto router plus OpenRouter's web-search plugin on
  // every call (Exa, up to 5 results), $0.03. The sanctioned home for "answer
  // with the live web": `:online` variants stay refused on every other tier
  // because the search is billed per REQUEST on top of tokens, outside
  // provider.max_price. Here that fee is the tier's own cost: measured
  // 2026-08-19 - Exa auto $0.007/request in usage.cost, ~700 injected prompt
  // tokens per result - and both ride into the margin clamp as
  // fixedUpstreamUsd + extraInputTokens. Results come back as OpenAI-wire
  // `annotations` (url_citation). Never cached: the web moves. Listed after
  // auto so tierFor() keeps resolving explicit models to their home tiers.
  "v1-chat-grounded": {
    reasoningDefault: "lowest",
    route: "POST /v1/grounded/chat/completions",
    price: 0.03,
    maxInputChars: 16_000,
    maxTokens: 1024,
    maxPrice: { prompt: 0.6, completion: 3 },
    router: true,
    priceSort: true,
    fallbacks: ["openai/gpt-4o-mini"],
    prefixes: [...new Set(Object.values(AUTO_RANKINGS).flatMap((byCategory) => Object.values(byCategory).flat()))],
    web: { id: "web", engine: "exa", max_results: 5 },
    fixedUpstreamUsd: 0.007,
    extraInputTokens: 4_500,
    noCache: true,
    // Every attempt re-runs the $0.007 search: a chain of 4 links x flex+default
    // all failing AFTER the search would cost $0.056 against a $0.03 price.
    // Two attempts bound the fixed part at $0.014 (cost audit 2026-08-19).
    maxAttempts: 2,
  },
  // Ox Alpha tier - ONE locked model (stealth/ox-alpha), $0.002.
  //
  // Verified against the live OpenRouter catalog 2026-08-22: pricing
  // prompt "0" / completion "0", context_length 1,048,576,
  // max_completion_tokens 131,072, is_moderated false, modality
  // text+image+video->text, reasoning {mandatory:true, default_enabled:true,
  // supported_efforts:["max","high","low"], default_effort:"max"}.
  //
  // The model is FREE upstream, so this is the cheapest chat tier we sell and
  // essentially pure margin - and the reason it is free is that the provider
  // logs prompts (see the STEALTH_MODEL_IDS note above). That is disclosed in
  // the tool description, on /api/pricing, and on GET /v1/models, and `zdr` is
  // refused here (logsPrompts below).
  //
  // Cost discipline WITHOUT a live price to clamp against: MODEL_COST prices
  // it 0/0 (true today) so the margin clamp is a no-op, which means the ONLY
  // thing standing between us and a surprise bill is `maxPrice` riding
  // upstream as provider.max_price. It is set at $0.005/M on BOTH sides -
  // below every real model on OpenRouter - so the day Ox Alpha stops being
  // free, OpenRouter refuses the provider, the call surfaces as an upstream
  // error (502), settlement is cancelled and nobody is charged. Fails closed,
  // loudly, on the safe side. (scripts/test-ox-tier.js pins the worst case AT
  // that bound under MARGIN x price, which is the bound the runtime clamp
  // cannot compute while the list price is 0.)
  //
  // Reasoning: mandatory and default_effort "max", i.e. the model will happily
  // spend an entire small budget thinking and answer nothing. Measured: a
  // 32-token budget returned content:null + finish_reason "length"; an
  // 800-token budget answered in ~10s. So (a) reasoningDefault "lowest" injects
  // effort "low" (the lowest non-"none" effort it supports), (b) minTokens
  // raises an absurdly small buyer budget to a floor that can actually answer,
  // (c) defaultMaxTokens is generous when the buyer sends no cap, and (d)
  // isEmptyLength still walks/502s if it produces nothing anyway - never a
  // paid empty 200.
  //
  // maxTokens 8,000 is bounded by the 90s upstream timeout, not by cost: at
  // the ~80 tok/s measured above, 8k output is already at that ceiling. A
  // timeout is a 504, which cancels settlement.
  //
  // maxInputChars 80,000: the model's context is 1M TOKENS, but server.js's
  // global express.json({limit:"100kb"}) rejects a bigger body first, so
  // anything past ~90k chars is unreachable regardless (the same ceiling
  // documented on the premium tier). Advertise what is actually servable.
  "v1-chat-ox": {
    route: `POST ${OX_ROUTE}`,
    price: 0.002,
    lockedModel: OX_MODEL,
    stealth: true,
    logsPrompts: true,          // provider retains prompts -> `zdr` is refused, not silently ignored
    available: () => oxAlphaAvailable(),
    reasoningDefault: "lowest", // -> effort "low"; default_effort "max" would eat the budget
    maxInputChars: 80_000,
    maxTokens: 8_000,
    defaultMaxTokens: 4_096,    // generous default: a reasoning model needs room before it speaks
    minTokens: 1_024,           // floor: below this the measured answer is empty + finish_reason "length"
    maxPrice: { prompt: 0.005, completion: 0.005 }, // free today; ANY real price is refused upstream
    prefixes: [OX_MODEL],
  },
};

// ---------------------------------------------------------------------------
// METERED TIER (2026-08-26): pay what the call costs, quoted per request.
//
// The flat tiers fix the amount in the 402 before the handler runs, so a
// 5-token "hi" on the base tier costs the same $0.02 as a 2k-token answer -
// measured 170x-2,162x upstream on the chat tiers (see gateway-meter.js). The
// `upto` meter already fixes that for buyers whose client speaks upto: they
// authorize the tier price as a ceiling and settle actual usage + 15%. But
// most x402 clients (every stock exact-scheme client among them) pay `exact`, and for them the price IS what the 402 says.
//
// So this tier quotes the 402 amount FROM THE REQUEST BODY: @x402/core
// resolves a `price` function per request (payments.js acceptsForItem hands
// it the parsed body), and the quote is the same worst-case arithmetic the
// margin clamp uses - exact-BPE input + the output cap at the model's list
// price - times METER_MARKUP, plus the per-request floor, never below the
// facilitator's minimum settle. Small calls get small quotes (a nano "hi"
// lands on the $0.001 floor); a buyer who sets max_tokens honestly pays for
// what they asked for. An upto buyer on this tier gets the same quote as
// their CEILING and then settles actual usage, exactly as on the flat tiers.
//
// Safety of a per-request price on `exact`: the price function runs on EVERY
// request, including the paid retry, against THAT request's body - so a
// payment authorized for a small quote cannot be replayed with a bigger body
// (the requirements no longer match and the paywall answers 402 again). A
// body that quotes above `maxQuoteUsd` is refused with a 400 before any
// upstream spend, and the 402 for it carries the cap so nobody pays for a
// request the handler will refuse (>= 400 cancels settlement).
//
// Listed LAST: its prefixes are the union of every flat tier's, and tierFor()
// takes the first match, so explicit models keep resolving to their home
// tiers for the self-correcting 400s and /v1/models stays de-duplicated.
export const METERED_MAX_QUOTE_USD = Number(process.env.GATEWAY_METERED_MAX_QUOTE_USD || 2);
const METERED_PREFIXES = [...new Set(Object.values(TIERS)
  .filter((t) => !t.router && !t.lockedModel && !t.stealth)
  .flatMap((t) => t.prefixes || []))];
TIERS["v1-chat-metered"] = {
  defaultModel: "anthropic/claude-haiku-4.5", // served when the caller names no model (quoted like any explicit model)
  metered: true,
  reasoningDefault: "lowest", // the buyer pays for reasoning tokens: default to the cheapest effort, opt up explicitly
  route: "POST /v1/metered/chat/completions",
  price: METER_MIN_SETTLE_USD,            // the FLOOR: what the catalog shows as "from"; the 402 quotes per request
  maxQuoteUsd: METERED_MAX_QUOTE_USD,
  maxInputChars: 200_000,
  maxTokens: 8192,
  defaultMaxTokens: 1024,
  maxPrice: { prompt: 20, completion: 100 },
  prefixes: METERED_PREFIXES,
};
TIERS["v1-chat-metered"].prefixes = METERED_PREFIXES;


// Drop-in compatibility: bare OpenAI-style names map to their OpenRouter ids,
// so `model: "gpt-4o-mini"` from an unmodified OpenAI SDK works unchanged.
/** Allowlist prefixes that are NOT themselves live OpenRouter ids, mapped to
 *  the concrete model a buyer gets when they send the bare family name.
 *  Found 2026-08-26 by the first live card buy: /v1/models listed
 *  "anthropic/claude-opus" (a prefix covering claude-opus-5 / -fast), a buyer
 *  sent it verbatim, and OpenRouter answered "not a valid model ID" - an
 *  uncharged 502 for a model we advertised. The live-catalog guard only asked
 *  whether SOMETHING resolves under each prefix, never whether the prefix is
 *  an id. Every other prefix in TIERS is itself a live id; this table is for
 *  the ones that are not, and the guard now fails if a listed id is not exact. */
export const PREFIX_CANONICAL = Object.freeze({
  // Live ids under each family read from openrouter.ai/api/v1/models on
  // 2026-08-26; the guard's exact-id check fails CI if one of these dies.
  "anthropic/claude-opus": "anthropic/claude-opus-5",
  "anthropic/claude-sonnet": "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku": "anthropic/claude-haiku-4.5",
  "x-ai/grok": "x-ai/grok-4.6",
  "google/gemini-3.1-pro": "google/gemini-3.1-pro-preview",
});

export function canonicalModel(model) {
  const c = canonicalModelRaw(model);
  return Object.hasOwn(PREFIX_CANONICAL, c.toLowerCase()) ? PREFIX_CANONICAL[c.toLowerCase()] : c;
}

function canonicalModelRaw(model) {
  // Whitespace inside the id is never meaningful upstream; collapsing it around
  // the variant colon keeps "model: online" from slipping past the variant
  // refusal and the allowlist as a malformed id (review 2026-08-19). Done with
  // split/trim/join, NOT a `\s*:\s*` regex: `model` is buyer-controlled and
  // that pattern is polynomial-backtracking on a long run of spaces with no
  // colon (CodeQL js/polynomial-redos #121). split/join is linear.
  const m = String(model || "").split(":").map((part) => part.trim()).join(":");
  if (!m) return m;
  if (m.includes("/")) return m; // already an OpenRouter id
  if (/^(gpt|o[0-9])/i.test(m)) return `openai/${m}`;
  if (/^claude/i.test(m)) {
    // Anthropic's own dated ids (claude-haiku-4-5-20251001, claude-sonnet-4-5-
    // 20250929 - what Claude Code and the Anthropic SDKs send by default) are
    // not OpenRouter ids; OpenRouter lists the family as claude-haiku-4.5.
    // Drop the date and dot the minor version so a stock Anthropic client's
    // default model resolves to a live upstream id instead of a 502.
    const undated = m.replace(/-\d{8}$/, "").replace(/^(claude-[a-z]+-\d+)-(\d+)$/i, "$1.$2");
    return `anthropic/${undated}`;
  }
  if (/^gemini/i.test(m)) return `google/${m}`;
  if (/^grok/i.test(m)) return `x-ai/${m}`;
  if (/^deepseek/i.test(m)) return `deepseek/${m}`;
  return m;
}

/** Display price for a tier in an error message. toFixed(2) alone renders the
 *  $0.002 stealth tier as "$0.00" - a free-looking price in a self-correcting
 *  400 is worse than no price at all. */
export function tierPriceLabel(price) {
  return price < 0.01 ? price.toFixed(3) : price.toFixed(2);
}

export function tierAllows(tierSlug, model) {
  const tier = TIERS[tierSlug];
  if (!tier) return false;
  const id = canonicalModel(model).toLowerCase();
  return tier.prefixes.some((p) => (p.endsWith("/") ? id.startsWith(p) : id === p || id.startsWith(p + "-") || id.startsWith(p + ":")));
}

/** Which gateway tier serves this model - for self-correcting 400s. */
export function tierFor(model) {
  for (const slug of Object.keys(TIERS)) if (tierAllows(slug, model)) return slug;
  return null;
}

const MAX_MESSAGES = 100;
export const MAX_IMAGES = 4;
const MAX_IMAGE_URL_LEN = 2048;
const MAX_N = 4; // `n` multiplies output cost - bounded and priced in the margin clamp

// ---------------------------------------------------------------------------
// Margin clamp - the flat tier price must ALWAYS cover the metered upstream
// bill. Char caps alone can't guarantee that: token-dense text (CJK packs
// 4-8x more tokens per char than English), giant tool schemas, `n`
// completions, and expensive model families (opus, o3-pro) can push the
// worst case past the price. So every request is priced BEFORE it goes
// upstream: estimate input tokens on the full outbound body, look up the
// model family's list price, and clamp max_tokens so
// input + output ≤ MARGIN × tier price. Cheap models never feel it (the
// affordable output exceeds the tier cap); pricey models get proportionally
// tighter output - and a request whose INPUT alone busts the budget gets a
// self-explaining 400 instead of a useless clamp.
//
// Upstream list prices (USD per 1M tokens) by canonical-id prefix, longest
// prefix wins. Rounded UP - this table only needs to never UNDERestimate.
// Effective cost is elementwise-min'd with the tier's provider max_price
// bound (OpenRouter refuses pricier providers), so an overestimate here
// can't reject traffic the provider bound already makes safe.
export const MODEL_COST = [
  ["openai/o3-pro", { prompt: 20, completion: 80 }],
  ["openai/o3-mini", { prompt: 1.1, completion: 4.4 }],
  ["openai/o3", { prompt: 2, completion: 8 }],
  ["openai/o4-mini", { prompt: 1.1, completion: 4.4 }],
  ["openai/gpt-5-nano", { prompt: 0.05, completion: 0.4 }],
  ["openai/gpt-5-mini", { prompt: 0.25, completion: 2 }],
  // gpt-5.6 family — explicit entries are LOAD-BEARING: costFor's plain
  // startsWith would otherwise match "openai/gpt-5" and price sol at a fifth
  // of its real cost. -pro variants share their base price and match these
  // prefixes. The per-row comments carry the date each was last read live;
  // the figures BELOW are the source of truth, not this block - it once still
  // said "sol $5/$30" a day after the row beneath it had been corrected to
  // 2/10, so a reader could not tell which to believe. test-gateway-model-ids
  // checks every row against the live catalog on each run.
  ["openai/gpt-5.6-sol", { prompt: 2, completion: 10 }],   // live 2026-08-28 (was 6/35: the clamp cut max_tokens ~3.5x too hard)
  ["openai/gpt-5.6-terra", { prompt: 2, completion: 12 }], // live 2026-08-28: the row was UNDER the real price
  // Nano-tier small models, live 2026-09-02 (exact rows so the clamp prices
  // them at cost instead of the tier bound).
  ["mistralai/ministral-8b-2512", { prompt: 0.15, completion: 0.15 }],
  ["mistralai/ministral-3b-2512", { prompt: 0.1, completion: 0.1 }],
  ["openai/gpt-5.6-luna", { prompt: 0.2, completion: 1.2 }], // live 2026-08-19: $0.20/$1.20 (was $1)
  // gpt-5-pro / gpt-5-image (+ -mini, :batch) sit under the "openai/gpt-5"
  // prefix at far higher rates - explicit so the family rate never prices them
  // (live 2026-08-19: image $10/$10, image-mini $2.5/$2, pro:batch $7.5/$60).
  ["openai/gpt-5-pro", { prompt: 15, completion: 120 }],
  ["openai/gpt-5-image", { prompt: 10, completion: 10 }],
  ["openai/gpt-5", { prompt: 1.25, completion: 10 }],
  ["openai/gpt-4o-mini", { prompt: 0.15, completion: 0.6 }],
  // STILL LIVE upstream at $5/$15 until OpenAI removes it on 2026-10-23, and the
  // "openai/gpt-4o" prefix admits it, so the row stays until the id is gone: with
  // no row the plain gpt-4o price would UNDER-count it (the live guard says so).
  // Delete this row once the live guard reports the id absent.
  ["openai/gpt-4o-2024-05-13", { prompt: 5, completion: 15 }],
  ["openai/gpt-4o", { prompt: 2.5, completion: 10 }],
  ["openai/gpt-4.1-mini", { prompt: 0.4, completion: 1.6 }],
  ["openai/gpt-4.1", { prompt: 2, completion: 8 }],
  // claude-opus covers claude-opus-5 ($5/$25) and -fast ($10/$50) — the $15/$75
  // legacy-opus bound overestimates both, which is the safe direction.
  // Longest prefix wins, so the specific rows below beat the legacy blanket.
  // Verified live on OpenRouter 2026-08-22. The "-fast" variants cost MORE than
  // their base model, so each needs its own row or the base row would
  // UNDERPRICE them.
  ["anthropic/claude-opus-5-fast", { prompt: 10, completion: 50 }],
  ["anthropic/claude-opus-5", { prompt: 5, completion: 25 }],
  ["anthropic/claude-opus-4.7-fast", { prompt: 30, completion: 150 }],
  ["anthropic/claude-opus-4.8-fast", { prompt: 10, completion: 50 }],
  ["anthropic/claude-opus-4.5", { prompt: 5, completion: 25 }],
  ["anthropic/claude-opus-4.6", { prompt: 5, completion: 25 }],
  ["anthropic/claude-opus-4.7", { prompt: 5, completion: 25 }],
  ["anthropic/claude-opus-4.8", { prompt: 5, completion: 25 }],
  // opus-4 and 4.1 genuinely still list at $15/$75.
  ["anthropic/claude-opus", { prompt: 15, completion: 75 }],
  // claude-sonnet covers claude-sonnet-5 — was priced at an anticipated
  // STANDARD $3/$15 to guard against a scheduled 2026-09-01 increase from the
  // $2/$10 intro rate; Anthropic cancelled that increase on 2026-08-10 and
  // made $2/$10 the permanent standard price (confirmed against their own
  // release notes, not just OpenRouter's current listing — the two would
  // read identically before 09-01 either way). Live on OpenRouter at $2/$10.
  ["anthropic/claude-sonnet-4", { prompt: 3, completion: 15 }], // sonnet-4 / 4.5 / 4.6 still list at $3/$15 (live 2026-08-19)
  ["anthropic/claude-sonnet", { prompt: 2, completion: 10 }],
  ["anthropic/claude-3.5-sonnet", { prompt: 3, completion: 15 }],
  ["anthropic/claude-3.7-sonnet", { prompt: 3, completion: 15 }],
  ["anthropic/claude", { prompt: 1, completion: 5 }], // haiku family
  ["google/gemini-2.5-pro", { prompt: 1.25, completion: 10 }], // live 2026-08-28
  ["google/gemini-pro", { prompt: 2.5, completion: 15 }],
  // gemini-3.x — explicit entries: the bare "google/gemini" flash-family rate
  // would underestimate them. Live 2026-08-04: 3.5-flash $1.5/$9, 3.6-flash
  // $1.5/$7.5, 3.1-pro(-preview) $2/$12, lites $0.25-0.30/$1.5-2.5.
  ["google/gemini-3.5-flash-lite", { prompt: 0.4, completion: 3 }],
  ["google/gemini-3.5-flash", { prompt: 2, completion: 10 }],
  ["google/gemini-3.6-flash", { prompt: 0.75, completion: 3.75 }], // live 2026-08-28
  ["google/gemini-3.1-flash-lite", { prompt: 0.4, completion: 2 }],
  ["google/gemini-3.1-pro", { prompt: 2.5, completion: 15 }],
  ["google/gemini", { prompt: 0.4, completion: 2.5 }], // flash family
  ["x-ai/grok", { prompt: 2, completion: 6 }],           // live 2026-08-28 (grok-4.6)
  // deepseek-v4-pro and r1 price above deepseek-chat; explicit so the family
  // rate keeps fitting chat. This prefix covers TWO live pools that repriced
  // three times in two days (completion 3.168 -> 3.96 on -0813; then base
  // v4-pro's 18-provider pool reached prompt $1.91 on 2026-08-20). Prompt is
  // pinned AT v1-chat's max_price prompt cap (2.5), so no provider the tier
  // admits can ever exceed it there — this guard cannot re-fire on prompt;
  // completion 4.5 covers the observed max 3.96 with ~14% headroom.
  ["deepseek/deepseek-v4-pro", { prompt: 2.5, completion: 4.5 }],
  ["deepseek/deepseek-r1", { prompt: 0.8, completion: 2.5 }],
  ["deepseek/", { prompt: 0.6, completion: 2.5 }],
  ["meta-llama/", { prompt: 3.5, completion: 3.5 }],
  ["mistralai/", { prompt: 2, completion: 7.5 }], // mistral-medium-3-5 $1.5/$7.5 (live 2026-08-19)
  ["qwen/", { prompt: 2, completion: 6.4 }], // qwen3.8-max / -2.4t-a95b $2/$6 (live 2026-08-19)
  ["poolside/", { prompt: 0.15, completion: 0.3 }], // laguna xs/s: $0.06-0.09/$0.12-0.18
  // Stealth listing: genuinely $0/$0 upstream (verified on the live catalog
  // 2026-08-22 - pricing.prompt "0", pricing.completion "0", and a real call
  // returned usage.cost 0). A zero row makes the margin clamp a NO-OP by
  // design (see clampToMargin's zero-cost branch); the v1-chat-ox maxPrice
  // bound is what actually holds the margin if the model is ever repriced.
  ["stealth/ox-alpha", { prompt: 0, completion: 0 }],
];

/** Upstream list price for a model (longest matching prefix), or null when
 *  the family is unknown - callers fall back to the tier's max_price bound. */
export function costFor(model) {
  const id = canonicalModel(model).toLowerCase();
  let best = null;
  for (const [prefix, cost] of MODEL_COST) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, cost };
  }
  return best ? best.cost : null;
}

/** Worst-case input multiplier when prompt caching is on: Anthropic bills a
 *  cache write at 1.25x list input (5-minute TTL; 1h would be 2x and is
 *  refused). Everyone else caches implicitly at <= list. */
export function cacheWriteFactor(model) {
  return canonicalModel(model).toLowerCase().startsWith("anthropic/") ? 1.25 : 1;
}

/** Tokenizer correction for the margin clamp.
 *
 *  The clamp prices the outbound body with an o200k BPE count, which is the
 *  right shape for OpenAI-family models. Anthropic states plainly that "Claude
 *  4.7 and later models and Claude Mythos Preview use a newer tokenizer... This
 *  tokenizer produces approximately 30% more tokens for the same text" (their
 *  own pricing page, read 2026-08-22). Claude Sonnet 4.6 and earlier use the
 *  previous tokenizer.
 *
 *  Without this the clamp UNDERCOUNTS input on every Opus-5 / Fable-5 call by
 *  roughly a third, which is the unsafe direction: it lets a body through that
 *  costs more than the bound we computed for it. 1.35 leaves a little room over
 *  the stated 30%, since the real increase "depends on the content".
 */
export const NEW_TOKENIZER_FACTOR = 1.35;
export function tokenizerFactor(model) {
  const m = canonicalModel(model).toLowerCase();
  if (!m.startsWith("anthropic/")) return 1;
  // The models on the OLD tokenizer, by their own documentation.
  if (/claude-(3|3\.5|3\.7|sonnet-4|opus-4(\.[0-6])?|haiku-4)/.test(m)) return 1;
  return NEW_TOKENIZER_FACTOR;
}

/** Buyer's prompt-cache preference (top-level OpenRouter `cache_control`):
 *  default ON as {type:"ephemeral"} (5m). `false`/null turns it off. A 1h
 *  TTL doubles Anthropic cache-write cost, so it is refused with guidance.
 *  Call-time only - it never changes the answer, so it is NOT part of the
 *  normalized body / cache key. Exported for the gateway test. */
export function cacheControlPref(input) {
  const cc = input?.cache_control;
  if (cc === undefined) return { type: "ephemeral" };
  if (cc === false || cc === null) return null;
  if (!cc || typeof cc !== "object" || Array.isArray(cc)) throw bad('"cache_control" must be {type:"ephemeral"} (optional ttl:"5m"), or false to disable prompt caching');
  if (cc.type !== "ephemeral") throw bad('"cache_control.type" must be "ephemeral"');
  if (cc.ttl !== undefined && cc.ttl !== "5m") throw bad('"cache_control.ttl" must be "5m" - the 1h tier doubles cache-write cost and is not offered at these flat prices');
  return { type: "ephemeral" };
}

export const MARGIN = 0.7;   // worst-case upstream ≤ 70% of the tier price
const MIN_OUT_TOKENS = 64;   // a clamp below this is useless - reject with guidance instead
const IMAGE_TOKENS = 1600;   // conservative flat per-image input estimate (high-detail tiling)
// Per-model overrides (longest prefix wins). OpenAI bills gpt-4o-mini image
// input at ~33x the 4o token count (2,833 base + 5,667 per 512px tile, up to
// 8 tiles at high detail = ~48k tokens, ~$0.0072/image at $0.15/M) so that a
// "cheap" model costs the same dollars per image as 4o - the flat 1,600 under-
// priced it ~30x and four images on the $0.02 tier were ~$0.029 of upstream
// (security review 2026-08-19). gpt-4.1-nano/mini use patch multipliers
// (2.46x / 1.62x on <=1,536 patches): ~3.8k / ~2.5k worst case.
const IMAGE_TOKENS_BY_MODEL = [
  ["openai/gpt-4o-mini", 48_200],
  ["openai/gpt-4.1-mini", 2_500],
];
export function imageTokensFor(model) {
  const m = String(model || "");
  let best = null;
  for (const [prefix, tok] of IMAGE_TOKENS_BY_MODEL) if (m.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, tok];
  return best ? best[1] : IMAGE_TOKENS;
}
const TOKEN_SAFETY = 1.15;   // headroom for BPE drift across vendors

// ---------------------------------------------------------------------------
// SERVER TOOLS - OpenRouter-executed tools inside an agent loop.
//
// History: every `tools` entry whose type was not "function" was refused
// (2026-08-04) because server-tool spend was "bounded by NEITHER max_tokens
// nor provider.max_price". That was correct at the time. OpenRouter has since
// shipped a per-request loop budget, verified against their live OpenAPI
// document and docs on 2026-08-22:
//
//   StopServerToolsWhenMaxCost: "Stop once cumulative cost across the loop
//   exceeds this dollar threshold." -> {type:"max_cost", max_cost_in_dollars}
//   StopServerToolsWhenStepCountIs: "Stop after the agent loop has executed
//   this many steps."               -> {type:"step_count_is", step_count}
//   StopServerToolsWhen (array, minItems 1) sits on ChatRequest,
//   MessagesRequest and ResponsesRequest as `stop_server_tools_when`, and
//   "When set, this overrides `max_tool_calls`" (default 30, max 30).
//
// READ THE WORD "exceeds". max_cost is a stop-AFTER-exceed condition, and the
// schema adds: "When a condition fires while the model is still emitting tool
// calls, the pending tool calls are executed and one final turn is made with
// tool calls disabled." So a request can overshoot max_cost by one step plus
// one model turn. A bound we cannot verify is not a bound, so max_cost is NOT
// what this margin arithmetic rests on. It rides as a belt.
//
// THE BOUND is deterministic and per-tool:
//   * `max_uses` - "Once the limit is reached, further search calls return an
//     error result instead of executing" (web_search and web_fetch). A hard
//     count, enforced at the tool, so parallel tool calls in one step cannot
//     overshoot the DOLLAR side.
//   * a PINNED engine with a published per-call price, so a use costs a known
//     number of dollars. Verified 2026-08-22:
//       web_search, Exa: instant/fast/auto $0.007, deep-lite/deep $0.012,
//         deep-reasoning $0.015 per request. (Native provider search is billed
//         by the provider at rates we do not control and forwards `max_uses`
//         only to Anthropic - so `engine` is pinned to "exa", never "auto".)
//       web_fetch, engine "openrouter" (direct HTTP fetch): "Free". Exa and
//         Parallel are $1 per 1,000 fetches; Firecrawl is BYOK.
//       datetime: "no additional cost beyond standard token usage".
//   * `max_characters` / `max_content_tokens` - a hard per-result content cap,
//     which is what bounds the TOKEN side.
//
// REFUSED, and why (each of these would be a spend we cannot bound):
//   openrouter:subagent, openrouter:advisor, openrouter:fusion - each spawns
//     further model calls, on a model the CALLER names ("any OpenRouter
//     model"), with `max_completion_tokens` defaulting to the provider default
//     and no evidence our provider.max_price reaches the inner call. A $0.10
//     request could delegate to claude-opus.
//   openrouter:image_generation - per-image upstream spend at image-model
//     rates; we sell images at $0.08 on their own route with their own bound.
//   openrouter:shell, openrouter:bash, openrouter:apply_patch,
//     openrouter:tool_search, openrouter:experimental__search_models -
//     sandbox/compute or catalog surfaces with no published per-call price.
//   openrouter:files - "files come from the API key's workspace", i.e. OUR
//     workspace. A read/write surface on our own account is not a thing a
//     buyer gets for $0.10.
//   mcp, code_interpreter, computer_use_preview, file_search - not accepted in
//     a Chat Completions `tools` array by OpenRouter anyway, and `mcp` would
//     let a buyer point our account at an arbitrary server_url with arbitrary
//     headers. Refused explicitly so the answer does not depend on upstream.
//   web_search / web_search_preview (the OpenAI-syntax shorthand) - it is
//     "automatically converted to openrouter:web_search" upstream, which would
//     hand the ENGINE choice back to the buyer. Refused with a pointer to the
//     bounded spelling.
//
// tokensPerUse is what one use injects back into the prompt, with headroom.
// Every subsequent model turn re-bills the whole accumulated transcript, so
// the arithmetic below charges the full injected budget on EVERY turn - a
// deliberate over-estimate of the true triangular growth.
export const SERVER_TOOL_POLICY = {
  "openrouter:web_search": {
    feeUsdPerUse: 0.007, // Exa, mode auto - the published request price
    // Cost-neutral narrowing a buyer may still ask for. Domain filters only
    // ever shrink the result set and never change the per-request price.
    buyerParams: ["allowed_domains", "excluded_domains"],
    // Everything a buyer must NOT set: each of these moves either the dollar
    // price (engine/mode) or the token volume (results/characters/uses).
    pin(limits) {
      return {
        engine: "exa",   // never "auto": native search is priced by the provider
        mode: "auto",    // $0.007; deep-lite/deep are $0.012, deep-reasoning $0.015
        max_uses: limits.max_uses,
        max_results: limits.max_results,
        max_total_results: limits.max_uses * limits.max_results,
        max_characters: limits.max_characters,
      };
    },
    // Exa highlights: max_results x max_characters, ~4 chars/token, plus
    // framing (title/url/JSON) and BPE headroom.
    tokensPerUse: (l) => Math.ceil((l.max_results * l.max_characters / 4) * TOKEN_SAFETY) + 200,
  },
  "openrouter:web_fetch": {
    feeUsdPerUse: 0, // engine "openrouter" is priced "Free" (Exa/Parallel are $0.001)
    buyerParams: ["allowed_domains", "blocked_domains"],
    pin(limits) {
      return {
        engine: "openrouter", // never "auto": that falls back to Exa/native, both priced
        max_uses: limits.max_uses,
        max_content_tokens: limits.max_content_tokens,
      };
    },
    tokensPerUse: (l) => Math.ceil(l.max_content_tokens * TOKEN_SAFETY) + 200,
  },
  "openrouter:datetime": {
    feeUsdPerUse: 0, // "no additional cost beyond standard token usage"
    buyerParams: ["timezone"], // a string, cost-neutral
    pin: () => ({}),
    tokensPerUse: () => 200,
  },
};

/** Server-tool types OpenRouter accepts that we deliberately do not sell, with
 *  the reason a buyer gets back. Anything not listed here and not in
 *  SERVER_TOOL_POLICY falls through to the generic refusal. */
const SERVER_TOOL_REFUSALS = {
  "openrouter:subagent": "it delegates to another model of your choosing, whose spend is not bounded by this tier's price",
  "openrouter:advisor": "it consults another model of your choosing, whose spend is not bounded by this tier's price",
  "openrouter:fusion": "it fans out to a panel of models, whose spend is not bounded by this tier's price",
  "openrouter:image_generation": "image generation is metered per image - POST /v1/images/generations sells it with its own bound",
  "openrouter:shell": "sandboxed compute has no per-call price we can bound",
  "openrouter:bash": "sandboxed compute has no per-call price we can bound",
  "openrouter:apply_patch": "it operates on a hosted workspace, not on your request",
  "openrouter:files": "it reads and writes files in the API key's workspace, which is ours, not yours",
  "openrouter:tool_search": "deferred tool loading has no per-call price we can bound",
  "openrouter:experimental__search_models": "it is an experimental catalog surface with no per-call price we can bound",
  mcp: "a buyer-supplied MCP server URL is an unbounded outbound call from our account",
  code_interpreter: "hosted code execution has no per-call price we can bound",
  computer_use_preview: "hosted computer use has no per-call price we can bound",
  file_search: "it reads vector stores on our account, not yours",
  web_search: 'the OpenAI-syntax shorthand hands the search ENGINE back to the caller - use {type:"openrouter:web_search"} instead, which we bound',
  web_search_preview: 'the OpenAI-syntax shorthand hands the search ENGINE back to the caller - use {type:"openrouter:web_search"} instead, which we bound',
};

/** The server-tool entries in a validated body, paired with the tier limits
 *  that were pinned onto them. Empty for every request that carries none, so
 *  every number below collapses to today's arithmetic. */
export function serverToolsIn(body, tier) {
  const cfg = tier?.serverTools;
  if (!cfg || !Array.isArray(body?.tools)) return [];
  return body.tools
    .filter((t) => t && typeof t === "object" && Object.hasOwn(SERVER_TOOL_POLICY, t.type) && Object.hasOwn(cfg.tools, t.type))
    .map((t) => ({ type: t.type, limits: cfg.tools[t.type], policy: SERVER_TOOL_POLICY[t.type] }));
}

/** The server-owned `stop_server_tools_when` array for an outbound body, or
 *  null when the request carries no server tool (the field is then absent and
 *  the request is byte-identical to today's). Verified against OpenRouter's
 *  live OpenAPI document 2026-08-22: StopServerToolsWhen is an array of
 *  discriminated conditions on ChatRequest.stop_server_tools_when, and
 *  "When set, this overrides `max_tool_calls`". */
export function stopServerToolsFor(body, tier) {
  const st = serverToolWorstCase(body, tier);
  if (!st.steps) return null;
  return [
    { type: "step_count_is", step_count: st.steps },
    { type: "max_cost", max_cost_in_dollars: +(tier.price * MARGIN).toFixed(6) },
  ];
}

/** Worst-case server-tool footprint for an outbound body: the dollar fee we
 *  may be billed for tool execution, the tokens the results inject, and the
 *  number of MODEL turns the loop can make. `turns` is 1 (today's behaviour)
 *  whenever the request carries no server tool. */
export function serverToolWorstCase(body, tier) {
  const entries = serverToolsIn(body, tier);
  if (!entries.length) return { feeUsd: 0, injectedTokens: 0, turns: 1, steps: 0 };
  let feeUsd = 0, injectedTokens = 0;
  for (const { limits, policy } of entries) {
    feeUsd += policy.feeUsdPerUse * limits.max_uses;
    injectedTokens += policy.tokensPerUse(limits) * limits.max_uses;
  }
  // The loop halts after maxSteps steps and makes one final turn with tools
  // disabled (the documented behaviour when a stop condition fires).
  const steps = tier.serverTools.maxSteps;
  return { feeUsd, injectedTokens, turns: steps + 1, steps };
}

// BPE in bounded pieces. gpt-tokenizer's merge loop is quadratic in the length
// of a single pre-token chunk, and the pre-tokenizer only splits on spaces,
// punctuation and script changes - so one unbroken run of CJK is ONE chunk.
// Measured 2026-08-25 on 100k chars: unbroken CJK 23.8 s whole vs 0.03 s in
// 1 KB pieces (same count); random CJK 0.26 s in 1 KB pieces vs 0.8 s in 4 KB
// (a single 20k-char chunk alone took 0.9 s); English 4 ms either way, +0.34%
// tokens in pieces. This runs on the request path on text a buyer chooses, so
// the bound is the point.
//
// Piecewise is NOT guaranteed >= exact: BPE is not sub-additive across a cut
// (merges ranked bc < ab < cd give "abcd" -> 3 tokens but "ab"+"cd" -> 2), and
// against the o200k table the piecewise count came out ONE token lower on ~1%
// of random cuts. A buyer cannot choose the cut points, but a margin bound
// should not rest on that, so one token is added per boundary: the result is
// then structurally >= exact, and over by at most ~1 token per KB.
// Pieces are cut on code-point boundaries so a surrogate pair is never split.
const TOKEN_COUNT_PIECE = 1024;
function countInPieces(count, text) {
  if (text.length <= TOKEN_COUNT_PIECE) return count(text);
  let n = 0, pieces = 0;
  for (let i = 0; i < text.length;) {
    let j = Math.min(text.length, i + TOKEN_COUNT_PIECE);
    const c = text.charCodeAt(j - 1);
    if (c >= 0xd800 && c <= 0xdbff && j < text.length) j++;
    n += count(text.slice(i, j));
    pieces++;
    i = j;
  }
  return n + (pieces - 1);
}
const countTokensBounded = (text) => countInPieces(countTokens, text);
// Same bound for the embeddings encoder (cl100k): one 16k-char unbroken item
// was a single quadratic chunk, 353 ms measured, on a default-on cache path.
const countEmbeddingTokensBounded = (text) => countInPieces(countEmbeddingTokens, text);

function estimateInputTokens(body, imageCount) {
  // Price the ENTIRE outbound body - messages, tools, response_format, stop
  // sequences - so a giant tool schema is input like any other input. Image
  // URLs are excluded from the text count (a data: URL is not prompt text)
  // and billed flat per image instead. Exact-BPE via gpt-tokenizer (o200k),
  // counted in bounded pieces (see countTokensBounded); deterministic, so the
  // prompt-cache key stays stable.
  const probe = { ...body };
  delete probe.max_tokens;
  const text = JSON.stringify(probe, (k, v) => (k === "image_url" ? undefined : v));
  return Math.ceil(countTokensBounded(text) * TOKEN_SAFETY) + imageCount * imageTokensFor(body.model);
}

/** Worst-case upstream bill (USD) for an outbound body at this tier:
 *  exact-BPE input pricing plus the full output cap × n, against the model's
 *  list cost elementwise-min'd with the tier's provider max_price bound.
 *  This is THE pricing function the margin clamp uses - the pricing-margin
 *  CI test (scripts/test-pricing-margin.js) imports it so the test and the
 *  runtime can never disagree on the math. */
export function worstCaseUpstreamCost(body, tier, imageCount = 0) {
  const listed = costFor(body.model) || tier.maxPrice;
  // Flat tiers bound the provider price with `max_price` (tier.maxPrice), so
  // the worst case is the min of the two. The METERED tier quotes the model's
  // own row and sends THAT row as its bound (`costFor` in the handlers), so
  // its quote must not be min'd with a ceiling the request never carries
  // (review 2026-08-27: opus-4.7-fast at 30/150 quoted as 20/100, ~30% under).
  const cost = tier.metered ? { prompt: listed.prompt, completion: listed.completion } : {
    prompt: Math.min(listed.prompt, tier.maxPrice.prompt),
    completion: Math.min(listed.completion, tier.maxPrice.completion),
  };
  // A tier may inject upstream input of its own (the grounded tier's web
  // results ride into the prompt as tokens - measured ~700 tokens/result) and
  // carry a fixed per-call upstream fee (the search itself, billed per
  // request on top of tokens). Both are the tier's cost, not the buyer's
  // input, and both are priced here so the clamp stays an honest bound.
  // Server tools (see SERVER_TOOL_POLICY) turn one call into a bounded agent
  // loop: up to `turns` model turns, each re-billing the whole accumulated
  // transcript, plus a per-use execution fee. `st` is all-zero / turns:1 for
  // every request that carries none, so the numbers below are byte-identical
  // to the pre-server-tools arithmetic on those.
  const st = serverToolWorstCase(body, tier);
  const inTokens = (estimateInputTokens(body, imageCount) + (tier.extraInputTokens || 0) + st.injectedTokens) * st.turns;
  // Prompt caching rides by default (top-level cache_control, see
  // cacheControlPref): on Anthropic a cache WRITE bills 1.25x list input
  // (reads 0.1x), so the worst case for a first-seen long prompt is 1.25x -
  // priced in here so the clamp stays an honest bound; every other provider
  // caches implicitly at list price or below.
  const inUsd = (inTokens / 1e6) * cost.prompt * cacheWriteFactor(body.model) * tokenizerFactor(body.model);
  const fixedUsd = (Number(tier.fixedUpstreamUsd) || 0) + st.feeUsd;
  const n = body.n || 1;
  // Every turn of the loop can produce a full output cap, so the output side
  // scales with turns exactly like the input side.
  const outUsd = ((Number(body.max_tokens) || 0) / 1e6) * cost.completion * n * st.turns;
  return { inTokens, inUsd, fixedUsd, outUsd, totalUsd: inUsd + fixedUsd + outUsd, cost, serverTools: st };
}

/** Shrinks body.max_tokens so the worst-case upstream bill stays ≤ MARGIN ×
 *  the tier price; throws a self-explaining 400 when the INPUT alone busts
 *  the budget. Exported for the failover chain walk (each fallback model is
 *  re-clamped at its own cost) and for the pricing-margin CI test. */
export function clampToMargin(body, tier, imageCount) {
  // Metered tier: the 402 quote IS the worst case times the markup, so there
  // is nothing to clamp against - the ceiling grows with the request. The
  // per-call cap (maxQuoteUsd) is enforced in validateRequest instead.
  if (tier.metered) return;
  const { inUsd, fixedUsd, inTokens, cost, serverTools } = worstCaseUpstreamCost(body, tier, imageCount);
  const budgetUsd = tier.price * MARGIN;
  const n = body.n || 1;
  // A server-tool loop can produce a full output cap on every turn, so the
  // affordable output is divided by turns as well as by n. `turns` is 1 for
  // every request that carries no server tool.
  const turns = serverTools.turns;
  // ZERO-COST MODEL (a free/stealth listing priced 0/0 in MODEL_COST): the
  // affordable-output division would be x/0 = Infinity, or 0/0 = NaN when the
  // input happens to consume the budget exactly - and NaN silently fails both
  // comparisons below, so it would neither clamp nor reject. Handle it
  // explicitly: output tokens genuinely cost nothing, so the only remaining
  // bound is the tier's own maxTokens cap (already applied in
  // validateRequest). The INPUT side still has to clear the budget - a tier
  // with a fixed per-call upstream fee (fixedUpstreamUsd) can bust it even at
  // a zero token rate - so that check is kept.
  if (!(cost.completion > 0)) {
    if (inUsd + fixedUsd > budgetUsd) {
      throw bad(
        `Input is too large for "${body.model}" at this tier's price (est. ${inTokens} input tokens). ` +
        `Shrink the input, lower "n", or use a cheaper model - GET /v1/models lists every model and its tier.`
      );
    }
    return;
  }
  const affordableOut = Math.floor(((budgetUsd - inUsd - fixedUsd) * 1e6) / cost.completion / n / turns);
  if (affordableOut < MIN_OUT_TOKENS) {
    throw bad(
      `Input is too large for "${body.model}" at this tier's price (est. ${inTokens} input tokens` +
      `${turns > 1 ? `, across up to ${turns} server-tool loop turns` : ""}). ` +
      `Shrink the input${turns > 1 ? ', drop the "tools" server-tool entries' : ""}, lower "n", or use a cheaper model - GET /v1/models lists every model and its tier.`
    );
  }
  if (body.max_tokens > affordableOut) body.max_tokens = affordableOut;
}

/** Per-block `cache_control` (Anthropic's explicit cache markers ride inside
 *  content blocks too): only the 5-minute ephemeral cache is priced - the 1h
 *  TTL writes at 2x input, over the 1.25x the margin clamp assumes. The
 *  top-level field is checked in cacheControlPref; this closes the per-block
 *  path on every wire (security review 2026-08-19). */
export function checkBlockCacheControl(cc, where) {
  if (cc === undefined || cc === null) return;
  if (typeof cc !== "object" || Array.isArray(cc)) throw bad(`${where}.cache_control must be an object like {type:"ephemeral"}`);
  if (cc.type !== undefined && cc.type !== "ephemeral") throw bad(`${where}.cache_control.type must be "ephemeral"`);
  if (cc.ttl !== undefined && cc.ttl !== "5m") throw bad(`${where}.cache_control.ttl "${String(cc.ttl).slice(0, 10)}" is not offered - the 1-hour cache writes at 2x input and is outside this tier's price; use the default 5-minute TTL`);
}
function contentChars(content) {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (!Array.isArray(content)) throw bad('"content" must be a string or an array of content blocks');
  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") throw bad("Each content block must be an object with a type field");
    checkBlockCacheControl(block.cache_control, "content block");
    if (block.type === "text") {
      if (typeof block.text !== "string") throw bad('Text content block must have "text" (string)');
      chars += block.text.length;
    } else if (block.type === "image_url") {
      const url = typeof block.image_url?.url === "string" ? block.image_url.url : "";
      if (!url) throw bad("image_url.url is required");
      if (url.length > MAX_IMAGE_URL_LEN && !url.startsWith("data:")) throw bad(`image_url.url too long (max ${MAX_IMAGE_URL_LEN})`);
      if (url.startsWith("data:") && url.length > 1_500_000) throw bad("data: image too large (max ~1MB)");
      images++;
    } else {
      throw bad(`Unknown content block type "${block.type}". Allowed: text, image_url`);
    }
  }
  return { chars, images };
}

// OpenAI request params passed through verbatim when present. Everything else
// (stream, unknown fields) is dropped or rejected explicitly.
const PASSTHROUGH = [
  "temperature", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty",
  "response_format", "tools", "tool_choice", "parallel_tool_calls", "logprobs", "top_logprobs", "n",
];

/** Refuse the model variants that change COST rather than routing. Shared by
 *  every wire (chat, Messages, Responses): the first two wires shipped without
 *  this and accepted "<model>:online" on nano (security review 2026-08-19). */
export function refuseCostVariants(model) {
  const variant = String(model || "").includes(":") ? String(model).slice(String(model).indexOf(":") + 1).toLowerCase() : "";
  if (variant === "online") throw bad(`Model variant ":online" is not offered - web search is billed per request on top of token pricing and is outside this tier's price. Use "${String(model).slice(0, String(model).indexOf(":"))}" instead (or POST /v1/grounded/chat/completions for grounded answers).`);
  if (variant === "batch") throw bad(`Model variant ":batch" is not offered - batch ids are asynchronous (24h window) and not served on a synchronous path. Use "${String(model).slice(0, String(model).indexOf(":"))}" instead.`);
}
/** Which routes currently sell a given server tool - used so a refusal on the
 *  budget tiers names where the tool DOES live instead of just saying no. */
function tiersOfferingServerTool(type) {
  return Object.values(TIERS)
    .filter((t) => t.serverTools && Object.hasOwn(t.serverTools.tools, type))
    .map((t) => `${t.route.split(" ")[1]} ($${t.price})`);
}

/** One `tools` entry. Function tools pass through unchanged. An allowlisted
 *  server tool is REWRITTEN with the tier's server-owned limits pinned onto
 *  it - a buyer may narrow (domain filters) but can never widen, because the
 *  pinned object replaces theirs rather than merging into it. Everything else
 *  is a self-explaining 400. */
export function validateToolEntry(t, tier) {
  if (t && typeof t === "object" && t.type === "function") {
    if (!t.function || typeof t.function !== "object") {
      throw bad('Unsupported tools entry (type "function"). An OpenAI function tool is {type:"function", function:{name, description, parameters}}.');
    }
    return t;
  }
  const type = t && typeof t === "object" ? String(t.type ?? "") : "";
  const shown = type.slice(0, 60);
  const policy = Object.hasOwn(SERVER_TOOL_POLICY, type) ? SERVER_TOOL_POLICY[type] : null;
  if (policy) {
    const limits = tier.serverTools && Object.hasOwn(tier.serverTools.tools, type) ? tier.serverTools.tools[type] : null;
    if (!limits) {
      const homes = tiersOfferingServerTool(type);
      throw bad(
        `Server tool "${shown}" is not available on ${tier.route.split(" ")[1]}. ` +
        `A server-tool loop runs extra model turns and (for search) a per-request execution fee, which this tier's price does not cover. ` +
        (homes.length ? `It is available on ${homes.join(" and ")}.` : "It is not currently available on any tier.")
      );
    }
    // Buyer parameters: only the cost-neutral ones, and only in the shapes we
    // can check. Anything else is refused by name - a caller who sends
    // max_uses:50 or engine:"native" is trying to change what this costs.
    const params = t.parameters;
    if (params !== undefined) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw bad(`"parameters" on server tool "${shown}" must be an object`);
      }
      for (const k of Object.keys(params)) {
        if (!policy.buyerParams.includes(k)) {
          throw bad(
            `"${k}" is not accepted on server tool "${shown}" - it changes what the call costs, and the loop budget is server-owned. ` +
            (policy.buyerParams.length ? `Accepted here: ${policy.buyerParams.join(", ")}.` : "No parameters are accepted here.")
          );
        }
        const v = params[k];
        const okShape = k === "timezone"
          ? typeof v === "string" && v.length <= 64
          : Array.isArray(v) && v.length <= 20 && v.every((d) => typeof d === "string" && d.length <= 253);
        if (!okShape) throw bad(`"${k}" on server tool "${shown}" must be ${k === "timezone" ? "an IANA timezone string" : "an array of at most 20 domain strings"}`);
      }
    }
    const kept = {};
    for (const k of policy.buyerParams) if (params && params[k] !== undefined) kept[k] = params[k];
    return { type, parameters: { ...kept, ...policy.pin(limits) } };
  }
  const why = Object.hasOwn(SERVER_TOOL_REFUSALS, type) ? SERVER_TOOL_REFUSALS[type] : null;
  const allowed = tier.serverTools ? Object.keys(tier.serverTools.tools) : [];
  throw bad(
    `Unsupported tools entry${type ? ` (type "${shown}")` : ""}. ` +
    (why ? `"${shown}" is not offered: ${why}. ` : "") +
    'The gateway accepts OpenAI function tools ({type:"function", function:{name, description, parameters}})' +
    (allowed.length ? ` and these server tools on ${tier.route.split(" ")[1]}: ${allowed.join(", ")}.` : ". Server-side tool types (openrouter:*) are not available on this tier - their upstream spend is not covered by the flat per-call price.")
  );
}

// `clamp:false` returns the normalized body WITHOUT the margin clamp - for the
// prompt-cache key only. The clamp is where the tokenizer runs, and the cache
// key is computed BEFORE the paywall (the free byte-identical replay), so with
// the clamp inside it an unauthenticated 100 KB body cost the event loop up to
// ~0.7 s per request (2026-08-25 review). The key never needed max_tokens to be
// clamped: both the pre-paywall read and the deferred write derive it the same
// way, so hits are unchanged, and the clamp still runs in the handler, i.e.
// only once a 402 has been cleared.
export function validateRequest(input, tierSlug, { clamp = true } = {}) {
  const tier = TIERS[tierSlug];
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");

  let model = canonicalModel(input.model);
  // Locked-model tiers (the stealth tier): the route IS the model. A buyer
  // sending a different model gets a self-explaining 400 naming where that
  // model lives, exactly like the cross-tier errors below - never a silent
  // substitution.
  if (tier.lockedModel) {
    if (model && model !== tier.lockedModel) {
      const home = tierFor(model);
      throw bad(
        `${tier.route.split(" ")[1]} serves only "${tier.lockedModel}" - the model is locked to this route. ` +
        (home && home !== tierSlug
          ? `"${model}" is served by the ${home} tier: call ${TIERS[home].route.split(" ")[1]} (price $${tierPriceLabel(TIERS[home].price)}/call).`
          : `Omit "model" (or send "${tier.lockedModel}"); GET /v1/models lists every model and its tier.`)
      );
    }
    model = tier.lockedModel;
  }
  if (tier.router === true && (!model || model === "auto")) {
    // Auto tier, no model (or model:"auto") → deterministic eval-ranked pick
    // from the requested quality band (default balanced). Resolving HERE (not
    // in the handler) keeps promptCacheKey correct: the resolved model is
    // part of the normalized body, so cached entries invalidate cleanly when
    // the ranking table changes - and two qualities that resolve to the same
    // model rightly share one cache entry.
    const quality = input.quality === undefined ? "balanced" : String(input.quality);
    if (!AUTO_QUALITIES.includes(quality)) {
      throw bad(`"quality" must be one of: ${AUTO_QUALITIES.join(", ")} (default balanced)`);
    }
    model = AUTO_RANKINGS[quality][classifyPrompt(input.messages)][0];
  } else if (tier.router === true && input.quality !== undefined) {
    throw bad('"quality" applies only when the gateway picks the model - omit "model" (or send "auto") to use it');
  }
  let defaultedModel = null;
  if (!model && tier.defaultModel) { model = tier.defaultModel; defaultedModel = model; } // serve the tier default, never refuse a missing model (2026-08-28)
  if (!model) throw bad('"model" is required (e.g. "openai/gpt-4o-mini" or "gpt-4o-mini")');
  // Model-id variants that change what is BILLED, not just how it routes.
  // The allowlist's ":variant" match exists for cost-neutral routing hints
  // (:nitro, :floor); these two are not that. Live-verified 2026-08-19
  // against OpenRouter's docs: ":online" attaches the web-search plugin at
  // $0.005-0.007 PER REQUEST on top of tokens (outside provider.max_price and
  // larger than the nano price by itself); ":batch" is the asynchronous batch
  // API (24h window), not a chat completion this path can serve.
  refuseCostVariants(model);
  if (!tierAllows(tierSlug, model)) {
    const home = tierFor(model);
    throw bad(
      home
        ? `Model "${model}" is served by the ${home} tier - call ${TIERS[home].route.split(" ")[1]} (price $${tierPriceLabel(TIERS[home].price)}/call) instead.`
        : `Model "${model}" is not in the gateway allowlist. GET /v1/models lists every supported model and its tier.`
    );
  }

  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) throw bad('"messages" must be a non-empty array of {role, content} objects');
  if (messages.length > MAX_MESSAGES) throw bad(`Too many messages (${messages.length}). Maximum is ${MAX_MESSAGES}`);

  let totalChars = 0;
  let totalImages = 0;
  for (const m of messages) {
    if (!m || typeof m.role !== "string") throw bad('Each message must have "role" (string)');
    if (m.content == null && !m.tool_calls) throw bad('Each message must have "content" (or "tool_calls")');
    if (m.content != null) {
      const { chars, images } = contentChars(m.content);
      totalChars += chars;
      totalImages += images;
    }
  }
  if (totalChars > tier.maxInputChars) throw bad(`Input too large (${totalChars} chars). The ${tierSlug} tier allows up to ${tier.maxInputChars} chars${tierSlug === "v1-chat-metered" ? "" : "; POST /v1/metered/chat/completions takes up to 200k chars and is priced from the body"}`);
  if (totalImages > MAX_IMAGES) throw bad(`Too many images (${totalImages}). Maximum is ${MAX_IMAGES} per request`);

  // OpenAI's newer SDKs send max_completion_tokens (reasoning-model wire);
  // honour it as the alias it is instead of silently defaulting the cap.
  const requestedMax = input.max_tokens != null ? input.max_tokens : input.max_completion_tokens;
  // `defaultMaxTokens` lets a tier whose model REASONS before it speaks hand
  // out a bigger default than the historical 1024 (see v1-chat-ox).
  const tierDefaultMax = Math.min(tier.defaultMaxTokens || 1024, tier.maxTokens);
  let maxTokens = requestedMax != null ? parseInt(requestedMax, 10) : tierDefaultMax;
  if (Number.isNaN(maxTokens) || maxTokens < 1) maxTokens = tierDefaultMax;
  if (maxTokens > tier.maxTokens) maxTokens = tier.maxTokens; // clamp, don't reject - drop-in friendliness
  // Output-token FLOOR, only on tiers that declare one. On a mandatory-
  // reasoning model, reasoning tokens are output tokens: a tiny budget is
  // spent thinking and the answer comes back empty with finish_reason
  // "length" (measured on stealth/ox-alpha at 32 tokens). isEmptyLength
  // already stops that becoming a paid empty 200 - it walks the chain and
  // ends in a 502 that cancels settlement - but a 502 is not a service. So
  // raise a too-small budget to a floor that can actually answer instead
  // (raising is safe here: the floor lives on a tier whose output is free,
  // and the margin clamp still runs afterwards on every tier).
  if (tier.minTokens && maxTokens < tier.minTokens) maxTokens = Math.min(tier.minTokens, tier.maxTokens);

  const body = { model, messages, max_tokens: maxTokens };
  for (const k of PASSTHROUGH) if (input[k] !== undefined) body[k] = input[k];
  // Buyer reasoning preference (changes the answer -> normalized body).
  const reasoning = validateReasoning(input, tier);
  if (reasoning !== undefined) body.reasoning = reasoning;
  // Anthropic's own rule, enforced for every model: the reasoning budget must
  // be strictly below max_tokens. The clamp and the metered quote price
  // `max_tokens` as the whole output; a reasoning budget at or above it would
  // let upstream raise the effective output past what was priced (audit
  // 2026-08-26 - OpenRouter's documented behaviour on Anthropic is to require
  // max_tokens > budget, and we do not rely on it rejecting rather than raising).
  if (reasoning?.max_tokens !== undefined && reasoning.max_tokens >= maxTokens) {
    throw bad(`"reasoning.max_tokens" (${reasoning.max_tokens}) must be below "max_tokens" (${maxTokens}) - reasoning tokens are output tokens and the whole output is what is priced`);
  }
  // Tools are OpenAI function-calling entries ONLY. OpenRouter also serves
  // SERVER-SIDE tool types (openrouter:subagent fans out to up to 10 worker
  // models billed to us at their rates; openrouter:advisor consults pricier
  // models mid-generation) whose spend is bounded by NEITHER max_tokens nor
  // provider.max_price — a $0.003 nano call carrying one would buy upstream
  // work the flat price never covered. The margin clamp prices tools as
  // input tokens; only type:"function" keeps "input tokens" the whole story.
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      throw bad('"tools" must be a non-empty array of {type:"function", ...} or {type:"openrouter:..."} entries');
    }
    body.tools = body.tools.map((t) => validateToolEntry(t, tier));
  }
  // The server-tool loop budget is SERVER-OWNED, exactly like
  // provider.max_price: it is what stands between a flat price and an agent
  // loop. A buyer-supplied value is refused, never merged and never honoured -
  // silently dropping it would leave a buyer believing they had set a budget.
  // (Both fields are outside PASSTHROUGH, so they were already being dropped;
  // this makes the answer explicit instead of silent.)
  for (const k of ["stop_server_tools_when", "max_tool_calls"]) {
    if (input[k] !== undefined) {
      throw bad(`"${k}" is set by the gateway, not by the caller - the server-tool loop budget is what keeps this route's flat price honest. Remove it; the per-tool limits that apply are on GET /v1/models.`);
    }
  }
  // tool_choice mirrors the tools guard. Today it can only select a tool the
  // (guarded) tools array declares, so this is belt-and-suspenders — but if
  // OpenRouter ever accepts a bare server-tool tool_choice, an unshaped
  // passthrough would be the bypass. OpenAI wire: "none"|"auto"|"required"
  // or {type:"function", function:{name}}.
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    const okString = tc === "none" || tc === "auto" || tc === "required";
    const okObject = tc && typeof tc === "object" && tc.type === "function" && typeof tc.function?.name === "string";
    if (!okString && !okObject) {
      throw bad('"tool_choice" must be "none", "auto", "required", or {type:"function", function:{name}}');
    }
  }
  if (body.n !== undefined) {
    const n = parseInt(body.n, 10);
    if (Number.isNaN(n) || n < 1 || n > MAX_N) throw bad(`"n" must be an integer between 1 and ${MAX_N} - each completion is metered output`);
    body.n = n;
  }
  if (input.stream === true) {
    body.stream = true;
    if (input.stream_options !== undefined) body.stream_options = input.stream_options;
  }
  // Zero-data-retention routing: an OpenRouter provider preference, accepted
  // top-level or as provider.zdr. This is the ONLY provider field a buyer may
  // set — everything else (notably max_price) stays server-owned. Part of the
  // normalized body, so zdr and non-zdr responses never share a cache entry.
  if (input.zdr === true || input.provider?.zdr === true) {
    // A stealth/cloaked listing is free BECAUSE the provider keeps the data.
    // Silently dropping zdr here would be the worst outcome: the buyer asked
    // for zero data retention, believed they got it, and their prompt was
    // logged anyway. Refuse with the reason and name a tier that can honour it.
    if (tier.logsPrompts) {
      throw bad(
        `"zdr" is not available on ${tier.route.split(" ")[1]}. "${tier.lockedModel || "This tier's model"}" is a stealth ` +
        "(cloaked) preview listing: the provider serves it at no cost in exchange for RETAINING and reviewing prompts and " +
        "completions, so zero-data-retention routing cannot be honoured here at any price. Send confidential input to a " +
        "priced tier instead - /v1/nano/chat/completions ($0.003), /v1/chat/completions ($0.02), /v1/pro/chat/completions " +
        "($0.10) and /v1/premium/chat/completions ($0.50) all accept zdr:true."
      );
    }
    body.zdr = true;
  }
  cacheControlPref(input); // shape-validate only (400 on a bad value); the preference is call-time, not in the normalized body
  if (clamp) clampToMargin(body, tier, totalImages);
  if (clamp && tier.metered) {
    // Refuse pre-spend anything the tier would quote above its per-call cap:
    // the 402 for such a body carries the cap (payments.js), the handler
    // answers this 400, and >= 400 cancels settlement, so nobody pays for it.
    const q = meteredQuoteFromNormalized(body, totalImages);
    if (q > tier.maxQuoteUsd) {
      throw bad(`This request would cost $${q.toFixed(4)} metered, above the $${tier.maxQuoteUsd} per-call cap of ${tier.route.split(" ")[1]} - lower max_tokens or the input, or use a flat tier (GET /v1/models).`);
    }
  }
  if (defaultedModel) Object.defineProperty(body, "__defaultedModel", { value: defaultedModel, enumerable: false });
  return body;
}

// ---------------------------------------------------------------------------
// Flex service tier - OpenRouter's `service_tier: "flex"` is a 50% discount on
// OpenAI and Google endpoints in exchange for higher latency and lower
// availability, and it NEVER falls back to the default tier on its own (a flex
// capacity error surfaces). So every flex-eligible link is tried twice: flex
// first, then the same model on the default tier, before the chain moves on.
// Eligibility is a live-verified table, not a provider guess: on 2026-08-19
// the gemini-2.5/3.x families and gpt-5-nano / gpt-5.6-* carried a "*/flex"
// endpoint tag; gpt-4o(-mini)/4.1/o3 did not (flex on those would 404 and
// cost a round-trip). scripts/test-gateway-model-ids.js checks every entry
// against /models/{id}/endpoints, so a model that loses flex fails CI instead
// of burning a failed attempt per call. Measured on the live catalog: the
// image model's flex endpoints are exactly half price on every unit incl.
// image_output ($0.000015 vs $0.00003 per token), and images are ~99% of
// this gateway's upstream bill. OPENROUTER_FLEX=off is the escape hatch.
export const FLEX_MODELS = [
  "google/gemini-2.5-flash-image", "google/gemini-2.5-flash-lite", "google/gemini-2.5-flash", "google/gemini-2.5-pro",
  "google/gemini-3.1-flash-lite", "google/gemini-3.5-flash-lite", "google/gemini-3.5-flash", "google/gemini-3.6-flash",
  "openai/gpt-5-nano", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra",
];
const FLEX_ENABLED = () => String(process.env.OPENROUTER_FLEX || "on").toLowerCase() !== "off";
export const PROVIDER_SORT_ENABLED = () => String(process.env.OPENROUTER_PROVIDER_SORT || "on").toLowerCase() !== "off";
export function flexEligible(model) {
  if (!FLEX_ENABLED()) return false;
  const m = String(model || "");
  return FLEX_MODELS.some((p) => m === p || m.startsWith(p + "-"));
}
/** Expand a model chain into attempts: [flex, default] for eligible links,
 *  [default] otherwise. Exported for the gateway test. */
export function flexAttempts(chain) {
  const out = [];
  for (const model of chain) {
    if (flexEligible(model)) out.push({ model, flex: true });
    out.push({ model, flex: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reasoning defaults - the "paid empty answer" guard. Reasoning tokens are
// OUTPUT tokens that count against max_tokens, and several ranked models
// reason by default (gpt-5 family: mandatory, default effort medium; gemini
// 3.x flash: mandatory; claude 5: default on at HIGH). Measured 2026-08-19:
// gpt-5-nano at max_tokens 64 AND 256 with default or "low" effort returned
// finish_reason "length" with EMPTY content - every token spent thinking,
// nothing said, the buyer charged; "minimal" answered. So (a) when the buyer
// sent no reasoning preference, a default-on/mandatory model gets the tier's
// default effort (budget tiers: the lowest non-"none" effort it supports;
// pro: "low"; premium: the model's own default - those buyers bought depth
// and the 8k cap leaves room), (b) a buyer `reasoning`/`reasoning_effort` is
// validated and passed through (it changes the answer -> normalized body ->
// cache key), and (c) an answer that is "length" + empty is treated like an
// empty refusal: the chain walks on, and a chain exhausted end-to-end is a
// 502 (settlement cancelled), never a paid empty 200.
// Table is live-verified by scripts/test-gateway-model-ids.js against
// /models `reasoning.supported_efforts` + `mandatory`/`default_enabled`.
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const REASONING_MODELS = [
  // `id` rows match the exact id (plus ":variant" suffixes such as :batch);
  // `prefix` rows match a whole family. Exact by default: a loose prefix
  // silently pulled in google/gemini-3.1-flash-lite-IMAGE, a different model
  // with a different effort set (caught by the live guard on first run).
  { id: "openai/gpt-5-nano", efforts: ["minimal", "low", "medium", "high"] },
  { prefix: "openai/gpt-5.6-", efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "google/gemini-3.1-flash-lite", efforts: ["minimal", "low", "medium", "high"] },
  { id: "google/gemini-3.5-flash-lite", efforts: ["minimal", "low", "medium", "high"] },
  { id: "google/gemini-3.5-flash", efforts: ["minimal", "low", "medium", "high"] },
  { id: "google/gemini-3.6-flash", efforts: ["minimal", "low", "medium", "high"] },
  { id: "anthropic/claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "anthropic/claude-opus-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  // stealth/ox-alpha: reasoning.mandatory true, default_effort "max" (live
  // catalog 2026-08-22). Without this row defaultReasoningFor returns null,
  // the model reasons at "max" by default and a small budget comes back empty
  // (measured at 32 tokens). Supported efforts are exactly low/high/max - no
  // "minimal", no "medium" - so "lowest" resolves to "low".
  { id: "stealth/ox-alpha", efforts: ["low", "high", "max"] },
];
export function reasoningRowMatches(row, id) {
  const m = String(id || "").toLowerCase();
  if (row.id) return m === row.id || m.startsWith(row.id + ":");
  return !!row.prefix && m.startsWith(row.prefix);
}
export function reasoningProfile(model) {
  const id = canonicalModel(model).toLowerCase();
  let best = null;
  for (const row of REASONING_MODELS) {
    if (!reasoningRowMatches(row, id)) continue;
    const len = (row.id || row.prefix).length;
    if (!best || len > best.len) best = { ...row, len };
  }
  return best;
}
/** The reasoning object to inject for a chain link when the buyer set none:
 *  null = leave the model's default alone. */
export function defaultReasoningFor(model, tierSlug) {
  const prof = reasoningProfile(model);
  if (!prof) return null;
  const policy = TIERS[tierSlug]?.reasoningDefault || "lowest";
  if (policy === "model") return null;
  const nonNone = prof.efforts.filter((e) => e !== "none");
  if (policy === "low") return { effort: nonNone.includes("low") ? "low" : (nonNone[0] || null) };
  // "lowest": the cheapest effort the model supports that still reasons
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const lowest = order.find((e) => nonNone.includes(e));
  return lowest ? { effort: lowest } : null;
}
/** Validate a buyer reasoning preference (OpenRouter `reasoning` object or
 *  OpenAI's `reasoning_effort` string). Returns the normalized object or
 *  undefined when the buyer sent none. */
export function validateReasoning(input, tier) {
  let r = input?.reasoning;
  if (r === undefined && typeof input?.reasoning_effort === "string") r = { effort: input.reasoning_effort };
  if (r === undefined) return undefined;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw bad('"reasoning" must be an object: {effort?: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", max_tokens?: int, exclude?: bool, enabled?: bool}');
  const out = {};
  for (const k of Object.keys(r)) {
    if (!["effort", "max_tokens", "exclude", "enabled"].includes(k)) throw bad(`"reasoning.${k}" is not supported - allowed: effort, max_tokens, exclude, enabled`);
  }
  if (r.effort !== undefined) {
    if (!REASONING_EFFORTS.includes(r.effort)) throw bad(`"reasoning.effort" must be one of: ${REASONING_EFFORTS.join(", ")}`);
    out.effort = r.effort;
  }
  if (r.max_tokens !== undefined) {
    const n = Number(r.max_tokens);
    if (!Number.isInteger(n) || n < 1) throw bad('"reasoning.max_tokens" must be a positive integer');
    if (n > tier.maxTokens) throw bad(`"reasoning.max_tokens" (${n}) exceeds this tier's output cap (${tier.maxTokens}) - reasoning tokens are output tokens`);
    out.max_tokens = n;
  }
  if (r.exclude !== undefined) { if (typeof r.exclude !== "boolean") throw bad('"reasoning.exclude" must be a boolean'); out.exclude = r.exclude; }
  if (r.enabled !== undefined) { if (typeof r.enabled !== "boolean") throw bad('"reasoning.enabled" must be a boolean'); out.enabled = r.enabled; }
  return out;
}
/** "length" with nothing said: the output cap was spent before any content
 *  (reasoning ate it, or the cap was absurdly small). A PAID empty 200 is the
 *  failure; the chain walks on exactly as for an empty refusal. */
export function isEmptyLength(data) {
  const choice = data?.choices?.[0];
  if (!choice) return false;
  if (String(choice.finish_reason || "").toLowerCase() !== "length") return false;
  const m = choice.message || {};
  const hasText = typeof m.content === "string" && m.content.trim() !== "";
  const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  return !hasText && !hasToolCalls;
}

/** Per-buyer identity for OpenRouter's `user` field. OpenRouter scopes provider
 *  abuse/policy blocks to this id; without it every request rides the
 *  ACCOUNT identity, so one abusive buyer could get the whole gateway
 *  provider-blocked. Derived, never raw: sha256 of the x402 payer (the signed
 *  EIP-3009 `from`, same source as src/payer.js) or, when no payer is readable
 *  (SVM/Stellar payloads, MPP `Authorization: Payment` credentials), of the
 *  gate credential itself. Null for non-HTTP callers. Injected at call time
 *  like `provider` - never part of the normalized body or any cache key. */
export function upstreamUserId(req) {
  if (!req) return null;
  let basis = null;
  const payer = payerFromRequest(req);
  if (payer) basis = `payer:${payer}`;
  else {
    const cred = paymentHeaderOf(req) || (typeof req.header === "function" ? req.header("authorization") : null);
    if (cred) basis = `credential:${cred}`;
  }
  // A free-trial call has no payer and no credential, and it is the ONLY path
  // that reaches an upstream without one. Sending no `user` there would leave
  // the single unauthenticated route as the only one with no abuse isolation,
  // which is exactly how one caller gets provider policy applied to the whole
  // account. Fall back to the client address so trial traffic is still scoped.
  if (!basis) {
    const ip = typeof req.ip === "string" ? req.ip : (typeof req.header === "function" ? req.header("x-forwarded-for") : null);
    if (ip) basis = `trial:${String(ip).split(",")[0].trim()}`;
  }
  if (!basis) return null;
  // HMAC, not a bare hash - this one is sent to OPENROUTER, a third party, so an
  // enumerable digest of a public wallet address would hand an outside vendor a
  // way to recover which wallet each request belongs to. Keyed, it still groups
  // a buyer's calls for provider policy while carrying no recoverable identity.
  // Call-time only and never part of a cache key, so changing it is inert.
  const idSecret = process.env.TELEMETRY_ID_SECRET || process.env.POW_SECRET || process.env.MPP_SECRET_KEY || "";
  return idSecret
    ? `a402:${createHmac("sha256", idSecret).update(basis).digest("hex").slice(0, 32)}`
    : `a402:${createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

/** Line-aware SSE pass-through that strips OpenRouter's billing fields from
 *  the usage frame. OpenRouter now includes full usage on EVERY response
 *  with no opt-in (their docs: `usage.include` "has no effect"; verified
 *  live 2026-08-19 - a streamed nano call carried `usage.cost`,
 *  `cost_details` and `is_byok` in its final frame). The non-stream path has
 *  always deleted those before the buyer saw them; the stream path piped raw
 *  bytes, so every streaming buyer was shown our upstream bill. Frames that
 *  carry no usage pass through byte-for-byte; partial lines are buffered
 *  across chunks so a frame split mid-JSON is never forwarded half-scrubbed.
 *  `onUsage(usage, rawCost)` fires once with the stripped cost for telemetry. */
export function createSseUsageScrubber({ onUsage } = {}) {
  let buf = "";
  // fetch's body yields Uint8Array chunks, NOT Buffers: String(Uint8Array) is
  // "100,97,116,97" - the comma-joined bytes - so the old `Buffer.isBuffer(chunk)
  // ? ... : String(chunk)` decode never saw a newline, buffered the whole
  // stream, and handed it to flush() as digits: no "data:" frame was ever
  // recognised and every streamed call 502'd "no data frame" (found 2026-08-27
  // driving Claude Code against the Messages wire; the relay's own unit tests
  // fed Buffers and passed). A streaming TextDecoder also keeps a multibyte
  // character split across two chunks intact, which per-chunk toString did not.
  const decoder = new TextDecoder("utf-8");
  const decode = (chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  // Usage can sit at the top level (chat completions, Anthropic message_delta)
  // or NESTED: the Responses API's final frame is {type:"response.completed",
  // response:{..., usage:{cost,...}}} (live-verified 2026-08-19) and an
  // Anthropic message_start carries message.usage. Every one of those is
  // scrubbed; the first (top-level or nested) usage object feeds telemetry.
  const usageSites = (obj) => [obj?.usage, obj?.response?.usage, obj?.message?.usage].filter((u) => u && typeof u === "object");
  const processLine = (line) => {
    // SSE allows "data:" with OR without the space (the spec strips one
    // optional leading space); OpenRouter emits "data: " today, but a format
    // change must not silently re-open the stream billing leak.
    const m = /^data:\s?/.exec(line);
    if (!m || !line.includes('"usage"')) return line;
    let obj;
    try { obj = JSON.parse(line.slice(m[0].length)); } catch { return line; }
    const sites = obj && typeof obj === "object" ? usageSites(obj) : [];
    if (!sites.length) return line;
    let had = false, reported = false;
    for (const u of sites) {
      const rawCost = typeof u.cost === "number" ? u.cost : null;
      if (("cost" in u) || ("cost_details" in u) || ("is_byok" in u) || ("cache_discount" in u)) had = true;
      delete u.cost; delete u.cost_details; delete u.is_byok; delete u.cache_discount;
      if (!reported && (rawCost !== null || typeof u.prompt_tokens === "number" || typeof u.input_tokens === "number")) {
        reported = true;
        try { onUsage?.(u, rawCost, obj); } catch { /* telemetry never breaks a stream */ }
      }
    }
    return had ? `data: ${JSON.stringify(obj)}` : line;
  };
  return {
    push(chunk) {
      buf += decode(chunk);
      const i = buf.lastIndexOf("\n");
      if (i < 0) return "";
      const complete = buf.slice(0, i);
      buf = buf.slice(i + 1);
      return complete.split("\n").map(processLine).join("\n") + "\n";
    },
    flush() {
      buf += decoder.decode(); // drain a trailing partial multibyte sequence
      const rest = buf; buf = "";
      return rest ? processLine(rest) : "";
    },
  };
}

/**
 * Attribution headers for EVERY OpenRouter request we make. OpenRouter files a
 * call under this app name; without it the call shows up unattributed on the
 * activity export, which is how upstream spend goes missing from a margin
 * review. `scripts/test-openrouter-attribution.js` fails if any call site in
 * src/ reaches openrouter.ai without them.
 */
export const OPENROUTER_ATTRIBUTION = Object.freeze({
  "HTTP-Referer": "https://agent402.tools",
  "X-Title": "Agent402.Tools x402 gateway",
  "X-OpenRouter-Title": "Agent402.Tools x402 gateway",
  "X-OpenRouter-Categories": "personal-agent,api",
});

export async function fetchOpenRouter(body, { timeoutMs, signal, url = OPENROUTER_URL } = {}) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("LLM gateway not configured (OPENROUTER_API_KEY unset)", 503);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...OPENROUTER_ATTRIBUTION,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs ?? 90_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }
}

export async function throwUpstreamError(res) {
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) throw bad("Gateway upstream auth failed", 502);
  if (res.status === 402) throw bad("Gateway upstream balance exhausted - the operator has been notified", 502);
  if (res.status === 429) throw bad("Upstream rate-limited - retry shortly", 503);
  if (res.status >= 500) throw bad(`Upstream error (HTTP ${res.status})`, 502);
  // Redact the FULL body BEFORE slicing/parsing — a secret straddling the
  // 200-char cut would otherwise leave an unredactable prefix. The route binder
  // returns err.message verbatim to buyers and logs it, so this must be clean.
  const safe = redactSecrets(text);
  let msg = safe.slice(0, 200);
  try { msg = JSON.parse(safe).error?.message || msg; } catch { /* keep raw slice */ }
  throw bad(`Upstream error: ${msg}`, 502);
}

/** OpenRouter can answer HTTP 200 with an error object and NO output - a
 *  provider rate limit or provider error surfaced after the response line was
 *  committed. Measured 2026-09-02 on the auto tier's own documented example:
 *  `{"id":"gen-…","error":{"message":"openai/gpt-5.6-luna is temporarily
 *  rate-limited upstream…"}}`, status 200, no choices - and our route relayed
 *  it as a 200, which on prod is a PAID empty answer, the same class the
 *  empty-refusal and empty-length walks exist for. A body that carries an
 *  error and no output is an upstream failure: 503 for a rate limit (the
 *  chain walks on 502/503/504), 502 otherwise. A body with output beside an
 *  error (a partial answer) is returned as-is. Applied at every place a wire
 *  parses an upstream 200. */
export function assertUpstreamBody(data) {
  if (!data || typeof data !== "object" || !data.error) return data;
  const has = (k) => Array.isArray(data[k]) && data[k].length > 0;
  if (has("choices") || has("output") || has("content") || has("data")) return data;
  const err = typeof data.error === "object" ? data.error : { message: String(data.error) };
  const msg = redactSecrets(String(err.message || err.code || "upstream error")).slice(0, 200);
  const code = Number(err.code);
  const rateLimited = code === 429 || /rate.?limit/i.test(msg);
  throw bad(`Upstream error: ${msg}`, rateLimited ? 503 : 502);
}

async function callOpenRouter(body) {
  const res = await fetchOpenRouter(body);
  if (!res.ok) await throwUpstreamError(res);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
  assertUpstreamBody(data);
  // Full OpenAI wire shape passes through untouched (id, object, created,
  // model, choices incl. tool_calls, usage) — drop-in fidelity is the product.
  return data;
}

/** A safety-classifier refusal that produced NOTHING. Claude 5-class models
 *  (Opus 5 / Fable 5, live on OpenRouter since June-July 2026) decline some
 *  prompts as an HTTP 200 with stop_reason "refusal" — OpenRouter surfaces it
 *  as finish_reason "content_filter" and/or native_finish_reason "refusal".
 *  The failover chain only walked on 502/503/504, so an empty refusal would
 *  ride to the buyer as a PAID empty answer. Empty-only on purpose: a refusal
 *  carrying partial content is returned as-is (the buyer gets something and
 *  finish_reason discloses why it stopped); an empty one is walkable, and a
 *  chain that refuses end-to-end surfaces a 502 — which cancels settlement,
 *  so nobody pays for nothing. Exported for the gateway test. */
export function isEmptyRefusal(data) {
  const choice = data?.choices?.[0];
  if (!choice) return false;
  const fr = String(choice.finish_reason || "").toLowerCase();
  const native = String(choice.native_finish_reason || "").toLowerCase();
  if (fr !== "content_filter" && native !== "refusal") return false;
  const m = choice.message || {};
  const hasText = typeof m.content === "string" && m.content.trim() !== "";
  const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  return !hasText && !hasToolCalls;
}

/** Stream the upstream SSE body to the client verbatim (OpenAI wire format:
 *  `data: {chunk}` lines, terminated by `data: [DONE]`). Throws ONLY before
 *  headers are written — once streaming starts, an upstream drop just ends
 *  the stream. Output cost stays bounded: max_tokens was clamped server-side
 *  before the upstream call, so the provider stops the stream at the cap. */
export async function streamOpenRouterTo(body, res, { onUsage, url } = {}) {
  // One controller covers connect AND the whole body read; client disconnect
  // aborts the upstream so a closed tab never keeps burning tokens.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  res.on?.("close", () => ctrl.abort());
  try {
    const upstream = await fetchOpenRouter(body, { signal: ctrl.signal, url });
    if (!upstream.ok) await throwUpstreamError(upstream);
    // The 200 is NOT committed until the first `data:` frame arrives. Measured
    // live (paid canary 2026-08-27 20:06:42Z): OpenRouter answered a nano
    // stream with only ": OPENROUTER PROCESSING" keep-alive comments and then
    // closed - no tokens, no usage frame - and the old relay had already
    // written 200, so the buyer paid $0.003 for an empty stream (settlement
    // runs on a <400 status). Holding the status until real data exists turns
    // that into a 502 before any byte is sent, which the callers' chain walk
    // catches (`!res.headersSent`) and which cancels settlement end to end.
    // Comment-only prelude is bounded so a comment flood cannot buffer forever.
    const scrub = createSseUsageScrubber({ onUsage });
    let committed = false;
    let pending = "";
    const commit = () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      committed = true;
      if (pending) { res.write(pending); pending = ""; }
    };
    const offer = (out) => {
      if (committed) { res.write(out); return; }
      pending += out;
      if (/^data:/m.test(pending) || pending.length > 64_000) commit();
    };
    try {
      // Billing fields are stripped in flight (see createSseUsageScrubber);
      // everything else passes through byte-for-byte.
      for await (const chunk of upstream.body) { const out = scrub.push(chunk); if (out) offer(out); }
      const tail = scrub.flush(); if (tail) offer(tail);
    } catch (e) {
      // Upstream dropped mid-stream: end what we have once something real was
      // sent; before that, it is an upstream failure the chain can walk. The
      // cause is logged either way - a bare catch hid a relay-side throw for a
      // day (2026-08-27: every Messages stream read as "no data frame").
      console.warn(`[gateway] stream relay ${committed ? "dropped mid-stream" : "failed before the first data frame"}: ${e?.message || e}`);
      if (!committed) throw bad("Upstream stream ended before producing any data frame", 502);
    }
    if (!committed) throw bad("Upstream stream ended before producing any data frame (no tokens) - nothing was charged", 502);
    res.end();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Prompt cache — EXPLICIT opt-in (`cache: true` in the request body).
//
// A byte-identical repeat of an already-paid generation is served from this
// cache BEFORE the paywall (see the pre-gate middleware in server.js), so the
// repeat costs the buyer nothing — retry-heavy agent loops stop re-paying for
// work already done. Opt-in is load-bearing: LLM output is sampled, and a
// buyer resending the same prompt often WANTS a fresh sample; only requests
// that declare cache:true ever read or write this cache.
//
// Keying: sha256 over the tier + the NORMALIZED body (validateRequest output,
// stable-stringified), so model aliases (gpt-4o-mini vs openai/gpt-4o-mini)
// and caller field order collapse to one entry, and every sampling-relevant
// field (temperature, seed, max_tokens, …) is part of the key. Pre-paywall
// service is necessarily buyer-agnostic — identical requests share entries.
// Streamed requests are never cached. Values are our own 200 responses.
const PROMPT_CACHE_TTL_MS = 10 * 60 * 1000;
const PROMPT_CACHE_MAX_ENTRIES = 5000;
const PROMPT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const PROMPT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const promptStore = new Map(); // key -> { at, body, bytes } (insertion order ≈ FIFO eviction)
let promptStoreBytes = 0;

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** Cache key for an opted-in, non-streamed gateway request. Throws (via
 *  validateRequest) on invalid input — callers treat that as "no cache" and
 *  let the normal path produce the real 402/400. Returns null for streams. */
export function promptCacheKey(tierSlug, input) {
  if (TIERS[tierSlug]?.noCache) return null; // grounded tier: the web moves, never replay
  const body = validateRequest(input, tierSlug, { clamp: false });
  if (body.stream === true) return null;
  // Same reason as the grounded tier: a server-tool answer is built from a
  // live search or fetch, so replaying it 10 minutes later serves stale web
  // content as if it were fresh. Covers the read AND the deferred write - the
  // handler keys both off this function.
  if (serverToolsIn(body, TIERS[tierSlug]).length) return null;
  return createHash("sha256").update(`${tierSlug}\n${stableStringify(body)}`).digest("hex");
}

export function promptCacheGet(key) {
  if (!key) return null;
  const hit = promptStore.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PROMPT_CACHE_TTL_MS) {
    promptStore.delete(key);
    promptStoreBytes -= hit.bytes;
    return null;
  }
  return hit.body;
}

export function promptCacheStore(key, body) {
  if (!key || body == null) return;
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(body), "utf8"); } catch { return; }
  if (!bytes || bytes > PROMPT_CACHE_MAX_ENTRY_BYTES) return;
  while ((promptStore.size >= PROMPT_CACHE_MAX_ENTRIES || promptStoreBytes + bytes > PROMPT_CACHE_MAX_BYTES) && promptStore.size > 0) {
    const firstKey = promptStore.keys().next().value;
    const ev = promptStore.get(firstKey);
    if (ev) promptStoreBytes -= ev.bytes;
    promptStore.delete(firstKey);
  }
  promptStore.set(key, { at: Date.now(), body, bytes });
  promptStoreBytes += bytes;
}

/** "POST /v1/…" path -> tier slug, for the pre-paywall middleware. */
export const GATEWAY_TIER_BY_PATH = Object.fromEntries(
  Object.entries(TIERS).map(([slug, t]) => [t.route.split(" ")[1], slug])
);

// ---------------------------------------------------------------------------
// Gateway credits status — the /v1 tiers settle the buyer's USDC BEFORE the
// handler runs, so an empty OpenRouter balance turns every gateway call into
// "charged but failed". This probe lets the heartbeat alarm BEFORE that
// happens. Deliberately bucketed ("ok"/"low"/"unknown") — the exact balance
// is operator information and never leaves the server. Cached 5 minutes so
// the public endpoint can't be used to hammer OpenRouter through us.
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_CACHE_MS = 5 * 60 * 1000;
// $15, not $5 (raised 2026-08-19): top-up is manual, and at the margin clamp
// (upstream <= 70% of price) $5 of credits is under an hour of a busy day.
const LOW_CREDITS_USD = () => Number(process.env.OPENROUTER_LOW_CREDITS_USD) || 15;
// The prod key carries its own USD limit (a runaway/leak backstop, set in the
// OpenRouter dashboard, monthly reset). It is a SECOND ceiling: hitting it
// stops the gateway exactly like an empty balance, so it pages on the same
// "low" bucket when the remaining share drops under this fraction.
const LOW_KEY_LIMIT_FRACTION = () => Number(process.env.OPENROUTER_LOW_KEY_LIMIT_FRACTION) || 0.25;
let creditsCache = null; // { at, result }
let creditsUnknownSince = null; // first moment the status went "unknown" (null while readable)
export function _resetCreditsCacheForTest() { creditsCache = null; creditsUnknownSince = null; }

// The management (provisioning) key, when set, is the DOCUMENTED credential
// for /credits; the ordinary API key happens to be accepted there today
// (verified 2026-08-19) and stays the fallback, so the balance leg keeps
// working if the management key is absent or revoked. It is never used for
// /key: that endpoint describes the CALLING key, and the management key has
// no limit of its own - reading it there would report the wrong ceiling.
const OPENROUTER_MANAGEMENT_KEY = () => (process.env.OPENROUTER_MANAGEMENT_KEY || "").trim();

/** Bucketed balance status for /api/gateway-status and the heartbeat alarm.
 *  Reads BOTH ceilings and reports the worse: the account credit balance
 *  (/credits - management key when configured, else the API key) and the
 *  prod key's own limit (/key `limit_remaining`, read with THAT key). Either
 *  alone failing reads "unknown" for that leg; only both unreadable is
 *  "unknown" overall, and a readable leg saying "low" always wins. Numbers
 *  never leave this function - the public payload is buckets only. */
export async function gatewayCreditsStatus() {
  const key = OPENROUTER_KEY();
  if (!key) return { configured: false, status: "unconfigured" };
  if (creditsCache && Date.now() - creditsCache.at < CREDITS_CACHE_MS) return creditsCache.result;
  const readJson = async (url, bearer) => {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  };
  const [credits, keyInfo] = await Promise.all([
    readJson(OPENROUTER_CREDITS_URL, OPENROUTER_MANAGEMENT_KEY() || key),
    readJson(OPENROUTER_KEY_URL, key),
  ]);
  const total = Number(credits?.data?.total_credits);
  const used = Number(credits?.data?.total_usage);
  const creditsLeg = Number.isFinite(total) && Number.isFinite(used) ? (total - used < LOW_CREDITS_USD() ? "low" : "ok") : "unknown";
  const limit = Number(keyInfo?.data?.limit);
  const remaining = Number(keyInfo?.data?.limit_remaining);
  let keyLeg = "unknown";
  if (keyInfo?.data && (keyInfo.data.limit === null || keyInfo.data.limit === undefined)) keyLeg = "ok"; // no key limit configured
  else if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) keyLeg = remaining / limit < LOW_KEY_LIMIT_FRACTION() ? "low" : "ok";
  // "low" on either leg wins; "ok" requires the credit balance itself to be
  // readable and fine (the key limit alone cannot vouch for the balance);
  // anything else is "unknown". Unknown never pages on its own, which is how
  // a dead alarm hid for months once (charged-failure, 2026-07-25) - so the
  // payload also carries HOW LONG it has been unknown (a duration, not a
  // balance), and the heartbeat pages on a sustained unknown.
  const status = (creditsLeg === "low" || keyLeg === "low") ? "low" : creditsLeg === "ok" && keyLeg !== "unknown" ? "ok" : "unknown";
  if (status === "unknown") creditsUnknownSince ??= Date.now(); else creditsUnknownSince = null;
  const result = {
    configured: true, status, credits: creditsLeg, keyLimit: keyLeg,
    ...(creditsUnknownSince ? { unknownForMinutes: Math.floor((Date.now() - creditsUnknownSince) / 60_000) } : {}),
  };
  creditsCache = { at: Date.now(), result };
  return result;
}

// ---------------------------------------------------------------------------
// /v1/embeddings — OpenAI wire-path embeddings, loop-priced with batching.
// Upstream is OpenAI directly (OpenRouter serves chat only); env-gated on
// OPENAI_API_KEY like llm-kit/embed-kit. Unlike the sampled chat tiers,
// embeddings are DETERMINISTIC per model — so the response cache is
// default-ON (opt out with cache:false): a byte-identical repeat within the
// TTL is served free pre-paywall with zero freshness concerns.
//
// Cost discipline: caps 16k chars (~4k tokens) / 64 items per request.
// Worst-case upstream at the caps: 3-small $0.00008, ada-002 $0.0004,
// 3-large $0.00052 — all ≥3.8x under the $0.002 price.
const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDINGS_PATH = "/v1/embeddings";
const EMBEDDINGS_DEFAULT_MODEL = "text-embedding-3-small";
const EMBEDDINGS_MODELS = new Set([EMBEDDINGS_DEFAULT_MODEL, "text-embedding-3-large", "text-embedding-ada-002"]);
const EMBEDDINGS_MAX_ITEMS = 64;
const EMBEDDINGS_MAX_CHARS = 16_000;
export const EMBEDDINGS_PRICE = 0.002;
// Upstream list prices (USD per 1M input tokens, OpenAI published rates).
// Like MODEL_COST: only needs to never UNDERestimate.
const EMBEDDINGS_COST = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.10,
};

/** Exact upstream bill for a validated embeddings body — cl100k tokens per
 *  item (embeddings bill input tokens only, and cl100k is what all three
 *  models meter) × the model's list rate. Used by the margin clamp below and
 *  imported by the pricing-margin CI test so they can never disagree. */
export function embeddingsUpstreamCost(body) {
  let tokens = 0;
  for (const it of body.input) tokens += countEmbeddingTokensBounded(it);
  return { tokens, totalUsd: (tokens / 1e6) * EMBEDDINGS_COST[body.model] };
}

export function validateEmbeddingsRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  let model = String(input.model || EMBEDDINGS_DEFAULT_MODEL).trim();
  if (model.startsWith("openai/")) model = model.slice("openai/".length);
  if (!EMBEDDINGS_MODELS.has(model)) {
    throw bad(`"model" must be one of: ${[...EMBEDDINGS_MODELS].join(", ")} (default ${EMBEDDINGS_DEFAULT_MODEL})`);
  }
  const raw = input.input;
  // Normalize string -> [string]: OpenAI returns the same list shape either
  // way, and normalizing collapses both spellings to ONE cache entry.
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!items || items.length === 0) throw bad('"input" is required - a string or an array of strings to embed');
  if (items.length > EMBEDDINGS_MAX_ITEMS) throw bad(`Too many inputs (${items.length}). Maximum is ${EMBEDDINGS_MAX_ITEMS} per request`);
  let totalChars = 0;
  for (const it of items) {
    if (typeof it !== "string" || !it) throw bad("Every input item must be a non-empty string");
    totalChars += it.length;
  }
  if (totalChars > EMBEDDINGS_MAX_CHARS) throw bad(`Input too large (${totalChars} chars). /v1/embeddings allows up to ${EMBEDDINGS_MAX_CHARS} chars per request`);
  const body = { model, input: items };
  // Margin clamp — same discipline as the chat tiers. The char cap alone
  // can't bound the bill: token-dense scripts pack ~2 cl100k tokens per char
  // (rare CJK), so 16k chars ≈ 32k tokens — $0.0042 on 3-large, over the
  // $0.002 price. There is no output knob to shrink here, so an over-budget
  // input gets a self-explaining 400 BEFORE any upstream spend. Exact-BPE and
  // sync → deterministic, so embeddingsCacheKey stays stable.
  const { tokens } = embeddingsUpstreamCost(body);
  const maxTokens = Math.floor((EMBEDDINGS_PRICE * MARGIN * 1e6) / EMBEDDINGS_COST[model]);
  if (tokens > maxTokens) {
    throw bad(
      `Input is too token-dense for ${model} at this price (est. ${tokens} tokens, max ${maxTokens}). ` +
      `Send fewer or shorter inputs${model === EMBEDDINGS_DEFAULT_MODEL ? "" : `, or use ${EMBEDDINGS_DEFAULT_MODEL}`}.`
    );
  }
  if (input.dimensions !== undefined) {
    if (model === "text-embedding-ada-002") throw bad('"dimensions" is not supported by text-embedding-ada-002');
    const d = parseInt(input.dimensions, 10);
    if (Number.isNaN(d) || d < 1 || d > 3072) throw bad('"dimensions" must be an integer between 1 and 3072');
    body.dimensions = d;
  }
  if (input.encoding_format !== undefined) {
    if (input.encoding_format !== "float" && input.encoding_format !== "base64") throw bad('"encoding_format" must be "float" or "base64"');
    body.encoding_format = input.encoding_format;
  }
  return body;
}

/** Cache key for /v1/embeddings — default-ON (deterministic output), so the
 *  only opt-out is an explicit cache:false. Returns null when opted out;
 *  throws (via validation) on invalid bodies — callers treat that as "no
 *  cache" and let the normal path answer honestly. */
export function embeddingsCacheKey(input) {
  if (input?.cache === false) return null;
  const body = validateEmbeddingsRequest(input);
  return createHash("sha256").update(`v1-embeddings\n${stableStringify(body)}`).digest("hex");
}

async function embeddingsHandler(input, req) {
  const body = validateEmbeddingsRequest(input);
  const key = OPENAI_KEY();
  if (!key) throw bad("Embeddings gateway not configured (OPENAI_API_KEY unset)", 503);
  let res;
  try {
    res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }
  if (!res.ok) await throwUpstreamError(res);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
  assertUpstreamBody(data);
  // Full OpenAI wire shape passes through untouched (object, data[], model,
  // usage). Store unless the buyer opted out; oversized batches are skipped
  // by the store's own per-entry byte cap. FR4-01 class: defer the write to
  // AFTER settlement (the route binder commits on a final 200) so an unsettled
  // 200 isn't cached and served free on a repeat; direct write for non-HTTP.
  try {
    const w = { key: embeddingsCacheKey(input), body: data };
    if (req) (req.__deferredCache ??= []).push(w); else promptCacheStore(w.key, w.body);
  } catch { /* never fail a served response over the cache */ }
  return data;
}

// ---------------------------------------------------------------------------
// /v1/rerank - reranking over OpenRouter's /rerank router (Cohere wire:
// {query, documents[], top_n} -> {results:[{index, relevance_score,
// document}]}). Deterministic output (a ranker, not a sampler) -> cache
// default-ON like embeddings. One model, locked: cohere/rerank-v3.5 (live
// probe 2026-08-19: 1 "search unit" = $0.001 upstream). Cohere's search unit
// is ONE query against up to 100 documents, with long documents split into
// extra chunks that each count - so the caps below (<= 50 docs, <= 1,600
// chars each, query <= 500 chars) keep every request at exactly one unit, and
// $0.001 sits under the $0.002 price at the 70% margin bound without any
// token math. Structured {text, image} documents are refused (image reranking
// bills differently); strings only.
export const RERANK_PATH = "/v1/rerank";
export const RERANK_PRICE = 0.002;
export const RERANK_MODEL = "cohere/rerank-v3.5";
const RERANK_URL = "https://openrouter.ai/api/v1/rerank";
const RERANK_MAX_DOCS = 50;
const RERANK_MAX_DOC_CHARS = 1_600;
const RERANK_MAX_QUERY_CHARS = 500;
const RERANK_MAX_TOTAL_CHARS = 40_000;
const RERANK_CHUNK_TOKENS = 500;   // Cohere: a document is split into 500-token chunks (query length included)
const RERANK_MAX_CHUNKS = 100;     // one search unit
export function validateRerankRequest(input) {
  if (!input || typeof input !== "object") throw bad("Body must be a JSON object: {query, documents[], top_n?}");
  if (input.model !== undefined && canonicalModel(input.model) !== RERANK_MODEL && String(input.model) !== "rerank-v3.5") throw bad(`"model" must be ${RERANK_MODEL} (the only rerank model served)`);
  const query = input.query;
  if (typeof query !== "string" || !query.trim()) throw bad('"query" (string) is required');
  if (query.length > RERANK_MAX_QUERY_CHARS) throw bad(`"query" too long (${query.length} chars; max ${RERANK_MAX_QUERY_CHARS})`);
  const documents = input.documents;
  if (!Array.isArray(documents) || documents.length === 0) throw bad('"documents" must be a non-empty array of strings');
  if (documents.length > RERANK_MAX_DOCS) throw bad(`Too many documents (${documents.length}); max ${RERANK_MAX_DOCS} per call - split the set`);
  let total = 0;
  documents.forEach((d, i) => {
    if (typeof d !== "string") throw bad(`documents[${i}] must be a string (structured {text,image} documents are not served)`);
    if (d.length > RERANK_MAX_DOC_CHARS) throw bad(`documents[${i}] too long (${d.length} chars; max ${RERANK_MAX_DOC_CHARS})`);
    total += d.length;
  });
  if (total > RERANK_MAX_TOTAL_CHARS) throw bad(`documents total ${total} chars; max ${RERANK_MAX_TOTAL_CHARS} per call`);
  // The char caps keep ordinary text at one search unit, but Cohere chunks by
  // TOKENS (500 per chunk incl. the query; every chunk counts as a document;
  // one unit = up to 100 chunks), and CJK/code text runs ~1 token per char -
  // 50 x 1,600 chars of it is ~200 chunks = 2 units = $0.002 = the whole
  // price (cost audit 2026-08-19). Estimate the chunk count with the o200k
  // tokenizer (+20% for tokenizer drift) and refuse past one unit - a
  // self-explaining 400 instead of a call that upstream bills at list.
  const qTok = Math.ceil(countTokensBounded(query) * 1.2);
  let chunks = 0;
  for (const d of documents) chunks += Math.max(1, Math.ceil((Math.ceil(countTokensBounded(d) * 1.2) + qTok) / RERANK_CHUNK_TOKENS));
  if (chunks > RERANK_MAX_CHUNKS) throw bad(`documents + query tokenize to ~${chunks} rerank chunks (500 tokens each, query included); max ${RERANK_MAX_CHUNKS} per call (one search unit) - shorten the documents or split the set`);
  const body = { model: RERANK_MODEL, query, documents };
  if (input.top_n !== undefined) {
    const n = Number(input.top_n);
    if (!Number.isInteger(n) || n < 1) throw bad('"top_n" must be a positive integer');
    body.top_n = Math.min(n, documents.length);
  }
  return body;
}
/** Cache key for /v1/rerank - default-ON (deterministic), cache:false opts out. */
export function rerankCacheKey(input) {
  if (input?.cache === false) return null;
  const body = validateRerankRequest(input);
  return createHash("sha256").update(`v1-rerank\n${stableStringify(body)}`).digest("hex");
}
async function rerankHandler(input, req) {
  const body = validateRerankRequest(input);
  const key = OPENROUTER_KEY();
  if (!key) throw bad("Rerank gateway not configured (OPENROUTER_API_KEY unset)", 503);
  const user = upstreamUserId(req);
  let res;
  try {
    res = await fetch(RERANK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...OPENROUTER_ATTRIBUTION },
      body: JSON.stringify({ ...body, ...(user ? { user } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }
  if (!res.ok) await throwUpstreamError(res);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
  assertUpstreamBody(data);
  if (!Array.isArray(data?.results)) throw bad("Upstream returned no results", 502);
  // Billing fields are operator telemetry, never buyer-visible; search_units stays (a count, not a bill).
  if (data.usage && typeof data.usage === "object") {
    const upstreamUsd = typeof data.usage.cost === "number" ? data.usage.cost : null;
    delete data.usage.cost; delete data.usage.cost_details; delete data.usage.is_byok; delete data.usage.cache_discount;
    import("../posthog.js").then(({ capturePostHogGatewayUsage }) => capturePostHogGatewayUsage({ tier: "v1-rerank", model: RERANK_MODEL, priceUsd: RERANK_PRICE, upstreamUsd, promptTokens: data.usage.search_units, completionTokens: 0 })).catch(() => {});
  }
  try {
    const w = { key: rerankCacheKey(input), body: data };
    if (w.key) { if (req) (req.__deferredCache ??= []).push(w); else promptCacheStore(w.key, w.body); }
  } catch { /* never fail a served response over the cache */ }
  return data;
}

// ---------------------------------------------------------------------------
// /v1/images/generations — OpenAI wire-path image generation over OpenRouter.
// OpenRouter serves image models through chat/completions with
// modalities: ["image","text"]; this route translates the OpenAI images API
// to that shape and back, so any OpenAI SDK's images.generate() works by
// changing base_url. The model is locked and n is locked to 1 — image output
// is metered upstream, so every knob that multiplies cost is server-owned
// (same discipline as image-gen's locked size/quality). Sampling is
// non-deterministic → never cached; no streaming.
//
// Margin (two layers, same scheme as the chat tiers): flash-image output is
// ~1300 completion tokens per image at ~$30/M list (~$0.04/image) against
// the $0.08 price; IMAGES_MAX_TOKENS bounds the response and
// IMAGES_MAX_PRICE rides upstream as provider.max_price so a repriced or
// hijacked provider is refused instead of quietly eating the margin. Usage
// accounting reports the exact bill to PostHog on every call.
export const IMAGES_PATH = "/v1/images/generations";
const IMAGES_MODEL = "google/gemini-2.5-flash-image";
export const IMAGES_PRICE = 0.08;
export const IMAGES_MAX_PROMPT_CHARS = 4_000;
export const IMAGES_MAX_TOKENS = 1_600; // one image (~1300 tok) + a little text headroom
// Worst case at these bounds: 1600 tok × $35/M = $0.056 ≤ 70% of the price.
// `request` is deliberately near-zero: the locked model's providers charge no
// per-request fee (OpenRouter lists prompt/completion/image-output pricing
// only), so this bound never rejects a real provider — but a generous value
// here would be a standing ALLOWANCE for a fee-charging provider to stack
// $0.05/request on top of the token bill and invert the margin. Exported
// (with the caps above) for the pricing-margin CI test.
export const IMAGES_MAX_PRICE = { prompt: 1, completion: 35, image: 0.05, request: 0.005 };

export function validateImagesRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required - a text description of the image to generate');
  if (prompt.length > IMAGES_MAX_PROMPT_CHARS) throw bad(`Prompt too long (${prompt.length} chars). Maximum is ${IMAGES_MAX_PROMPT_CHARS}`);
  if (input.model !== undefined) {
    const m = canonicalModel(input.model);
    if (m !== IMAGES_MODEL) throw bad(`"model" is fixed to ${IMAGES_MODEL} on this endpoint (omit it, or send that id)`);
  }
  if (input.n !== undefined && parseInt(input.n, 10) !== 1) {
    throw bad('"n" is locked to 1 - the flat price is per image; call again for more');
  }
  if (input.response_format !== undefined && input.response_format !== "b64_json") {
    throw bad('"response_format" must be "b64_json" - generated images are returned inline, not hosted');
  }
  // size/quality/style have no upstream meaning for this model and no cost
  // impact — ignored for drop-in friendliness rather than rejected.
  const body = { prompt };
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  return body;
}

async function imagesHandler(input, req) {
  const { prompt, zdr } = validateImagesRequest(input);
  const user = upstreamUserId(req);
  const upstreamBody = {
    model: IMAGES_MODEL,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
    max_tokens: IMAGES_MAX_TOKENS,
    provider: { max_price: IMAGES_MAX_PRICE, ...(zdr ? { zdr: true } : {}) },
    // OpenRouter documents `usage.include` as a no-op now (full usage is always
    // returned). KEPT anyway: our margin telemetry and the metered meter read
    // `usage.cost`, and dropping the field on the strength of a docs line would
    // fail silently if the always-on behaviour is partial. Harmless if ignored.
    usage: { include: true },

    ...(user ? { user } : {}),
  };
  // Flex first (half price on this model's endpoints, live-verified), default
  // second: flex never falls back on its own, and an imageless or failed flex
  // answer must not become the buyer's 502 while the default tier would serve.
  let data = null, servedTier = "default", lastErr = null;
  for (const flex of flexEligible(IMAGES_MODEL) ? [true, false] : [false]) {
    try {
      const res = await fetchOpenRouter({ ...upstreamBody, ...(flex ? { service_tier: "flex" } : {}) }, { timeoutMs: 120_000 });
      if (!res.ok) await throwUpstreamError(res);
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
      assertUpstreamBody(parsed);
      const imgs = parsed?.choices?.[0]?.message?.images;
      if (!Array.isArray(imgs) || imgs.length === 0) throw bad("Upstream returned no image - retry, or rephrase the prompt", 502);
      data = parsed; servedTier = parsed.service_tier || (flex ? "flex" : "default");
      break;
    } catch (e) {
      if (![502, 503, 504].includes(e?.statusCode)) throw e;
      lastErr = e;
    }
  }
  if (!data) throw lastErr;
  const images = data.choices[0].message.images;

  // Exact upstream bill → operator telemetry, stripped before the response.
  const usage = data.usage && typeof data.usage === "object" ? data.usage : null;
  if (usage) {
    const upstreamUsd = typeof usage.cost === "number" ? usage.cost : null;
    delete usage.cost;
    delete usage.cost_details;
    delete usage.is_byok;
    delete usage.cache_discount;
    try {
      const { capturePostHogGatewayUsage } = await import("../posthog.js");
      capturePostHogGatewayUsage({
        tier: "v1-images",
        model: data.model || IMAGES_MODEL,
        priceUsd: IMAGES_PRICE,
        upstreamUsd,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        serviceTier: servedTier,
      });
    } catch { /* telemetry must never fail a served response */ }
  }

  // Translate back to the OpenAI images wire: data URI → b64_json.
  const out = images.map((im) => {
    const url = typeof im?.image_url?.url === "string" ? im.image_url.url : "";
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
    if (!m) throw bad("Upstream returned an image in an unexpected format", 502);
    return { b64_json: m[2], media_type: m[1] };
  });
  return {
    created: Math.floor(Date.now() / 1000),
    model: data.model || IMAGES_MODEL,
    data: out,
    ...(usage ? { usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// /v1/audio/speech — OpenAI wire-path text-to-speech over OpenRouter's audio
// API (raw audio bytes out, exactly like OpenAI's endpoint, so any SDK's
// audio.speech.create() works by changing base_url — served via the route
// binder's { __binary } sentinel). OpenRouter's TTS catalog carries NO
// OpenAI models (their docs still advertise openai/gpt-4o-mini-tts-2025-12-15;
// the live ?output_modalities=speech list — and a real paid probe of every
// entry, 2026-07-16 — says otherwise), so the tier serves a SIX-model
// failover chain across five independent providers (Microsoft twice: the
// cheaper -flash variant, then MAI-Voice-2), every link proven with a real
// buy — latest sweep: probe run 30971572514, 2026-08-05. Payment settles BEFORE this handler runs, so a provider
// outage must never become the buyer's 502: the chain walks on ANY upstream
// failure (5xx, network error, empty audio), and only exhausting every
// link surfaces an error. Buyers keep the OpenAI wire: the 11 OpenAI voice
// names map per-model to each provider's own voice ids, and any native id
// (en_paul_cheerful…) is accepted too — remapped to its OpenAI-name
// equivalent (or the link's alloy) if the chain walks past its model.
// TTS bills per INPUT character upstream, so the char cap bounds the
// worst-case bill deterministically per link — see costPerChar below:
// $0.032 (53% of the $0.06 price) on Voxtral down to $0.0012 (2%) on
// Kokoro; even the deepest fallback (MAI-Voice-2, $0.044 = 73%) clears the
// price. Binary responses carry no usage accounting and are never cached
// (sampled output).
export const SPEECH_PATH = "/v1/audio/speech";
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const SPEECH_PRICE = 0.06;
const SPEECH_MAX_CHARS = 2_000;
const SPEECH_FORMATS = { mp3: "audio/mpeg", pcm: "audio/pcm" };
const OPENAI_SPEECH_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"];
// Chain order = failover order. `map` translates the OpenAI wire voice
// names to the provider's ids (closest gender/accent/tone available);
// `voices` is the provider's full native set (accepted directly, listed on
// GET /v1/models); `aliases` are the bare/family spellings accepted in
// `model`. Voice ids and per-char prices come from OpenRouter's models API
// (?output_modalities=speech) — the probe workflow re-verifies all of this
// live (.github/workflows/openrouter-tts-probe.yml).
export const SPEECH_MODELS = [
  {
    id: "mistralai/voxtral-mini-tts-2603",
    aliases: ["mistralai/voxtral-mini-tts", "voxtral-mini-tts", "voxtral-mini-tts-2603"],
    costPerChar: 0.000016,
    map: { alloy: "en_paul_neutral", ash: "en_paul_confident", ballad: "gb_oliver_neutral", coral: "gb_jane_neutral", echo: "en_paul_happy", fable: "gb_oliver_cheerful", onyx: "gb_oliver_confident", nova: "gb_jane_confident", sage: "gb_jane_neutral", shimmer: "gb_jane_curious", verse: "en_paul_cheerful" },
    voices: new Set([
      "en_paul_sad", "en_paul_neutral", "en_paul_happy", "en_paul_frustrated", "en_paul_excited", "en_paul_confident", "en_paul_cheerful", "en_paul_angry",
      "gb_oliver_neutral", "gb_oliver_sad", "gb_oliver_excited", "gb_oliver_curious", "gb_oliver_confident", "gb_oliver_cheerful", "gb_oliver_angry",
      "gb_jane_sarcasm", "gb_jane_confused", "gb_jane_shameful", "gb_jane_sad", "gb_jane_neutral", "gb_jane_jealousy", "gb_jane_frustrated", "gb_jane_curious", "gb_jane_confident",
      "fr_marie_sad", "fr_marie_neutral", "fr_marie_happy", "fr_marie_excited", "fr_marie_curious", "fr_marie_angry",
    ]),
  },
  {
    id: "x-ai/grok-voice-tts-1.0",
    aliases: ["grok-voice-tts-1.0", "grok-voice-tts"],
    costPerChar: 0.000015,
    map: { alloy: "eve", ash: "rex", ballad: "leo", coral: "ara", echo: "rex", fable: "leo", onyx: "rex", nova: "ara", sage: "eve", shimmer: "ara", verse: "sal" },
    voices: new Set(["eve", "ara", "rex", "sal", "leo"]),
  },
  {
    id: "hexgrad/kokoro-82m",
    aliases: ["kokoro-82m", "kokoro"],
    costPerChar: 0.00000062,
    map: { alloy: "af_alloy", ash: "am_adam", ballad: "bm_george", coral: "af_bella", echo: "am_echo", fable: "bm_fable", onyx: "am_onyx", nova: "af_nova", sage: "af_sarah", shimmer: "af_sky", verse: "am_liam" },
    voices: new Set([
      "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
      "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
      "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
      "ef_dora", "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
      "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
      "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    ]),
  },
  // zyphra/zonos-v0.1-hybrid was link 4 until 2026-08-19: it has ZERO
  // endpoints on OpenRouter now (absent from ?output_modalities=speech), so
  // every walk past Kokoro burned a failed round-trip. Removed; the chain is
  // five links. scripts/test-gateway-model-ids.js now checks every link live.
  {
    // MAI-Voice-2-Flash — same four voices as MAI-Voice-2 at $15/M chars
    // (vs $22/M): worst case $0.030 = 50% of the price. Proven by a real
    // authenticated buy on probe run 30971572514 (2026-08-05, 200 +
    // audio/mpeg bytes) before entering the chain.
    id: "microsoft/mai-voice-2-flash",
    aliases: ["mai-voice-2-flash"],
    costPerChar: 0.000015,
    map: Object.fromEntries(OPENAI_SPEECH_VOICES.map((v) => [v, "en-US-Harper:MAI-Voice-2"])),
    voices: new Set(["en-US-Harper:MAI-Voice-2", "es-MX-Valeria:MAI-Voice-2", "fr-FR-Soleil:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"]),
  },
  {
    // Single English voice — every OpenAI name lands on Harper. Priciest
    // link (73% of the price) and same provider as -flash, hence last: it
    // only serves when five other providers AND its own flash variant fail.
    id: "microsoft/mai-voice-2",
    aliases: ["mai-voice-2"],
    costPerChar: 0.000022,
    map: Object.fromEntries(OPENAI_SPEECH_VOICES.map((v) => [v, "en-US-Harper:MAI-Voice-2"])),
    voices: new Set(["en-US-Harper:MAI-Voice-2", "es-MX-Valeria:MAI-Voice-2", "fr-FR-Soleil:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"]),
  },
];

/** The provider's voice id for a requested voice on this chain link:
 *  OpenAI name → mapped; the link's own native id → itself; another link's
 *  native id (chain walked past its model) → this link's alloy. */
function speechVoiceFor(entry, requested) {
  return entry.map[requested] || (entry.voices.has(requested) ? requested : entry.map.alloy);
}

export function validateSpeechRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  const text = typeof input.input === "string" ? input.input : "";
  if (!text.trim()) throw bad('"input" is required - the text to speak');
  if (text.length > SPEECH_MAX_CHARS) {
    throw bad(`Input too long (${text.length} chars). /v1/audio/speech allows up to ${SPEECH_MAX_CHARS}`);
  }
  if (input.instructions !== undefined) {
    throw bad('"instructions" is not supported by the serving models - pick an expressive native voice instead (e.g. "en_paul_cheerful"; full list on GET /v1/models)');
  }
  // Explicit model pins that link to the FRONT of the chain — the rest stay
  // as fallbacks (same semantics as the chat tiers: a buyer's pick should
  // not turn a provider outage into their 502).
  let chain = SPEECH_MODELS;
  if (input.model !== undefined) {
    const m = canonicalModel(input.model).toLowerCase();
    const hit = SPEECH_MODELS.find((e) => m === e.id || e.aliases.includes(m));
    if (!hit) {
      throw bad(`"model" must be one of: ${SPEECH_MODELS.map((e) => e.id).join(", ")} (or omit it for the default chain)`);
    }
    chain = [hit, ...SPEECH_MODELS.filter((e) => e !== hit)];
  }
  const voice = input.voice === undefined ? "alloy" : String(input.voice);
  if (!OPENAI_SPEECH_VOICES.includes(voice) && !SPEECH_MODELS.some((e) => e.voices.has(voice))) {
    throw bad(`"voice" must be an OpenAI voice name (${OPENAI_SPEECH_VOICES.join(", ")}) or a native voice id from GET /v1/models`);
  }
  const format = input.response_format === undefined ? "mp3" : String(input.response_format);
  if (!SPEECH_FORMATS[format]) throw bad(`"response_format" must be one of: ${Object.keys(SPEECH_FORMATS).join(", ")}`);
  if (input.speed !== undefined) {
    const s = Number(input.speed);
    // OpenAI's documented range. Upstream bills per input character, so
    // speed is cost-neutral; providers that don't support it ignore it.
    if (!Number.isFinite(s) || s < 0.25 || s > 4) throw bad('"speed" must be between 0.25 and 4');
  }
  const zdr = input.zdr === true || input.provider?.zdr === true;
  const bodies = chain.map((entry) => ({
    model: entry.id,
    input: text,
    voice: speechVoiceFor(entry, voice),
    response_format: format,
    ...(input.speed !== undefined ? { speed: Number(input.speed) } : {}),
    ...(zdr ? { provider: { zdr: true } } : {}),
  }));
  return { bodies, contentType: SPEECH_FORMATS[format] };
}

async function speechHandler(input) {
  const { bodies, contentType } = validateSpeechRequest(input);
  const key = OPENROUTER_KEY();
  if (!key) throw bad("LLM gateway not configured (OPENROUTER_API_KEY unset)", 503);
  let lastErr;
  for (const body of bodies) {
    try {
      let res;
      try {
        res = await fetch(OPENROUTER_SPEECH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...OPENROUTER_ATTRIBUTION,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw bad(`Upstream request failed: ${e.message}`, 504);
      }
      if (!res.ok) await throwUpstreamError(res);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw bad("Upstream returned no audio - retry, or rephrase the input", 502);
      return { __binary: buffer, contentType };
    } catch (e) {
      // Walk on anything upstream-shaped (throwUpstreamError maps every
      // upstream failure to 502/503; timeouts and network errors are 504).
      // Our own validation 4xxs were thrown before the loop.
      if (![502, 503, 504].includes(e?.statusCode)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Image blocks in a validated messages array — the margin clamp bills each
 *  a flat IMAGE_TOKENS, so the failover re-clamp needs the same count. */
function countImages(messages) {
  let images = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "image_url") images++;
  }
  return images;
}

function makeHandler(tierSlug) {
  return async (input, req) => {
    // Availability gate (stealth tiers): the boot probe found the id gone
    // upstream, so answer BEFORE spending a round-trip on a model that no
    // longer exists. 503 is >=400, and @x402/express cancels settlement for
    // any >=400 response - the buyer is not charged.
    const avail = TIERS[tierSlug].available;
    if (typeof avail === "function" && !avail()) {
      throw bad(
        `"${TIERS[tierSlug].lockedModel || tierSlug}" is no longer served upstream. It was a stealth (cloaked) preview ` +
        "listing and has been withdrawn by its provider; nothing was charged for this call. GET /v1/models lists every " +
        "model the gateway currently serves.",
        503
      );
    }
    const body = validateRequest(input, tierSlug);
    // Metered belt: the price this request was gated at (stashed by the x402
    // price function / the gates) must cover the body actually being served.
    // The quote and the dispatcher now share one input construction, so a
    // mismatch means something priced a different object than it served;
    // refuse with a 4xx (settlement cancelled, hold released, nothing spent).
    if (TIERS[tierSlug].metered && Number.isFinite(req?.__meteredQuoteUsd)) {
      const q = meteredQuoteUsd(input);
      if (q.invalid || q.usd > req.__meteredQuoteUsd * (1 + 1e-6) + 1e-9) {
        throw bad(`This request was quoted at $${req.__meteredQuoteUsd} but the body being served quotes $${q.usd}${q.invalid ? ` (${q.reason})` : ""}. Nothing was charged; resend the request exactly as it should be served (no query-string or wrapped fields).`, 400);
      }
    }
    // NB: @x402/express settles AFTER this handler and cancels settlement for a
    // >=400 response, so an upstream failure that we let surface as a 5xx is NOT
    // charged. We still walk the tier's fallback chain on upstream errors
    // (502/503/504) so an equivalent model can serve rather than fail — better
    // UX, and a served 200 only bills if it then settles. Our own validation
    // 4xxs pass through untouched.
    // The response's `model` field discloses which model actually served.
    // (Origin: openai/gpt-4.1-nano returned persistent provider errors on
    // 2026-07-08 — two independent paid runs — and buyers were charged $0.003
    // for 502s. No allowlist can guarantee a provider stays alive; a chain
    // ending in a canary-proven model can.)
    // Auto tier with no explicit model: the routed band+category's full
    // ranking IS the failover chain (body.model is already its head).
    // Explicit-model requests — on any tier — keep the requested model
    // first, then the tier's static fallbacks.
    const isRouted =
      TIERS[tierSlug].router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto");
    const routedCategory = isRouted ? classifyPrompt(input.messages) : null;
    const routedQuality = isRouted ? (input.quality === undefined ? "balanced" : String(input.quality)) : null;
    const chain = routedCategory
      ? [...AUTO_RANKINGS[routedQuality][routedCategory]]
      : [body.model, ...(TIERS[tierSlug].fallbacks || []).filter((m) => m !== body.model)];
    // Hard upstream price cap (see the maxPrice note on TIERS): rides on every
    // call, buyer-invisible, and never part of the cache key (validateRequest
    // output stays the normalized body). A cap-excluded provider surfaces as
    // an upstream error, which the chain below already walks. The buyer's zdr
    // preference (validated into body.zdr) folds in here — sent upstream as
    // provider.zdr, stripped from the top-level body (zdr: undefined below).
    // Metered tier: the quote priced THIS model at its MODEL_COST row, so the
    // upstream bound is that row, not the tier-wide 20/100 - a pricier
    // provider of the same model is refused upstream instead of served at a
    // loss the quote never covered (audit 2026-08-26).
    const meteredBound = TIERS[tierSlug].metered ? costFor(body.model) : null;
    const providerPrefs = {
      ...(meteredBound ? { max_price: { prompt: meteredBound.prompt, completion: meteredBound.completion } }
        : TIERS[tierSlug].maxPrice ? { max_price: TIERS[tierSlug].maxPrice } : {}),
      ...(body.zdr === true ? { zdr: true } : {}),
      // Cheapest provider under the cap - ONLY on the budget tiers, where
      // price is the product. On the same model, sort-by-price can land on a
      // lower-precision (quantized) provider; pro/premium buyers did not buy
      // that, and max_price already bounds their cost. OPENROUTER_PROVIDER_SORT=off disables.
      ...(TIERS[tierSlug].priceSort === true && PROVIDER_SORT_ENABLED() ? { sort: "price" } : {}),
    };
    const provider = Object.keys(providerPrefs).length ? providerPrefs : undefined;
    // Prompt cache: top-level cache_control (default on, buyer may disable)
    // + session_id = the per-buyer id, so OpenRouter pins the buyer's turns
    // to one provider and implicit caches (OpenAI/Gemini/DeepSeek/Grok) and
    // Anthropic's explicit cache actually get hit. Call-time only, never in
    // the cache key (validated shape in validateRequest).
    const cacheControl = cacheControlPref(input);
    // Margin holds on EVERY link of the chain, not just the requested model:
    // validateRequest clamped max_tokens against the REQUESTED model's cost,
    // so a cheap-model clamp (often a no-op) would ride unchanged to a
    // pricier fallback and could push the worst-case upstream bill past the
    // flat price (e.g. nano gpt-4.1-nano n=4 at the full output cap failing
    // over to deepseek-chat). Re-clamp each candidate at ITS OWN cost — a
    // no-op for the primary model, tighter output for pricier fallbacks, and
    // a fallback whose input alone busts its budget is skipped (payment
    // settled; serving a shorter answer beats losing money or 502ing).
    const imageCount = countImages(body.messages);
    // Per-buyer `user` for OpenRouter's abuse isolation (see upstreamUserId):
    // call-time injection, never in the normalized body or cache keys.
    const user = upstreamUserId(req);
    // Structured outputs: route only to providers that honour
    // response_format (require_parameters) and, off-stream, let OpenRouter's
    // response-healing plugin repair almost-JSON (live-verified 2026-08-19:
    // accepted, no cost change). Server-set; buyer `plugins` never pass.
    const rfType = body.response_format && typeof body.response_format === "object" ? body.response_format.type : null;
    const structured = rfType === "json_schema" || rfType === "json_object";
    const providerForLink = structured ? { ...(provider || {}), require_parameters: true } : provider;
    const outboundFor = (model, flex = false) => {
      const attempt = { ...body, model };
      clampToMargin(attempt, TIERS[tierSlug], imageCount); // throws 400 → caller skips this candidate
      // Reasoning default per link (see REASONING_MODELS): only when the
      // buyer expressed no preference. Deterministic given the model, so it
      // needs no place in the cache key.
      const reasoning = body.reasoning !== undefined ? body.reasoning : defaultReasoningFor(model, tierSlug);
      const plugins = [
        ...(TIERS[tierSlug].web ? [{ ...TIERS[tierSlug].web }] : []),
        ...(structured && body.stream !== true ? [{ id: "response-healing" }] : []),
      ];
      // Server-owned loop budget. Call-time injection like provider.max_price:
      // deterministic given the tier, so it never belongs in a cache key, and
      // a buyer value can never reach it (validateRequest refuses the field).
      // step_count_is is the bound the margin arithmetic uses; max_cost is a
      // belt - it stops AFTER cumulative spend exceeds the threshold, so it is
      // set to the whole margin budget and relied on for nothing.
      const stopServerTools = stopServerToolsFor(attempt, TIERS[tierSlug]);
      return {
        ...attempt, zdr: undefined, cache_control: undefined,
        ...(stopServerTools ? { stop_server_tools_when: stopServerTools } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(providerForLink ? { provider: providerForLink } : {}), ...(user ? { user, session_id: user } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
        ...(plugins.length ? { plugins } : {}),
        ...(flex ? { service_tier: "flex" } : {}),
      };
    };
    // Server-tool execution is upstream spend, so it has to be visible to a
    // margin review. OpenRouter reports the loop's counts as
    // usage.server_tool_use_details {tool_calls_executed, tool_calls_requested,
    // web_search_requests} (and usage.cost is documented as "the total amount
    // charged to your account", i.e. the fee is already inside upstreamUsd -
    // the counts are what say WHY a margin moved).
    const recordUsage = (usage, upstreamUsd, served, serviceTier) => import("../posthog.js")
      .then(({ capturePostHogGatewayUsage }) => capturePostHogGatewayUsage({
        tier: tierSlug, model: served, priceUsd: (TIERS[tierSlug].metered && Number.isFinite(req?.__meteredQuoteUsd) && req.__meteredQuoteUsd > 0) ? req.__meteredQuoteUsd : TIERS[tierSlug].price, upstreamUsd,
        promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, serviceTier,
        serverToolCalls: usage?.server_tool_use_details?.tool_calls_executed ?? usage?.server_tool_use?.tool_calls_executed,
        serverToolSearches: usage?.server_tool_use_details?.web_search_requests ?? usage?.server_tool_use?.web_search_requests,
        defaulted: !!body.__defaultedModel,
      }))
      .catch(() => { /* telemetry must never fail a served response */ });
    // Flex-eligible links are tried on the flex tier first, then default (see
    // FLEX_MODELS): any upstream failure on the flex attempt falls to the same
    // model's default attempt before the chain moves on.
    const attempts = flexAttempts(chain).slice(0, TIERS[tierSlug].maxAttempts || Infinity);
    if (body.stream === true) {
      // The route binder invokes __sse(res) after the paywall settled.
      // streamOpenRouterTo throws only BEFORE headers are written, so the
      // failover chain is safe: once bytes flow, errors just end the stream.
      return {
        __sse: async (res) => {
          let lastErr;
          for (const { model, flex } of attempts) {
            let outbound;
            try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
            try {
              // Streams now carry margin telemetry too: the scrubber hands us
              // the upstream cost it strips from the final usage frame.
              return await streamOpenRouterTo(outbound, res, { onUsage: (usage, cost, frame) => recordUsage(usage, cost, frame?.model || model, frame?.service_tier || (flex ? "flex" : "default")) });
            } catch (e) {
              if (res.headersSent || ![502, 503, 504].includes(e?.statusCode)) throw e;
              lastErr = e;
            }
          }
          throw lastErr;
        },
      };
    }
    let lastErr;
    let refusedModel = null;
    for (const { model, flex } of attempts) {
      // A model that refused on flex will refuse on default too - don't pay twice.
      if (model === refusedModel) continue;
      let outbound;
      try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
      try {
        // usage.include once asked OpenRouter for the exact upstream bill;
        // OpenRouter now returns it on every response regardless (2026-08),
        // so this is a harmless no-op kept for older gateway behaviour. It is
        // injected at call time (like provider), never part of the normalized
        // body or cache keys. Streams get the same accounting via the SSE
        // scrubber in streamOpenRouterTo.
        const data = await callOpenRouter({ ...outbound, usage: { include: true } });
        // An empty safety refusal (HTTP 200, no content) walks the chain like
        // a provider error — a buyer must never pay for nothing. See
        // isEmptyRefusal above. Streams can't be inspected this way; there
        // the raw SSE passes through and finish_reason discloses.
        if (isEmptyRefusal(data)) {
          lastErr = bad("Upstream declined the request (safety filter) - rephrase the prompt, or pick a different model", 502);
          refusedModel = model;
          continue;
        }
        if (isEmptyLength(data)) {
          // The output cap was spent before any content (reasoning tokens are
          // output tokens). Never serve a paid empty 200: try the next link
          // (flex->default first, then the chain); end-to-end empty is a 502.
          lastErr = bad("Upstream produced no content within the output cap (reasoning consumed it) - raise max_tokens, lower reasoning.effort, or pick a non-reasoning model", 502);
          refusedModel = model; // same model + same effort on the default tier would be empty too - don't pay twice
          continue;
        }
        // The exact upstream cost is operator telemetry, never a buyer-visible
        // field — capture it, then strip it before the response is cached or
        // returned. Standard token counts stay (OpenAI wire shape).
        if (data && typeof data === "object" && data.usage && typeof data.usage === "object") {
          const upstreamUsd = typeof data.usage.cost === "number" ? data.usage.cost : null;
          delete data.usage.cost;
          delete data.usage.cost_details;
          delete data.usage.is_byok;
          delete data.usage.cache_discount; // a USD saving is a billing number too
          await recordUsage(data.usage, upstreamUsd, data.model || model, data.service_tier || (flex ? "flex" : "default"));
          // METERED SETTLEMENT: hand the real cost to the route binder, which
          // settles that plus the markup instead of the flat tier price when
          // the buyer paid over `upto`. Stripped before the body is returned,
          // exactly like the billing fields above - a buyer never sees our
          // upstream bill, only what they were charged. A non-number (upstream
          // did not report) deliberately means "no meter", not "free".
          if (typeof upstreamUsd === "number") setMeterSentinel(data, upstreamUsd);
        }
        // Routed requests disclose the decision: additive key, OpenAI wire
        // shape otherwise untouched (the standard `model` field already names
        // the server, this adds WHY). Streams pass through unannotated.
        if (routedCategory && data && typeof data === "object") {
          data.agent402_router = { category: routedCategory, quality: routedQuality, served: data.model || model };
        }
        if (body.__defaultedModel) data.agent402_default_model = body.__defaultedModel; // the caller sent no model; say what served
        if (input.cache === true && !TIERS[tierSlug].noCache) {
          // FR4-01 class: defer the cache write to AFTER settlement. @x402/express
          // settles after this handler, so writing now would cache an
          // unsettled 200. Stash on req; the route binder commits on a final 200.
          // Fall back to a direct write for non-HTTP callers (no settlement).
          try {
            const w = { key: promptCacheKey(tierSlug, input), body: data };
            if (req) (req.__deferredCache ??= []).push(w); else promptCacheStore(w.key, w.body);
          } catch { /* never fail a served response over the cache */ }
        }
        return data;
      } catch (e) {
        if (![502, 503, 504].includes(e?.statusCode)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  };
}


// ---- metered quote --------------------------------------------------------
function imageCountOf(input) {
  let n = 0;
  for (const m of Array.isArray(input?.messages) ? input.messages : []) {
    if (Array.isArray(m?.content)) for (const part of m.content) if (part && part.type === "image_url") n++;
  }
  return n;
}
/** Quote for an already-normalized metered body (validateRequest output). */
function meteredQuoteFromNormalized(body, imageCount) {
  const wc = worstCaseUpstreamCost(body, TIERS["v1-chat-metered"], imageCount);
  const raw = Math.max(METER_MIN_SETTLE_USD, wc.totalUsd * METER_MARKUP + METER_FLOOR_USD);
  return Math.ceil(raw * 1e6) / 1e6; // round UP to a micro-dollar: never quote below the arithmetic
}
/** Metered quote for an already-validated PROBE (a body shaped the way
 *  worstCaseUpstreamCost reads it: model, max_tokens, messages, optional
 *  system/tools/thinking). The Messages wire builds its probe in
 *  validateMessagesRequest and prices it here, so both wires quote from the
 *  same arithmetic, cap and rounding. */
export function meteredQuoteForProbe(probe, imageCount = 0) {
  const tier = TIERS["v1-chat-metered"];
  const usd = meteredQuoteFromNormalized(probe, imageCount);
  // rawUsd is what the body would actually cost; usd is what the 402 carries
  // (the cap, over the cap). A handler MUST refuse an overCap body: the 402
  // quoted the cap, not the cost (review 2026-08-27: the Messages wire served
  // a ~$8 Opus body for $2 because it clamped here and never refused).
  if (usd > tier.maxQuoteUsd) return { usd: tier.maxQuoteUsd, rawUsd: usd, overCap: true, model: probe?.model };
  return { usd, rawUsd: usd, model: probe?.model };
}
/** The per-request price of the metered tier, from the RAW request body.
 *  Never throws: an invalid body quotes the floor (the handler's own 400
 *  refuses it, uncharged), and a body over the cap quotes the cap (same). */
export function meteredQuoteUsd(input) {
  const tier = TIERS["v1-chat-metered"];
  try {
    const v = validateRequest(input, "v1-chat-metered", { clamp: false });
    const usd = meteredQuoteFromNormalized(v, imageCountOf(input));
    if (usd > tier.maxQuoteUsd) return { usd: tier.maxQuoteUsd, overCap: true, model: v.model };
    return { usd, model: v.model };
  } catch (e) {
    return { usd: tier.price, invalid: true, reason: String(e?.message || e).slice(0, 160) };
  }
}

const SHARED_TAGS = ["llm", "ai", "inference", "chat", "gateway", "openai-compatible", "openrouter"];
const EXAMPLE = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 };
const EXAMPLE_OUT = {
  id: "gen-…", object: "chat.completion", created: 1750000000, model: "openai/gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

const INPUT_SCHEMA = {
  properties: {
    model: { type: "string", description: "Model id - OpenRouter form (openai/gpt-4o-mini) or bare OpenAI form (gpt-4o-mini). GET /v1/models lists the allowlist per tier. Optional: omit it and the tier serves its documented default (x402.defaultModel on /v1/models), named back in agent402_default_model; the price does not change" },
    messages: { type: "array", description: "OpenAI chat messages: [{role, content}] - text and image_url content blocks supported" },
    max_tokens: { type: "number", description: "Output token cap (clamped to the tier maximum)" },
    zdr: { type: "boolean", description: "Optional - true routes only to zero-data-retention providers (also accepted as provider.zdr). Same price; a model with no ZDR provider errors upstream and walks the failover chain." },
    cache_control: { description: 'Optional - prompt caching preference. Default ON ({type:"ephemeral"}, 5-minute TTL): repeated prefixes across your turns are served from the provider cache (same price to you). Send false to disable. ttl:"1h" is not offered.' },
    reasoning: { type: "object", description: 'Optional - reasoning control for reasoning models: {effort: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", max_tokens?: int, exclude?: bool, enabled?: bool}. Reasoning tokens count against max_tokens. When omitted, reasoning-by-default models get a low effort on the budget tiers (so the cap is not spent thinking) and the model default on premium. OpenAI\'s reasoning_effort string is accepted too.' },
    max_completion_tokens: { type: "integer", description: "Optional - alias of max_tokens (newer OpenAI SDKs send this)." },
    tools: { type: "array", description: 'Optional - OpenAI function tools {type:"function", function:{...}}. The pro and premium routes also accept the bounded server tools {type:"openrouter:web_search"}, {type:"openrouter:web_fetch"} and {type:"openrouter:datetime"}, which OpenRouter executes in an agent loop; GET /v1/models lists the per-tier step and per-tool limits. Those limits and the loop budget are server-owned - stop_server_tools_when and max_tool_calls are refused. A request carrying a server tool is never served from the prompt cache.' },
  },
  required: ["model", "messages"],
};

const AUTO_INPUT_SCHEMA = {
  properties: {
    messages: INPUT_SCHEMA.properties.messages,
    model: { type: "string", description: 'Optional - omit (or send "auto") for eval-ranked server-side routing. An explicit model from the auto ranking is honored at the auto caps.' },
    quality: { type: "string", description: 'Optional routing band when the gateway picks the model: "fast" (cheapest/snappiest), "balanced" (default), "best" (strongest under the flat price). Never changes the price.' },
    max_tokens: INPUT_SCHEMA.properties.max_tokens,
  },
  required: ["messages"],
};

export const LLM_GATEWAY_TOOLS = [
  {
    route: "POST /v1/metered/chat/completions",
    name: "Chat completions - metered (pay what the call costs)",
    slug: "v1-chat-metered",
    category: "llm",
    price: `$${METER_MIN_SETTLE_USD}`,
    // payments.js: a `quote` makes the x402 price a per-request function of the body.
    quote: (body) => meteredQuoteUsd(body).usd,
    description:
      `OpenAI-compatible chat completions billed per request from what the call costs: the 402 quotes exact-BPE input plus your max_tokens at the model's list price, times ${METER_MARKUP}, from $${METER_MIN_SETTLE_USD} up to a $${METERED_MAX_QUOTE_USD} per-call cap. Any model from the flat tiers (GET /v1/models). Pay the quote over x402 exact, or authorize it as a ceiling over upto and settle actual usage. Set max_tokens to what you need: it is what you pay for.`,
    tags: [...["llm", "ai", "inference", "chat", "gateway", "openai-compatible", "openrouter"], "metered", "pay-per-token"],
    discovery: { bodyType: "json", input: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "openai/gpt-4o-mini" } } },
    handler: makeHandler("v1-chat-metered"),
  },
  {
    route: "POST /v1/nano/chat/completions",
    name: "Chat completions - nano tier",
    slug: "v1-chat-nano",
    category: "llm",
    price: "$0.003",
    description:
      "OpenAI-compatible chat completions, nano tier: gpt-5.6-luna, gpt-5-nano, gemini flash-lite, small llama/ministral/qwen, deepseek-chat - $0.003 per call in USDC over x402, priced for high-frequency agent loops. Same wire format as /v1/chat/completions with loop-sized caps (12k chars in, 768 tokens out). Streaming supported (stream: true). No API key, no signup.",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "openai/gpt-5.6-luna" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "openai/gpt-4.1-nano" } } },
    handler: makeHandler("v1-chat-nano"),
  },
  {
    route: "POST /v1/auto/chat/completions",
    name: "Chat completions - auto tier (eval-ranked routing)",
    slug: "v1-chat-auto",
    category: "llm",
    price: "$0.01",
    description:
      'OpenAI-compatible chat completions with server-side model choice: omit "model" (or send "auto") and the gateway routes the prompt to the top-ranked model for its task type (code / reasoning / long-context / general) from a fixed eval-derived ranking - deterministic, no LLM in the routing path. An optional quality knob picks the band: "fast" (cheapest/snappiest), "balanced" (default), or "best" (strongest models the flat price covers) - same $0.01 either way. Provider errors fail over down the ranking automatically; the response adds agent402_router {category, quality, served} alongside the standard model field. Caps 16k chars in / 1024 tokens out. Streaming supported (stream: true). No API key, no signup.',
    tags: [...SHARED_TAGS, "router", "auto"],
    discovery: {
      bodyType: "json",
      input: { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
      inputSchema: AUTO_INPUT_SCHEMA,
      output: { example: { ...EXAMPLE_OUT, agent402_router: { category: "general", quality: "balanced", served: "openai/gpt-4o-mini" } } },
    },
    handler: makeHandler("v1-chat-auto"),
  },
  {
    route: "POST /v1/grounded/chat/completions",
    name: "Grounded chat (web search, OpenAI-compatible)",
    slug: "v1-chat-grounded",
    category: "llm",
    price: "$0.03",
    description:
      'OpenAI-compatible chat completions GROUNDED in a live web search on every call: the gateway runs an Exa search (up to 5 results) for the prompt, hands the results to the model, and returns the answer with url_citation annotations - $0.03 per call in USDC, no API key, no signup. Model is chosen server-side like the auto tier (omit "model" or send "auto"; explicit ranked models accepted); the response adds agent402_router {category, quality, served}. The sanctioned way to get live-web answers from the gateway (":online" model variants are refused elsewhere because search is billed per request). Caps 16k chars in / 1024 tokens out. Streaming supported. Never cached - the web moves.',
    tags: [...SHARED_TAGS, "router", "grounded", "web-search", "citations"],
    discovery: {
      bodyType: "json",
      input: { messages: [{ role: "user", content: "What is the current Node.js LTS version? One line, cite the source." }], max_tokens: 120 },
      inputSchema: AUTO_INPUT_SCHEMA,
      output: { example: { ...EXAMPLE_OUT, agent402_router: { category: "general", quality: "balanced", served: "openai/gpt-4o-mini" } } },
    },
    handler: makeHandler("v1-chat-grounded"),
  },
  {
    route: `POST ${OX_ROUTE}`,
    name: "Chat completions - Ox Alpha (stealth preview, prompts shared)",
    slug: "v1-chat-ox",
    category: "llm",
    price: "$0.002",
    description:
      "OpenAI-compatible chat completions served by Ox Alpha (stealth/ox-alpha), a reasoning model with a 1,048,576-token " +
      "context window. FREE TO USE while the model's own upstream is free: add ?trial=1 and no wallet, key or signup is "
      + "needed (a per-client allowance, and the response says how much is left). $0.002 per call in USDC over x402 when "
      + "you want it without an allowance. The model is locked to this route " +
      "(sending a different model returns a 400 naming its tier). Reasoning is always on; the gateway sets effort \"low\" " +
      "by default and you can raise it with reasoning.effort (\"low\", \"high\" or \"max\"). Text and image input, up to " +
      "80,000 chars per request (the HTTP body limit, not the model's context) and 8,000 output tokens. Streaming " +
      "supported (stream: true). " +
      "PROMPTS ARE SHARED WITH THE MODEL PROVIDER: this is a stealth (cloaked) preview listing, served at no upstream " +
      "cost in exchange for the provider RETAINING and reviewing the prompts and completions sent through it. Do not send " +
      "confidential or personal data on this route; zdr:true is refused here and works on every priced tier instead. " +
      "The model can also be withdrawn by its provider at any time, at which point this route answers 503 (never a charge).",
    tags: [...SHARED_TAGS, "reasoning", "long-context", "stealth", "preview", "prompts-shared"],
    discovery: {
      bodyType: "json",
      input: { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 1024 },
      inputSchema: {
        properties: {
          messages: INPUT_SCHEMA.properties.messages,
          model: { type: "string", description: `Optional - locked to ${OX_MODEL}; any other value is a 400 naming the tier that serves it.` },
          max_tokens: { type: "number", description: "Output token cap (default 4096, floor 1024, tier maximum 8000). Reasoning tokens count against it, which is why the floor exists." },
          reasoning: { type: "object", description: 'Optional - {effort: "low"|"high"|"max"}. Defaults to "low" so the budget is not spent thinking. This model always reasons; "none"/"minimal"/"medium" are not supported by it.' },
          cache_control: INPUT_SCHEMA.properties.cache_control,
          max_completion_tokens: INPUT_SCHEMA.properties.max_completion_tokens,
        },
        required: ["messages"],
      },
      output: { example: { ...EXAMPLE_OUT, model: OX_MODEL } },
    },
    handler: makeHandler("v1-chat-ox"),
  },
  {
    route: "POST /v1/chat/completions",
    name: "Chat completions (OpenAI-compatible)",
    slug: "v1-chat",
    category: "llm",
    price: "$0.02",
    description:
      "OpenAI-compatible chat completions over x402 - point any OpenAI SDK at base_url https://agent402.tools/v1 and pay per call in USDC (Base, Solana, Polygon, Arbitrum, Stellar), no API key, no signup. Budget/mid models: gpt-4o-mini, claude haiku, gemini flash, deepseek, llama, mistral, qwen. Full wire compatibility incl. tools/function-calling and response_format. GET /v1/models lists every model. Streaming supported (stream: true).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: EXAMPLE, inputSchema: INPUT_SCHEMA, output: { example: EXAMPLE_OUT } },
    handler: makeHandler("v1-chat"),
  },
  {
    route: "POST /v1/pro/chat/completions",
    name: "Chat completions - pro tier",
    slug: "v1-chat-pro",
    category: "llm",
    price: "$0.10",
    description:
      "OpenAI-compatible chat completions, pro tier: gpt-4o, gpt-4.1, claude sonnet, gemini pro, grok - paid per call in USDC over x402. Same wire format as /v1/chat/completions with higher input/output caps (48k chars in, 4096 tokens out).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "openai/gpt-4o" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "openai/gpt-4o" } } },
    handler: makeHandler("v1-chat-pro"),
  },
  {
    route: "POST /v1/premium/chat/completions",
    name: "Chat completions - premium tier",
    slug: "v1-chat-premium",
    category: "llm",
    price: "$0.50",
    description:
      "OpenAI-compatible chat completions, premium tier: gpt-5, o3/o4, claude opus - paid per call in USDC over x402. Same wire format as /v1/chat/completions with the largest caps (64k chars in, 8192 tokens out).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "anthropic/claude-opus-4" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "anthropic/claude-opus-4" } } },
    handler: makeHandler("v1-chat-premium"),
  },
  {
    route: "POST /v1/embeddings",
    name: "Embeddings (OpenAI-compatible)",
    slug: "v1-embeddings",
    category: "llm",
    price: "$0.002",
    description:
      "OpenAI-compatible text embeddings over x402 - point any OpenAI SDK at base_url https://agent402.tools/v1 and pay $0.002 per call in USDC, no API key, no signup. Batch up to 64 inputs / 16k chars per request; text-embedding-3-small by default (3-large and ada-002 supported; dimensions and encoding_format pass through). Embeddings are deterministic, so a byte-identical repeat within 10 minutes is served FREE from cache automatically (X-Cache: hit; opt out with cache:false).",
    tags: ["embeddings", "vector", "rag", "semantic-search", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { input: "Agent402 is an open-source x402 tool server." },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Text to embed - a string or an array of up to 64 strings (16k chars total)" },
          model: { type: "string", description: `Optional - ${EMBEDDINGS_DEFAULT_MODEL} (default), text-embedding-3-large, or text-embedding-ada-002` },
          dimensions: { type: "number", description: "Optional output dimensions (3-small/3-large only)" },
        },
        required: ["input"],
      },
      output: { example: { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.0023, -0.0091, 0.0152] }], model: EMBEDDINGS_DEFAULT_MODEL, usage: { prompt_tokens: 12, total_tokens: 12 } } },
    },
    handler: embeddingsHandler,
  },
  {
    route: "POST /v1/rerank",
    name: "Rerank (Cohere-compatible)",
    slug: "v1-rerank",
    category: "llm",
    price: "$0.002",
    description:
      "Rerank documents against a query over x402 - the Cohere /rerank wire ({query, documents[], top_n} -> results with relevance_score), served by cohere/rerank-v3.5, $0.002 per call in USDC, no API key, no signup. Up to 50 documents (1,600 chars each, 40k total) and a 500-char query per call. Deterministic, so a byte-identical repeat within 10 minutes is served FREE from cache (X-Cache: hit; opt out with cache:false). The retrieval companion to /v1/embeddings - embed and recall, then rerank the top candidates.",
    tags: ["rerank", "reranking", "retrieval", "rag", "semantic-search", "cohere", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { query: "What is the capital of France?", documents: ["Paris is the capital of France.", "Berlin is the capital of Germany.", "Madrid is in Spain."], top_n: 2 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "The search query (max 500 chars)" },
          documents: { type: "array", items: { type: "string" }, description: "Documents to rank (1-50 strings, 1,600 chars each, 40k total)" },
          top_n: { type: "integer", description: "Optional - return only the top N results" },
          cache: { type: "boolean", description: "Optional - false disables the default-on response cache" },
        },
        required: ["query", "documents"],
      },
      output: { example: { id: "gen-rerank-…", model: "rerank-v3.5", results: [{ index: 0, relevance_score: 0.89, document: { text: "Paris is the capital of France." } }, { index: 1, relevance_score: 0.15, document: { text: "Berlin is the capital of Germany." } }], usage: { search_units: 1 } } },
    },
    handler: rerankHandler,
  },
  {
    route: "POST /v1/images/generations",
    name: "Image generation (OpenAI-compatible)",
    slug: "v1-images",
    category: "llm",
    price: "$0.080",
    description:
      "OpenAI-compatible image generation over x402 - point any OpenAI SDK's images.generate() at base_url https://agent402.tools/v1 and pay $0.08 per image in USDC, no API key, no signup. Served by Gemini 2.5 Flash Image (nano banana); prompt in (up to 4k chars), inline base64 image out (response_format b64_json). One image per call (n locked to 1). Optional zdr:true routes only to zero-data-retention providers.",
    tags: ["image-generation", "images", "text-to-image", "nano-banana", "gemini", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A minimalist watercolor of a fox reading a newspaper in a forest clearing" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the image to generate (up to 4,000 chars)" },
          zdr: { type: "boolean", description: "Optional - true routes only to zero-data-retention providers" },
        },
        required: ["prompt"],
      },
      output: { example: { created: 1750000000, model: IMAGES_MODEL, data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAA…", media_type: "image/png" }], usage: { prompt_tokens: 14, completion_tokens: 1290, total_tokens: 1304 } } },
    },
    handler: imagesHandler,
  },
  {
    route: "POST /v1/audio/speech",
    name: "Text-to-speech (OpenAI-compatible)",
    slug: "v1-audio-speech",
    category: "llm",
    price: "$0.060",
    description:
      "OpenAI-compatible text-to-speech over x402 - point any OpenAI SDK's audio.speech.create() at base_url https://agent402.tools/v1 and pay $0.06 per call in USDC, no API key, no signup. Served by Voxtral Mini TTS behind a five-model failover chain (xAI Grok Voice, Kokoro, MAI-Voice-2 Flash, MAI-Voice-2), every link proven by a real paid canary - a provider outage never becomes your failure. Up to 2,000 chars in, raw mp3 (default) or pcm bytes out - the same wire shape as OpenAI's endpoint. OpenAI voice names (alloy, nova, …) map per-model; native voice ids (e.g. en_paul_cheerful) work too. zdr:true routes only to zero-data-retention providers.",
    tags: ["tts", "text-to-speech", "speech", "audio", "voice", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { input: "Agent402 serves fourteen hundred tools, paid per call.", voice: "alloy" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Text to speak (up to 2,000 chars)" },
          voice: { type: "string", description: "OpenAI voice name - alloy (default), ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse - or a native voice id from GET /v1/models (e.g. en_paul_cheerful)" },
          response_format: { type: "string", description: '"mp3" (default) or "pcm"' },
          model: { type: "string", description: "Optional - pin a chain model (e.g. mistralai/voxtral-mini-tts-2603); the rest stay as fallbacks" },
          speed: { type: "number", description: "Optional 0.25–4 playback speed (providers that don't support it ignore it)" },
          zdr: { type: "boolean", description: "Optional - true routes only to zero-data-retention providers" },
        },
        required: ["input"],
      },
      output: { example: "(raw mp3 bytes - Content-Type: audio/mpeg)" },
    },
    handler: speechHandler,
  },
];

// server.js's global express.json({limit:"100kb"}) runs before every /v1/*
// route and rejects a bigger body with a 413 before a tier's own
// maxInputChars is ever checked. Found live (2026-08-12): v1-chat-premium
// advertises maxInputChars:200000 here, but nothing past ~90k chars is
// actually reachable - a caller who trusts this discovery field gets an
// opaque 413 instead of being served, or the tier's own clean "too large"
// 400. Every OTHER tier's cap (<=48k) already fits safely under 100kb, so
// this only clamps what premium advertises, not what it internally
// enforces (that stays 200_000 - harmless groundwork for when the body
// limit itself is raised, see that change's own commit message).
const ADVERTISED_MAX_INPUT_CHARS = 85_000;
// The METERED routes are the exception: server.js mounts a 1 MB parser on
// /v1/metered (2026-08-27), so the metered tier advertises its real 200k cap -
// an agent host (Claude Code sends ~110 KB a turn) reads this field to decide
// whether it fits, and the clamped figure told OpenClaw's setup to refuse
// models that serve fine.

/** OpenAI-compatible GET /v1/models payload — free discovery surface. */
export function modelsList() {
  const data = [];
  for (const [slug, tier] of Object.entries(TIERS)) {
    // A tier whose upstream model has been withdrawn stops being advertised
    // here within seconds of boot (see probeOxAlphaAvailability) - /v1/models
    // is the machine-readable surface agents pick models from, and pointing
    // one at a dead id is the exact class the live-catalog CI guard exists for.
    if (typeof tier.available === "function" && !tier.available()) continue;
    // The metered tier's prefixes are the union of the flat tiers' - listing
    // them again would duplicate every id. Instead each chat entry carries
    // `meteredEndpoint`, the route that quotes the same model per request.
    if (tier.metered) continue;
    for (const p of tier.prefixes) {
      data.push({
        // A family prefix that is not itself an upstream id is advertised as
        // the concrete model it resolves to (PREFIX_CANONICAL) - an agent
        // must be able to send any id on this list verbatim.
        id: p.endsWith("/") ? `${p}*` : (PREFIX_CANONICAL[p.toLowerCase()] || p),
        object: "model",
        owned_by: p.split("/")[0],
        x402: {
          tier: slug, endpoint: tier.route.split(" ")[1], priceUsd: tier.price, maxTokens: tier.maxTokens,
          ...(tier.defaultModel ? { defaultModel: tier.defaultModel } : {}),
          ...(slug.startsWith("v1-chat") && !tier.lockedModel && !tier.router && TIERS["v1-chat-metered"]
            ? {
              meteredEndpoint: TIERS["v1-chat-metered"].route.split(" ")[1], meteredFromUsd: TIERS["v1-chat-metered"].price,
              meteredMessagesEndpoint: "/v1/metered/messages",
              meteredResponsesEndpoint: "/v1/metered/responses",
              // The metered route validates against ITS caps, not the flat home
              // tier's: a client deriving a context window from this entry must
              // not carry the flat cap onto the metered route (agent402-openclaw
              // did, and OpenClaw refused every turn as a context overflow).
              meteredMaxInputChars: TIERS["v1-chat-metered"].maxInputChars, meteredMaxTokens: TIERS["v1-chat-metered"].maxTokens,
            }
            : {}),
          maxInputChars: Math.min(tier.maxInputChars, ADVERTISED_MAX_INPUT_CHARS),
          // Disclosure rides on the machine surface too, not only in prose:
          // an agent choosing a model must be able to SEE that this one shares
          // prompts and cannot be routed zero-data-retention.
          ...(tier.logsPrompts ? { dataRetention: "provider-retains-prompts", zdr: false } : {}),
          ...(tier.stealth ? { stealth: true } : {}),
          // Server tools and the exact server-owned limits that ride on them.
          // An agent picking a route must be able to SEE the loop budget it
          // gets, and that the per-tool caps are not negotiable.
          ...(tier.serverTools ? {
            serverTools: {
              maxSteps: tier.serverTools.maxSteps,
              tools: Object.fromEntries(Object.entries(tier.serverTools.tools).map(([type, limits]) => [type, { ...limits, ...SERVER_TOOL_POLICY[type].pin(limits) }])),
              note: "Server-owned. stop_server_tools_when and max_tool_calls are set by the gateway and refused on the request.",
            },
          } : {}),
        },
      });
    }
  }
  for (const m of EMBEDDINGS_MODELS) {
    data.push({
      id: m,
      object: "model",
      owned_by: "openai",
      x402: { tier: "v1-embeddings", endpoint: EMBEDDINGS_PATH, priceUsd: EMBEDDINGS_PRICE, maxInputChars: EMBEDDINGS_MAX_CHARS, maxItems: EMBEDDINGS_MAX_ITEMS },
    });
  }
  data.push({
    id: IMAGES_MODEL,
    object: "model",
    owned_by: "google",
    x402: { tier: "v1-images", endpoint: IMAGES_PATH, priceUsd: IMAGES_PRICE, maxPromptChars: IMAGES_MAX_PROMPT_CHARS, imagesPerCall: 1 },
  });
  for (const m of SPEECH_MODELS) {
    data.push({
      id: m.id,
      object: "model",
      owned_by: m.id.split("/")[0],
      x402: { tier: "v1-audio-speech", endpoint: SPEECH_PATH, priceUsd: SPEECH_PRICE, maxInputChars: SPEECH_MAX_CHARS, voices: [...m.voices] },
    });
  }
  return { object: "list", data, terms_of_service: "https://agent402.tools/terms", note: "Prefixes ending in /* allow the whole vendor family. Pay per call via x402 (USDC on Base, Solana, Polygon, Arbitrum, Stellar) - no API key. Bare OpenAI-style names (gpt-4o-mini) are accepted and mapped. Use constitutes acceptance of the terms_of_service (acceptable-use policy included)." };
}
