// Budget image tiers + a bounded video tier over OpenRouter's DEDICATED media
// APIs (`POST /api/v1/images`, `POST /api/v1/videos`), not the chat wire the
// flagship `/v1/images/generations` route rides.
//
// Why a second kit: the chat wire only reaches the Gemini/GPT image models
// that are token-priced per image, while
// the dedicated Image API lists 40+ models with FLAT per-image / per-megapixel
// prices and ALL-OR-NOTHING billing (a failed or cancelled generation is a
// 502 and is not billed - their docs, "Billing and Cancellation"). Flat prices
// make the worst-case upstream cost a constant per link, so the margin bound
// (same MARGIN as the chat tiers) holds with no token math. Every knob that multiplies cost is server-owned: n is
// locked to 1, output size/quality are locked to the provider default (1024 x
// 1024 measured on every link), reference images (image-to-image, billed
// extra) are refused, and each link is pinned to the provider whose listed
// price the bound was computed from (`provider.only`).
//
// Measured live 2026-08-22 (one call each), latency and output:
//   flux.2-klein-4b        2.0 s  jpeg 1024x1024
//   gpt-image-1-mini med. 14.1 s  png  1024x1024
//   flux.2-pro             8.7 s  jpeg 1024x1024
//   qwen-image-3          65.7 s  png  2048x2048
//   flux-3-image-klein     5-7 s  jpeg 1024x1024 (2026-10-17; edits 9-12 s,
//                                  output follows the reference's aspect)
//   veo-3.1-lite 4s 720p   40 s   mp4, no audio
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
// are LOCKED (4 s, 720p, no audio, on the listed per-second SKU) so the
// price is a constant; aspect ratio (16:9 / 9:16) is free to choose. Measured
// 40 s end to end; the handler waits up to VIDEOS_MAX_WAIT_MS and answers 504
// past it (not charged on our side). The upstream job keeps running, so it is
// parked for VIDEO_PARK_MS and an identical retry collects that clip instead
// of starting a new one; uncollected, it is bounded at one clip. Content is fetched with our key (the unsigned URLs 401
// without it - measured) and returned inline as base64, never as a URL that
// would expose our job ids.
import { parseMultipartFile } from "../multipart.js";
import { imageSize, examplePngBase64 } from "./judge-preview-kit.js";
import { bad, fetchOpenRouter, throwUpstreamError, assertUpstreamBody, MARGIN, OPENROUTER_ATTRIBUTION, upstreamUserId, IMAGES_PATH, IMAGES_PRICE } from "./llm-gateway-kit.js";
import { redactSecrets } from "./redact.js";
import { upstreamCosts } from "../upstream-costs.js";
import { createHash } from "node:crypto";
import { shared } from "../shared-limits.js";
import { payerFromRequest } from "../payer.js";
import { reportProgress } from "../job-progress.js";
import { cdnSyncLeftMs } from "../cdn-sync-window.js";

export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
export const OPENROUTER_VIDEOS_URL = "https://openrouter.ai/api/v1/videos";
const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();

export const IMAGES_FAST_PATH = "/v1/images/fast";
export const IMAGES_PRO_PATH = "/v1/images/pro";
export const IMAGES_EDIT_PATH = "/v1/images/edits";
export const VIDEOS_PATH = "/v1/videos/generations";
export const IMAGE_MAX_PROMPT_CHARS = 4_000;
// Reference images on the edit route. Billing is flat per output image at the
// pinned resolution whatever the references (measured with one and two), and
// the provider accepts up to ten; four keeps the body bounded. Each is read
// for its type and size from the bytes, so only an image the provider accepts
// (it refuses one under 256 px a side) reaches the upstream.
export const IMAGE_EDIT_MAX_REFS = 4;
export const IMAGE_EDIT_MAX_REF_BYTES = 6 * 1024 * 1024;
export const IMAGE_EDIT_MIN_SIDE = 256;

// FLUX 3 Image Klein, flat per image at the pinned 1K resolution. Square on the
// text-to-image tiers (their documented 1024x1024); unset on the edit tier,
// where the output follows the reference image's aspect.
const KLEIN3 = "black-forest-labs/flux-3-image-klein";
const klein3Link = (params) => ({ model: KLEIN3, provider: "black-forest-labs", params: { resolution: "1K", ...params },
  listed: { unit: "image", variant: "1k" } });

