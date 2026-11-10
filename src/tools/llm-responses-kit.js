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
  substitutedFrom, TIERS, AUTO_RANKINGS, classifyPrompt, canonicalModel, tierAllows, tierFor, meteredQuoteForProbe, meteredBoundFor,
  isFlatTier, flatTierQuoteUsd, servedTierFor, crossTierDisclosure, AUTO_MODEL, AUTO_TIER,
  clampToMargin, assertMeteredAvailable, attemptsFor, serviceTierFor, validateServiceTier, cacheControlPref, upstreamUserId, PROVIDER_SORT_ENABLED,
  fetchOpenRouter, upstreamHttpError, refuseUnlistedMeteredModel, streamOpenRouterTo, bad, MAX_IMAGES, maxInputCharsFor, inputTooLargeError,
  failoverChain, modelFallbackPref, availabilitySubstitution, retryRateLimited,
  rateLimitDelaysFor, paymentWindowTimeoutMs, timedOutBudget, streamClientWatch, STREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS,
  validateReasoning, reasoningForLink, lowestEffortRetry, recoveryRunAffordable, retryEmptyAtLowestEffort,
  setReasoningAdjustedHeader, REASONING_ADJUSTED, LINK_PROBE,
  refuseCostVariants, refuseUnsupportedParams, defaultModelFor, defaultModelCompatNote,
  assertUpstreamBody,
  stripBilling,
} from "./llm-gateway-kit.js";

import { METER_MIN_SETTLE_USD, setMeterSentinel } from "../gateway-meter.js";
import { gatewaySettleBreakerCheck } from "../gateway-settle-breaker.js";
import { flattenNamespaceForResponses, attributeNamespaces } from "./tool-namespaces.js";
const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
const MAX_TOOLS = 64;
const MAX_INPUT_ITEMS = 200; // default; a tier may raise it (`maxInputItems`) - the metered tier does

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
      case "refusal":
        // An echoed assistant refusal (output message content).
        if (typeof p.refusal !== "string") throw bad(`${where}.content[${i}].refusal must be a string`);
        acc.chars += p.refusal.length;
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
        throw bad(`${where}.content[${i}]: unsupported part type "${p.type}" (allowed: input_text, input_image, output_text, refusal)`);
    }
  });
}

