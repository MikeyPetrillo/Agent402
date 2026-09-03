// Budget image tiers + a bounded video tier over OpenRouter's DEDICATED media
// APIs (`POST /api/v1/images`, `POST /api/v1/videos`), not the chat wire the
// $0.08 `/v1/images/generations` route rides.
//
// Why a second kit: the chat wire only reaches the Gemini/GPT image models
// that are token-priced per image (~$0.02-$0.04 per picture, measured), while
// the dedicated Image API lists 40+ models with FLAT per-image / per-megapixel
// prices and ALL-OR-NOTHING billing (a failed or cancelled generation is a
// 502 and is not billed - their docs, "Billing and Cancellation"). Flat prices
// make the worst-case upstream cost a constant per link, so the margin bound
// (worst case <= 70% of the tier price, same MARGIN as the chat tiers) holds
// with no token math. Every knob that multiplies cost is server-owned: n is
// locked to 1, output size/quality are locked to the provider default (1024 x
// 1024 measured on every link), reference images (image-to-image, billed
// extra) are refused, and each link is pinned to the provider whose listed
// price the bound was computed from (`provider.only`).
//
// Measured live 2026-08-22 (one call each, `usage.cost` as OpenRouter bills):
//   flux.2-klein-4b        $0.0140   2.0 s  jpeg 1024x1024   ($0.014/megapixel)
//   gpt-image-1-mini med.  $0.0085  14.1 s  png  1024x1024   ($8/M image tokens, 1056 tok)
//   gpt-image-1-mini low   $0.0022  30.0 s  png  1024x1024   (272 tok)
//   flux.2-pro             $0.0300   8.7 s  jpeg 1024x1024   ($0.03/megapixel)
//   qwen-image-3           $0.0300  65.7 s  png  2048x2048   (flat, 1K and 2K both $0.03)
//   riverflow-v2.5-fast    $0.0185  22.0 s  webp             (flat $0.019)
//   veo-3.1-lite 4s 720p   $0.1200  40 s    mp4, no audio    ($0.03 per second, listed SKU)
//
// Repricing guard: the Image API has no documented `max_price`, so a silent
// upstream reprice cannot be refused per request the way the chat tiers do.
// Instead each link carries the listed price its bound was computed from and
// the handler re-reads the model's live endpoint listing (1h cache, fail-open
// on a listing outage, loud) and SKIPS a link whose listed output price rose
// above it - the chain walks to the next link, and a chain that is repriced
// end-to-end answers 503 (not charged). The post-call `usage.cost` is also
// compared to the bound and logged loudly when it is over.
//
// Video (`/v1/videos/generations`): the Video API is asynchronous (submit ->
// poll -> download); the handler does all three inside the request so the
// buyer gets bytes back on the same paid call. Duration, resolution and audio
// are LOCKED (4 s, 720p, no audio = $0.12 on the listed per-second SKU) so the
// price is a constant; aspect ratio (16:9 / 9:16) is free to choose. Measured
// 40 s end to end; the handler waits up to VIDEOS_MAX_WAIT_MS and answers 504
// past it (not charged on our side; the upstream job may still complete and
// bill us - bounded at one clip, the same accepted class as a flex timeout on
// the chat tiers). Content is fetched with our key (the unsigned URLs 401
// without it - measured) and returned inline as base64, never as a URL that
// would expose our job ids.
import { bad, fetchOpenRouter, throwUpstreamError, assertUpstreamBody, MARGIN, OPENROUTER_ATTRIBUTION } from "./llm-gateway-kit.js";
import { redactSecrets } from "./redact.js";

export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
export const OPENROUTER_VIDEOS_URL = "https://openrouter.ai/api/v1/videos";
const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();

export const IMAGES_FAST_PATH = "/v1/images/fast";
export const IMAGES_PRO_PATH = "/v1/images/pro";
export const VIDEOS_PATH = "/v1/videos/generations";
export const IMAGE_MAX_PROMPT_CHARS = 4_000;

