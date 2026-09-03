// /v1/.../responses - the OpenAI Responses API wire on the same five tiers as
// chat completions and the Anthropic Messages wire (build #12 of the
// 2026-08-18 rail deep-dive). The OpenAI Agents SDK, the Responses-first
// OpenAI SDKs and Codex-style runtimes pay per call by pointing base_url at
// https://agent402.tools/v1 (or /v1/nano, /v1/pro, /v1/premium) - no key.
//
// Same tier = same price, allowlist, caps, provider max_price, flex-first
// attempts, failover chain and margin clamp (TIERS in llm-gateway-kit.js).
// Only the wire differs: `input` (string or item list), `instructions`,
// `max_output_tokens`, function tools, `text.format`, `reasoning` in; a
// Response object (`output[]`, `status`, `usage.input_tokens/output_tokens`)
// out; SSE events response.created ... response.completed. OpenRouter's
// /api/v1/responses serves any model through it (live-verified 2026-08-19
// with gemini-2.5-flash-lite).
//
// Billing: usage.cost / is_byok / cost_details ride in the non-stream body
// and NESTED at response.usage inside the stream's response.completed frame
// (live-verified) - stripped here and by createSseUsageScrubber, which
// scrubs nested usage sites since this wire was scoped.
//
// Server-state knobs are refused or forced: `previous_response_id` (we hold
// no conversation state - a 400 says so), `store` forced false, `background`
// refused. Server-side tools (web_search*, file_search, computer, mcp,
// code_interpreter, image_generation) are refused: their spend is bounded by
// neither max_output_tokens nor provider.max_price. Function tools only.
import {
  TIERS, AUTO_RANKINGS, classifyPrompt, canonicalModel, tierAllows, tierFor, meteredQuoteForProbe, costFor,
  clampToMargin, flexAttempts, cacheControlPref, upstreamUserId, PROVIDER_SORT_ENABLED,
  fetchOpenRouter, throwUpstreamError, streamOpenRouterTo, bad, MAX_IMAGES,
  defaultReasoningFor, validateReasoning,
  refuseCostVariants,
  assertUpstreamBody,
} from "./llm-gateway-kit.js";

import { METER_MARKUP, METER_MIN_SETTLE_USD, setMeterSentinel } from "../gateway-meter.js";
const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
const MAX_TOOLS = 64;
const MAX_INPUT_ITEMS = 200;

export const RESPONSES_PATH_BY_TIER = {
  "v1-chat-nano": "/v1/nano/responses",
  "v1-chat-auto": "/v1/auto/responses",
  "v1-chat": "/v1/responses",
  "v1-chat-pro": "/v1/pro/responses",
  "v1-chat-premium": "/v1/premium/responses",
  // LAST (the TIERS ordering rule): the metered tier's prefixes are the
  // union of the flat tiers', so tierFor() must keep resolving explicit
  // models to their home tiers first.
  "v1-chat-metered": "/v1/metered/responses",
};
/** Per-request price of the metered Responses route, from the RAW body.
 *  Never throws: an invalid body quotes the floor (the handler's own 400
 *  refuses it, uncharged); an over-cap body quotes the cap (the handler
 *  refuses that too). Same arithmetic as the chat and Messages wires. */
export function meteredResponsesQuoteUsd(input) {
  const tier = TIERS["v1-chat-metered"];
  try {
    const { probe, imageCount } = validateResponsesRequest(input, "v1-chat-metered");
    return meteredQuoteForProbe(probe, imageCount);
  } catch (e) {
    return { usd: tier.price, invalid: true, reason: String(e?.message || e).slice(0, 160) };
  }
}
export const RESPONSES_TIER_BY_PATH = Object.fromEntries(Object.entries(RESPONSES_PATH_BY_TIER).map(([t, p]) => [p, t]));

const ROLES = new Set(["user", "assistant", "system", "developer"]);
const SERVER_TOOL_RE = /^(web_search|file_search|computer|mcp|code_interpreter|image_generation|local_shell|shell|apply_patch)/;

