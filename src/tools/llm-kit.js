// LLM proxy kit — three tiers of x402-paywalled LLM inference via OpenAI.
// Callers send the OpenAI chat/completions format and get a response back.
// Env-gated: missing API key → 503 at call time, not boot failure.
//
// Capabilities:
//   - Vision: image_url content blocks (max 2 images, low-detail forced on basic)
//   - Structured output: response_format (json_object / json_schema)
//
// Tiers:
//   llm          $0.01  — gpt-4o-mini        (16k input, 4096 output)
//   llm-pro      $0.10  — gpt-4o, gpt-4.1    (16k input, 2048 output)
//   llm-premium  $0.50  — o3, o3-mini         (32k input, 2048 output)

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Tier → allowed model prefixes, input char budget, and output token cap.
// Caps are set so worst-case upstream cost stays well below the x402 price.
const TIERS = {
  llm:           { prefixes: ["gpt-4o-mini"],       maxInputChars: 16_000, maxTokens: 4096 },
  "llm-pro":     { prefixes: ["gpt-4o", "gpt-4.1"], maxInputChars: 16_000, maxTokens: 2048 },
  "llm-premium": { prefixes: ["o3", "o3-mini"],     maxInputChars: 32_000, maxTokens: 2048 },
};

function isAllowed(model, tierSlug) {
  const tier = TIERS[tierSlug];
  if (!tier) return false;
  return tier.prefixes.some((p) => model === p || model.startsWith(p + "-"));
}

const MAX_MESSAGES = 50;
const MAX_IMAGES = 2;
const MAX_IMAGE_URL_LEN = 2048;
const MAX_SCHEMA_CHARS = 2000;
const ALLOWED_DETAILS = new Set(["low", "high", "auto"]);
const SCHEMA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Normalise a message's content to the OpenAI array-of-blocks format.
// Plain string → [{ type: "text", text }]. Already an array → validated.
function normaliseContent(content, role, tierSlug) {
  if (typeof content === "string") return { blocks: [{ type: "text", text: content }], chars: content.length, images: 0 };
  if (!Array.isArray(content)) throw bad('"content" must be a string or an array of content blocks');

  let chars = 0;
  let images = 0;
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") throw bad("Each content block must be an object with a type field");
    if (block.type === "text") {
      if (typeof block.text !== "string") throw bad('Text content block must have "text" (string)');
      chars += block.text.length;
      out.push({ type: "text", text: block.text });
    } else if (block.type === "image_url") {
      if (role !== "user") throw bad("image_url blocks are only allowed in user messages");
      const iu = block.image_url;
      if (!iu || typeof iu !== "object") throw bad('image_url block must have an "image_url" object');
      const url = typeof iu.url === "string" ? iu.url.trim() : "";
      if (!url) throw bad("image_url.url is required");
      if (url.length > MAX_IMAGE_URL_LEN) throw bad(`image_url.url too long (${url.length} chars, max ${MAX_IMAGE_URL_LEN})`);
      if (!/^https?:\/\//i.test(url)) throw bad("image_url.url must be an HTTP(S) URL (no data: URIs)");
      let detail = typeof iu.detail === "string" ? iu.detail.trim().toLowerCase() : undefined;
      if (detail && !ALLOWED_DETAILS.has(detail)) throw bad(`image_url.detail must be one of: low, high, auto`);
      // Force low detail on the basic tier to cap image token cost.
      if (tierSlug === "llm") detail = "low";
      if (!detail) detail = tierSlug === "llm" ? "low" : "auto";
      images++;
      out.push({ type: "image_url", image_url: { url, detail } });
    } else {
      throw bad(`Unknown content block type "${block.type}". Allowed: text, image_url`);
    }
  }
  if (!out.some((b) => b.type === "text")) throw bad("At least one text content block is required");
  return { blocks: out, chars, images };
}

function validateResponseFormat(rf) {
  if (rf == null) return undefined;
  if (typeof rf !== "object") throw bad('"response_format" must be an object');
  const type = rf.type;
  if (type === "text" || type === undefined) return undefined; // default, no-op
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const js = rf.json_schema;
    if (!js || typeof js !== "object") throw bad('response_format.json_schema must be an object');
    if (typeof js.name !== "string" || !SCHEMA_NAME_RE.test(js.name)) {
      throw bad('json_schema.name must be 1-64 alphanumeric/underscore/dash chars');
    }
    const serialised = JSON.stringify(js);
    if (serialised.length > MAX_SCHEMA_CHARS) {
      throw bad(`json_schema too large (${serialised.length} chars, max ${MAX_SCHEMA_CHARS})`);
    }
    return { type: "json_schema", json_schema: js };
  }
  throw bad(`Unknown response_format type "${type}". Allowed: text, json_object, json_schema`);
}