// One link = one model on one provider at a known listed price. `worstCaseUsd`
// is the bound the tier price was set against (listed price x the locked
// output, plus the prompt bill where the provider meters text); `listed` is
// the live-listing check: the endpoint's `output_image` pricing line for that
// unit (and variant, when priced by tier) must not exceed `maxCostUsd`.
export const IMAGE_TIERS = {
  "v1-images-fast": {
    path: IMAGES_FAST_PATH,
    price: 0.02,
    chain: [
      // $0.014/megapixel, locked 1024x1024 billed as 1 MP (measured $0.014).
      { model: "black-forest-labs/flux.2-klein-4b", provider: "black-forest-labs", params: {}, worstCaseUsd: 0.014,
        listed: { unit: "megapixel", maxCostUsd: 0.014 } },
      // $8/M image tokens x ~1568 (medium, measured) + $2.5/M text prompt tokens.
      // gpt-5-image-mini replaced gpt-image-1-mini here 2026-09-02, ahead of the
      // latter's 2026-12-01 retirement: identical image_output pricing
      // ($0.000008/token) and prompt pricing on OpenRouter's endpoint listing,
      // read live that day; gpt-image-2 ($0.00003/token, ~$0.032 at medium) does
      // not fit under this tier's bound. Verified LIVE in the IMAGE catalog
      // (/api/v1/images/models); absent from the chat-model list, which is not
      // the same thing.
      { model: "openai/gpt-5-image-mini", provider: "openai", params: { quality: "medium" }, worstCaseUsd: 0.013, // measured live 2026-09-02: 1568 image tokens at medium = $0.0126
        listed: { unit: "token", maxCostUsd: 0.000008 } },
    ],
  },
  "v1-images-pro": {
    path: IMAGES_PRO_PATH,
    price: 0.05,
    chain: [
      // $0.03/megapixel, locked 1024x1024 (measured $0.03).
      { model: "black-forest-labs/flux.2-pro", provider: "black-forest-labs", params: {}, worstCaseUsd: 0.03,
        listed: { unit: "megapixel", maxCostUsd: 0.03 } },
      // Flat $0.03 per image at 1K (measured $0.03; 2K is the same price but
      // 65 s and a 3 MB PNG, so the fallback pins 1K).
      { model: "qwen/qwen-image-3", provider: "alibaba", params: { resolution: "1K" }, worstCaseUsd: 0.03,
        listed: { unit: "image", variant: "1k", maxCostUsd: 0.03 } },
    ],
  },
};

export const VIDEOS_MODEL = "google/veo-3.1-lite";
export const VIDEOS_PRICE = 0.2;
export const VIDEOS_DURATION_SECONDS = 4;
export const VIDEOS_RESOLUTION = "720p";
export const VIDEOS_ASPECT_RATIOS = ["16:9", "9:16"];
export const VIDEOS_MAX_PROMPT_CHARS = 2_000;
// Listed SKU `duration_seconds_without_audio_720p` = $0.03/s x 4 s; measured $0.12.
export const VIDEOS_WORST_CASE_USD = 0.12;
const VIDEOS_POLL_MS = () => Math.max(100, parseInt(process.env.VIDEOS_POLL_MS || "5000", 10) || 5000);
const VIDEOS_MAX_WAIT_MS = () => Math.max(1_000, parseInt(process.env.VIDEOS_MAX_WAIT_MS || "180000", 10) || 180_000);
// Per-link generation timeout. Deliberately short: a timeout AFTER the image was
// generated is billed upstream while the chain walks on to the next link, so the
// chain sum can exceed the tier price. 45 s sits past every measured generation
// (klein 2 s, flux.2-pro 9 s, qwen 66 s is the exception and is the LAST link).
const IMAGE_LINK_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.IMAGE_LINK_TIMEOUT_MS || "45000", 10) || 45_000);

/** Margin table for the pricing-margin CI test: every link's bound against
 *  its tier price, plus the video tier. Integer micro-dollars, so 70% of
 *  $0.02 compares as 14000 >= 14000 rather than as a float near-miss. */
export function mediaMarginTable() {
  const rows = [];
  for (const [tier, t] of Object.entries(IMAGE_TIERS)) {
    for (const link of t.chain) rows.push({ tier, price: t.price, model: link.model, worst: link.worstCaseUsd });
  }
  rows.push({ tier: "v1-videos", price: VIDEOS_PRICE, model: VIDEOS_MODEL, worst: VIDEOS_WORST_CASE_USD });
  return rows;
}
export function withinMargin(price, worst) {
  return Math.round(worst * 1e6) <= Math.round(price * 1e6 * MARGIN);
}