/** Validate + probe a content part list (input_text / input_image / output_text). */
function probeParts(parts, where, acc) {
  if (typeof parts === "string") { acc.chars += parts.length; return parts; }
  if (!Array.isArray(parts)) throw bad(`${where}.content must be a string or an array of parts`);
  return parts.map((p, i) => {
    if (!p || typeof p !== "object" || typeof p.type !== "string") throw bad(`${where}.content[${i}] must be a part with a type`);
    switch (p.type) {
      case "input_text":
      case "output_text":
      case "text":
        if (typeof p.text !== "string") throw bad(`${where}.content[${i}].text must be a string`);
        acc.chars += p.text.length;
        return p;
      case "input_image": {
        const url = typeof p.image_url === "string" ? p.image_url : (typeof p.image_url?.url === "string" ? p.image_url.url : "");
        if (!url) throw bad(`${where}.content[${i}].image_url is required (http(s) URL or data: URI)`);
        if (url.startsWith("data:") ? url.length > 1_500_000 : (!/^https?:\/\//.test(url) || url.length > 2048)) throw bad(`${where}.content[${i}].image_url must be an http(s) URL or a data: URI under ~1MB`);
        acc.images++;
        return { type: "input_image" };
      }
      case "input_file":
        throw bad(`${where}.content[${i}]: input_file is not served (file parsing is metered upstream) - extract the text first, e.g. POST /api/pdf-text`);
      default:
        throw bad(`${where}.content[${i}]: unsupported part type "${p.type}" (allowed: input_text, input_image, output_text)`);
    }
  });
}

/** Validate an OpenAI Responses request for a tier. Returns
 *  { body, probe, imageCount, isRouted, routedCategory, routedQuality, chain }. */
export function validateResponsesRequest(input, tierSlug) {
  const tier = TIERS[tierSlug];
  if (!tier) throw bad(`unknown tier ${tierSlug}`, 500);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Body must be a JSON object (OpenAI Responses request)");
  if (input.previous_response_id !== undefined) throw bad('"previous_response_id" is not supported - this gateway stores no conversation state (store is always false); send the full input each call');
  if (input.background === true) throw bad('"background" responses are not served (no server-side state)');
  const isRouted = tier.router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto");
  let model = canonicalModel(input.model);
  let defaultedModel = null;
  if (!isRouted) {
    refuseCostVariants(model);
    if (!model && tier.defaultModel) { model = tier.defaultModel; defaultedModel = model; } // see llm-messages-kit: serve the tier default, never refuse a missing model
    if (!model) throw bad(`"model" is required (e.g. openai/gpt-4o-mini). This tier serves: ${tier.prefixes?.slice(0, 6).join(", ") || "see /v1/models"}`);
    if (!tierAllows(tierSlug, model)) {
      const home = tierFor(model);
      // RESPONSES_PATH_BY_TIER is an explicit map: a chat tier with no
      // Responses twin would render as "served on undefined". Fall back to
      // that tier's real chat route.
      const homePath = home ? (RESPONSES_PATH_BY_TIER[home] || TIERS[home].route.split(" ")[1]) : null;
      throw bad(home && home !== tierSlug ? `"${model}" is served on ${homePath} (${home})` : `"model" ${model} is not served on this tier - GET /v1/models lists every model and its tier`);
    }
  }
  const acc = { chars: 0, images: 0 };
  let probeInput;
  if (typeof input.input === "string") { acc.chars += input.input.length; probeInput = input.input; }
  else if (Array.isArray(input.input)) {
    if (input.input.length === 0 || input.input.length > MAX_INPUT_ITEMS) throw bad(`"input" must have 1-${MAX_INPUT_ITEMS} items`);
    probeInput = input.input.map((it, i) => {
      if (!it || typeof it !== "object") throw bad(`input[${i}] must be an object`);
      const type = it.type || (it.role ? "message" : null);
      switch (type) {
        case "message":
          if (!ROLES.has(it.role)) throw bad(`input[${i}].role must be user, assistant, system or developer`);
          return { role: it.role, content: probeParts(it.content, `input[${i}]`, acc) };
        case "function_call":
          if (typeof it.name !== "string" || typeof it.call_id !== "string") throw bad(`input[${i}] function_call needs name + call_id`);
          acc.chars += it.name.length + String(it.arguments ?? "").length;
          return it;
        case "function_call_output":
          if (typeof it.call_id !== "string") throw bad(`input[${i}] function_call_output needs call_id`);
          // `output` may be a string or an array of content parts. The array
          // form is probed like message content - an input_file or remote
          // image hidden in a tool result is the same metered input as one in
          // a message (security review 2026-08-19: it was counted as chars only).
          if (typeof it.output === "string") acc.chars += it.output.length;
          else if (Array.isArray(it.output)) probeParts(it.output, `input[${i}].output`, acc);
          else throw bad(`input[${i}] function_call_output.output must be a string or an array of content parts`);
          return it;
        case "reasoning":
          acc.chars += JSON.stringify(it.summary ?? "").length;
          return it;
        default:
          throw bad(`input[${i}]: unsupported item type "${type}" (allowed: message, function_call, function_call_output, reasoning)`);
      }
    });
  } else throw bad('"input" is required: a string or an array of input items');
  let instructions;
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== "string") throw bad('"instructions" must be a string');
    acc.chars += input.instructions.length; instructions = input.instructions;
  }
  if (acc.chars > tier.maxInputChars) throw bad(`Input too large (${acc.chars} chars). The ${tierSlug} tier allows up to ${tier.maxInputChars} chars`);
  if (acc.images > MAX_IMAGES) throw bad(`Too many images (${acc.images}). Maximum is ${MAX_IMAGES} per request`);
  // The tier's own default budget, like the chat wire: a premium model that
  // reasons before it speaks spent a hardcoded 1024 entirely on reasoning and
  // our own documented example answered 502 "reasoning consumed it"
  // (2026-09-02 audit); the chat wire has given such tiers 4,096 since 08-19.
  const tierDefaultMax = Math.min(tier.defaultMaxTokens || 1024, tier.maxTokens);
  let maxOut = input.max_output_tokens != null ? parseInt(input.max_output_tokens, 10) : tierDefaultMax;
  if (!Number.isFinite(maxOut) || maxOut < 1) maxOut = tierDefaultMax;
  if (maxOut > tier.maxTokens) maxOut = tier.maxTokens;

  const body = { model: isRouted ? undefined : model, input: input.input, max_output_tokens: maxOut, store: false };
  if (instructions !== undefined) body.instructions = instructions;
  for (const k of ["temperature", "top_p", "metadata", "tool_choice", "parallel_tool_calls", "truncation", "text"]) if (input[k] !== undefined) body[k] = input[k];
  // tool_choice mirrors the tools guard (function tools only): Responses wire
  // is "none"|"auto"|"required" or {type:"function", name} - a hosted-tool
  // choice ({type:"web_search_preview"} etc.) is refused like the tool itself.
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    const okString = tc === "none" || tc === "auto" || tc === "required";
    const okObject = tc && typeof tc === "object" && tc.type === "function" && typeof tc.name === "string";
    if (!okString && !okObject) throw bad('"tool_choice" must be "none", "auto", "required", or {type:"function", name}');
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length === 0 || input.tools.length > MAX_TOOLS) throw bad(`"tools" must be a non-empty array of up to ${MAX_TOOLS} function tools`);
    for (const [i, t] of input.tools.entries()) {
      if (!t || typeof t !== "object" || typeof t.type !== "string") throw bad(`tools[${i}] must be {type:"function", name, parameters}`);
      if (SERVER_TOOL_RE.test(t.type) || t.type !== "function") throw bad(`tools[${i}]: "${t.type}" is a server-side tool (spend bounded by neither max_output_tokens nor the price cap) - only type:"function" tools are served`);
      if (typeof t.name !== "string") throw bad(`tools[${i}].name is required`);
    }
    body.tools = input.tools;
  }
  const reasoning = validateReasoning(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}, tier);
  if (reasoning !== undefined) body.reasoning = reasoning;
  if (input.stream === true) body.stream = true;
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  cacheControlPref(input);
  const probe = { model: body.model, max_tokens: maxOut, input: probeInput, ...(instructions !== undefined ? { instructions } : {}), ...(body.tools ? { tools: body.tools } : {}), ...(body.text ? { text: body.text } : {}) };
  const probeMessages = [];
  if (instructions) probeMessages.push({ role: "user", content: instructions });
  if (typeof probeInput === "string") probeMessages.push({ role: "user", content: probeInput });
  else for (const it of probeInput) if (it?.role && it.content !== undefined) probeMessages.push({ role: "user", content: typeof it.content === "string" ? it.content : it.content.map((p) => (p?.text ? { type: "text", text: p.text } : p)) });
  const routedCategory = isRouted ? classifyPrompt(probeMessages) : null;
  const routedQuality = isRouted ? (input.quality === undefined ? "balanced" : String(input.quality)) : null;
  if (isRouted && !AUTO_RANKINGS[routedQuality]) throw bad('"quality" must be "fast", "balanced", or "best"');
  const chain = isRouted ? [...AUTO_RANKINGS[routedQuality][routedCategory]] : [model, ...(tier.fallbacks || []).filter((m) => m !== model)];
  return { body, probe, imageCount: acc.images, isRouted, routedCategory, routedQuality, chain, defaultedModel };
}