// What goes upstream is rebuilt from the fields each item and part type
// documents, never the buyer's object: an unknown field, a file reference
// (file_id, file_url) or a container reference would otherwise reach the
// upstream unread. Runs after validation, so every kept field was checked.
const IMAGE_DETAIL = new Set(["auto", "low", "high"]);
const str = (v) => typeof v === "string";
const num = (v) => typeof v === "number" && Number.isFinite(v);
// output_text: `annotations` is required by the output-message schema. Only a
// url_citation is kept; file_citation, container_file_citation and file_path
// annotations name a file or container and are dropped.
function forwardAnnotations(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && a.type === "url_citation" && str(a.url)).map((a) => ({
    type: "url_citation", url: a.url,
    ...(str(a.title) ? { title: a.title } : {}),
    ...(num(a.start_index) ? { start_index: a.start_index } : {}),
    ...(num(a.end_index) ? { end_index: a.end_index } : {}),
  }));
}
const forwardBytes = (b) => (Array.isArray(b) && b.every((x) => Number.isInteger(x)) ? { bytes: b } : {});
const forwardLogprob = (l) => ({ token: l.token, logprob: l.logprob, ...forwardBytes(l.bytes) });
function forwardLogprobs(list) {
  if (!Array.isArray(list)) return null;
  return list.filter((l) => l && str(l.token) && num(l.logprob)).map((l) => ({
    ...forwardLogprob(l),
    ...(Array.isArray(l.top_logprobs) ? { top_logprobs: l.top_logprobs.filter((t) => t && str(t.token) && num(t.logprob)).map(forwardLogprob) } : {}),
  }));
}
function forwardPart(p) {
  if (p.type === "input_image") {
    const image_url = str(p.image_url) ? p.image_url : { url: p.image_url.url };
    return { type: "input_image", image_url, ...(IMAGE_DETAIL.has(p.detail) ? { detail: p.detail } : {}) };
  }
  if (p.type === "output_text") {
    const logprobs = forwardLogprobs(p.logprobs);
    return { type: "output_text", text: p.text, annotations: forwardAnnotations(p.annotations), ...(logprobs ? { logprobs } : {}) };
  }
  if (p.type === "refusal") return { type: "refusal", refusal: p.refusal };
  return { type: p.type, text: p.text };
}
const forwardContent = (c) => (str(c) ? c : c.map(forwardPart));
const withIdStatus = (it, out) => ({ ...out, ...(str(it.id) ? { id: it.id } : {}), ...(str(it.status) ? { status: it.status } : {}) });
function forwardItem(it, type) {
  switch (type) {
    case "message":
      return withIdStatus(it, { ...(it.type === "message" ? { type: "message" } : {}), role: it.role, content: forwardContent(it.content) });
    case "function_call":
      return withIdStatus(it, { type: "function_call", call_id: it.call_id, name: it.name, arguments: str(it.arguments) ? it.arguments : JSON.stringify(it.arguments ?? {}), ...(str(it.namespace) ? { namespace: it.namespace } : {}) });
    case "function_call_output":
      return withIdStatus(it, { type: "function_call_output", call_id: it.call_id, output: forwardContent(it.output) });
    case "reasoning": {
      const summary = Array.isArray(it.summary) ? it.summary.filter((x) => x && str(x.text)).map((x) => ({ type: "summary_text", text: x.text })) : [];
      const content = Array.isArray(it.content) ? it.content.filter((x) => x && str(x.text)).map((x) => ({ type: "reasoning_text", text: x.text })) : null;
      return withIdStatus(it, { type: "reasoning", summary, ...(content ? { content } : {}), ...(str(it.encrypted_content) ? { encrypted_content: it.encrypted_content } : {}) });
    }
    default:
      return null;
  }
}
const forwardFunctionTool = (t) => ({
  type: "function", name: t.name,
  ...(str(t.description) ? { description: t.description } : {}),
  ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
  ...(typeof t.strict === "boolean" ? { strict: t.strict } : {}),
});

/** Validate an OpenAI Responses request for a tier. Returns
 *  { body, probe, imageCount, isRouted, routedCategory, routedQuality, chain }. */
