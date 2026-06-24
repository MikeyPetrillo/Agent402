// Image generation kit — three tiers of x402-paywalled image generation
// via OpenAI GPT Image API. Quality and size are locked per tier to bound
// upstream cost. Env-gated: missing OPENAI_API_KEY → 503, not boot failure.
//
// Tiers:
//   image-gen          $0.03  — gpt-image-1-mini, low quality, 1024x1024
//   image-gen-hd       $0.10  — gpt-image-1-mini, medium quality, 1024x1024
//   image-gen-premium  $0.30  — gpt-image-2, medium quality, 1024x1024

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const TIERS = {
  "image-gen":         { model: "gpt-image-1-mini", quality: "low",    size: "1024x1024", maxPromptChars: 1000 },
  "image-gen-hd":      { model: "gpt-image-1-mini", quality: "medium", size: "1024x1024", maxPromptChars: 2000 },
  "image-gen-premium": { model: "gpt-image-2",      quality: "medium", size: "1024x1024", maxPromptChars: 4000 },
};

function validateInput(input, tierSlug) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required — describe the image you want');
  const cap = TIERS[tierSlug].maxPromptChars;
  if (prompt.length > cap) {
    throw bad(`Prompt too long (${prompt.length} chars). The ${tierSlug} tier allows up to ${cap} chars`);
  }
  return { prompt };
}

async function callOpenAI(prompt, tierSlug) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const tier = TIERS[tierSlug];
  const body = {
    model: tier.model,
    prompt,
    n: 1,
    size: tier.size,
    quality: tier.quality,
  };

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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

  const img = data.data?.[0];
  return {
    model: tier.model,
    provider: "openai",
    quality: tier.quality,
    size: tier.size,
    image: img?.b64_json ?? "",
    revised_prompt: img?.revised_prompt ?? prompt,
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { prompt } = validateInput(input, tierSlug);
    return callOpenAI(prompt, tierSlug);
  };
}

const SHARED_TAGS = ["image", "ai", "generation", "openai", "text-to-image"];

export const IMAGE_GEN_TOOLS = [
  {
    route: "POST /api/image-gen",
    name: "Image generation",
    slug: "image-gen",
    category: "ai",
    price: "$0.030",
    description:
      "Generate an image from a text prompt using GPT Image (mini, low quality, 1024x1024). No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 1000 chars.",
    tags: [...SHARED_TAGS, "gpt-image-1-mini"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 1000 chars)" },
        },
        required: ["prompt"],
      },
      output: {
        example: {
          model: "gpt-image-1-mini",
          provider: "openai",
          quality: "low",
          size: "1024x1024",
          image: "<base64-encoded PNG>",
          revised_prompt: "A single red apple on a white background",
        },
      },
    },
    handler: makeHandler("image-gen"),
  },
  {
    route: "POST /api/image-gen-hd",
    name: "Image generation (HD)",
    slug: "image-gen-hd",
    category: "ai",
    price: "$0.100",
    description:
      "Generate a higher-quality image from a text prompt using GPT Image (mini, medium quality, 1024x1024). No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 2000 chars.",
    tags: [...SHARED_TAGS, "gpt-image-1-mini", "hd"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 2000 chars)" },
        },
        required: ["prompt"],
      },
      output: {
        example: {
          model: "gpt-image-1-mini",
          provider: "openai",
          quality: "medium",
          size: "1024x1024",
          image: "<base64-encoded PNG>",
          revised_prompt: "A single red apple on a white background",
        },
      },
    },
    handler: makeHandler("image-gen-hd"),
  },
  {
    route: "POST /api/image-gen-premium",
    name: "Image generation (Premium)",
    slug: "image-gen-premium",
    category: "ai",
    price: "$0.300",
    description:
      "Generate a premium image from a text prompt using GPT Image 2 (medium quality, 1024x1024). Flagship model with best detail and coherence. No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 4000 chars.",
    tags: [...SHARED_TAGS, "gpt-image-2", "premium"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 4000 chars)" },
        },
        required: ["prompt"],
      },
      output: {
        example: {
          model: "gpt-image-2",
          provider: "openai",
          quality: "medium",
          size: "1024x1024",
          image: "<base64-encoded PNG>",
          revised_prompt: "A single red apple on a white background",
        },
      },
    },
    handler: makeHandler("image-gen-premium"),
  },
];
