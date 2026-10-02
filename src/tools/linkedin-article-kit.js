// linkedin-article-kit — a READY-TO-PUBLISH LinkedIn article: grounded research
// (the research-deep pipeline: planned searches, page bodies, cited sources),
// an Opus synthesis in LinkedIn's shape (headline options, hook, short
// paragraphs under subheads, takeaways, a closing CTA, a companion post with
// hashtags), and generated images delivered at LinkedIn's OWN sizes:
//   article cover  1920 x 1080 (LinkedIn: "optimal image size for the cover
//                  photo is 1920 (w) x 1080 (h)"; max 7680 x 4320)
//   post / link    1200 x 627  (LinkedIn: "1.91:1 ratio (1200 x 627)")
//   feed square    1200 x 1200 and feed portrait 1080 x 1350 (common feed sizes)
//   in-article     1200 x 675  (16:9, under the 3 MB file cap)
// Each image is generated once (the budget image tier) and
// crop-to-filled to every size in-process, so the buyer gets files, not a
// prompt. Facts in the article link to their sources (LinkedIn's editor keeps
// links; it has no [n] citations), and a numbered source list is appended.
//
// Same discipline as the other report products: grounding-strict (every
// specific traces to the research material), settlement-safe (any upstream
// failure throws >= 400 so the buyer is not charged), upstream cost read for
// the internal accumulator and never returned, WALLET_ONLY, composite-guarded,
// long-running (EVM exact only), not cached. 503 without OPENROUTER_API_KEY.
// LinkedIn has no public API for publishing personal articles; this delivers
// the package to paste, never posts.
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { makeResearchHandler } from "./research-deep-kit.js";
import { IMAGES_FAST_TOOLS } from "./llm-images-fast-kit.js";
import { runImageOffThread } from "./image-pool.js";
import { runImageOp, MAX_SRC_PIXELS, declaredDimensions } from "./image-ops.js";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
export const LINKEDIN_MODELS = [SYNTH];
// Upstream worst case: research base cap + synthesis (measured on the report
// kits; this one is shorter) + 2 budget images at the images-fast tier's
// bound, all under maxUpstreamUsd.
export const LINKEDIN_TIERS = {
  "linkedin-article": { price: "$1.10", maxUpstreamUsd: 0.65, researchTier: "research", maxImages: 2, synthMaxTokens: 6000 },
};
export const LINKEDIN_SIZES = {
  cover: [
    { name: "article-cover", use: "LinkedIn article cover image", width: 1920, height: 1080 },
    { name: "post-link-share", use: "LinkedIn post / link-share image (1.91:1)", width: 1200, height: 627 },
    { name: "feed-square", use: "LinkedIn feed image, square (1:1)", width: 1200, height: 1200 },
    { name: "feed-portrait", use: "LinkedIn feed image, portrait (4:5)", width: 1080, height: 1350 },
  ],
  inline: [
    { name: "in-article", use: "in-article image (16:9)", width: 1200, height: 675 },
  ],
};
export const LINKEDIN_LIMITS = { headlineChars: 100, postChars: 3000, hashtagsMax: 5, imageMaxBytes: 3 * 1024 * 1024, coverOptimal: "1920x1080", coverMax: "7680x4320", formats: "JPG, PNG, static GIF" };
const WORDS = { short: "~600", standard: "~1,000", long: "~1,500" };
const SYNTH_TIMEOUT_MS = 150_000;
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_TOPIC = 600, MAX_ANGLE = 400, MAX_SHORT = 200;

async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
const str = (v, max, name) => { if (v == null) return ""; if (typeof v !== "string") throw bad(`"${name}" must be a string`); const s = v.replace(/\s+/g, " ").trim(); if (s.length > max) throw bad(`"${name}" too long (max ${max} chars)`); return s; };
// House style: no em dashes anywhere in delivered copy.
const noEmDash = (s) => String(s || "").replace(/\s*[—–]\s*/g, " - ");

