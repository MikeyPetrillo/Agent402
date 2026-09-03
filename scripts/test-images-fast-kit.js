// Budget image tiers + bounded video tier (src/tools/llm-images-fast-kit.js)
// - offline, stub fetch. Pins: request shape on OpenRouter's dedicated media
// APIs (model, n locked, provider pin, locked params), cost stripped from the
// response, imageless -> 502, no key -> 503, chain walk on 502/503/504 only,
// live-listing repricing guard, margin bound (worst case <= MARGIN x price)
// for every link, and the video submit -> poll -> download loop (failed ->
// 502, timeout -> 504, off-host polling URL never followed).
//
//   node scripts/test-images-fast-kit.js
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.VIDEOS_POLL_MS = "5";
process.env.VIDEOS_MAX_WAIT_MS = "1000";
const {
  IMAGES_FAST_TOOLS, IMAGE_TIERS, IMAGES_FAST_PATH, IMAGES_PRO_PATH, VIDEOS_PATH,
  OPENROUTER_IMAGES_URL, OPENROUTER_VIDEOS_URL,
  validateImageTierRequest, validateVideosRequest, linkRepriced, mediaMarginTable, withinMargin,
  VIDEOS_MODEL, VIDEOS_PRICE, VIDEOS_DURATION_SECONDS, VIDEOS_WORST_CASE_USD, _resetListingCacheForTest,
} = await import("../src/tools/llm-images-fast-kit.js");
const { MARGIN } = await import("../src/tools/llm-gateway-kit.js");
const { _testEventsForTest } = await import("../src/posthog.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (slug) => IMAGES_FAST_TOOLS.find((t) => t.slug === slug);
const throws = async (fn, frag, m) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && String(e.message).includes(frag), `${m} (${e ? e.statusCode + " " + String(e.message).slice(0, 80) : "no throw"})`); return e; };
const lastGatewayEvent = () => _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();

// ---- registration / pricing ----
ok(IMAGES_FAST_TOOLS.length === 3, "three tools exported");
ok(bySlug("v1-images-fast")?.route === `POST ${IMAGES_FAST_PATH}` && bySlug("v1-images-fast").price === "$0.020", "fast tier at POST /v1/images/fast, $0.020");
ok(bySlug("v1-images-pro")?.route === `POST ${IMAGES_PRO_PATH}` && bySlug("v1-images-pro").price === "$0.050", "pro tier at POST /v1/images/pro, $0.050");
ok(bySlug("v1-videos")?.route === `POST ${VIDEOS_PATH}` && bySlug("v1-videos").price === "$0.200", "video tier at POST /v1/videos/generations, $0.200");
ok(IMAGES_FAST_TOOLS.every((t) => t.discovery?.bodyType === "json" && t.discovery.input?.prompt && t.discovery.inputSchema?.required?.includes("prompt") && typeof t.handler === "function" && t.category === "llm"), "every tool carries a json discovery example with a prompt and a handler");
ok(IMAGES_FAST_TOOLS.every((t) => !/\u2014/.test(t.description + t.name)), "no em dashes in tool copy");
for (const [tier, t] of Object.entries(IMAGE_TIERS)) {
  ok(t.chain.length === 2 && t.chain.every((l) => l.model && l.provider && typeof l.worstCaseUsd === "number" && l.listed?.unit && typeof l.listed.maxCostUsd === "number"), `${tier}: primary + one failover, each with a provider pin, a bound and a listed-price check`);
  // Compare NUMBERS, not trimmed strings: a chain of trailing-zero replaces is
  // both fragile ("$10" would become "$1") and reads as a sanitizer.
  ok(Math.abs(Number(t.price) - Number(String(bySlug(tier).price).replace(/^\$/, ""))) < 1e-9, `${tier}: tool price matches the tier price`);
}
const table = mediaMarginTable();
ok(table.length === 5 && table.every((r) => withinMargin(r.price, r.worst)), `margin: every link's bound is <= ${MARGIN * 100}% of its tier price (${table.map((r) => `${r.model}@$${r.price}:$${r.worst}`).join(", ")})`);
ok(!withinMargin(0.02, 0.0141) && withinMargin(0.02, 0.014), "withinMargin compares in micro-dollars (70% of $0.02 is exactly $0.014, not a float near-miss)");
ok(Math.abs(VIDEOS_WORST_CASE_USD - 0.03 * VIDEOS_DURATION_SECONDS) < 1e-9 && VIDEOS_WORST_CASE_USD <= VIDEOS_PRICE * MARGIN + 1e-9, "video bound = listed $0.03/s x locked 4 s = $0.12 under 70% of $0.20");

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
  ok(!linkRepriced(klein, listing(0.014)) && !linkRepriced(klein, listing(0.01)), "listed price at or under the bound is not repriced");
  ok(linkRepriced(klein, listing(0.015)), "listed price above the bound is repriced");
  ok(!linkRepriced(klein, null) && !linkRepriced(klein, []) && !linkRepriced(klein, listing(0.5, "someone-else")), "unreadable listing / provider gone -> fail-open (not repriced)");
  const qwen = IMAGE_TIERS["v1-images-pro"].chain[1];
  ok(!linkRepriced(qwen, [{ provider_tag: "alibaba", pricing: [{ billable: "output_image", unit: "image", variant: "1k", cost_usd: 0.03 }, { billable: "output_image", unit: "image", variant: "2k", cost_usd: 0.9 }] }]), "variant-priced link checks ONLY its pinned variant (a 2K reprice does not trip the 1K pin)");
  ok(linkRepriced(qwen, [{ provider_tag: "alibaba", pricing: [{ billable: "output_image", unit: "image", variant: "1k", cost_usd: 0.031 }] }]), "pinned-variant reprice trips");
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
    const cost = body?.model === "openai/gpt-5-image-mini" ? 0.0085 : 0.014;
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
  ok(!JSON.stringify(out).includes("0.014"), "the upstream bill appears nowhere in the response");
  const ev = lastGatewayEvent();
  ok(ev?.properties.tier === "v1-images-fast" && ev?.properties.upstreamUsd === 0.014 && ev?.properties.priceUsd === 0.02 && ev?.properties.model === "black-forest-labs/flux.2-klein-4b", "gateway_usage telemetry: tier/price/upstream/model");
  ok(calls.length === 1, "exactly one upstream call on the happy path");
}