export function validateResponsesRequest(input, tierSlug) {
  assertMeteredAvailable(TIERS[tierSlug]);
  const tier = TIERS[tierSlug];
  if (!tier) throw bad(`unknown tier ${tierSlug}`, 500);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Body must be a JSON object (OpenAI Responses request)");
  if (input.previous_response_id !== undefined) throw bad('"previous_response_id" is not supported - this gateway stores no conversation state (store is always false); send the full input each call');
  if (input.background === true) throw bad('"background" responses are not served (no server-side state)');
  const isRouted = tier.router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto");
  let model = canonicalModel(input.model);
  const substituted = substitutedFrom(input.model);
  let defaultedModel = null;
  // One read of the parameters a model may not take, shared by the default
  // choice and the refusal below, so the two can never disagree.
  const paramCtx = (() => {
    const last = Array.isArray(input.input) ? input.input[input.input.length - 1] : null;
    return {
      sampling: { temperature: input.temperature, top_p: input.top_p, top_k: input.top_k },
      endsWithAssistant: !!last && (last.type || (last.role ? "message" : null)) === "message" && last.role === "assistant",
      reasoningBudget: input.reasoning?.max_tokens !== undefined,
    };
  })();
  if (!isRouted) {
    refuseCostVariants(model);
    if (!model && tier.defaultModel) { // see llm-messages-kit: serve the tier default, never refuse a missing model
      model = defaultModelFor(tier, paramCtx);
      defaultedModel = model;
    }
    if (!model) throw bad(`"model" is required (e.g. openai/gpt-4o-mini). This tier serves: ${tier.prefixes?.slice(0, 6).join(", ") || "see /v1/models"}`);
    if (!tierAllows(tierSlug, model, input.model)) {
      // "auto" when not gated at the auto price: name the auto route.
      const home = model === AUTO_MODEL ? AUTO_TIER : tierFor(model);
      // RESPONSES_PATH_BY_TIER is an explicit map: a chat tier with no
      // Responses twin would render as "served on undefined". Fall back to
      // that tier's real chat route.
      const homePath = home ? (RESPONSES_PATH_BY_TIER[home] || TIERS[home].route.split(" ")[1]) : null;
      throw bad(home && home !== tierSlug ? `"${model}" is served on ${homePath} (${home})` : `"model" ${model} is not served on this tier - GET /v1/models lists every model and its tier`);
    }
    // Metered: an id the live list does not carry is refused, as on the chat wire.
    refuseUnlistedMeteredModel(tier, model);
  }
  const acc = { chars: 0, images: 0 };
  let probeInput;
  let forwardInput = input.input;
  if (typeof input.input === "string") { acc.chars += input.input.length; probeInput = input.input; }
  else if (Array.isArray(input.input)) {
    const maxItems = Number.isFinite(tier.maxInputItems) ? tier.maxInputItems : MAX_INPUT_ITEMS;
    if (input.input.length === 0 || input.input.length > maxItems) throw bad(`"input" must have 1-${maxItems} items on ${RESPONSES_PATH_BY_TIER[tierSlug]}` + (!tier.metered && TIERS["v1-chat-metered"]?.maxInputItems ? ` (${RESPONSES_PATH_BY_TIER["v1-chat-metered"]} allows ${TIERS["v1-chat-metered"].maxInputItems})` : ""));
    forwardInput = [];
    const probeItem = (it, type, i) => {
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
    };
    probeInput = input.input.map((it, i) => {
      if (!it || typeof it !== "object") throw bad(`input[${i}] must be an object`);
      const type = it.type || (it.role ? "message" : null);
      const checked = probeItem(it, type, i);
      forwardInput.push(forwardItem(it, type));
      return checked;
    });
  } else throw bad('"input" is required: a string or an array of input items');
  let instructions;
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== "string") throw bad('"instructions" must be a string');
    acc.chars += input.instructions.length; instructions = input.instructions;
  }
  if (acc.chars > tier.maxInputChars && acc.chars > maxInputCharsFor(tierSlug, model)) throw inputTooLargeError(tierSlug, model, acc.chars, RESPONSES_PATH_BY_TIER);
  if (acc.images > MAX_IMAGES) throw bad(`Too many images (${acc.images}). Maximum is ${MAX_IMAGES} per request`);
  // The tier's own default budget, like the chat wire: a premium model that
  // reasons before it speaks spent a hardcoded 1024 entirely on reasoning and
  // our own documented example answered 502 "reasoning consumed it"
  // (2026-09-02 audit); the chat wire has given such tiers 4,096 since 08-19.
  const tierDefaultMax = Math.min(tier.defaultMaxTokens || 1024, tier.maxTokens);
  let maxOut = input.max_output_tokens != null ? parseInt(input.max_output_tokens, 10) : tierDefaultMax;
  if (!Number.isFinite(maxOut) || maxOut < 1) maxOut = tierDefaultMax;
  if (maxOut > tier.maxTokens) maxOut = tier.maxTokens;

  const body = { model: isRouted ? undefined : model, input: forwardInput, max_output_tokens: maxOut, store: false };
  if (instructions !== undefined) body.instructions = instructions;
  // Parameters the model does not take (GPT-6 Astra sampling; Claude Haiku 5
  // sampling and assistant prefill): named before any upstream call, as on the
  // chat and Messages wires.
  if (!isRouted) refuseUnsupportedParams(model, paramCtx);
  for (const k of ["temperature", "top_p", "metadata", "tool_choice", "parallel_tool_calls", "truncation"]) if (input[k] !== undefined) body[k] = input[k];
  // `text` carries the output format and verbosity, nothing else.
  if (input.text && typeof input.text === "object" && !Array.isArray(input.text)) {
    const text = {};
    if (input.text.format !== undefined) text.format = input.text.format;
    if (input.text.verbosity !== undefined) text.verbosity = input.text.verbosity;
    body.text = text;
  } else if (input.text !== undefined) body.text = input.text;
  // tool_choice mirrors the tools guard (function tools only): Responses wire
  // is "none"|"auto"|"required" or {type:"function", name} - a hosted-tool
  // choice ({type:"web_search_preview"} etc.) is refused like the tool itself.
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    const okString = tc === "none" || tc === "auto" || tc === "required";
    const okObject = tc && typeof tc === "object" && tc.type === "function" && typeof tc.name === "string";
    if (!okString && !okObject) throw bad('"tool_choice" must be "none", "auto", "required", or {type:"function", name}');
  }
  let namespaceOf = null;
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length === 0 || input.tools.length > MAX_TOOLS) throw bad(`"tools" must be a non-empty array of up to ${MAX_TOOLS} function tools`);
    const flat = [];
    for (const [i, t] of input.tools.entries()) {
      if (!t || typeof t !== "object" || typeof t.type !== "string") throw bad(`tools[${i}] must be {type:"function", name, parameters}`);
      // A tool namespace flattens into its function tools (see tool-namespaces.js);
      // the name -> namespace map puts `namespace` back on each function_call
      // in the non-streamed output, as OpenAI's FunctionCall item carries it.
      if (t.type === "namespace") {
        const ns = flattenNamespaceForResponses(t, `tools[${i}]`);
        flat.push(...ns.tools);
        namespaceOf = { ...(namespaceOf || {}), ...ns.namespaceOf };
        continue;
      }
      if (SERVER_TOOL_RE.test(t.type) || t.type !== "function") throw bad(`tools[${i}]: "${t.type}" is a server-side tool (spend bounded by neither max_output_tokens nor the price cap) - only type:"function" tools (and namespaces of them) are served`);
      if (typeof t.name !== "string") throw bad(`tools[${i}].name is required`);
      flat.push(forwardFunctionTool(t));
    }
    if (flat.length > MAX_TOOLS) throw bad(`"tools" flattens to ${flat.length} function tools; the maximum is ${MAX_TOOLS}`);
    body.tools = flat;
  }
  const reasoning = validateReasoning(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}, tier);
  // Chat-wire parity: the reasoning budget must be strictly below the output
  // cap, because the cap is the whole output the price covers.
  if (reasoning?.max_tokens !== undefined && reasoning.max_tokens >= maxOut) {
    throw bad(`"reasoning.max_tokens" (${reasoning.max_tokens}) must be below "max_output_tokens" (${maxOut}) - reasoning tokens are output tokens and the whole output is what is priced`);
  }
  if (reasoning !== undefined) body.reasoning = reasoning;
  if (input.stream === true) body.stream = true;
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  // service_tier "priority" (alias "fast") on the tiers that price it; the
  // probe carries it so clampToMargin sizes max_output_tokens at the
  // priority rate (PRIORITY_PRICE_FACTOR). Refused with the reason elsewhere.
  const serviceTier = validateServiceTier(input, tier);
  if (serviceTier) body.service_tier = serviceTier;
  cacheControlPref(input);
  const probe = { model: body.model, max_tokens: maxOut, input: probeInput, ...(instructions !== undefined ? { instructions } : {}), ...(body.tools ? { tools: body.tools } : {}), ...(body.text ? { text: body.text } : {}), ...(serviceTier ? { service_tier: serviceTier } : {}) };
  const probeMessages = [];
  if (instructions) probeMessages.push({ role: "user", content: instructions });
  if (typeof probeInput === "string") probeMessages.push({ role: "user", content: probeInput });
  else for (const it of probeInput) if (it?.role && it.content !== undefined) probeMessages.push({ role: "user", content: typeof it.content === "string" ? it.content : it.content.map((p) => (p?.text ? { type: "text", text: p.text } : p)) });
  const routedCategory = isRouted ? classifyPrompt(probeMessages) : null;
  const routedQuality = isRouted ? (input.quality === undefined ? "balanced" : String(input.quality)) : null;
  if (isRouted && !AUTO_RANKINGS[routedQuality]) throw bad('"quality" must be "fast", "balanced", or "best"');
  const chain = isRouted ? [...AUTO_RANKINGS[routedQuality][routedCategory]] : failoverChain(model, tierSlug, { fallback: modelFallbackPref(input) });
  return { body, probe, imageCount: acc.images, isRouted, routedCategory, routedQuality, chain, defaultedModel, substituted: isRouted ? null : substituted, namespaceOf };
}

