// Budget image tiers + bounded video tier (src/tools/llm-images-fast-kit.js)
// - offline, stub fetch. Pins: request shape on OpenRouter's dedicated media
// APIs (model, n locked, provider pin, locked params), cost stripped from the
// response, imageless -> 502, no key -> 503, chain walk on 502/503/504 only,
// live-listing repricing guard, margin bound (worst case <= MARGIN x price)
// for every link, and the video submit -> poll -> download loop (failed ->
// 502, timeout -> 504, off-host polling URL never followed), and parking:
// keyed on the EVM payer, claimed once, released on every terminal error.
//
//   node scripts/test-images-fast-kit.js
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.VIDEOS_POLL_MS = "5";
process.env.VIDEOS_MAX_WAIT_MS = "1000";
const {
  IMAGES_FAST_TOOLS, IMAGE_TIERS, IMAGES_FAST_PATH, IMAGES_PRO_PATH, IMAGES_EDIT_PATH, VIDEOS_PATH,
  IMAGE_EDIT_MAX_REFS, IMAGE_EDIT_MAX_REF_BYTES, editInputFromMultipart,
  OPENROUTER_IMAGES_URL, OPENROUTER_VIDEOS_URL,
  validateImageTierRequest, validateVideosRequest, linkRepriced, mediaMarginTable, withinMargin,
  VIDEOS_MODEL, VIDEOS_PRICE, VIDEOS_DURATION_SECONDS, videosWorstCaseUsd, linkBounds, _resetListingCacheForTest,
} = await import("../src/tools/llm-images-fast-kit.js");
const { MARGIN, IMAGES_MODEL, LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
const { _testEventsForTest } = await import("../src/posthog.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-images-fast-kit");
// Bounds come from the private table; mocked upstream bills are derived from
// them so no real rate is typed here.
const KLEIN3 = "black-forest-labs/flux-3-image-klein";
const linkOf = (tier, model) => IMAGE_TIERS[tier].chain.find((l) => l.model === model);
const KB = linkBounds(IMAGE_TIERS["v1-images-fast"].chain[0]), MB = linkBounds(linkOf("v1-images-fast", "openai/gpt-5-image-mini"));
const PB = linkBounds(IMAGE_TIERS["v1-images-pro"].chain[0]), QB = linkBounds(linkOf("v1-images-pro", KLEIN3));
const VW = videosWorstCaseUsd();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (slug) => IMAGES_FAST_TOOLS.find((t) => t.slug === slug);
const throws = async (fn, frag, m) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && String(e.message).includes(frag), `${m} (${e ? e.statusCode + " " + String(e.message).slice(0, 80) : "no throw"})`); return e; };
const lastGatewayEvent = () => _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();

// ---- registration / pricing ----
ok(IMAGES_FAST_TOOLS.length === 4, "four tools exported");
ok(bySlug("v1-images-edit")?.route === `POST ${IMAGES_EDIT_PATH}` && bySlug("v1-images-edit").price === "$0.020" && IMAGES_EDIT_PATH === "/v1/images/edits", "edit route at POST /v1/images/edits (OpenAI's path), $0.020");
ok(bySlug("v1-images-fast")?.route === `POST ${IMAGES_FAST_PATH}` && bySlug("v1-images-fast").price === "$0.020", "fast tier at POST /v1/images/fast, $0.020");
ok(bySlug("v1-images-pro")?.route === `POST ${IMAGES_PRO_PATH}` && bySlug("v1-images-pro").price === "$0.050", "pro tier at POST /v1/images/pro, $0.050");
ok(bySlug("v1-videos")?.route === `POST ${VIDEOS_PATH}` && bySlug("v1-videos").price === "$0.200", "video tier at POST /v1/videos/generations, $0.200");
ok(IMAGES_FAST_TOOLS.every((t) => t.discovery?.bodyType === "json" && t.discovery.input?.prompt && t.discovery.inputSchema?.required?.includes("prompt") && typeof t.handler === "function" && t.category === "llm"), "every tool carries a json discovery example with a prompt and a handler");
ok(IMAGES_FAST_TOOLS.every((t) => !/\u2014/.test(t.description + t.name)), "no em dashes in tool copy");
for (const [tier, t] of Object.entries(IMAGE_TIERS)) {
  ok(t.chain.length >= 1 && t.chain.every((l) => l.model && l.provider && linkBounds(l) && l.listed?.unit), `${tier}: every link has a provider pin, a bound and a listed-price check`);
  // Compare NUMBERS, not trimmed strings: a chain of trailing-zero replaces is
  // both fragile ("$10" would become "$1") and reads as a sanitizer.
  // v1-images is the flagship /v1/images/generations route, whose tool lives in the gateway kit.
  const tool = bySlug(tier) || LLM_GATEWAY_TOOLS.find((x) => x.slug === tier);
  ok(Math.abs(Number(t.price) - Number(String(tool.price).replace(/^\$/, ""))) < 1e-9, `${tier}: tool price matches the tier price`);
}
ok(IMAGE_TIERS["v1-images"].chain[0].model === IMAGES_MODEL && IMAGE_TIERS["v1-images"].path === "/v1/images/generations", "the /v1/images/generations links: first link is the model /v1/models advertises");
ok(IMAGE_TIERS["v1-images"].chain.every((l) => l.model !== "google/gemini-2.5-flash-image" && (l.params.output_format === "png" || l.model === "openai/gpt-5-image-mini")), "the route keeps its documented PNG output on every link (gpt-5-image-mini answers PNG natively)");
ok(JSON.stringify(IMAGE_TIERS["v1-images-fast"].chain.map((l) => l.model)) === JSON.stringify(["black-forest-labs/flux.2-klein-4b", KLEIN3, "openai/gpt-5-image-mini"]), "fast chain: Klein 4B, then FLUX 3 Image Klein, then GPT-5 Image Mini");
ok(JSON.stringify(IMAGE_TIERS["v1-images-pro"].chain.map((l) => l.model)) === JSON.stringify(["black-forest-labs/flux.2-pro", KLEIN3]), "pro chain: FLUX.2 Pro, then FLUX 3 Image Klein");
ok(IMAGE_TIERS["v1-images-edit"].edit === true && IMAGE_TIERS["v1-images-edit"].chain.length === 1 && IMAGE_TIERS["v1-images-edit"].chain[0].model === KLEIN3, "edit tier: FLUX 3 Image Klein");
for (const tier of ["v1-images-fast", "v1-images-pro"]) {
  const l = linkOf(tier, KLEIN3);
  ok(l.params.resolution === "1K" && l.params.aspect_ratio === "1:1" && l.listed.unit === "image" && l.listed.variant === "1k", `${tier}: Klein link pinned to 1K square, checked against the listed 1k line`);
}
ok(IMAGE_TIERS["v1-images-edit"].chain[0].params.resolution === "1K" && IMAGE_TIERS["v1-images-edit"].chain[0].params.aspect_ratio === undefined, "edit link pinned to 1K, aspect left to the reference");
const table = mediaMarginTable();
ok(table.length === 9 && table.every((r) => withinMargin(r.price, r.worst)), `margin: every link's bound is within the margin share of its tier price (${table.map((r) => `${r.model}@$${r.price}`).join(", ")})`);
ok(!withinMargin(1, MARGIN + 0.000001) && withinMargin(1, MARGIN), "withinMargin compares in micro-dollars (an exact boundary is equal, not a float near-miss)");
ok(VW > 0 && VW <= VIDEOS_PRICE * MARGIN + 1e-9, "video worst case is fixed by the locked 4 s duration and stays within bound");