// ---------------------------------------------------------------------------
// Validation (OpenAI images wire: prompt, n, model, response_format).
export function validateImageTierRequest(input, tierSlug) {
  const tier = IMAGE_TIERS[tierSlug];
  if (!tier) throw bad("Unknown image tier", 500);
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required - a text description of the image to generate');
  if (prompt.length > IMAGE_MAX_PROMPT_CHARS) throw bad(`Prompt too long (${prompt.length} chars). Maximum is ${IMAGE_MAX_PROMPT_CHARS}`);
  if (input.model !== undefined) {
    const m = String(input.model).trim();
    if (!tier.chain.some((l) => l.model === m)) {
      throw bad(`"model" is fixed on this endpoint - omit it, or send ${tier.chain[0].model} (served first; ${tier.chain.slice(1).map((l) => l.model).join(", ")} is the failover)`);
    }
  }
  if (input.n !== undefined && parseInt(input.n, 10) !== 1) {
    throw bad('"n" is locked to 1 - the flat price is per image; call again for more');
  }
  if (input.response_format !== undefined && input.response_format !== "b64_json") {
    throw bad('"response_format" must be "b64_json" - generated images are returned inline, not hosted');
  }
  if (input.input_references !== undefined || input.image !== undefined || input.images !== undefined) {
    throw bad("Reference images (image-to-image) are not accepted on this endpoint - it is priced for text-to-image only");
  }
  // size / quality / aspect_ratio / style are ignored, not rejected: the output
  // size is locked to the provider default the price was measured at, and
  // drop-in OpenAI clients send them by habit.
  return { prompt };
}

// ---------------------------------------------------------------------------
// Live-listing repricing guard.
const listingCache = new Map(); // model -> { at, endpoints|null }
const LISTING_TTL_MS = 60 * 60 * 1000;
async function listedEndpoints(model) {
  const hit = listingCache.get(model);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.endpoints;
  let endpoints = null;
  try {
    const res = await fetch(`${OPENROUTER_IMAGES_URL}/models/${model}/endpoints`, { headers: { ...OPENROUTER_ATTRIBUTION }, signal: AbortSignal.timeout(6_000) });
    if (res.ok) {
      const j = await res.json();
      const eps = (j?.data ?? j)?.endpoints;
      if (Array.isArray(eps)) endpoints = eps;
    }
  } catch { /* fail-open below, loudly */ }
  if (!endpoints) console.warn(`[images-fast] could not read the live price listing for ${model} - serving on the pinned bound`);
  listingCache.set(model, { at: Date.now(), endpoints });
  return endpoints;
}
/** True when the live listing shows this link's provider charging MORE for
 *  output than the bound was computed from. Null listing (unreadable) or a
 *  listing that no longer carries the provider => not "repriced" (fail-open;
 *  a vanished provider fails the call itself, which walks the chain). */
export function linkRepriced(link, endpoints) {
  if (!Array.isArray(endpoints)) return false;
  const ep = endpoints.find((e) => (e?.provider_tag || "").split("/")[0] === link.provider || e?.provider_tag === link.provider);
  if (!ep || !Array.isArray(ep.pricing)) return false;
  const lines = ep.pricing.filter((p) => p?.billable === "output_image" && p?.unit === link.listed.unit
    && (link.listed.variant ? p?.variant === link.listed.variant : true));
  if (!lines.length) return false;
  const max = Math.max(...lines.map((p) => Number(p.cost_usd) || 0));
  return max > link.listed.maxCostUsd + 1e-12;
}
export function _resetListingCacheForTest() { listingCache.clear(); }

