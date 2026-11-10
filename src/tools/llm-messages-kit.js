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
// keys on the OpenAI-shaped normalized body) and the budget tiers' default
// reasoning-effort injection (the Anthropic wire expresses thinking as
// `thinking`, which the buyer sets natively). The one effort the gateway adds
// is premium's small-budget "low" (smallBudgetEffort), and only when the buyer
// set neither effort nor thinking. A buyer's own effort or thinking budget
// that leaves no room for an answer inside the cap is lowered on the outbound
// link and disclosed (agent402_reasoning_adjusted), and an empty max_tokens
// answer gets one same-model run at the lowest depth before the chain walks. Routing on the auto tier by prompt class is
// supported (classifyPrompt reads text blocks). Buyer-settable OpenRouter
// knobs are the same as the chat wire: zdr, cache_control (top-level, the
// Anthropic-native per-block cache_control passes through untouched).
import { createHash } from "node:crypto";
import {
  substitutedFrom, TIERS, AUTO_RANKINGS, classifyPrompt, canonicalModel, tierAllows, tierFor,
  isFlatTier, flatTierQuoteUsd, servedTierFor, crossTierDisclosure, AUTO_MODEL, AUTO_TIER,
  clampToMargin, fitBudgetBelowCap, assertMeteredAvailable, attemptsFor, serviceTierFor, validateServiceTier, cacheControlPref, upstreamUserId, PROVIDER_SORT_ENABLED,
  fetchOpenRouter, upstreamHttpError, refuseUnlistedMeteredModel, isInputTooLarge, streamOpenRouterTo, bad, MAX_IMAGES, maxInputCharsFor, inputTooLargeError,
  failoverChain, modelFallbackPref, availabilitySubstitution, retryRateLimited,
  rateLimitDelaysFor, paymentWindowTimeoutMs, timedOutBudget, streamClientWatch, STREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS,
  refuseCostVariants, checkBlockCacheControl, meteredQuoteForProbe, meteredBoundFor,
  assertUpstreamBody, reasoningProfile, REASONING_EFFORTS, refuseUnsupportedParams, defaultModelFor, defaultModelCompatNote, smallBudgetEffort,
  stripBilling, fitEffortToBudget, fitBudgetForAnswer, lowestEffortFor, reasoningAdjustedNote, recoveryRunAffordable, retryEmptyAtLowestEffort,
  setReasoningAdjustedHeader, reasoningOutsideMaxTokens, REASONING_ADJUSTED, LINK_PROBE,
} from "./llm-gateway-kit.js";
import { METER_MIN_SETTLE_USD, setMeterSentinel } from "../gateway-meter.js";
import { gatewaySettleBreakerCheck } from "../gateway-settle-breaker.js";

const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";
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
  // quote from the body, settled at actual usage over upto / credits; a card
  // pays the quote grossed up for the processor fee.
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
/** The metered Messages body's input size refusal for the pre-payment check
 *  (src/gateway-prepayment.js), or null: this wire's own validation is the
 *  counter, so the two can never disagree about a body. */
export function meteredMessagesInputSizeRefusal(input) {
  try { validateMessagesRequest(input, "v1-chat-metered"); } catch (e) { return isInputTooLarge(e) ? e : null; }
  return null;
}
export const MESSAGES_TIER_BY_PATH = Object.fromEntries(Object.entries(MESSAGES_PATH_BY_TIER).map(([t, p]) => [p, t]));

/** Claude models released after Opus 4.6 (live docs 2026-08-28 + the Fable
 *  parameter list 2026-09-18): top_k gone, temperature must be 1, top_p >= 0.99.
 *  Exported for the tests. */
export function isPostOpus46(model) {
  return /^anthropic\/claude-(opus-(5|4\.[78])|sonnet-5|fable)/.test(String(model || ""));
}
/** Models whose live parameter list carries no tool_choice and which refuse a
 *  forced choice ({type:"any"} / {type:"tool"}) with a 400 - Fable 5.1,
 *  measured 2026-09-18. Fable 5 still lists tool_choice and is not admitted. */