// ---- image validation ----
ok(validateImageTierRequest({ prompt: " a fox " }, "v1-images-fast").prompt === "a fox", "prompt trims and validates");
ok(validateImageTierRequest({ prompt: "a fox", model: IMAGE_TIERS["v1-images-fast"].chain[0].model }, "v1-images-fast").prompt === "a fox", "the served model id is accepted");
ok(validateImageTierRequest({ prompt: "a fox", size: "1024x1024", quality: "hd", aspect_ratio: "16:9", style: "vivid" }, "v1-images-pro").prompt === "a fox", "cost-neutral OpenAI params (size/quality/aspect/style) are ignored, not rejected");
await throws(() => validateImageTierRequest({}, "v1-images-fast"), '"prompt" is required', "missing prompt -> 400");
await throws(() => validateImageTierRequest({ prompt: "x".repeat(4001) }, "v1-images-fast"), "Prompt too long", "prompt cap -> 400");
await throws(() => validateImageTierRequest({ prompt: "a fox", model: "dall-e-3" }, "v1-images-fast"), "fixed on this endpoint", "other model ids -> 400 naming the served model");
await throws(() => validateImageTierRequest({ prompt: "a fox", n: 2 }, "v1-images-pro"), "locked to 1", "n>1 -> 400 (price is per image)");
await throws(() => validateImageTierRequest({ prompt: "a fox", response_format: "url" }, "v1-images-fast"), "b64_json", "url response_format -> 400");
await throws(() => validateImageTierRequest({ prompt: "a fox", input_references: ["data:..."] }, "v1-images-fast"), "Reference images", "image-to-image refs -> 400 (billed extra upstream)");
await throws(() => validateImageTierRequest("nope", "v1-images-fast"), "JSON object", "non-object body -> 400");

// ---- repricing guard (pure) ----
{
  const klein = IMAGE_TIERS["v1-images-fast"].chain[0];
  const listing = (cost, tag = "black-forest-labs") => [{ provider_tag: tag, pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: cost }] }];
  ok(!linkRepriced(klein, listing(KB.listedMaxUsd)) && !linkRepriced(klein, listing(KB.listedMaxUsd * 0.7)), "listed price at or under the bound is not repriced");
  ok(linkRepriced(klein, listing(KB.listedMaxUsd * 1.07)), "listed price above the bound is repriced");
  ok(!linkRepriced(klein, null) && !linkRepriced(klein, []) && !linkRepriced(klein, listing(0.5, "someone-else")), "unreadable listing / provider gone -> fail-open (not repriced)");
  const k3 = linkOf("v1-images-pro", KLEIN3);
  ok(!linkRepriced(k3, [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "image", variant: "1k", cost_usd: QB.listedMaxUsd }, { billable: "output_image", unit: "image", variant: "4k", cost_usd: QB.listedMaxUsd * 30 }] }]), "variant-priced link checks ONLY its pinned variant (a 4K reprice does not trip the 1K pin)");
  ok(linkRepriced(k3, [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "image", variant: "1k", cost_usd: QB.listedMaxUsd * 1.03 }] }]), "pinned-variant reprice trips");
}