// pro tier happy path: pro primary + locked params
{
  calls = []; perModel = { "black-forest-labs/flux.2-pro": () => ({ status: 200, json: { data: [{ b64_json: JPEG_B64, media_type: "image/jpeg" }], usage: { cost: 0.03 } } }) };
  const out = await bySlug("v1-images-pro").handler({ prompt: "a desk" });
  ok(calls[0].body.model === "black-forest-labs/flux.2-pro" && calls[0].body.provider.only[0] === "black-forest-labs" && out.model === "black-forest-labs/flux.2-pro" && out.usage.cost === undefined, "pro tier serves flux.2-pro first, cost stripped");
}

// failover: primary 502 -> failover link with its locked params; 400 does NOT walk
{
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 502, json: { error: { message: "provider down" } } }) };
  const out = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 2 && calls[1].body.model === "openai/gpt-5-image-mini" && calls[1].body.quality === "medium" && calls[1].body.provider.only[0] === "openai" && out.model === "openai/gpt-5-image-mini", "primary 502 walks to the failover with its locked quality + provider pin");
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 429, json: { error: { message: "slow down" } } }) };
  const out2 = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 2 && out2.model === "openai/gpt-5-image-mini", "upstream 429 (-> 503) walks the chain too");
  // An upstream 4xx (e.g. a provider safety refusal) is a 502 on our side, so
  // the chain walks to the failover; refused end to end -> 502, not charged.
  calls = []; perModel = { "black-forest-labs/flux.2-klein-4b": () => ({ status: 400, json: { error: { message: "prompt rejected by safety" } } }), "openai/gpt-5-image-mini": () => ({ status: 400, json: { error: { message: "prompt rejected by safety" } } }) };
  const e = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "Upstream error: prompt rejected", "upstream 4xx on every link -> 502 carrying the upstream message");
  ok(e?.statusCode === 502 && calls.length === 2, "…both links tried, 502 (settlement cancelled)");
  calls = []; perModel = { "black-forest-labs/flux.2-pro": () => ({ status: 503, json: {} }) };
  const out3 = await bySlug("v1-images-pro").handler({ prompt: "a desk" });
  ok(calls.length === 2 && calls[1].body.model === "qwen/qwen-image-3" && calls[1].body.resolution === "1K" && calls[1].body.provider.only[0] === "alibaba" && out3.model === "qwen/qwen-image-3", "pro failover pins qwen-image-3 at 1K on its provider");
}