function validateInput(input, tierSlug) {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) throw bad('"model" is required (e.g. "gpt-4o-mini")');
  if (!isAllowed(model, tierSlug)) {
    throw bad(`Model "${model}" is not allowed in the ${tierSlug} tier. Allowed prefixes: ${TIERS[tierSlug].prefixes.join(", ")}`);
  }

  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw bad('"messages" must be a non-empty array of {role, content} objects');
  }
  if (messages.length > MAX_MESSAGES) {
    throw bad(`Too many messages (${messages.length}). Maximum is ${MAX_MESSAGES}`);
  }

  let totalChars = 0;
  let totalImages = 0;
  const normMessages = [];
  for (const m of messages) {
    if (!m || typeof m.role !== "string") throw bad('Each message must have "role" (string)');
    if (m.content == null) throw bad('Each message must have "content"');
    const { blocks, chars, images } = normaliseContent(m.content, m.role, tierSlug);
    totalChars += chars;
    totalImages += images;
    // Send as string if text-only (simpler, backward compatible with all models).
    const content = blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
    normMessages.push({ role: m.role, content });
  }

  const charCap = TIERS[tierSlug].maxInputChars;
  if (totalChars > charCap) {
    throw bad(`Input too large (${totalChars} chars). The ${tierSlug} tier allows up to ${charCap} chars`);
  }
  if (totalImages > MAX_IMAGES) {
    throw bad(`Too many images (${totalImages}). Maximum is ${MAX_IMAGES} per request`);
  }

  const tokenCap = TIERS[tierSlug].maxTokens;
  let maxTokens = input.max_tokens != null ? parseInt(input.max_tokens, 10) : 1024;
  if (Number.isNaN(maxTokens) || maxTokens < 1) maxTokens = 1024;
  if (maxTokens > tokenCap) maxTokens = tokenCap;

  const responseFormat = validateResponseFormat(input.response_format);

  const opts = {};
  if (input.temperature != null) opts.temperature = Number(input.temperature);
  if (input.top_p != null) opts.top_p = Number(input.top_p);
  if (input.stop != null) opts.stop = input.stop;

  return { model, messages: normMessages, maxTokens, responseFormat, opts };
}

async function callOpenAI(model, messages, maxTokens, responseFormat, opts) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const body = {
    model,
    messages,
    max_completion_tokens: maxTokens,
    ...opts,
  };
  if (responseFormat) body.response_format = responseFormat;

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw bad(`OpenAI request failed: ${e.message}`, 504);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("OpenAI upstream auth failed", 502);
    if (res.status === 429) throw bad("OpenAI rate-limited — retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message || msg; } catch {}
    throw bad(`OpenAI error: ${msg}`, 502);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("OpenAI returned non-JSON", 502); }

  const choice = data.choices?.[0];
  return {
    model: data.model || model,
    provider: "openai",
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
    choices: [{
      message: { role: "assistant", content: choice?.message?.content ?? "" },
      finish_reason: choice?.finish_reason ?? "stop",
    }],
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { model, messages, maxTokens, responseFormat, opts } = validateInput(input, tierSlug);
    return callOpenAI(model, messages, maxTokens, responseFormat, opts);
  };
}

const SHARED_TAGS = ["llm", "ai", "inference", "chat", "proxy", "openai"];