// ---- image handler (stubbed fetch) ----
const realFetch = globalThis.fetch;
const JPEG_B64 = Buffer.from("fake-jpeg-bytes".repeat(4)).toString("base64");
let calls = [];
let listingReply = null; // null -> listing unreadable (fail-open)
let perModel = {};       // model -> (body) => { status, json } | throws
function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/images/models/") && u.endsWith("/endpoints")) {
      if (!listingReply) return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => listingReply(u), text: async () => JSON.stringify(listingReply(u)) };
    }
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method: init.method || "GET", body, headers: init.headers || {} });
    const cost = body?.model === "openai/gpt-5-image-mini" ? MB.worstCaseUsd * 0.6 : body?.model === KLEIN3 ? QB.worstCaseUsd : KB.worstCaseUsd;
    const r = perModel[body?.model] ? perModel[body.model](body) : { status: 200, json: { created: 1, data: [{ b64_json: JPEG_B64, media_type: "image/jpeg" }], usage: { prompt_tokens: 11, completion_tokens: 4096, total_tokens: 4107, cost, is_byok: false, cost_details: { upstream_inference_cost: cost } } } };
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.json), json: async () => r.json, headers: { get: () => "application/json" } };
  };
}
installFetch();

// no key -> 503 before any upstream call
delete process.env.OPENROUTER_API_KEY;
{
  const e = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "not configured", "no OPENROUTER_API_KEY -> 503");
  ok(e?.statusCode === 503 && calls.length === 0, "503 carries statusCode and nothing was fetched");
}
process.env.OPENROUTER_API_KEY = "test-key";

// happy path: fast tier, primary link
{
  calls = []; perModel = {};
  const out = await bySlug("v1-images-fast").handler({ prompt: "a fox", n: 1, size: "1024x1024" });
  const c = calls[0];
  ok(c.url === OPENROUTER_IMAGES_URL && c.method === "POST", "upstream call hits OpenRouter's dedicated Image API");
  ok(c.body.model === "black-forest-labs/flux.2-klein-4b" && c.body.n === 1 && c.body.prompt === "a fox", "request: primary model, n locked to 1, prompt");
  ok(Array.isArray(c.body.provider?.only) && c.body.provider.only[0] === "black-forest-labs", "request pins the provider the bound was priced on (provider.only)");
  ok(c.body.size === undefined && c.body.quality === undefined && c.body.input_references === undefined, "buyer size/quality never ride upstream (output locked at the measured default)");
  ok(String(c.headers.Authorization || "").startsWith("Bearer test-key"), "bearer key on the request");
  ok(out.data.length === 1 && out.data[0].b64_json === JPEG_B64 && out.data[0].media_type === "image/jpeg" && typeof out.created === "number" && out.model === "black-forest-labs/flux.2-klein-4b", "OpenAI images response shape: created/model/data[b64_json, media_type]");
  ok(out.usage && out.usage.cost === undefined && out.usage.cost_details === undefined && out.usage.is_byok === undefined && out.usage.total_tokens === 4107, "usage passes with cost/cost_details/is_byok stripped");
  ok(!JSON.stringify(out).includes(String(KB.worstCaseUsd)), "the upstream bill appears nowhere in the response");
  const ev = lastGatewayEvent();
  ok(ev?.properties.tier === "v1-images-fast" && ev?.properties.upstreamUsd === KB.worstCaseUsd && ev?.properties.priceUsd === 0.02 && ev?.properties.model === "black-forest-labs/flux.2-klein-4b", "gateway_usage telemetry: tier/price/upstream/model");
  ok(calls.length === 1, "exactly one upstream call on the happy path");
}

// pro tier happy path: pro primary + locked params
{
  calls = []; perModel = { "black-forest-labs/flux.2-pro": () => ({ status: 200, json: { data: [{ b64_json: JPEG_B64, media_type: "image/jpeg" }], usage: { cost: PB.worstCaseUsd } } }) };
  const out = await bySlug("v1-images-pro").handler({ prompt: "a desk" });
  ok(calls[0].body.model === "black-forest-labs/flux.2-pro" && calls[0].body.provider.only[0] === "black-forest-labs" && out.model === "black-forest-labs/flux.2-pro" && out.usage.cost === undefined, "pro tier serves flux.2-pro first, cost stripped");
}