// imageless -> 502 (walks, then 502 end to end); malformed -> 502
{
  calls = []; perModel = {
    "black-forest-labs/flux.2-klein-4b": () => ({ status: 200, json: { data: [], usage: { cost: 0 } } }),
    "openai/gpt-5-image-mini": () => ({ status: 200, json: { data: [{ b64_json: "" }] } }),
  };
  const e = await throws(() => bySlug("v1-images-fast").handler({ prompt: "a fox" }), "no image", "imageless upstream on both links -> 502");
  ok(e?.statusCode === 502 && calls.length === 2, "…both links tried, 502 (not charged)");
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
    ? { data: { id: "black-forest-labs/flux.2-klein-4b", endpoints: [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.02 }] }] } }
    : { data: { endpoints: [{ provider_tag: "openai", pricing: [{ billable: "output_image", unit: "token", cost_usd: 0.000008 }] }] } };
  const out = await bySlug("v1-images-fast").handler({ prompt: "a fox" });
  ok(calls.length === 1 && calls[0].body.model === "openai/gpt-5-image-mini" && out.model === "openai/gpt-5-image-mini", "a primary repriced ABOVE its bound on the live listing is skipped before any spend; the failover serves");
  listingReply = () => ({ data: { endpoints: [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.02 }] }, { provider_tag: "openai", pricing: [{ billable: "output_image", unit: "token", cost_usd: 0.00001 }] }] } });
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
function installVideoFetch({ statuses = ["pending", "in_progress", "completed"], contentStatus = 200, pollingUrl, submitStatus = 202, failError } = {}) {
  let polls = 0; const seen = { submit: null, polls: [], content: null };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST") {
      seen.submit = { url: u, body: JSON.parse(init.body), auth: init.headers?.Authorization };
      const j = { id: "job1", polling_url: pollingUrl ?? `${OPENROUTER_VIDEOS_URL}/job1`, status: "pending" };
      return { ok: submitStatus < 400, status: submitStatus, text: async () => JSON.stringify(submitStatus < 400 ? j : { error: { message: "bad" } }) };
    }
    if (u.includes("/content")) {
      seen.content = { url: u, auth: init.headers?.Authorization };
      return { ok: contentStatus < 400, status: contentStatus, headers: { get: (h) => (h === "content-type" ? "video/mp4" : null) }, arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength), text: async () => "" };
    }
    seen.polls.push({ url: u, auth: init.headers?.Authorization });
    const s = statuses[Math.min(polls++, statuses.length - 1)];
    const j = { id: "job1", status: s, ...(s === "completed" ? { unsigned_urls: [`${OPENROUTER_VIDEOS_URL}/job1/content?index=0`], usage: { cost: 0.12, is_byok: false } } : {}), ...(s === "failed" ? { error: failError ?? "content policy" } : {}) };
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
  ok(out.usage && out.usage.cost === undefined && !JSON.stringify(out).includes("0.12") && !JSON.stringify(out).includes("job1"), "upstream cost and job id appear nowhere in the response");
  const ev = lastGatewayEvent();
  ok(ev?.properties.tier === "v1-videos" && ev?.properties.upstreamUsd === 0.12 && ev?.properties.priceUsd === VIDEOS_PRICE, "video telemetry: tier/price/upstream");
}
{
  installVideoFetch({ statuses: ["failed"], failError: { message: "blocked by policy" } });
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "failed upstream", "job failed -> 502 (not charged)");
  ok(e?.statusCode === 502 && String(e.message).includes("blocked by policy"), "…502 carries the short upstream reason");
}
{
  installVideoFetch({ statuses: ["pending"] });
  const t0 = Date.now();
  const e = await throws(() => bySlug("v1-videos").handler({ prompt: "a boat" }), "did not finish", "job never completes -> 504 after the wait budget");
  ok(e?.statusCode === 504 && Date.now() - t0 >= 900, "…504 after VIDEOS_MAX_WAIT_MS");
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

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