// One link = one model on one provider. Its bounds live in the private table
// (src/upstream-costs.js, `media`, never committed): `worstCaseUsd` is the
// bound the tier price was set against, `listedMaxUsd` the ceiling the live
// listing's `output_image` line for `listed.unit` (and variant) must not
// exceed. A link without bounds is skipped (503, never charged).
export function linkBounds(link) {
  const b = upstreamCosts().media?.[link.model];
  return b && Number.isFinite(b.worstCaseUsd) && Number.isFinite(b.listedMaxUsd) ? b : null;
}
export const IMAGE_TIERS = {
  "v1-images-fast": {
    path: IMAGES_FAST_PATH,
    price: 0.02,
    chain: [
      // Per-megapixel pricing, locked 1024x1024 billed as 1 MP.
      { model: "black-forest-labs/flux.2-klein-4b", provider: "black-forest-labs", params: {},
        listed: { unit: "megapixel" } },
      klein3Link({ aspect_ratio: "1:1" }),
      // Token-priced: ~1568 image tokens at medium plus text prompt tokens.
      // gpt-5-image-mini replaced gpt-image-1-mini here 2026-09-02, ahead of the
      // latter's 2026-12-01 retirement: identical image_output and prompt
      // pricing on OpenRouter's endpoint listing, read live that day;
      // gpt-image-2 does not fit under this tier's bound. Verified LIVE in the IMAGE catalog
      // (/api/v1/images/models); absent from the chat-model list, which is not
      // the same thing.
      { model: "openai/gpt-5-image-mini", provider: "openai", params: { quality: "medium" },
        listed: { unit: "token" } },
    ],
  },
  "v1-images-pro": {
    path: IMAGES_PRO_PATH,
    price: 0.05,
    chain: [
      // Per-megapixel pricing, locked 1024x1024.
      { model: "black-forest-labs/flux.2-pro", provider: "black-forest-labs", params: {},
        listed: { unit: "megapixel" } },
      // Replaced qwen-image-3 (66 s per image) 2026-10-17: a few seconds, and
      // the same 1024x1024 JPEG the primary returns.
      klein3Link({ aspect_ratio: "1:1" }),
    ],
  },
  // Image edit: a prompt plus one to four reference images. One link; no other
  // listed edit model fits under this price's bound, so an outage is a 503
  // (not charged).
  "v1-images-edit": {
    path: IMAGES_EDIT_PATH,
    price: 0.02,
    edit: true,
    chain: [klein3Link({})],
  },
  // The flagship /v1/images/generations route (tool def in llm-gateway-kit.js,
  // which hands the call to imageTierHandler here). It rode
  // google/gemini-2.5-flash-image over chat modalities until 2026-09-24; Google
  // shuts that model down on 2026-10-02. Same two links as the pro tier's
  // primary and the fast tier's failover, pinned to PNG so the route keeps the
  // output format it documents (media_type image/png, 1024x1024), and both
  // decode in Jimp for the products that post-process images.
  "v1-images": {
    path: IMAGES_PATH,
    price: IMAGES_PRICE,
    chain: [
      // Per-megapixel pricing; the locked 1024x1024 output bills as 1 MP (PNG).
      { model: "black-forest-labs/flux.2-pro", provider: "black-forest-labs", params: { output_format: "png" },
        listed: { unit: "megapixel" } },
      { model: "openai/gpt-5-image-mini", provider: "openai", params: { quality: "medium" },
        listed: { unit: "token" } },
    ],
  },
};