// failover: primary 502 -> failover link with its locked params; 400 does NOT walk
{
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 502, json: { error: { message: "provider down" } } }) };
  const out = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 2 && calls[1].body.model === KLEIN3 && calls[1].body.resolution === "1K" && calls[1].body.aspect_ratio === "1:1" && calls[1].body.provider.only[0] === "black-forest-labs" && calls[1].body.input_references === undefined && out.model === KLEIN3, "primary 502 walks to FLUX 3 Image Klein at 1K square on its provider");
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 502, json: {} }), [KLEIN3]: () => ({ status: 502, json: {} }) };
  const outMini = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 3 && calls[2].body.model === "openai/gpt-5-image-mini" && calls[2].body.quality === "medium" && calls[2].body.provider.only[0] === "openai" && outMini.model === "openai/gpt-5-image-mini", "both Klein links down -> GPT-5 Image Mini with its locked quality + provider pin");
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 429, json: { error: { message: "slow down" } } }) };
  const out2 = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 2 && out2.model === KLEIN3, "upstream 429 (-> 503) walks the chain too");
  // An upstream 4xx (e.g. a provider safety refusal) is a 502 on our side, so
  // the chain walks to the failover; refused end to end -> 502, not charged.
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 400, json: { error: { message: "prompt rejected by safety" } } }), "openai/gpt-5-image-mini": () => ({ status: 400, json: { error: { message: "prompt rejected by safety" } } }), [KLEIN3]: () => ({ status: 400, json: { error: { message: "prompt rejected by safety" } } }) };
  const e = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "Upstream error: prompt rejected", "upstream 4xx on every link -> 502 carrying the upstream message");
  ok(e?.statusCode === 502 && calls.length === 3, "…every link tried, 502 (settlement cancelled)");
  calls = []; perModel = { "black-forest-labs/flux.2-pro": () => ({ status: 503, json: {} }) };
  const out3 = await bySlug("v1-images-pro").handler({ prompt: "a desk" });
  ok(calls.length === 2 && calls[1].body.model === KLEIN3 && calls[1].body.resolution === "1K" && calls[1].body.aspect_ratio === "1:1" && calls[1].body.provider.only[0] === "black-forest-labs" && out3.model === KLEIN3, "pro failover pins FLUX 3 Image Klein at 1K square on its provider");
}

// imageless -> 502 (walks, then 502 end to end); malformed -> 502
{
  calls = []; perModel = {
    "black-forest-labs/flux.2-klein-4b": () => ({ status: 200, json: { data: [], usage: { cost: 0 } } }),
    "openai/gpt-5-image-mini": () => ({ status: 200, json: { data: [{ b64_json: "" }] } }),
    [KLEIN3]: () => ({ status: 200, json: { data: [] } }),
  };
  const e = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "no image", "imageless upstream on every link -> 502");
  ok(e?.statusCode === 502 && calls.length === 3, "…every link tried, 502 (not charged)");
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 200, json: { data: [{ b64_json: JPEG_B64 }] } }) };
  const out = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(out.data[0].b64_json === JPEG_B64 && out.data[0].media_type === undefined && out.usage === undefined, "no usage / no media_type upstream -> still a valid image response, fields omitted");
  calls = []; globalThis.fetch = async (url, init) => ({ ok: true, status: 200, text: async () => "<html>", json: async () => ({}) });
  const e2 = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "non-JSON", "non-JSON upstream -> 502");
  ok(e2?.statusCode === 502, "…502");
  installFetch();
}

// live-listing repricing guard in the handler
{
  _resetListingCacheForTest();
  calls = []; perModel = {};
  listingReply = (u) => u.includes("flux.2-klein-4b")
    ? { data: { id: "black-forest-labs/flux.2-klein-4b", endpoints: [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: KB.listedMaxUsd * 1.4 }] }] } }
    : { data: { endpoints: [{ provider_tag: "openai", pricing: [{ billable: "output_image", unit: "token", cost_usd: MB.listedMaxUsd }] }] } };
  const out = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 1 && calls[0].body.model === KLEIN3 && out.model === KLEIN3, "a primary repriced ABOVE its bound on the live listing is skipped before any spend; the failover serves");
  listingReply = () => ({ data: { endpoints: [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: KB.listedMaxUsd * 1.4 }, { billable: "output_image", unit: "image", variant: "1k", cost_usd: QB.listedMaxUsd * 1.25 }] }, { provider_tag: "openai", pricing: [{ billable: "output_image", unit: "token", cost_usd: MB.listedMaxUsd * 1.25 }] }] } });
  _resetListingCacheForTest(); calls = [];
  const e = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "repriced", "chain repriced end to end -> 503, nothing spent");
  ok(e?.statusCode === 503 && calls.length === 0, "…503 and zero upstream generation calls");
  _resetListingCacheForTest(); listingReply = null;
}

// ---- video validation ----
ok(validateVideosRequest({ prompt: "a boat" }).aspect_ratio === "16:9", "video: aspect defaults to 16:9");
ok(validateVideosRequest({ prompt: "a boat", aspect_ratio: "9:16" }).aspect_ratio === "9:16" && validateVideosRequest({ prompt: "a boat", size: "720x1280" }).aspect_ratio === "9:16", "video: 9:16 by aspect_ratio or OpenAI-style size");
ok(validateVideosRequest({ prompt: "a boat", duration: 4, resolution: "720p", model: VIDEOS_MODEL, generate_audio: false, n: 1 }).prompt === "a boat", "video: the locked values are accepted when sent explicitly");
await throws(() => validateVideosRequest({ prompt: "a boat", duration: 8 }), "locked to 4", "video: other durations -> 400 (price is per 4 s clip)");
await throws(() => validateVideosRequest({ prompt: "a boat", seconds: 8 }), "locked to 4", "video: OpenAI-style seconds -> 400 too");
await throws(() => validateVideosRequest({ prompt: "a boat", resolution: "1080p" }), "locked to 720p", "video: other resolutions -> 400");
await throws(() => validateVideosRequest({ prompt: "a boat", generate_audio: true }), "audio", "video: audio -> 400 (doubles the upstream bill)");
await throws(() => validateVideosRequest({ prompt: "a boat", aspect_ratio: "4:3" }), "aspect_ratio", "video: unsupported aspect -> 400");
await throws(() => validateVideosRequest({ prompt: "a boat", frame_images: [{}] }), "Reference / frame", "video: image-to-video inputs -> 400");
await throws(() => validateVideosRequest({ prompt: "a boat", model: "openai/sora-2-pro" }), "fixed to", "video: other models -> 400");
await throws(() => validateVideosRequest({ prompt: "x".repeat(2001) }), "Prompt too long", "video: prompt cap");