export function noForcedToolChoice(model) {
  return /^anthropic\/claude-fable-5\.1/.test(String(model || ""));
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
        // A citation's text goes upstream with the block (forwardCitations),
        // so it is input like the block's own text and counts against the cap.
        acc.chars += b.text.length + citationChars(b.citations);
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

// What goes upstream is rebuilt from the fields each block type documents,
// never the buyer's object: an unknown field, a file reference (a file source,
// file_id) or a container reference would otherwise reach the upstream
// unread. Runs after validation, so every kept field was checked.
const str = (v) => typeof v === "string";
const cacheOf = (b) => (b.cache_control && typeof b.cache_control === "object"
  ? { cache_control: { type: "ephemeral", ...(b.cache_control.ttl !== undefined ? { ttl: b.cache_control.ttl } : {}) } }
  : {});
// A text block's citations, each rebuilt from the fields its location type
// documents; the file_id a document location may carry is dropped, and a
// citation of a type not listed here is dropped whole.
const CITATION_FIELDS = {
  char_location: { str: ["document_title"], int: ["document_index", "start_char_index", "end_char_index"] },
  page_location: { str: ["document_title"], int: ["document_index", "start_page_number", "end_page_number"] },
  content_block_location: { str: ["document_title"], int: ["document_index", "start_block_index", "end_block_index"] },
  web_search_result_location: { str: ["encrypted_index", "title", "url"], int: [] },
  search_result_location: { str: ["source", "title"], int: ["search_result_index", "start_block_index", "end_block_index"] },
};
/** The characters of a text block's citations that forwardCitations sends
 *  upstream: the cited text and the documented string fields of each citation
 *  of a listed type (a citation of another type is dropped and costs nothing). */
function citationChars(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const c of list) {
    const spec = c && CITATION_FIELDS[c.type];
    if (!spec || !str(c.cited_text)) continue;
    n += c.cited_text.length;
    for (const k of spec.str) if (str(c[k])) n += c[k].length;
  }
  return n;
}
function forwardCitations(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list) {
    const spec = c && CITATION_FIELDS[c.type];
    if (!spec || !str(c.cited_text)) continue;
    const kept = { type: c.type, cited_text: c.cited_text };
    for (const k of spec.str) if (str(c[k]) || (k === "document_title" && c[k] === null)) kept[k] = c[k];
    for (const k of spec.int) if (Number.isInteger(c[k])) kept[k] = c[k];
    out.push(kept);
  }
  return out;
}
function forwardBlock(b) {
  switch (b.type) {
    case "text": {
      const citations = forwardCitations(b.citations);
      return { type: "text", text: b.text, ...(citations && citations.length ? { citations } : {}), ...cacheOf(b) };
    }
    case "image": {
      const src = b.source;
      const source = src.type === "base64"
        ? { type: "base64", media_type: src.media_type, data: src.data }
        : { type: "url", url: src.url };
      return { type: "image", source, ...cacheOf(b) };
    }
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input && typeof b.input === "object" ? b.input : {}, ...cacheOf(b) };
    case "tool_result":
      return {
        type: "tool_result", tool_use_id: b.tool_use_id,
        ...(b.content !== undefined ? { content: forwardBlocks(b.content) } : {}),
        ...(typeof b.is_error === "boolean" ? { is_error: b.is_error } : {}),
        ...cacheOf(b),
      };
    case "thinking":
      return { type: "thinking", thinking: str(b.thinking) ? b.thinking : "", ...(str(b.signature) ? { signature: b.signature } : {}) };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: str(b.data) ? b.data : "" };
    default:
      return null;
  }
}
const forwardBlocks = (c) => (str(c) ? c : c.map(forwardBlock));
const forwardTool = (t) => ({
  ...(t.type === "custom" ? { type: "custom" } : {}),
  name: t.name,
  ...(str(t.description) ? { description: t.description } : {}),
  input_schema: t.input_schema,
  ...(typeof t.strict === "boolean" ? { strict: t.strict } : {}),
  ...cacheOf(t),
});

/** Validate an Anthropic Messages request for a tier. Returns
 *  { body, probe, imageCount, isRouted, chain } - `body` is the outbound
 *  Anthropic body (model resolved, caps applied), `probe` a token-estimate
 *  copy for the margin clamp. */
