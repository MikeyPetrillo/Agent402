// LLM gateway — OpenAI-compatible pay-per-call inference over x402.
//
// Unlike llm-kit (a custom JSON tool), these routes live at the OpenAI wire
// paths and speak the full chat/completions format, so ANY existing agent or
// SDK adopts the gateway by changing base_url — no integration work. That is
// the distribution mechanism behind the top x402 earners: agents pay per
// reasoning turn, in loops, not per occasional tool call.
//
//   POST /v1/chat/completions          $0.02  — budget/mid models
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
// upstream cost well under the x402 price. Streaming is rejected in v1 — the
// paywall settles against a buffered response.

const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Tier → OpenRouter model-id prefixes, input char budget, output token cap.
// Caps chosen so worst-case upstream cost stays well below the x402 price
// (budget models run ~$0.15-0.60/M tokens; 2048 output + 32k input tops out
// around $0.003 — a $0.02 price leaves >6x headroom).
export const TIERS = {
  "v1-chat": {
    route: "POST /v1/chat/completions",
    price: 0.02,
    maxInputChars: 32_000,
    maxTokens: 2048,
    prefixes: [
      "openai/gpt-4o-mini", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
      "anthropic/claude-haiku", "anthropic/claude-3-haiku", "anthropic/claude-3.5-haiku",
      "google/gemini-flash", "google/gemini-2.0-flash", "google/gemini-2.5-flash",
      "deepseek/", "meta-llama/", "mistralai/", "qwen/",
    ],
  },
  "v1-chat-pro": {
    route: "POST /v1/pro/chat/completions",
    price: 0.10,
    maxInputChars: 48_000,
    maxTokens: 4096,
    prefixes: [
      "openai/gpt-4o", "openai/gpt-4.1",
      "anthropic/claude-sonnet", "anthropic/claude-3.5-sonnet", "anthropic/claude-3.7-sonnet",
      "google/gemini-pro", "google/gemini-2.5-pro",
      "x-ai/grok",
    ],
  },
  "v1-chat-premium": {
    route: "POST /v1/premium/chat/completions",
    price: 0.50,
    maxInputChars: 64_000,
    maxTokens: 8192,
    prefixes: [
      "openai/gpt-5", "openai/o3", "openai/o4",
      "anthropic/claude-opus",
    ],
  },
};

// Drop-in compatibility: bare OpenAI-style names map to their OpenRouter ids,
// so `model: "gpt-4o-mini"` from an unmodified OpenAI SDK works unchanged.
export function canonicalModel(model) {
  const m = String(model || "").trim();
  if (!m) return m;
  if (m.includes("/")) return m; // already an OpenRouter id
  if (/^(gpt|o[0-9])/i.test(m)) return `openai/${m}`;
  if (/^claude/i.test(m)) return `anthropic/${m}`;
  if (/^gemini/i.test(m)) return `google/${m}`;
  if (/^grok/i.test(m)) return `x-ai/${m}`;
  if (/^deepseek/i.test(m)) return `deepseek/${m}`;
  return m;
}

export function tierAllows(tierSlug, model) {
  const tier = TIERS[tierSlug];
  if (!tier) return false;
  const id = canonicalModel(model).toLowerCase();
  return tier.prefixes.some((p) => (p.endsWith("/") ? id.startsWith(p) : id === p || id.startsWith(p + "-") || id.startsWith(p + ":")));
}

/** Which gateway tier serves this model — for self-correcting 400s. */
export function tierFor(model) {
  for (const slug of Object.keys(TIERS)) if (tierAllows(slug, model)) return slug;
  return null;
}

const MAX_MESSAGES = 100;
const MAX_IMAGES = 4;
const MAX_IMAGE_URL_LEN = 2048;