export const VIDEOS_MODEL = "google/veo-3.1-lite";
export const VIDEOS_PRICE = 0.2;
export const VIDEOS_DURATION_SECONDS = 4;
export const VIDEOS_RESOLUTION = "720p";
export const VIDEOS_ASPECT_RATIOS = ["16:9", "9:16"];
export const VIDEOS_MAX_PROMPT_CHARS = 2_000;
// Listed SKU `duration_seconds_without_audio_720p` x 4 s, from the private table.
export function videosWorstCaseUsd() {
  const v = upstreamCosts().media?.[VIDEOS_MODEL]?.worstCaseUsd;
  return Number.isFinite(v) ? v : null;
}
const VIDEOS_POLL_MS = () => Math.max(100, parseInt(process.env.VIDEOS_POLL_MS || "5000", 10) || 5000);
// The wait before each status poll. A clip takes about 40 s, so nothing is
// lost by polling every 5 s for the first VIDEOS_POLL_FAST_AFTER_MS; after
// that the clip is due, and a 2 s poll answers on average about 1.5 s sooner
// than a 5 s one (half the interval). A 429 or 5xx poll is already tolerated
// (VIDEOS_MAX_POLL_FAILURES). VIDEOS_POLL_MS set explicitly keeps one fixed interval.
const VIDEOS_POLL_FAST_MS = 2_000;
const VIDEOS_POLL_FAST_AFTER_MS = 20_000;
export function videosPollWaitMs(elapsedMs) {
  if (process.env.VIDEOS_POLL_MS) return VIDEOS_POLL_MS();
  return elapsedMs < VIDEOS_POLL_FAST_AFTER_MS ? VIDEOS_POLL_MS() : VIDEOS_POLL_FAST_MS;
}
const VIDEOS_MAX_WAIT_MS = () => Math.max(1_000, parseInt(process.env.VIDEOS_MAX_WAIT_MS || "180000", 10) || 180_000);
// Per-link generation timeout. Deliberately short: a timeout AFTER the image was
// generated is billed upstream while the chain walks on to the next link, so the
// chain sum can exceed the tier price. 45 s sits past every measured generation
// (klein 2 s, flux.2-pro 9 s, qwen 66 s is the exception and is the LAST link).
const IMAGE_LINK_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.IMAGE_LINK_TIMEOUT_MS || "45000", 10) || 45_000);
// A link starts only with this much of the CDN wait left, and ends this long
// before it, so settlement and the write fit.
const CDN_LINK_MIN_START_MS = 15_000;
const CDN_LINK_TAIL_MS = 5_000;
/** The per-link timeout under the CDN wait; `defaultMs` off the CDN; null
 *  when a further link could not finish in time. The first link always starts. */
export function cdnLinkTimeoutMs(req, defaultMs, startedLinks, now = Date.now()) {
  const left = cdnSyncLeftMs(req, now);
  if (left == null) return defaultMs;
  const usable = left - CDN_LINK_TAIL_MS;
  if (startedLinks > 0 && usable < CDN_LINK_MIN_START_MS) return null;
  return Math.max(1_000, Math.min(defaultMs, usable));
}

/** Margin table for the pricing-margin CI test: every link's bound against
 *  its tier price, plus the video tier. Integer micro-dollars, so an exact
 *  boundary compares as equal rather than as a float near-miss. */
export function mediaMarginTable() {
  const rows = [];
  for (const [tier, t] of Object.entries(IMAGE_TIERS)) {
    for (const link of t.chain) rows.push({ tier, price: t.price, model: link.model, worst: linkBounds(link)?.worstCaseUsd ?? null });
  }
  rows.push({ tier: "v1-videos", price: VIDEOS_PRICE, model: VIDEOS_MODEL, worst: videosWorstCaseUsd() });
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
  if (input == null || typeof input !== "object" || Buffer.isBuffer(input)) throw bad("Request body must be a JSON object");
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
  if (tier.edit) {
    if (input.mask !== undefined) throw bad('"mask" is not accepted - describe the change in the prompt; the model edits from the prompt and the reference images');
    return { prompt, refs: editReferences(input) };
  }
  if (input.input_references !== undefined || input.image !== undefined || input.images !== undefined) {
    throw bad(`Reference images (image-to-image) are not accepted on this endpoint - it is priced for text-to-image only; send them to ${IMAGES_EDIT_PATH}`);
  }
  // size / quality / aspect_ratio / style are ignored, not rejected: the output
  // size is locked to the provider default the price was measured at, and
  // drop-in OpenAI clients send them by habit.
  return { prompt };
}

