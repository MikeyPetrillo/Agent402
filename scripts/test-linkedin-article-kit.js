// linkedin-article-kit, offline: the research, synthesis and image generation
// are stubbed (deps injection, same seam as ticker-pack); the image RESIZING is
// real (image-ops in-process), because the sizes are the product. No network,
// no keys, no money.
import { Jimp } from "jimp";
import { makeLinkedInHandler, normLinkedInInput, parseArticleJson, renderSizes, LINKEDIN_SIZES, LINKEDIN_LIMITS, LINKEDIN_TIERS, LINKEDIN_TOOLS } from "../src/tools/linkedin-article-kit.js";
import { runImageOp, declaredDimensions } from "../src/tools/image-ops.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "../src/composite-spend-guard.js";
import { REPORT_TIERS } from "../src/report-tiers.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const src = new Jimp({ width: 1024, height: 1024, color: 0x3366ffff });
const srcJpeg = await src.getBuffer("image/jpeg", { quality: 90 });
const resize = (buffer, params) => runImageOp({ op: "cover", buffer, params });

const RESEARCH = {
  report: "Agents pay per call [1]. Stablecoin settlement grew 40% in 2025 [2]. Base fees are under a cent [3].",
  sources: [
    { n: 1, title: "x402 spec", url: "https://example.com/x402", snippet: "Agents pay per call.", fullText: true },
    { n: 2, title: "Stablecoin report", url: "https://example.com/stable", snippet: "Stablecoin settlement grew 40% in 2025.", fullText: false },
    { n: 3, title: "Base fees", url: "https://example.com/base", snippet: "Fees are under a cent.", fullText: true },
  ],
  meta: { searches_run: 3, sources_cited: 3 },
};
const body = "Agents will pay for APIs the way people pay for coffee: one small transaction at a time.\n\nThat is the point of [per-call pricing](https://example.com/x402).\n\n## Why now\n\n" + "Stablecoin settlement [grew 40% in 2025](https://example.com/stable) and the rails are cheap. ".repeat(12) + "\n\n> Under a cent per settlement changes who can sell.\n\n## What changes\n\n" + "Sellers meter, buyers budget, nobody signs up. ".repeat(20) + "\n\n## What to do\n\n1. Meter one endpoint.\n2. Publish a 402.\n3. Watch who pays.\n\nWhat would you meter first?";
const SYNTH_JSON = {
  headlines: ["Why AI agents will pay for APIs with stablecoins — and what it means", "Per-call pricing is the new API key", "The 402 economy"],
  subtitle: "One small payment at a time — no accounts",
  body_markdown: body,
  key_takeaways: ["Agents pay per call.", "Settlement is under a cent — on Base.", "No sign-up is the feature."],
  post_caption: "Agents don't sign up. They pay.\n\n- per call\n- in stablecoins\n- under a cent\n\nFull article in the link — read it.\n\n#AgenticFinance #x402 #Stablecoins #AI",
  hashtags: ["AgenticFinance", "#x402", "Stablecoins", "AI"],
  image_briefs: [{ slot: "cover", prompt: "A clean editorial illustration of many small coins flowing along network lines into an API socket, centred, generous margins, no text", alt: "Coins flowing along network lines into an API socket" }, { slot: "inline", prompt: "A minimal diagram-like illustration of a 402 handshake as two abstract shapes exchanging a token, no text", alt: "Two abstract shapes exchanging a token" }],
  sources_used: [1, 2, 3],
};
const calls = { research: 0, synth: 0, images: 0 };
const deps = (over = {}) => ({
  research: async (input) => { calls.research++; if (typeof input.accountAs === "function") input.accountAs(0.12); return RESEARCH; },
  synthesize: async () => { calls.synth++; return { choices: [{ message: { content: JSON.stringify(SYNTH_JSON) } }], usage: { cost: 0.09 } }; },
  generateImage: async () => { calls.images++; return { model: "stub/image", data: [{ b64_json: srcJpeg.toString("base64"), media_type: "image/jpeg" }], usage: { cost: 0.014 } }; },
  resize,
  ...over,
});

