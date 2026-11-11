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
//
// Moderation: every tier asks the images API for its "low" moderation level
// (less restrictive filtering; the provider's usage policies still apply)
// unless the caller sends `moderation: "auto"`, the provider's stricter
// default. A refusal by the provider's content check is a 400 (never charged)
// and is never sent to another model or provider. Should the API answer 400
// naming the `moderation` parameter (a model that does not take it), the same
// request goes once more without the field, and that fallback is counted.

import { redactSecrets } from "./redact.js";
import { upstreamCosts } from "../upstream-costs.js";
import { capturePostHogGatewayUsage } from "../posthog.js";
import { ourKeyRefusedError } from "../upstream-deadline.js";

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

export const MODERATION_LEVELS = ["low", "auto"];
export const DEFAULT_MODERATION = "low";

function moderationFor(input) {
  const v = input.moderation;
  if (v === undefined || v === null || v === "") return DEFAULT_MODERATION;
  const m = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!MODERATION_LEVELS.includes(m)) {
    throw bad(`"moderation" must be one of ${MODERATION_LEVELS.join(", ")} (low is the default; auto applies the provider's stricter filtering)`);
  }
  return m;
}

// Per-process counts since boot, for /__operator/tool-failures.json: renders
// by the moderation level actually sent, content-check refusals by that level,
// and how often a request went again without the parameter. Counts only: no
// prompt, payer or upstream text is kept.
const moderationStats = { calls: { low: 0, auto: 0 }, refusals: { low: 0, auto: 0 }, unknownParamFallbacks: 0 };
let fallbackLogged = false;
// A model that refused the parameter is remembered in this process for
// MODERATION_RECHECK_MS: its next requests go without it (one request, not
// two). After that the parameter is sent again, so a model that starts to
// take it is read again, and the fallback above still covers a refusal.
export const MODERATION_RECHECK_MS = 6 * 3_600_000;
const noModerationParam = new Map(); // model -> until (ms)
const skipsModeration = (model, now = Date.now()) => {
  const until = noModerationParam.get(model);
  if (until === undefined) return false;
  if (now < until) return true;
  noModerationParam.delete(model);
  return false;
};
export function _resetImageModerationMemoForTest() { noModerationParam.clear(); fallbackLogged = false; }
export function imageModerationStats() {
  return { sinceBoot: { calls: { ...moderationStats.calls }, refusals: { ...moderationStats.refusals }, unknownParamFallbacks: moderationStats.unknownParamFallbacks, modelsWithoutParam: noModerationParam.size } };
}

function validateInput(input, tierSlug) {
  input = input || {};
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required - describe the image you want');
  const cap = TIERS[tierSlug].maxPromptChars;
  if (prompt.length > cap) {
    throw bad(`Prompt too long (${prompt.length} chars). The ${tierSlug} tier allows up to ${cap} chars`);
  }
  return { prompt, size: sizeFor(input, tierSlug), moderation: moderationFor(input) };
}

/** A 400 from the images API that is about the `moderation` parameter itself
 *  (unknown, unsupported, or a value the model does not take). The OpenAI
 *  error object names the offending field in `error.param`; the message names
 *  it in quotes ("Unknown parameter: 'moderation'."). */
export function isModerationParamError(status, error) {
  if (status !== 400 || !error || typeof error !== "object") return false;
  if (error.code === "moderation_blocked") return false;
  if (error.param === "moderation") return true;
  const code = String(error.code || "");
  return ["unknown_parameter", "unsupported_parameter", "invalid_value", "unsupported_value"].includes(code)
    && typeof error.message === "string" && error.message.includes("'moderation'");
}

/** The provider's content check refused the prompt: code moderation_blocked,
 *  or (older answers) a message naming the safety system. */
export function isSafetyRefusal(error, message) {
  if (error?.code === "moderation_blocked") return true;
  return /safety system/i.test(String(message || "").slice(0, 400));
}

// The categories the provider lists on a refusal ("safety_violations=[violence]"),
// so a caller knows what to rephrase. Bounded input, no backtracking.
function refusalCategories(message) {
  const m = /safety_violations=\[([a-z_, -]{1,120})\]/i.exec(String(message || "").slice(0, 1000));
  return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean).join(", ") : "";
}

async function postImages(key, body, timeoutMs) {
  try {
    return await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw bad(`OpenAI request failed: ${e.message}`, 504);
  }
}

function parseError(text) {
  // Redact the FULL body BEFORE slicing/parsing (a secret straddling the
  // 200-char cut leaves an unredactable prefix); the route binder returns
  // err.message verbatim to buyers and logs it.
  const safe = redactSecrets(text);
  let msg = safe.slice(0, 200);
  let error = null;
  try { const j = JSON.parse(safe); if (j?.error && typeof j.error === "object") error = j.error; msg = (typeof error?.message === "string" && error.message) || msg; } catch {}
  return { msg, error, code: error?.code ?? null };
}