/** Validate the buyer's request. Exported for tests. */
export function normLinkedInInput(input) {
  if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"topic": "..."}');
  const topic = str(input.topic ?? input.query, MAX_TOPIC, "topic");
  if (!topic) throw bad('"topic" (what the article is about) is required');
  const length = ["short", "standard", "long"].includes(input.length) ? input.length : "standard";
  const images = input.images && typeof input.images === "object" ? input.images : {};
  const cover = images.cover !== false;
  const inlineN = Math.max(0, Math.min(1, Number.isFinite(Number(images.inline)) ? Number(images.inline) : 1));
  const author = input.author && typeof input.author === "object" ? { name: str(input.author.name, 120, "author.name"), role: str(input.author.role, 160, "author.role") } : null;
  return {
    topic, angle: str(input.angle, MAX_ANGLE, "angle"), audience: str(input.audience, MAX_SHORT, "audience"), tone: str(input.tone, 80, "tone") || "professional, first-person, direct",
    author, cta: str(input.cta, MAX_SHORT, "cta"), length, cover, inlineN, imageStyle: str(images.style, MAX_SHORT, "images.style") || "clean editorial illustration, no text, no logos, no real people's faces",
    hashtags: Math.max(0, Math.min(LINKEDIN_LIMITS.hashtagsMax, Number.isFinite(Number(input.hashtags)) ? Number(input.hashtags) : 4)),
  };
}

/** Parse the synthesis JSON defensively; a malformed field is a 502 (not
 *  charged), never a half-article. Exported for tests. */
export function parseArticleJson(text) {
  let j;
  try { j = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw bad("Article synthesis returned malformed JSON - not charged, please retry", 502); }
  const arr = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => noEmDash(x.trim())).slice(0, n) : []);
  const headlines = arr(j.headlines, 3).map((h) => h.slice(0, LINKEDIN_LIMITS.headlineChars));
  const body = noEmDash(String(j.body_markdown || "").trim());
  if (!headlines.length || body.split(/\s+/).length < 150) throw bad("Article synthesis produced no usable article - not charged, please retry", 502);
  const hashtags = arr(j.hashtags, LINKEDIN_LIMITS.hashtagsMax).map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/[^#\p{L}\p{N}_]/gu, ""));
  let post = noEmDash(String(j.post_caption || "").trim());
  if (post.length > LINKEDIN_LIMITS.postChars) post = post.slice(0, LINKEDIN_LIMITS.postChars - 1).replace(/\s+\S*$/, "") + "…";
  const briefs = (Array.isArray(j.image_briefs) ? j.image_briefs : []).filter((b) => b && typeof b.prompt === "string" && b.prompt.trim()).map((b) => ({ slot: b.slot === "inline" ? "inline" : "cover", prompt: b.prompt.trim().slice(0, 1200), alt: noEmDash(String(b.alt || "").trim()).slice(0, 300) }));
  return { headlines, subtitle: noEmDash(String(j.subtitle || "").trim()).slice(0, 220), body, takeaways: arr(j.key_takeaways, 5), post, hashtags, briefs, sourcesUsed: Array.isArray(j.sources_used) ? j.sources_used.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [] };
}

/** One generated source image -> every LinkedIn size for its slot, as JPEG
 *  under the 3 MB cap. `resize` is injectable (tests run it in-process). */
export async function renderSizes(srcBuffer, slot, { resize = defaultResize, quality = 90 } = {}) {
  const out = [];
  for (const size of LINKEDIN_SIZES[slot] || []) {
    // image-ops answers with the route binder's binary sentinel ({__binary,
    // contentType}); unwrap to the bytes.
    const unwrap = (r) => (Buffer.isBuffer(r) ? r : Buffer.isBuffer(r?.__binary) ? r.__binary : null);
    let buf = unwrap(await resize(srcBuffer, { width: size.width, height: size.height, format: "jpeg", quality }));
    if (!buf) throw bad("image resize returned no bytes", 502);
    if (buf.length > LINKEDIN_LIMITS.imageMaxBytes) buf = unwrap(await resize(srcBuffer, { width: size.width, height: size.height, format: "jpeg", quality: 75 })) || buf;
    const dims = declaredDimensions(buf) || { width: size.width, height: size.height };
    out.push({ name: size.name, use: size.use, width: dims.width, height: dims.height, format: "jpeg", media_type: "image/jpeg", bytes: buf.length, b64: buf.toString("base64") });
  }
  return out;
}
async function defaultResize(buffer, params) {
  try { return await runImageOffThread({ op: "cover", buffer, params, maxPixels: MAX_SRC_PIXELS }); }
  catch (e) { if (e?.statusCode === 400) throw e; return runImageOp({ op: "cover", buffer, params, maxPixels: MAX_SRC_PIXELS }); }
}

function defaultDeps() {
  return {
    research: makeResearchHandler(LINKEDIN_TIERS["linkedin-article"].researchTier),
    generateImage: (input) => IMAGES_FAST_TOOLS.find((t) => t.slug === "v1-images-fast").handler(input),
    synthesize: (body, timeoutMs, user) => chat(body, timeoutMs, user),
    resize: defaultResize,
  };
}

