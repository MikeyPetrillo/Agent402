// Google's NATIVE generateContent wire, served from the same gateway.
//
// Why a fourth wire. A buyer holding the Google GenAI SDK cannot point it at an
// OpenAI-shaped endpoint: it sends `contents` and expects `candidates`. The
// three wires we already serve (OpenAI chat, Anthropic Messages, OpenAI
// Responses) each have a NATIVE upstream at OpenRouter, so they are relays.
// This one does not: probed live 2026-09-18, OpenRouter answers 404 on every
// spelling of /v1beta/models/<model>:generateContent. So this wire is a
// TRANSLATION, not a relay - Gemini shape in, chat shape upstream, Gemini shape
// out.
//
// It translates and then calls the chat tier's OWN handler in process rather
// than re-implementing the serving path. That is deliberate: every guard the
// chat wire carries - the settle-failure breaker, the margin clamp, the
// failover chain, flex/priority service tiers, the metered belt, the billing
// scrub and the usage telemetry - applies here without a second copy that can
// drift. The only code below is the two translations and the refusals for
// Gemini fields we cannot honour.
//
// Metered quoting stays consistent because BOTH sides quote the same object:
// the 402 price function translates the Gemini body and quotes the chat body,
// and the handler hands that same chat body to the chat handler, whose own belt
// re-quotes it. A translation that is deterministic makes the two agree; one
// that is not would refuse the call rather than mis-charge it.
//
// NOT served here and refused by name rather than ignored: streaming
// (:streamGenerateContent is a different path and a different frame format),
// safetySettings (we cannot honour a threshold we do not control), topK,
// candidateCount above 1 (n>1 multiplies upstream cost), and thinkingConfig
// (the chat wire owns reasoning defaults). A field we silently dropped would
// be a buyer believing they set something they did not.
import {
  TIERS, canonicalModel, bad, meteredQuoteForProbe, validateRequest, LLM_GATEWAY_TOOLS,
  isFlatTier, flatTierQuoteUsd,
} from "./llm-gateway-kit.js";

/** Tier slug -> the fixed catalog path for that tier's Gemini route.
 *  The Google-shaped URL (/v1beta/models/<model>:generateContent) is an ALIAS
 *  that rewrites onto these before any gate, the same way the Anthropic SDK
 *  path and the /api/chain verbs do. A catalog route has to be a fixed string:
 *  the paywall, the pricing surface and the discovery manifest all key on
 *  "METHOD /path", and a path carrying the model in a segment cannot be one. */
export const GEMINI_PATH_BY_TIER = {
  "v1-chat-nano": "/v1/nano/gemini",
  "v1-chat-auto": "/v1/auto/gemini",
  "v1-chat": "/v1/gemini",
  "v1-chat-pro": "/v1/pro/gemini",
  "v1-chat-premium": "/v1/premium/gemini",
  // Metered LAST (the TIERS ordering rule).
  "v1-chat-metered": "/v1/metered/gemini",
};
export const GEMINI_TIER_BY_PATH = Object.fromEntries(Object.entries(GEMINI_PATH_BY_TIER).map(([t, p]) => [p, t]));

const MAX_CONTENTS = 100;
const MAX_PARTS = 64;
const MAX_TOOLS = 64;
const MAX_STOP_SEQUENCES = 8;

const FINISH_TO_GEMINI = {
  stop: "STOP",
  length: "MAX_TOKENS",
  content_filter: "SAFETY",
  tool_calls: "STOP",
  function_call: "STOP",
};