// ---- video handler (stubbed fetch): submit -> poll -> download ----
const MP4 = Buffer.from("\0\0\0 ftypisom-fake-mp4-bytes");
function installVideoFetch({ statuses = ["pending", "in_progress", "completed"], contentStatus = 200, contentStatuses, pollHttp = [], pollingUrl, submitStatus = 202, failError, submitId = "job1" } = {}) {
  let contentCalls = 0, pollCalls = 0;
  let polls = 0; const seen = { submit: null, submits: 0, polls: [], content: null };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST") {
      seen.submit = { url: u, body: JSON.parse(init.body), auth: init.headers?.Authorization };
      seen.submits++;
      const j = { id: submitId, polling_url: pollingUrl ?? `${OPENROUTER_VIDEOS_URL}/${submitId}`, status: "pending" };
      return { ok: submitStatus < 400, status: submitStatus, text: async () => JSON.stringify(submitStatus < 400 ? j : { error: { message: "bad" } }) };
    }
    if (u.includes("/content")) {
      seen.content = { url: u, auth: init.headers?.Authorization };
      seen.contentCalls = ++contentCalls;
      const cs = contentStatuses ? contentStatuses[Math.min(contentCalls - 1, contentStatuses.length - 1)] : contentStatus;
      if (cs === "throw") throw new TypeError("fetch failed");
      if (cs !== contentStatus) return { ok: cs < 400, status: cs, headers: { get: (h) => (h === "content-type" ? "video/mp4" : null) }, arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength), text: async () => "" };
      return { ok: contentStatus < 400, status: contentStatus, headers: { get: (h) => (h === "content-type" ? "video/mp4" : null) }, arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength), text: async () => "" };
    }
    seen.polls.push({ url: u, auth: init.headers?.Authorization });
    const h = pollHttp[pollCalls++];
    if (h === "throw") throw new TypeError("fetch failed");
    if (h === "garbled") return { ok: true, status: 200, text: async () => "<html>" };
    if (typeof h === "number") return { ok: false, status: h, text: async () => JSON.stringify({ error: { message: "upstream hiccup" } }) };
    const s = statuses[Math.min(polls++, statuses.length - 1)];
    const j = { id: "job1", status: s, ...(s === "completed" ? { unsigned_urls: [`${OPENROUTER_VIDEOS_URL}/job1/content?index=0`], usage: { cost: VW, is_byok: false } } : {}), ...(s === "failed" ? { error: failError ?? "content policy" } : {}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(j) };
  };
  return seen;
}
{
  const seen = installVideoFetch();
  const out = await bySlug("v1-videos").handler({ prompt: "a boat", aspect_ratio: "9:16" });
  ok(seen.submit.url === OPENROUTER_VIDEOS_URL && seen.submit.body.model === VIDEOS_MODEL && seen.submit.body.duration === 4 && seen.submit.body.resolution === "720p" && seen.submit.body.generate_audio === false && seen.submit.body.aspect_ratio === "9:16", "video submit: locked model/duration/resolution/no-audio + chosen aspect on the Video API");
  ok(seen.polls.length === 3 && seen.polls.every((p) => p.url === `${OPENROUTER_VIDEOS_URL}/job1` && String(p.auth).startsWith("Bearer ")), "polls the job with our key until completed");
  ok(seen.content && seen.content.url === `${OPENROUTER_VIDEOS_URL}/job1/content?index=0` && String(seen.content.auth).startsWith("Bearer "), "downloads the clip with our key (unsigned URLs 401 without it)");
  ok(out.data[0].b64_json === MP4.toString("base64") && out.data[0].media_type === "video/mp4" && out.data[0].duration_seconds === 4 && out.data[0].resolution === "720p" && out.data[0].aspect_ratio === "9:16" && out.model === VIDEOS_MODEL, "video response: inline mp4 base64 + the locked facts");
  ok(out.usage && out.usage.cost === undefined && !JSON.stringify(out).includes(String(VW)) && !JSON.stringify(out).includes("job1"), "upstream cost and job id appear nowhere in the response");
  const ev = lastGatewayEvent();
  ok(ev?.properties.tier === "v1-videos" && ev?.properties.upstreamUsd === VW && ev?.properties.priceUsd === VIDEOS_PRICE, "video telemetry: tier/price/upstream");
}
{
  installVideoFetch({ statuses: ["failed"], failError: { message: "blocked by policy" } });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "failed upstream", "job failed -> 502 (not charged)");
  ok(e?.statusCode === 502 && String(e.message).includes("blocked by policy"), "…502 carries the short upstream reason");
}
// Parking is keyed on the signed EVM payer (payerFromRequest): a request with
// no such identity never parks or resumes, so two buyers sending the same
// prompt cannot share a clip.
const payReq = (payload) => {
  const h = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined), ip: "203.0.113.9" };
};
const evmReq = (n = 1) => payReq({ x402Version: 2, payload: { signature: "0x00", authorization: { from: `0x${String(n).padStart(40, "a")}` } } });
const svmReq = () => payReq({ x402Version: 2, accepted: { scheme: "exact", network: "solana:mainnet" }, payload: { transaction: "AQAB" } });
{
  installVideoFetch({ statuses: ["pending"] });
  const t0 = Date.now();
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }, evmReq(1)), "did not finish", "job never completes -> 504 after the wait budget");
  ok(e?.statusCode === 504 && Date.now() - t0 >= 900, "…504 after VIDEOS_MAX_WAIT_MS");
  ok(/same request again/.test(e?.message || "") && /not charged on x402/.test(e?.message || "") && !/job1/.test(e?.message || ""), "…504 tells an EVM payer to resend to collect the clip, scoped to x402, without naming the job");
  // The retry the 504 asks for resumes the SAME upstream job instead of paying for a new one.
  const seen = installVideoFetch();
  const out = await bySlug("v1-videos").handler({ prompt: "a boat" }, evmReq(1));
  ok(!seen.submit && seen.polls.length > 0 && seen.polls.every((p) => p.url === `${OPENROUTER_VIDEOS_URL}/job1`) && out.data[0].b64_json === MP4.toString("base64"), "an identical retry from the same EVM payer polls the parked job and submits nothing new");
  const again = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: "a boat" }, evmReq(1));
  ok(!!again.submit, "once collected the parked job is released; the next identical request submits a fresh job");
}
{
  installVideoFetch({ statuses: ["pending"] });
  await throws(() => bySlug("v1-videos").handler({ prompt: "a different boat" }, evmReq(1)), "did not finish", "a second timed-out request parks its own job");
  const seen = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: "another prompt entirely" }, evmReq(1));
  ok(!!seen.submit, "a different request never picks up someone else's parked job");
  const other = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: "a different boat" }, evmReq(2));
  ok(!!other.submit, "another EVM payer sending the same prompt never picks up the parked job");
  const resume = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: "a different boat" }, evmReq(1));
  ok(!resume.submit, "and the parked one is still collected by its own payer's retry");
}
for (const [label, mk] of [["no payment header", () => undefined], ["a non-EVM payer", svmReq]]) {
  installVideoFetch({ statuses: ["pending"] });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "an unkeyed boat" }, mk()), "did not finish", `${label}: timeout -> 504`);
  ok(e?.statusCode === 504 && !/collect/.test(e?.message || "") && /not charged on x402/.test(e?.message || ""), `${label}: the 504 promises no collection and scopes the charge to x402`);
  const seen = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: "an unkeyed boat" }, mk());
  ok(seen.submits === 1, `${label}: an identical retry submits its own job (nothing was parked)`);
}
{
  // Two concurrent identical retries: one claims the parked clip, the other
  // submits its own job, so one clip is never collected twice.
  installVideoFetch({ statuses: ["pending"] });
  await throws(() => bySlug("v1-videos").handler({ prompt: "a contested boat" }, evmReq(3)), "did not finish", "concurrent: a timed-out request parks its job");
  const seen = installVideoFetch({ submitId: "job2" });
  const [a, b] = await Promise.all([bySlug("v1-videos").handler({ prompt: "a contested boat" }, evmReq(3)), bySlug("v1-videos").handler({ prompt: "a contested boat" }, evmReq(3))]);
  const polled = new Set(seen.polls.map((p) => p.url));
  ok(!!a?.data && !!b?.data && seen.submits === 1 && polled.has(`${OPENROUTER_VIDEOS_URL}/job1`) && polled.has(`${OPENROUTER_VIDEOS_URL}/job2`), "concurrent: exactly one retry resumes the parked job and the other submits a new one");
}
for (const [label, opts] of [["a non-transient poll status", { pollHttp: [401] }], ["the poll-failure limit", { pollHttp: [502, 502, 502, 502, 502, 502] }], ["a non-transient content status", { contentStatuses: [404] }]]) {
  // A resumed job that ends in a terminal error is released: the next retry
  // submits fresh instead of resuming a dead job.
  installVideoFetch({ statuses: ["pending"] });
  await throws(() => bySlug("v1-videos").handler({ prompt: `a doomed boat ${label}` }, evmReq(4)), "did not finish", `${label}: a timed-out request parks its job`);
  installVideoFetch(opts);
  await throws(() => bySlug("v1-videos").handler({ prompt: `a doomed boat ${label}` }, evmReq(4)), "pstream", `${label}: the resumed job ends in a terminal error`);
  const seen = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: `a doomed boat ${label}` }, evmReq(4));
  ok(seen.submits === 1, `${label}: the dead job is no longer parked; the next retry submits fresh`);
}
{
  const seen = installVideoFetch({ pollingUrl: "https://evil.example/steal?job=1" });
  await bySlug("v1-videos").handler({ prompt: "a boat" });
  ok(seen.polls.every((p) => p.url.startsWith(OPENROUTER_VIDEOS_URL)), "an off-host polling_url is never followed with our key (job id polled on our upstream instead)");
}
{
  installVideoFetch({ contentStatus: 500 });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "Upstream error", "content download failure -> 502");
  ok(e?.statusCode === 502, "…502");
}
{
  // Transient poll failures keep polling; the clip is still delivered.
  const seen = installVideoFetch({ pollHttp: [500, "throw", 429, "garbled"] });
  const out = await bySlug("v1-videos").handler({ prompt: "a boat" });
  ok(out?.data?.[0]?.b64_json === MP4.toString("base64") && seen.polls.length === 7, "transient poll failures (5xx, network, 429, garbled) keep polling to completion");
}
{
  const seen = installVideoFetch({ pollHttp: [502, 502, 502, 502, 502, 502, 502] });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "Upstream error", "five consecutive poll failures end the request");
  ok(e?.statusCode === 502 && seen.polls.length === 5, "…502 after exactly five failed polls");
}
{
  const seen = installVideoFetch({ pollHttp: [401] });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "auth", "a non-transient poll status (401) still ends the request at once");
  ok(e?.statusCode === 502 && seen.polls.length === 1, "…on the first poll");
}
{
  const seen = installVideoFetch({ contentStatuses: [503, "throw", 200] });
  const out = await bySlug("v1-videos").handler({ prompt: "a boat" });
  ok(out?.data?.[0]?.b64_json === MP4.toString("base64") && seen.contentCalls === 3, "the content download is retried twice on transient failures");
}
{
  const seen = installVideoFetch({ contentStatuses: [500, 500, 500, 200] });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "Upstream error", "content download retries are capped at two extra");
  ok(e?.statusCode === 502 && seen.contentCalls === 3, "…three content requests in all");
}
{
  const seen = installVideoFetch({ contentStatuses: [404, 200] });
  await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "Upstream error", "a non-transient content status is not retried");
  ok(seen.contentCalls === 1, "…one content request");
}
{
  installVideoFetch({ submitStatus: 402 });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "balance", "upstream 402 on submit -> 502 (operator problem, buyer not charged)");
  ok(e?.statusCode === 502, "…502");
}
{
  delete process.env.OPENROUTER_API_KEY;
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "not configured", "video: no key -> 503");
  ok(e?.statusCode === 503, "…503");
  process.env.OPENROUTER_API_KEY = "test-key";
}