function makeLinkedInHandlerInner(tierSlug) {
  const t = LINKEDIN_TIERS[tierSlug];
  return async (input, req, depsIn) => {
    const d = { ...defaultDeps(), ...(depsIn || {}) };
    const p = normLinkedInInput(input);
    const user = safeUser(req);
    let spent = 0;

    // 1) GROUNDED RESEARCH (the whole research-deep pipeline, booked here).
    const rq = `${p.topic}${p.angle ? ` - angle: ${p.angle}` : ""}${p.audience ? ` - for ${p.audience}` : ""}`;
    const research = await d.research({ query: rq, accountAs: (usd) => { spent += Number(usd) || 0; } }, req);
    const sources = Array.isArray(research?.sources) ? research.sources : [];
    if (!research?.report || sources.length < 3) throw bad("Not enough grounded material to write this article - not charged, please retry with a more specific topic.", 502);
    const sourceBlock = sources.map((s) => `[${s.n}] ${s.title}${s.fullText ? " (full text read)" : " (excerpt)"} - ${s.url}`).join("\n");

    // 2) SYNTHESIS in LinkedIn's shape, as JSON.
    const prompt = `You are a ghostwriter producing a READY-TO-PUBLISH LinkedIn ARTICLE${p.author?.name ? ` for ${p.author.name}${p.author.role ? ` (${p.author.role})` : ""}` : ""} that will be SOLD to a paying customer. Fabrication is the worst possible failure.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the RESEARCH REPORT and SOURCES below. Every SPECIFIC fact - statistics, numbers, dates, prices, names, quotes, product claims - MUST appear there. NEVER add a figure or claim from memory. If the material lacks a number, write qualitatively.
2. LinkedIn articles have no bracketed citations. Attach each specific fact to its source as a markdown link on the relevant words: [phrase](url) using the URL of the numbered source that supports it. Do NOT write [n] tags in the article. Do not write a "Sources" section (one is appended in code).
3. A gap in the material is never a claim about the world: if the research does not cover something, leave it out; never write "unclear", "undisclosed" or "unknown" as if that were a fact.
4. House style: NO em dashes or en dashes anywhere (use a comma, a colon, or " - "). No hashtags inside the article body. No emoji. No "In today's fast-paced world" openers. Plain, specific, first-person where an author is given.

=== LINKEDIN SHAPE ===
- headlines: 3 options, each <= ${LINKEDIN_LIMITS.headlineChars} characters, specific, no clickbait, no colon-stacking.
- subtitle: one line, <= 200 characters.
- body_markdown (${WORDS[p.length]} words): a HOOK in the first two lines that states the point (the first 2-3 lines are all a reader sees before "see more"); then 4-7 sections under ## subheads; paragraphs of 1-3 sentences; one or two pull-quote lines rendered as > blockquotes (only sentences supported by the material); concrete examples with linked sources; a short numbered list where it helps; close with a direct question or ask${p.cta ? ` and this call to action: "${p.cta}"` : ""}.
- key_takeaways: 3-5 one-sentence bullets, each grounded.
- post_caption: a companion LinkedIn POST (<= ${LINKEDIN_LIMITS.postChars} characters, ideally 900-1,300) to publish the article with: a hook line, 3-6 short lines or bullets, a line inviting readers to the article, then ${p.hashtags} hashtags on the last line. No em dashes.
- hashtags: the same ${p.hashtags} hashtags as an array, CamelCase, no spaces.
- image_briefs: ${p.cover ? '1 "cover"' : "no cover"}${p.inlineN ? ` and 1 "inline"` : ""} image brief(s): {slot, prompt, alt}. prompt = a concrete, generation-ready description in this style: "${p.imageStyle}"; composition must read at 16:9 AND square (keep the subject centred, generous margins, no text, no logos, no real people's faces, no charts with numbers). alt = a plain-language description for accessibility.
- sources_used: the [n] numbers you drew on.
Tone: ${p.tone}.${p.audience ? ` Audience: ${p.audience}.` : ""}${p.angle ? ` Angle: ${p.angle}.` : ""}

Return ONLY a JSON object with keys: headlines, subtitle, body_markdown, key_takeaways, post_caption, hashtags, image_briefs, sources_used.

=== TOPIC ===
${p.topic}
=== RESEARCH REPORT (grounded, cited with [n]) ===
${research.report}
=== SOURCES ===
${sourceBlock}`;
    const sd = await d.synthesize({ model: SYNTH, messages: [{ role: "user", content: prompt }], max_tokens: t.synthMaxTokens, response_format: { type: "json_object" }, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const art = parseArticleJson(textOf(sd));

    // 3) IMAGES: one generation per brief, then every LinkedIn size for the slot.
    const wanted = art.briefs.filter((b) => (b.slot === "cover" ? p.cover : p.inlineN > 0)).slice(0, t.maxImages);
    if (p.cover && !wanted.some((b) => b.slot === "cover")) wanted.unshift({ slot: "cover", prompt: `${p.imageStyle}. Theme: ${art.headlines[0]}. Centered subject, generous margins, no text, no logos, no faces.`, alt: art.headlines[0] });
    const images = [];
    const imageErrors = [];
    for (const b of wanted) {
      try {
        const g = await Promise.race([d.generateImage({ prompt: b.prompt }), new Promise((_, r) => setTimeout(() => r(bad("image generation timed out", 504)), IMAGE_TIMEOUT_MS))]);
        spent += Number(g?.usage?.cost) || 0.014;
        const b64 = g?.data?.[0]?.b64_json;
        if (!b64) throw bad("no image returned", 502);
        const src = Buffer.from(b64, "base64");
        const variants = await renderSizes(src, b.slot, { resize: d.resize });
        images.push({ slot: b.slot, alt: b.alt, prompt: b.prompt, source: { width: declaredDimensions(src)?.width || null, height: declaredDimensions(src)?.height || null, model: g?.model || null }, files: variants });
      } catch (e) { imageErrors.push({ slot: b.slot, error: String(e?.message || e).slice(0, 160) }); }
    }
    // A cover was asked for and every image failed: the buyer is not charged.
    if (p.cover && !images.some((i) => i.slot === "cover")) throw bad(`Image generation failed (${imageErrors.map((x) => x.error).join("; ") || "no image"}) - not charged, please retry.`, 502);

    // 4) ASSEMBLE the deliverable.
    const wordCount = art.body.split(/\s+/).filter(Boolean).length;
    const sourceList = sources.map((s) => `${s.n}. [${s.title}](${s.url})`).join("\n");
    const report = [
      `# ${art.headlines[0]}`,
      art.subtitle ? `*${art.subtitle}*` : "",
      "",
      art.body,
      "",
      art.takeaways.length ? `## Key takeaways\n${art.takeaways.map((x) => `- ${x}`).join("\n")}` : "",
      "",
      `## Sources\n${sourceList}`,
      "",
      "---",
      `## Companion post (paste as a LinkedIn post, ${art.post.length} of ${LINKEDIN_LIMITS.postChars} characters)`,
      "",
      art.post,
      "",
      `## Alternative headlines\n${art.headlines.slice(1).map((h) => `- ${h}`).join("\n") || "- (none)"}`,
      "",
      `## Images (${images.length}${imageErrors.length ? `, ${imageErrors.length} failed` : ""})`,
      images.map((im) => `- ${im.slot}: ${im.files.map((f) => `${f.name} ${f.width}x${f.height} (${Math.round(f.bytes / 1024)} KB)`).join(", ")}\n  alt: ${im.alt || "(none)"}`).join("\n") || "- none",
      "",
      `## Publishing notes\n- Article cover: LinkedIn's optimal size is ${LINKEDIN_LIMITS.coverOptimal} (max ${LINKEDIN_LIMITS.coverMax}); ${LINKEDIN_LIMITS.formats}, under 3 MB.\n- Post / link-share image: 1200 x 627 (1.91:1).\n- Headline shown in full up to ~${LINKEDIN_LIMITS.headlineChars} characters; a post is capped at ${LINKEDIN_LIMITS.postChars} characters.\n- Facts are linked to their sources inline; LinkedIn keeps the links when you paste the article into the editor.\n- LinkedIn has no public API for personal articles: paste the article, upload the cover, then publish the companion post with the link-share image.`,
    ].filter((x) => x !== "").join("\n");

    const meta = { tier: tierSlug, words: wordCount, length: p.length, headlines: art.headlines.length, images: images.length, image_files: images.reduce((n, i) => n + i.files.length, 0), image_errors: imageErrors, post_chars: art.post.length, hashtags: art.hashtags.length,
      sources_listed: sources.length, sources_full_text: sources.filter((s) => s.fullText).length, research: research.meta || null, synthesis_model: SYNTH, limits: LINKEDIN_LIMITS, disclaimer: "Grounded in cited web sources; review before publishing. Not posted on your behalf." };
    const out = {
      report, title: art.headlines[0],
      article: { headline: art.headlines[0], headlines: art.headlines, subtitle: art.subtitle, body_markdown: art.body, key_takeaways: art.takeaways, word_count: wordCount },
      post: { caption: art.post, hashtags: art.hashtags, chars: art.post.length },
      images, sources, tables: [], meta,
    };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(t) });
    return out;
  };
}
export function makeLinkedInHandler(tierSlug) {
  const inner = makeLinkedInHandlerInner(tierSlug);
  return async (input, req, deps) => {
    try { return await inner(input, req, deps); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(LINKEDIN_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "What the article is about (up to 600 chars). The research runs on this." },
    angle: { type: "string", description: "Optional: the take or thesis to argue." },
    audience: { type: "string", description: "Optional: who it is for, e.g. CFOs at mid-market SaaS." },
    tone: { type: "string", description: "Optional voice, default: professional, first-person, direct." },
    author: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } }, description: "Optional byline the article is written as." },
    cta: { type: "string", description: "Optional closing call to action." },
    length: { type: "string", enum: ["short", "standard", "long"], description: "~600 / ~1,000 / ~1,500 words (default standard)." },
    images: { type: "object", properties: { cover: { type: "boolean", description: "Generate the cover image (default true)." }, inline: { type: "number", description: "In-article images, 0 or 1 (default 1)." }, style: { type: "string", description: "Visual style for the generated images." } } },
    hashtags: { type: "number", description: "Hashtags on the companion post, 0-5 (default 4)." },
  },
  required: ["topic"],
};
const OUT_EXAMPLE = {
  report: "# Why agent payments settle on chain\n*One line of context*\n\n...\n\n## Sources\n1. [Example](https://example.com/...)\n\n---\n## Companion post (paste as a LinkedIn post, 1,120 of 3000 characters)\n...",
  title: "Why agent payments settle on chain",
  article: { headline: "Why agent payments settle on chain", headlines: ["Why agent payments settle on chain", "...", "..."], subtitle: "One line of context", body_markdown: "...", key_takeaways: ["..."], word_count: 980 },
  post: { caption: "...\n#AgenticFinance #Payments #AI #Stablecoins", hashtags: ["#AgenticFinance", "#Payments", "#AI", "#Stablecoins"], chars: 1120 },
  images: [{ slot: "cover", alt: "An abstract network of nodes exchanging tokens", prompt: "...", source: { width: 1024, height: 1024, model: "black-forest-labs/flux.2-klein-4b" }, files: [
    { name: "article-cover", use: "LinkedIn article cover image", width: 1920, height: 1080, format: "jpeg", media_type: "image/jpeg", bytes: 412000, b64: "/9j/4AAQ…" },
    { name: "post-link-share", use: "LinkedIn post / link-share image (1.91:1)", width: 1200, height: 627, format: "jpeg", media_type: "image/jpeg", bytes: 180000, b64: "/9j/4AAQ…" },
  ] }],
  sources: [{ n: 1, title: "Example", url: "https://example.com/...", snippet: "...", fullText: true }],
  tables: [],
  meta: { tier: "linkedin-article", words: 980, images: 2, image_files: 5, post_chars: 1120, sources_listed: 12, sources_full_text: 4, synthesis_model: "anthropic/claude-opus-5" },
};
export const LINKEDIN_TOOLS = [
  {
    route: "POST /v1/linkedin-article", name: "LinkedIn article, ready to publish (research + copy + sized images)", slug: "linkedin-article", category: "llm", price: LINKEDIN_TIERS["linkedin-article"].price,
    description: "Hand over a topic and get a publish-ready LinkedIn article back: grounded web research with cited sources, three headline options, a hook-first body under subheads with facts linked to their sources, key takeaways, a companion post with hashtags, and generated images delivered at LinkedIn's own sizes (article cover 1920x1080, link-share 1200x627, feed square and portrait, in-article 16:9) as inline JPEG under 3 MB. Optional byline, angle, audience, tone and CTA. Nothing from memory; nothing posted on your behalf. One payment, one package. Not cached.",
    // No bare "article"/"content" tag: /api/find's lexical ranker scores a
    // curated tag +3 and this slug's "article" segment already +6, which put
    // this tool above `extract` for "extract article from URL" (test-find-ranking).
    tags: ["linkedin", "linkedin-article", "ghostwriting", "thought-leadership", "social-media", "marketing", "images", "report", "agentic-finance", "x402", "mpp"],
    discovery: { bodyType: "json", input: { topic: "Why AI agents will pay for APIs with stablecoins", audience: "fintech product leaders", length: "standard" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeLinkedInHandler("linkedin-article"),
  },
];