// ---------------------------------------------------------------------------
// Image handler: walk the chain, first link that returns an image wins.
async function imageTierHandler(tierSlug, input) {
  const tier = IMAGE_TIERS[tierSlug];
  const { prompt } = validateImageTierRequest(input, tierSlug);
  let lastErr = null;
  for (const link of tier.chain) {
    if (linkRepriced(link, await listedEndpoints(link.model))) {
      console.warn(`[images-fast] ${link.model} on ${link.provider} is listed above its bound ($${link.listed.maxCostUsd}) - skipping`);
      lastErr = bad("Image tier temporarily unavailable - upstream repriced above the bound; the operator has been notified", 503);
      continue;
    }
    const body = { model: link.model, prompt, n: 1, ...link.params, provider: { only: [link.provider] } };
    try {
      const res = await fetchOpenRouter(body, { url: OPENROUTER_IMAGES_URL, timeoutMs: IMAGE_LINK_TIMEOUT_MS });
      if (!res.ok) await throwUpstreamError(res);
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
        assertUpstreamBody(parsed);
      const first = Array.isArray(parsed?.data) ? parsed.data[0] : null;
      if (!first || typeof first.b64_json !== "string" || !first.b64_json) throw bad("Upstream returned no image - retry, or rephrase the prompt", 502);

      const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
      if (usage) {
        const upstreamUsd = typeof usage.cost === "number" ? usage.cost : null;
        delete usage.cost; delete usage.cost_details; delete usage.is_byok; delete usage.cache_discount;
        if (upstreamUsd != null && upstreamUsd > link.worstCaseUsd + 1e-9) {
          console.warn(`[images-fast] ${link.model} billed $${upstreamUsd} above its bound $${link.worstCaseUsd} on ${tierSlug}`);
        }
        try {
          const { capturePostHogGatewayUsage } = await import("../posthog.js");
          capturePostHogGatewayUsage({ tier: tierSlug, model: link.model, priceUsd: tier.price, upstreamUsd, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, serviceTier: "default" });
        } catch { /* telemetry must never fail a served response */ }
      }
      return {
        created: Math.floor(Date.now() / 1000),
        model: link.model,
        data: [{ b64_json: first.b64_json, ...(first.media_type ? { media_type: first.media_type } : {}) }],
        ...(usage ? { usage } : {}),
      };
    } catch (e) {
      if (![502, 503, 504].includes(e?.statusCode)) throw e;
      lastErr = e;
    }
  }
  throw lastErr || bad("No image link available", 503);
}

// ---------------------------------------------------------------------------
// Video: validate, submit, poll, download.
export function validateVideosRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required - a text description of the clip to generate');
  if (prompt.length > VIDEOS_MAX_PROMPT_CHARS) throw bad(`Prompt too long (${prompt.length} chars). Maximum is ${VIDEOS_MAX_PROMPT_CHARS}`);
  if (input.model !== undefined && String(input.model).trim() !== VIDEOS_MODEL) {
    throw bad(`"model" is fixed to ${VIDEOS_MODEL} on this endpoint (omit it, or send that id)`);
  }
  if (input.duration !== undefined && Number(input.duration) !== VIDEOS_DURATION_SECONDS) {
    throw bad(`"duration" is locked to ${VIDEOS_DURATION_SECONDS} seconds - the flat price buys one ${VIDEOS_DURATION_SECONDS}-second clip`);
  }
  if (input.seconds !== undefined && Number(input.seconds) !== VIDEOS_DURATION_SECONDS) {
    throw bad(`"seconds" is locked to ${VIDEOS_DURATION_SECONDS} - the flat price buys one ${VIDEOS_DURATION_SECONDS}-second clip`);
  }
  if (input.resolution !== undefined && String(input.resolution) !== VIDEOS_RESOLUTION) {
    throw bad(`"resolution" is locked to ${VIDEOS_RESOLUTION} on this endpoint`);
  }
  if (input.size !== undefined && !["1280x720", "720x1280"].includes(String(input.size))) {
    throw bad('"size" must be 1280x720 or 720x1280 (720p, landscape or portrait)');
  }
  if (input.generate_audio === true) {
    throw bad('"generate_audio" is not available on this endpoint - audio doubles the upstream bill; clips are silent');
  }
  if (input.n !== undefined && parseInt(input.n, 10) !== 1) throw bad('"n" is locked to 1 - the flat price is per clip');
  if (input.frame_images !== undefined || input.input_references !== undefined || input.input_reference !== undefined) {
    throw bad("Reference / frame images are not accepted on this endpoint - it is priced for text-to-video only");
  }
  if (input.response_format !== undefined && input.response_format !== "b64_json") {
    throw bad('"response_format" must be "b64_json" - the clip is returned inline, not hosted');
  }
  let aspect = input.aspect_ratio !== undefined ? String(input.aspect_ratio) : null;
  if (input.size === "720x1280") aspect = "9:16";
  if (input.size === "1280x720") aspect = "16:9";
  if (aspect === null) aspect = VIDEOS_ASPECT_RATIOS[0];
  if (!VIDEOS_ASPECT_RATIOS.includes(aspect)) throw bad(`"aspect_ratio" must be one of ${VIDEOS_ASPECT_RATIOS.join(", ")}`);
  return { prompt, aspect_ratio: aspect };
}