// ---- per-buyer `user` rides every media call (2026-09-18) ----
// These three routes sent no `user`, which the OpenRouter log showed as an
// empty Client User ID on every FLUX / Veo row while every chat row carried
// one. It is what scopes an upstream provider policy block to ONE buyer, so
// without it an abusive caller here is unattributed and the blast radius is
// the whole account. A request we cannot key sends none rather than a
// placeholder - a shared constant would be worse than absent, since it would
// pool every buyer under one id upstream.
{
  const { upstreamUserId } = await import("../src/tools/llm-gateway-kit.js");
  // upstreamUserId reads the payment header, else the authorization header,
  // else the client address, through Express's own req.header().
  const req = { ip: "203.0.113.7", headers: {}, header: (n) => (String(n).toLowerCase() === "x-forwarded-for" ? "203.0.113.7" : null) };
  const expected = upstreamUserId(req);
  ok(typeof expected === "string" && expected.startsWith("a402:"), `upstreamUserId keys a request (${expected})`);

  installFetch(); calls = []; listingReply = null; perModel = {};
  await bySlug("v1-images-fast").handler({ prompt: "a fox" }, req);
  ok(calls.length === 1 && calls[0].body.user === expected, "images/fast sends the per-buyer user id");

  calls = [];
  await bySlug("v1-images-pro").handler({ prompt: "a fox" }, req);
  ok(calls.length === 1 && calls[0].body.user === expected, "images/pro sends it too");

  calls = [];
  await bySlug("v1-images-fast").handler({ prompt: "a fox" }, null);
  ok(calls.length === 1 && !("user" in calls[0].body), "a request we cannot key sends NO user, never a shared placeholder");

  const seen = installVideoFetch();
  await bySlug("v1-videos").handler({ prompt: "a boat" }, req);
  ok(seen.submit.body.user === expected, "videos sends it on the submit call");
}