export function validateMessagesRequest(input, tierSlug) {
  assertMeteredAvailable(TIERS[tierSlug]);
  const tier = TIERS[tierSlug];
  if (!tier) throw bad(`unknown tier ${tierSlug}`, 500);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Body must be a JSON object (Anthropic Messages request)");
  // model: required unless the tier routes; allowlisted per tier like the chat wire
  const isRouted = tier.router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto");
  let model = canonicalModel(input.model);
  const substituted = substitutedFrom(input.model);
  let defaultedModel = null;
  // One read of the parameters a model may not take, shared by the default
  // choice and the refusal below, so the two can never disagree.
  const paramCtx = (() => {
    const msgs = Array.isArray(input.messages) ? input.messages : [];
    return {
      sampling: { temperature: input.temperature, top_p: input.top_p, top_k: input.top_k },
      endsWithAssistant: msgs[msgs.length - 1]?.role === "assistant",
      reasoningBudget: input.thinking?.type === "enabled",
      effortField: "effort",
    };
  })();
  if (!isRouted) {
    refuseCostVariants(model);
    // No model named: serve the tier's default instead of refusing (30 days of
    // real callers: 82 refusals for a missing "model" across the LLM wires -
    // agents posting to a tier route expect that tier's model, 2026-08-28).
    if (!model && tier.defaultModel) {
      model = defaultModelFor(tier, paramCtx);
      defaultedModel = model;
    }
    if (!model) throw bad(`"model" is required (e.g. anthropic/claude-sonnet-5). This tier serves: ${tier.prefixes?.slice(0, 6).join(", ") || "see /v1/models"}`);
    if (!tierAllows(tierSlug, model, input.model)) {
      // "auto" when not gated at the auto price: name the auto route.
      const home = model === AUTO_MODEL ? AUTO_TIER : tierFor(model);
      // Not every chat tier has a Messages twin (MESSAGES_PATH_BY_TIER is an
      // explicit map, not a derivation) - a tier added to TIERS alone would
      // otherwise be advertised here at a path that does not exist. Point at
      // the tier's real chat route in that case.
      const homePath = home ? (MESSAGES_PATH_BY_TIER[home] || TIERS[home].route.split(" ")[1]) : null;
      throw bad(home && home !== tierSlug ? `"${model}" is served on ${homePath} (${home})` : `"model" ${model} is not served on this tier - GET /v1/models lists every model and its tier`);
    }
    // Metered: an id the live list does not carry is refused, as on the chat wire.
    refuseUnlistedMeteredModel(tier, model);
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
  if (acc.chars > tier.maxInputChars && acc.chars > maxInputCharsFor(tierSlug, model)) throw inputTooLargeError(tierSlug, model, acc.chars, MESSAGES_PATH_BY_TIER);
  if (acc.images > MAX_IMAGES) throw bad(`Too many images (${acc.images}). Maximum is ${MAX_IMAGES} per request`);
  // max_tokens: required by the Anthropic wire; clamp to the tier cap (drop-in friendliness, like the chat wire)
  let maxTokens = parseInt(input.max_tokens, 10);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) throw bad('"max_tokens" (positive integer) is required by the Messages API');
  const requestedMaxTokens = maxTokens;
  if (maxTokens > tier.maxTokens) maxTokens = tier.maxTokens;

  const body = { model: isRouted ? undefined : model, max_tokens: maxTokens, messages: messages.map((m) => ({ role: m.role, content: forwardBlocks(m.content) })) };
  if (system !== undefined) body.system = forwardBlocks(input.system);
  // Sampling params on the Messages wire (live docs, read 2026-08-28): models
  // released after Claude Opus 4.6 REFUSE `top_k` at any value, `temperature`
  // other than 1, and `top_p` under 0.99 - a 400 from Anthropic, relayed to
  // the buyer as an upstream error with no explanation. Say it ourselves, and
  // only for the models it applies to; older models keep the old freedom.
  // Only the models released AFTER Opus 4.6 (opus-4.7/4.8/5, sonnet-5, and
  // Fable 5.x, whose live parameter list carries no temperature at all).
  // Haiku 4.5 and everything older keep the old freedom.
  // Claude Haiku 5 takes none of temperature, top_p or top_k (dropped
  // silently upstream), refuses an assistant prefill and a fixed thinking
  // budget: named here, before any upstream call (refuseUnsupportedParams).
  if (!isRouted) {
    refuseUnsupportedParams(model, paramCtx);
  }
  const strictSampling = isPostOpus46(model);
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
    // Fable 5.1 refuses a FORCED tool choice - measured live 2026-09-18 through
    // OpenRouter: `{type:"any"}` answered 400 'tool_choice: type "tool" and
    // "any" are not supported for this model', `{type:"auto"}` served a
    // tool_use block. Its live supported_parameters list carries no
    // tool_choice at all. Say it here with the fix instead of relaying the 400.
    if (noForcedToolChoice(model) && (tc.type === "any" || tc.type === "tool")) {
      throw bad(`"tool_choice" {type:"${tc.type}"} is not supported by ${model} - it accepts {type:"auto"} or {type:"none"} only (a forced tool call is refused upstream). Ask for the tool in the prompt and keep tool_choice auto.`);
    }
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
    body.tools = input.tools.map(forwardTool);
  }
  if (input.thinking !== undefined) {
    const th = input.thinking;
    if (!th || typeof th !== "object" || !["enabled", "disabled", "adaptive"].includes(th.type)) throw bad('"thinking" must be {type:"enabled", budget_tokens} | {type:"adaptive"} | {type:"disabled"}');
    let thinking = th;
    if (th.type === "enabled") {
      const b = Number(th.budget_tokens);
      if (!Number.isInteger(b) || b < 1024) throw bad('"thinking.budget_tokens" must be an integer >= 1024');
      if (b >= maxTokens) {
        // A budget that only collides with OUR clamp of max_tokens (Claude
        // Code on Haiku sends max_tokens 32000 with budget 31999) is clamped
        // with it, keeping a quarter of the output for the answer, rather than
        // refusing a request the buyer wrote correctly. A budget at or above
        // the buyer's OWN max_tokens is still their error.
        const fitted = maxTokens - Math.max(1024, Math.floor(maxTokens / 4));
        if (b < requestedMaxTokens && fitted >= 1024) thinking = { ...th, budget_tokens: fitted };
        else throw bad(`"thinking.budget_tokens" (${b}) must be below max_tokens (${maxTokens}) - thinking tokens are output tokens`);
      }
    }
    body.thinking = thinking;
  }
  // `effort` - Anthropic's primary depth control on Opus 5 / Sonnet 5 / Fable
  // and every Claude 4.7+ (their 2026-07-24 release notes), accepted top-level
  // by OpenRouter's /api/v1/messages. Measured live 2026-09-18 on sonnet-5:
  // the field passes through (thinking_tokens moved 741 -> 583 between low and
  // max on a counting prompt) and OpenRouter does NOT validate the value - an
  // effort of "turbo" answered 200 as if nothing had been sent. So the value
  // is validated HERE against the model's own live-guarded effort list
  // (REASONING_MODELS), refused with that list, and kept in the normalized
  // body because it changes the answer. A model with no effort table (haiku
  // 4.5 and older) does not take the field: refused with the thinking form
  // that model does honour. `thinking:{type:"enabled", budget_tokens}` stays
  // accepted on every model: through OpenRouter it answered 200 on sonnet-5
  // (translated; the thinking block came back, the budget is advisory there)
  // and haiku-4.5 honours it natively (304-char thinking block, same run).
  if (input.effort !== undefined) {
    const effort = input.effort;
    if (typeof effort !== "string" || !REASONING_EFFORTS.includes(effort) || effort === "none") throw bad(`"effort" must be one of: ${REASONING_EFFORTS.filter((e) => e !== "none").join(", ")}`);
    if (!isRouted) {
      const prof = reasoningProfile(model);
      if (!prof) throw bad(`"effort" is not supported by ${model} - it is the depth control on Claude 4.7+ (Opus 5, Sonnet 5, Fable 5.1) and Claude Haiku 5.5. On this model use thinking:{type:"enabled", budget_tokens} instead, or omit effort.`);
      if (!prof.efforts.includes(effort)) throw bad(`"effort" ${JSON.stringify(effort)} is not supported by ${model} - it accepts: ${prof.efforts.join(", ")}`);
    }
    // Anthropic's own rule: thinking disabled with effort xhigh/max is a 400
    // (the two ask for opposite things). Refused before any upstream call.
    if (body.thinking?.type === "disabled" && (effort === "xhigh" || effort === "max")) throw bad(`"effort" ${JSON.stringify(effort)} cannot be combined with thinking:{type:"disabled"} - a disabled-thinking call takes low or medium effort at most. Drop one of the two.`);
    body.effort = effort;
  }
  // `speed: "fast"` (Anthropic's spelling) and `service_tier: "priority"` /
  // "fast" both request the priority endpoint (billed above the headline,
  // live endpoints 2026-09-18). Offered on the
  // tiers flagged `priority` at the same flat price - the clamp prices the
  // probe at PRIORITY_PRICE_FACTOR - and refused with the reason elsewhere,
  // never dropped. Sent upstream as service_tier (one spelling); OpenRouter
  // reports the served tier as usage.service_tier on this wire.
  const serviceTier = validateServiceTier(input, tier);
  if (serviceTier) body.service_tier = serviceTier;
  if (input.stream === true) body.stream = true;
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  cacheControlPref(input); // shape-validate (400 on bad value); applied call-time
  const probe = { model: body.model, max_tokens: maxTokens, messages: probeMessages, ...(system !== undefined ? { system } : {}), ...(body.tools ? { tools: body.tools } : {}), ...(body.thinking ? { thinking: body.thinking } : {}), ...(serviceTier ? { service_tier: serviceTier } : {}) };
  const routedCategory = isRouted ? classifyPrompt([...(typeof system === "string" ? [{ role: "user", content: system }] : []), ...probeMessages]) : null;
  const routedQuality = isRouted ? (input.quality === undefined ? "balanced" : String(input.quality)) : null;
  if (isRouted && !AUTO_RANKINGS[routedQuality]) throw bad('"quality" must be "fast", "balanced", or "best"');
  const chain = isRouted ? [...AUTO_RANKINGS[routedQuality][routedCategory]] : failoverChain(model, tierSlug, { fallback: modelFallbackPref(input) });
  return { body, probe, imageCount: acc.images, isRouted, routedCategory, routedQuality, chain, defaultedModel, substituted: isRouted ? null : substituted };
}