async function openRouterGet(url, { timeoutMs = 30_000, accept } = {}) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("LLM gateway not configured (OPENROUTER_API_KEY unset)", 503);
  try {
    return await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_ATTRIBUTION, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function videosHandler(input) {
  const { prompt, aspect_ratio } = validateVideosRequest(input);
  const body = { model: VIDEOS_MODEL, prompt, duration: VIDEOS_DURATION_SECONDS, resolution: VIDEOS_RESOLUTION, aspect_ratio, generate_audio: false };
  const started = Date.now();
  const res = await fetchOpenRouter(body, { url: OPENROUTER_VIDEOS_URL, timeoutMs: 30_000 });
  if (!res.ok) await throwUpstreamError(res);
  let job;
  try { job = JSON.parse(await res.text()); } catch { throw bad("Upstream returned non-JSON", 502); }
  const id = typeof job?.id === "string" ? job.id : "";
  if (!id) throw bad("Upstream accepted no video job", 502);
  // Only ever poll OUR upstream with our key - never a URL the response named
  // on some other host.
  const pollUrl = typeof job.polling_url === "string" && job.polling_url.startsWith(`${OPENROUTER_VIDEOS_URL}/`) ? job.polling_url : `${OPENROUTER_VIDEOS_URL}/${encodeURIComponent(id)}`;

  let status = job.status || "pending", st = job;
  while (status !== "completed") {
    if (status === "failed") {
      const why = typeof st?.error === "string" ? st.error : (st?.error?.message || "");
      throw bad(`Video generation failed upstream${why ? `: ${redactSecrets(String(why)).slice(0, 160)}` : ""} - not charged`, 502);
    }
    if (Date.now() - started > VIDEOS_MAX_WAIT_MS()) {
      throw bad(`Video generation did not finish within ${Math.round(VIDEOS_MAX_WAIT_MS() / 1000)} s - not charged; retry`, 504);
    }
    await sleep(VIDEOS_POLL_MS());
    const p = await openRouterGet(pollUrl, { timeoutMs: 20_000 });
    if (!p.ok) await throwUpstreamError(p);
    try { st = JSON.parse(await p.text()); } catch { throw bad("Upstream returned non-JSON while polling", 502); }
    status = st?.status || status;
  }

  const c = await openRouterGet(`${OPENROUTER_VIDEOS_URL}/${encodeURIComponent(id)}/content?index=0`, { timeoutMs: 60_000 });
  if (!c.ok) await throwUpstreamError(c);
  const bytes = Buffer.from(await c.arrayBuffer());
  if (!bytes.length) throw bad("Upstream returned an empty clip - retry", 502);
  const mediaType = (c.headers?.get?.("content-type") || "video/mp4").split(";")[0].trim() || "video/mp4";

  const rawUsage = st?.usage && typeof st.usage === "object" ? st.usage : null;
  const upstreamUsd = rawUsage && typeof rawUsage.cost === "number" ? rawUsage.cost : null;
  if (upstreamUsd != null && upstreamUsd > VIDEOS_WORST_CASE_USD + 1e-9) {
    console.warn(`[videos] ${VIDEOS_MODEL} billed $${upstreamUsd} above its bound $${VIDEOS_WORST_CASE_USD}`);
  }
  try {
    const { capturePostHogGatewayUsage } = await import("../posthog.js");
    capturePostHogGatewayUsage({ tier: "v1-videos", model: VIDEOS_MODEL, priceUsd: VIDEOS_PRICE, upstreamUsd, serviceTier: "default" });
  } catch { /* telemetry must never fail a served response */ }

  return {
    created: Math.floor(Date.now() / 1000),
    model: VIDEOS_MODEL,
    data: [{ b64_json: bytes.toString("base64"), media_type: mediaType, duration_seconds: VIDEOS_DURATION_SECONDS, resolution: VIDEOS_RESOLUTION, aspect_ratio }],
    usage: { generation_seconds: Math.round((Date.now() - started) / 1000) },
  };
}

// ---------------------------------------------------------------------------
const SHARED_TAGS = ["ai", "generation", "gateway", "openai-compatible", "openrouter"];
const imageInputSchema = {
  properties: {
    prompt: { type: "string", description: `Text description of the image to generate (up to ${IMAGE_MAX_PROMPT_CHARS.toLocaleString()} chars)` },
  },
  required: ["prompt"],
};
const imageOutputExample = (model) => ({ created: 1750000000, model, data: [{ b64_json: "/9j/4AAQSkZJRgABAQAAAQABAAD…", media_type: "image/jpeg" }], usage: { prompt_tokens: 11, completion_tokens: 4096, total_tokens: 4107 } });

export const IMAGES_FAST_TOOLS = [
  {
    route: `POST ${IMAGES_FAST_PATH}`,
    name: "Fast image generation (OpenAI-compatible, budget)",
    slug: "v1-images-fast",
    category: "llm",
    price: "$0.020",
    description:
      "Budget text-to-image over x402 - OpenAI images wire (prompt in, inline base64 out) at $0.02 per picture, a quarter of the flagship /v1/images/generations price. Served by FLUX.2 Klein 4B (about 2 seconds per image, 1024x1024 JPEG) with GPT-5 Image Mini as the failover. n locked to 1, text-to-image only, size and quality fixed. Point any OpenAI SDK's images.generate() at base_url https://agent402.tools/v1 and call /images/fast.",
    tags: ["image-generation", "images", "text-to-image", "generate", "generate-image", "create-image", "picture", "cheap", "flux", "budget", "fast", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A minimalist line drawing of a lighthouse at dawn" },
      inputSchema: imageInputSchema,
      output: { example: imageOutputExample(IMAGE_TIERS["v1-images-fast"].chain[0].model) },
    },
    handler: (input) => imageTierHandler("v1-images-fast", input),
  },
  {
    route: `POST ${IMAGES_PRO_PATH}`,
    name: "Pro image generation (OpenAI-compatible)",
    slug: "v1-images-pro",
    category: "llm",
    price: "$0.050",
    description:
      "Higher-fidelity text-to-image over x402 - OpenAI images wire (prompt in, inline base64 out) at $0.05 per picture. Served by FLUX.2 Pro (about 9 seconds per image, 1024x1024 JPEG) with Qwen Image 3 at 1K as the failover. n locked to 1, text-to-image only, size and quality fixed. Point any OpenAI SDK's images.generate() at base_url https://agent402.tools/v1 and call /images/pro.",
    tags: ["image-generation", "images", "text-to-image", "generate", "generate-image", "create-image", "picture", "flux", "pro", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A photorealistic still life of a brass astrolabe on a walnut desk, soft window light" },
      inputSchema: imageInputSchema,
      output: { example: imageOutputExample(IMAGE_TIERS["v1-images-pro"].chain[0].model) },
    },
    handler: (input) => imageTierHandler("v1-images-pro", input),
  },
  {
    route: `POST ${VIDEOS_PATH}`,
    name: "Video generation (4-second clip)",
    slug: "v1-videos",
    category: "llm",
    price: "$0.200",
    description:
      "Text-to-video over x402 - one silent 4-second 720p clip (MP4, inline base64) for a flat $0.20, served by Veo 3.1 Lite. Choose aspect_ratio 16:9 (default) or 9:16; duration, resolution and audio are fixed so the price is. The call returns when the clip is ready (about 40 seconds measured, up to 4 minutes); a failed or timed-out generation is never charged.",
    tags: ["video-generation", "video", "videos", "text-to-video", "generate", "generate-video", "create-video", "clip", "animation", "veo", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A paper boat drifting down a rain-soaked gutter, close up, cinematic", aspect_ratio: "16:9" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: `Text description of the clip (up to ${VIDEOS_MAX_PROMPT_CHARS.toLocaleString()} chars)` },
          aspect_ratio: { type: "string", enum: VIDEOS_ASPECT_RATIOS, description: "16:9 (default, 1280x720) or 9:16 (720x1280)" },
        },
        required: ["prompt"],
      },
      output: { example: { created: 1750000000, model: VIDEOS_MODEL, data: [{ b64_json: "AAAAIGZ0eXBpc29t…", media_type: "video/mp4", duration_seconds: 4, resolution: "720p", aspect_ratio: "16:9" }], usage: { generation_seconds: 40 } } },
    },
    handler: videosHandler,
  },
];