// ---- image edit (/v1/images/edits) ----
{
  installFetch();
  const { examplePngBase64 } = await import("../src/tools/judge-preview-kit.js");
  const PNG = Buffer.from(examplePngBase64(), "base64"); // 300x300
  // A JPEG whose SOF0 frame names its size (the reader stops there).
  const jpegOf = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]), Buffer.alloc(32, 1)]);
  const JPG = jpegOf(640, 480);
  const edit = bySlug("v1-images-edit");
  const v = (input) => validateImageTierRequest(input, "v1-images-edit");
  ok(v({ prompt: "green", image: PNG.toString("base64") }).refs[0].startsWith("data:image/png;base64,"), "raw base64 accepted; the type is read from the bytes");
  ok(v({ prompt: "green", image: `data:image/png;base64,${JPG.toString("base64")}` }).refs[0].startsWith("data:image/jpeg;base64,"), "a declared type is never trusted: JPEG bytes labeled PNG go up as JPEG");
  ok(v({ prompt: "green", image: [{ image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }, JPG.toString("base64")] }).refs.length === 2, "image as an array of strings or {image_url} objects");
  ok(v({ prompt: "green", images: [PNG.toString("base64")] }).refs.length === 1, "\"images\" is read too");
  ok(v(edit.discovery.input).refs[0].startsWith("data:image/png;base64,"), "the published example carries a real image the route accepts");
  await throws(() => v({ prompt: "green" }), '"image" is required', "no reference -> 400");
  await throws(() => v({ prompt: "green", image: Array(IMAGE_EDIT_MAX_REFS + 1).fill(PNG.toString("base64")) }), `At most ${IMAGE_EDIT_MAX_REFS}`, "too many references -> 400");
  await throws(() => v({ prompt: "green", image: Buffer.from("not an image at all").toString("base64") }), "not a PNG or JPEG", "non-image bytes -> 400");
  await throws(() => v({ prompt: "green", image: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]).toString("base64") }), "not a PNG or JPEG", "WebP -> 400 (its size cannot be checked here)");
  await throws(() => v({ prompt: "green", image: jpegOf(255, 900).toString("base64") }), "at least 256x256", "a side under the provider's 256 px minimum -> 400 before any spend");
  ok(v({ prompt: "green", image: jpegOf(256, 256).toString("base64") }).refs.length === 1, "256x256 exactly is accepted");
  await throws(() => v({ prompt: "green", image: "https://example.com/a.png" }), "not fetched", "an image URL is refused, never fetched");
  await throws(() => v({ prompt: "green", image: "data:image/png,rawtext" }), "base64-encoded", "a non-base64 data: URL -> 400");
  await throws(() => v({ prompt: "green", image: "%%%" }), "not valid base64", "garbage -> 400");
  await throws(() => v({ prompt: "green", image: Buffer.concat([PNG, Buffer.alloc(IMAGE_EDIT_MAX_REF_BYTES)]).toString("base64") }), "each reference image may be up to", "an oversized reference -> 400");
  await throws(() => v({ prompt: "green", image: PNG.toString("base64"), mask: PNG.toString("base64") }), '"mask" is not accepted', "mask -> 400");
  await throws(() => v({ image: PNG.toString("base64") }), '"prompt" is required', "edit still needs a prompt");
  await throws(() => validateImageTierRequest({ prompt: "a fox", image: PNG.toString("base64") }, "v1-images-pro"), IMAGES_EDIT_PATH, "text-to-image tiers point reference images at the edit route");

  calls = []; perModel = {};
  const out = await edit.handler({ prompt: "make it green", image: [PNG.toString("base64"), JPG.toString("base64")], size: "512x512" }, null);
  const c = calls[0];
  ok(calls.length === 1 && c.body.model === KLEIN3 && c.body.n === 1 && c.body.resolution === "1K" && c.body.aspect_ratio === undefined && c.body.provider.only[0] === "black-forest-labs", "edit call: Klein at 1K, aspect left to the reference, provider pinned");
  ok(Array.isArray(c.body.input_references) && c.body.input_references.length === 2 && c.body.input_references.every((r) => r.type === "image_url" && r.image_url.url.startsWith("data:image/")) && c.body.image === undefined && c.body.size === undefined, "references ride as input_references data URLs; buyer fields do not ride upstream");
  ok(out.model === KLEIN3 && out.data[0].b64_json === JPEG_B64 && out.usage.cost === undefined, "edit answers the OpenAI images shape, cost stripped");
  ok(lastGatewayEvent()?.properties.tier === "v1-images-edit" && lastGatewayEvent()?.properties.priceUsd === 0.02, "edit telemetry names its tier and price");

  calls = []; perModel = { [KLEIN3]: () => ({ status: 502, json: {} }) };
  const e = await throws(() => edit.handler({ prompt: "green", image: PNG.toString("base64") }, null), "Upstream", "edit link down -> 5xx (not charged)");
  ok([502, 503].includes(e?.statusCode) && calls.length === 1, "…one link, one call");

  // multipart: OpenAI's images.edit() wire.
  const boundary = "----a402test";
  const mp = (parts) => Buffer.concat(parts.flatMap((p) => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"\r\nContent-Type: image/png` : ""}\r\n\r\n`), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from("\r\n")]).concat([Buffer.from(`--${boundary}--\r\n`)]));
  const req = (body) => ({ headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
  calls = []; perModel = {};
  const out2 = await edit.handler({}, req(mp([{ name: "image", filename: "a.png", value: PNG }, { name: "prompt", value: "make it green" }, { name: "model", value: KLEIN3 }])));
  ok(calls.length === 1 && calls[0].body.prompt === "make it green" && calls[0].body.input_references?.length === 1 && calls[0].body.input_references[0].image_url.url.startsWith("data:image/png;base64,") && out2.model === KLEIN3, "multipart image file + prompt field is served");
  calls = [];
  await throws(() => edit.handler({}, req(mp([{ name: "prompt", value: "green" }]))), 'no "image" file part', "multipart without a file -> 400");
  await throws(() => edit.handler({}, req(mp([{ name: "image", filename: "a.png", value: Buffer.from("text") }, { name: "prompt", value: "green" }]))), "not a PNG or JPEG", "multipart non-image -> 400");
  await throws(() => edit.handler({}, req(mp([{ name: "image", filename: "a.png", value: PNG }, { name: "prompt", value: "green" }, { name: "n", value: "2" }]))), "locked to 1", "multipart n=2 -> 400");
  ok(calls.length === 0, "…refused before any upstream call");
  ok(editInputFromMultipart({ headers: { "content-type": "application/json" }, body: {} }) === null, "a JSON request is not read as multipart");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