async function callOpenAI(prompt, size, tierSlug, moderation = DEFAULT_MODERATION) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const tier = TIERS[tierSlug];
  const body = {
    model: tier.model,
    prompt,
    n: 1,
    size,
    quality: tier.quality,
    moderation,
  };
  // The level the request actually ran under: the provider's default ("auto")
  // once the parameter has been dropped.
  let sentLevel = moderation;
  let fellBack = false;
  if (skipsModeration(tier.model)) { delete body.moderation; sentLevel = "auto"; fellBack = true; }

  let res = await postImages(key, body, tier.timeoutMs);
  let text = await res.text();
  if (res.status === 400 && "moderation" in body) {
    const first = parseError(text);
    if (isModerationParamError(res.status, first.error)) {
      // Once, never in a loop: the second answer is final whatever it is.
      moderationStats.unknownParamFallbacks++;
      if (!fallbackLogged) {
        fallbackLogged = true;
        console.warn(`[image-gen] ${tier.model} refused the moderation parameter; serving without it, and sending it again to this model after ${MODERATION_RECHECK_MS / 3_600_000} h (counted on the operator failure view)`);
      }
      noModerationParam.set(tier.model, Date.now() + MODERATION_RECHECK_MS);
      delete body.moderation;
      sentLevel = "auto";
      fellBack = true;
      res = await postImages(key, body, tier.timeoutMs);
      text = await res.text();
    }
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw ourKeyRefusedError("Image generation", res.status);
    if (res.status === 429) throw bad("OpenAI rate-limited - retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    const { msg, error, code } = parseError(text);
    // An account-level billing or account state is the upstream's, not the request's.
    if (["billing_hard_limit_reached", "billing_not_active", "account_deactivated"].includes(code)) throw bad("OpenAI upstream unavailable", 502);
    // The model's own content check refused the prompt. It stays a 400 (not
    // charged) and is never handed to another model or provider.
    if (isSafetyRefusal(error, msg)) {
      moderationStats.refusals[sentLevel]++;
      const cats = refusalCategories(msg);
      throw bad("The model's content check refused this prompt. This 400 is not charged on x402; rephrase the prompt and try again."
        + (cats ? ` Flagged: ${cats}.` : "")
        + (moderation === "auto" && !fellBack ? ' This call used moderation "auto"; "low", the default, filters less strictly.' : ""), 400);
    }
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
  if (typeof img?.b64_json !== "string" || !img.b64_json) throw bad("OpenAI returned no image - retry", 502);
  recordImageSpend(tierSlug, data.usage);
  moderationStats.calls[sentLevel]++;
  return {
    model: tier.model,
    provider: "openai",
    quality: tier.quality,
    size,
    image: img.b64_json,
    revised_prompt: img?.revised_prompt ?? prompt,
  };
}

// The list price of a tier, read from its own tool def so it is never typed twice.
const tierPriceUsd = (slug) => { const t = IMAGE_GEN_TOOLS.find((x) => x.slug === slug); return t ? Number(String(t.price).replace("$", "")) || 0 : 0; };

/** The image API returns token counts and never a cost: text input tokens at
 *  the model's prompt rate and image output tokens at its completion rate,
 *  both from the model's OWN row in the private table (never a chat row's
 *  fallback, which prices image tokens wrong), into the same meter and margin
 *  event as the /v1 tiers. No row, no figure. */
function recordImageSpend(tierSlug, usage) {
  try {
    const row = upstreamCosts().openai?.[TIERS[tierSlug].model];
    const inTok = Number(usage?.input_tokens) || 0, outTok = Number(usage?.output_tokens) || 0;
    const upstreamUsd = row && usage ? Math.round(((inTok * row.prompt + outTok * row.completion) / 1e6) * 1e6) / 1e6 : null;
    capturePostHogGatewayUsage({ tier: tierSlug, model: TIERS[tierSlug].model, priceUsd: tierPriceUsd(tierSlug), upstreamUsd, promptTokens: inTok, completionTokens: outTok, source: "image-gen" });
  } catch { /* telemetry must never fail a served response */ }
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { prompt, size, moderation } = validateInput(input, tierSlug);
    return callOpenAI(prompt, size, tierSlug, moderation);
  };
}

const SHARED_TAGS = ["image", "ai", "generation", "openai", "text-to-image"];

const MODERATION_PROP = { type: "string", enum: MODERATION_LEVELS, description: 'Content filtering level: "low" (default, less restrictive) or "auto" (stricter). The model provider\'s usage policies apply at either level; a prompt its content check refuses answers 400 and is not charged on x402.' };
const MODERATION_COPY = ' Content filtering runs at the less restrictive "low" level by default (send moderation "auto" for stricter filtering); the model provider\'s usage policies still apply, and a refused prompt answers 400, not charged on x402.';

export const IMAGE_GEN_TOOLS = [
  {
    route: "POST /api/image-gen",
    name: "Image generation",
    slug: "image-gen",
    category: "ai",
    price: "$0.030",
    description:
      "Generate an image from a text prompt using GPT Image 2 (low quality, 1024x1024). No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 1000 chars. A render takes 10 to 30 s; use a client timeout of at least 60 s." + MODERATION_COPY,
    tags: [...SHARED_TAGS, "gpt-image-2"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 1000 chars)" },
          moderation: MODERATION_PROP,
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
      "Generate a higher-quality image from a text prompt using GPT Image 2 (medium quality, 1024x1024). No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 2000 chars. A render takes 20 to 45 s; use a client timeout of at least 60 s." + MODERATION_COPY,
    tags: [...SHARED_TAGS, "gpt-image-2", "hd"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 2000 chars)" },
          moderation: MODERATION_PROP,
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
      "Generate a larger image from a text prompt using GPT Image 2 (medium quality): 1536x1024 landscape by default, 1024x1536 portrait or 1024x1024 square via orientation. No API key needed; pay per call via x402. Returns base64 PNG. Prompt capped at 4000 chars. A render takes 25 to 50 s; use a client timeout of at least 75 s." + MODERATION_COPY,
    tags: [...SHARED_TAGS, "gpt-image-2", "premium"],
    discovery: {
      bodyType: "json",
      input: { prompt: "A single red apple on a white background" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the desired image (max 4000 chars)" },
          moderation: MODERATION_PROP,
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