/** One reference image as a data URL, from bytes; the type and size are read
 *  from the bytes, never from what the caller declared. */
export function referenceDataUrl(buf, label = "image") {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad(`${label} is empty`);
  if (buf.length > IMAGE_EDIT_MAX_REF_BYTES) throw bad(`${label} is ${(buf.length / 1048576).toFixed(1)} MB; each reference image may be up to ${IMAGE_EDIT_MAX_REF_BYTES / 1048576} MB`);
  const format = buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpeg" : null;
  const size = format ? imageSize(buf, format) : null;
  if (!size) throw bad(`${label} is not a PNG or JPEG image (an animated PNG is not accepted)`);
  if (size.width < IMAGE_EDIT_MIN_SIDE || size.height < IMAGE_EDIT_MIN_SIDE) throw bad(`${label} is ${size.width}x${size.height}; each reference image must be at least ${IMAGE_EDIT_MIN_SIDE}x${IMAGE_EDIT_MIN_SIDE} pixels`);
  return `data:image/${format};base64,${buf.toString("base64")}`;
}
function decodeReference(v, label) {
  let s = v;
  if (s && typeof s === "object") s = s.image_url?.url ?? s.image_url ?? s.url ?? s.b64_json;
  if (typeof s !== "string" || !s.trim()) throw bad(`${label} must be a base64 image or a data: URL`);
  s = s.trim();
  if (/^https?:/i.test(s)) throw bad(`${label}: image URLs are not fetched - send the image inline as base64 or a data: URL`);
  const m = /^data:([^;,]*)(;base64)?,/i.exec(s);
  if (m && !m[2]) throw bad(`${label}: the data: URL must be base64-encoded`);
  const b64 = (m ? s.slice(m[0].length) : s).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw bad(`${label} is not valid base64`);
  return referenceDataUrl(Buffer.from(b64, b64.includes("-") || b64.includes("_") ? "base64url" : "base64"), label);
}
/** The edit route's references from a JSON body: `image` (one, or an array,
 *  as OpenAI's wire allows) or `images`. */
function editReferences(input) {
  if (input._editRefs) return input._editRefs;
  const raw = input.images !== undefined ? input.images : input.image;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (!list.length) throw bad('"image" is required - one to four reference images, each base64 or a data: URL (or a multipart "image" file)');
  if (list.length > IMAGE_EDIT_MAX_REFS) throw bad(`At most ${IMAGE_EDIT_MAX_REFS} reference images per edit (got ${list.length})`);
  return list.map((v, i) => decodeReference(v, list.length > 1 ? `image ${i + 1}` : "image"));
}
/** OpenAI's images.edit() sends multipart/form-data: an `image` file part plus
 *  `prompt` (and fields it ignores here). One file part, by the parser's
 *  design; send JSON for more than one reference. */
export function editInputFromMultipart(req) {
  const ct = req?.headers?.["content-type"] || "";
  const body = req?.body;
  if (!/^multipart\/form-data/i.test(String(ct)) || !Buffer.isBuffer(body)) return null;
  const { fields, file } = parseMultipartFile(body, ct, { maxParts: 16 });
  if (!file) throw bad('multipart body has no "image" file part');
  const input = { ...fields };
  delete input.image; delete input["image[]"];
  input._editRefs = [referenceDataUrl(file.buf, "image")];
  return input;
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
  const b = linkBounds(link);
  return !b || max > b.listedMaxUsd + 1e-12;
}
export function _resetListingCacheForTest() { listingCache.clear(); }