export const LLM_TOOLS = [
  {
    route: "POST /api/llm",
    name: "LLM inference",
    slug: "llm",
    category: "ai",
    price: "$0.010",
    description:
      "LLM inference proxy — send an OpenAI-format chat/completions request and get a response from GPT-4o-mini. Supports vision (up to 2 image URLs, low detail) and structured output (response_format: json_object or json_schema). No API key needed; pay per call via x402. Input capped at 16k chars, output at 4096 tokens.",
    tags: [...SHARED_TAGS, "gpt-4o-mini", "vision", "json-mode"],
    discovery: {
      bodyType: "json",
      input: { model: "gpt-4o-mini", messages: [{ role: "user", content: "Say hello in one sentence." }], max_tokens: 64 },
      inputSchema: {
        properties: {
          model: { type: "string", description: "Model ID — gpt-4o-mini" },
          messages: { type: "array", description: "Array of {role, content} objects. content can be a string or array of {type:'text',text} and {type:'image_url',image_url:{url,detail}} blocks" },
          max_tokens: { type: "number", description: "Max output tokens (default 1024, cap 4096)" },
          response_format: { type: "object", description: 'Optional: {type:"json_object"} or {type:"json_schema",json_schema:{name,schema}}' },
          temperature: { type: "number", description: "Sampling temperature (0-2)" },
          top_p: { type: "number", description: "Nucleus sampling (0-1)" },
          stop: { type: "string", description: "Stop sequence(s)" },
        },
        required: ["model", "messages"],
      },
      output: {
        example: {
          model: "gpt-4o-mini",
          provider: "openai",
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          choices: [{ message: { role: "assistant", content: "Hello! How can I help you today?" }, finish_reason: "stop" }],
        },
      },
    },
    handler: makeHandler("llm"),
  },
  {
    route: "POST /api/llm-pro",
    name: "LLM inference (Pro)",
    slug: "llm-pro",
    category: "ai",
    price: "$0.100",
    description:
      "LLM inference proxy (Pro tier) — GPT-4o or GPT-4.1. Supports vision (up to 2 image URLs) and structured output (response_format: json_object or json_schema). No API key needed; pay per call via x402. Input capped at 16k chars, output at 2048 tokens.",
    tags: [...SHARED_TAGS, "gpt-4o", "gpt-4.1", "vision", "json-mode"],
    discovery: {
      bodyType: "json",
      input: { model: "gpt-4o", messages: [{ role: "user", content: "Say hello in one sentence." }], max_tokens: 64 },
      inputSchema: {
        properties: {
          model: { type: "string", description: "Model ID — gpt-4o or gpt-4.1" },
          messages: { type: "array", description: "Array of {role, content} objects. content can be a string or array of {type:'text',text} and {type:'image_url',image_url:{url,detail}} blocks" },
          max_tokens: { type: "number", description: "Max output tokens (default 1024, cap 2048)" },
          response_format: { type: "object", description: 'Optional: {type:"json_object"} or {type:"json_schema",json_schema:{name,schema}}' },
          temperature: { type: "number", description: "Sampling temperature (0-2)" },
          top_p: { type: "number", description: "Nucleus sampling (0-1)" },
          stop: { type: "string", description: "Stop sequence(s)" },
        },
        required: ["model", "messages"],
      },
      output: {
        example: {
          model: "gpt-4o",
          provider: "openai",
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          choices: [{ message: { role: "assistant", content: "Hello! How can I help you today?" }, finish_reason: "stop" }],
        },
      },
    },
    handler: makeHandler("llm-pro"),
  },
  {
    route: "POST /api/llm-premium",
    name: "LLM inference (Premium)",
    slug: "llm-premium",
    category: "ai",
    price: "$0.500",
    description:
      "LLM inference proxy (Premium tier) — o3 or o3-mini reasoning models. Supports vision (up to 2 image URLs) and structured output (response_format: json_object or json_schema). No API key needed; pay per call via x402. Input capped at 32k chars, output at 2048 tokens.",
    tags: [...SHARED_TAGS, "o3", "o3-mini", "vision", "json-mode"],
    discovery: {
      bodyType: "json",
      input: { model: "o3-mini", messages: [{ role: "user", content: "Say hello in one sentence." }], max_tokens: 64 },
      inputSchema: {
        properties: {
          model: { type: "string", description: "Model ID — o3 or o3-mini" },
          messages: { type: "array", description: "Array of {role, content} objects. content can be a string or array of {type:'text',text} and {type:'image_url',image_url:{url,detail}} blocks" },
          max_tokens: { type: "number", description: "Max output tokens (default 1024, cap 2048)" },
          response_format: { type: "object", description: 'Optional: {type:"json_object"} or {type:"json_schema",json_schema:{name,schema}}' },
          temperature: { type: "number", description: "Sampling temperature (0-2)" },
          top_p: { type: "number", description: "Nucleus sampling (0-1)" },
          stop: { type: "string", description: "Stop sequence(s)" },
        },
        required: ["model", "messages"],
      },
      output: {
        example: {
          model: "o3-mini",
          provider: "openai",
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          choices: [{ message: { role: "assistant", content: "Hello! How can I help you today?" }, finish_reason: "stop" }],
        },
      },
    },
    handler: makeHandler("llm-premium"),
  },
];
