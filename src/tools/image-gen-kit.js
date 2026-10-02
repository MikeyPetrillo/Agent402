// Image generation kit - three tiers of x402-paywalled image generation
// via OpenAI GPT Image API. Quality and size are locked per tier to bound
// upstream cost. Env-gated: missing OPENAI_API_KEY → 503, not boot failure.
//
// Tiers:
//   image-gen          gpt-image-2, low quality, 1024x1024
//   image-gen-hd       gpt-image-2, medium quality, 1024x1024
//   image-gen-premium  gpt-image-2, medium quality, 1536x1024 or 1024x1536
//
// All three tiers ride gpt-image-2 since 2026-08-04: OpenAI retires
// gpt-image-1-mini (the old low/hd model) on 2026-12-01. Until 2026-09-29
// premium sent hd's exact request under a higher price; it now renders the
// larger landscape or portrait frame. High quality was measured and declined:
// a render ran about two minutes, longer than a Solana or default Algorand
// credential stays settleable. A render typically takes 20 to 45 s, so each
// tier carries its own upstream timeout and callers need a client timeout of
// at least 60 s (75 s on premium).

import { redactSecrets } from "./redact.js";

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// sizes: orientation -> size; the first entry is the default. A render whose
// billed image tokens pass outputTokenBound is logged (the answer is still
// served, the work is already paid for).
export const TIERS = {
  "image-gen":         { model: "gpt-image-2", quality: "low",    sizes: { square: "1024x1024" }, maxPromptChars: 1000, timeoutMs: 60_000, outputTokenBound: 700 },
  "image-gen-hd":      { model: "gpt-image-2", quality: "medium", sizes: { square: "1024x1024" }, maxPromptChars: 2000, timeoutMs: 60_000, outputTokenBound: 2300 },
  "image-gen-premium": { model: "gpt-image-2", quality: "medium", sizes: { landscape: "1536x1024", portrait: "1024x1536", square: "1024x1024" }, maxPromptChars: 4000, timeoutMs: 75_000, outputTokenBound: 3500 },
};

function sizeFor(input, tierSlug) {
  const sizes = TIERS[tierSlug].sizes;
  const names = Object.keys(sizes);
  if (input.orientation === undefined || input.orientation === null || input.orientation === "") return sizes[names[0]];
  const o = String(input.orientation).trim().toLowerCase();
  if (!Object.hasOwn(sizes, o)) {
    throw bad(names.length === 1
      ? `"orientation" must be ${names[0]} on ${tierSlug} (it renders ${sizes[names[0]]} only); image-gen-premium offers landscape and portrait`
      : `"orientation" must be one of ${names.join(", ")}`);
  }
  return sizes[o];
}

function validateInput(input, tierSlug) {
  input = input || {};
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required - describe the image you want');
  const cap = TIERS[tierSlug].maxPromptChars;
  if (prompt.length > cap) {
    throw bad(`Prompt too long (${prompt.length} chars). The ${tierSlug} tier allows up to ${cap} chars`);
  }
  return { prompt, size: sizeFor(input, tierSlug) };
}

async function callOpenAI(prompt, size, tierSlug) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const tier = TIERS[tierSlug];
  const body = {
    model: tier.model,
    prompt,
    n: 1,
    size,
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
      signal: AbortSignal.timeout(tier.timeoutMs),
    });
  } catch (e) {
    throw bad(`OpenAI request failed: ${e.message}`, 504);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("OpenAI upstream auth failed", 502);
    if (res.status === 429) throw bad("OpenAI rate-limited - retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    // Redact the FULL body BEFORE slicing/parsing (a secret straddling the
    // 200-char cut leaves an unredactable prefix); the route binder returns
    // err.message verbatim to buyers and logs it.
    const safe = redactSecrets(text);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // Reaching here means a remaining 4xx - the REQUEST was invalid (bad
    // temperature, unknown language code, oversized input), not the upstream.
    // Surfacing it as 502 taught buyers to retry the identical bad request
    // (observed 2026-07-26: paired retries ~1s apart on temperature:100) and
    // polluted upstream-failure telemetry. A self-explaining 400 teaches the
    // agent to fix the request; settlement is cancelled either way.
    throw bad(`OpenAI rejected the request: ${msg}`, 400);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("OpenAI returned non-JSON", 502); }

  const billed = Number(data.usage?.output_tokens);
  if (Number.isFinite(billed) && billed > tier.outputTokenBound) {
    console.warn(`[image-gen] ${tierSlug} render billed above its bound (${billed} > ${tier.outputTokenBound} output tokens)`);
  }
  const img = data.data?.[0];
  return {
    model: tier.model,
    provider: "openai",
    quality: tier.quality,
    size,
    image: img?.b64_json ?? "",
    revised_prompt: img?.revised_prompt ?? prompt,
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { prompt, size } = validateInput(input, tierSlug);
    return callOpenAI(prompt, size, tierSlug);
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
      "Generate an image from a text prompt using GPT Image 2 (low quality, 1024x1024). No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 1000 chars. A render takes 10 to 30 s; use a client timeout of at least 60 s.",
    tags: [...SHARED_TAGS, "gpt-image-2"],
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
          model: "gpt-image-2",
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
      "Generate a higher-quality image from a text prompt using GPT Image 2 (medium quality, 1024x1024). No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 2000 chars. A render takes 20 to 45 s; use a client timeout of at least 60 s.",
    tags: [...SHARED_TAGS, "gpt-image-2", "hd"],
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
          model: "gpt-image-2",
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
    price: "$0.150",
    description:
      "Generate a larger image from a text prompt using GPT Image 2 (medium quality): 1536x1024 landscape by default, 1024x1536 portrait or 1024x1024 square via orientation. No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 4000 chars. A render takes 25 to 50 s; use a client timeout of at least 75 s.",
    tags: [...SHARED_TAGS, "gpt-image-2", "premium"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 4000 chars)" },
          orientation: { type: "string", enum: ["landscape", "portrait", "square"], description: "landscape 1536x1024 (default), portrait 1024x1536, square 1024x1024" },
        },
        required: ["prompt"],
      },
      output: {
        example: {
          model: "gpt-image-2",
          provider: "openai",
          quality: "medium",
          size: "1536x1024",
          image: "<base64-encoded PNG>",
          revised_prompt: "A single red apple on a white background",
        },
      },
    },
    handler: makeHandler("image-gen-premium"),
  },
];