/** status incomplete for max_output_tokens with no text/function output =
 *  the cap was spent reasoning; a paid empty answer, walk the chain. */
export function isEmptyIncomplete(data) {
  if (!data || data.status !== "incomplete" || data.incomplete_details?.reason !== "max_output_tokens") return false;
  const out = Array.isArray(data.output) ? data.output : [];
  const said = out.some((o) => o?.type === "function_call" || (o?.type === "message" && Array.isArray(o.content) && o.content.some((c) => c?.type === "output_text" && typeof c.text === "string" && c.text.trim() !== "")));
  return !said;
}

function stripBilling(usage) {
  if (!usage || typeof usage !== "object") return null;
  const upstreamUsd = typeof usage.cost === "number" ? usage.cost : null;
  delete usage.cost; delete usage.cost_details; delete usage.is_byok; delete usage.cache_discount;
  return upstreamUsd;
}

export function makeResponsesHandler(tierSlug) {
  return async function responsesHandler(input, req) {
    const tier = TIERS[tierSlug];
    const { body, probe, imageCount, isRouted, routedCategory, routedQuality, chain, defaultedModel } = validateResponsesRequest(input, tierSlug);
    const structured = body.text?.format?.type === "json_schema" || body.text?.format?.type === "json_object";
    // Metered belt (chat + Messages wire parity): an over-cap body is refused
    // before any upstream call (the 402 quoted the cap, not the cost), and
    // the price this request was gated at must cover the body being served.
    if (tier.metered) {
      const q = meteredQuoteForProbe(probe, imageCount);
      if (q.overCap) throw bad(`This request would cost $${q.rawUsd.toFixed(4)} metered, above the $${tier.maxQuoteUsd} per-call cap of ${RESPONSES_PATH_BY_TIER[tierSlug]} - lower max_output_tokens or the input, or use a flat tier (GET /v1/models lists them)`, 400);
    }
    if (tier.metered && Number.isFinite(req?.__meteredQuoteUsd)) {
      const q = meteredResponsesQuoteUsd(input);
      if (q.invalid || q.overCap || q.usd > req.__meteredQuoteUsd * (1 + 1e-6) + 1e-9) {
        throw bad(`This request was quoted at $${req.__meteredQuoteUsd} but the body being served quotes $${q.usd}${q.invalid ? ` (${q.reason})` : ""}. Nothing was charged; resend the request exactly as it should be served.`, 400);
      }
    }
    // Metered: the quote priced THIS model at its MODEL_COST row, so the
    // upstream bound is that row, never the tier-wide cap.
    const meteredBound = tier.metered ? costFor(body.model) : null;
    const quotedUsd = tier.metered && Number.isFinite(req?.__meteredQuoteUsd) && req.__meteredQuoteUsd > 0 ? req.__meteredQuoteUsd : null;
    const providerPrefs = {
      ...(meteredBound ? { max_price: { prompt: meteredBound.prompt, completion: meteredBound.completion } }
        : tier.maxPrice ? { max_price: tier.maxPrice } : {}),
      ...(body.zdr === true ? { zdr: true } : {}),
      ...(tier.priceSort === true && PROVIDER_SORT_ENABLED() ? { sort: "price" } : {}),
      ...(structured ? { require_parameters: true } : {}),
    };
    const provider = Object.keys(providerPrefs).length ? providerPrefs : undefined;
    const user = upstreamUserId(req);
    const cacheControl = cacheControlPref(input);
    const outboundFor = (model, flex = false) => {
      const p = { ...probe, model };
      clampToMargin(p, tier, imageCount); // max_tokens in the probe IS max_output_tokens
      const reasoning = body.reasoning !== undefined ? body.reasoning : defaultReasoningFor(model, tierSlug);
      return {
        ...body, model, max_output_tokens: Math.min(body.max_output_tokens, p.max_tokens), zdr: undefined,
        ...(reasoning ? { reasoning } : {}),
        ...(provider ? { provider } : {}), ...(user ? { user, session_id: user } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
        ...(flex ? { service_tier: "flex" } : {}),
      };
    };
    const recordUsage = (usage, upstreamUsd, served, serviceTier) => import("../posthog.js")
      .then(({ capturePostHogGatewayUsage }) => capturePostHogGatewayUsage({
        tier: `${tierSlug}:responses`, model: served, priceUsd: quotedUsd ?? tier.price, upstreamUsd,
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
                url: OPENROUTER_RESPONSES_URL,
                onUsage: (usage, cost, frame) => recordUsage(usage, cost, frame?.response?.model || model, frame?.response?.service_tier || (flex ? "flex" : "default")),
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
        const res = await fetchOpenRouter(outbound, { url: OPENROUTER_RESPONSES_URL });
        if (!res.ok) await throwUpstreamError(res);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
        assertUpstreamBody(data);
        if (data?.status === "failed" || data?.error) {
          lastErr = bad(`Upstream error: ${String(data?.error?.message || data?.error?.code || "response failed").slice(0, 200)}`, 502);
          continue;
        }
        if (isEmptyIncomplete(data)) {
          lastErr = bad("Upstream produced no output within max_output_tokens (reasoning consumed it) - raise max_output_tokens, lower reasoning.effort, or pick a non-reasoning model", 502);
          refusedModel = model;
          continue;
        }
        const upstreamUsd = stripBilling(data.usage);
        await recordUsage(data.usage, upstreamUsd, data.model || model, data.service_tier || (flex ? "flex" : "default"));
        if (routerNote) data.agent402_router = { ...routerNote, served: data.model || model };
        if (defaultedModel) data.agent402_default_model = defaultedModel;
        // Metered settlement sentinel (chat-wire parity): the route binder
        // settles actual x markup for upto/credits buyers and strips this
        // before the body leaves. Non-enumerable; a non-number means "no meter".
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

const EXAMPLE_MODEL_BY_TIER = {
  "v1-chat-nano": "openai/gpt-5.6-luna",
  "v1-chat": "openai/gpt-4o-mini",
  "v1-chat-pro": "openai/gpt-4o",
  "v1-chat-premium": "anthropic/claude-opus-5",
  "v1-chat-metered": "anthropic/claude-haiku-4.5",
};
const TIER_LABEL = { "v1-chat-nano": "nano", "v1-chat-auto": "auto", "v1-chat": "base", "v1-chat-pro": "pro", "v1-chat-premium": "premium", "v1-chat-metered": "metered" };
const priceString = (tierSlug) => (tierSlug === "v1-chat-nano" ? "$0.003" : tierSlug === "v1-chat-metered" ? `$${METER_MIN_SETTLE_USD}` : `$${TIERS[tierSlug].price.toFixed(2)}`);
const EXAMPLE_OUT = { id: "resp_…", object: "response", status: "completed", model: "openai/gpt-4o-mini", output: [{ id: "msg_…", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "x402 is an HTTP-native way for agents to pay per request with USDC.", annotations: [] }] }], usage: { input_tokens: 14, output_tokens: 18, total_tokens: 32 } };
const INPUT_SCHEMA = {
  properties: {
    model: { type: "string", description: "Model id (OpenRouter naming) - allowlisted per tier; omit (or \"auto\") on the auto tier" },
    input: { description: "A string, or an array of input items ({role, content} messages with input_text / input_image parts, function_call, function_call_output)" },
    instructions: { type: "string", description: "Optional system/developer instructions" },
    max_output_tokens: { type: "integer", description: "Optional output cap (clamped to the tier cap)" },
    tools: { type: "array", description: "Optional function tools ({type:\"function\", name, parameters}); server-side tools are not served" },
    text: { type: "object", description: 'Optional {format: {type: "text"|"json_schema"|"json_object", ...}}' },
    reasoning: { type: "object", description: 'Optional {effort: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"} - reasoning tokens count against max_output_tokens' },
    stream: { type: "boolean", description: "Responses SSE events (response.created … response.completed)" },
    zdr: { type: "boolean", description: "Optional - zero-data-retention providers only" },
  },
  required: ["input"],
};
function describe(tierSlug) {
  const t = TIERS[tierSlug];
  if (tierSlug === "v1-chat-metered") {
    return `OpenAI Responses API billed per request from what the call costs: the 402 quotes exact-BPE input (instructions + input items + tools) plus your max_output_tokens at the model's list price, times ${METER_MARKUP}, never under $${METER_MIN_SETTLE_USD}; an upto (Permit2) or credits buyer settles actual usage under that quote. Point the OpenAI SDK's responses.create(), the OpenAI Agents SDK, or OpenAI Codex CLI's model_providers base_url at https://agent402.tools/v1/metered. Any model the flat tiers serve (GET /v1/models); function tools only; store is always false.`;
  }
  const base = `OpenAI Responses API over x402 - point the OpenAI SDK's responses.create() (or the OpenAI Agents SDK) at base_url https://agent402.tools${RESPONSES_PATH_BY_TIER[tierSlug].replace(/\/responses$/, "")} and pay ${priceString(tierSlug)} per call in USDC, no API key, no signup. Same models, caps and price as this tier's /chat/completions route; any model here is served through the Responses wire. Up to ${t.maxInputChars.toLocaleString("en-US")} input chars and ${t.maxTokens} output tokens; streaming supported; function tools yes, server-side tools (web_search, file_search, computer, mcp) no; no stored conversation state (send the full input each call).`;
  const dflt = t.defaultModel ? ` Omit "model" and the tier serves ${t.defaultModel} (named back in agent402_default_model); the price does not change.` : "";
  return tierSlug === "v1-chat-auto" ? `${base} Omit "model" and the gateway routes the prompt to the top-ranked model for its task type; the response adds agent402_router {category, quality, served}.` : base + dflt;
}

export const LLM_RESPONSES_TOOLS = Object.entries(RESPONSES_PATH_BY_TIER).map(([tierSlug, path]) => ({
  route: `POST ${path}`,
  name: `Responses ${TIER_LABEL[tierSlug]} (OpenAI Responses API)`,
  slug: `${tierSlug}-responses`,
  category: "llm",
  price: priceString(tierSlug),
  description: describe(tierSlug),
  tags: tierSlug === "v1-chat-metered" ? ["llm", "ai", "inference", "openai-compatible", "responses-api", "agents-sdk", "codex", "gateway", "openrouter", "metered", "pay-per-token"] : ["llm", "ai", "inference", "openai-compatible", "responses-api", "agents-sdk", "gateway", "openrouter"],
  ...(tierSlug === "v1-chat-metered" ? { quote: (body) => meteredResponsesQuoteUsd(body).usd } : {}),
  discovery: {
    bodyType: "json",
    // A tier whose default model reasons before it speaks (it carries
    // defaultMaxTokens) publishes NO budget in its example: 128 tokens were
    // consumed entirely by reasoning on the premium tier and our own example
    // answered 502 (2026-09-02 audit). The tier default leaves room.
    input: tierSlug === "v1-chat-auto"
      ? { input: "Summarize x402 in one sentence.", max_output_tokens: 128 }
      : { model: EXAMPLE_MODEL_BY_TIER[tierSlug], input: "Summarize x402 in one sentence.", ...(TIERS[tierSlug]?.defaultMaxTokens ? {} : { max_output_tokens: 128 }) },
    inputSchema: INPUT_SCHEMA,
    output: { example: EXAMPLE_OUT },
  },
  handler: makeResponsesHandler(tierSlug),
}));