// ---- validation ---------------------------------------------------------------
{
  let e = null; try { normLinkedInInput({}); } catch (x) { e = x; }
  ok(e && e.statusCode === 400 && /topic/.test(e.message), "topic is required (400)");
  e = null; try { normLinkedInInput({ topic: "x".repeat(601) }); } catch (x) { e = x; }
  ok(e && /too long/.test(e.message), "topic cap enforced");
  const n = normLinkedInInput({ topic: "  agent payments  ", length: "long", images: { inline: 5, cover: false }, hashtags: 9, author: { name: "A", role: "B" } });
  ok(n.topic === "agent payments" && n.length === "long" && n.inlineN === 1 && n.cover === false && n.hashtags === 5 && n.author.name === "A", "input normalised: whitespace, length, inline capped at 1, hashtags capped at 5, byline kept");
}
// ---- synthesis parse ----------------------------------------------------------
{
  const a = parseArticleJson(JSON.stringify(SYNTH_JSON));
  ok(!/[—–]/.test(a.body) && !/[—–]/.test(a.headlines.join("")) && !/[—–]/.test(a.post) && !/[—–]/.test(a.takeaways.join("")), "house style: em/en dashes are replaced everywhere in delivered copy");
  ok(a.headlines.every((h) => h.length <= LINKEDIN_LIMITS.headlineChars) && a.hashtags.join(",") === "#AgenticFinance,#x402,#Stablecoins,#AI", "headlines within LinkedIn's length; hashtags normalised with #");
  const longPost = parseArticleJson(JSON.stringify({ ...SYNTH_JSON, post_caption: "word ".repeat(1000) }));
  ok(longPost.post.length <= LINKEDIN_LIMITS.postChars, `a companion post over ${LINKEDIN_LIMITS.postChars} chars is trimmed at a word boundary (${longPost.post.length})`);
  let e = null; try { parseArticleJson("not json"); } catch (x) { e = x; }
  ok(e && e.statusCode === 502, "malformed synthesis JSON is a 502 (not charged), never a half article");
  e = null; try { parseArticleJson(JSON.stringify({ headlines: ["h"], body_markdown: "too short" })); } catch (x) { e = x; }
  ok(e && e.statusCode === 502, "a body under 150 words is refused (not charged)");
}
// ---- sizes ----------------------------------------------------------------------
{
  const files = await renderSizes(srcJpeg, "cover", { resize });
  const dims = files.map((f) => `${f.name}:${f.width}x${f.height}`).join(" ");
  ok(files.length === LINKEDIN_SIZES.cover.length && /article-cover:1920x1080/.test(dims) && /post-link-share:1200x627/.test(dims) && /feed-square:1200x1200/.test(dims) && /feed-portrait:1080x1350/.test(dims), `cover slot renders LinkedIn's sizes exactly (${dims})`);
  ok(files.every((f) => f.bytes <= LINKEDIN_LIMITS.imageMaxBytes && f.media_type === "image/jpeg" && declaredDimensions(Buffer.from(f.b64, "base64")).width === f.width), "every file is a real JPEG under 3 MB whose header agrees with the stated dimensions");
  const inline = await renderSizes(srcJpeg, "inline", { resize });
  ok(inline.length === 1 && inline[0].width === 1200 && inline[0].height === 675, "inline slot renders 1200x675 (16:9)");
}
// ---- the handler end to end (stubbed upstreams, real resizing) ------------------
{
  const h = makeLinkedInHandler("linkedin-article");
  const out = await h({ topic: "Why AI agents will pay for APIs with stablecoins", audience: "fintech leaders", author: { name: "Mike", role: "founder" } }, { headers: {} }, deps());
  ok(calls.research === 1 && calls.synth === 1 && calls.images === 2, `one research run, one synthesis, one image per brief (${calls.images})`);
  ok(out.article.headline === "Why AI agents will pay for APIs with stablecoins - and what it means" && out.article.headlines.length === 3 && out.article.word_count > 150, "article carries the chosen headline, three options and a word count");
  ok(out.images.length === 2 && out.images[0].slot === "cover" && out.images[0].files.length === 4 && out.images[1].files.length === 1, "cover -> 4 sized files, inline -> 1");
  ok(/## Companion post/.test(out.report) && /## Sources\n1\. \[x402 spec\]\(https:\/\/example.com\/x402\)/.test(out.report) && /## Publishing notes/.test(out.report) && /1920x1080/.test(out.report), "the markdown deliverable carries the post, a linked source list and LinkedIn's publishing notes");
  ok(!/\[\d+\]/.test(out.article.body_markdown) && /\]\(https:\/\/example\.com\/stable\)/.test(out.article.body_markdown), "the article links facts to sources instead of [n] tags");
  ok(out.meta.image_files === 5 && out.meta.sources_full_text === 2 && out.meta.tier === "linkedin-article" && !("cost" in out.meta) && !JSON.stringify(out.meta).includes("upstream"), "meta counts files and full-text sources and never carries cost");
  ok(out.post.chars === out.post.caption.length && out.post.hashtags.length === 4, "post caption and hashtags are returned structured");
  // A failed cover is not charged; a failed inline image is reported, not fatal.
  let e = null; try { await h({ topic: "t" }, { headers: {} }, deps({ generateImage: async () => { throw Object.assign(new Error("upstream down"), { statusCode: 502 }); } })); } catch (x) { e = x; }
  ok(e && e.statusCode === 502 && /not charged/i.test(e.message), "every image failing with a cover requested -> 502 not charged");
  let n = 0;
  const out2 = await h({ topic: "t" }, { headers: {} }, deps({ generateImage: async () => { n++; if (n === 2) throw new Error("second failed"); return { data: [{ b64_json: srcJpeg.toString("base64") }] }; } }));
  ok(out2.images.length === 1 && out2.meta.image_errors.length === 1 && /1 failed/.test(out2.report), "a failed inline image is named in the report, the cover still ships");
  const thin = deps({ research: async () => ({ report: "x", sources: [{ n: 1, title: "a", url: "https://a" }], meta: {} }) });
  e = null; try { await h({ topic: "t" }, { headers: {} }, thin); } catch (x) { e = x; }
  ok(e && e.statusCode === 502, "thin research (< 3 sources) is refused, not charged");
}
// ---- job progress and the images generated at once -------------------------------
{
  const h = makeLinkedInHandler("linkedin-article");
  const patches = [];
  const req = { headers: {} };
  Object.defineProperty(req, "__a402JobProgress", { value: (p) => patches.push(p), enumerable: false });
  let live = 0, peak = 0;
  const slowImage = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 150)); live--; return { data: [{ b64_json: srcJpeg.toString("base64") }] }; };
  const out = await h({ topic: "Why AI agents will pay for APIs with stablecoins" }, req, deps({ generateImage: slowImage }));
  ok(peak === 2 && out.images.length === 2 && out.images[0].slot === "cover" && out.images[1].slot === "inline", `the two images generate at once and keep the briefs' order (peak ${peak})`);
  const stages = patches.map((p) => `${p.stage}:${p.done}/${p.total}`);
  ok(JSON.stringify(stages) === JSON.stringify(["researching:0/3", "writing article:1/3", "generating images:2/3"]), `the run reports its steps to the job (${stages.join(", ")})`);
  ok(patches.every((p) => p.progress === p.done / p.total), "each step carries its fraction done");
}
// ---- registration ---------------------------------------------------------------
{
  ok(EXPENSIVE_COMPOSITE_SLUGS.has("linkedin-article"), "the slug is composite-guarded (and therefore long-running: EVM exact only)");
  ok(REPORT_TIERS["linkedin-article"]?.maxUpstreamUsd === LINKEDIN_TIERS["linkedin-article"].maxUpstreamUsd, "the report-tiers registry knows its cap (enforced by recordCompositeUsage)");
  ok(HUMAN_PRODUCTS["linkedin-article"]?.kind === "linkedin" && HUMAN_PRODUCTS["linkedin-article"].price === 400, "card product exists at $4, the derived card rung for the $1.10 agent tier");
  ok(LINKEDIN_TOOLS[0].route === "POST /v1/linkedin-article" && /1920x1080/.test(LINKEDIN_TOOLS[0].description), "the catalog entry names the LinkedIn sizes");
}
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
