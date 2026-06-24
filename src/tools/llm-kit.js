// LLM proxy kit — three tiers of x402-paywalled LLM inference. Accepts
// OpenAI chat/completions format universally; Anthropic models are
// translated server-side. Env-gated: missing keys → 503, not boot failure.
//
// Tiers:
//   llm          $0.01  — gpt-4o-mini, claude-haiku
//   llm-pro      $0.05  — gpt-4o, gpt-4.1, claude-sonnet
//   llm-premium  $0.25  — o3, o3-mini, claude-opus

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();
const ANTHROPIC_KEY = () => (process.env.ANTHROPIC_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const MAX_TOKENS_CAP = 4096;

// Tier → allowed model prefixes. Anthropic models use prefix match so
// versioned IDs like claude-sonnet-4-20250514 resolve correctly.
const TIERS = {
  llm:         { prefixes: ["gpt-4o-mini", "claude-haiku-4-5"] },
  "llm-pro":   { prefixes: ["gpt-4o", "gpt-4.1", "claude-sonnet-4"] },
  "llm-premium": { prefixes: ["o3", "o3-mini", "claude-opus-4"] },
};

function isAllowed(model, tierSlug) {
  const tier = TIERS[tierSlug];
  if (!tier) return false;
  return tier.prefixes.some((p) => model === p || model.startsWith(p + "-"));
}

function isAnthropic(model) {
  return model.startsWith("claude-");
}

function validateInput(input, tierSlug) {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) throw bad('"model" is required (e.g. "gpt-4o-mini", "claude-sonnet-4-20250514")');
  if (!isAllowed(model, tierSlug)) {
    throw bad(`Model "${model}" is not allowed in the ${tierSlug} tier. Allowed prefixes: ${TIERS[tierSlug].prefixes.join(", ")}`);
  }

  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw bad('"messages" must be a non-empty array of {role, content} objects');
  }
  for (const m of messages) {
    if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
      throw bad('Each message must have "role" (string) and "content" (string)');
    }
  }

  let maxTokens = input.max_tokens != null ? parseInt(input.max_tokens, 10) : 1024;
  if (Number.isNaN(maxTokens) || maxTokens < 1) maxTokens = 1024;
  if (maxTokens > MAX_TOKENS_CAP) maxTokens = MAX_TOKENS_CAP;

  const opts = {};
  if (input.temperature != null) opts.temperature = Number(input.temperature);
  if (input.top_p != null) opts.top_p = Number(input.top_p);
  if (input.stop != null) opts.stop = input.stop;

  return { model, messages, maxTokens, opts };
}

async function callOpenAI(model, messages, maxTokens, opts) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const body = {
    model,
    messages,
    max_completion_tokens: maxTokens,
    ...opts,
  };

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

async function callAnthropic(model, messages, maxTokens, opts) {
  const key = ANTHROPIC_KEY();
  if (!key) throw bad("Anthropic not configured", 503);

  // Extract system messages → Anthropic's top-level system param
  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");
  const system = systemMsgs.length > 0
    ? systemMsgs.map((m) => m.content).join("\n\n")
    : undefined;

  const body = {
    model,
    max_tokens: maxTokens,
    messages: nonSystemMsgs,
    ...(system ? { system } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.top_p != null ? { top_p: opts.top_p } : {}),
    ...(opts.stop != null ? { stop_sequences: Array.isArray(opts.stop) ? opts.stop : [opts.stop] } : {}),
  };

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw bad(`Anthropic request failed: ${e.message}`, 504);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("Anthropic upstream auth failed", 502);
    if (res.status === 429) throw bad("Anthropic rate-limited — retry shortly", 503);
    if (res.status >= 500) throw bad(`Anthropic upstream error (HTTP ${res.status})`, 502);
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message || msg; } catch {}
    throw bad(`Anthropic error: ${msg}`, 502);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("Anthropic returned non-JSON", 502); }

  // Translate Anthropic → OpenAI response shape
  const content = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const stopMap = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop" };
  const finishReason = stopMap[data.stop_reason] ?? "stop";

  return {
    model: data.model || model,
    provider: "anthropic",
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
    choices: [{
      message: { role: "assistant", content },
      finish_reason: finishReason,
    }],
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { model, messages, maxTokens, opts } = validateInput(input, tierSlug);
    if (isAnthropic(model)) {
      return callAnthropic(model, messages, maxTokens, opts);
    }
    return callOpenAI(model, messages, maxTokens, opts);
  };
}

const SHARED_TAGS = ["llm", "ai", "inference", "chat", "proxy", "openai", "anthropic"];

export const LLM_TOOLS = [
  {
    route: "POST /api/llm",
    name: "LLM inference",
    slug: "llm",
    category: "ai",
    price: "$0.010",
    description:
      "LLM inference proxy — send an OpenAI-format chat/completions request and get a response from GPT-4o-mini or Claude Haiku. No API key needed; pay per call via x402. Supports temperature, top_p, stop, and max_tokens (capped at 4096).",
    tags: [...SHARED_TAGS, "gpt-4o-mini", "claude-haiku"],
    discovery: {
      bodyType: "json",
      input: { model: "gpt-4o-mini", messages: [{ role: "user", content: "Say hello in one sentence." }], max_tokens: 64 },
      inputSchema: {
        properties: {
          model: { type: "string", description: "Model ID — gpt-4o-mini or claude-haiku-4-5-*" },
          messages: { type: "array", description: "Array of {role, content} message objects" },
          max_tokens: { type: "number", description: "Max completion tokens (default 1024, cap 4096)" },
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
    price: "$0.050",
    description:
      "LLM inference proxy (Pro tier) — GPT-4o, GPT-4.1, or Claude Sonnet 4. Same OpenAI-format interface as /api/llm but with more capable models. No API key needed; pay per call via x402.",
    tags: [...SHARED_TAGS, "gpt-4o", "gpt-4.1", "claude-sonnet"],
    discovery: {
      bodyType: "json",
      input: { model: "gpt-4o", messages: [{ role: "user", content: "Say hello in one sentence." }], max_tokens: 64 },
      inputSchema: {
        properties: {
          model: { type: "string", description: "Model ID — gpt-4o, gpt-4.1, or claude-sonnet-4-*" },
          messages: { type: "array", description: "Array of {role, content} message objects" },
          max_tokens: { type: "number", description: "Max completion tokens (default 1024, cap 4096)" },
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
    price: "$0.250",
    description:
      "LLM inference proxy (Premium tier) — o3, o3-mini, or Claude Opus 4. Frontier reasoning models via the same OpenAI-format interface. No API key needed; pay per call via x402.",
    tags: [...SHARED_TAGS, "o3", "o3-mini", "claude-opus"],
    discovery: {
      bodyType: "json",
      input: { model: "o3-mini", messages: [{ role: "user", content: "Say hello in one sentence." }], max_tokens: 64 },
      inputSchema: {
        properties: {
          model: { type: "string", description: "Model ID — o3, o3-mini, or claude-opus-4-*" },
          messages: { type: "array", description: "Array of {role, content} message objects" },
          max_tokens: { type: "number", description: "Max completion tokens (default 1024, cap 4096)" },
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