function partsToText(parts, where) {
  let text = "";
  const images = [];
  for (const p of parts) {
    if (p == null || typeof p !== "object") throw bad(`${where}: each entry of "parts" must be an object`);
    if (typeof p.text === "string") { text += p.text; continue; }
    const inline = p.inlineData || p.inline_data;
    if (inline && typeof inline === "object") {
      const mime = inline.mimeType || inline.mime_type;
      const data = inline.data;
      if (typeof mime !== "string" || typeof data !== "string") throw bad(`${where}: "inlineData" needs "mimeType" and base64 "data"`);
      if (!/^image\//.test(mime)) throw bad(`${where}: only image/* inlineData is served on this wire (got ${mime}); audio and video are not`);
      images.push(`data:${mime};base64,${data}`);
      continue;
    }
    if (p.functionCall || p.function_call || p.functionResponse || p.function_response) continue; // handled by the caller
    throw bad(`${where}: unsupported part. This wire serves "text" and image "inlineData", plus "functionCall"/"functionResponse" turns.`);
  }
  return { text, images };
}

/** Gemini request -> OpenAI chat request. Pure and deterministic: the metered
 *  quote and the served body are both derived from it, so any nondeterminism
 *  here would show up as a refused call, never as a wrong charge. */
export function geminiToChat(input, model) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  for (const [k, why] of [
    ["safetySettings", "this wire cannot honour a safety threshold it does not control upstream"],
    ["safety_settings", "this wire cannot honour a safety threshold it does not control upstream"],
    ["cachedContent", "server-side context caching is not offered; the gateway caches nothing on your behalf"],
    ["cached_content", "server-side context caching is not offered; the gateway caches nothing on your behalf"],
  ]) if (input[k] !== undefined) throw bad(`"${k}" is not supported on this route - ${why}.`);

  const contents = input.contents;
  if (!Array.isArray(contents) || contents.length === 0) throw bad('"contents" must be a non-empty array');
  if (contents.length > MAX_CONTENTS) throw bad(`"contents" is capped at ${MAX_CONTENTS} turns on this route`);

  const messages = [];
  const sys = input.systemInstruction || input.system_instruction;
  if (sys !== undefined) {
    const sysParts = Array.isArray(sys?.parts) ? sys.parts : typeof sys === "string" ? [{ text: sys }] : null;
    if (!sysParts) throw bad('"systemInstruction" must be a string or an object with "parts"');
    const { text, images } = partsToText(sysParts, "systemInstruction");
    if (images.length) throw bad('"systemInstruction" cannot carry inlineData');
    if (text) messages.push({ role: "system", content: text });
  }

  let images = 0;
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i];
    const where = `contents[${i}]`;
    if (c == null || typeof c !== "object") throw bad(`${where} must be an object`);
    const parts = c.parts;
    if (!Array.isArray(parts) || parts.length === 0) throw bad(`${where}: "parts" must be a non-empty array`);
    if (parts.length > MAX_PARTS) throw bad(`${where}: "parts" is capped at ${MAX_PARTS}`);
    const role = c.role === undefined ? "user" : c.role;
    if (role !== "user" && role !== "model" && role !== "function") throw bad(`${where}: "role" must be "user", "model" or "function"`);

    // A functionResponse turn becomes an OpenAI tool message; a functionCall
    // turn becomes an assistant message carrying tool_calls. Gemini keys those
    // by NAME and OpenAI by id, so the name is carried as the id - it round
    // trips, and a model that emitted two calls of the same name in one turn
    // gets distinct ids by index.
    const responses = parts.filter((p) => p?.functionResponse || p?.function_response);
    if (responses.length) {
      for (const p of responses) {
        const fr = p.functionResponse || p.function_response;
        if (typeof fr?.name !== "string") throw bad(`${where}: "functionResponse" needs a "name"`);
        messages.push({ role: "tool", tool_call_id: fr.name, content: JSON.stringify(fr.response ?? null) });
      }
      continue;
    }
    const calls = parts.filter((p) => p?.functionCall || p?.function_call);
    const { text, images: imgs } = partsToText(parts, where);
    images += imgs.length;
    if (calls.length) {
      messages.push({
        role: "assistant",
        ...(text ? { content: text } : { content: null }),
        tool_calls: calls.map((p, n) => {
          const fc = p.functionCall || p.function_call;
          if (typeof fc?.name !== "string") throw bad(`${where}: "functionCall" needs a "name"`);
          return { id: n === 0 ? fc.name : `${fc.name}_${n}`, type: "function", function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) } };
        }),
      });
      continue;
    }
    const openaiRole = role === "model" ? "assistant" : "user";
    messages.push({ role: openaiRole, content: imgs.length
      ? [...(text ? [{ type: "text", text }] : []), ...imgs.map((url) => ({ type: "image_url", image_url: { url } }))]
      : text });
  }

  const gc = input.generationConfig || input.generation_config || {};
  if (gc !== null && typeof gc !== "object") throw bad('"generationConfig" must be an object');
  for (const [k, why] of [
    ["topK", "the chat wire upstream takes no top_k"],
    ["top_k", "the chat wire upstream takes no top_k"],
    ["thinkingConfig", "reasoning depth is set per tier on this gateway; see GET /v1/models"],
    ["thinking_config", "reasoning depth is set per tier on this gateway; see GET /v1/models"],
  ]) if (gc?.[k] !== undefined) throw bad(`"generationConfig.${k}" is not supported on this route - ${why}.`);
  const n = gc?.candidateCount ?? gc?.candidate_count;
  if (n !== undefined && n !== 1) throw bad('"generationConfig.candidateCount" must be 1 on this route.');

  const chat = { model, messages };
  const maxOut = gc?.maxOutputTokens ?? gc?.max_output_tokens;
  if (maxOut !== undefined) chat.max_tokens = maxOut;
  if (gc?.temperature !== undefined) chat.temperature = gc.temperature;
  const topP = gc?.topP ?? gc?.top_p;
  if (topP !== undefined) chat.top_p = topP;
  const stops = gc?.stopSequences ?? gc?.stop_sequences;
  if (stops !== undefined) {
    if (!Array.isArray(stops) || stops.some((s) => typeof s !== "string")) throw bad('"generationConfig.stopSequences" must be an array of strings');
    if (stops.length > MAX_STOP_SEQUENCES) throw bad(`"generationConfig.stopSequences" is capped at ${MAX_STOP_SEQUENCES}`);
    chat.stop = stops;
  }
  const mime = gc?.responseMimeType ?? gc?.response_mime_type;
  const schema = gc?.responseSchema ?? gc?.response_schema;
  if (schema !== undefined) chat.response_format = { type: "json_schema", json_schema: { name: "response", schema, strict: true } };
  else if (mime === "application/json") chat.response_format = { type: "json_object" };
  else if (mime !== undefined && mime !== "text/plain") throw bad(`"generationConfig.responseMimeType" must be "text/plain" or "application/json" (got ${mime})`);

  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) throw bad('"tools" must be an array');
    const fns = [];
    for (const t of input.tools) {
      const decls = t?.functionDeclarations || t?.function_declarations;
      if (!Array.isArray(decls)) throw bad('each "tools" entry must carry "functionDeclarations" - this wire serves client function tools only, not Google search or code execution.');
      for (const d of decls) {
        if (typeof d?.name !== "string") throw bad('each function declaration needs a "name"');
        fns.push({ type: "function", function: { name: d.name, ...(d.description ? { description: d.description } : {}), parameters: d.parameters ?? { type: "object", properties: {} } } });
      }
    }
    if (fns.length > MAX_TOOLS) throw bad(`"tools" is capped at ${MAX_TOOLS} function declarations`);
    if (fns.length) chat.tools = fns;
  }
  const mode = (input.toolConfig || input.tool_config)?.functionCallingConfig?.mode
    || (input.toolConfig || input.tool_config)?.function_calling_config?.mode;
  if (mode !== undefined) {
    const map = { AUTO: "auto", ANY: "required", NONE: "none" };
    if (!Object.hasOwn(map, mode)) throw bad(`"toolConfig.functionCallingConfig.mode" must be one of ${Object.keys(map).join(", ")}`);
    chat.tool_choice = map[mode];
  }
  return { chat, images };
}

