// /v1/.../messages - the Anthropic Messages API wire on the same five tiers as
// the OpenAI-compatible chat completions routes (build #12 of the 2026-08-18
// rail deep-dive). Claude Code, the Anthropic Agent SDK and every
// Anthropic-SDK user pay per call by pointing base_url at
// https://agent402.tools/v1 (or /v1/nano, /v1/pro, /v1/premium) - no key.
//
// Same tier = same price, model allowlist, input/output caps, provider
// max_price, flex-first attempts, failover chain and margin clamp as the chat
// route of that tier (TIERS in llm-gateway-kit.js). What is different is only
// the wire: Anthropic request shape in (system, messages with content blocks,
// tools with input_schema, thinking, stop_sequences, top_k...), Anthropic
// response shape out (content[], stop_reason, usage.input_tokens/
// output_tokens, SSE events message_start...message_stop). OpenRouter's
// /api/v1/messages serves ANY model through this wire (live-verified
// 2026-08-19 with claude-sonnet-5 and gemini-2.5-flash-lite), so the tier's
// non-Anthropic fallbacks work as failover links too.
//
// Billing fields: OpenRouter puts usage.cost / is_byok / cost_details in the
// non-stream body AND in the stream's message_delta frame (live-verified) -
// stripped here (non-stream) and by createSseUsageScrubber (stream; it keys
// on `"usage"` in data: lines, which message_delta carries at top level).
//
// Deliberately NOT on this wire (yet): the opt-in prompt cache (`cache:true`
// keys on the OpenAI-shaped normalized body), default reasoning-effort
// injection (the Anthropic wire expresses thinking as `thinking`, which the
// buyer sets natively), and routing on the auto tier by prompt class is
// supported (classifyPrompt reads text blocks). Buyer-settable OpenRouter
// knobs are the same as the chat wire: zdr, cache_control (top-level, the
// Anthropic-native per-block cache_control passes through untouched).
import { createHash } from "node:crypto";
import {
  TIERS, AUTO_RANKINGS, classifyPrompt, canonicalModel, tierAllows, tierFor,
  clampToMargin, flexAttempts, cacheControlPref, upstreamUserId, PROVIDER_SORT_ENABLED,
  fetchOpenRouter, throwUpstreamError, streamOpenRouterTo, bad, MAX_IMAGES,
  refuseCostVariants, checkBlockCacheControl, meteredQuoteForProbe, costFor,
  assertUpstreamBody,
} from "./llm-gateway-kit.js";
import { METER_MARKUP, METER_MIN_SETTLE_USD, setMeterSentinel } from "../gateway-meter.js";

const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";
const IMAGE_TOKENS = 1600; // same flat per-image estimate as the chat wire
const MAX_STOP_SEQUENCES = 8;
const MAX_TOOLS = 64;

/** Tier slug -> the Messages route path on that tier (the base tier lives at
 *  /v1/messages, like /v1/chat/completions). */
export const MESSAGES_PATH_BY_TIER = {
  "v1-chat-nano": "/v1/nano/messages",
  "v1-chat-auto": "/v1/auto/messages",
  "v1-chat": "/v1/messages",
  "v1-chat-pro": "/v1/pro/messages",
  "v1-chat-premium": "/v1/premium/messages",
  // Metered LAST (same ordering rule as TIERS): the 402 price is a per-request
  // quote from the body, settled at actual usage over upto / credits / card.
  "v1-chat-metered": "/v1/metered/messages",
};

/** Per-request price of the metered Messages route, from the RAW body. Never
 *  throws: an invalid body quotes the floor (the handler's own 400 refuses it,
 *  uncharged); an over-cap body quotes the cap (same). Mirrors meteredQuoteUsd
 *  on the chat wire, priced from the Messages probe. */
export function meteredMessagesQuoteUsd(input) {
  const tier = TIERS["v1-chat-metered"];
  try {
    const { probe, imageCount } = validateMessagesRequest(input, "v1-chat-metered");
    return meteredQuoteForProbe(probe, imageCount);
  } catch (e) {
    return { usd: tier.price, invalid: true, reason: String(e?.message || e).slice(0, 160) };
  }
}
export const MESSAGES_TIER_BY_PATH = Object.fromEntries(Object.entries(MESSAGES_PATH_BY_TIER).map(([t, p]) => [p, t]));

function textOfBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** Walk Anthropic content blocks: validate, count chars, count images, and
 *  build a token-estimate probe copy with image payloads replaced by a marker
 *  (a base64 image is not prompt text - it is billed flat per image). */
function probeContent(content, where, acc) {
  if (typeof content === "string") { acc.chars += content.length; return content; }
  if (!Array.isArray(content)) throw bad(`${where}.content must be a string or an array of content blocks`);
  return content.map((b, i) => {
    if (!b || typeof b !== "object" || typeof b.type !== "string") throw bad(`${where}.content[${i}] must be a content block with a type`);
    checkBlockCacheControl(b.cache_control, `${where}.content[${i}]`);
    switch (b.type) {
      case "text":
        if (typeof b.text !== "string") throw bad(`${where}.content[${i}].text must be a string`);
        acc.chars += b.text.length;
        return b;
      case "image": {
        const src = b.source;
        if (!src || typeof src !== "object") throw bad(`${where}.content[${i}].source is required for an image block`);
        if (src.type === "base64") {
          if (typeof src.data !== "string" || !src.data) throw bad(`${where}.content[${i}].source.data must be base64 text`);
          if (src.data.length > 1_500_000) throw bad(`${where}.content[${i}] image too large (max ~1MB)`);
          if (typeof src.media_type !== "string" || !/^image\//.test(src.media_type)) throw bad(`${where}.content[${i}].source.media_type must be an image/* type`);
        } else if (src.type === "url") {
          if (typeof src.url !== "string" || !/^https?:\/\//.test(src.url) || src.url.length > 2048) throw bad(`${where}.content[${i}].source.url must be an http(s) URL`);
        } else {
          throw bad(`${where}.content[${i}].source.type must be "base64" or "url"`);
        }
        acc.images++;
        return { type: "image" }; // probe marker: tokens billed flat
      }
      case "tool_use":
        if (typeof b.id !== "string" || typeof b.name !== "string") throw bad(`${where}.content[${i}] tool_use needs id + name`);
        acc.chars += JSON.stringify(b.input ?? {}).length + b.name.length;
        return b;
      case "tool_result": {
        if (typeof b.tool_use_id !== "string") throw bad(`${where}.content[${i}] tool_result needs tool_use_id`);
        const inner = b.content === undefined ? "" : probeContent(b.content, `${where}.content[${i}]`, acc);
        return { ...b, content: inner };
      }
      case "thinking":
      case "redacted_thinking":
        // assistant-turn echoes of prior thinking (multi-turn with extended thinking); passed through, counted as text
        acc.chars += typeof b.thinking === "string" ? b.thinking.length : (typeof b.data === "string" ? b.data.length : 0);
        return b;
      default:
        throw bad(`${where}.content[${i}]: unsupported block type "${b.type}" (allowed: text, image, tool_use, tool_result, thinking)`);
    }
  });
}

/** Validate an Anthropic Messages request for a tier. Returns
 *  { body, probe, imageCount, isRouted, chain } - `body` is the outbound
 *  Anthropic body (model resolved, caps applied), `probe` a token-estimate
 *  copy for the margin clamp. */
export function validateMessagesRequest(input, tierSlug) {
  const tier = TIERS[tierSlug];
  if (!tier) throw bad(`unknown tier ${tierSlug}`, 500);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Body must be a JSON object (Anthropic Messages request)");
  // model: required unless the tier routes; allowlisted per tier like the chat wire
  const isRouted = tier.router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto");
  let model = canonicalModel(input.model);
  let defaultedModel = null;
  if (!isRouted) {
    refuseCostVariants(model);
    // No model named: serve the tier's default instead of refusing (30 days of
    // real callers: 82 refusals for a missing "model" across the LLM wires -
    // agents posting to a tier route expect that tier's model, 2026-08-28).
    if (!model && tier.defaultModel) { model = tier.defaultModel; defaultedModel = model; }
    if (!model) throw bad(`"model" is required (e.g. anthropic/claude-sonnet-5). This tier serves: ${tier.prefixes?.slice(0, 6).join(", ") || "see /v1/models"}`);
    if (!tierAllows(tierSlug, model)) {
      const home = tierFor(model);
      // Not every chat tier has a Messages twin (MESSAGES_PATH_BY_TIER is an
      // explicit map, not a derivation) - a tier added to TIERS alone would
      // otherwise be advertised here at a path that does not exist. Point at
      // the tier's real chat route in that case.
      const homePath = home ? (MESSAGES_PATH_BY_TIER[home] || TIERS[home].route.split(" ")[1]) : null;
      throw bad(home && home !== tierSlug ? `"${model}" is served on ${homePath} (${home})` : `"model" ${model} is not served on this tier - GET /v1/models lists every model and its tier`);
    }
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) throw bad('"messages" must be a non-empty array');
  const acc = { chars: 0, images: 0 };
  // Mid-conversation system messages (Anthropic's mid-conversation-system beta;
  // Claude Code sends one per turn, measured 2026-08-27) are folded into a user
  // turn - the pre-beta shape every upstream accepts. Consecutive user turns are
  // legal on the Messages wire; the text reaches the model in the same position.
  const messages = input.messages.map((m, i) => {
    if (!m || typeof m !== "object") throw bad(`messages[${i}] must be an object`);
    if (m.role === "system") {
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      return { role: "user", content };
    }
    return m;
  });
  const probeMessages = messages.map((m, i) => {
    if (m.role !== "user" && m.role !== "assistant") throw bad(`messages[${i}].role must be "user", "assistant" or "system"`);
    return { role: m.role, content: probeContent(m.content, `messages[${i}]`, acc) };
  });
  let system;
  if (input.system !== undefined) {
    if (typeof input.system === "string") { acc.chars += input.system.length; system = input.system; }
    else if (Array.isArray(input.system)) { system = probeContent(input.system, "system", acc); }
    else throw bad('"system" must be a string or an array of text blocks');
  }
  if (acc.chars > tier.maxInputChars) throw bad(`Input too large (${acc.chars} chars). The ${tierSlug} tier allows up to ${tier.maxInputChars} chars`);
  if (acc.images > MAX_IMAGES) throw bad(`Too many images (${acc.images}). Maximum is ${MAX_IMAGES} per request`);
  // max_tokens: required by the Anthropic wire; clamp to the tier cap (drop-in friendliness, like the chat wire)
  let maxTokens = parseInt(input.max_tokens, 10);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) throw bad('"max_tokens" (positive integer) is required by the Messages API');
  if (maxTokens > tier.maxTokens) maxTokens = tier.maxTokens;

  const body = { model: isRouted ? undefined : model, max_tokens: maxTokens, messages };
  if (system !== undefined) body.system = input.system;
  // Sampling params on the Messages wire (live docs, read 2026-08-28): models
  // released after Claude Opus 4.6 REFUSE `top_k` at any value, `temperature`
  // other than 1, and `top_p` under 0.99 - a 400 from Anthropic, relayed to
  // the buyer as an upstream error with no explanation. Say it ourselves, and
  // only for the models it applies to; older models keep the old freedom.
  // Only the models released AFTER Opus 4.6 (opus-4.7/4.8/5, sonnet-5).
  // Haiku 4.5 and everything older keep the old freedom.
  const strictSampling = /^anthropic\/claude-(opus-(5|4\.[78])|sonnet-5)/.test(String(model || ""));
  if (strictSampling) {
    if (input.top_k !== undefined) throw bad('"top_k" is not supported by this model (Anthropic removed it for models after Claude Opus 4.6); omit it');
    if (input.temperature !== undefined && Number(input.temperature) !== 1) throw bad('"temperature" must be 1 for this model (Anthropic removed other values for models after Claude Opus 4.6)');
    if (input.top_p !== undefined && Number(input.top_p) < 0.99) throw bad('"top_p" must be at least 0.99 for this model (Anthropic removed lower values for models after Claude Opus 4.6)');
  }
  for (const k of ["temperature", "top_p", "top_k", "metadata", "tool_choice"]) if (input[k] !== undefined) body[k] = input[k];
  // tool_choice mirrors the tools guard (client tools only): Anthropic wire is
  // {type:"auto"|"any"|"none"} or {type:"tool", name}; anything else refused.
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    const okType = tc && typeof tc === "object" && (tc.type === "auto" || tc.type === "any" || tc.type === "none" || (tc.type === "tool" && typeof tc.name === "string"));
    if (!okType) throw bad('"tool_choice" must be {type:"auto"|"any"|"none"} or {type:"tool", name}');
  }
  if (input.stop_sequences !== undefined) {
    if (!Array.isArray(input.stop_sequences) || input.stop_sequences.length > MAX_STOP_SEQUENCES || !input.stop_sequences.every((x) => typeof x === "string")) throw bad(`"stop_sequences" must be an array of up to ${MAX_STOP_SEQUENCES} strings`);
    body.stop_sequences = input.stop_sequences;
  }
  // `tools: []` is what an Anthropic client sends when it has no tools this
  // turn (Claude Code's session-naming call, measured 2026-08-27): no tools.
  if (input.tools !== undefined && !(Array.isArray(input.tools) && input.tools.length === 0)) {
    if (!Array.isArray(input.tools) || input.tools.length > MAX_TOOLS) throw bad(`"tools" must be an array of up to ${MAX_TOOLS} tool definitions`);
    for (const [i, t] of input.tools.entries()) {
      // Anthropic client tools only: {name, description?, input_schema}. Server
      // tools (web_search_20250305, computer use, text editor...) create spend
      // bounded by neither max_tokens nor max_price - refused, same rule as the
      // chat wire's openrouter:* server tools.
      if (!t || typeof t !== "object" || typeof t.name !== "string") throw bad(`tools[${i}] needs a name`);
      if (t.type !== undefined && t.type !== "custom") throw bad(`tools[${i}]: server/built-in tool type "${t.type}" is not served (client tools with input_schema only)`);
      if (!t.input_schema || typeof t.input_schema !== "object") throw bad(`tools[${i}].input_schema is required`);
      checkBlockCacheControl(t.cache_control, `tools[${i}]`);
    }
    body.tools = input.tools;
  }
  if (input.thinking !== undefined) {
    const th = input.thinking;
    if (!th || typeof th !== "object" || !["enabled", "disabled", "adaptive"].includes(th.type)) throw bad('"thinking" must be {type:"enabled", budget_tokens} | {type:"adaptive"} | {type:"disabled"}');
    if (th.type === "enabled") {
      const b = Number(th.budget_tokens);
      if (!Number.isInteger(b) || b < 1024) throw bad('"thinking.budget_tokens" must be an integer >= 1024');
      if (b >= maxTokens) throw bad(`"thinking.budget_tokens" (${b}) must be below max_tokens (${maxTokens}) - thinking tokens are output tokens`);
    }
    body.thinking = th;
  }
  if (input.stream === true) body.stream = true;
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  cacheControlPref(input); // shape-validate (400 on bad value); applied call-time
  const probe = { model: body.model, max_tokens: maxTokens, messages: probeMessages, ...(system !== undefined ? { system } : {}), ...(body.tools ? { tools: body.tools } : {}), ...(body.thinking ? { thinking: body.thinking } : {}) };
  const routedCategory = isRouted ? classifyPrompt([...(typeof system === "string" ? [{ role: "user", content: system }] : []), ...probeMessages]) : null;
  const routedQuality = isRouted ? (input.quality === undefined ? "balanced" : String(input.quality)) : null;
  if (isRouted && !AUTO_RANKINGS[routedQuality]) throw bad('"quality" must be "fast", "balanced", or "best"');
  const chain = isRouted ? [...AUTO_RANKINGS[routedQuality][routedCategory]] : [model, ...(tier.fallbacks || []).filter((m) => m !== model)];
  return { body, probe, imageCount: acc.images, isRouted, routedCategory, routedQuality, chain, defaultedModel };
}