// ---------------------------------------------------------------------------
// Per-buyer `user` for OpenRouter's abuse isolation (see upstreamUserId in the
// gateway kit). These three routes sent none, which the OpenRouter log showed
// as an empty Client User ID on every FLUX / Veo row (2026-09-18), while chat,
// Messages, Responses, embeddings, rerank and /v1/images/generations all send
// it. It is what scopes an upstream provider policy block to ONE buyer; without
// it an abusive caller here is unattributed and the blast radius is the whole
// account. Call-time only and never part of a cache key - these routes cache
// nothing. A request we cannot key (no payer, no gate credential) sends none,
// exactly as the other wires behave.
function userOf(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

// Image handler: walk the chain, first link that returns an image wins.
// `zdr` (the /v1/images/generations route's documented knob) folds into the
// provider prefs next to the pin, the way the chat wire folds it.
export async function imageTierHandler(tierSlug, input, req, { zdr = false } = {}) {
  const user = userOf(req);
  const tier = IMAGE_TIERS[tierSlug];
  const { prompt, refs } = validateImageTierRequest(input, tierSlug);
  let lastErr = null;
  let started = 0;
  for (const link of tier.chain) {
    // Through the CDN proxy the answer must start inside the proxy's wait
    // (src/cdn-sync-window.js): a fallback link that cannot finish in what is
    // left is not started, and the call ends with a 504 (not charged).
    const linkTimeoutMs = cdnLinkTimeoutMs(req, IMAGE_LINK_TIMEOUT_MS, started);
    if (linkTimeoutMs == null) throw bad("The image did not finish within the time this connection waits for an answer - not charged; retry, or send Prefer: respond-async for a job link", 504);
    if (!linkBounds(link)) {
      lastErr = bad("Image tier temporarily unavailable", 503);
      continue;
    }
    if (linkRepriced(link, await listedEndpoints(link.model))) {
      console.warn(`[images-fast] ${link.model} on ${link.provider} is listed above its bound - skipping`);
      lastErr = bad("Image tier temporarily unavailable - upstream repriced above the bound; the operator has been notified", 503);
      continue;
    }
    const body = { model: link.model, prompt, n: 1, ...link.params,
      ...(refs ? { input_references: refs.map((url) => ({ type: "image_url", image_url: { url } })) } : {}), provider: { only: [link.provider], ...(zdr ? { zdr: true } : {}) }, ...(user ? { user } : {}) };
    try {
      started++;
      const res = await fetchOpenRouter(body, { url: OPENROUTER_IMAGES_URL, timeoutMs: linkTimeoutMs });
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
        if (upstreamUsd != null && upstreamUsd > (linkBounds(link)?.worstCaseUsd ?? Infinity) + 1e-9) {
          console.warn(`[images-fast] ${link.model} billed above its bound on ${tierSlug}`);
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
    throw bad('"generate_audio" is not available on this endpoint; clips are silent');
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
const VIDEOS_MAX_POLL_FAILURES = 5;
const VIDEOS_CONTENT_RETRIES = 2;
const videoTransientStatus = (s) => s === 429 || s >= 500;
// openRouterGet throws 504 on a network error or timeout (503 when unconfigured).
const videoTransientError = (e) => e?.statusCode === 504;
const videoContentBackoffMs = (attempt) => Math.min(VIDEOS_POLL_MS(), 1_000) * (attempt + 1);

// Parked video jobs: one upstream job per identical request (same buyer, same
// locked body), kept for VIDEO_PARK_MS on the shared store so a retry on
// either replica resumes it. Only a request with a signed payer identity
// (payerFromRequest) parks or resumes: without one, two buyers sending the same
// prompt would share a key. The key is a hash; the job id is never returned.
// A retry CLAIMS the parked id before polling it (an atomic counter on the
// shared store: the first claimant gets 1), so two concurrent identical retries
// cannot both collect one clip; the loser submits its own job. Every terminal
// error releases the id; only another timeout parks it again.
const VIDEO_PARK_MS = () => Math.max(60_000, parseInt(process.env.VIDEO_PARK_MS || "1800000", 10) || 1_800_000);
const videoParkKey = (payer, body) => createHash("sha256").update(JSON.stringify({ payer, body })).digest("hex").slice(0, 32);
async function parkedVideoJob(key) {
  try {
    const r = await shared.windowRead("video-park", key, { windowMs: VIDEO_PARK_MS() });
    const last = r?.ok && Array.isArray(r.entries) && r.entries.length ? r.entries[r.entries.length - 1] : null;
    return last && typeof last.member === "string" && last.member ? last.member : null;
  } catch { return null; }
}
async function claimParkedVideoJob(key, id) {
  try {
    const r = await shared.counterAdd("video-park-claim", `${key}:${id}`, 1, VIDEO_PARK_MS());
    if (!r?.ok || r.value !== 1) return false;
    await shared.windowRemove("video-park", key, { member: id });
    return true;
  } catch { return false; }
}
async function parkVideoJob(key, id) {
  try {
    await shared.counterClear("video-park-claim", `${key}:${id}`);
    await shared.windowAdd("video-park", key, { windowMs: VIDEO_PARK_MS(), member: id });
  } catch { /* best effort */ }
}
async function unparkVideoJob(key, id) {
  try { await shared.windowRemove("video-park", key, { member: id }); } catch { /* best effort */ }
}

async function videosHandler(input, req) {
  if (videosWorstCaseUsd() == null) throw bad("/v1/videos is temporarily unavailable.", 503);
  const user = userOf(req);
  const { prompt, aspect_ratio } = validateVideosRequest(input);
  const body = { model: VIDEOS_MODEL, prompt, duration: VIDEOS_DURATION_SECONDS, resolution: VIDEOS_RESOLUTION, aspect_ratio, generate_audio: false, ...(user ? { user } : {}) };
  const started = Date.now();
  // A job that outlived the last identical request is picked up again rather
  // than paid for twice: the retry the 504 asks for collects the same clip.
  const payer = payerFromRequest(req);
  const parkKey = payer ? videoParkKey(payer, body) : null;
  let job = null;
  const parkedId = parkKey ? await parkedVideoJob(parkKey) : null;
  if (parkedId && await claimParkedVideoJob(parkKey, parkedId)) job = { id: parkedId, status: "pending" };
  else {
    const res = await fetchOpenRouter(body, { url: OPENROUTER_VIDEOS_URL, timeoutMs: 30_000 });
    if (!res.ok) await throwUpstreamError(res);
    try { job = JSON.parse(await res.text()); } catch { throw bad("Upstream returned non-JSON", 502); }
  }
  const id = typeof job?.id === "string" ? job.id : "";
  if (!id) throw bad("Upstream accepted no video job", 502);
  // Job progress (src/job-progress.js): a no-op outside an async job or task.
  reportProgress({ stage: "submitted" }, req);
  // Only ever poll OUR upstream with our key - never a URL the response named
  // on some other host.
  const pollUrl = typeof job.polling_url === "string" && job.polling_url.startsWith(`${OPENROUTER_VIDEOS_URL}/`) ? job.polling_url : `${OPENROUTER_VIDEOS_URL}/${encodeURIComponent(id)}`;

  let status = job.status || "pending", st = job, pollFailures = 0, c;
  try {
  while (status !== "completed") {
    if (status === "failed") {
      const why = typeof st?.error === "string" ? st.error : (st?.error?.message || "");
      throw bad(`Video generation failed upstream${why ? `: ${redactSecrets(String(why)).slice(0, 160)}` : ""}. This call is not charged on x402`, 502);
    }
    if (Date.now() - started > VIDEOS_MAX_WAIT_MS()) {
      const waited = `Video generation did not finish within ${Math.round(VIDEOS_MAX_WAIT_MS() / 1000)} s. This call is not charged on x402`;
      if (!parkKey) throw bad(`${waited}; send the request again to start a new clip`, 504);
      await parkVideoJob(parkKey, id);
      throw Object.assign(bad(`${waited}; send the same request again, paid from the same wallet, within ${Math.round(VIDEO_PARK_MS() / 60_000)} minutes to collect this clip`, 504), { videoParked: true });
    }
    await sleep(videosPollWaitMs(Date.now() - started));
    // A transient poll failure (5xx, 429, network, timeout, garbled body)
    // keeps polling until the deadline; a run of them, or any other status,
    // ends the request.
    let next = null, failure = null;
    try {
      const p = await openRouterGet(pollUrl, { timeoutMs: 20_000 });
      if (!p.ok && !videoTransientStatus(p.status)) await throwUpstreamError(p);
      if (!p.ok) {
        await p.text().catch(() => "");
        failure = bad(`Upstream error while polling (HTTP ${p.status})`, p.status === 429 ? 503 : 502);
      } else {
        try { next = JSON.parse(await p.text()); } catch { failure = bad("Upstream returned non-JSON while polling", 502); }
      }
    } catch (e) {
      if (!videoTransientError(e)) throw e;
      failure = e;
    }
    if (failure) {
      if (++pollFailures >= VIDEOS_MAX_POLL_FAILURES) throw failure;
      continue;
    }
    pollFailures = 0;
    st = next;
    status = st?.status || status;
    if (status !== "completed" && status !== "failed") reportProgress({ stage: "generating" }, req);
  }
  reportProgress({ stage: "downloading" }, req);

  const contentUrl = `${OPENROUTER_VIDEOS_URL}/${encodeURIComponent(id)}/content?index=0`;
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < VIDEOS_CONTENT_RETRIES && Date.now() - started < VIDEOS_MAX_WAIT_MS();
    try {
      c = await openRouterGet(contentUrl, { timeoutMs: 60_000 });
    } catch (e) {
      if (canRetry && videoTransientError(e)) { await sleep(videoContentBackoffMs(attempt)); continue; }
      throw e;
    }
    if (c.ok) break;
    if (canRetry && videoTransientStatus(c.status)) { await c.text().catch(() => ""); await sleep(videoContentBackoffMs(attempt)); continue; }
    await throwUpstreamError(c);
  }
  } catch (e) {
    // Any end other than a fresh park releases the id: a terminal poll or
    // content error, the poll-failure limit, or "failed".
    if (parkKey && !e?.videoParked) void unparkVideoJob(parkKey, id);
    throw e;
  }
  const bytes = Buffer.from(await c.arrayBuffer());
  if (!bytes.length) throw bad("Upstream returned an empty clip - retry", 502);
  reportProgress({ stage: "encoding" }, req);
  const mediaType = (c.headers?.get?.("content-type") || "video/mp4").split(";")[0].trim() || "video/mp4";

  const rawUsage = st?.usage && typeof st.usage === "object" ? st.usage : null;
  const upstreamUsd = rawUsage && typeof rawUsage.cost === "number" ? rawUsage.cost : null;
  if (upstreamUsd != null && upstreamUsd > (videosWorstCaseUsd() ?? 0) + 1e-9) {
    console.warn(`[videos] ${VIDEOS_MODEL} billed above its bound`);
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
const SHARED_TAGS = ["ai", "generation", "gateway", "openai-compatible"];
const imageInputSchema = {
  properties: {
    prompt: { type: "string", description: `Text description of the image to generate (up to ${IMAGE_MAX_PROMPT_CHARS.toLocaleString()} chars)` },
  },
  required: ["prompt"],
};
// The judge preview's 300x300 PNG (a red square on white): small enough to ride
// in the 402's discovery block, and above the provider's 256 px minimum.
const EDIT_EXAMPLE_IMAGE = `data:image/png;base64,${examplePngBase64()}`;
const imageOutputExample = (model) => ({ created: 1750000000, model, data: [{ b64_json: "/9j/4AAQSkZJRgABAQAAAQABAAD…", media_type: "image/jpeg" }], usage: { prompt_tokens: 11, completion_tokens: 4096, total_tokens: 4107 } });

export const IMAGES_FAST_TOOLS = [
  {
    route: `POST ${IMAGES_FAST_PATH}`,
    name: "Fast image generation (OpenAI-compatible, budget)",
    slug: "v1-images-fast", aliases: ["fast-image-generation", "budget-image-generation"],
    category: "llm",
    price: "$0.020",
    description:
      "Budget text-to-image over x402 - OpenAI images wire (prompt in, inline base64 out) at $0.02 per picture, a quarter of the flagship /v1/images/generations price. Served by FLUX.2 Klein 4B (about 2 seconds per image, 1024x1024 JPEG) with FLUX 3 Image Klein, then GPT-5 Image Mini, as the failover. n locked to 1, text-to-image only, size and quality fixed. Point any OpenAI SDK's images.generate() at base_url https://agent402.tools/v1 and call /images/fast.",
    tags: ["image-generation", "images", "text-to-image", "generate", "generate-image", "create-image", "picture", "cheap", "flux", "budget", "fast", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A minimalist line drawing of a lighthouse at dawn" },
      inputSchema: imageInputSchema,
      output: { example: imageOutputExample(IMAGE_TIERS["v1-images-fast"].chain[0].model) },
    },
    handler: (input, req) => imageTierHandler("v1-images-fast", input, req),
  },
  {
    route: `POST ${IMAGES_PRO_PATH}`,
    name: "Pro image generation (OpenAI-compatible)",
    slug: "v1-images-pro", aliases: ["pro-image-generation"],
    category: "llm",
    price: "$0.050",
    description:
      "Higher-fidelity text-to-image over x402 - OpenAI images wire (prompt in, inline base64 out) at $0.05 per picture. Served by FLUX.2 Pro (about 9 seconds per image, 1024x1024 JPEG) with FLUX 3 Image Klein as the failover. n locked to 1, text-to-image only, size and quality fixed. Point any OpenAI SDK's images.generate() at base_url https://agent402.tools/v1 and call /images/pro.",
    tags: ["image-generation", "images", "text-to-image", "generate", "generate-image", "create-image", "picture", "flux", "pro", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A photorealistic still life of a brass astrolabe on a walnut desk, soft window light" },
      inputSchema: imageInputSchema,
      output: { example: imageOutputExample(IMAGE_TIERS["v1-images-pro"].chain[0].model) },
    },
    handler: (input, req) => imageTierHandler("v1-images-pro", input, req),
  },
  {
    route: `POST ${IMAGES_EDIT_PATH}`,
    name: "Image edit (OpenAI-compatible)",
    slug: "v1-images-edit", aliases: ["image-edit", "edit-image"],
    category: "llm",
    price: "$0.020",
    description:
      `Edit an image with a prompt over x402 - OpenAI images.edit wire (reference images and a prompt in, inline base64 out) at $0.02 per picture. Send one to ${IMAGE_EDIT_MAX_REFS} PNG or JPEG reference images (${IMAGE_EDIT_MIN_SIDE} px a side or more, up to ${IMAGE_EDIT_MAX_REF_BYTES / 1048576} MB each) as base64 or data: URLs in JSON, or one as a multipart "image" file; the output is one JPEG of about one megapixel that follows the first reference's aspect ratio. Served by FLUX 3 Image Klein in about 10 seconds. No mask: describe the change in the prompt. n locked to 1; a failed generation is not charged on x402. Point any OpenAI SDK's images.edit() at base_url https://agent402.tools/v1.`,
    tags: ["image-edit", "edit-image", "images", "image-to-image", "inpainting", "retouch", "photo-edit", "flux", "klein", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "Turn the red square into a ripe red apple with a soft shadow", image: EDIT_EXAMPLE_IMAGE },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: `What to change (up to ${IMAGE_MAX_PROMPT_CHARS.toLocaleString()} chars)` },
          image: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: IMAGE_EDIT_MAX_REFS }],
            description: `One to ${IMAGE_EDIT_MAX_REFS} reference images, each base64 or a data: URL (PNG or JPEG, at least ${IMAGE_EDIT_MIN_SIDE}x${IMAGE_EDIT_MIN_SIDE}, up to ${IMAGE_EDIT_MAX_REF_BYTES / 1048576} MB each). Image URLs are not fetched.`,
          },
        },
        required: ["prompt", "image"],
      },
      output: { example: imageOutputExample(IMAGE_TIERS["v1-images-edit"].chain[0].model) },
    },
    handler: (input, req) => imageTierHandler("v1-images-edit", editInputFromMultipart(req) || input, req),
  },
  {
    route: `POST ${VIDEOS_PATH}`,
    name: "Video generation (4-second clip)",
    slug: "v1-videos",
    category: "llm",
    price: "$0.200",
    description:
      "Text-to-video over x402 - one silent 4-second 720p clip (MP4, inline base64) for a flat $0.20, served by Veo 3.1 Lite. Choose aspect_ratio 16:9 (default) or 9:16; duration, resolution and audio are fixed so the price is. The call returns when the clip is ready (about 40 seconds measured, up to 4 minutes). A failed or timed-out generation is not charged on x402, and a wallet payer whose request timed out can send it again unchanged to collect the same clip.",
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