/** OpenAI chat response -> Gemini generateContent response. */
export function chatToGemini(data, model) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const msg = choice?.message || {};
  const parts = [];
  if (typeof msg.content === "string" && msg.content) parts.push({ text: msg.content });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let args = {};
    try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { args = { _raw: tc?.function?.arguments ?? null }; }
    parts.push({ functionCall: { name: tc?.function?.name, args } });
  }
  const u = data?.usage || {};
  return {
    candidates: [{
      content: { role: "model", parts },
      // A refusal with no content is a real Gemini shape (finishReason SAFETY
      // and empty parts); the chat wire already walks its chain on an empty
      // answer, so anything that reaches here had something to say or ended
      // for a stated reason.
      finishReason: FINISH_TO_GEMINI[choice?.finish_reason] || "FINISH_REASON_UNSPECIFIED",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: u.prompt_tokens ?? 0,
      candidatesTokenCount: u.completion_tokens ?? 0,
      totalTokenCount: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
    },
    modelVersion: data?.model || model,
  };
}

/** Per-request price of the metered Gemini route, from the RAW body. Never
 *  throws: an invalid body quotes the floor and the handler's own 400 refuses
 *  it, uncharged. Quotes the TRANSLATED chat body, which is exactly what the
 *  handler serves, so the gate and the belt agree by construction. */