/** status incomplete for max_output_tokens with no text/function output =
 *  the cap was spent reasoning; a paid empty answer, walk the chain. */
export function isEmptyIncomplete(data) {
  if (!data || data.status !== "incomplete" || data.incomplete_details?.reason !== "max_output_tokens") return false;
  return !saidAnything(data);
}

/** status incomplete for content_filter with no text/function output = an
 *  empty safety refusal; walk the chain like the chat wire does. */
export function isEmptyFilteredIncomplete(data) {
  if (!data || data.status !== "incomplete" || data.incomplete_details?.reason !== "content_filter") return false;
  return !saidAnything(data);
}

function saidAnything(data) {
  const out = Array.isArray(data.output) ? data.output : [];
  return out.some((o) => o?.type === "function_call" || (o?.type === "message" && Array.isArray(o.content) && o.content.some((c) => c?.type === "output_text" && typeof c.text === "string" && c.text.trim() !== "")));
}

/** The end-to-end empty answer's 502 on this wire (not settled). */
export const EMPTY_INCOMPLETE_MESSAGE = "Upstream produced no output within max_output_tokens (reasoning consumed it, after any effort fit and lowest-effort retry by the gateway) - raise max_output_tokens, lower reasoning.effort, or pick a non-reasoning model";

export function makeResponsesHandler(routeTier) {
  return async function responsesHandler(input, req) {
    // Settle-failure breaker first: refuse (nobody charged) before any upstream call.
    await gatewaySettleBreakerCheck(req);
    // Price by model (chat-wire parity): `tierSlug` is the route's tier unless
    // the body names another flat tier's model and the request was gated at
    // that tier's price; then that tier's whole config serves it.
    const tierSlug = servedTierFor(routeTier, input?.model, req);
    const tier = TIERS[tierSlug];
    const { body, probe, imageCount, isRouted, routedCategory, routedQuality, chain, defaultedModel, substituted, namespaceOf } = validateResponsesRequest(input, tierSlug);
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
    // Priced at this prompt's size: a long-context tier bounds a long prompt.
    const meteredBound = tier.metered ? meteredBoundFor(probe, tier, imageCount) : null;
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
      const maxOut = Math.min(body.max_output_tokens, p.max_tokens);
      // A buyer budget follows this link's clamped cap, and a buyer effort
      // or budget that leaves no room for an answer inside it is lowered by
      // the small-budget rule and disclosed (reasoningForLink).
      const { reasoning, note } = reasoningForLink(body.reasoning, model, tierSlug, maxOut, "max_output_tokens");
      return {
        ...body, model, max_output_tokens: maxOut, zdr: undefined,
        ...(reasoning ? { reasoning } : {}),
        ...(provider ? { provider } : {}), ...(user ? { user, session_id: user } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
        service_tier: serviceTierFor(model, body, flex), // flex / priority / explicit default on :nitro
        ...(note ? { [REASONING_ADJUSTED]: note } : {}),
        [LINK_PROBE]: { ...p, max_tokens: maxOut },
      };
    };
    const recordUsage = (usage, upstreamUsd, served, serviceTier) => import("../posthog.js")
      .then(({ capturePostHogGatewayUsage }) => capturePostHogGatewayUsage({
        tier: `${tierSlug}:responses`, routeTier: `${routeTier}:responses`, model: served, priceUsd: quotedUsd ?? tier.price, upstreamUsd,
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
                  url: OPENROUTER_RESPONSES_URL, timeoutMs,
                  onUsage: (usage, cost, frame) => recordUsage(usage, cost, frame?.response?.model || model, frame?.response?.service_tier || (flex ? "flex" : "default")),
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
    const recovery = { used: false }; // one lowest-effort recovery try per call
    for (const { model, flex } of attempts) {
      if (model === refusedModel) continue;
      let outbound;
      try { outbound = outboundFor(model, flex); } catch (e) { if (!lastErr) lastErr = e; continue; }
      const timeoutMs = paymentWindowTimeoutMs(req, UPSTREAM_TIMEOUT_MS);
      const attemptStarted = Date.now();
      try {
        const callOnce = (sendBody, ms) => retryRateLimited(async () => {
          const res = await fetchOpenRouter(sendBody, { url: OPENROUTER_RESPONSES_URL, timeoutMs: ms });
          if (!res.ok) await upstreamHttpError(res, sendBody?.model);
          const text = await res.text();
          let parsed;
          try { parsed = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
          return assertUpstreamBody(parsed, { model: sendBody?.model });
        }, { delays: rateLimitDelaysFor(flex) });
        let data = await callOnce(outbound, timeoutMs);
        let reasoningAdjusted = outbound[REASONING_ADJUSTED] || null;
        // An answer that spent its whole cap reasoning gets one more run of
        // the same model at its lowest supported effort before the chain
        // walks on: once per call, while the price covers another run and
        // time is left.
        if (isEmptyIncomplete(data)) {
          const plan = lowestEffortRetry(outbound.reasoning, body.reasoning, model);
          const again = await retryEmptyAtLowestEffort({
            once: recovery, plan, req, timeouts,
            affordable: () => recoveryRunAffordable(outbound[LINK_PROBE], tier, imageCount, data?.usage?.cost, req?.__meteredQuoteUsd),
            run: (p, ms) => callOnce({ ...outbound, reasoning: p.reasoning }, ms),
            usable: (d) => !(d?.status === "failed" || d?.error) && !isEmptyIncomplete(d) && !isEmptyFilteredIncomplete(d),
          });
          if (again) { data = again; reasoningAdjusted = plan.note; }
        }
        if (data?.status === "failed" || data?.error) {
          lastErr = bad(`Upstream error: ${String(data?.error?.message || data?.error?.code || "response failed").slice(0, 200)}`, 502);
          continue;
        }
        if (isEmptyFilteredIncomplete(data)) {
          lastErr = bad("Upstream declined the request (safety filter) - rephrase the prompt, or pick a different model", 502);
          refusedModel = model;
          continue;
        }
        if (isEmptyIncomplete(data)) {
          lastErr = bad(EMPTY_INCOMPLETE_MESSAGE, 502);
          refusedModel = model;
          continue;
        }
        const upstreamUsd = stripBilling(data.usage);
        await recordUsage(data.usage, upstreamUsd, data.model || model, data.service_tier || (flex ? "flex" : "default"));
        if (routerNote) data.agent402_router = { ...routerNote, served: data.model || model };
        if (defaultedModel) data.agent402_default_model = defaultedModel;
        if (reasoningAdjusted) data.agent402_reasoning_adjusted = reasoningAdjusted; // a reasoning setting was lowered to leave room for the answer
        if (substituted) data.agent402_model_substituted = { requested: substituted, served: body.model, reason: "the requested model is retired upstream; its named successor served instead" };
        else { const sub = availabilitySubstitution(body.model, model); if (sub) data.agent402_model_substituted = sub; }
        if (tierSlug !== routeTier) data.agent402_tier = { ...crossTierDisclosure(routeTier, tierSlug), route: RESPONSES_PATH_BY_TIER[routeTier] };
        if (namespaceOf) attributeNamespaces(data.output, namespaceOf);
        // Metered settlement sentinel (chat-wire parity): the route binder
        // settles actual x markup for upto/credits buyers and strips this
        // before the body leaves. Non-enumerable; a non-number means "no meter".
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
    reasoning: { type: "object", description: 'Optional {effort: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"} - reasoning tokens count against max_output_tokens. An effort above low, or a reasoning.max_tokens budget, that leaves no room for an answer inside a small max_output_tokens is lowered before the call, and an answer that still comes back empty is retried once on the same model at its lowest supported effort when the call\'s price and time allow; either change is named in agent402_reasoning_adjusted {field, requested, used, reason} (the X-Agent402-Reasoning-Adjusted header on a stream)' },
    stream: { type: "boolean", description: "Responses SSE events (response.created … response.completed)" },
    zdr: { type: "boolean", description: "Optional - zero-data-retention providers only" },
  },
  required: ["input"],
};
function describe(tierSlug) {
  const t = TIERS[tierSlug];
  const compat = defaultModelCompatNote(t);
  if (tierSlug === "v1-chat-metered") {
    return `OpenAI Responses API priced per request from the request itself. The 402 quotes the input (instructions, input items and tools), estimated from its tokens with headroom, plus your max_output_tokens, never under $${METER_MIN_SETTLE_USD}; an upto (Permit2) or credits buyer settles actual usage under that quote. Point the OpenAI SDK's responses.create(), the OpenAI Agents SDK, or OpenAI Codex CLI's model_providers base_url at https://agent402.tools/v1/metered. Any model the flat tiers serve (GET /v1/models); function tools only; store is always false.${compat ? ` ${compat}` : ""}`;
  }
  const base = `OpenAI Responses API over x402 - point the OpenAI SDK's responses.create() (or the OpenAI Agents SDK) at base_url https://agent402.tools${RESPONSES_PATH_BY_TIER[tierSlug].replace(/\/responses$/, "")} and pay ${priceString(tierSlug)} per call in USDC, no API key, no signup. Same models, caps and price as this tier's /chat/completions route; any model here is served through the Responses wire. Up to ${t.maxInputChars.toLocaleString("en-US")} input chars and ${t.maxTokens} output tokens; streaming supported; function tools and tool namespaces yes (a namespace is flattened into its functions; function_call items carry a namespace field on non-streamed output), server-side tools (web_search, file_search, computer, mcp) no; no stored conversation state (send the full input each call).`;
  const dflt = t.defaultModel ? ` Omit "model" and the tier serves ${t.defaultModel} (named back in agent402_default_model); the price does not change.${compat ? ` ${compat}` : ""}` : "";
  return tierSlug === "v1-chat-auto" ? `${base} Omit "model" and the gateway routes the prompt to the top-ranked model for its task type; the response adds agent402_router {category, quality, served}.` : base + dflt;
}

export const LLM_RESPONSES_TOOLS = Object.entries(RESPONSES_PATH_BY_TIER).map(([tierSlug, path]) => ({
  route: `POST ${path}`,
  name: `Responses ${TIER_LABEL[tierSlug]} (OpenAI Responses API)`,
  slug: `${tierSlug}-responses`,
  category: "llm",
  price: priceString(tierSlug),
  description: describe(tierSlug),
  tags: tierSlug === "v1-chat-metered" ? ["llm", "ai", "inference", "openai-compatible", "responses-api", "agents-sdk", "codex", "gateway", "metered", "pay-per-token"] : ["llm", "ai", "inference", "openai-compatible", "responses-api", "agents-sdk", "gateway"],
  ...(tierSlug === "v1-chat-metered" ? { quote: (body) => meteredResponsesQuoteUsd(body).usd } : {}),
  // Price by model on a flat route (see LLM_GATEWAY_TOOLS in the gateway kit).
  ...(isFlatTier(tierSlug) ? { tierQuote: (body) => flatTierQuoteUsd(tierSlug, body?.model) } : {}),
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