/** stop_reason max_tokens with nothing said = the cap was spent (thinking ate
 *  it) - a paid empty answer; walk the chain like the chat wire does. */
export function isEmptyMaxTokens(data) {
  if (!data || data.stop_reason !== "max_tokens") return false;
  const blocks = Array.isArray(data.content) ? data.content : [];
  return !blocks.some((b) => (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "") || b?.type === "tool_use");
}

/** The end-to-end empty answer's 502 on this wire (not settled). */
export const EMPTY_MAX_TOKENS_MESSAGE = "Upstream produced no content within max_tokens (thinking consumed it, after any effort or budget fit and lowest-depth retry by the gateway) - raise max_tokens, lower effort or thinking.budget_tokens, or disable thinking";

export function makeMessagesHandler(routeTier) {
  return async function messagesHandler(input, req) {
    // Settle-failure breaker first: refuse (nobody charged) before any upstream call.
    await gatewaySettleBreakerCheck(req);
    // Price by model (chat-wire parity): `tierSlug` is the route's tier unless
    // the body names another flat tier's model and the request was gated at
    // that tier's price; then that tier's whole config serves it.
    const tierSlug = servedTierFor(routeTier, input?.model, req);
    const tier = TIERS[tierSlug];
    const { body, probe, imageCount, isRouted, routedCategory, routedQuality, chain, defaultedModel, substituted } = validateMessagesRequest(input, tierSlug);
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
    // Priced at this prompt's size: a long-context tier bounds a long prompt.
    const meteredBound = tier.metered ? meteredBoundFor(probe, tier, imageCount) : null;
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
      // A routed chain (auto tier) walks models with different effort tables;
      // a link that does not take the buyer's effort gets the call without
      // it rather than a silently ignored field (explicit-model requests were
      // validated against their own model above and never reach this branch).
      const linkProfile = body.effort !== undefined ? reasoningProfile(model) : null;
      const maxOut = Math.min(body.max_tokens, p.max_tokens);
      // A buyer who set no depth (no effort, no thinking) on a tier that
      // leaves the model's own default (premium) gets effort "low" when the
      // budget is below the room the tier gives a reasoning model: thinking
      // tokens count against max_tokens, and a small budget spent thinking at
      // the model default comes back cut off (smallBudgetEffort).
      const buyerEffort = body.effort !== undefined && linkProfile && linkProfile.efforts.includes(body.effort) ? body.effort : undefined;
      // A buyer effort that leaves no room for an answer inside this link's
      // cap is lowered by the same small-budget rule and disclosed
      // (fitEffortToBudget).
      const effortForLink = body.effort !== undefined
        ? fitEffortToBudget(model, tierSlug, buyerEffort, maxOut)
        : (body.thinking === undefined ? (smallBudgetEffort(model, tierSlug, maxOut) ?? undefined) : undefined);
      let note = buyerEffort !== undefined && effortForLink !== buyerEffort ? reasoningAdjustedNote("effort", buyerEffort, effortForLink, "max_tokens") : null;
      // A thinking budget follows the clamped cap (thinking tokens are output
      // tokens); under Anthropic's 1024 floor the link is refused instead.
      // It is then lowered, never under that floor, so a quarter of the cap
      // is left for the answer (fitBudgetForAnswer).
      let thinking = body.thinking;
      if (body.thinking?.type === "enabled") {
        const underCap = fitBudgetBelowCap(body.thinking.budget_tokens, maxOut, { floor: 1024, field: "thinking.budget_tokens" });
        const budget = reasoningOutsideMaxTokens(model) ? underCap : fitBudgetForAnswer(underCap, maxOut, { floor: 1024 });
        if (budget !== underCap && !note) note = reasoningAdjustedNote("thinking.budget_tokens", body.thinking.budget_tokens, budget, "max_tokens");
        thinking = { ...body.thinking, budget_tokens: budget };
      }
      return {
        ...body, model, max_tokens: maxOut, zdr: undefined, effort: effortForLink,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(provider ? { provider } : {}), ...(user ? { user, session_id: user } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
        service_tier: serviceTierFor(model, body, flex), // flex / priority / explicit default on :nitro
        ...(note ? { [REASONING_ADJUSTED]: note } : {}),
        [LINK_PROBE]: p,
      };
    };
    // The one recovery try after an empty max_tokens answer: the same model
    // with its depth setting at the lowest the wire offers. An effort goes to
    // the model's lowest; a thinking budget on a model that may run without
    // thinking is switched off. Null when nothing lower can be sent.
    const lowestDepthRetry = (outbound, model) => {
      const lowest = lowestEffortFor(model, { floor: "minimal" });
      const prof = reasoningProfile(model);
      const sent = outbound.effort;
      if (sent !== undefined) {
        if (!lowest || REASONING_EFFORTS.indexOf(sent) <= REASONING_EFFORTS.indexOf(lowest)) return null;
        return { patch: { effort: lowest }, note: reasoningAdjustedNote("effort", body.effort !== undefined ? body.effort : "default", lowest, "empty_answer_retry") };
      }
      if (outbound.thinking?.type === "enabled" && (!prof || prof.efforts.includes("none"))) {
        return { patch: { thinking: { type: "disabled" } }, note: reasoningAdjustedNote("thinking.budget_tokens", body.thinking.budget_tokens, "disabled", "empty_answer_retry") };
      }
      if (lowest && outbound.thinking?.type !== "disabled") {
        return { patch: { effort: lowest }, note: reasoningAdjustedNote("effort", "default", lowest, "empty_answer_retry") };
      }
      return null;
    };
    const recordUsage = (usage, upstreamUsd, served, serviceTier) => import("../posthog.js")
      .then(({ capturePostHogGatewayUsage }) => capturePostHogGatewayUsage({
        tier: `${tierSlug}:messages`, routeTier: `${routeTier}:messages`, model: served, priceUsd: quotedUsd ?? tier.price, upstreamUsd,
        promptTokens: usage?.input_tokens, completionTokens: usage?.output_tokens, serviceTier, defaulted: !!defaultedModel,
      })).catch(() => {});
    const attempts = attemptsFor(chain, body);
    const routerNote = isRouted ? { category: routedCategory, quality: routedQuality } : null;

    if (body.stream === true) {
      return {
        __sse: async (res) => {
          let lastErr;
          const timeouts = timedOutBudget();
          const client = streamClientWatch(res);
          try {
            for (const { model, flex } of attempts) {
              client.assertPresent();
              let outbound;
              try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
              const timeoutMs = paymentWindowTimeoutMs(req, STREAM_TIMEOUT_MS);
              const attemptStarted = Date.now();
              // No envelope on a stream: the disclosure rides in a header.
              setReasoningAdjustedHeader(res, outbound[REASONING_ADJUSTED]);
              try {
                return await retryRateLimited(() => streamOpenRouterTo(outbound, res, {
                  url: OPENROUTER_MESSAGES_URL, timeoutMs,
                  onUsage: (usage, cost, frame) => recordUsage(usage, cost, frame?.message?.model || model, frame?.usage?.service_tier || (flex ? "flex" : "default")),
                }), { delays: rateLimitDelaysFor(flex), canRetry: () => !res.headersSent && !client.gone() });
              } catch (e) {
                if (res.headersSent || ![502, 503, 504].includes(e?.statusCode)) throw e;
                lastErr = e;
                timeouts.note(e, attemptStarted, timeoutMs);
                if (timeouts.spent()) throw e;
              }
            }
            client.assertPresent();
            throw lastErr || bad("No upstream model could serve this request", 502);
          } finally { client.done(); setReasoningAdjustedHeader(res, null); }
        },
      };
    }

    let lastErr;
    let refusedModel = null;
    const timeouts = timedOutBudget();
    const recovery = { used: false }; // one lowest-depth recovery try per call
    for (const { model, flex } of attempts) {
      if (model === refusedModel) continue;
      let outbound;
      try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
      const timeoutMs = paymentWindowTimeoutMs(req, UPSTREAM_TIMEOUT_MS);
      const attemptStarted = Date.now();
      try {
        const callOnce = (sendBody, ms) => retryRateLimited(async () => {
          const res = await fetchOpenRouter(sendBody, { url: OPENROUTER_MESSAGES_URL, timeoutMs: ms });
          if (!res.ok) await upstreamHttpError(res, sendBody?.model);
          const text = await res.text();
          let parsed;
          try { parsed = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
          assertUpstreamBody(parsed, { model: sendBody?.model });
          if (!Array.isArray(parsed?.content)) throw bad("Upstream returned no answer (no content) - not charged", 502);
          return parsed;
        }, { delays: rateLimitDelaysFor(flex) });
        let data = await callOnce(outbound, timeoutMs);
        let reasoningAdjusted = outbound[REASONING_ADJUSTED] || null;
        // An answer that spent its whole cap thinking gets one more run of
        // the same model at its lowest depth before the chain walks on: once
        // per call, while the price covers another run and time is left.
        if (isEmptyMaxTokens(data)) {
          const plan = lowestDepthRetry(outbound, model);
          const again = await retryEmptyAtLowestEffort({
            once: recovery, plan, req, timeouts,
            affordable: () => recoveryRunAffordable(outbound[LINK_PROBE], tier, imageCount, data?.usage?.cost, req?.__meteredQuoteUsd),
            run: (p, ms) => callOnce({ ...outbound, ...p.patch }, ms),
            usable: (d) => !isEmptyMaxTokens(d) && !(d?.stop_reason === "refusal" && isEmptyMaxTokens({ ...d, stop_reason: "max_tokens" })),
          });
          if (again) { data = again; reasoningAdjusted = plan.note; }
        }
        if (data?.stop_reason === "refusal" && isEmptyMaxTokens({ ...data, stop_reason: "max_tokens" })) {
          lastErr = bad("Upstream declined the request (safety filter) - rephrase the prompt, or pick a different model", 502);
          refusedModel = model;
          continue;
        }
        if (isEmptyMaxTokens(data)) {
          lastErr = bad(EMPTY_MAX_TOKENS_MESSAGE, 502);
          refusedModel = model;
          continue;
        }
        const upstreamUsd = stripBilling(data.usage);
        await recordUsage(data.usage, upstreamUsd, data.model || model, data.usage?.service_tier || (flex ? "flex" : "default"));
        if (routerNote) data.agent402_router = { ...routerNote, served: data.model || model };
        if (defaultedModel) data.agent402_default_model = defaultedModel; // the caller sent no model; say what served
        if (reasoningAdjusted) data.agent402_reasoning_adjusted = reasoningAdjusted; // a depth setting was lowered to leave room for the answer
        if (substituted) data.agent402_model_substituted = { requested: substituted, served: body.model, reason: "the requested model is retired upstream; its named successor served instead" };
        else { const sub = availabilitySubstitution(body.model, model); if (sub) data.agent402_model_substituted = sub; }
        if (tierSlug !== routeTier) data.agent402_tier = { ...crossTierDisclosure(routeTier, tierSlug), route: MESSAGES_PATH_BY_TIER[routeTier] };
        // Metered settlement sentinel (chat-wire parity): the route binder
        // settles actual x markup for upto/credits buyers and strips this
        // before the body leaves. A non-number means "no meter", never "free".
        if (typeof upstreamUsd === "number") setMeterSentinel(data, upstreamUsd);
        return data;
      } catch (e) {
        if (![502, 503, 504].includes(e?.statusCode)) throw e;
        lastErr = e;
        timeouts.note(e, attemptStarted, timeoutMs);
        if (timeouts.spent()) throw e;
      }
    }
    throw lastErr || bad("No upstream model could serve this request", 502);
  };
}

const EXAMPLE_IN = { model: "anthropic/claude-sonnet-5", max_tokens: 256, messages: [{ role: "user", content: "Summarize x402 in one sentence." }] };
// The premium example's budget: its model reasons before it speaks, and 256
// tokens could be spent thinking before the one sentence was said.
const EXAMPLE_MAX_TOKENS_BY_TIER = { "v1-chat-premium": 1024 };
const EXAMPLE_OUT = { id: "msg_…", type: "message", role: "assistant", model: "anthropic/claude-sonnet-5", content: [{ type: "text", text: "x402 is an HTTP-native way for agents to pay per request with USDC." }], stop_reason: "end_turn", usage: { input_tokens: 14, output_tokens: 18 } };
const TAGS = ["llm", "ai", "inference", "anthropic-compatible", "messages-api", "claude", "gateway"];
const INPUT_SCHEMA = {
  properties: {
    model: { type: "string", description: "Model id (OpenRouter naming, e.g. anthropic/claude-sonnet-5) - allowlisted per tier; omit (or \"auto\") on the auto tier" },
    max_tokens: { type: "integer", description: "Required by the Messages API; clamped to the tier's output cap" },
    messages: { type: "array", description: "Anthropic messages: {role: user|assistant, content: string | [text|image|tool_use|tool_result blocks]}" },
    system: { type: "string", description: "Optional system prompt (string or text blocks)" },
    tools: { type: "array", description: "Optional client tools {name, description, input_schema}; server/built-in tools are not served" },
    thinking: { type: "object", description: 'Optional {type:"enabled", budget_tokens} | {type:"adaptive"} | {type:"disabled"} - thinking tokens are output tokens; a budget is clamped along with max_tokens to fit the tier output cap. On Claude 4.7+ (Opus 5, Sonnet 5, Fable 5.1) thinking is adaptive and `effort` is the depth control; a budget_tokens value is advisory there. Claude Haiku 5.5 refuses {type:"enabled", budget_tokens} with a 400 (send effort instead). A budget above three quarters of max_tokens is lowered to leave a quarter for the answer (not under 1024), and an answer that still comes back empty is retried once with thinking off where the model runs without it, when the call\'s price and time allow; either change is named in agent402_reasoning_adjusted' },
    effort: { type: "string", description: 'Optional depth control for Claude 4.7+ (Opus 5, Sonnet 5, Fable 5.1) and Claude Haiku 5.5: low | medium | high | xhigh | max, validated against the model\'s own list (GET /v1/models). Not accepted on Haiku 4.5 and older, which take thinking.budget_tokens instead. An effort above low that leaves no room for an answer inside a small max_tokens is sent as low, and an answer that still comes back empty is retried once at the model\'s lowest effort when the call\'s price and time allow; either change is named in agent402_reasoning_adjusted {field, requested, used, reason} (the X-Agent402-Reasoning-Adjusted header on a stream)' },
    stream: { type: "boolean", description: "Anthropic SSE (message_start … message_stop)" },
    zdr: { type: "boolean", description: "Optional - zero-data-retention providers only" },
  },
  required: ["max_tokens", "messages"],
};

function describe(tierSlug) {
  const t = TIERS[tierSlug];
  const compat = defaultModelCompatNote(t);
  const dflt = t.defaultModel ? ` Omit "model" and the tier serves ${t.defaultModel} (named back in agent402_default_model); the price does not change.${compat ? ` ${compat}` : ""}` : "";
  const price = priceString(tierSlug);
  if (tierSlug === "v1-chat-metered") {
    return `Anthropic Messages API priced per request from the request itself. The 402 quotes the input (system, messages and tools), estimated from its tokens with headroom, plus your max_tokens, from ${price} up to a $${t.maxQuoteUsd} per-call cap. Point the Anthropic SDK (or any Messages-format client) at base_url https://agent402.tools/v1/metered. Any model from the flat tiers (GET /v1/models). Pay the quote over x402 exact, or authorize it as a ceiling over upto or credits and settle actual usage; a card payment is charged the quote plus the processor fee. Up to ${t.maxInputChars.toLocaleString("en-US")} input chars and ${t.maxTokens} output tokens; streaming supported.${compat ? ` ${compat}` : ""}`;
  }
  const base = `Anthropic Messages API over x402 - point the Anthropic SDK (or Claude Code / the Agent SDK) at base_url https://agent402.tools${MESSAGES_PATH_BY_TIER[tierSlug].replace(/\/messages$/, "")} and pay ${price} per call in USDC, no API key, no signup. Same models, caps and price as this tier's /chat/completions route; any model here is served through the Messages wire (Claude natively, others translated). Depth: \`effort\` (low..max) on Claude 4.7+ and Haiku 5.5, thinking.budget_tokens on older Claude. Up to ${t.maxInputChars.toLocaleString("en-US")} input chars and ${t.maxTokens} output tokens; streaming supported.`;
  return tierSlug === "v1-chat-auto"
    ? `${base} Omit "model" and the gateway routes the prompt to the top-ranked model for its task type; the response adds agent402_router {category, quality, served}.`
    : base + dflt;
}

// Example model per tier: a LIVE id (the "answers its own example" CI check
// calls upstream with it; a bare allowlist prefix would 400 there) - Claude
// where the tier serves Claude, the tier's cheapest chat example otherwise.
const EXAMPLE_MODEL_BY_TIER = {
  "v1-chat-metered": "anthropic/claude-haiku-4.5",
  "v1-chat-nano": "google/gemini-3.1-flash-lite",
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
  // Price by model on a flat route (see LLM_GATEWAY_TOOLS in the gateway kit).
  ...(isFlatTier(tierSlug) ? { tierQuote: (body) => flatTierQuoteUsd(tierSlug, body?.model) } : {}),
  description: describe(tierSlug),
  tags: tierSlug === "v1-chat-metered" ? [...TAGS, "metered", "pay-per-token"] : TAGS,
  discovery: {
    bodyType: "json",
    input: tierSlug === "v1-chat-auto" ? { max_tokens: 256, messages: EXAMPLE_IN.messages } : { ...EXAMPLE_IN, model: EXAMPLE_MODEL_BY_TIER[tierSlug], max_tokens: EXAMPLE_MAX_TOKENS_BY_TIER[tierSlug] ?? EXAMPLE_IN.max_tokens },
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