export function meteredGeminiQuoteUsd(input) {
  const tier = TIERS["v1-chat-metered"];
  try {
    const model = modelOf(input, "v1-chat-metered");
    const { chat, images } = geminiToChat(input, model);
    const probe = validateRequest(chat, "v1-chat-metered", { clamp: false });
    return meteredQuoteForProbe(probe, images);
  } catch (e) {
    return { usd: tier.price, invalid: true, reason: String(e?.message || e).slice(0, 160) };
  }
}

/** The model for this call: the `model` field the alias rewrite folded in from
 *  the Google-shaped path, else one sent in the body, else the tier default. */
function modelOf(input, tierSlug) {
  const raw = input?.model;
  const m = canonicalModel(typeof raw === "string" ? raw.replace(/^models\//, "") : raw);
  return m || TIERS[tierSlug].defaultModel;
}

/** Chat path -> this wire's path, for the tiers that have BOTH. The chat
 *  validator's cross-tier errors name a chat route ("... call
 *  /v1/chat/completions instead"), and a buyer who reached us with a Google SDK
 *  cannot speak that wire - our own error would be sending them somewhere their
 *  client cannot go. So the message is re-pointed at the SAME tier's Gemini
 *  route. Tiers with no Gemini twin (grounded, the stealth tier) are left
 *  alone on purpose: naming the chat route is then the honest answer, because
 *  that is genuinely the only place the model is served. */
const CHAT_PATH_TO_GEMINI = new Map(
  LLM_GATEWAY_TOOLS
    .filter((t) => GEMINI_PATH_BY_TIER[t.slug])
    .map((t) => [String(t.route).replace(/^POST\s+/, ""), GEMINI_PATH_BY_TIER[t.slug]]),
);
export function repointToGeminiWire(message) {
  let out = String(message ?? "");
  // Longest first: /v1/metered/chat/completions contains /v1/chat/completions
  // as no substring, but /v1/chat/completions IS a substring of the nano and
  // pro paths' neighbours in other messages, so order defensively.
  for (const [chatPath, geminiPath] of [...CHAT_PATH_TO_GEMINI].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(chatPath).join(geminiPath);
  }
  return out;
}

export function makeGeminiHandler(tierSlug) {
  return async function geminiHandler(input, req) {
    if (input?.stream === true || input?.alt === "sse") {
      throw bad(`Streaming is not served on this route. Use ${GEMINI_PATH_BY_TIER[tierSlug]} without streaming, or the OpenAI chat wire, which streams (GET /v1/models).`);
    }
    const model = modelOf(input, tierSlug);
    const { chat } = geminiToChat(input, model);
    const chatTool = LLM_GATEWAY_TOOLS.find((t) => t.slug === tierSlug);
    if (!chatTool) throw bad(`Gateway tier ${tierSlug} is not available`, 503);
    // The chat handler owns everything that can refuse, spend or charge: the
    // settle-failure breaker, the margin clamp, the failover chain and the
    // metered belt. Its throws pass through unchanged, so a buyer sees the
    // same status and the same words they would on the chat route.
    let data;
    try {
      data = await chatTool.handler(chat, req);
    } catch (e) {
      // Same status, same reasoning, but any chat path in the words is
      // re-pointed at this wire (see repointToGeminiWire).
      if (e && typeof e.message === "string") e.message = repointToGeminiWire(e.message);
      throw e;
    }
    const out = chatToGemini(data, model);
    // Price by model: the chat handler served another flat tier's config
    // because this request was gated at that tier's price; say so here too.
    if (data?.agent402_tier) out.agent402_tier = { ...data.agent402_tier, route: GEMINI_PATH_BY_TIER[tierSlug] };
    // model "auto" (routed by the auto tier): carry the router's disclosure too.
    if (data?.agent402_router) out.agent402_router = data.agent402_router;
    return out;
  };
}

const EXAMPLE_IN = {
  contents: [{ role: "user", parts: [{ text: "Summarize x402 in one sentence." }] }],
  generationConfig: { maxOutputTokens: 256 },
};
const EXAMPLE_OUT = {
  candidates: [{ content: { role: "model", parts: [{ text: "x402 is an HTTP-native way for agents to pay per request with USDC." }] }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 18, totalTokenCount: 32 },
  modelVersion: "google/gemini-3.5-flash-lite",
};
const INPUT_SCHEMA = {
  type: "object",
  required: ["contents"],
  properties: {
    contents: { type: "array", description: "Gemini turns: [{role, parts:[{text}|{inlineData}]}]" },
    systemInstruction: { type: "object", description: "Optional system turn: {parts:[{text}]}" },
    generationConfig: { type: "object", description: "maxOutputTokens, temperature, topP, stopSequences, responseMimeType, responseSchema" },
    tools: { type: "array", description: "[{functionDeclarations:[{name, description, parameters}]}]" },
    model: { type: "string", description: "Optional; the Google-shaped path carries it (/v1beta/models/<model>:generateContent)" },
  },
};
const TIER_LABEL = { "v1-chat-nano": "nano", "v1-chat-auto": "auto", "v1-chat": "base", "v1-chat-pro": "pro", "v1-chat-premium": "premium", "v1-chat-metered": "metered" };

export const LLM_GEMINI_TOOLS = Object.entries(GEMINI_PATH_BY_TIER).map(([tierSlug, path]) => {
  const tier = TIERS[tierSlug];
  return {
    route: `POST ${path}`,
    name: `Gemini generateContent (${TIER_LABEL[tierSlug]} tier)`,
    slug: `${tierSlug}-gemini`,
    category: "llm",
    price: tier.metered ? `$${tier.price.toFixed(3)}` : `$${tier.price.toFixed(3)}`,
    ...(tier.metered ? { quote: (body) => meteredGeminiQuoteUsd(body).usd } : {}),
    // Price by model on a flat route: the same model this wire hands the chat
    // handler (modelOf), so the gate's price and the served tier agree.
    ...(isFlatTier(tierSlug) ? { tierQuote: (body) => flatTierQuoteUsd(tierSlug, modelOf(body, tierSlug)) } : {}),
    description: `Google's native generateContent wire on the ${TIER_LABEL[tierSlug]} tier. Send Gemini's own request shape (contents, systemInstruction, generationConfig, function declarations) and get Gemini's own response shape (candidates, usageMetadata) back. Point a Google GenAI SDK at this gateway and pay per request with USDC, no account. Also answers the Google-shaped path /v1beta/models/<model>:generateContent.`,
    tags: ["llm", "gemini", "google", "generatecontent", "chat"],
    discovery: { bodyType: "json", inputSchema: INPUT_SCHEMA, input: EXAMPLE_IN, output: { example: EXAMPLE_OUT } },
    handler: makeGeminiHandler(tierSlug),
  };
});