/** stop_reason max_tokens with nothing said = the cap was spent (thinking ate
 *  it) - a paid empty answer; walk the chain like the chat wire does. */
export function isEmptyMaxTokens(data) {
  if (!data || data.stop_reason !== "max_tokens") return false;
  const blocks = Array.isArray(data.content) ? data.content : [];
  return !blocks.some((b) => (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "") || b?.type === "tool_use");
}

function stripBilling(usage) {
  if (!usage || typeof usage !== "object") return null;
  const upstreamUsd = typeof usage.cost === "number" ? usage.cost : null;
  delete usage.cost; delete usage.cost_details; delete usage.is_byok; delete usage.cache_discount;
  return upstreamUsd;
}

export function makeMessagesHandler(tierSlug) {
  return async function messagesHandler(input, req) {
    const tier = TIERS[tierSlug];
    const { body, probe, imageCount, isRouted, routedCategory, routedQuality, chain, defaultedModel } = validateMessagesRequest(input, tierSlug);
    // Metered belt (same as the chat wire): the price this request was gated
    // at must cover the body actually being served; a mismatch is refused 400
    // (settlement cancelled, hold released, nothing spent).
    // Cap, pre-spend and independent of how the call arrived (HTTP with a
    // stashed quote, or an in-process caller with no request): the chat wire
    // refuses this in validateRequest; the Messages wire clamped the quote to
    // the cap and served the full body (review 2026-08-27).
    if (tier.metered) {
      const q = meteredQuoteForProbe(probe, imageCount);
      if (q.overCap) throw bad(`This request would cost $${q.rawUsd.toFixed(4)} metered, above the $${tier.maxQuoteUsd} per-call cap of ${MESSAGES_PATH_BY_TIER[tierSlug]} - lower max_tokens or the input, or use a flat tier (GET /v1/models).`);
    }
    if (tier.metered && Number.isFinite(req?.__meteredQuoteUsd)) {
      const q = meteredMessagesQuoteUsd(input);
      if (q.invalid || q.overCap || q.usd > req.__meteredQuoteUsd * (1 + 1e-6) + 1e-9) {
        throw bad(`This request was quoted at $${req.__meteredQuoteUsd} but the body being served quotes $${q.usd}${q.invalid ? ` (${q.reason})` : ""}. Nothing was charged; resend the request exactly as it should be served (no query-string or wrapped fields).`, 400);
      }
    }
    // Metered: the quote priced THIS model at its MODEL_COST row, so the
    // upstream bound is that row, never the tier-wide cap (audit 2026-08-26).
    const meteredBound = tier.metered ? costFor(body.model) : null;
    const quotedUsd = tier.metered && Number.isFinite(req?.__meteredQuoteUsd) && req.__meteredQuoteUsd > 0 ? req.__meteredQuoteUsd : null;
    const providerPrefs = {
      ...(meteredBound ? { max_price: { prompt: meteredBound.prompt, completion: meteredBound.completion } }
        : tier.maxPrice ? { max_price: tier.maxPrice } : {}),
      ...(body.zdr === true ? { zdr: true } : {}),
      ...(tier.priceSort === true && PROVIDER_SORT_ENABLED() ? { sort: "price" } : {}),
    };
    const provider = Object.keys(providerPrefs).length ? providerPrefs : undefined;
    const user = upstreamUserId(req);
    const cacheControl = cacheControlPref(input);
    const outboundFor = (model, flex = false) => {
      // Margin: clamp max_tokens on the PROBE (image payloads excluded, images
      // billed flat), then carry the clamped cap onto the real body.
      const p = { ...probe, model };
      clampToMargin(p, tier, imageCount); // throws 400 -> caller skips this link
      return {
        ...body, model, max_tokens: Math.min(body.max_tokens, p.max_tokens), zdr: undefined,
        ...(provider ? { provider } : {}), ...(user ? { user, session_id: user } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
        ...(flex ? { service_tier: "flex" } : {}),
      };
    };
    const recordUsage = (usage, upstreamUsd, served, serviceTier) => import("../posthog.js")
      .then(({ capturePostHogGatewayUsage }) => capturePostHogGatewayUsage({
        tier: `${tierSlug}:messages`, model: served, priceUsd: quotedUsd ?? tier.price, upstreamUsd,
        promptTokens: usage?.input_tokens, completionTokens: usage?.output_tokens, serviceTier, defaulted: !!defaultedModel,
      })).catch(() => {});
    const attempts = flexAttempts(chain);
    const routerNote = isRouted ? { category: routedCategory, quality: routedQuality } : null;

    if (body.stream === true) {
      return {
        __sse: async (res) => {
          let lastErr;
          for (const { model, flex } of attempts) {
            let outbound;
            try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
            try {
              return await streamOpenRouterTo(outbound, res, {
                url: OPENROUTER_MESSAGES_URL,
                onUsage: (usage, cost, frame) => recordUsage(usage, cost, frame?.message?.model || model, frame?.usage?.service_tier || (flex ? "flex" : "default")),
              });
            } catch (e) {
              if (res.headersSent || ![502, 503, 504].includes(e?.statusCode)) throw e;
              lastErr = e;
            }
          }
          throw lastErr || bad("No upstream model could serve this request", 502);
        },
      };
    }

    let lastErr;
    let refusedModel = null;
    for (const { model, flex } of attempts) {
      if (model === refusedModel) continue;
      let outbound;
      try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
      try {
        const res = await fetchOpenRouter(outbound, { url: OPENROUTER_MESSAGES_URL });
        if (!res.ok) await throwUpstreamError(res);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
        assertUpstreamBody(data);
        if (data?.stop_reason === "refusal" && isEmptyMaxTokens({ ...data, stop_reason: "max_tokens" })) {
          lastErr = bad("Upstream declined the request (safety filter) - rephrase the prompt, or pick a different model", 502);
          refusedModel = model;
          continue;
        }
        if (isEmptyMaxTokens(data)) {
          lastErr = bad("Upstream produced no content within max_tokens (thinking consumed it) - raise max_tokens, lower thinking.budget_tokens, or disable thinking", 502);
          refusedModel = model;
          continue;
        }
        const upstreamUsd = stripBilling(data.usage);
        await recordUsage(data.usage, upstreamUsd, data.model || model, data.usage?.service_tier || (flex ? "flex" : "default"));
        if (routerNote) data.agent402_router = { ...routerNote, served: data.model || model };
        if (defaultedModel) data.agent402_default_model = defaultedModel; // the caller sent no model; say what served
        // Metered settlement sentinel (chat-wire parity): the route binder
        // settles actual x markup for upto/credits buyers and strips this
        // before the body leaves. A non-number means "no meter", never "free".
        if (typeof upstreamUsd === "number") setMeterSentinel(data, upstreamUsd);
        return data;
      } catch (e) {
        if (![502, 503, 504].includes(e?.statusCode)) throw e;
        lastErr = e;
      }
    }
    throw lastErr || bad("No upstream model could serve this request", 502);
  };
}

const EXAMPLE_IN = { model: "anthropic/claude-sonnet-5", max_tokens: 256, messages: [{ role: "user", content: "Summarize x402 in one sentence." }] };
const EXAMPLE_OUT = { id: "msg_…", type: "message", role: "assistant", model: "anthropic/claude-sonnet-5", content: [{ type: "text", text: "x402 is an HTTP-native way for agents to pay per request with USDC." }], stop_reason: "end_turn", usage: { input_tokens: 14, output_tokens: 18 } };
const TAGS = ["llm", "ai", "inference", "anthropic-compatible", "messages-api", "claude", "gateway", "openrouter"];
const INPUT_SCHEMA = {
  properties: {
    model: { type: "string", description: "Model id (OpenRouter naming, e.g. anthropic/claude-sonnet-5) - allowlisted per tier; omit (or \"auto\") on the auto tier" },
    max_tokens: { type: "integer", description: "Required by the Messages API; clamped to the tier's output cap" },
    messages: { type: "array", description: "Anthropic messages: {role: user|assistant, content: string | [text|image|tool_use|tool_result blocks]}" },
    system: { type: "string", description: "Optional system prompt (string or text blocks)" },
    tools: { type: "array", description: "Optional client tools {name, description, input_schema}; server/built-in tools are not served" },
    thinking: { type: "object", description: 'Optional {type:"enabled", budget_tokens} | {type:"adaptive"} | {type:"disabled"} - thinking tokens are output tokens' },
    stream: { type: "boolean", description: "Anthropic SSE (message_start … message_stop)" },
    zdr: { type: "boolean", description: "Optional - zero-data-retention providers only" },
  },
  required: ["max_tokens", "messages"],
};

function describe(tierSlug) {
  const t = TIERS[tierSlug];
  const dflt = t.defaultModel ? ` Omit "model" and the tier serves ${t.defaultModel} (named back in agent402_default_model); the price does not change.` : "";
  const price = priceString(tierSlug);
  if (tierSlug === "v1-chat-metered") {
    return `Anthropic Messages API billed per request from what the call costs: the 402 quotes exact-BPE input (system + messages + tools) plus your max_tokens at the model's list price, times ${METER_MARKUP}, from ${price} up to a $${t.maxQuoteUsd} per-call cap. Point the Anthropic SDK (or any Messages-format client) at base_url https://agent402.tools/v1/metered. Any model from the flat tiers (GET /v1/models). Pay the quote over x402 exact, or authorize it as a ceiling over upto, credits or card and settle actual usage. Up to ${t.maxInputChars.toLocaleString("en-US")} input chars and ${t.maxTokens} output tokens; streaming supported.`;
  }
  const base = `Anthropic Messages API over x402 - point the Anthropic SDK (or Claude Code / the Agent SDK) at base_url https://agent402.tools${MESSAGES_PATH_BY_TIER[tierSlug].replace(/\/messages$/, "")} and pay ${price} per call in USDC, no API key, no signup. Same models, caps and price as this tier's /chat/completions route; any model here is served through the Messages wire (Claude natively, others translated). Up to ${t.maxInputChars.toLocaleString("en-US")} input chars and ${t.maxTokens} output tokens; streaming supported.`;
  return tierSlug === "v1-chat-auto"
    ? `${base} Omit "model" and the gateway routes the prompt to the top-ranked model for its task type; the response adds agent402_router {category, quality, served}.`
    : base + dflt;
}

// Example model per tier: a LIVE id (the "answers its own example" CI check
// calls upstream with it; a bare allowlist prefix would 400 there) - Claude
// where the tier serves Claude, the tier's cheapest chat example otherwise.
const EXAMPLE_MODEL_BY_TIER = {
  "v1-chat-metered": "anthropic/claude-haiku-4.5",
  "v1-chat-nano": "google/gemini-2.5-flash-lite",
  "v1-chat": "anthropic/claude-haiku-4.5",
  "v1-chat-pro": "anthropic/claude-sonnet-5",
  "v1-chat-premium": "anthropic/claude-opus-5",
};
const TIER_LABEL = { "v1-chat-nano": "nano", "v1-chat-auto": "auto", "v1-chat": "base", "v1-chat-pro": "pro", "v1-chat-premium": "premium", "v1-chat-metered": "metered" };
const priceString = (tierSlug) => (tierSlug === "v1-chat-nano" ? "$0.003" : tierSlug === "v1-chat-metered" ? `$${METER_MIN_SETTLE_USD}` : `$${TIERS[tierSlug].price.toFixed(2)}`);

export const LLM_MESSAGES_TOOLS = Object.entries(MESSAGES_PATH_BY_TIER).map(([tierSlug, path]) => ({
  route: `POST ${path}`,
  name: `Messages ${TIER_LABEL[tierSlug]} (Anthropic-compatible)`,
  slug: `${tierSlug}-messages`,
  category: "llm",
  price: priceString(tierSlug),
  // payments.js: a `quote` makes the x402 price a per-request function of the body.
  ...(tierSlug === "v1-chat-metered" ? { quote: (body) => meteredMessagesQuoteUsd(body).usd } : {}),
  description: describe(tierSlug),
  tags: tierSlug === "v1-chat-metered" ? [...TAGS, "metered", "pay-per-token"] : TAGS,
  discovery: {
    bodyType: "json",
    input: tierSlug === "v1-chat-auto" ? { max_tokens: 256, messages: EXAMPLE_IN.messages } : { ...EXAMPLE_IN, model: EXAMPLE_MODEL_BY_TIER[tierSlug] },
    inputSchema: INPUT_SCHEMA,
    output: { example: EXAMPLE_OUT },
  },
  handler: makeMessagesHandler(tierSlug),
}));

/** Stable key helper for tests/operator (not wired to the pre-paywall cache). */
export function messagesFingerprint(tierSlug, input) {
  const { body } = validateMessagesRequest(input, tierSlug);
  return createHash("sha256").update(`${tierSlug}:messages\n${JSON.stringify(body)}`).digest("hex");
}