function contentChars(content) {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (!Array.isArray(content)) throw bad('"content" must be a string or an array of content blocks');
  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") throw bad("Each content block must be an object with a type field");
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

export function validateRequest(input, tierSlug) {
  const tier = TIERS[tierSlug];
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");

  if (input.stream === true) {
    throw bad('Streaming is not supported on the x402 gateway (payment settles against a complete response). Set "stream": false.');
  }

  const model = canonicalModel(input.model);
  if (!model) throw bad('"model" is required (e.g. "openai/gpt-4o-mini" or "gpt-4o-mini")');
  if (!tierAllows(tierSlug, model)) {
    const home = tierFor(model);
    throw bad(
      home
        ? `Model "${model}" is served by the ${home} tier — call ${TIERS[home].route.split(" ")[1]} (price $${TIERS[home].price.toFixed(2)}/call) instead.`
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
  if (totalChars > tier.maxInputChars) throw bad(`Input too large (${totalChars} chars). The ${tierSlug} tier allows up to ${tier.maxInputChars} chars`);
  if (totalImages > MAX_IMAGES) throw bad(`Too many images (${totalImages}). Maximum is ${MAX_IMAGES} per request`);

  let maxTokens = input.max_tokens != null ? parseInt(input.max_tokens, 10) : Math.min(1024, tier.maxTokens);
  if (Number.isNaN(maxTokens) || maxTokens < 1) maxTokens = Math.min(1024, tier.maxTokens);
  if (maxTokens > tier.maxTokens) maxTokens = tier.maxTokens; // clamp, don't reject — drop-in friendliness

  const body = { model, messages, max_tokens: maxTokens };
  for (const k of PASSTHROUGH) if (input[k] !== undefined) body[k] = input[k];
  return body;
}

async function callOpenRouter(body) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("LLM gateway not configured (OPENROUTER_API_KEY unset)", 503);

  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agent402.tools",
        "X-Title": "Agent402.Tools x402 gateway",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("Gateway upstream auth failed", 502);
    if (res.status === 402) throw bad("Gateway upstream balance exhausted — the operator has been notified", 502);
    if (res.status === 429) throw bad("Upstream rate-limited — retry shortly", 503);
    if (res.status >= 500) throw bad(`Upstream error (HTTP ${res.status})`, 502);
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message || msg; } catch { /* keep raw slice */ }
    throw bad(`Upstream error: ${msg}`, 502);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
  // Full OpenAI wire shape passes through untouched (id, object, created,
  // model, choices incl. tool_calls, usage) — drop-in fidelity is the product.
  return data;
}

function makeHandler(tierSlug) {
  return async (input) => callOpenRouter(validateRequest(input, tierSlug));
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
    model: { type: "string", description: "Model id — OpenRouter form (openai/gpt-4o-mini) or bare OpenAI form (gpt-4o-mini). GET /v1/models lists the allowlist per tier." },
    messages: { type: "array", description: "OpenAI chat messages: [{role, content}] — text and image_url content blocks supported" },
    max_tokens: { type: "number", description: "Output token cap (clamped to the tier maximum)" },
  },
  required: ["model", "messages"],
};

export const LLM_GATEWAY_TOOLS = [
  {
    route: "POST /v1/chat/completions",
    name: "Chat completions (OpenAI-compatible)",
    slug: "v1-chat",
    category: "llm",
    price: "$0.02",
    description:
      "OpenAI-compatible chat completions over x402 — point any OpenAI SDK at base_url https://agent402.tools/v1 and pay per call in USDC (Base, Solana, Polygon, Arbitrum, Stellar), no API key, no signup. Budget/mid models: gpt-4o-mini, claude haiku, gemini flash, deepseek, llama, mistral, qwen. Full wire compatibility incl. tools/function-calling and response_format. GET /v1/models lists every model. No streaming.",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: EXAMPLE, inputSchema: INPUT_SCHEMA, output: { example: EXAMPLE_OUT } },
    handler: makeHandler("v1-chat"),
  },
  {
    route: "POST /v1/pro/chat/completions",
    name: "Chat completions — pro tier",
    slug: "v1-chat-pro",
    category: "llm",
    price: "$0.10",
    description:
      "OpenAI-compatible chat completions, pro tier: gpt-4o, gpt-4.1, claude sonnet, gemini pro, grok — paid per call in USDC over x402. Same wire format as /v1/chat/completions with higher input/output caps (48k chars in, 4096 tokens out).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "openai/gpt-4o" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "openai/gpt-4o" } } },
    handler: makeHandler("v1-chat-pro"),
  },
  {
    route: "POST /v1/premium/chat/completions",
    name: "Chat completions — premium tier",
    slug: "v1-chat-premium",
    category: "llm",
    price: "$0.50",
    description:
      "OpenAI-compatible chat completions, premium tier: gpt-5, o3/o4, claude opus — paid per call in USDC over x402. Same wire format as /v1/chat/completions with the largest caps (64k chars in, 8192 tokens out).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "anthropic/claude-opus-4" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "anthropic/claude-opus-4" } } },
    handler: makeHandler("v1-chat-premium"),
  },
];

/** OpenAI-compatible GET /v1/models payload — free discovery surface. */
export function modelsList() {
  const data = [];
  for (const [slug, tier] of Object.entries(TIERS)) {
    for (const p of tier.prefixes) {
      data.push({
        id: p.endsWith("/") ? `${p}*` : p,
        object: "model",
        owned_by: p.split("/")[0],
        x402: { tier: slug, endpoint: tier.route.split(" ")[1], priceUsd: tier.price, maxTokens: tier.maxTokens, maxInputChars: tier.maxInputChars },
      });
    }
  }
  return { object: "list", data, note: "Prefixes ending in /* allow the whole vendor family. Pay per call via x402 (USDC on Base, Solana, Polygon, Arbitrum, Stellar) — no API key. Bare OpenAI-style names (gpt-4o-mini) are accepted and mapped." };
}
